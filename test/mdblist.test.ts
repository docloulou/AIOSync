import test from 'node:test';
import assert from 'node:assert/strict';
import { MdblistProvider } from '../src/providers/mdblist.ts';
import { Store } from '../src/store.ts';
import { TrackerService } from '../src/service.ts';
import { loadSettings } from '../src/config.ts';
import type { Checkpoint, WatchEvent } from '../src/types.ts';

const credentials = { token: 'mdb-key+/=?&private' };
const at = '2026-09-16T10:00:00Z';
const movie = { watched_at: at, movie: { ids: { imdb: 'tt0111161', tmdb: 278 } } };
const episode = { watched_at: at, show: { ids: { imdb: 'tt0903747', tmdb: 1396 } }, episode: { season: 0, number: 1, ids: { tmdb: 999 } } };
const resume = { id: 1, type: 'episode', progress: 25, runtime: 40, updated_at: at, paused_at: at, show: episode.show, episode: { season: 0, number: 2 } };
const activity = { watched_at: at, season_watched_at: null, episode_watched_at: at, journal_at: at, server_time: at };
type Call = { path: string; params: URLSearchParams; body?: any; method: string };
function page(bucket: string, rows: unknown[], total = rows.length, next: string | null = null) {
  return { [bucket]: rows, pagination: { total, limit: 1000, next_cursor: next } };
}
function defaults(call: Call): unknown {
  if (call.path === '/user') return { user_id: 123, username: 'test-account' };
  if (call.path === '/sync/last_activities') return activity;
  if (call.path === '/sync/watched' && call.method === 'GET') {
    // Current cursor pages omit total/limit; watched episodes nest the parent show.
    return { ...(call.params.get('mediatype') === 'movie' ? { movies: [movie] } : {
      episodes: [{ last_watched_at: at, episode: { ...episode.episode, show: episode.show } }],
    }), pagination: { has_more: false, next_cursor: null } };
  }
  if (call.path === '/sync/playback') return [resume];
  if (call.path === '/upnext') return { items: [{ show: episode.show, next_episode: { season: 0, episode: 2 }, progress: { total: 10 }, last_watched_at: at }], limit: 100, has_more: false };
  if (call.path === '/sync/watched') return { updated: { movies: 1, episodes: 1 }, not_found: {}, errors: [] };
  if (call.path === '/sync/watched/remove') return { deleted: { movies: 1, episodes: 1 }, not_found: {} };
  if (call.path === '/scrobble/clear') return { action: 'clear', deleted: true };
  if (call.path.startsWith('/scrobble/')) return { action: call.path.split('/').at(-1), progress: call.body.progress };
  throw new Error(`Unexpected test request: ${call.path}`);
}
function fixture(handler: (call: Call) => unknown | Promise<unknown> = () => undefined) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.mdblist.com');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    assert.ok(url.searchParams.get('apikey'));
    const call = { path: url.pathname, params: url.searchParams, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const value = await handler(call);
    return value instanceof Response ? value : Response.json(value === undefined ? defaults(call) : value);
  };
  return { provider: new MdblistProvider({ fetch: fetcher }), calls };
}
function checkpoint(): Checkpoint {
  const saved = new Map<string, unknown>();
  return async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    if (saved.has(key)) return structuredClone(saved.get(key)) as T;
    const result = await operation(); saved.set(key, structuredClone(result)); return result;
  };
}
function event(overrides: Partial<WatchEvent> = {}): WatchEvent {
  return { id: 'event-1', event: 'pause', at: Date.parse(at) / 1000, metaId: 'tt0903747', videoId: 'tt0903747:0:2',
    season: 0, episode: 2, positionMs: 600000, durationMs: 2400000, ids: { tmdb: '1396' }, ...overrides };
}

