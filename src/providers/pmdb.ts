import { HttpClient, UpstreamError } from '../http.ts';
import type { Checkpoint, Credentials, MediaType, Provider, PushResult, Snapshot, WatchEvent, WatchItem } from '../types.ts';

type ObjectValue = Record<string, unknown>;
type Target = { tmdb_id: number; media_type: 'movie' | 'tv'; season?: number; episode?: number };
type HistoryRow = Target & { id: string; watched_at: string | null };
type ResumeRow = Target & { id: string; position_ms: number; runtime_ms: number; updated?: string; created?: string };
type Page<T> = { items: T[]; total: number; totalPages: number; page: number; perPage: number };

function invalid(message: string): never {
  throw new UpstreamError(`PublicMetaDB: ${message}`, 502);
}
function object(value: unknown, context: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${context}: expected an object`);
  return value as ObjectValue;
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function numericId(value: unknown): number | undefined {
  if (integer(value, 1)) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return undefined;
}
function date(value: unknown, context: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`${context}: invalid date`);
  return value as string;
}
function rowTarget(raw: ObjectValue, context: string): Target {
  if (!integer(raw.tmdb_id, 1) || (raw.media_type !== 'movie' && raw.media_type !== 'tv')) invalid(`${context}: invalid media identity`);
  const result: Target = { tmdb_id: raw.tmdb_id as number, media_type: raw.media_type as Target['media_type'] };
  if (result.media_type === 'tv') {
    if (!integer(raw.season, 0) || !integer(raw.episode, 1)) invalid(`${context}: invalid episode numbering`);
    result.season = raw.season as number;
    result.episode = raw.episode as number;
  }
  return result;
}
function historyRow(value: unknown): HistoryRow {
  const raw = object(value, 'history');
  if (typeof raw.id !== 'string' || !raw.id) invalid('history: missing row ID');
  if (raw.watched_at !== null) date(raw.watched_at, 'history');
  return { ...rowTarget(raw, 'history'), id: raw.id as string, watched_at: raw.watched_at as string | null };
}
function resumeRow(value: unknown): ResumeRow {
  const raw = object(value, 'resume');
  if (typeof raw.id !== 'string' || !raw.id) invalid('resume: missing row ID');
  if (!integer(raw.position_ms, 0) || !integer(raw.runtime_ms, 1) || raw.position_ms > raw.runtime_ms) invalid('resume: invalid duration or position');
  const result: ResumeRow = {
    ...rowTarget(raw, 'resume'), id: raw.id as string,
    position_ms: raw.position_ms as number, runtime_ms: raw.runtime_ms as number,
  };
  if (raw.updated != null) result.updated = date(raw.updated, 'resume.updated');
  if (raw.created != null) result.created = date(raw.created, 'resume.created');
  return result;
}
function page<T>(value: unknown, requestedPage: number, parseRow: (row: unknown) => T): Page<T> {
  const raw = object(value, 'pagination');
  if (!Array.isArray(raw.items) || !integer(raw.total, 0) || !integer(raw.totalPages, 0)
    || !integer(raw.perPage, 1) || raw.perPage > 500 || raw.page !== requestedPage) invalid('incomplete or invalid pagination');
  const total = raw.total as number;
  const perPage = raw.perPage as number;
  const totalPages = raw.totalPages as number;
  if (total === 0 ? (totalPages !== 0 && totalPages !== 1) : totalPages !== Math.ceil(total / perPage)) invalid('inconsistent pagination');
  if ((raw.items as unknown[]).length > perPage) invalid('page exceeds its declared size');
  return { items: (raw.items as unknown[]).map(parseRow), total, totalPages, page: requestedPage, perPage };
}
function identity(target: Target): { metaId: string; videoId: string } {
  const metaId = `tmdb:${target.tmdb_id}`;
  return { metaId, videoId: target.media_type === 'movie' ? metaId : `${metaId}:${target.season}:${target.episode}` };
}
function matches(a: Target, b: Target): boolean {
  return a.tmdb_id === b.tmdb_id && a.media_type === b.media_type
    && (a.media_type === 'movie' || (a.season === b.season && a.episode === b.episode));
}
function targetParams(target: Target): URLSearchParams {
  const params = new URLSearchParams({ tmdb_id: String(target.tmdb_id), media_type: target.media_type });
  if (target.media_type === 'tv') {
    params.set('season', String(target.season));
    params.set('episode', String(target.episode));
  }
  return params;
}
function successful(value: unknown, context: string): ObjectValue {
  const raw = object(value, context);
  if (raw.success !== true) invalid(`${context}: missing success confirmation`);
  return raw;
}

/** PublicMetaDB's documented external API; one instance-wide rate budget. */
export class PmdbProvider implements Provider {
  readonly name = 'pmdb' as const;
  private readonly http: HttpClient;

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.http = new HttpClient('https://publicmetadb.com', {
      fetch: options.fetch, intervalMs: 50, limiterKey: 'pmdb',
    });
  }

  private request(path: string, credentials: Credentials, init: RequestInit = {}): Promise<unknown> {
    if (!credentials.token?.trim()) throw new UpstreamError('Missing PublicMetaDB API key', 401);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credentials.token}`);
    if (init.body != null) headers.set('Content-Type', 'application/json');
    return this.http.json(path, { ...init, headers });
  }

  async validate(credentials: Credentials): Promise<void> {
    page(await this.request('/api/external/watched?page=1&perPage=1', credentials), 1, historyRow);
  }

  private async all<T extends { id: string }>(path: string, credentials: Credentials, parseRow: (row: unknown) => T): Promise<T[]> {
    const rows: T[] = [];
    let first: Page<T> | undefined;
    const seen = new Set<string>();
    for (let index = 1; index <= 20_000; index++) {
      const params = new URLSearchParams(path.split('?')[1]);
      params.set('page', String(index));
      params.set('perPage', '500');
      const result = page(await this.request(`${path.split('?')[0]}?${params}`, credentials), index, parseRow);
      first ??= result;
      if (result.total !== first.total || result.totalPages !== first.totalPages || result.perPage !== first.perPage) {
        invalid('the collection changed during pagination; a new full read is required');
      }
      for (const row of result.items) {
        if (seen.has(row.id)) invalid('duplicate row across pages; incomplete snapshot');
        seen.add(row.id);
        rows.push(row);
      }
      if (index >= result.totalPages) {
        if (rows.length !== result.total) invalid('row count differs from the reported total');
        return rows;
      }
      if (result.items.length !== result.perPage) invalid('incomplete intermediate page');
    }
    return invalid('pagination limit exceeded; no partial snapshot returned');
  }

  private async resolve(event: WatchEvent, type: MediaType, credentials: Credentials): Promise<Target> {
    if (event.videos || event.scope === 'season' || event.scope === 'series') throw new UpstreamError('PMDB batches must be split into individual videos', 422);
    if (type === 'series' && (event.season === null || !integer(event.season, 0) || !integer(event.episode, 1))) {
      throw new UpstreamError('PublicMetaDB requires an explicit season and episode; absolute numbering needs a verified mapping', 422);
    }
    if (type === 'series' && /^(?:kitsu|mal|anilist|anidb|simkl):/.test(event.metaId)) {
      throw new UpstreamError('This anime metadata numbering cannot be assumed to match TMDB', 422);
    }
    if (type === 'series' && /^(?:kitsu|mal|anilist|anidb|simkl):/.test(event.videoId ?? '')) {
      throw new UpstreamError('This anime video numbering requires an explicit mapping to TMDB episodes', 422);
    }
    const media_type = type === 'movie' ? 'movie' : 'tv';
    let tmdb_id = numericId(event.ids?.tmdb);
    if (event.ids?.tmdb != null && !tmdb_id) throw new UpstreamError('Invalid TMDB ID', 422);
    if (!tmdb_id && /^tmdb:[1-9]\d*$/.test(event.metaId)) tmdb_id = numericId(event.metaId.slice(5));
    if (!tmdb_id) {
      const imdb = event.ids?.imdb ?? (/^tt\d+$/.test(event.metaId) ? event.metaId : undefined);
      if (!imdb || !/^tt\d+$/.test(imdb)) throw new UpstreamError('PublicMetaDB: no usable TMDB or IMDb ID', 422);
      const params = new URLSearchParams({ id_type: 'imdb', id_value: imdb, media_type });
      const raw = object(await this.request(`/api/external/mappings/lookup?${params}`, credentials), 'IMDb mapping');
      if (!Array.isArray(raw.results) || !integer(raw.total, 0) || raw.total !== raw.results.length) invalid('incomplete IMDb mapping');
      const candidates = new Set<number>();
      for (const value of raw.results) {
        const candidate = object(value, 'IMDb mapping');
        if (!integer(candidate.tmdb_id, 1) || (candidate.media_type !== 'movie' && candidate.media_type !== 'tv')) invalid('invalid IMDb mapping');
        if (candidate.media_type === media_type) candidates.add(candidate.tmdb_id as number);
      }
      if (candidates.size !== 1) throw new UpstreamError(candidates.size ? 'Ambiguous IMDb to TMDB mapping' : 'No IMDb to TMDB mapping in PublicMetaDB', 422);
      tmdb_id = [...candidates][0];
    }
    return type === 'movie' ? { tmdb_id: tmdb_id!, media_type } : { tmdb_id: tmdb_id!, media_type, season: event.season!, episode: event.episode! };
  }

  private async clearResume(target: Target, credentials: Credentials, checkpoint: Checkpoint): Promise<void> {
    const rows = await checkpoint('pmdb:resume-list', () => this.all(`/api/external/resume?${targetParams(target)}`, credentials, resumeRow));
    for (const row of rows) {
      if (!matches(row, target)) invalid('the filtered response contains another video; deletion aborted');
      await checkpoint(`pmdb:resume-delete:${row.id}`, async () => {
        try {
          successful(await this.request(`/api/external/resume/${encodeURIComponent(row.id)}`, credentials, { method: 'DELETE' }), 'resume deletion');
        } catch (error) {
          // A replay after the remote delete but before the local checkpoint is harmless.
          if (!(error instanceof UpstreamError) || error.status !== 404) throw error;
        }
        return true;
      });
    }
  }

  async push(event: WatchEvent, type: MediaType, credentials: Credentials, checkpoint: Checkpoint): Promise<PushResult> {
    const target = await checkpoint('pmdb:target', () => this.resolve(event, type, credentials));
    if (event.event === 'unplayed') {
      // PMDB has no "unplayed" resume write. Remove the exact resume record
      // returned by the filtered list endpoint; never POST position_ms: 0.
      await checkpoint('pmdb:unplayed', async () => {
        const raw = successful(await this.request(`/api/external/watched?${targetParams(target)}`, credentials, { method: 'DELETE' }), 'history deletion');
        if (!integer(raw.deleted, 0)) invalid('history deletion: invalid count');
        return true;
      });
      await this.clearResume(target, credentials, checkpoint);
      return;
    }
    if (event.event === 'played' || (event.event === 'stop' && event.played === true)) {
      if (!Number.isFinite(event.at) || event.at < 0 || !Number.isFinite(new Date(event.at * 1000).getTime())) throw new UpstreamError('Invalid playback timestamp', 422);
      await checkpoint('pmdb:played', async () => {
        successful(await this.request('/api/external/watched?dedupe=true', credentials, {
          method: 'POST', body: JSON.stringify({ ...target, watched_at: new Date(event.at * 1000).toISOString() }),
        }), 'history write');
        return true;
      });
      await this.clearResume(target, credentials, checkpoint);
      return;
    }
    if (event.event !== 'start' && event.event !== 'pause' && event.event !== 'stop') throw new UpstreamError('Unrecognized PMDB event', 422);
    // Transient start/seek payloads must not delete a usable remote resume.
    // Only explicit played/unplayed actions above clear it.
    if (!integer(event.positionMs, 0) || !integer(event.durationMs, 1) || event.positionMs > event.durationMs) {
      return { localOnly: true, warning: 'Playback event kept locally: missing or invalid duration/position for PublicMetaDB. Existing remote resume preserved.' };
    }
    const progress = event.positionMs / event.durationMs * 100;
    if (progress < 2 || progress >= 80) {
      return { localOnly: true, warning: 'Resume kept locally: PublicMetaDB only saves progress from 2% inclusive to 80% exclusive. Existing remote resume preserved.' };
    }
    await checkpoint('pmdb:resume-save', async () => {
      const raw = object(await this.request('/api/external/resume', credentials, {
        method: 'POST', body: JSON.stringify({ ...target, position_ms: event.positionMs, runtime_ms: event.durationMs }),
      }), 'resume write');
      if (raw.action !== 'saved') invalid('resume write: missing saved confirmation');
      const item = object(raw.item, 'resume write.item');
      if (!matches(rowTarget(item, 'resume write'), target) || item.position_ms !== event.positionMs || item.runtime_ms !== event.durationMs) {
        invalid('resume write: different video or position');
      }
      return true;
    });
  }

  async pull(credentials: Credentials): Promise<Snapshot> {
    // Reject the entire read on either failure: a partial watched set would delete imported data.
    const history = await this.all('/api/external/watched', credentials, historyRow);
    const resumes = await this.all('/api/external/resume', credentials, resumeRow);
    const movies = new Set<string>();
    const episodes = new Set<string>();
    const showEpisodes = new Map<string, Set<string>>();
    for (const row of history) {
      const { metaId, videoId } = identity(row);
      if (row.media_type === 'movie') movies.add(metaId);
      else {
        episodes.add(videoId);
        const set = showEpisodes.get(metaId) ?? new Set<string>();
        set.add(videoId);
        showEpisodes.set(metaId, set);
      }
    }
    const items = resumes.map((row): WatchItem => {
      const timestamp = row.updated ?? row.created;
      return {
        type: row.media_type === 'movie' ? 'movie' : 'series', ...identity(row),
        ...(row.media_type === 'tv' ? { season: row.season, episode: row.episode } : {}),
        positionMs: row.position_ms, durationMs: row.runtime_ms,
        progressPercent: row.position_ms / row.runtime_ms * 100, played: false,
        ...(timestamp ? { at: Math.floor(Date.parse(timestamp) / 1000) } : {}),
      };
    }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.videoId.localeCompare(b.videoId));
    return {
      items,
      watched: {
        movies: [...movies].sort(), episodes: [...episodes].sort(),
        counts: Object.fromEntries([...showEpisodes].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, { watched: rows.size, total: 0 }])),
        nextUp: [],
      },
    };
  }
}
