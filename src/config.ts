export type Settings = ReturnType<typeof loadSettings>;
export function loadSettings(env: NodeJS.ProcessEnv = process.env) {
  const positive=(name:string,fallback:number)=>{const value=Number(env[name]??fallback);if(!Number.isSafeInteger(value)||value<1)throw new Error(`${name} doit être un entier positif`);return value;};
  const apiKey=env.GLOBAL_API_KEY ?? '';
  const encryptionKey=env.ENCRYPTION_KEY ?? '';
  if(apiKey.length<32) throw new Error('GLOBAL_API_KEY doit contenir au moins 32 caractères aléatoires.');
  if(!/^[a-f\d]{64}$/i.test(encryptionKey)) throw new Error('ENCRYPTION_KEY doit être une clé hexadécimale de 64 caractères.');
  const base=new URL(env.PUBLIC_BASE_URL || 'http://localhost:7000');
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/') throw new Error('PUBLIC_BASE_URL doit être une origine HTTP(S), sans chemin.');
  const port=Number(env.PORT || 7000);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('PORT invalide');
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