test('MDBList validates a personal key through /user and safely encodes query authentication', async () => {
  const { provider, calls } = fixture();
  await provider.validate(credentials);
  assert.equal(calls[0].path, '/user');
  assert.equal(calls[0].params.get('apikey'), credentials.token);
  assert.equal([...calls[0].params].length, 1);
  await assert.rejects(provider.validate({ token: '' }), /API key/);
  for (const body of [{}, { user_id: 0 }, { error: 'unauthorized' }]) {
    await assert.rejects(fixture(() => body).provider.validate(credentials), /MDBList/);
  }
});

test('MDBList sends real native start, pause, incomplete stop and completed stop with exact episode coordinates', async () => {
  const { provider, calls } = fixture();
  for (const action of ['start', 'pause', 'stop'] as const) {
    await provider.push(event({ event: action, played: false }), 'series', credentials, checkpoint());
  }
  await provider.push(event({ event: 'stop', played: true, positionMs: 2160000 }), 'series', credentials, checkpoint());
  assert.deepEqual(calls.map(c => c.path), ['/scrobble/start', '/scrobble/pause', '/scrobble/stop', '/scrobble/stop']);
  assert.deepEqual(calls[1].body, { show: { ids: { tmdb: 1396, imdb: 'tt0903747' }, season: 0, episode: 2 }, progress: 25 });
  assert.equal(calls[3].body.progress, 90);
  assert.ok(calls.every(c => c.method === 'POST'));
  await provider.push(event({ event: 'start', metaId: 'tmdb:278', videoId: 'tmdb:278', ids: undefined }), 'movie', credentials, checkpoint());
  assert.deepEqual(calls.at(-1)!.body, { movie: { ids: { tmdb: 278 } }, progress: 25 });
});

test('MDBList keeps incomplete progress at 80%+ and invalid positions local without a destructive scrobble', async () => {
  const { provider, calls } = fixture();
  for (const action of ['pause', 'stop'] as const) for (const percent of [80, 85, 100]) {
    const result = await provider.push(event({ event: action, played: false, positionMs: 24000 * percent }), 'series', credentials, checkpoint());
    assert.equal(result?.localOnly, true); assert.match(result?.warning ?? '', /80%/);
  }
  for (const fields of [{ positionMs: undefined }, { durationMs: undefined }, { durationMs: 0 }, { positionMs: -1 }, { positionMs: 2400001 }, { positionMs: NaN }]) {
    assert.equal((await provider.push(event(fields), 'series', credentials, checkpoint()))?.localOnly, true);
  }
  assert.equal(calls.length, 0);
  await provider.push(event({ positionMs: 1896000 }), 'series', credentials, checkpoint());
  assert.equal(calls[0].body.progress, 79);
  await provider.push(event({ event: 'start', positionMs: 2040000 }), 'series', credentials, checkpoint());
  assert.equal(calls[1].path, '/scrobble/start'); assert.equal(calls[1].body.progress, 85);
});

test('MDBList manual marks preserve event time and target one special; cleanup retries do not replay history', async () => {
  let failed = false;
  const { provider, calls } = fixture(c => {
    if (c.path === '/scrobble/clear' && !failed) { failed = true; return new Response('', { status: 503 }); }
  });
  const saved = checkpoint();
  const e = event({ event: 'played' });
  await assert.rejects(provider.push(e, 'series', credentials, saved), /503/);
  await provider.push(e, 'series', credentials, saved);
  assert.equal(calls.filter(c => c.path === '/sync/watched').length, 1);
  assert.deepEqual(calls[0].body, { shows: [{ ids: { tmdb: 1396, imdb: 'tt0903747' }, seasons: [{ number: 0, episodes: [{ number: 2, watched_at: '2026-09-16T10:00:00.000Z' }] }] }] });
  assert.deepEqual(calls.at(-1)!.body, { show: { ids: { tmdb: 1396, imdb: 'tt0903747' }, season: 0, episode: 2 } });
  await provider.push(event({ event: 'unplayed' }), 'series', credentials, checkpoint());
  assert.equal(calls.at(-2)!.path, '/sync/watched/remove');
  assert.equal(JSON.stringify(calls.at(-2)!.body).includes('watched_at'), false);
});

