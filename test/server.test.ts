import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server.ts';
import { loadSettings } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { UpstreamError } from '../src/http.ts';
import { hash } from '../src/security.ts';
import type { Credentials, Provider, ProviderName, Snapshot, WatchEvent, MediaType, Checkpoint } from '../src/types.ts';

class FakeProvider implements Provider {
  name: ProviderName;
  validations: string[] = [];
  pushes: { event: WatchEvent; type: MediaType; token: string }[] = [];
  pulls: string[] = [];
  failure: UpstreamError | undefined;
  snapshots = new Map<string, Snapshot>();
  constructor(name: ProviderName) { this.name = name; }
  async validate(credentials: Credentials) {
    this.validations.push(credentials.token);
    if (credentials.token.startsWith('invalid')) throw new UpstreamError('Invalid upstream access token', 401);
  }
  async push(event: WatchEvent, type: MediaType, credentials: Credentials, checkpoint: Checkpoint) {
    this.pushes.push({ event: structuredClone(event), type, token: credentials.token });
    if (this.failure) throw this.failure;
    await checkpoint('remote-write', async () => ({ accepted: true }));
  }
  async pull(credentials: Credentials) {
    this.pulls.push(credentials.token);
    return structuredClone(this.snapshots.get(credentials.token) || emptySnapshot());
  }
}

function emptySnapshot(): Snapshot {
  return { items: [], watched: { movies: [], episodes: [], counts: {}, nextUp: [] } };
}

type RequestOptions = { method?: string; body?: unknown; auth?: boolean; cookie?: string; origin?: string; headers?: Record<string, string>; raw?: string };

async function fixture(t: TestContext) {
  const settings = loadSettings({
    GLOBAL_API_KEY: 'test-global-api-key-at-least-thirty-two-characters',
    ENCRYPTION_KEY: 'ab'.repeat(32), PUBLIC_BASE_URL: 'http://127.0.0.1:7000',
    SIMKL_CLIENT_ID: 'test-client-id', SIMKL_CLIENT_SECRET: 'test-client-secret',
    SIMKL_ACCESS_TOKEN: 'simkl-env-token-private', PMDB_API_KEY: 'pmdb-env-token-private',
    SYNC_INTERVAL_SECONDS: '3600',
  });
  const store = new Store(':memory:', settings.encryptionKey);
  const providers = { simkl: new FakeProvider('simkl'), pmdb: new FakeProvider('pmdb') };
  const app = createApp(settings, { store, providers });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  settings.baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    await app.service.stop();
    store.close();
  });
  async function request(path: string, options: RequestOptions = {}) {
    const headers: Record<string, string> = { ...(options.auth === false ? {} : { Authorization: `Bearer ${settings.apiKey}` }), ...options.headers };
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.origin) headers.Origin = options.origin;
    let body: string | undefined;
    if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(options.body); }
    if (options.raw !== undefined) { headers['Content-Type'] ??= 'application/json'; body = options.raw; }
    const response = await fetch(new URL(path, settings.baseUrl), { method: options.method || 'GET', headers, body, redirect: 'manual' });
    const text = await response.text();
    let data: any; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, headers: response.headers, data, text };
  }
  async function login() {
    const result = await request('/api/login', { method: 'POST', body: { apiKey: settings.apiKey }, auth: false, origin: settings.baseUrl });
    assert.equal(result.status, 200);
    const cookie = result.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    return cookie.split(';')[0];
  }
  async function profile(name = 'Lucas') {
    const result = await request('/api/profiles', { method: 'POST', body: { name, pullProvider: null, pushProviders: [], consent: false } });
    assert.equal(result.status, 201, result.text);
    return result.data;
  }
  async function connect(id: string, provider: ProviderName, token?: string) {
    const result = await request(`/api/profiles/${id}/connections/${provider}`, { method: 'POST', body: token ? { token } : {} });
    assert.equal(result.status, 200, result.text);
    return result;
  }
  async function configure(id: string, settings: { name?: string; pullProvider?: ProviderName | null; pushProviders?: ProviderName[]; consent?: boolean } = {}) {
    const result = await request(`/api/profiles/${id}`, { method: 'PUT', body: { name: 'Lucas', pullProvider: null, pushProviders: [], consent: true, ...settings } });
    assert.equal(result.status, 200, result.text);
    return result.data;
  }
  function addon(p: any, path: string) { return new URL(p.manifestUrl).pathname.replace('manifest.json', path); }
  async function settle() {
    await app.service.stop();
    for (let n = 0; n < 30; n++) {
      const pending = store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='pending' AND due<=?").get(Date.now()) as { n: number };
      if (!pending.n) break;
      await app.service.tick();
      await app.service.stop();
    }
  }
  return { ...app, settings, providers, request, login, profile, connect, configure, addon, settle };
}

