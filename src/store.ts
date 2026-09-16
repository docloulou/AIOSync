import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, randomToken, seal, unseal } from './security.ts';
import type { Credentials, Profile, ProviderName } from './types.ts';

export class Store {
  db: DatabaseSync;
  key: string;
  constructor(dir: string,key: string) {
    this.key=key;
    if(dir!==':memory:') mkdirSync(dir,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(dir===':memory:'?dir:join(dir,'tracker.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections(profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,provider TEXT,secret TEXT NOT NULL,error TEXT,PRIMARY KEY(profile,provider));
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER);
      CREATE TABLE IF NOT EXISTS oauth(state TEXT PRIMARY KEY,profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,session TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS receipts(profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,event_id TEXT,created INTEGER,PRIMARY KEY(profile,event_id));
      CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,provider TEXT,event_id TEXT,type TEXT,payload TEXT,status TEXT DEFAULT 'pending',attempts INTEGER DEFAULT 0,due INTEGER DEFAULT 0,error TEXT,checkpoints TEXT DEFAULT '{}',created INTEGER,UNIQUE(profile,provider,event_id));
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,due,id);
      CREATE TABLE IF NOT EXISTS snapshots(profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,provider TEXT,data TEXT,updated INTEGER,error TEXT,PRIMARY KEY(profile,provider));
      CREATE TABLE IF NOT EXISTS overlays(profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,provider TEXT,video TEXT,data TEXT,at REAL,PRIMARY KEY(profile,provider,video));
      CREATE TABLE IF NOT EXISTS marks(profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,video TEXT,at REAL,event_id TEXT,PRIMARY KEY(profile,video));
      CREATE TABLE IF NOT EXISTS aliases(profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,type TEXT,alias TEXT,meta TEXT,PRIMARY KEY(profile,type,alias));
      CREATE TABLE IF NOT EXISTS video_aliases(profile TEXT REFERENCES profiles(id) ON DELETE CASCADE,type TEXT,alias TEXT,meta TEXT,video TEXT,PRIMARY KEY(profile,type,alias));
    `);
    this.db.prepare("UPDATE jobs SET status='pending' WHERE status='running'").run();
    // Detect a changed encryption key at startup rather than silently losing every connection.
    const first=this.db.prepare('SELECT secret FROM connections LIMIT 1').get() as any;
    if(first) unseal(first.secret,key);
  }
  transaction<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try {const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;} }
  profiles():Profile[] { return (this.db.prepare('SELECT data FROM profiles ORDER BY rowid').all() as any[]).map(x=>JSON.parse(x.data)); }
  profile(id:string):Profile|undefined { const r=this.db.prepare('SELECT data FROM profiles WHERE id=?').get(id) as any;return r?JSON.parse(r.data):undefined; }
  create(fields:Omit<Profile,'id'|'token'|'created'>) { const p={...fields,id:randomUUID(),token:randomToken(),created:Date.now()};this.save(p);return p; }
  save(p:Profile){this.db.prepare('INSERT INTO profiles(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(p.id,JSON.stringify(p));}
  connect(profile:string,provider:ProviderName,c:Credentials){
    this.transaction(()=>{
      const existing=this.db.prepare('SELECT secret FROM connections WHERE profile=? AND provider=?').get(profile,provider) as {secret:string}|undefined;
      if(existing&&unseal<Credentials>(existing.secret,this.key).token!==c.token) {
        throw Object.assign(new Error('Déconnecte d’abord le compte existant avant de changer de jeton'),{status:409});
      }
      // Stable on same-account reconnect; disconnect/reconnect creates a new generation,
      // even when the same token is supplied again. Old in-flight work cannot commit.
      this.db.prepare('INSERT INTO connections(profile,provider,secret) VALUES(?,?,?) ON CONFLICT(profile,provider) DO UPDATE SET error=NULL').run(profile,provider,existing?.secret??seal(c,this.key));
      this.db.prepare('DELETE FROM snapshots WHERE profile=? AND provider=?').run(profile,provider);
      this.db.prepare("UPDATE jobs SET status='pending',due=0,error=NULL WHERE profile=? AND provider=? AND status='blocked'").run(profile,provider);
    });
  }
  connectionRevision(profile:string,provider:ProviderName):string|undefined {
    const row=this.db.prepare('SELECT secret FROM connections WHERE profile=? AND provider=?').get(profile,provider) as {secret:string}|undefined;
    return row?hash(row.secret):undefined;
  }
  credentials(profile:string,provider:ProviderName):Credentials|undefined { const r=this.db.prepare('SELECT secret FROM connections WHERE profile=? AND provider=?').get(profile,provider) as any;return r?unseal(r.secret,this.key):undefined; }
  close(){this.db.close();}
}