test('MDBList explicit completion works without a runtime, and unwatch is safe when no resume exists', async () => {
  const { provider, calls } = fixture(c => c.path === '/scrobble/clear' ? { action: 'clear', deleted: false } : undefined);
  await provider.push(event({ event: 'stop', played: true, durationMs: undefined, metaId: 'tt0111161', ids: undefined }), 'movie', credentials, checkpoint());
  assert.deepEqual(calls[0].body, { movies: [{ ids: { imdb: 'tt0111161' }, watched_at: '2026-09-16T10:00:00.000Z' }] });
  await provider.push(event({ event: 'unplayed', metaId: 'tt0111161', ids: undefined }), 'movie', credentials, checkpoint());
  assert.equal(calls.at(-2)!.path, '/sync/watched/remove');
});

test('MDBList refuses unresolved writes, unsplit batches and anime numbering without deleting resumes', async () => {
  for (const fields of [{ season: null }, { metaId: 'kitsu:42' }, { videoId: 'mal:42:2' }, { scope: 'series' as const, videos: [{ videoId: 'tt1:1:1', season: 1, episode: 1 }] }]) {
    const f = fixture();
    await assert.rejects(f.provider.push(event(fields), 'series', credentials, checkpoint()), e => (e as any).status === 422);
    assert.equal(f.calls.length, 0);
  }
  for (const response of [{ updated: {}, not_found: { shows: [episode.show] } }, { updated: {}, errors: [{ reason: 'partial' }] }, {}, { error: 'bad' }]) {
    const f = fixture(() => response);
    await assert.rejects(f.provider.push(event({ event: 'played' }), 'series', credentials, checkpoint()), /MDBList/);
    assert.equal(f.calls.some(c => c.path === '/scrobble/clear'), false);
  }
});

test('MDBList pull imports watched aliases, exact specials, progress and explicit next episode', async () => {
  const { provider } = fixture();
  const result = await provider.pull(credentials);
  assert.deepEqual(result.watched.movies, ['tmdb:278', 'tt0111161']);
  assert.deepEqual(result.watched.episodes, ['tmdb:1396:0:1', 'tt0903747:0:1']);
  assert.equal(result.watched.episodes.some(id => id.includes('999')), false);
  assert.deepEqual(result.watched.counts['tt0903747'], { watched: 1, total: 10 });
  assert.equal(result.watched.nextUp[0].videoId, 'tt0903747:0:2');
  assert.deepEqual(result.items[0], { type: 'series', metaId: 'tt0903747', videoId: 'tt0903747:0:2', season: 0, episode: 2,
    progressPercent: 25, positionMs: 600000, durationMs: 2400000, played: false, at: Date.parse(at) / 1000 });
});

test('MDBList follows all watched cursors and supports documented offset pagination without cursors', async () => {
  for (const cursorMode of [true, false]) {
    const second = { ...movie, movie: { ids: { tmdb: 550 } } };
    const f = fixture(c => {
      if (c.path !== '/sync/watched' || c.params.get('mediatype') !== 'movie') return;
      const after = cursorMode ? c.params.has('cursor') : c.params.has('offset');
      if (after) assert.equal(c.params.get(cursorMode ? 'cursor' : 'offset'), cursorMode ? 'cursor&next=1' : '1');
      return { movies: [after ? second : movie], pagination: { total: 2, limit: 1,
        ...(cursorMode ? { next_cursor: after ? null : 'cursor&next=1' } : { offset: after ? 1 : 0 }) } };
    });
    assert.deepEqual((await f.provider.pull(credentials)).watched.movies, ['tmdb:278', 'tmdb:550', 'tt0111161']);
  }
});

