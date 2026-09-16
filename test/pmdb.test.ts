import test from 'node:test';
import assert from 'node:assert/strict';
import { PmdbProvider } from '../src/providers/pmdb.ts';
import type { Checkpoint, WatchEvent } from '../src/types.ts';

const credentials = { token: 'pm-test-token' };
type Call = { path: string; method: string; body?: any; headers: Headers };
function fixture(handler: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const call: Call = {
      path: url.pathname + url.search, method: request.method, headers: request.headers,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    assert.equal(call.headers.get('authorization'), 'Bearer pm-test-token');
    return new Response(JSON.stringify(await handler(call)), { headers: { 'Content-Type': 'application/json' } });
  };
  return { provider: new PmdbProvider({ fetch: fetcher }), calls };
}
function list(items: unknown[], total = items.length, page = 1, perPage = 500) {
  return { items, total, page, perPage, totalPages: Math.ceil(total / perPage) };
}
function checkpoint(): Checkpoint {
  const stored = new Map<string, unknown>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (stored.has(key)) return structuredClone(stored.get(key)) as T;
    const result = await fn();
    stored.set(key, structuredClone(result));
    return result;
  };
}
function event(overrides: Partial<WatchEvent> = {}): WatchEvent {
  return {
    id: 'e|tmdb:1399:0:1|played|1789554779', event: 'played', at: 1789554779,
    metaId: 'tmdb:1399', videoId: 'tmdb:1399:0:1', season: 0, episode: 1,
    ...overrides,
  };
}
const movie = { id: 'watched-film', tmdb_id: 550, media_type: 'movie', watched_at: null };
const episode = { id: 'watched-episode', tmdb_id: 1399, media_type: 'tv', season: 0, episode: 1, watched_at: '2026-09-16T10:00:00Z' };
const resume = { id: 'resume-1', tmdb_id: 1399, media_type: 'tv', season: 0, episode: 2, position_ms: 1800, runtime_ms: 6000, created: '2026-09-15T10:00:00Z', updated: '2026-09-16T10:00:00Z' };

test('PMDB pulls every history page, deduplicates watched episodes, preserves specials and real resume times', async () => {
  const first = [movie, episode, ...Array.from({ length: 498 }, (_, index) => ({ ...episode, id: `replay-${index}` }))];
  const { provider, calls } = fixture(({ path }) => {
    const url = new URL(path, 'https://example.test');
    if (url.pathname.endsWith('/watched')) {
      return url.searchParams.get('page') === '1' ? list(first, 501) : list([{ ...episode, id: 'ep-2', episode: 2 }], 501, 2);
    }
    return list([resume]);
  });
  const snapshot = await provider.pull(credentials);
  assert.equal(calls.length, 3);
  assert.deepEqual(snapshot.watched.movies, ['tmdb:550']);
  assert.deepEqual(snapshot.watched.episodes, ['tmdb:1399:0:1', 'tmdb:1399:0:2']);
  assert.deepEqual(snapshot.watched.counts, { 'tmdb:1399': { watched: 2, total: 0 } });
  assert.deepEqual(snapshot.watched.nextUp, []);
  assert.equal(snapshot.items[0].season, 0);
  assert.equal(snapshot.items[0].positionMs, 1800);
  assert.equal(snapshot.items[0].progressPercent, 30);
  assert.equal(snapshot.items[0].at, Date.parse(resume.updated) / 1000);
});

test('PMDB refuses incomplete, malformed or changing snapshots instead of replacing watched with empty data', async () => {
  for (const response of [
    {}, { items: [] }, list([], 1), list([{ ...movie, tmdb_id: 'bad' }]),
    list([{ ...episode, season: null }]),
  ]) {
    const { provider } = fixture(() => response);
    await assert.rejects(provider.pull(credentials), /PublicMetaDB/);
  }
  const { provider } = fixture(({ path }) => path.includes('/watched') ? list([movie]) : { items: 'invalid' });
  await assert.rejects(provider.pull(credentials), /pagination/);
  const changing = fixture(({ path }) => path.includes('page=1') ? list([movie], 2, 1, 1) : list([episode], 3, 2, 1));
  await assert.rejects(changing.provider.pull(credentials), /changé pendant/);
  const duplicate = fixture(({ path }) => list([movie], 2, path.includes('page=1') ? 1 : 2, 1));
  await assert.rejects(duplicate.provider.pull(credentials), /dupliquée/);
});

test('PMDB validates credentials with a minimal authenticated read', async () => {
  const { provider, calls } = fixture(() => list([], 0, 1, 1));
  await provider.validate(credentials);
  assert.equal(calls[0].path, '/api/external/watched?page=1&perPage=1');
  await assert.rejects(provider.validate({ token: '' }), /Clé API/);
});

