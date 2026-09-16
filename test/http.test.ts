import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, UpstreamError } from '../src/http.ts';

test('API errors respect Retry-After and never expose upstream secrets',async()=>{
  const h=new HttpClient('https://publicmetadb.com',{intervalMs:0,fetch:(async()=>new Response('secret-token-do-not-echo',{status:429,headers:{'Retry-After':'17'}})) as typeof fetch});
  await assert.rejects(h.json('/api/external/watched'),(e:unknown)=>e instanceof UpstreamError&&e.status===429&&e.retryAfterMs===17000&&!e.message.includes('secret'));
  const simkl=new HttpClient('https://api.simkl.com',{intervalMs:0,fetch:(async()=>Response.json({error:'rate_limit',token:'private'},{status:400})) as typeof fetch});
  await assert.rejects(simkl.json('/sync/activities'),(e:unknown)=>e instanceof UpstreamError&&e.status===429&&e.retryAfterMs>=2000&&!e.message.includes('private'));
});

test('requests using the same provider budget never overlap',async()=>{
  let running=0,max=0;
  const mock=(async()=>{running++;max=Math.max(running,max);await new Promise(r=>setTimeout(r,10));running--;return Response.json({ok:true});}) as typeof fetch;
  const a=new HttpClient('https://publicmetadb.com',{intervalMs:0,limiterKey:'test-serial',fetch:mock});
  const b=new HttpClient('https://publicmetadb.com',{intervalMs:0,limiterKey:'test-serial',fetch:mock});
  await Promise.all([a.json('/a'),b.json('/b'),a.json('/c')]);assert.equal(max,1);
});

test('HTTP client refuses another origin before transmitting credentials',async()=>{
  let called=false;const h=new HttpClient('https://api.simkl.com',{headers:{Authorization:'Bearer private'},fetch:(async()=>{called=true;return Response.json({});})as typeof fetch});
  await assert.rejects(h.json('https://example.com/steal'),(e:unknown)=>e instanceof UpstreamError&&e.status===400);assert.equal(called,false);
});
