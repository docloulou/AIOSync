import test from 'node:test';
import assert from 'node:assert/strict';
import { SimklProvider } from '../src/providers/simkl.ts';
import { UpstreamError } from '../src/http.ts';
import type { Checkpoint, WatchEvent } from '../src/types.ts';

type Call = { url: URL; method: string; body: any; headers: Headers };
let sequence = 0;
function fixture(handler: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const provider = new SimklProvider({ clientId: 'client', fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call = { url: new URL(String(input)), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) };
    calls.push(call);
    const value = handler(call);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch });
  return { provider, calls, credentials: { token: `simkl-test-${++sequence}` } };
}
function checkpoint(): Checkpoint {
  const values = new Map<string, unknown>();
  return async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    if (values.has(key)) return values.get(key) as T;
    const value = await operation(); values.set(key, value); return value;
  };
}
const base: WatchEvent = {
  id: 'event', event: 'pause', at: 1789550400, metaId: 'tt0903747', videoId: 'tt0903747:3:7',
  season: 3, episode: 7, ids: { imdb: 'tt0903747', tmdb: '1396', tvdb: '81189' },
};
const activity = (time: string, removed = '2026-01-01T00:00:00Z') => ({ all: time, tv_shows: { removed_from_list: removed }, movies: { removed_from_list: removed }, anime: { removed_from_list: removed } });

test('Simkl preserves incomplete 85% stop instead of applying its own 80% completion threshold', async () => {
  const f = fixture(() => ({ action: 'pause' }));
  await f.provider.push({ ...base, event: 'stop', played: false, positionMs: 85000, durationMs: 100000 }, 'series', f.credentials, checkpoint());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url.pathname, '/scrobble/pause');
  assert.equal(f.calls[0]!.body.progress, 85);
  assert.deepEqual(f.calls[0]!.body.episode, { season: 3, number: 7 });
  assert.equal(f.calls[0]!.headers.get('Authorization'), `Bearer ${f.credentials.token}`);
  assert.equal(f.calls[0]!.url.searchParams.get('client_id'), 'client');
  assert.ok(f.calls[0]!.url.searchParams.has('app-name'));
});

test('Simkl start uses native start and unknown duration never overwrites resume at zero', async () => {
  const f = fixture(() => ({ action: 'start' }));
  const result = await f.provider.push({ ...base, positionMs: 5000 }, 'series', f.credentials, checkpoint());
  assert.equal(result?.localOnly, true);
  assert.equal(f.calls.length, 0);
  await f.provider.push({ ...base, event: 'start', positionMs: 5000, durationMs: 10000 }, 'series', f.credentials, checkpoint());
  assert.equal(f.calls[0]!.url.pathname, '/scrobble/start');
  assert.equal(f.calls[0]!.body.progress, 50);
});

test('Simkl played:true writes history with event date even without runtime', async () => {
  const f = fixture(call => call.url.pathname === '/sync/playback' ? [] : ({ added: { episodes: 1 }, not_found: { shows: [] } }));
  await f.provider.push({ ...base, event: 'stop', played: true }, 'series', f.credentials, checkpoint());
  const write = f.calls[0]!;
  assert.equal(write.url.pathname, '/sync/history');
  assert.equal(write.body.shows[0].use_tvdb_anime_seasons, true);
  assert.deepEqual(write.body.shows[0].seasons, [{ number: 3, episodes: [{ number: 7, watched_at: new Date(base.at * 1000).toISOString() }] }]);
});

test('Simkl bulk history only sends supplied episodes, including specials', async () => {
  const f = fixture(call => call.url.pathname === '/sync/playback' ? [] : ({ added: { episodes: 3 }, not_found: { shows: [] } }));
  await f.provider.push({ ...base, event: 'played', scope: 'series', videos: [
    { videoId: 'tt0903747:0:1', season: 0, episode: 1 },
    { videoId: 'tt0903747:1:2', season: 1, episode: 2 },
    { videoId: 'tt0903747:3:7', season: 3, episode: 7 },
  ] }, 'series', f.credentials, checkpoint());
  const seasons = f.calls[0]!.body.shows[0].seasons;
  assert.deepEqual(seasons.map((s: any) => [s.number, s.episodes.map((e: any) => e.number)]), [[0, [1]], [1, [2]], [3, [7]]]);
  assert.ok(seasons.every((s: any) => s.episodes.length));
});