function movieEvent(id = 'event-1'): WatchEvent {
  return { id, event: 'played', at: 1789542000, scope: 'movie', metaId: 'tt1234567', videoId: 'tt1234567', played: true };
}

test('HTTP admin auth: cookie session, bearer, origin checks, logout and security headers', async (t) => {
  const f = await fixture(t);
  const status = await f.request('/api/status', { auth: false });
  assert.equal(status.status, 200);
  assert.equal(status.data.authenticated, false);
  assert.equal(status.data.simklOAuth, false);
  assert.equal(status.data.pmdbEnvToken, false);
  assert.equal((await f.request('/api/profiles', { auth: false })).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { apiKey: 'wrong' }, auth: false })).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { apiKey: f.settings.apiKey }, auth: false, origin: 'https://evil.example' })).status, 403);
  const cookie = await f.login();
  const authorized = await f.request('/api/status', { auth: false, cookie });
  assert.equal(authorized.data.authenticated, true);
  assert.equal(authorized.data.simklOAuth, true);
  assert.equal(authorized.data.simklEnvToken, true);
  assert.equal(authorized.data.pmdbEnvToken, true);
  assert.equal((await f.request('/api/profiles', { auth: false, cookie })).status, 200);
  assert.equal((await f.request('/api/profiles')).status, 200);
  assert.equal((await f.request('/api/profiles', { method: 'POST', auth: false, cookie, origin: 'https://evil.example', body: {} })).status, 403);
  const page = await f.request('/', { auth: false });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const logout = await f.request('/api/logout', { method: 'POST', body: {}, auth: false, cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal((await f.request('/api/profiles', { auth: false, cookie })).status, 401);
});