test('MDBList reads every cursor page without total or limit, including a final empty page', async () => {
  for (const emptyLast of [false, true]) {
    const f = fixture(c => {
      if (c.path !== '/sync/watched' || c.params.get('mediatype') !== 'movie') return;
      assert.equal(c.params.has('offset'), false, 'cursor mode must not send an offset');
      const cursor = c.params.get('cursor');
      if (cursor === null) return { movies: [movie], pagination: { has_more: true, next_cursor: 'page&two=1' } };
      if (cursor === 'page&two=1') return { movies: [{ movie: { ids: { tmdb: 550 } } }], pagination: { total: null, has_more: emptyLast, next_cursor: emptyLast ? 'page-three' : null } };
      assert.equal(cursor, 'page-three');
      return { movies: [], pagination: { next_cursor: null } };
    });
    const result = await f.provider.pull(credentials);
    assert.deepEqual(result.watched.movies, ['tmdb:278', 'tmdb:550', 'tt0111161']);
    assert.equal(f.calls.filter(c => c.path === '/sync/watched' && c.params.get('mediatype') === 'movie').length, emptyLast ? 3 : 2);
  }
});

test('MDBList legacy has_more pagination works with per-media totals and an explicit null cursor', async () => {
  for (const includeTotal of [true, false]) {
    const f = fixture(c => {
      if (c.path !== '/sync/watched' || c.params.get('mediatype') !== 'movie') return;
      assert.equal(c.params.has('cursor'), false);
      const after = c.params.has('offset');
      if (after) assert.equal(c.params.get('offset'), '1');
      return { movies: [after ? { movie: { ids: { tmdb: 550 } } } : movie], pagination: {
        offset: after ? '1' : '0', limit: '1', ...(includeTotal ? { total_movies: '2', total_episodes: 40 } : {}), has_more: !after, next_cursor: null,
      } };
    });
    assert.deepEqual((await f.provider.pull(credentials)).watched.movies, ['tmdb:278', 'tmdb:550', 'tt0111161']);
  }
});

test('MDBList accepts confirmed empty histories but never treats a missing nonempty bucket as empty', async () => {
  for (const pagination of [{ total_movies: 0 }, { total: 0, limit: 1000, next_cursor: null }]) {
    const f = fixture(c => c.path === '/sync/watched' && c.params.get('mediatype') === 'movie' ? { pagination } : undefined);
    assert.deepEqual((await f.provider.pull(credentials)).watched.movies, []);
  }
  const empty = fixture(c => c.path === '/sync/watched' && c.params.get('mediatype') === 'movie' ? { movies: [], pagination: { has_more: false } } : undefined);
  assert.deepEqual((await empty.provider.pull(credentials)).watched.movies, []);
  const missing = fixture(c => c.path === '/sync/watched' && c.params.get('mediatype') === 'movie' ? { pagination: { has_more: false } } : undefined);
  await assert.rejects(missing.provider.pull(credentials), /missing or invalid movies array/);
});

test('MDBList rejects cursor loops, contradictory signals, empty continuing pages and missing completion evidence', async () => {
  for (const response of [
    { movies: [movie], pagination: {} },
    { movies: [movie], pagination: { has_more: false, next_cursor: 'secret-cursor' } },
    { movies: [], pagination: { has_more: true } },
    { movies: [], pagination: { next_cursor: 'secret-cursor' } },
    { movies: [movie], pagination: { total: 2, has_more: false } },
    { movies: [movie], pagination: { total: 1, has_more: true } },
    { movies: [movie], pagination: { limit: 0, has_more: false } },
    { movies: [movie], pagination: { total: credentials.token, has_more: false } },
  ]) {
    const f = fixture(c => c.path === '/sync/watched' && c.params.get('mediatype') === 'movie' ? response : undefined);
    await assert.rejects(f.provider.pull(credentials), (error: any) => {
      assert.match(error.message, /MDBList: movies history page 1:/);
      assert.equal(error.message.includes('secret-cursor'), false);
      assert.equal(error.message.includes(credentials.token), false);
      return true;
    });
  }
  const loop = fixture(c => c.path === '/sync/watched' && c.params.get('mediatype') === 'movie' ? {
    movies: [{ movie: { ids: { tmdb: c.params.has('cursor') ? 550 : 278 } } }], pagination: { has_more: true, next_cursor: 'same-cursor' },
  } : undefined);
  await assert.rejects(loop.provider.pull(credentials), /movies history page 2: repeated history cursor/);
  assert.equal(loop.calls.filter(c => c.path === '/sync/watched').length, 2);
});

