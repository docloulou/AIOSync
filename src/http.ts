export class UpstreamError extends Error {
  status: number;
  retryAfterMs: number;
  constructor(message: string, status = 502, retryAfterMs = 0) {
    super(message); this.name = 'UpstreamError'; this.status = status; this.retryAfterMs = retryAfterMs;
  }
}

const queues = new Map<string, Promise<void>>();
const active = new Map<string, Promise<void>>();
const next = new Map<string, number>();
async function pace(key: string, interval: number) {
  const before = queues.get(key) ?? Promise.resolve();
  const slot = before.catch(() => {}).then(async () => {
    const wait = Math.max(0, (next.get(key) ?? 0) - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    next.set(key, Date.now() + interval);
  });
  queues.set(key, slot); await slot;
}

export class HttpClient {
  baseUrl: string;
  options: {headers?: Record<string,string>; fetch?: typeof fetch; intervalMs?: number; limiterKey?: string};
  constructor(baseUrl: string, options: HttpClient['options'] = {}) { this.baseUrl=baseUrl; this.options=options; }
  async json(path: string, init: RequestInit = {}): Promise<any> {
    const key=this.options.limiterKey ?? new URL(this.baseUrl).origin;
    const previous=active.get(key)??Promise.resolve();
    const task=previous.catch(()=>{}).then(()=>this.perform(path,init));
    active.set(key,task.then(()=>{},()=>{}));
    return task;
  }
  private async perform(path: string, init: RequestInit): Promise<any> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) throw new UpstreamError('Unexpected API origin', 400);
    await pace(this.options.limiterKey ?? url.origin, this.options.intervalMs ?? 100);
    const headers = new Headers(this.options.headers);
    headers.set('Accept','application/json');
    if(init.body) headers.set('Content-Type','application/json');
    new Headers(init.headers).forEach((v,k)=>headers.set(k,v));
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {...init,headers,redirect:'error',signal:init.signal ?? AbortSignal.timeout(12000)});
    } catch { throw new UpstreamError('API inaccessible ou délai dépassé',502); }
    if(!response.ok) {
      const raw=response.headers.get('retry-after');
      const retry=raw ? (/^\d+$/.test(raw)?Number(raw)*1000:Math.max(0,Date.parse(raw)-Date.now())) : 0;
      // SIMKL documents a transient per-user lock as HTTP 400 + rate_limit.
      // Inspect only this known code; never expose arbitrary upstream bodies.
      if(response.status===400&&url.origin==='https://api.simkl.com'){
        let error:any;try{error=await response.json();}catch{}
        if(error?.error==='rate_limit')throw new UpstreamError('SIMKL occupé, nouvelle tentative différée',429,Math.max(retry||0,2000));
      }
      throw new UpstreamError(`API distante : HTTP ${response.status}`,response.status,retry || 0);
    }
    if(response.status===204) return undefined;
    try {
      const body=await response.text();
      if(body.length>100_000_000) throw new Error('oversized');
      return body ? JSON.parse(body) : undefined;
    } catch { throw new UpstreamError('Réponse JSON distante invalide',502); }
  }
}
