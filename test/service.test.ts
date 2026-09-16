import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { TrackerService } from '../src/service.ts';
import { loadSettings } from '../src/config.ts';
import { UpstreamError } from '../src/http.ts';
import type { Profile, Provider, Snapshot, WatchEvent } from '../src/types.ts';

function state(): Snapshot {
  return { items: [], watched: { movies: ['tmdb:550'], episodes: [], counts: {}, nextUp: [] } };
}
function setup(t: test.TestContext, overrides: Partial<Provider> = {}) {
  const settings = loadSettings({ GLOBAL_API_KEY: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(64), SYNC_INTERVAL_SECONDS: '3600' });
  const store = new Store(':memory:', settings.encryptionKey);
  t.after(() => store.close());
  const provider: Provider = { name: 'pmdb', validate: async () => {}, push: async () => {}, pull: async () => state(), ...overrides };
  const service = new TrackerService(store, settings, { pmdb: provider, simkl: { ...provider, name: 'simkl' } });
  const p = store.create({ name: 'Test account', pushProviders: ['pmdb'], pullProvider: 'pmdb', consent: true });
  store.connect(p.id, 'pmdb', { token: 'pm-account-one' });
  return { store, service, provider, p };
}
function event(overrides: Partial<WatchEvent> = {}): WatchEvent {
  return { id: 'e|tt1234567:1:1|pause|5000', event: 'pause', at: Math.floor(Date.now() / 1000), metaId: 'tt1234567',
    videoId: 'tt1234567:1:1', season: 1, episode: 1, positionMs: 5000, durationMs: 20000,
    ids: { imdb: 'tt1234567', tmdb: '99', tvdb: '44' }, ...overrides };
}
function jobs(store: Store): any[] { return store.db.prepare('SELECT * FROM jobs ORDER BY id').all(); }
function cached(store: Store, p: Profile, value = state(), error: string | null = null) {
  store.db.prepare('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?,?)').run(p.id, 'pmdb', JSON.stringify(value), Date.now(), error);
}
function disconnect(store: Store, p: Profile) {
  store.transaction(() => {
    for (const table of ['connections', 'jobs', 'snapshots', 'overlays']) store.db.prepare(`DELETE FROM ${table} WHERE profile=? AND provider=?`).run(p.id, 'pmdb');
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('service finishes a successful push and a normal pause does not tombstone its own remote resume', async t => {
  const { store, service, p } = setup(t);
  const e = event();
  store.db.prepare('INSERT INTO overlays VALUES(?,?,?,?,?)').run(p.id, 'pmdb', e.videoId!, JSON.stringify({ type: 'series', metaId: e.metaId, videoId: e.videoId, positionMs: 1000 }), e.at - 1);
  assert.equal(service.enqueue(p, 'series', e), true);
  assert.equal(service.enqueue(p, 'series', e), false);
  await service.deliver(jobs(store)[0]);
  assert.equal(jobs(store)[0].status, 'done');
  assert.equal(store.db.prepare('SELECT * FROM overlays').all().length, 0);
  const remote = state();
  remote.items = [{ type: 'series', metaId: 'tmdb:99', videoId: 'tmdb:99:1:1', positionMs: 5000, at: e.at }];
  assert.equal(service.mapSnapshot(p, remote).items.length, 1);
  service.enqueue(p, 'series', event({ id: 'played-one', event: 'played' }));
  await service.deliver(jobs(store)[1]);
  assert.equal(jobs(store)[1].status, 'done');
  assert.equal(store.db.prepare('SELECT data FROM overlays').all().length, 1);
});

test('service never publishes an unseen watched version during an upstream outage', async t => {
  const { store, service, p } = setup(t);
  cached(store, p, state(), 'offline');
  await assert.rejects(service.pull(p, null), (error: any) => error.status === 503);
  store.db.prepare('UPDATE snapshots SET error=NULL').run();
  const initial = await service.pull(p, null);
  assert.deepEqual(initial.watched?.movies, ['tmdb:550']);
  assert.equal(Object.hasOwn(await service.pull(p, initial.version), 'watched'), false);
  store.db.prepare("UPDATE snapshots SET error='offline'").run();
  assert.equal(Object.hasOwn(await service.pull(p, initial.version), 'watched'), false);
  await assert.rejects(service.pull(p, 'other-version'), (error: any) => error.status === 503);
});

test('start keeps a local resume through an empty provider pull and still delivers native events', async t => {
  for(const name of ['simkl','pmdb'] as const){
    const delivered:string[]=[];
    const {store,service,p}=setup(t,{push:async e=>{delivered.push(e.event);}});
    p.pushProviders=[name];p.pullProvider=name;store.save(p);
    if(name==='simkl')store.connect(p.id,name,{token:'simkl-account'});
    const e=event({id:`${name}-seek`,event:'start',positionMs:12000});
    service.enqueue(p,'series',e);
    await service.deliver(jobs(store)[0]);
    await service.refresh(p);
    const pull=await service.pull(p,null);
    assert.equal(pull.items[0].positionMs,12000);
    assert.equal(pull.items[0].progressPercent,60);
    assert.equal(Object.hasOwn(pull.items[0],'_expiresAt'),false);
    assert.deepEqual(delivered,['start']);
    // An explicit completion still removes the backup and dispatches normally.
    service.enqueue(p,'series',event({id:`${name}-finished`,event:'stop',played:true,at:e.at+1}));
    await service.deliver(jobs(store)[1]);
    assert.equal(service.mapSnapshot(p,state()).items.length,0);
    assert.deepEqual(delivered,['start','stop']);
  }
});

test('zero or incomplete starts preserve the cached point before a provider clears its paused list', async t => {
  for(const fields of [{positionMs:0},{positionMs:undefined},{positionMs:8000,durationMs:0}]){
    const {store,service,p}=setup(t);
    const e=event({id:'transient-start',event:'start',...fields});
    const snapshot=state();
    snapshot.items=[{type:'series',metaId:'tmdb:99',videoId:'tmdb:99:1:1',positionMs:7000,durationMs:20000,at:e.at-5}];
    cached(store,p,snapshot);
    service.enqueue(p,'series',e);
    await service.deliver(jobs(store)[0]);
    await service.refresh(p);
    assert.equal((await service.pull(p,null)).items[0].positionMs,7000);
  }
});

test('invalid fallback events do not delete or replace the last local resume', async t => {
  const {store,service,p}=setup(t,{push:async()=>({localOnly:true})});
  const e=event();
  service.enqueue(p,'series',e);
  await service.deliver(jobs(store)[0]);
  for(const [index,fields] of [
    {positionMs:undefined},{positionMs:8000,durationMs:0},{positionMs:21000,durationMs:20000},
  ].entries()){
    service.enqueue(p,'series',event({id:`invalid-${index}`,at:e.at+index+1,...fields}));
    await service.deliver(jobs(store).at(-1));
    assert.equal(service.mapSnapshot(p,state()).items[0].positionMs,5000);
  }
  service.enqueue(p,'series',event({id:'zero-start',event:'start',positionMs:0,at:e.at+5}));
  await service.deliver(jobs(store).at(-1));
  assert.equal(service.mapSnapshot(p,state()).items[0].positionMs,5000);
});

test('a real rewind is saved, a newer remote resume wins, and unplayed still clears it', async t => {
  const {store,service,p}=setup(t,{push:async()=>({localOnly:true})});
  const e=event({event:'start',positionMs:14000});
  service.enqueue(p,'series',e);await service.deliver(jobs(store)[0]);
  service.enqueue(p,'series',event({id:'rewind',positionMs:3000,at:e.at+1}));
  await service.deliver(jobs(store)[1]);
  assert.equal(service.mapSnapshot(p,state()).items[0].positionMs,3000);
  const remote=state();
  remote.items=[{type:'series',metaId:'tmdb:99',videoId:'tmdb:99:1:1',positionMs:9000,at:e.at+2}];
  assert.equal(service.mapSnapshot(p,remote).items[0].positionMs,9000);
  assert.equal(store.db.prepare('SELECT 1 FROM overlays').all().length,0);
  service.enqueue(p,'series',event({id:'unwatch',event:'unplayed',at:e.at+3}));
  await service.deliver(jobs(store)[2]);
  assert.equal(service.mapSnapshot(p,remote).items.length,0);
});

test('active backups expire and a successful pause returns to the provider resume', async t => {
  const {store,service,p}=setup(t);
  service.enqueue(p,'series',event({event:'start'}));await service.deliver(jobs(store)[0]);
  const row=store.db.prepare('SELECT * FROM overlays').get() as any;
  const data=JSON.parse(row.data);data._expiresAt=Date.now()/1000-1;
  store.db.prepare('UPDATE overlays SET data=?').run(JSON.stringify(data));
  assert.equal(service.mapSnapshot(p,state()).items.length,0);
  service.enqueue(p,'series',event({id:'new-start',event:'start'}));await service.deliver(jobs(store)[1]);
  service.enqueue(p,'series',event({id:'real-pause',positionMs:6000}));await service.deliver(jobs(store)[2]);
  assert.equal(store.db.prepare('SELECT 1 FROM overlays').all().length,0);
  const remote=state();
  remote.items=[{type:'series',metaId:'tmdb:99',videoId:'tmdb:99:1:1',positionMs:6000}];
  assert.equal(service.mapSnapshot(p,remote).items[0].positionMs,6000);
});

test('bulk broadcast aliases preserve exact arbitrary video IDs and counts under every known show ID', t => {
  const { store, service, p } = setup(t);
  service.enqueue(p, 'series', event({ id: 'bulk', event: 'played', scope: 'series', season: null, videoId: undefined,
    videos: [{ videoId: 'custom:opening', season: 0, episode: 1 }, { videoId: 'custom:episode-x', season: 1, episode: 1 }] }));
  const remote = state();
  remote.items = [{ type: 'series', metaId: 'tmdb:99', videoId: 'tmdb:99:0:1', season: 0, episode: 1, positionMs: 100 }];
  remote.watched.episodes = ['tmdb:99:1:1'];
  remote.watched.counts = { 'tmdb:99': { watched: 1, total: 10 } };
  remote.watched.nextUp = [{ type: 'series', metaId: 'tmdb:99', videoId: 'tmdb:99:0:1', season: 0, episode: 1 }];
  const mapped = service.mapSnapshot(p, remote);
  assert.equal(mapped.items[0].metaId, 'tt1234567');
  assert.equal(mapped.items[0].videoId, 'custom:opening');
  assert.deepEqual(mapped.watched.episodes, ['custom:episode-x']);
  assert.equal(mapped.watched.nextUp[0].videoId, 'custom:opening');
  assert.deepEqual(Object.keys(mapped.watched.counts), ['tmdb:99', 'tt1234567', 'tvdb:44']);
  assert.ok(jobs(store).every(job => JSON.parse(job.payload).scope === 'episode' && !JSON.parse(job.payload).videos));
});

test('service does not learn guessed TMDB episode aliases from mixed anime numbering', t => {
  const { store, service, p } = setup(t);
  service.enqueue(p, 'series', event({ videoId: 'kitsu:42:7', season: 1, episode: 7 }));
  assert.equal(store.db.prepare('SELECT * FROM video_aliases').all().length, 0);
  assert.equal(store.db.prepare('SELECT * FROM aliases').all().length, 0);
});

test('connection generations survive ordinary reconnect but change after explicit disconnect', t => {
  const { store, p } = setup(t);
  const before = store.connectionRevision(p.id, 'pmdb');
  store.connect(p.id, 'pmdb', { token: 'pm-account-one' });
  assert.equal(store.connectionRevision(p.id, 'pmdb'), before);
  assert.throws(() => store.connect(p.id, 'pmdb', { token: 'pm-account-two' }), /Disconnect/);
  disconnect(store, p);
  store.connect(p.id, 'pmdb', { token: 'pm-account-one' });
  assert.notEqual(store.connectionRevision(p.id, 'pmdb'), before);
});

test('in-flight refresh cannot commit an old account snapshot after disconnect/reconnect', async t => {
  const old = deferred<Snapshot>();
  const { store, service, provider, p } = setup(t, { pull: async () => old.promise });
  const pending = service.refresh(p);
  disconnect(store, p);
  store.connect(p.id, 'pmdb', { token: 'pm-account-two' });
  provider.pull = async () => ({ ...state(), watched: { ...state().watched, movies: ['tmdb:200'] } });
  await service.refresh(p);
  old.resolve(state());
  await assert.rejects(pending, /Connection replaced/);
  const row: any = store.db.prepare('SELECT data,error FROM snapshots').get();
  assert.deepEqual(JSON.parse(row.data).watched.movies, ['tmdb:200']);
  assert.equal(row.error, null);
});

test('in-flight failed refresh does not recreate a snapshot after disconnect', async t => {
  const old = deferred<Snapshot>();
  const { store, service, p } = setup(t, { pull: async () => old.promise });
  const pending = service.refresh(p);
  disconnect(store, p);
  old.reject(new UpstreamError('old account rejected', 401));
  await assert.rejects(pending, /old account/);
  assert.equal(store.db.prepare('SELECT * FROM snapshots').all().length, 0);
});

test('in-flight delivery stops before its next checkpoint and never writes old account overlays', async t => {
  const first = deferred<boolean>();
  let secondCalls = 0;
  const { store, service, p } = setup(t, { push: async (_e, _type, _credentials, checkpoint) => {
    await checkpoint('first-write', () => first.promise);
    await checkpoint('second-write', async () => { secondCalls++; return true; });
    return { localOnly: true };
  } });
  service.enqueue(p, 'series', event());
  const pending = service.deliver(jobs(store)[0]);
  disconnect(store, p);
  store.connect(p.id, 'pmdb', { token: 'pm-account-two' });
  first.resolve(true);
  await pending;
  assert.equal(secondCalls, 0);
  assert.equal(jobs(store).length, 0);
  assert.equal(store.db.prepare('SELECT * FROM overlays').all().length, 0);
  assert.equal((store.db.prepare('SELECT error FROM connections').get() as any).error, null);
});

test('consent and push routing prevent delivery and consent removes both manifest halves', async t => {
  let calls = 0;
  const { store, service, p } = setup(t, { push: async () => { calls++; } });
  service.enqueue(p, 'series', event());
  p.consent = false;
  store.save(p);
  assert.equal(Object.hasOwn(service.manifest(p).watchState, 'push'), false);
  assert.equal(Object.hasOwn(service.manifest(p).watchState, 'pull'), false);
  assert.throws(() => service.enqueue(p, 'series', event({ id: 'new' })), /consent/);
  await service.deliver(jobs(store)[0]);
  assert.equal(jobs(store)[0].status, 'blocked');
  assert.equal(calls, 0);
  p.consent = true; p.pushProviders = []; store.save(p);
  await service.deliver(jobs(store)[0]);
  assert.equal(calls, 0);
  assert.equal(jobs(store)[0].error, 'Sync disabled');
});

test('consent revoked during a write keeps its checkpoint but stops later remote operations', async t => {
  const first = deferred<boolean>();
  let secondCalls = 0;
  const { store, service, p } = setup(t, { push: async (_e, _type, _credentials, checkpoint) => {
    await checkpoint('first', () => first.promise);
    await checkpoint('second', async () => { secondCalls++; return true; });
  } });
  service.enqueue(p, 'series', event());
  const pending = service.deliver(jobs(store)[0]);
  p.consent = false; store.save(p);
  first.resolve(true);
  await pending;
  assert.equal(jobs(store)[0].status, 'blocked');
  assert.deepEqual(JSON.parse(jobs(store)[0].checkpoints), { first: true });
  assert.equal(secondCalls, 0);
});

test('PMDB bulk jobs skip a video superseded by a newer single mark', async t => {
  const sent: WatchEvent[] = [];
  const { store, service, p } = setup(t, { push: async e => { sent.push(e); } });
  const at = event().at;
  service.enqueue(p, 'series', event({ id: 'b|show|1', event: 'played', scope: 'series', season: null,
    videos: [{ videoId: 'tt1234567:1:1', season: 1, episode: 1 }, { videoId: 'tt1234567:1:2', season: 1, episode: 2 }], at }));
  service.enqueue(p, 'series', event({ id: 'e|new-unplayed', event: 'unplayed', at: at + 1 }));
  for (const job of jobs(store)) await service.deliver(job);
  assert.deepEqual(sent.map(e => [e.event, e.videoId]), [['played', 'tt1234567:1:2'], ['unplayed', 'tt1234567:1:1']]);
  assert.ok(jobs(store).every(job => job.status === 'done'));
});

test('retry preserves connection order while other profiles can progress and checkpoints avoid repeating a write', async t => {
  let firstWrites = 0;
  let secondWrites = 0;
  const sent: string[] = [];
  const { store, service, p } = setup(t, { push: async (e, _type, _credentials, checkpoint) => {
    if (e.id === 'retry-first') {
      await checkpoint('one', async () => { firstWrites++; return true; });
      await checkpoint('two', async () => { secondWrites++; if (secondWrites === 1) throw new UpstreamError('rate limited', 429, 60000); return true; });
    }
    sent.push(e.id);
  } });
  p.pullProvider = null; store.save(p);
  const other = store.create({ name: 'Other', consent: true, pushProviders: ['pmdb'], pullProvider: null });
  store.connect(other.id, 'pmdb', { token: 'pm-other' });
  service.enqueue(p, 'series', event({ id: 'retry-first' }));
  service.enqueue(p, 'series', event({ id: 'later-same-connection', positionMs: 6000 }));
  service.enqueue(other, 'series', event({ id: 'other-connection' }));
  await service.tick();
  assert.equal(jobs(store)[0].status, 'pending');
  assert.ok(jobs(store)[0].due >= Date.now() + 59000);
  await service.tick();
  assert.deepEqual(sent, ['other-connection']);
  store.db.prepare('UPDATE jobs SET due=0 WHERE id=?').run(jobs(store)[0].id);
  await service.tick();
  await service.tick();
  assert.deepEqual(sent, ['other-connection', 'retry-first', 'later-same-connection']);
  assert.equal(firstWrites, 1);
  assert.equal(secondWrites, 2);
});

test('disk-backed queue and completed checkpoints survive a process restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tracker-durable-'));
  const settings = loadSettings({ GLOBAL_API_KEY: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(64) });
  let store = new Store(directory, settings.encryptionKey);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let historyWrites = 0;
  let cleanupWrites = 0;
  const provider: Provider = { name: 'pmdb', validate: async () => {}, pull: async () => state(),
    push: async (_e, _type, _credentials, checkpoint) => {
      await checkpoint('history-written', async () => { historyWrites++; return { remoteId: 'saved-play' }; });
      await checkpoint('resume-deleted', async () => {
        cleanupWrites++;
        if (cleanupWrites === 1) throw new UpstreamError('temporary failure', 502);
        return true;
      });
    },
  };
  let service = new TrackerService(store, settings, { pmdb: provider, simkl: { ...provider, name: 'simkl' } });
  const p = store.create({ name: 'Persistent', consent: true, pushProviders: ['pmdb'], pullProvider: null });
  store.connect(p.id, 'pmdb', { token: 'pm-persistent' });
  const revision = store.connectionRevision(p.id, 'pmdb');
  service.enqueue(p, 'series', event({ id: 'restart-event', event: 'played' }));
  await service.deliver(jobs(store)[0]);
  assert.equal(historyWrites, 1);
  assert.equal(jobs(store)[0].status, 'pending');
  // Simulate termination while a retry was running, before the next checkpoint.
  store.db.prepare("UPDATE jobs SET status='running'").run();
  store.close();
  store = new Store(directory, settings.encryptionKey);
  service = new TrackerService(store, settings, { pmdb: provider, simkl: { ...provider, name: 'simkl' } });
  assert.equal(store.connectionRevision(p.id, 'pmdb'), revision);
  assert.equal(store.credentials(p.id, 'pmdb')?.token, 'pm-persistent');
  assert.equal(jobs(store)[0].status, 'pending');
  assert.deepEqual(JSON.parse(jobs(store)[0].checkpoints), { 'history-written': { remoteId: 'saved-play' } });
  await service.deliver(jobs(store)[0]);
  assert.equal(jobs(store)[0].status, 'done');
  assert.equal(historyWrites, 1, 'The completed remote history write is not replayed after reopening SQLite');
  assert.equal(cleanupWrites, 2);
});

