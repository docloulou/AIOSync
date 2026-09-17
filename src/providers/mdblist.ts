import { HttpClient, UpstreamError } from '../http.ts';
import type { Checkpoint, Credentials, MediaType, Provider, PushResult, Snapshot, Watched, WatchEvent, WatchItem } from '../types.ts';

type Json = Record<string, any>;
type Ids = Record<string, string | number>;
type Target = { ids: Ids; season?: number; episode?: number };
type Cache = { signature?: string; watched: Watched; dirty: boolean };
const ID_KEYS = ['imdb', 'tmdb', 'tvdb', 'trakt', 'mdblist'];
const ACTIVITY_KEYS = ['watched_at', 'season_watched_at', 'episode_watched_at', 'journal_at'];
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
function invalid(message: string): never { throw new UpstreamError(`MDBList: ${message}`, 502); }
function object(value: unknown, context: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'error' in value) invalid(`invalid ${context}; previous state preserved`);
  return value as Json;
}
function ids(value: unknown): Ids {
  const result: Ids = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of ID_KEYS) {
    const v = (value as Json)[key];
    if (key === 'imdb' && typeof v === 'string' && /^tt\d+$/.test(v)) result[key] = v;
    else if (key === 'mdblist' && typeof v === 'string' && /^[a-zA-Z0-9_-]+$/.test(v)) result[key] = v;
    else if (['tmdb', 'tvdb', 'trakt'].includes(key) && /^(?:[1-9]\d*)$/.test(String(v)) && Number.isSafeInteger(Number(v))) result[key] = Number(v);
  }
  return result;
}
function aliases(value: Ids): string[] {
  return ID_KEYS.filter(k => value[k] !== undefined).map(k => k === 'imdb' ? String(value[k]) : `${k}:${value[k]}`);
}
function timestamp(value: unknown): number | undefined {
  if (value == null) return;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid('invalid playback timestamp');
  return Math.floor(Date.parse(value as string) / 1000);
}
function percentage(raw: unknown, fail: (reason: string) => never): number {
  // Both playback reads and scrobble acknowledgements can use decimal strings.
  const value = typeof raw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    const kind = raw === undefined ? 'missing' : raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    const reason = typeof value === 'number' && Number.isFinite(value) ? 'outside 0-100' : `expected a finite decimal number, received ${kind}`;
    // Report the field and row, never raw upstream content or credentials.
    fail(reason);
  }
  return value;
}
function playbackProgress(row: Json, index: number): number {
  // The optional fallback is a stored point too; never extrapolate elapsed time.
  const field = row.progress == null && row.progress_at_update != null ? 'progress_at_update' : 'progress';
  return percentage(row[field], reason => invalid(`invalid playback progress at item ${index + 1} (${field}: ${reason}); previous state preserved`));
}
function coordinates(row: Json): { season: number; episode: number } {
  const season = row.season_number ?? (typeof row.season === 'object' ? row.season?.number : row.season);
  const episode = row.number ?? row.episode_number ?? (typeof row.episode === 'number' ? row.episode : row.episode?.number);
  if (!integer(season) || !integer(episode, 1)) invalid('episode numbering is missing; no numbering was guessed');
  return { season, episode };
}
function identities(row: Json, type: MediaType): WatchItem[] {
  // Episode IDs belong to the episode, never to its parent show.
  const bases = aliases(ids(type === 'movie' ? row.movie?.ids : (row.show ?? row.episode?.show)?.ids));
  if (!bases.length) invalid('missing movie or parent-show identifiers');
  const c = type === 'series' ? coordinates(object(row.episode ?? row, 'episode')) : undefined;
  return bases.map(metaId => ({ type, metaId, videoId: c ? `${metaId}:${c.season}:${c.episode}` : metaId, ...c }));
}
function target(event: WatchEvent, type: MediaType): Target {
  if (event.videos || event.scope === 'season' || event.scope === 'series') throw new UpstreamError('MDBList batches must be split into individual videos', 422);
  if (type === 'series' && (!integer(event.season) || !integer(event.episode, 1)
    || /^(kitsu|mal|anilist|anidb|simkl):/.test(event.metaId) || /^(kitsu|mal|anilist|anidb|simkl):/.test(event.videoId ?? ''))) {
    throw new UpstreamError('MDBList requires verified TV season and episode numbers; absolute anime numbering is not converted', 422);
  }
  const value = ids(event.ids);
  const match = /^(?:(imdb|tmdb|tvdb|trakt|mdblist):)?([^:]+)$/.exec(event.metaId);
  if (match) Object.assign(value, ids({ [match[1] ?? 'imdb']: match[2] }));
  if (!Object.keys(value).length) throw new UpstreamError('MDBList: no supported movie or show identifier', 422);
  return { ids: value, ...(type === 'series' ? { season: event.season!, episode: event.episode! } : {}) };
}
function hasContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.values(value).some(hasContent);
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== '';
}
function checkHistory(value: unknown, watched: boolean): void {
  const row = object(value, 'history write response');
  object(row[watched ? 'updated' : 'deleted'], 'history write confirmation');
  if (hasContent(row.not_found)) throw new UpstreamError('MDBList could not resolve this title or episode', 422);
  if (hasContent(row.errors)) throw new UpstreamError('MDBList did not fully apply the history write', 422);
}