test('MDBList resolves parent-show IDs nested in episodes for history and playback', async () => {
  const f = fixture(c => c.path === '/sync/playback' ? [{ ...resume, show: undefined,
    episode: { season: 0, number: 2, ids: { tmdb: 999999 }, show: episode.show } }] : undefined);
  const result = await f.provider.pull(credentials);
  assert.deepEqual(result.watched.episodes, ['tmdb:1396:0:1', 'tt0903747:0:1']);
  assert.equal(result.items[0].metaId, 'tt0903747');
  assert.equal(result.items[0].videoId, 'tt0903747:0:2');
  assert.equal(JSON.stringify(result).includes('999999'), false, 'episode IDs must never become show IDs');
});

test('MDBList cleanup is idempotent on HTTP 404 but preserves auth and upstream failures', async () => {
  for (const status of [404, 401, 503]) {
    const f = fixture(c => c.path === '/scrobble/clear' ? new Response('', { status }) : undefined);
    const saved = checkpoint();
    const push = () => f.provider.push(event({ event: 'unplayed' }), 'series', credentials, saved);
    if (status === 404) { await push(); await push(); assert.equal(f.calls.length, 2); }
    else await assert.rejects(push(), (error: any) => error.status === status);
  }
});

test('MDBList validates complete snapshots and never interprets malformed history or playback as empty', async () => {
  for (const response of [{}, { movies: [] }, page('movies', [], 1), page('movies', [movie], 0), page('movies', [{ movie: {} }])]) {
    const f = fixture(c => c.path === '/sync/watched' && c.params.get('mediatype') === 'movie' ? response : undefined);
    await assert.rejects(f.provider.pull(credentials), /MDBList/);
  }
  for (const response of [{}, [{ ...resume, progress: 101 }], [{ ...resume, show: undefined }], [{ ...resume, episode: { ids: { tmdb: 999 } } }]]) {
    const f = fixture(c => c.path === '/sync/playback' ? response : undefined);
    await assert.rejects(f.provider.pull(credentials), /MDBList/);
  }
  const duplicate = fixture(c => c.path === '/sync/watched' ? page('movies', [movie], 2, 'same-cursor') : undefined);
  await assert.rejects(duplicate.provider.pull(credentials), /duplicate/);
  const changing = fixture(c => c.path === '/sync/watched' ? page('movies', [movie], c.params.has('cursor') ? 3 : 2, 'next') : undefined);
  await assert.rejects(changing.provider.pull(credentials), /changed during/);
});

test('MDBList always reads external progress, caches unchanged history and reconciles journal removals', async () => {
  let changed = false, position = 25;
  const f = fixture(c => {
    if (c.path === '/sync/last_activities') return { ...activity, journal_at: changed ? '2026-09-16T11:00:00Z' : at };
    if (c.path === '/sync/playback') return [{ ...resume, progress: position, updated_at: position === 25 ? at : '2026-09-16T11:00:00Z' }];
    if (changed && c.path === '/sync/watched') return page(c.params.get('mediatype') === 'movie' ? 'movies' : 'episodes', []);
  });
  await f.provider.pull(credentials);
  assert.equal(f.calls.length, 5);
  position = 10; // A newer rewind is authoritative too.
  const fresh = await f.provider.pull(credentials);
  assert.equal(f.calls.length, 7);
  assert.equal(fresh.items[0].positionMs, 240000);
  assert.equal(fresh.items[0].at, Date.parse('2026-09-16T11:00:00Z') / 1000);
  changed = true;
  const removed = await f.provider.pull(credentials);
  assert.equal(f.calls.length, 12);
  assert.deepEqual(removed.watched.movies, []);
  assert.deepEqual(removed.watched.episodes, []);
});

