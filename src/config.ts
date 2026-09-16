export type Settings = ReturnType<typeof loadSettings>;
export function loadSettings(env: NodeJS.ProcessEnv = process.env) {
  const positive=(name:string,fallback:number)=>{const value=Number(env[name]??fallback);if(!Number.isSafeInteger(value)||value<1)throw new Error(`${name} must be a positive integer`);return value;};
  const apiKey=env.GLOBAL_API_KEY ?? '';
  const encryptionKey=env.ENCRYPTION_KEY ?? '';
  if(apiKey.length<32) throw new Error('GLOBAL_API_KEY must contain at least 32 random characters.');
  if(!/^[a-f\d]{64}$/i.test(encryptionKey)) throw new Error('ENCRYPTION_KEY must be a 64-character hexadecimal key.');
  const base=new URL(env.PUBLIC_BASE_URL || 'http://localhost:7000');
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/') throw new Error('PUBLIC_BASE_URL must be an HTTP(S) origin with no path.');
  const port=Number(env.PORT || 7000);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid PORT');
  return {apiKey,encryptionKey,baseUrl:base.origin,port,host:env.HOST || '0.0.0.0',
    dataDir:env.DATA_DIR || './data',simklClientId:env.SIMKL_CLIENT_ID || '',
    simklClientSecret:env.SIMKL_CLIENT_SECRET || '',pmdbApiKey:env.PMDB_API_KEY || '',
    simklAccessToken:env.SIMKL_ACCESS_TOKEN || '',
    refreshSeconds:Math.max(30,Number(env.SYNC_INTERVAL_SECONDS)||300),
    maxPullBytes:positive('MAX_PULL_BYTES',4_900_000),
    maxResumeItems:positive('MAX_RESUME_ITEMS',5000),
    maxWatchedMovies:positive('MAX_WATCHED_MOVIES',50000),
    maxWatchedEpisodes:positive('MAX_WATCHED_EPISODES',50000),
    sessionHours:12,
  };
}
