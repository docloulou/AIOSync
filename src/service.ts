import { createHash } from 'node:crypto';
import type { Settings } from './config.ts';
import { Store } from './store.ts';
import { UpstreamError } from './http.ts';
import { capability } from './security.ts';
import type { MediaType, Profile, Provider, ProviderName, Snapshot, WatchEvent, WatchItem } from './types.ts';

class StaleWorkError extends Error {}
const animeNamespace=/^(kitsu|mal|anilist|anidb|simkl):/;

export class TrackerService {
  store:Store; settings:Settings; providers:Record<ProviderName,Provider>;
  busy=false; timer?:ReturnType<typeof setInterval>; refreshing=new Map<string,Promise<void>>();
  constructor(store:Store,settings:Settings,providers:Record<ProviderName,Provider>){this.store=store;this.settings=settings;this.providers=providers;}
  url(p:Profile){return `${this.settings.baseUrl}/addon/${p.id}/${capability(this.settings.encryptionKey,this.settings.apiKey,p.id,p.token)}/manifest.json`;}
  manifest(p:Profile){return {
    id:`org.trackerbridge.${p.id}`,version:'1.1.5',name:`AIOSync · ${p.name}`,
    description:'SIMKL / PublicMetaDB / MDBList watch-state sync for AIOStreams Jellyfin',types:['movie','series'],catalogs:[],
    resources:[{name:'watch_state',types:['movie','series'],idPrefixes:['tt','imdb:','tmdb:','tvdb:','kitsu:','mal:','anilist:','anidb:','simkl:','trakt:','mdblist:']}],
    behaviorHints:{configurable:true,configurationRequired:false},
    watchState:{version:2,...(p.consent&&p.pushProviders.length?{push:{events:['start','pause','stop','played','unplayed'],bulk:true}}:{}),
      ...(p.pullProvider&&p.consent?{pull:{items:true,watched:true,ttlSeconds:this.settings.refreshSeconds}}:{})}
  };}
  describe(p:Profile){
    this.expireJobs(p.id);
    const conns=this.store.db.prepare('SELECT provider,error FROM connections WHERE profile=?').all(p.id) as any[];
    const counts=this.store.db.prepare('SELECT status,COUNT(*) n FROM jobs WHERE profile=? GROUP BY status').all(p.id) as any[];
    const snap=p.pullProvider?this.store.db.prepare('SELECT updated,error FROM snapshots WHERE profile=? AND provider=?').get(p.id,p.pullProvider) as any:undefined;
    const {token,...safe}=p;
    return {...safe,manifestUrl:this.url(p),connections:Object.fromEntries(conns.map(c=>[c.provider,{connected:true,error:c.error}])),
      jobs:{pending:0,blocked:0,failed:0,...Object.fromEntries(counts.map(c=>[c.status,c.n]))},lastSync:snap?.updated,syncError:snap?.error};
  }
  expireJobs(profile:string|null=null){
    const db=this.store.db, now=Date.now();
    const maxAge=now-this.settings.jobMaxAgeSeconds*1000;
    const startAge=now-this.settings.startEventTtlSeconds*1000;
    db.prepare(`UPDATE jobs SET status='cancelled',due=0,error='Expired: maximum queue age reached'
      WHERE status IN ('pending','blocked','failed') AND created<=? AND (? IS NULL OR profile=?)`).run(maxAge,profile,profile);
    // A late-delivered start must not bring an old viewing session back to life.
    db.prepare(`UPDATE jobs SET status='cancelled',due=0,error='Expired: playback start is too old'
      WHERE status IN ('pending','blocked','failed') AND json_extract(payload,'$.event')='start'
      AND (created<=? OR json_extract(payload,'$.at')*1000<=?) AND (? IS NULL OR profile=?)`).run(startAge,startAge,profile,profile);
    db.prepare(`UPDATE jobs AS j SET status='cancelled',due=0,error='Superseded: a newer playback event replaced this start'
      WHERE j.status IN ('pending','blocked','failed') AND json_extract(j.payload,'$.event')='start'
      AND (? IS NULL OR j.profile=?) AND EXISTS (
        SELECT 1 FROM jobs newer WHERE newer.profile=j.profile AND newer.provider=j.provider AND newer.type=j.type
        AND newer.id>j.id AND newer.status!='cancelled'
        AND json_extract(newer.payload,'$.at')>=json_extract(j.payload,'$.at')
        AND (json_extract(newer.payload,'$.videoId')=json_extract(j.payload,'$.videoId') OR EXISTS (
          SELECT 1 FROM json_each(newer.payload,'$.videos') v WHERE json_extract(v.value,'$.videoId')=json_extract(j.payload,'$.videoId')))
      )`).run(profile,profile);
  }
  purgeJobs(p:Profile){
    // Retain receipts/checkpoints for deduplication and a visible audit trail.
    const result=this.store.db.prepare(`UPDATE jobs SET status='cancelled',due=0,error='Purged by administrator'
      WHERE profile=? AND status IN ('pending','blocked','failed','running')`).run(p.id);
    return Number(result.changes);
  }
  enqueue(p:Profile,type:MediaType,e:WatchEvent){
    const db=this.store.db;
    if(!p.consent)throw new UpstreamError('Sync disabled: consent required',403);
    for(const provider of p.pushProviders) {
      const connection=db.prepare('SELECT error FROM connections WHERE profile=? AND provider=?').get(p.id,provider) as {error:string|null}|undefined;
      if(!connection||connection.error||!this.store.credentials(p.id,provider))throw new UpstreamError(`Reconnect ${provider}`,401);
    }
    if(!p.pushProviders.length) throw new UpstreamError('Push disabled for this profile',403);
    return this.store.transaction(()=>{
      if(db.prepare('SELECT 1 FROM receipts WHERE profile=? AND event_id=?').get(p.id,e.id)) return false;
      const n=(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('pending','blocked','running')").get() as any).n;
      const newJobs=p.pushProviders.reduce((sum,provider)=>sum+((provider==='pmdb'||provider==='mdblist')&&e.videos?e.videos.length:1),0);
      if(n+newJobs>50000) throw new UpstreamError('Sync queue is full',429,60000);
      db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(p.id,e.id,Date.now());
      const videos=e.videos??[{videoId:e.videoId!,season:e.season,episode:e.episode}];
      if(e.event==='played'||e.event==='unplayed'||(e.event==='stop'&&e.played)) for(const v of videos)
        db.prepare('INSERT INTO marks VALUES(?,?,?,?) ON CONFLICT(profile,video) DO UPDATE SET at=excluded.at,event_id=excluded.event_id WHERE excluded.at>=marks.at').run(p.id,v.videoId,e.at,e.id);
      // Only broadcast-numbered IDs are safe to alias without an anime episode mapper.
      const broadcast=type==='movie'||(!animeNamespace.test(e.metaId)&&videos.every(v=>
        Number.isInteger(v.season)&&Number(v.season)>=0&&Number.isInteger(v.episode)&&Number(v.episode)>0&&!animeNamespace.test(v.videoId)));
      if(broadcast) {
        const aliases=[e.metaId,...Object.entries(e.ids??{}).filter(([k])=>['imdb','tmdb','tvdb','trakt','mdblist'].includes(k)).map(([k,v])=>k==='imdb'?v:`${k}:${v}`)];
        for(const alias of aliases) db.prepare('INSERT INTO aliases VALUES(?,?,?,?) ON CONFLICT(profile,type,alias) DO UPDATE SET meta=excluded.meta').run(p.id,type,alias,e.metaId);
        for(const v of videos) {
          const native=aliases.map(alias=>type==='movie'?alias:`${alias}:${v.season}:${v.episode}`);
          // An exact video identity is independent of the show's meta identity.
          for(const alias of new Set([...native,v.videoId])) db.prepare('INSERT INTO video_aliases VALUES(?,?,?,?,?) ON CONFLICT(profile,type,alias) DO UPDATE SET meta=excluded.meta,video=excluded.video').run(p.id,type,alias,e.metaId,v.videoId);
        }
      }
      for(const provider of p.pushProviders){
        const events=(provider==='pmdb'||provider==='mdblist')&&e.videos?e.videos.map(v=>({...e,...v,scope:'episode' as const,videos:undefined,id:`${e.id}|${v.videoId}`})):[e];
        for(const event of events) db.prepare('INSERT INTO jobs(profile,provider,event_id,type,payload,created) VALUES(?,?,?,?,?,?)').run(p.id,provider,event.id,type,JSON.stringify(event),Date.now());
      }
      return true;
    });
  }
  start(){this.timer=setInterval(()=>{void this.tick();},500);this.timer.unref();void this.tick();}
  async stop(){if(this.timer)clearInterval(this.timer);while(this.busy)await new Promise(r=>setTimeout(r,20));await Promise.allSettled(this.refreshing.values());}
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      const db=this.store.db;
      this.expireJobs();
      // A blocked/retrying job preserves event order for its own connection only.
      const job=db.prepare(`SELECT j.* FROM jobs j WHERE j.status='pending' AND j.due<=? AND NOT EXISTS
        (SELECT 1 FROM jobs older WHERE older.profile=j.profile AND older.provider=j.provider AND older.id<j.id AND older.status IN ('pending','running','blocked')) ORDER BY j.id LIMIT 1`).get(Date.now()) as any;
      if(job) await this.deliver(job);
      for(const p of this.store.profiles()) if(p.pullProvider&&p.consent&&this.store.credentials(p.id,p.pullProvider)){
        // A full remote history read after every per-video write would turn a bulk
        // mark into hundreds of complete library imports. Refresh once runnable
        // writes drain; a future retry or blocked head must not starve refreshes.
        const draining=db.prepare(`SELECT 1 FROM jobs j WHERE j.profile=? AND j.provider=? AND
          (j.status='running' OR (j.status='pending' AND j.due<=? AND NOT EXISTS
            (SELECT 1 FROM jobs older WHERE older.profile=j.profile AND older.provider=j.provider AND older.id<j.id
              AND older.status IN ('pending','running','blocked')))) LIMIT 1`).get(p.id,p.pullProvider,Date.now());
        if(draining)continue;
        const snap=db.prepare('SELECT updated FROM snapshots WHERE profile=? AND provider=?').get(p.id,p.pullProvider) as any;
        if(!snap||Date.now()-snap.updated>=this.settings.refreshSeconds*1000) void this.refresh(p).catch(()=>{});
      }
      db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
      db.prepare('DELETE FROM oauth WHERE expires<?').run(Date.now());
      db.prepare('DELETE FROM receipts WHERE created<?').run(Date.now()-30*86400000);
      db.prepare("DELETE FROM jobs WHERE status IN ('done','cancelled') AND created<?").run(Date.now()-30*86400000);
    }finally{this.busy=false;}
  }
  async deliver(job:any){
    const db=this.store.db;
    this.expireJobs(job.profile);
    job=db.prepare("SELECT * FROM jobs WHERE id=? AND status='pending'").get(job.id);
    if(!job)return;
    let e:WatchEvent=JSON.parse(job.payload);const p=this.store.profile(job.profile);if(!p)return;
    if(!p.consent||!p.pushProviders.includes(job.provider)){
      db.prepare("UPDATE jobs SET status='blocked',error='Sync disabled' WHERE id=?").run(job.id);return;
    }
    const revision=this.store.connectionRevision(p.id,job.provider);
    const isCurrent=()=>this.store.connectionRevision(p.id,job.provider)===revision&&!!db.prepare("SELECT 1 FROM jobs WHERE id=? AND status='running'").get(job.id);
    const assertCurrent=()=>{
      if(!isCurrent())throw new StaleWorkError('Connection replaced during sync');
      const current=this.store.profile(p.id);
      if(!current?.consent||!current.pushProviders.includes(job.provider))throw new UpstreamError('Sync disabled',403);
    };
    // A newer single watched/unwatched mark supersedes an older queued bulk entry.
    if(e.videos){e={...e,videos:e.videos.filter(v=>{const m=db.prepare('SELECT at,event_id FROM marks WHERE profile=? AND video=?').get(p.id,v.videoId) as any;return !m||m.event_id===e.id||m.at<e.at;})};if(!e.videos.length){db.prepare("UPDATE jobs SET status='done',error='Superseded by a newer operation' WHERE id=?").run(job.id);return;}}
    if((job.provider==='pmdb'||job.provider==='mdblist')&&e.id.includes('|')&&e.scope==='episode'){
      const original=e.id.slice(0,-(e.videoId!.length+1));
      const m=db.prepare('SELECT at,event_id FROM marks WHERE profile=? AND video=?').get(p.id,e.videoId!) as any;
      if(m&&m.at>=e.at&&m.event_id!==e.id&&m.event_id!==original){db.prepare("UPDATE jobs SET status='done',error='Superseded by a newer operation' WHERE id=?").run(job.id);return;}
    }
    db.prepare("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=?").run(job.id);
    try{
      const credentials=this.store.credentials(p.id,job.provider);if(!credentials)throw new UpstreamError('Account disconnected',401);
      const checkpoints=JSON.parse(job.checkpoints);
      const beforeStart=e.event==='start'?db.prepare('SELECT data FROM snapshots WHERE profile=? AND provider=?').get(p.id,job.provider) as {data:string|null}|undefined:undefined;
      const result=await this.providers[job.provider as ProviderName].push(e,job.type,credentials,async(key,operation)=>{
        assertCurrent();
        if(Object.hasOwn(checkpoints,key))return checkpoints[key];
        const value=await operation();
        if(!isCurrent())throw new StaleWorkError('Connection replaced during sync');
        checkpoints[key]=value??null;
        db.prepare('UPDATE jobs SET checkpoints=? WHERE id=?').run(JSON.stringify(checkpoints),job.id);
        assertCurrent();return value;
      });
      assertCurrent();
      const videos=e.videos??[{videoId:e.videoId!,season:e.season,episode:e.episode}];
      for(const v of videos){
        const clearsResume=e.event==='played'||e.event==='unplayed'||(e.event==='stop'&&e.played===true);
        let item:(WatchItem&{_expiresAt?:number})|null=null;
        if(!clearsResume&&(e.event==='start'||result?.localOnly)){
          const validPosition=Number.isFinite(e.positionMs)&&e.positionMs!>=0&&
            (e.durationMs===undefined||(Number.isFinite(e.durationMs)&&e.durationMs>0&&e.positionMs!<=e.durationMs));
          // A start at zero can be a transient player reset during a seek. Keep
          // the last known resume until a pause/stop supplies an explicit position.
          if(validPosition&&(e.event!=='start'||e.positionMs!>0)){
            item={type:job.type,metaId:e.metaId,videoId:v.videoId,season:v.season,episode:v.episode,positionMs:e.positionMs,at:e.at,played:false,
              ...(e.durationMs!==undefined?{durationMs:e.durationMs,progressPercent:e.positionMs!/e.durationMs*100}:{})};
          }else if(e.event==='start'){
            // Native SIMKL start removes its paused playback. Back up a cached
            // point before the next pull replaces that snapshot with an empty list.
            const existing=db.prepare('SELECT 1 FROM overlays WHERE profile=? AND provider=? AND video=?').get(p.id,job.provider,v.videoId);
            if(existing)continue;
            if(beforeStart?.data){
              item=this.mapSnapshot({...p,pullProvider:job.provider},JSON.parse(beforeStart.data)).items.find(i=>i.videoId===v.videoId)??null;
            }
          }
          // Missing/invalid data must never become a deletion marker.
          if(!item)continue;
          // Active-session backups expire if a client disappears without a stop.
          // Unsupported paused positions remain until replaced, as before.
          if(e.event==='start')item={...item,_expiresAt:Date.now()/1000+86400};
        }
        if(!clearsResume&&e.event!=='start'&&!result?.localOnly) {
          db.prepare('DELETE FROM overlays WHERE profile=? AND provider=? AND video=? AND at<=?').run(p.id,job.provider,v.videoId,e.at);
        } else {
          db.prepare('INSERT INTO overlays VALUES(?,?,?,?,?) ON CONFLICT(profile,provider,video) DO UPDATE SET data=excluded.data,at=excluded.at WHERE excluded.at>=overlays.at').run(p.id,job.provider,v.videoId,JSON.stringify(item),e.at);
        }
      }
      db.prepare("UPDATE jobs SET status='done',error=? WHERE id=?").run(result?.warning??null,job.id);
      db.prepare('UPDATE connections SET error=NULL WHERE profile=? AND provider=?').run(p.id,job.provider);
      // Refresh on next pull rather than fan out a full library for every bulk video.
      db.prepare('UPDATE snapshots SET updated=0 WHERE profile=? AND provider=?').run(p.id,job.provider);
    }catch(error){
      // Disconnection deletes this job. Never resurrect it or attach its result/error
      // to credentials connected while an upstream operation was in flight.
      if(error instanceof StaleWorkError||!isCurrent())return;
      const err=error instanceof UpstreamError?error:new UpstreamError(error instanceof Error?error.message:'Provider error',502);
      const attempts=job.attempts+1;const auth=[401,403].includes(err.status);
      const retry=err.status===429||err.status>=500;
      const status=auth?'blocked':retry&&attempts<15?'pending':'failed';
      const wait=Math.max(err.retryAfterMs,Math.min(6*3600000,30000*2**Math.min(attempts-1,10)));
      db.prepare('UPDATE jobs SET status=?,due=?,error=? WHERE id=?').run(status,Date.now()+wait,err.message,job.id);
      if(auth&&err.message!=='Sync disabled')db.prepare('UPDATE connections SET error=? WHERE profile=? AND provider=?').run(err.message,p.id,job.provider);
    }
  }
  refresh(p:Profile):Promise<void>{
    if(!p.pullProvider||!p.consent)return Promise.reject(new UpstreamError('Pull disabled',403));
    const provider=p.pullProvider;const revision=this.store.connectionRevision(p.id,provider);
    if(!revision)return Promise.reject(new UpstreamError('Account not connected',401));
    const key=`${p.id}:${provider}:${revision}`;
    const isCurrent=()=>{
      const current=this.store.profile(p.id);
      return this.store.connectionRevision(p.id,provider)===revision&&current?.pullProvider===provider&&current.consent;
    };
    if(this.refreshing.has(key))return this.refreshing.get(key)!;
    const task=(async()=>{
      try{
        if(!isCurrent())throw new StaleWorkError('Configuration changed during pull');
        const c=this.store.credentials(p.id,provider);if(!c)throw new UpstreamError('Account not connected',401);
        const data=await this.providers[provider].pull(c);
        // Commit only a complete successful snapshot. Never replace history with a partial read.
        if(!Array.isArray(data.items)||!Array.isArray(data.watched?.movies)||!Array.isArray(data.watched?.episodes))throw new UpstreamError('Incomplete snapshot',502);
        if(!isCurrent())throw new StaleWorkError('Connection replaced during pull');
        this.store.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,NULL) ON CONFLICT(profile,provider) DO UPDATE SET data=excluded.data,updated=excluded.updated,error=NULL').run(p.id,provider,JSON.stringify(data),Date.now());
      }catch(e){
        if(isCurrent())this.store.db.prepare('INSERT INTO snapshots VALUES(?,?,NULL,?,?) ON CONFLICT(profile,provider) DO UPDATE SET updated=excluded.updated,error=excluded.error').run(p.id,provider,Date.now(),e instanceof Error?e.message:'Sync failed');
        throw e;
      }
    })().finally(()=>this.refreshing.delete(key));this.refreshing.set(key,task);return task;
  }
  mapSnapshot(p:Profile,s:Snapshot):Snapshot{
    const aliasRows=this.store.db.prepare('SELECT type,alias,meta FROM aliases WHERE profile=?').all(p.id) as any[];
    const aliases=new Map<string,string>(aliasRows.map(r=>[`${r.type}|${r.alias}`,r.meta]));
    const videoAliases=new Map<string,{meta:string;video:string}>((this.store.db.prepare('SELECT type,alias,meta,video FROM video_aliases WHERE profile=?').all(p.id) as any[]).map(r=>[`${r.type}|${r.alias}`,{meta:r.meta,video:r.video}]));
    const base=(id:string,type:MediaType)=>aliases.get(`${type}|${id}`)??id;
    const video=(id:string,type:MediaType='series')=>{
      const exact=videoAliases.get(`${type}|${id}`);if(exact)return exact.video;
      if(type==='movie')return base(id,type);
      const m=/^(.+):(\d+):(\d+)$/.exec(id);return m?`${base(m[1],'series')}:${Number(m[2])}:${Number(m[3])}`:id;
    };
    const mapItem=(i:WatchItem):WatchItem=>{
      const exact=videoAliases.get(`${i.type}|${i.videoId}`);
      return {...i,metaId:exact?.meta??base(i.metaId,i.type),videoId:exact?.video??video(i.videoId,i.type)};
    };
    const items=s.items.map(mapItem);
    for(const o of this.store.db.prepare('SELECT video,data,at FROM overlays WHERE profile=? AND provider=?').all(p.id,p.pullProvider!) as any[]){
      const stored=JSON.parse(o.data) as (WatchItem&{_expiresAt?:number})|null;
      if(stored?._expiresAt!==undefined&&stored._expiresAt<Date.now()/1000){this.store.db.prepare('DELETE FROM overlays WHERE profile=? AND provider=? AND video=?').run(p.id,p.pullProvider!,o.video);continue;}
      // Internal expiry metadata is never part of the watch_state response.
      const parsed=stored?(({_expiresAt,...item})=>item)(stored):null;
      const local=parsed?mapItem(parsed):null;
      const overlayVideo=local?.videoId??videoAliases.get(`series|${o.video}`)?.video??videoAliases.get(`movie|${o.video}`)?.video??o.video;
      const idx=items.findIndex(i=>i.videoId===overlayVideo);const remote=idx>=0?items[idx]:null;
      if(remote&&remote.at&&remote.at>o.at){this.store.db.prepare('DELETE FROM overlays WHERE profile=? AND provider=? AND video=?').run(p.id,p.pullProvider!,o.video);continue;}
      // Tombstones are short-lived; real local-only resume points remain until replaced.
      if(!local&&Date.now()/1000-o.at>86400){this.store.db.prepare('DELETE FROM overlays WHERE profile=? AND provider=? AND video=?').run(p.id,p.pullProvider!,o.video);continue;}
      if(idx>=0)items.splice(idx,1);if(local)items.push(local);
    }
    const counts:Snapshot['watched']['counts']={...s.watched.counts};
    for(const [id,value] of Object.entries(s.watched.counts)){
      const mapped=base(id,'series');counts[mapped]=value;
      for(const alias of aliasRows)if(alias.type==='series'&&alias.meta===mapped)counts[alias.alias]=value;
    }
    return {items:items.sort((a,b)=>(b.at??0)-(a.at??0)).slice(0,this.settings.maxResumeItems??5000),watched:{
      movies:[...new Set(s.watched.movies.map(i=>base(i,'movie')))].sort(),episodes:[...new Set(s.watched.episodes.map(i=>video(i)))].sort(),
      counts:Object.fromEntries(Object.entries(counts).sort(([a],[b])=>a.localeCompare(b))),nextUp:s.watched.nextUp.map(mapItem)
    }};
  }
  async pull(p:Profile,since:string|null){
    if(!p.pullProvider||!p.consent)throw new UpstreamError('Pull disabled',403);
    const revision=this.store.connectionRevision(p.id,p.pullProvider);
    if(!revision)throw new UpstreamError('Account not connected',401);
    let row=this.store.db.prepare('SELECT * FROM snapshots WHERE profile=? AND provider=?').get(p.id,p.pullProvider) as any;
    if(!row||Date.now()-row.updated>this.settings.refreshSeconds*1000){
      let timeout:ReturnType<typeof setTimeout>|undefined;
      await Promise.race([this.refresh(p).catch(()=>{}),new Promise<void>(r=>{timeout=setTimeout(r,10000);})]);if(timeout)clearTimeout(timeout);
      row=this.store.db.prepare('SELECT * FROM snapshots WHERE profile=? AND provider=?').get(p.id,p.pullProvider) as any;
    }
    const current=this.store.profile(p.id);
    if(this.store.connectionRevision(p.id,p.pullProvider)!==revision||!current?.consent||current.pullProvider!==p.pullProvider)throw new UpstreamError('Configuration changed during pull',503);
    if(!row?.data)throw new UpstreamError(row?.error??'Initial sync in progress; try again shortly',503,30000);
    const s=this.mapSnapshot(p,JSON.parse(row.data));
    const version=createHash('sha256').update(JSON.stringify([p.pullProvider,s.watched])).digest('hex').slice(0,32);
    // A client must never learn a new watched version without its corresponding set.
    if(row.error&&since!==version)throw new UpstreamError('Tracker unavailable; previous history preserved',503,30000);
    const body={version,items:s.items,...(!row.error&&since!==version?{watched:s.watched}:{})};
    if(Buffer.byteLength(JSON.stringify(body))>(this.settings.maxPullBytes??4_900_000)
      ||s.watched.movies.length>(this.settings.maxWatchedMovies??50000)
      ||s.watched.episodes.length>(this.settings.maxWatchedEpisodes??50000))throw new UpstreamError('History exceeds configured limits; increase the limits in both services before importing',503);
    return body;
  }
}