/** Personal API keys use MDBList's documented query authentication, server-side only. */
export class MdblistProvider implements Provider {
  readonly name = 'mdblist' as const;
  private fetcher?: typeof fetch;
  private clients = new Map<string, HttpClient>();
  private caches = new Map<string, Cache>();
  private operations = new Map<string, Promise<unknown>>();
  private pulls = new Map<string, Promise<Snapshot>>();
  private cooldowns = new Map<string, number>();
  constructor(options: { fetch?: typeof fetch } = {}) { this.fetcher = options.fetch; }

  private async request(path: string, credentials: Credentials, params: Record<string, string> = {}, body?: unknown): Promise<any> {
    if (!credentials.token?.trim()) throw new UpstreamError('Missing MDBList API key', 401);
    const retryAt = this.cooldowns.get(credentials.token) ?? 0;
    if (retryAt > Date.now()) throw new UpstreamError('MDBList API quota reached; retry deferred', 429, retryAt - Date.now());
    let client = this.clients.get(credentials.token);
    if (!client) {
      client = new HttpClient('https://api.mdblist.com', {
        fetch: this.fetcher, intervalMs: this.fetcher ? 0 : 100, limiterKey: `mdblist:${credentials.token}`,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'AIOSync/1.1.4' },
      });
      this.clients.set(credentials.token, client);
    }
    try {
      return await client.json(`${path}?${new URLSearchParams({ ...params, apikey: credentials.token })}`,
        body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 429) {
        this.cooldowns.set(credentials.token, Date.now() + Math.max(error.retryAfterMs, 30000));
      }
      throw error;
    }
  }
  private async serial<T>(token: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.operations.get(token) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.operations.set(token, pending);
    try { return await pending; } finally { if (this.operations.get(token) === pending) this.operations.delete(token); }
  }
  async validate(credentials: Credentials): Promise<void> {
    const user = object(await this.request('/user', credentials), 'account');
    if (!integer(user.user_id, 1)) invalid('the response does not confirm an authenticated account');
  }
  async push(event: WatchEvent, type: MediaType, credentials: Credentials, checkpoint: Checkpoint): Promise<PushResult> {
    return this.serial(credentials.token, () => this.pushOnce(event, type, credentials, checkpoint));
  }
  private async pushOnce(event: WatchEvent, type: MediaType, credentials: Credentials, checkpoint: Checkpoint): Promise<PushResult> {
    const t = target(event, type);
    const body = type === 'movie' ? { movie: { ids: t.ids } } : { show: t };
    const progress = Number.isFinite(event.positionMs) && event.positionMs! >= 0 && Number.isFinite(event.durationMs)
      && event.durationMs! > 0 && event.positionMs! <= event.durationMs! ? event.positionMs! / event.durationMs! * 100 : undefined;
    const watched = event.event === 'played' || event.event === 'stop' && event.played === true;
    const nativeCompletion = watched && event.event === 'stop' && progress !== undefined && progress >= 80;
    if ((watched && !nativeCompletion) || event.event === 'unplayed') {
      const date = new Date(event.at * 1000);
      if (!Number.isFinite(date.getTime())) throw new UpstreamError('Invalid playback timestamp', 422);
      const marked = watched ? { watched_at: date.toISOString() } : {};
      const history = type === 'movie' ? { movies: [{ ids: t.ids, ...marked }] } : {
        shows: [{ ids: t.ids, seasons: [{ number: t.season, episodes: [{ number: t.episode, ...marked }] }] }],
      };
      await checkpoint('mdblist:history', async () => {
        checkHistory(await this.request(watched ? '/sync/watched' : '/sync/watched/remove', credentials, {}, history), watched);
        return true;
      });
      // Also invalidate on a resumed checkpoint, before a later cleanup can fail.
      const cache = this.caches.get(credentials.token); if (cache) cache.dirty = true;
      await checkpoint('mdblist:clear', async () => {
        try {
          const result = object(await this.request('/scrobble/clear', credentials, {}, body), 'resume cleanup');
          if (typeof result.deleted !== 'boolean') invalid('missing resume cleanup confirmation');
        } catch (error) {
          // An already absent session satisfies this exact-item cleanup.
          if (!(error instanceof UpstreamError) || error.status !== 404) throw error;
        }
        return true;
      });
      return;
    }
    if (progress === undefined) return { localOnly: true, warning: 'MDBList: missing or invalid position/duration; existing remote resume preserved.' };
    // Both pause and stop auto-complete at 80%. AIOStreams decides completion.
    if (event.event !== 'start' && !nativeCompletion && progress >= 80) {
      return { localOnly: true, warning: 'Resume kept locally: MDBList automatically marks pause/stop at 80% as watched. Waiting for explicit completion.' };
    }
    if (!['start', 'pause', 'stop'].includes(event.event)) throw new UpstreamError('Unrecognized MDBList event', 422);
    await checkpoint(`mdblist:scrobble:${event.event}`, async () => {
      const result = object(await this.request(`/scrobble/${event.event}`, credentials, {}, { ...body, progress }), 'scrobble response');
      if (typeof result.action !== 'string' || !result.action.trim() || result.action === 'error') {
        invalid(`invalid ${event.event} scrobble confirmation (action: missing or invalid)`);
      }
      percentage(result.progress, reason => invalid(`invalid ${event.event} scrobble confirmation (progress: ${reason})`));
      return true;
    });
    if (nativeCompletion) { const cache = this.caches.get(credentials.token); if (cache) cache.dirty = true; }
  }

  private async history(credentials: Credentials, type: MediaType): Promise<WatchItem[][]> {
    const bucket = type === 'movie' ? 'movies' : 'episodes';
    const rows: WatchItem[][] = [];
    const seen = new Set<string>(), cursors = new Set<string>();
    let total: number | undefined, cursor: string | undefined;
    for (let page = 0; page < 2000; page++) {
      const params: Record<string, string> = { mediatype: type === 'movie' ? 'movie' : 'episode', limit: '1000' };
      if (cursor) params.cursor = cursor; else if (rows.length) params.offset = String(rows.length);
      const context = `${bucket} history page ${page + 1}`;
      // Never put upstream values, cursors, or request URLs into diagnostics.
      const fail = (reason: string): never => invalid(`${context}: ${reason}; previous state preserved`);
      const count = (value: unknown, field: string, min = 0): number | undefined => {
        if (value === undefined || value === null) return;
        const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
        if (!integer(n, min)) fail(`invalid pagination.${field}`);
        return n as number;
      };
      const response = object(await this.request('/sync/watched', credentials, params), context);
      const pagination = object(response.pagination, `${context} pagination`);
      // Cursor responses need not contain totals. Older offset responses may
      // report total_movies/total_episodes instead of one generic total.
      const totalField = pagination[`total_${bucket}`] != null ? `total_${bucket}` : 'total';
      const pageTotal = count(pagination[totalField], totalField);
      const limit = count(pagination.limit, 'limit', 1) ?? 1000;
      const offset = count(pagination.offset, 'offset');
      if (pageTotal !== undefined) {
        if (total !== undefined && pageTotal !== total) fail('history changed during pagination; a new full read is required');
        total = pageTotal;
      }
      const next = pagination.next_cursor;
      const hasCursor = Object.hasOwn(pagination, 'next_cursor');
      if (hasCursor && next !== null && typeof next !== 'string') fail('invalid pagination.next_cursor');
      const hasMore = pagination.has_more;
      if (hasMore !== undefined && typeof hasMore !== 'boolean') fail('invalid pagination.has_more');
      if (next && hasMore === false) fail('conflicting pagination continuation signals');
      if (!cursor && offset !== undefined && offset !== rows.length) fail('unexpected history offset');
      // Omitted empty buckets are safe only with an explicit zero total.
      const entries = response[bucket] === undefined && pageTotal === 0 ? [] : response[bucket];
      if (!Array.isArray(entries)) fail(`missing or invalid ${bucket} array`);
      if (entries.length > limit) fail('history page exceeds pagination.limit');
      for (const entry of entries) {
        const candidates = identities(object(entry, 'watched item'), type);
        if (seen.has(candidates[0]!.videoId)) fail('duplicate history entry; no partial snapshot returned');
        seen.add(candidates[0]!.videoId); rows.push(candidates);
      }
      if (total !== undefined && rows.length > total) fail('history exceeds its declared total');
      if (next) {
        if (total !== undefined && rows.length === total) fail('history cursor continues beyond the declared total');
        if (!entries.length) fail('empty intermediate history page');
        if (cursors.has(next)) fail('repeated history cursor');
        cursors.add(next); cursor = next;
        continue;
      }
      // Legacy has_more pages continue by offset even when next_cursor is null.
      const more = hasMore === true || (hasMore === undefined && !hasCursor && total !== undefined && rows.length < total);
      if (more) {
        if (total !== undefined && rows.length === total) fail('history continues beyond the declared total');
        if (!entries.length) fail('empty intermediate history page');
        cursor = undefined;
        continue;
      }
      if (hasMore === false || hasCursor || total !== undefined && rows.length === total) {
        if (total !== undefined && rows.length !== total) fail('incomplete history; row count differs from the declared total');
        return rows;
      }
      // A short page alone is not proof that a watched snapshot is complete.
      fail('missing pagination completion signal (next_cursor, has_more or total)');
    }
    return invalid('history pagination limit exceeded');
  }
  private async nextUp(credentials: Credentials, counts: Watched['counts']): Promise<WatchItem[]> {
    const items: WatchItem[] = [], seen = new Set<string>();
    let offset = 0;
    for (let page = 0; page < 1000; page++) {
      const response = object(await this.request('/upnext', credentials, { limit: '100', offset: String(offset), hide_unreleased: 'true' }), 'up next');
      if (!Array.isArray(response.items) || typeof response.has_more !== 'boolean' || response.items.length > 100) invalid('invalid up-next pagination');
      for (const entry of response.items) {
        const row = object(entry, 'up-next item');
        if (!Object.hasOwn(row, 'next_episode')) invalid('missing next-episode field');
        if (row.next_episode === null) continue;
        const candidates = identities({ show: row.show ?? row, episode: row.next_episode }, 'series');
        const best = candidates[0]!;
        if (seen.has(best.metaId)) invalid('repeated show in up-next pagination');
        seen.add(best.metaId);
        const at = timestamp(row.last_watched_at);
        items.push({ ...best, ...(at !== undefined ? { at } : {}) });
        const total = row.progress?.total ?? row.total_episodes;
        for (const candidate of candidates) {
          const count = counts[candidate.metaId] ?? { watched: 0, total: 0 };
          if (integer(total) && total >= count.watched) count.total = total;
          counts[candidate.metaId] = count;
        }
      }
      if (!response.has_more) return items;
      if (!response.items.length) invalid('empty intermediate up-next page');
      offset += response.items.length;
    }
    return invalid('up-next pagination limit exceeded');
  }
  async pull(credentials: Credentials): Promise<Snapshot> {
    const existing = this.pulls.get(credentials.token); if (existing) return existing;
    const pending = this.serial(credentials.token, () => this.pullOnce(credentials));
    this.pulls.set(credentials.token, pending);
    try { return await pending; } finally { this.pulls.delete(credentials.token); }
  }
  private async pullOnce(credentials: Credentials): Promise<Snapshot> {
    const activity = object(await this.request('/sync/last_activities', credentials), 'activity timestamps');
    const complete = ACTIVITY_KEYS.every(k => Object.hasOwn(activity, k));
    const signature = complete ? JSON.stringify([...ACTIVITY_KEYS.map(k => timestamp(activity[k])), new Date().toISOString().slice(0, 10)]) : undefined;
    const prior = this.caches.get(credentials.token);
    let watched: Watched;
    if (!prior || prior.dirty || signature === undefined || signature !== prior.signature) {
      const movies = await this.history(credentials, 'movie');
      const episodes = await this.history(credentials, 'series');
      const counts: Watched['counts'] = {};
      for (const candidates of episodes) for (const item of candidates) {
        counts[item.metaId] ??= { watched: 0, total: 0 }; counts[item.metaId]!.watched++;
      }
      watched = { movies: [...new Set(movies.flatMap(a => a.map(i => i.metaId)))].sort(),
        episodes: [...new Set(episodes.flatMap(a => a.map(i => i.videoId)))].sort(), counts, nextUp: await this.nextUp(credentials, counts) };
    } else watched = prior.watched;
    // Always read paused sessions: external players' progress must replace older local backups.
    const playback = await this.request('/sync/playback', credentials);
    if (!Array.isArray(playback)) invalid('invalid playback list');
    const items = new Map<string, WatchItem>();
    for (const [index, entry] of playback.entries()) {
      const row = object(entry, 'playback');
      if (row.type !== 'movie' && row.type !== 'episode') invalid('unknown playback type');
      const progress = playbackProgress(row, index);
      if (row.runtime != null && !integer(row.runtime)) invalid('invalid playback runtime');
      const best = identities(row, row.type === 'movie' ? 'movie' : 'series')[0]!;
      const dates = [timestamp(row.updated_at), timestamp(row.paused_at)];
      if (row.updated_at_ts != null) { if (!integer(row.updated_at_ts)) invalid('invalid playback timestamp'); dates.push(row.updated_at_ts); }
      const knownDates = dates.filter((d): d is number => d !== undefined);
      const at = knownDates.length ? Math.max(...knownDates) : undefined;
      const durationMs = row.runtime > 0 ? row.runtime * 60000 : undefined;
      const item: WatchItem = { ...best, progressPercent: progress, played: false,
        ...(at !== undefined ? { at } : {}), ...(durationMs !== undefined ? { durationMs, positionMs: Math.round(durationMs * progress / 100) } : {}) };
      const key = `${item.type}:${item.videoId}`;
      if (!items.has(key) || (at ?? 0) >= (items.get(key)!.at ?? 0)) items.set(key, item);
    }
    // Commit only after every read succeeds. Failed reads retain the previous complete snapshot.
    this.caches.set(credentials.token, { signature, watched, dirty: false });
    return { items: [...items.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.videoId.localeCompare(b.videoId)), watched: structuredClone(watched) };
  }
}