test('HTTP independent profiles: private tokens, account identity, capabilities, rotation and cascade deletion', async (t) => {
  const f = await fixture(t);
  const alice = await f.profile('Alice');
  const bob = await f.profile('Bob');
  assert.notEqual(alice.id, bob.id);
  assert.notEqual(alice.manifestUrl, bob.manifestUrl);
  await f.connect(alice.id, 'simkl', 'simkl-private-alice');
  await f.connect(alice.id, 'pmdb', 'pmdb-private-alice');
  await f.connect(bob.id, 'simkl', 'simkl-private-bob');
  const list = await f.request('/api/profiles');
  assert.deepEqual(list.data.profiles.map((p: any) => p.name), ['Alice', 'Bob']);
  assert.equal(list.data.profiles[1].connections.pmdb, undefined);
  const privateStrings = [f.settings.apiKey, f.settings.encryptionKey, f.settings.simklClientSecret, 'simkl-private-alice', 'pmdb-private-alice', 'simkl-private-bob', f.store.profile(alice.id)!.token];
  for (const secret of privateStrings) assert.equal(list.text.includes(secret), false, `Profile API must not expose ${secret.slice(0, 6)}`);
  const encrypted = f.store.db.prepare('SELECT secret FROM connections').all() as { secret: string }[];
  assert.equal(JSON.stringify(encrypted).includes('simkl-private-alice'), false);
  assert.equal(f.store.credentials(alice.id, 'simkl')?.token, 'simkl-private-alice');
  assert.equal(f.store.credentials(bob.id, 'simkl')?.token, 'simkl-private-bob');
  await f.configure(alice.id, { name: 'Alice', pullProvider: 'simkl', pushProviders: ['simkl'] });
  await f.configure(bob.id, { name: 'Bob', pullProvider: 'simkl', pushProviders: ['simkl'] });
  const aliceSnapshot = emptySnapshot(); aliceSnapshot.watched.movies.push('tt1000001');
  const bobSnapshot = emptySnapshot(); bobSnapshot.watched.movies.push('tt2000002');
  f.providers.simkl.snapshots.set('simkl-private-alice', aliceSnapshot);
  f.providers.simkl.snapshots.set('simkl-private-bob', bobSnapshot);
  for (const profile of [alice, bob]) {
    const result = await f.request(f.addon(profile, 'watch_state/push/movie/tt1234567.json'), { method: 'POST', auth: false, body: movieEvent('same-id-across-profiles') });
    assert.equal(result.status, 200);
  }
  await f.settle();
  assert.deepEqual(f.providers.simkl.pushes.map((push) => push.token).sort(), ['simkl-private-alice', 'simkl-private-bob']);
  assert.deepEqual((await f.request(f.addon(alice, 'watch_state/pull.json'), { auth: false })).data.watched.movies, ['tt1000001']);
  assert.deepEqual((await f.request(f.addon(bob, 'watch_state/pull.json'), { auth: false })).data.watched.movies, ['tt2000002']);
  const original = f.addon(alice, 'manifest.json');
  const forged = original.replace(alice.id, bob.id);
  assert.equal((await f.request(forged, { auth: false })).status, 401);
  assert.equal((await f.request(original, { auth: false })).status, 200);
  const rotate = await f.request(`/api/profiles/${alice.id}/rotate`, { method: 'POST', body: {} });
  assert.equal(rotate.status, 200);
  assert.notEqual(rotate.data.manifestUrl, alice.manifestUrl);
  assert.equal((await f.request(original, { auth: false })).status, 401);
  assert.equal((await f.request(new URL(rotate.data.manifestUrl).pathname, { auth: false })).status, 200);
  assert.equal((await f.request(f.addon(bob, 'manifest.json'), { auth: false })).status, 200);
  await f.request(`/api/profiles/${alice.id}`, { method: 'DELETE' });
  assert.equal(f.store.profile(alice.id), undefined);
  assert.equal(f.store.credentials(alice.id, 'simkl'), undefined);
  assert.equal((await f.request(new URL(rotate.data.manifestUrl).pathname, { auth: false })).status, 401);
  assert.equal((await f.request('/api/profiles')).data.profiles.length, 1);
});

test('HTTP connections: env fallback, validation failure, safe account replacement and disconnect routing', async (t) => {
  const f = await fixture(t);
  const p = await f.profile();
  const bad = await f.request(`/api/profiles/${p.id}/connections/simkl`, { method: 'POST', body: { token: 'invalid-simkl' } });
  assert.equal(bad.status, 400);
  assert.equal(f.store.credentials(p.id, 'simkl'), undefined);
  await f.connect(p.id, 'simkl');
  await f.connect(p.id, 'pmdb');
  assert.deepEqual(f.providers.simkl.validations, ['invalid-simkl', f.settings.simklAccessToken]);
  assert.deepEqual(f.providers.pmdb.validations, [f.settings.pmdbApiKey]);
  const replacement = await f.request(`/api/profiles/${p.id}/connections/simkl`, { method: 'POST', body: { token: 'different-account' } });
  assert.equal(replacement.status, 400);
  assert.equal(f.store.credentials(p.id, 'simkl')?.token, f.settings.simklAccessToken);
  await f.configure(p.id, { pullProvider: 'simkl', pushProviders: ['simkl', 'pmdb'] });
  assert.equal((await f.request(`/api/profiles/${p.id}/connections/simkl`, { method: 'DELETE' })).status, 200);
  const current = (await f.request('/api/profiles')).data.profiles[0];
  assert.equal(current.pullProvider, null);
  assert.deepEqual(current.pushProviders, ['pmdb']);
  assert.equal(current.connections.simkl, undefined);
  await f.connect(p.id, 'simkl', 'different-account');
  assert.equal(f.store.credentials(p.id, 'simkl')?.token, 'different-account');
});

