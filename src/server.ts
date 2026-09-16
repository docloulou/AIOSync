import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadSettings } from './config.ts';
import type { Settings } from './config.ts';
import { Store } from './store.ts';
import { TrackerService } from './service.ts';
import { SimklProvider } from './providers/simkl.ts';
import { PmdbProvider } from './providers/pmdb.ts';
import { capability, equal, hash, randomToken } from './security.ts';
import { eventFrom, InputError, profileFields } from './validation.ts';
import { HttpClient, UpstreamError } from './http.ts';
import type { Provider, ProviderName } from './types.ts';

function json(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
async function body(req:IncomingMessage):Promise<any>{
  if(!req.headers['content-type']?.toLowerCase().startsWith('application/json'))throw Object.assign(new InputError('Content-Type application/json is required'),{status:415});
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>1_000_000)throw Object.assign(new InputError('Request body is too large'),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new InputError('Invalid JSON');}
}
function sessionToken(req:IncomingMessage){const v=/(?:^|;\s*)tracker_session=([^;]+)/.exec(req.headers.cookie??'');return v?.[1]??'';}

export function createApp(settings:Settings,options:{store?:Store;providers?:Record<ProviderName,Provider>}={}){
  const store=options.store??new Store(settings.dataDir,settings.encryptionKey);
  const providers=options.providers??{simkl:new SimklProvider({clientId:settings.simklClientId}),pmdb:new PmdbProvider()};
  const service=new TrackerService(store,settings,providers);
  const attempts=new Map<string,{n:number,reset:number}>();
  const sessionHash=(token:string)=>hash(`${settings.apiKey}\0${token}`);
  const cookie=(value:string,age:number)=>`tracker_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${settings.baseUrl.startsWith('https:')?'; Secure':''}`;
  function authenticated(req:IncomingMessage){
    const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
    if(bearer&&equal(bearer,settings.apiKey))return true;
    const token=sessionToken(req);if(!token)return false;
    return !!store.db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires>?').get(sessionHash(token),Date.now());
  }
  async function handle(req:IncomingMessage,res:ServerResponse){
    const url=new URL(req.url??'/',settings.baseUrl);const method=req.method??'GET';
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(url.pathname==='/healthz'&&method==='GET')return json(res,200,{ok:true});
    if(url.pathname==='/manifest.json'&&method==='GET'){
      res.setHeader('Access-Control-Allow-Origin','*');
      return json(res,200,{id:'org.trackerbridge',version:'1.0.1',name:'AIOSync — SIMKL / PMDB',
        description:'Open the configuration page to connect your accounts and create a personal addon URL.',types:['movie','series'],resources:[],catalogs:[],
        behaviorHints:{configurable:true,configurationRequired:true}});
    }
    if(url.pathname.startsWith('/addon/')){
      res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');
      if(method==='OPTIONS'){res.writeHead(204);res.end();return;}
      const match=/^\/addon\/([a-f\d-]+)\/([\w-]+)\/(.+)$/.exec(url.pathname);
      if(!match)throw Object.assign(new InputError('Unknown route'),{status:404});
      const p=store.profile(match[1]);
      if(!p||!equal(match[2],capability(settings.encryptionKey,settings.apiKey,p.id,p.token)))throw new UpstreamError('Invalid or revoked addon URL',401);
      if(match[3]==='manifest.json'&&method==='GET')return json(res,200,service.manifest(p));
      if(match[3]==='configure'&&method==='GET'){res.writeHead(302,{Location:'/'});res.end();return;}
      if(match[3]==='watch_state/pull.json'&&method==='GET')return json(res,200,await service.pull(p,url.searchParams.get('since')));
      const push=/^watch_state\/push\/(movie|series)\/(.+)\.json$/.exec(match[3]);
      if(push&&method==='POST'){
        let id:string;try{id=decodeURIComponent(push[2]);}catch{throw new InputError('Invalid URL identifier');}
        const event=eventFrom(await body(req),push[1] as 'movie'|'series',id);
        service.enqueue(p,push[1] as 'movie'|'series',event);json(res,200,{accepted:true});void service.tick();return;
      }
      throw Object.assign(new InputError('Unknown route'),{status:404});
    }
    // Admin APIs are same-origin; the shared key can alternatively be a Bearer token for scripts.
    if(method!=='GET'&&method!=='HEAD'&&req.headers.origin&&req.headers.origin!==settings.baseUrl)throw new UpstreamError('Origin is not allowed',403);
    if(url.pathname==='/api/login'&&method==='POST'){
      const addr=req.socket.remoteAddress??'unknown';const now=Date.now();
      if(attempts.size>10000)for(const [k,v]of attempts)if(v.reset<now)attempts.delete(k);
      let a=attempts.get(addr);if(!a||a.reset<now){a={n:0,reset:now+600000};attempts.set(addr,a);}if(a.n>=20)throw new UpstreamError('Too many login attempts',429,a.reset-now);
      a.n++;const b=await body(req);
      if(typeof b.apiKey!=='string'||!equal(b.apiKey,settings.apiKey))throw new UpstreamError('Incorrect global API key',401);
      attempts.delete(addr);const token=randomToken();store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(sessionHash(token),now+settings.sessionHours*3600000);
      res.setHeader('Set-Cookie',cookie(token,settings.sessionHours*3600));return json(res,200,{authenticated:true});
    }
    if(url.pathname==='/api/status'&&method==='GET'){
      const auth=authenticated(req);return json(res,200,{authenticated:auth,simklOAuth:auth&&!!(settings.simklClientId&&settings.simklClientSecret),simklEnvToken:auth&&!!settings.simklAccessToken,pmdbEnvToken:auth&&!!settings.pmdbApiKey});
    }
    if(url.pathname==='/api/logout'&&method==='POST'){
      store.db.prepare('DELETE FROM sessions WHERE token=?').run(sessionHash(sessionToken(req)));res.setHeader('Set-Cookie',cookie('',0));return json(res,200,{ok:true});
    }
    if(url.pathname==='/oauth/simkl/callback'&&method==='GET'){
      const state=url.searchParams.get('state')??'';const code=url.searchParams.get('code');
      const record=store.db.prepare('SELECT * FROM oauth WHERE state=? AND session=? AND expires>?').get(hash(state),sessionHash(sessionToken(req)),Date.now()) as any;
      if(!record||!authenticated(req))throw new UpstreamError('OAuth session expired or invalid; sign in again and retry',401);
      store.db.prepare('DELETE FROM oauth WHERE state=?').run(hash(state));
      if(!code||url.searchParams.has('error'))throw new InputError('SIMKL authorization was cancelled');
      const token=await new HttpClient('https://api.simkl.com').json('/oauth/token',{method:'POST',body:JSON.stringify({code,client_id:settings.simklClientId,client_secret:settings.simklClientSecret,redirect_uri:`${settings.baseUrl}/oauth/simkl/callback`,grant_type:'authorization_code'})});
      if(typeof token?.access_token!=='string'||!token.access_token)throw new UpstreamError('SIMKL did not return a valid access token',502);
      if(store.credentials(record.profile,'simkl'))throw new UpstreamError('Disconnect the existing SIMKL account before replacing it',409);
      await providers.simkl.validate({token:token.access_token});store.connect(record.profile,'simkl',{token:token.access_token});
      res.writeHead(303,{Location:'/'});res.end();return;
    }
    if(url.pathname.startsWith('/api/')){
      if(!authenticated(req))throw new UpstreamError('Authentication required',401);
      if(url.pathname==='/api/profiles'&&method==='GET')return json(res,200,{profiles:store.profiles().map(p=>service.describe(p))});
      if(url.pathname==='/api/profiles'&&method==='POST'){
        const p=store.create(profileFields(await body(req)));return json(res,201,service.describe(p));
      }
      const route=/^\/api\/profiles\/([a-f\d-]+)(?:\/(.*))?$/.exec(url.pathname);
      if(route){
        const p=store.profile(route[1]);if(!p)throw Object.assign(new InputError('Profile not found'),{status:404});
        const action=route[2]??'';
        if(!action&&method==='PUT'){
          const fields=profileFields(await body(req));
          for(const provider of [...fields.pushProviders,...(fields.pullProvider?[fields.pullProvider]:[])])if(!store.credentials(p.id,provider))throw new InputError(`Connect ${provider} first`);
          const updated={...p,...fields};store.save(updated);return json(res,200,service.describe(updated));
        }
        if(!action&&method==='DELETE'){store.db.prepare('DELETE FROM profiles WHERE id=?').run(p.id);return json(res,200,{ok:true});}
        if(action==='rotate'&&method==='POST'){p.token=randomToken();store.save(p);return json(res,200,{manifestUrl:service.url(p)});}
        if(action==='refresh'&&method==='POST'){void service.refresh(p).catch(()=>{});return json(res,202,{accepted:true});}
        if(action==='retry'&&method==='POST'){
          store.db.prepare("UPDATE jobs SET status='pending',due=0,attempts=0,error=NULL WHERE profile=? AND status IN ('blocked','failed')").run(p.id);return json(res,200,{ok:true});
        }
        if(action==='jobs'&&method==='GET'){
          const rows=store.db.prepare('SELECT provider,payload,status,error,attempts FROM jobs WHERE profile=? ORDER BY id DESC LIMIT 100').all(p.id) as any[];
          return json(res,200,{jobs:rows.map(({payload,...rest})=>{
            const {event,at,metaId,videoId,positionMs,durationMs,played}=JSON.parse(payload);
            return {...rest,event,at,metaId,videoId,positionMs,durationMs,played};
          })});
        }
        if(action==='oauth/simkl'&&method==='POST'){
          if(!settings.simklClientId||!settings.simklClientSecret)throw new InputError('Configure SIMKL_CLIENT_ID and SIMKL_CLIENT_SECRET');
          if(store.credentials(p.id,'simkl'))throw new InputError('Disconnect the existing SIMKL account before replacing it');
          const session=sessionToken(req);if(!session||!store.db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires>?').get(sessionHash(session),Date.now()))throw new InputError('OAuth requires an active session in this browser');
          const state=randomToken();store.db.prepare('INSERT INTO oauth VALUES(?,?,?,?)').run(hash(state),p.id,sessionHash(session),Date.now()+600000);
          const target=new URL('https://simkl.com/oauth/authorize');target.search=new URLSearchParams({client_id:settings.simklClientId,redirect_uri:`${settings.baseUrl}/oauth/simkl/callback`,response_type:'code',state}).toString();
          return json(res,200,{url:target.href});
        }
        const connect=/^connections\/(simkl|pmdb)$/.exec(action);
        if(connect){
          const provider=connect[1] as ProviderName;
          if(method==='POST'){
            const b=await body(req);const value=b.token||(provider==='pmdb'?settings.pmdbApiKey:settings.simklAccessToken);
            if(typeof value!=='string'||!value.trim()||value.length>10000)throw new InputError('Access token required');
            if(provider==='simkl'&&!settings.simklClientId)throw new InputError('SIMKL_CLIENT_ID is required in .env');
            const c={token:value.trim()};const old=store.credentials(p.id,provider);
            if(old&&!equal(old.token,c.token))throw new InputError('Disconnect the existing account first: its queued events and cached resumes will be deleted before switching accounts');
            try{await providers[provider].validate(c);}catch(e){
              if(e instanceof UpstreamError&&[401,403].includes(e.status))throw new InputError(`The provider rejected the ${provider} credentials`);
              throw e;
            }
            store.connect(p.id,provider,c);return json(res,200,{connected:true});
          }
          if(method==='DELETE'){
            store.transaction(()=>{for(const table of ['connections','jobs','snapshots','overlays'])store.db.prepare(`DELETE FROM ${table} WHERE profile=? AND provider=?`).run(p.id,provider);
              p.pushProviders=p.pushProviders.filter(x=>x!==provider);if(p.pullProvider===provider)p.pullProvider=null;store.save(p);
            });return json(res,200,{ok:true});
          }
        }
      }
      throw Object.assign(new InputError('Unknown route'),{status:404});
    }
    const staticFiles:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/configure':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
    const file=staticFiles[url.pathname];if(file&&method==='GET'){
      res.writeHead(200,{'Content-Type':file[1]});res.end(await readFile(new URL(`../public/${file[0]}`,import.meta.url)));return;
    }
    throw Object.assign(new InputError('Unknown route'),{status:404});
  }
  const server=createServer((req,res)=>{handle(req,res).catch(error=>{
    if(res.headersSent){res.end();return;}
    const status=error instanceof UpstreamError||error instanceof InputError?error.status:500;
    if(error instanceof UpstreamError&&error.retryAfterMs)res.setHeader('Retry-After',String(Math.ceil(error.retryAfterMs/1000)));
    // No request URLs, auth headers, tokens, payloads or upstream bodies in logs.
    if(status===500)process.stderr.write('Internal HTTP processing error\n');
    json(res,status,{error:status===500?'Internal error':error.message});
  });});
  server.requestTimeout=30000;server.headersTimeout=15000;server.maxHeadersCount=50;
  return {server,store,service};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const settings=loadSettings();const app=createApp(settings);
  app.server.listen(settings.port,settings.host,()=>{process.stdout.write(`AIOSync is listening on port ${settings.port}\n`);app.service.start();});
  let stopping=false;
  const stop=async()=>{
    if(stopping)return;stopping=true;
    const closed=new Promise<void>(resolve=>app.server.close(()=>resolve()));
    app.server.closeIdleConnections();
    await Promise.all([closed,app.service.stop()]);app.store.close();
  };
  process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
}