test('Simkl respects native video ID space when parent metadata is IMDb', async () => {
  const f = fixture(call => call.url.pathname === '/sync/playback' ? [] : ({ added: {}, not_found: {} }));
  const anime: WatchEvent = { ...base, event: 'played', metaId: 'tt13293588', videoId: 'kitsu:42323:7', season: 1, episode: 7, ids: { imdb: 'tt13293588', tmdb: '94664', kitsu: '42323' } };
  await f.provider.push(anime, 'series', f.credentials, checkpoint());
  assert.deepEqual(f.calls[0]!.body.shows[0].ids, { kitsu: '42323' });
  assert.equal(f.calls[0]!.body.shows[0].seasons, undefined);
  assert.equal(f.calls[0]!.body.shows[0].episodes[0].number, 7);
  await assert.rejects(f.provider.push({ ...base, season: null }, 'series', f.credentials, checkpoint()), /absolu sans identifiant/);
});

test('Simkl unplayed clears only matching saved resume and retry checkpoints avoid repeating history', async () => {
  let failedOnce = false;
  const f = fixture(call => {
    if (call.url.pathname === '/sync/playback') return [
      { id: 10, show: { ids: { imdb: 'tt0903747' } }, episode: { season: 3, number: 7 } },
      { id: 11, show: { ids: { imdb: 'tt0903747' } }, episode: { season: 3, number: 8 } },
    ];
    if (call.method === 'DELETE') {
      if (!failedOnce) { failedOnce = true; return new Response('', { status: 503 }); }
      return new Response(null, { status: 204 });
    }
    return { deleted: { episodes: 1 }, not_found: { shows: [] } };
  });
  const run = checkpoint();
  await assert.rejects(f.provider.push({ ...base, event: 'unplayed' }, 'series', f.credentials, run));
  await f.provider.push({ ...base, event: 'unplayed' }, 'series', f.credentials, run);
  assert.equal(f.calls.filter(c => c.url.pathname === '/sync/history/remove').length, 1);
  assert.equal(f.calls.filter(c => c.url.pathname === '/sync/playback').length, 1);
  assert.deepEqual(f.calls.filter(c => c.method === 'DELETE').map(c => c.url.pathname), ['/sync/playback/10', '/sync/playback/10']);
});

test('Simkl does not report success for provider not_found', async () => {
  const f = fixture(() => ({ added: { episodes: 0 }, not_found: { shows: [{ ids: { imdb: 'tt0903747' } }] } }));
  await assert.rejects(f.provider.push({ ...base, event: 'played' }, 'series', f.credentials, checkpoint()), (error: unknown) => error instanceof UpstreamError && error.status === 422 && /non reconnu/.test(error.message));
});

test('Simkl partial bulk not_found returns saved diagnostics without replaying successful writes', async () => {
  const f = fixture(call => call.url.pathname === '/sync/playback' ? [] : ({ added: { episodes: 1 }, not_found: { shows: [{ ids: { imdb: 'tt0903747' }, seasons: [{ number: 3, episodes: [{ number: 8 }] }] }] } }));
  const run = checkpoint();
  const event: WatchEvent = { ...base, event: 'played', scope: 'season', videos: [
    { videoId: 'tt0903747:3:7', season: 3, episode: 7 },
    { videoId: 'tt0903747:3:8', season: 3, episode: 8 },
  ] };
  const first = await f.provider.push(event, 'series', f.credentials, run);
  const second = await f.provider.push(event, 'series', f.credentials, run);
  assert.match(first?.warning ?? '', /tt0903747.*S3E8/);
  assert.deepEqual(first, second);
  assert.equal(f.calls.filter(c => c.url.pathname === '/sync/history').length, 1);
});