test('background pull runs once after a multi-video PMDB bulk drains, then stays idle while fresh', async t => {
  let pulls = 0;
  let writes = 0;
  const { store, service, p } = setup(t, {
    push: async () => { writes++; },
    pull: async () => { pulls++; return state(); },
  });
  service.enqueue(p, 'series', event({ id: 'batch-refresh', event: 'played', scope: 'series', season: null,
    videos: [1, 2, 3].map(episode => ({ videoId: `tt1234567:1:${episode}`, season: 1, episode })) }));
  await service.tick();
  assert.equal(writes, 1); assert.equal(pulls, 0);
  await service.tick();
  assert.equal(writes, 2); assert.equal(pulls, 0);
  await service.tick();
  await Promise.all(service.refreshing.values());
  assert.equal(writes, 3); assert.equal(pulls, 1);
  assert.ok(jobs(store).every(job => job.status === 'done'));
  await service.tick();
  assert.equal(pulls, 1);
});

test('a future retry or blocked queue head does not prevent periodic refresh forever', async t => {
  for (const status of ['pending', 'blocked']) {
    let pulls = 0;
    let writes = 0;
    const { store, service, p } = setup(t, {
      push: async () => { writes++; }, pull: async () => { pulls++; return state(); },
    });
    service.enqueue(p, 'series', event({ id: `head-${status}` }));
    service.enqueue(p, 'series', event({ id: `waiting-${status}`, positionMs: 6000 }));
    store.db.prepare('UPDATE jobs SET status=?,due=? WHERE id=?').run(status, Date.now() + 3600000, jobs(store)[0].id);
    await service.tick();
    await Promise.all(service.refreshing.values());
    assert.equal(writes, 0);
    assert.equal(pulls, 1);
  }
});

test('a revoked upstream credential returns 401 to AIO until a successful reconnect clears the auth error', async t => {
  const { store, service, p } = setup(t, { push: async () => { throw new UpstreamError('Upstream API: HTTP 401', 401); } });
  service.enqueue(p, 'series', event({ id: 'rejected-by-provider' }));
  await service.deliver(jobs(store)[0]);
  assert.equal(jobs(store)[0].status, 'blocked');
  assert.throws(() => service.enqueue(p, 'series', event({ id: 'next-event' })), (error: any) => error.status === 401);
  assert.equal(jobs(store).length, 1);
  store.connect(p.id, 'pmdb', { token: 'pm-account-one' });
  assert.equal(jobs(store)[0].status, 'pending');
  assert.equal(service.enqueue(p, 'series', event({ id: 'next-event' })), true);
});
