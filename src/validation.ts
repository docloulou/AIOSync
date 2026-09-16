import type { MediaType, ProviderName, WatchEvent } from './types.ts';
export class InputError extends Error { status=400; }
const validId=(x:unknown)=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\u0000-\u0020/\\?#]/.test(x);
const ordinal=(x:unknown)=>Number.isInteger(x)&&Number(x)>=0&&Number(x)<=1_000_000;
export function eventFrom(body:any,type:MediaType,pathId:string):WatchEvent {
  if(!body || typeof body!=='object'||Array.isArray(body)) throw new InputError('Invalid JSON event');
  if(typeof body.id!=='string'||body.id.length<1||body.id.length>1024) throw new InputError('Invalid id');
  if(!['start','pause','stop','played','unplayed'].includes(body.event)) throw new InputError('Unknown event');
  if(!validId(body.metaId)||!Number.isFinite(body.at)||body.at<0||body.at>8640000000000) throw new InputError('Invalid metaId or at');
  if(body.scope!==undefined&&!['movie','episode','season','series'].includes(body.scope)) throw new InputError('Invalid scope');
  if(body.played!==undefined&&typeof body.played!=='boolean') throw new InputError('Invalid played value');
  for(const field of ['positionMs','durationMs']) if(body[field]!==undefined&&(!Number.isFinite(body[field])||body[field]<0)) throw new InputError(`Invalid ${field}`);
  if(body.ids!==undefined&&(!body.ids||Array.isArray(body.ids)||typeof body.ids!=='object'||Object.entries(body.ids).some(([k,v])=>!/^\w+$/.test(k)||!validId(v)))) throw new InputError('Invalid ids');
  const bulk=body.scope==='series'||body.scope==='season';
  if(bulk) {
    if(type!=='series'||!['played','unplayed'].includes(body.event)||body.metaId!==pathId) throw new InputError('Invalid bulk operation');
    if(!Array.isArray(body.videos)||!body.videos.length||body.videos.length>500) throw new InputError('videos must contain 1 to 500 items');
    if(body.scope==='season'&&!ordinal(body.season)) throw new InputError('Invalid season');
    for(const v of body.videos) if(!v||!validId(v.videoId)||!ordinal(v.episode)||(v.season!==null&&!ordinal(v.season))||(body.scope==='season'&&v.season!==body.season)) throw new InputError('Invalid bulk video');
    if(new Set(body.videos.map((v:any)=>v.videoId)).size!==body.videos.length) throw new InputError('Duplicate videos');
  } else {
    if(!validId(body.videoId)||body.videoId!==pathId) throw new InputError('videoId does not match the route');
    if(type==='series'&&(!ordinal(body.episode)||(body.season!==undefined&&body.season!==null&&!ordinal(body.season)))) throw new InputError('Invalid episode coordinates');
    if((type==='movie'&&body.scope==='episode')||(type==='series'&&body.scope==='movie')) throw new InputError('Type and scope do not match');
  }
  return {id:body.id,event:body.event,at:body.at,scope:body.scope,metaId:body.metaId,videoId:body.videoId,
    season:body.season,episode:body.episode,positionMs:body.positionMs,durationMs:body.durationMs,
    played:body.played,ids:body.ids,videos:body.videos,part:body.part,parts:body.parts};
}
export function profileFields(b:any) {
  if(!b||typeof b.name!=='string'||!b.name.trim()||b.name.length>100) throw new InputError('Name is required (100 characters maximum)');
  if(![null,'simkl','pmdb','mdblist'].includes(b.pullProvider)) throw new InputError('Invalid pull source');
  if(!Array.isArray(b.pushProviders)||b.pushProviders.some((x:any)=>!['simkl','pmdb','mdblist'].includes(x))) throw new InputError('Invalid push destinations');
  if(typeof b.consent!=='boolean') throw new InputError('Consent is required');
  return {name:b.name.trim(),pullProvider:b.pullProvider,pushProviders:[...new Set(b.pushProviders)] as ProviderName[],consent:b.consent};
}
