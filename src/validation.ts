import type { MediaType, WatchEvent } from './types.ts';
export class InputError extends Error { status=400; }
const validId=(x:unknown)=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\u0000-\u0020/\\?#]/.test(x);
const ordinal=(x:unknown)=>Number.isInteger(x)&&Number(x)>=0&&Number(x)<=1_000_000;
export function eventFrom(body:any,type:MediaType,pathId:string):WatchEvent {
  if(!body || typeof body!=='object'||Array.isArray(body)) throw new InputError('Événement JSON invalide');
  if(typeof body.id!=='string'||body.id.length<1||body.id.length>1024) throw new InputError('id invalide');
  if(!['start','pause','stop','played','unplayed'].includes(body.event)) throw new InputError('Événement inconnu');
  if(!validId(body.metaId)||!Number.isFinite(body.at)||body.at<0||body.at>8640000000000) throw new InputError('metaId ou at invalide');
  if(body.scope!==undefined&&!['movie','episode','season','series'].includes(body.scope)) throw new InputError('scope invalide');
  if(body.played!==undefined&&typeof body.played!=='boolean') throw new InputError('played invalide');
  for(const field of ['positionMs','durationMs']) if(body[field]!==undefined&&(!Number.isFinite(body[field])||body[field]<0)) throw new InputError(`${field} invalide`);
  if(body.ids!==undefined&&(!body.ids||Array.isArray(body.ids)||typeof body.ids!=='object'||Object.entries(body.ids).some(([k,v])=>!/^\w+$/.test(k)||!validId(v)))) throw new InputError('ids invalides');
  const bulk=body.scope==='series'||body.scope==='season';
  if(bulk) {
    if(type!=='series'||!['played','unplayed'].includes(body.event)||body.metaId!==pathId) throw new InputError('Opération groupée invalide');
    if(!Array.isArray(body.videos)||!body.videos.length||body.videos.length>500) throw new InputError('videos : 1 à 500 éléments requis');
    if(body.scope==='season'&&!ordinal(body.season)) throw new InputError('Saison invalide');
    for(const v of body.videos) if(!v||!validId(v.videoId)||!ordinal(v.episode)||(v.season!==null&&!ordinal(v.season))||(body.scope==='season'&&v.season!==body.season)) throw new InputError('Vidéo groupée invalide');
    if(new Set(body.videos.map((v:any)=>v.videoId)).size!==body.videos.length) throw new InputError('Vidéos dupliquées');
  } else {
    if(!validId(body.videoId)||body.videoId!==pathId) throw new InputError('videoId incompatible avec la route');
    if(type==='series'&&(!ordinal(body.episode)||(body.season!==undefined&&body.season!==null&&!ordinal(body.season)))) throw new InputError('Coordonnées épisode invalides');
    if((type==='movie'&&body.scope==='episode')||(type==='series'&&body.scope==='movie')) throw new InputError('Type et scope incompatibles');
  }
  return {id:body.id,event:body.event,at:body.at,scope:body.scope,metaId:body.metaId,videoId:body.videoId,
    season:body.season,episode:body.episode,positionMs:body.positionMs,durationMs:body.durationMs,
    played:body.played,ids:body.ids,videos:body.videos,part:body.part,parts:body.parts};
}
export function profileFields(b:any) {
  if(!b||typeof b.name!=='string'||!b.name.trim()||b.name.length>100) throw new InputError('Nom requis (100 caractères maximum)');
  if(![null,'simkl','pmdb'].includes(b.pullProvider)) throw new InputError('Source pull invalide');
  if(!Array.isArray(b.pushProviders)||b.pushProviders.some((x:any)=>!['simkl','pmdb'].includes(x))) throw new InputError('Destinations push invalides');
  if(typeof b.consent!=='boolean') throw new InputError('Consentement requis');
  return {name:b.name.trim(),pullProvider:b.pullProvider,pushProviders:[...new Set(b.pushProviders)] as ('simkl'|'pmdb')[],consent:b.consent};
}