test('MDBList separates accounts and refreshes history after its own writes even before activity timestamps change', async () => {
  const f = fixture();
  await f.provider.pull(credentials);
  await f.provider.pull({ token: 'other-account' });
  assert.equal(f.calls.filter(c => c.path === '/sync/watched').length, 4);
  await f.provider.push(event({ event: 'played' }), 'series', credentials, checkpoint());
  const before = f.calls.length;
  await f.provider.pull(credentials);
  assert.equal(f.calls.length - before, 5);
});

test('MDBList preserves unknown runtime as percentage and picks the latest duplicate resume', async () => {
  const f = fixture(c => c.path === '/sync/playback' ? [resume, { ...resume, runtime: 0, progress: 50, updated_at_ts: Date.parse(at) / 1000 + 5 }] : undefined);
  const snapshot = await f.provider.pull(credentials);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].progressPercent, 50);
  assert.equal(snapshot.items[0].positionMs, undefined);
  assert.equal(snapshot.items[0].durationMs, undefined);
});

test('MDBList honors quota retry times and never exposes API keys from upstream errors', async () => {
  for (const status of [401, 429, 500]) {
    const f = fixture(() => new Response(credentials.token, { status, headers: { 'Retry-After': '120' } }));
    await assert.rejects(f.provider.validate(credentials), (error: any) => {
      assert.equal(error.status, status); assert.equal(error.retryAfterMs, 120000);
      assert.equal(error.message.includes(credentials.token), false); return true;
    });
    if (status === 429) {
      await assert.rejects(f.provider.pull(credentials), (error: any) => error.status === 429 && error.retryAfterMs > 119000);
      assert.equal(f.calls.length, 1, 'pull must honor the account cooldown without another remote request');
    }
  }
});

test('MDBList up-next pagination follows offsets and never guesses an episode when the next pointer is absent', async () => {
  const f = fixture(c => {
    if (c.path !== '/upnext') return;
    const first = c.params.get('offset') === '0';
    assert.equal(c.params.get('hide_unreleased'), 'true');
    if (!first) assert.equal(c.params.get('offset'), '1');
    return { items: [{ show: first ? episode.show : { ids: { tmdb: 99 } }, next_episode: first ? { season: 0, number: 2 } : { season_number: 1, episode_number: 5 } }], limit: 100, has_more: first };
  });
  const snapshot = await f.provider.pull(credentials);
  assert.deepEqual(snapshot.watched.nextUp.map(i => i.videoId), ['tt0903747:0:2', 'tmdb:99:1:5']);
  assert.equal(snapshot.watched.counts['tmdb:99'].total, 0);
  const broken = fixture(c => c.path === '/upnext' ? { items: [{ show: episode.show }], has_more: false } : undefined);
  await assert.rejects(broken.provider.pull(credentials), /next-episode/);
});