test('HTTP watch-state v2: advertised routes, fan-out, deduplication, canonical pull and version cursor', async (t) => {
  const f = await fixture(t);
  const p = await f.profile();
  await f.connect(p.id, 'simkl', 's-token');
  await f.connect(p.id, 'pmdb', 'p-token');
  await f.configure(p.id, { pullProvider: 'simkl', pushProviders: ['simkl', 'pmdb'] });
  f.providers.simkl.snapshots.set('s-token', {
    items: [{ type: 'series', metaId: 'tt7654321', videoId: 'tt7654321:1:2', season: 1, episode: 2, positionMs: 300000, durationMs: 1200000, progressPercent: 25, at: 1789542010 }],
    watched: { movies: ['tt1234567'], episodes: ['tt7654321:1:1'], counts: { tt7654321: { watched: 1, total: 10 } }, nextUp: [{ type: 'series', metaId: 'tt7654321', videoId: 'tt7654321:1:2', season: 1, episode: 2 }] },
  });
  const manifest = await f.request(f.addon(p, 'manifest.json'), { auth: false });
  assert.equal(manifest.data.watchState.version, 2);
  assert.equal(manifest.data.watchState.push.bulk, true);
  assert.deepEqual(manifest.data.watchState.push.events, ['start', 'pause', 'stop', 'played', 'unplayed']);
  assert.equal(manifest.data.watchState.pull.watched, true);
  assert.equal(manifest.headers.get('access-control-allow-origin'), '*');
  const pushPath = f.addon(p, 'watch_state/push/movie/tt1234567.json');
  const push = await f.request(pushPath, { method: 'POST', body: movieEvent(), auth: false, origin: 'https://aiostreams.example' });
  assert.equal(push.status, 200, push.text);
  assert.deepEqual(push.data, { accepted: true });
  await f.settle();
  assert.equal(f.providers.simkl.pushes.length, 1);
  assert.equal(f.providers.pmdb.pushes.length, 1);
  assert.equal(f.providers.simkl.pushes[0].token, 's-token');
  assert.equal(f.providers.pmdb.pushes[0].token, 'p-token');
  assert.equal((await f.request(pushPath, { method: 'POST', body: movieEvent(), auth: false })).status, 200);
  await f.settle();
  assert.equal(f.providers.simkl.pushes.length, 1);
  assert.equal(f.providers.pmdb.pushes.length, 1);
  const pull = await f.request(f.addon(p, 'watch_state/pull.json'), { auth: false });
  assert.equal(pull.status, 200);
  assert.equal(typeof pull.data.version, 'string');
  assert.equal(pull.data.items[0].progressPercent, 25);
  assert.deepEqual(pull.data.watched.movies, ['tt1234567']);
  assert.deepEqual(pull.data.watched.episodes, ['tt7654321:1:1']);
  const unchanged = await f.request(f.addon(p, `watch_state/pull.json?since=${pull.data.version}`), { auth: false });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.data.version, pull.data.version);
  assert.equal(unchanged.data.watched, undefined);
  assert.equal(unchanged.data.items.length, 1);
  const jobs = await f.request(`/api/profiles/${p.id}/jobs`);
  assert.equal(jobs.data.jobs.length, 2);
  assert.equal(jobs.text.includes('s-token'), false);
  assert.equal(jobs.text.includes('p-token'), false);
  assert.ok(jobs.data.jobs.every((job: any) => job.status === 'done' && job.event === 'played'));
});

test('HTTP job diagnostics expose timing and media fields only to authenticated administrators', async (t) => {
  const f = await fixture(t);
  const p = await f.profile();
  await f.connect(p.id, 'simkl', 'diagnostics-private-token');
  await f.configure(p.id, { pushProviders: ['simkl'] });
  const event = { ...movieEvent('diagnostic-event'), event: 'pause' as const, played: false, positionMs: 45000, durationMs: 100000, ids: { imdb: 'tt1234567', private: 'excluded-identifier' } };
  assert.equal((await f.request(f.addon(p, 'watch_state/push/movie/tt1234567.json'), { method: 'POST', auth: false, body: event })).status, 200);
  await f.settle();
  const path = `/api/profiles/${p.id}/jobs`;
  assert.equal((await f.request(path, { auth: false })).status, 401);
  const result = await f.request(path);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.jobs, [{ provider: 'simkl', status: 'done', error: null, attempts: 1,
    event: 'pause', at: event.at, metaId: event.metaId, videoId: event.videoId, positionMs: 45000, durationMs: 100000, played: false }]);
  for (const secret of [f.settings.apiKey, f.settings.encryptionKey, f.settings.simklClientSecret, 'diagnostics-private-token', 'excluded-identifier', f.store.profile(p.id)!.token, p.manifestUrl]) {
    assert.equal(result.text.includes(secret), false);
  }
});