test('Simkl full pull includes completed episodes, native anime mapping, authoritative nextUp and playback', async () => {
  const f = fixture(call => {
    if (call.url.pathname === '/sync/activities') return activity('2026-09-16T12:00:00Z');
    if (call.url.pathname === '/sync/all-items/shows') return { shows: [{
      status: 'watching', show: { runtime: 43, ids: { simkl: 1, imdb: 'tt0903747', tmdb: 1396 } }, watched_episodes_count: 2, total_episodes_count: 62,
      seasons: [{ number: 3, episodes: [{ number: 7, watched_at: '2026-09-15T12:00:00Z' }, { number: 8 }] }],
      next_to_watch: 'S03E10', next_to_watch_info: { season: 3, episode: 10 }, last_watched_at: '2026-09-15T12:00:00Z',
    }] };
    if (call.url.pathname === '/sync/all-items/movies') return { movies: [{ status: 'completed', movie: { ids: { simkl: 2, imdb: 'tt0111161' } } }] };
    if (call.url.pathname === '/sync/all-items/anime') return { anime: [{
      status: 'completed', anime_type: 'tv', show: { ids: { simkl: 3, kitsu: 42323, mal: 39535, imdb: 'tt13293588' } }, watched_episodes_count: 1, total_episodes_count: 12,
      seasons: [{ number: 1, episodes: [{ number: 4, tvdb: { season: 2, episode: 4 } }] }],
    }] };
    if (call.url.pathname === '/sync/playback') return [{ id: 4, type: 'episode', show: { ids: { simkl: 1, imdb: 'tt0903747' } }, episode: { season: 3, episode: 9 }, progress: 28.5, paused_at: '2026-09-16T11:00:00Z' }];
    throw new Error('unexpected');
  });
  const snapshot = await f.provider.pull(f.credentials);
  assert.ok(snapshot.watched.movies.includes('tt0111161'));
  assert.ok(snapshot.watched.episodes.includes('tt0903747:3:7'));
  assert.ok(snapshot.watched.episodes.includes('kitsu:42323:4'));
  assert.ok(snapshot.watched.episodes.includes('tt13293588:2:4'));
  assert.ok(!snapshot.watched.episodes.includes('tt13293588:1:4'));
  assert.equal(snapshot.watched.nextUp.find(v => v.metaId === 'tt0903747')?.episode, 10);
  assert.equal(snapshot.watched.nextUp.length, 1, 'one pointer per title, not one per identifier alias');
  assert.equal(snapshot.items.length, 1, 'one resume per playback, not one per identifier alias');
  assert.equal(snapshot.items.find(v => v.metaId === 'tt0903747')?.progressPercent, 28.5);
  assert.equal(snapshot.items.find(v => v.metaId === 'tt0903747')?.durationMs, 43 * 60000);
  assert.equal(snapshot.items.find(v => v.metaId === 'tt0903747')?.positionMs, Math.round(43 * 60000 * 0.285));
  assert.deepEqual(snapshot.watched.counts['tmdb:1396'], { watched: 2, total: 62 });
  assert.equal(snapshot.watched.counts.tt13293588, undefined, 'an anime cour is not the franchise total');
  const historyCalls = f.calls.filter(c => c.url.pathname.startsWith('/sync/all-items'));
  assert.deepEqual(historyCalls.map(c => c.url.pathname), ['/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
  assert.ok(historyCalls.every(c => c.url.searchParams.get('include_all_episodes') === 'yes'));
  await f.provider.pull(f.credentials);
  assert.equal(f.calls.filter(c => c.url.pathname.startsWith('/sync/all-items')).length, 3, 'activities gate avoids expensive full repulls');
  assert.equal(f.calls.filter(c => c.url.pathname === '/sync/playback').length, 2, 'playbacks are read every pull');
});

test('Simkl incremental deletions reconcile the full snapshot and failures never commit an empty history', async () => {
  let state = 0;
  const f = fixture(call => {
    if (call.url.pathname === '/sync/activities') return activity(state === 0 ? '2026-09-15T12:00:00Z' : '2026-09-16T12:00:00Z', state === 0 ? '2026-01-01T00:00:00Z' : '2026-09-16T12:00:00Z');
    if (call.url.pathname === '/sync/all-items/movies') return { movies: [{ status: 'completed', movie: { ids: { simkl: 2, imdb: 'tt0111161' } } }] };
    if (call.url.pathname === '/sync/all-items') {
      if (state === 1 && call.url.searchParams.get('extended') === 'simkl_ids_only') return new Response('', { status: 503 });
      return {};
    }
    if (call.url.pathname === '/sync/playback') return [];
    return {};
  });
  assert.ok((await f.provider.pull(f.credentials)).watched.movies.includes('tt0111161'));
  state = 1;
  await assert.rejects(f.provider.pull(f.credentials));
  state = 2;
  const result = await f.provider.pull(f.credentials);
  assert.deepEqual(result.watched.movies, []);
  const deltas = f.calls.filter(c => c.url.searchParams.has('date_from'));
  assert.equal(deltas.length, 2);
  assert.ok(deltas.every(c => c.url.searchParams.get('date_from') === '2026-09-15T12:00:00Z'));
});

test('Simkl absolute playback remains season:null without TV mapping', async () => {
  const f = fixture(call => {
    if (call.url.pathname === '/sync/activities') return activity('2026-09-16T12:00:00Z');
    if (call.url.pathname === '/sync/playback') return [{ id: 4, type: 'episode', show: { ids: { simkl: 3, kitsu: 42323, imdb: 'tt13293588' } }, episode: { number: 199 }, progress: 23, paused_at: '2026-09-16T11:00:00Z' }];
    return {};
  });
  const snapshot = await f.provider.pull(f.credentials);
  const item = snapshot.items.find(v => v.metaId === 'kitsu:42323');
  assert.equal(item?.season, null);
  assert.equal(item?.videoId, 'kitsu:42323:199');
  assert.equal(snapshot.items.find(v => v.metaId === 'tt13293588'), undefined);
  assert.equal(snapshot.items.length, 1);
});

test('Simkl movie resume chooses IMDb once even when several identifiers are available', async () => {
  const f = fixture(call => {
    if (call.url.pathname === '/sync/activities') return activity('2026-09-16T12:00:00Z');
    if (call.url.pathname === '/sync/playback') return [{ id: 4, movie: { ids: { simkl: 3, tmdb: 55, imdb: 'tt0111161' } }, progress: 23 }];
    return {};
  });
  assert.deepEqual((await f.provider.pull(f.credentials)).items, [{ type: 'movie', metaId: 'tt0111161', videoId: 'tt0111161', progressPercent: 23 }]);
});

test('Simkl accepts documented empty-object libraries, rejects successful HTTP error envelopes', async () => {
  for (const bad of [{ error: 'temporarily_unavailable' }, { message: 'try later' }, { shows: [], error: 'failure' }, { movies: null }]) {
    const f = fixture(call => {
      if (call.url.pathname === '/sync/activities') return activity('2026-09-16T12:00:00Z');
      if (call.url.pathname === '/sync/all-items/shows') return bad;
      return {};
    });
    await assert.rejects(f.provider.pull(f.credentials), (error: unknown) => error instanceof UpstreamError && error.status === 502);
  }
  const empty = fixture(call => {
    if (call.url.pathname === '/sync/activities') return activity('2026-09-16T12:00:00Z');
    return call.url.pathname === '/sync/playback' ? [] : {};
  });
  assert.deepEqual(await empty.provider.pull(empty.credentials), { items: [], watched: { movies: [], episodes: [], counts: {}, nextUp: [] } });
});

test('Simkl thin identifier reconciliation preserves retained titles and rejects errors before clearing', async () => {
  let phase = 0;
  const f = fixture(call => {
    if (call.url.pathname === '/sync/activities') return activity(phase === 0 ? '2026-09-15T12:00:00Z' : '2026-09-16T12:00:00Z', phase === 0 ? '2026-01-01T00:00:00Z' : '2026-09-16T12:00:00Z');
    if (call.url.pathname === '/sync/all-items/movies') return { movies: [
      { status: 'completed', movie: { ids: { simkl: 2, imdb: 'tt0111161' } } },
      { status: 'completed', movie: { ids: { simkl: 3, imdb: 'tt1375666' } } },
    ] };
    if (call.url.searchParams.get('extended') === 'simkl_ids_only') return phase === 1 ? { error: 'unavailable' } : { movies: [{ movie: { ids: { simkl: 2 } } }] };
    return call.url.pathname === '/sync/playback' ? [] : {};
  });
  assert.ok((await f.provider.pull(f.credentials)).watched.movies.includes('tt1375666'));
  phase = 1;
  await assert.rejects(f.provider.pull(f.credentials));
  phase = 2;
  const snapshot = await f.provider.pull(f.credentials);
  assert.ok(snapshot.watched.movies.includes('tt0111161'));
  assert.ok(!snapshot.watched.movies.includes('tt1375666'));
  assert.equal(f.calls.filter(c => c.url.searchParams.get('date_from') === '2026-09-15T12:00:00Z').length, 2, 'failed reconciliation did not advance the watermark');
});