test('PMDB marks a special watched with the event time and checkpoints prevent replay writes', async () => {
  const { provider, calls } = fixture(({ method }) => method === 'POST' ? { success: true } : list([]));
  const saved = checkpoint();
  await provider.push(event(), 'series', credentials, saved);
  await provider.push(event(), 'series', credentials, saved);
  const writes = calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/external/watched?dedupe=true');
  assert.deepEqual(writes[0].body, { tmdb_id: 1399, media_type: 'tv', season: 0, episode: 1, watched_at: '2026-09-16T10:32:59.000Z' });
});

test('PMDB resolves IMDb only through exact mapping and rejects ambiguity or missing maps', async () => {
  for (const results of [[], [{ tmdb_id: 550, media_type: 'movie' }, { tmdb_id: 551, media_type: 'movie' }]]) {
    const { provider, calls } = fixture(() => ({ results, total: results.length }));
    await assert.rejects(provider.push(event({ metaId: 'tt0137523' }), 'movie', credentials, checkpoint()), /correspondance|Correspondance/);
    assert.equal(calls.length, 1);
  }
  const { provider, calls } = fixture(({ path, method }) => {
    if (path.startsWith('/api/external/mappings/lookup')) return { results: [{ tmdb_id: 550, media_type: 'movie' }], total: 1 };
    return method === 'POST' ? { success: true } : list([]);
  });
  await provider.push(event({ metaId: 'tt0137523', season: undefined, episode: undefined }), 'movie', credentials, checkpoint());
  assert.match(calls[0].path, /id_type=imdb&id_value=tt0137523&media_type=movie/);
  assert.equal(calls.find(call => call.method === 'POST')!.body.tmdb_id, 550);
});

test('PMDB saves partial pause with actual milliseconds and never invents runtime', async () => {
  const { provider, calls } = fixture(({ body }) => ({ action: 'saved', item: { ...body, id: 'new-resume' } }));
  await provider.push(event({ event: 'pause', positionMs: 1800, durationMs: 6000 }), 'series', credentials, checkpoint());
  assert.equal(calls[0].path, '/api/external/resume');
  assert.equal(calls[0].body.position_ms, 1800);
  assert.equal(calls[0].body.runtime_ms, 6000);
});

test('PMDB stop follows the explicit played flag instead of inventing a watched threshold', async () => {
  const { provider, calls } = fixture(({ method }) => method === 'POST' ? { success: true } : list([]));
  await provider.push(event({ event: 'stop', played: true, positionMs: 99, durationMs: 100 }), 'series', credentials, checkpoint());
  assert.equal(calls[0].path, '/api/external/watched?dedupe=true');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('PMDB preserves unsupported progress locally and removes stale remote resume without marking watched', async () => {
  for (const values of [
    { positionMs: 1, durationMs: 100 }, { positionMs: 80, durationMs: 100 },
    { positionMs: 89, durationMs: 100 }, { positionMs: 2000 },
  ]) {
    const { provider, calls } = fixture(({ method }) => method === 'GET' ? list([{ ...resume, episode: 1 }]) : { success: true });
    const result = await provider.push(event({ event: 'stop', played: false, ...values }), 'series', credentials, checkpoint());
    assert.equal(result?.localOnly, true);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(calls.at(-1)?.path, '/api/external/resume/resume-1');
    assert.equal(calls.at(-1)?.method, 'DELETE');
  }
});

test('PMDB start clears the exact resume and unplayed deletes only the exact episode history', async () => {
  for (const action of ['start', 'unplayed'] as const) {
    const { provider, calls } = fixture(({ method, path }) => {
      if (method === 'GET') return list([{ ...resume, episode: 1 }]);
      if (path.startsWith('/api/external/watched')) return { success: true, deleted: 2 };
      return { success: true };
    });
    await provider.push(event({ event: action }), 'series', credentials, checkpoint());
    assert.equal(calls.at(-1)?.path, '/api/external/resume/resume-1');
    if (action === 'unplayed') assert.equal(calls[0].path, '/api/external/watched?tmdb_id=1399&media_type=tv&season=0&episode=1');
    else assert.ok(calls.every(call => !call.path.includes('/watched')));
  }
});

test('PMDB rejects absolute or anime numbering and unsplit bulk before making upstream requests', async () => {
  const { provider, calls } = fixture(() => { throw new Error('Unexpected request'); });
  for (const value of [event({ season: null }), event({ metaId: 'kitsu:123', ids: { tmdb: '1399' }, season: 1 }), event({ metaId: 'tt1234567', videoId: 'kitsu:123:7', ids: { tmdb: '1399' }, season: 1 }), event({ scope: 'season', videos: [] })]) {
    await assert.rejects(provider.push(value, 'series', credentials, checkpoint()));
  }
  assert.equal(calls.length, 0);
});

test('PMDB refuses to delete a different episode if upstream ignores resume filters', async () => {
  const { provider, calls } = fixture(() => list([resume]));
  await assert.rejects(provider.push(event({ event: 'start' }), 'series', credentials, checkpoint()), /autre vidéo/);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('PMDB does not accept a successful HTTP response without the expected write confirmation', async () => {
  const { provider } = fixture(() => ({ success: false }));
  await assert.rejects(provider.push(event(), 'series', credentials, checkpoint()), /confirmation/);
});