test('MDBList missing activity markers disable history reuse, and an incomplete initial read cannot prime the cache', async () => {
  for (const activityResponse of [{ watched_at: at }, {}]) {
    const incomplete = fixture(c => c.path === '/sync/last_activities' ? activityResponse : undefined);
    await incomplete.provider.pull(credentials); await incomplete.provider.pull(credentials);
    assert.equal(incomplete.calls.length, 10);
  }
  let broken = true;
  const f = fixture(c => c.path === '/sync/playback' && broken ? {} : undefined);
  await assert.rejects(f.provider.pull(credentials), /playback list/);
  broken = false;
  const before = f.calls.length;
  await f.provider.pull(credentials);
  assert.equal(f.calls.length - before, 5);
  const empty = fixture(c => {
    if (c.path === '/sync/watched') return page(c.params.get('mediatype') === 'movie' ? 'movies' : 'episodes', []);
    if (c.path === '/sync/playback') return [];
    if (c.path === '/upnext') return { items: [], has_more: false };
  });
  assert.deepEqual(await empty.provider.pull(credentials), { items: [], watched: { movies: [], episodes: [], counts: {}, nextUp: [] } });
});

test('MDBList later-page failures preserve the full SQLite snapshot and recovery imports every page', async t => {
  let changed = false, failed = true;
  const f = fixture(c => {
    if (c.path === '/sync/last_activities') return { ...activity, journal_at: changed ? '2026-09-16T12:00:00Z' : at };
    if (!changed || c.path !== '/sync/watched' || c.params.get('mediatype') !== 'movie') return;
    if (!c.params.has('cursor')) return { movies: [movie], pagination: { has_more: true, next_cursor: 'second-page' } };
    if (failed) return new Response('', { status: 503 });
    return { movies: [{ movie: { ids: { tmdb: 550 } } }], pagination: { has_more: false, next_cursor: null } };
  });
  const settings = loadSettings({ GLOBAL_API_KEY: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(64) });
  const store = new Store(':memory:', settings.encryptionKey); t.after(() => store.close());
  const service = new TrackerService(store, settings, { mdblist: f.provider, simkl: f.provider, pmdb: f.provider });
  const p = store.create({ name: 'MDBList', consent: true, pushProviders: [], pullProvider: 'mdblist' });
  store.connect(p.id, 'mdblist', credentials);
  await service.refresh(p);
  const initial = await service.pull(p, null);
  const saved = (store.db.prepare('SELECT data FROM snapshots').get() as any).data;
  changed = true;
  await assert.rejects(service.refresh(p), /503/);
  assert.equal((store.db.prepare('SELECT data FROM snapshots').get() as any).data, saved);
  await assert.rejects(service.pull(p, null), /previous history preserved/);
  assert.equal(Object.hasOwn(await service.pull(p, initial.version), 'watched'), false);
  failed = false; await service.refresh(p);
  const recovered = await service.pull(p, initial.version);
  assert.deepEqual(recovered.watched?.movies, ['tmdb:278', 'tmdb:550', 'tt0111161']);
  assert.notEqual(recovered.version, initial.version);
});

test('MDBList 85% fallback is served locally until a newer external resume replaces it through the service', async t => {
  let external = false;
  const f = fixture(c => c.path === '/sync/playback' ? [{ ...resume, progress: 20, updated_at: external ? '2026-09-16T11:00:00Z' : '2026-09-16T09:00:00Z', paused_at: null }] : undefined);
  const settings = loadSettings({ GLOBAL_API_KEY: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(64) });
  const store = new Store(':memory:', settings.encryptionKey); t.after(() => store.close());
  const service = new TrackerService(store, settings, { mdblist: f.provider, simkl: f.provider, pmdb: f.provider });
  const p = store.create({ name: 'MDBList', consent: true, pushProviders: ['mdblist'], pullProvider: 'mdblist' });
  store.connect(p.id, 'mdblist', credentials);
  const e = event({ positionMs: 2040000 });
  service.enqueue(p, 'series', e);
  await service.deliver(store.db.prepare('SELECT * FROM jobs').get());
  await service.refresh(p);
  assert.equal((await service.pull(p, null)).items[0].positionMs, 2040000);
  external = true; await service.refresh(p);
  assert.equal((await service.pull(p, null)).items[0].positionMs, 480000);
  assert.equal(store.db.prepare('SELECT * FROM overlays').all().length, 0);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});