test('HTTP malformed and bulk events: reject invalid atomic input, split PMDB episodes and preserve SIMKL bulk', async (t) => {
  const f = await fixture(t);
  const p = await f.profile();
  await f.connect(p.id, 'simkl', 's'); await f.connect(p.id, 'pmdb', 'p');
  await f.configure(p.id, { pushProviders: ['simkl', 'pmdb'] });
  const moviePath = f.addon(p, 'watch_state/push/movie/tt1234567.json');
  assert.equal((await f.request(moviePath, { method: 'POST', auth: false, raw: '{' })).status, 400);
  assert.equal((await f.request(moviePath, { method: 'POST', auth: false, body: { ...movieEvent(), videoId: 'tt9999999' } })).status, 400);
  assert.equal((await f.request(moviePath, { method: 'POST', auth: false, raw: 'plain text', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const path = f.addon(p, 'watch_state/push/series/tt7654321.json');
  const bulk: WatchEvent = { id: 'bulk-1', event: 'played', at: 1789542000, scope: 'season', metaId: 'tt7654321', season: 1, videos: [{ videoId: 'tt7654321:1:1', season: 1, episode: 1 }, { videoId: 'tt7654321:1:2', season: 1, episode: 2 }] };
  assert.equal((await f.request(path, { method: 'POST', auth: false, body: { ...bulk, videos: [] } })).status, 400);
  assert.equal((await f.request(path, { method: 'POST', auth: false, body: { ...bulk, videos: [bulk.videos![0], bulk.videos![0]] } })).status, 400);
  assert.equal((await f.request(path, { method: 'POST', auth: false, body: { ...bulk, videos: [{ videoId: 'tt7654321:2:1', season: 2, episode: 1 }] } })).status, 400);
  assert.equal((await f.request(path, { method: 'POST', auth: false, body: { ...bulk, event: 'start' } })).status, 400);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n, 0);
  assert.equal((await f.request(path, { method: 'POST', auth: false, body: bulk })).status, 200);
  await f.settle();
  assert.equal(f.providers.simkl.pushes.length, 1);
  assert.equal(f.providers.simkl.pushes[0].event.videos?.length, 2);
  assert.equal(f.providers.pmdb.pushes.length, 2);
  assert.deepEqual(f.providers.pmdb.pushes.map((p) => p.event.videoId), ['tt7654321:1:1', 'tt7654321:1:2']);
  assert.ok(f.providers.pmdb.pushes.every((p) => p.event.scope === 'episode' && !p.event.videos));
});

test('HTTP consent revocation removes capabilities, rejects new events and prevents pending delivery', async (t) => {
  const f = await fixture(t);
  const p = await f.profile();
  await f.connect(p.id, 'simkl', 's');
  await f.configure(p.id, { pullProvider: 'simkl', pushProviders: ['simkl'] });
  f.providers.simkl.failure = new UpstreamError('Upstream account disconnected', 401);
  const path = f.addon(p, 'watch_state/push/movie/tt1234567.json');
  assert.equal((await f.request(path, { method: 'POST', auth: false, body: movieEvent() })).status, 200);
  await f.settle();
  assert.equal(f.providers.simkl.pushes.length, 1);
  await f.configure(p.id, { pullProvider: 'simkl', pushProviders: ['simkl'], consent: false });
  const manifest = await f.request(f.addon(p, 'manifest.json'), { auth: false });
  assert.equal(manifest.data.watchState.push, undefined);
  assert.equal(manifest.data.watchState.pull, undefined);
  assert.equal((await f.request(path, { method: 'POST', auth: false, body: movieEvent('event-after-revoke') })).status, 403);
  assert.equal((await f.request(f.addon(p, 'watch_state/pull.json'), { auth: false })).status, 403);
  f.providers.simkl.failure = undefined;
  await f.request(`/api/profiles/${p.id}/retry`, { method: 'POST', body: {} });
  await f.settle();
  assert.equal(f.providers.simkl.pushes.length, 1, 'revoked consent must stop pending outbound work');
});

test('HTTP destination removal does not replay blocked jobs to a removed provider', async (t) => {
  const f = await fixture(t);
  const p = await f.profile();
  await f.connect(p.id, 'simkl', 's'); await f.connect(p.id, 'pmdb', 'p');
  await f.configure(p.id, { pushProviders: ['simkl', 'pmdb'] });
  f.providers.simkl.failure = new UpstreamError('Upstream account disconnected', 401);
  await f.request(f.addon(p, 'watch_state/push/movie/tt1234567.json'), { method: 'POST', auth: false, body: movieEvent() });
  await f.settle();
  assert.equal(f.providers.simkl.pushes.length, 1);
  assert.equal(f.providers.pmdb.pushes.length, 1);
  await f.configure(p.id, { pushProviders: ['pmdb'] });
  f.providers.simkl.failure = undefined;
  await f.request(`/api/profiles/${p.id}/retry`, { method: 'POST', body: {} });
  await f.settle();
  assert.equal(f.providers.simkl.pushes.length, 1, 'deselected provider must not receive an old queued event');
});

test('HTTP OAuth state is opaque, profile/session-bound, expiring, single-use and unavailable to bearer-only clients', async (t) => {
  const f = await fixture(t);
  const p = await f.profile('OAuth');
  const bearer = await f.request(`/api/profiles/${p.id}/oauth/simkl`, { method: 'POST', body: {} });
  assert.equal(bearer.status, 400);
  const cookie = await f.login();
  const otherCookie = await f.login();
  const oauth = await f.request(`/api/profiles/${p.id}/oauth/simkl`, { method: 'POST', body: {}, auth: false, cookie });
  assert.equal(oauth.status, 200);
  const target = new URL(oauth.data.url);
  assert.equal(target.origin, 'https://simkl.com');
  assert.equal(target.searchParams.get('client_id'), f.settings.simklClientId);
  assert.equal(target.searchParams.get('redirect_uri'), `${f.settings.baseUrl}/oauth/simkl/callback`);
  const state = target.searchParams.get('state')!;
  assert.ok(state.length >= 32);
  assert.equal(oauth.text.includes(f.settings.simklClientSecret), false);
  const record = f.store.db.prepare('SELECT * FROM oauth').get() as any;
  assert.equal(record.profile, p.id);
  assert.equal(record.state, hash(state));
  assert.notEqual(record.session, cookie.split('=')[1]);
  const callback = `/oauth/simkl/callback?state=${encodeURIComponent(state)}&error=access_denied`;
  assert.equal((await f.request(callback, { auth: false })).status, 401);
  assert.equal((await f.request(callback, { auth: false, cookie: otherCookie })).status, 401);
  assert.equal((await f.request(callback, { auth: false, cookie })).status, 400);
  assert.equal((await f.request(callback, { auth: false, cookie })).status, 401);
  const second = await f.request(`/api/profiles/${p.id}/oauth/simkl`, { method: 'POST', body: {}, auth: false, cookie });
  const expiredState = new URL(second.data.url).searchParams.get('state')!;
  f.store.db.prepare('UPDATE oauth SET expires=0').run();
  assert.equal((await f.request(`/oauth/simkl/callback?state=${expiredState}&error=access_denied`, { auth: false, cookie })).status, 401);
  assert.equal(f.providers.simkl.validations.length, 0);
});

test('HTTP global API key rotation revokes existing session and addon capability', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const p = await f.profile();
  assert.equal((await f.request(f.addon(p, 'manifest.json'), { auth: false })).status, 200);
  f.settings.apiKey = 'new-global-api-key-at-least-thirty-two-characters';
  assert.equal((await f.request('/api/profiles', { auth: false, cookie })).status, 401);
  assert.equal((await f.request(f.addon(p, 'manifest.json'), { auth: false })).status, 401);
  assert.equal((await f.request('/api/profiles')).status, 200);
});
