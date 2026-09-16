import { HttpClient, UpstreamError } from '../http.ts';
import type { Checkpoint, Credentials, MediaType, Provider, PushResult, Snapshot, Video, WatchEvent, WatchItem } from '../types.ts';

type Json = Record<string, any>;
type Ids = Record<string, string>;
type Bucket = 'shows' | 'movies' | 'anime';
type Cache = { activity: Json; entries: Map<string, { bucket: Bucket; row: Json }>; dirty: boolean };
type Target = { ids: Ids; native: boolean; season?: number; episode?: number; videoId?: string };
const NATIVE = new Set(['mal', 'kitsu', 'anilist', 'anidb']);
const ACCEPTED = new Set(['imdb', 'tmdb', 'tvdb', 'simkl', ...NATIVE]);
const BUCKETS: Bucket[] = ['shows', 'movies', 'anime'];
const epoch = (value: unknown): number | undefined => {
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.floor(date / 1000) : undefined;
};
const number = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
function ids(value: unknown): Ids {
  const result: Ids = {};
  if (!value || typeof value !== 'object') return result;
  for (const [key, val] of Object.entries(value)) {
    if (ACCEPTED.has(key) && (typeof val === 'string' || typeof val === 'number') && String(val)) result[key] = String(val);
  }
  return result;
}
function parseBase(value: string | undefined): { key: string; value: string } | undefined {
  if (!value) return;
  const imdb = /^(?:imdb:)?(tt\d+)(?::|$)/.exec(value);
  if (imdb) return { key: 'imdb', value: imdb[1]! };
  const match = /^(tmdb|tvdb|simkl|mal|kitsu|anilist|anidb):(\d+)(?::|$)/.exec(value);
  return match ? { key: match[1]!, value: match[2]! } : undefined;
}
function baseId(key: string, value: string): string { return key === 'imdb' ? value : `${key}:${value}`; }
function aliases(value: Ids): string[] { return Object.entries(value).map(([key, val]) => baseId(key, val)); }
function movieIds(row: Json): Ids { return ids((row.movie ?? row.show ?? row.anime)?.ids); }
function nativeAliases(value: Ids): string[] {
  return Object.entries(value).filter(([key]) => NATIVE.has(key) || key === 'simkl').map(([key, val]) => baseId(key, val));
}
function televisionAliases(value: Ids, anime: boolean): string[] {
  return Object.entries(value).filter(([key]) => !NATIVE.has(key) && (!anime || key !== 'simkl')).map(([key, val]) => baseId(key, val));
}
function videoId(metaId: string, season: number | null, episode: number): string {
  return season === null ? `${metaId}:${episode}` : `${metaId}:${season}:${episode}`;
}
function bestItem(candidates: WatchItem[]): WatchItem {
  const priority = ['imdb', 'tmdb', 'tvdb', 'kitsu', 'mal', 'anilist', 'anidb', 'simkl'];
  const rank = (item: WatchItem) => {
    const key = parseBase(item.metaId)?.key;
    const index = key ? priority.indexOf(key) : -1;
    return index < 0 ? priority.length : index;
  };
  if (!candidates.length) throw new UpstreamError('SIMKL : aucun identifiant exploitable pour la reprise.', 502);
  return candidates.reduce((best, item) => rank(item) < rank(best) ? item : best);
}
function assertLibrary(response: unknown, expectedBucket?: Bucket): asserts response is Json {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new UpstreamError('SIMKL : historique invalide.', 502);
  // Official /all-items omits empty buckets and returns exactly {} for an empty library.
  // An error or unexpected envelope is never interpreted as an empty library.
  for (const [key, value] of Object.entries(response)) {
    if (!BUCKETS.includes(key as Bucket) || expectedBucket && key !== expectedBucket || !Array.isArray(value)) {
      throw new UpstreamError('SIMKL : réponse d’historique inattendue, état précédent conservé.', 502);
    }
    if (value.some(row => !row || typeof row !== 'object' || Array.isArray(row) || 'error' in row)) {
      throw new UpstreamError('SIMKL : entrée d’historique invalide.', 502);
    }
  }
}
function episodeRows(value: Ids, anime: boolean, episode: Json, season?: number): WatchItem[] {
  const ep = number(episode.number ?? episode.episode);
  if (ep === undefined || ep < 1) throw new Error('SIMKL a renvoyé un épisode sans numéro exploitable.');
  const output: WatchItem[] = [];
  const tvSeason = number(episode.tvdb?.season ?? episode.tvdb_season ?? (!anime ? (episode.season ?? season) : undefined));
  const tvEpisode = number(episode.tvdb?.episode ?? episode.tvdb_number ?? (!anime ? ep : undefined));
  if (tvSeason !== undefined && tvEpisode !== undefined) {
    for (const metaId of televisionAliases(value, anime)) output.push({ type: 'series', metaId, videoId: videoId(metaId, tvSeason, tvEpisode), season: tvSeason, episode: tvEpisode });
  }
  if (anime) {
    // Simkl anime seasons are AniDB titles. Their episode numbers are absolute within that title.
    // Specials are not an absolute episode in the main title: keep their real Simkl season.
    if (season === 0 || episode.season === 0) {
      if (value.simkl) {
        const metaId = `simkl:${value.simkl}`;
        output.push({ type: 'series', metaId, videoId: videoId(metaId, 0, ep), season: 0, episode: ep });
      }
    } else {
      for (const metaId of nativeAliases(value)) output.push({ type: 'series', metaId, videoId: videoId(metaId, null, ep), season: null, episode: ep });
    }
  }
  if (!output.length) throw new Error('SIMKL : numérotation ou identifiants impossibles à convertir sans inventer un épisode.');
  return output;
}
function target(event: WatchEvent, type: MediaType, video?: Video): Target {
  const available = ids(event.ids);
  const meta = parseBase(event.metaId);
  if (meta) available[meta.key] = meta.value;
  const videoBase = parseBase(video?.videoId ?? event.videoId);
  const season = video ? video.season : event.season;
  const episode = video ? video.episode : event.episode;
  const primary = videoBase && NATIVE.has(videoBase.key) ? videoBase : meta;
  const native = type === 'series' && (!!primary && NATIVE.has(primary.key) || season === null);
  let selected: Ids;
  if (native) {
    // Never pair absolute anime coordinates with a franchise IMDb/TMDB identifier.
    if (primary && (NATIVE.has(primary.key) || primary.key === 'simkl')) selected = { [primary.key]: primary.value };
    else {
      const nativeKey = [...NATIVE].find(key => available[key]);
      if (!nativeKey) throw new UpstreamError('SIMKL : épisode absolu sans identifiant anime (Kitsu, MAL, AniList, AniDB ou Simkl).', 422);
      selected = { [nativeKey]: available[nativeKey]! };
    }
  } else {
    selected = Object.fromEntries(Object.entries(available).filter(([key]) => !NATIVE.has(key)));
    if (!Object.keys(selected).length && type === 'movie') selected = available;
  }
  if (!Object.keys(selected).length) throw new UpstreamError('SIMKL : aucun identifiant pris en charge pour ce contenu.', 422);
  if (type === 'series' && (!Number.isInteger(episode) || episode! < 1)) throw new UpstreamError('SIMKL : numéro d’épisode requis pour une écriture exacte.', 422);
  if (type === 'series' && !native && (!Number.isInteger(season) || season! < 0)) throw new UpstreamError('SIMKL : saison requise pour une série à numérotation TV.', 422);
  return { ids: selected, native, ...(type === 'series' ? { episode, ...(native ? {} : { season: season! }) } : {}), videoId: video?.videoId ?? event.videoId };
}
function checkWrite(body: any, allowPartial = false): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('SIMKL : réponse d’écriture invalide.');
  if ('error' in body) throw new UpstreamError('SIMKL a renvoyé une erreur dans sa réponse d’écriture.', 502);
  const missing = Object.values(body.not_found ?? {}).filter(Array.isArray).flat();
  if (missing.length) {
    const details = missing.slice(0, 10).map((item: any) => {
      const identity = aliases(ids(item?.ids)).join(', ') || 'identifiant inconnu';
      const coordinates = (item?.seasons ?? []).flatMap((season: any) => (season.episodes ?? []).map((ep: any) => `S${season.number}E${ep.number}`));
      const absolute = (item?.episodes ?? []).map((ep: any) => `E${ep.number}`);
      return `${identity}${coordinates.length || absolute.length ? ` (${[...coordinates, ...absolute].join(', ')})` : ''}`;
    }).join('; ');
    const warning = `SIMKL : ${missing.length} contenu(s) ou épisode(s) non reconnu(s) : ${details}.`;
    if (allowPartial) return warning;
    throw new UpstreamError(warning, 422);
  }
}

export class SimklProvider implements Provider {
  name = 'simkl' as const;
  private clientId: string;
  private fetcher: typeof fetch | undefined;
  private clients = new Map<string, HttpClient>();
  private caches = new Map<string, Cache>();
  private pulls = new Map<string, Promise<Snapshot>>();
  private operations = new Map<string, Promise<unknown>>();

  constructor(options: { clientId: string; fetch?: typeof fetch }) {
    this.clientId = options.clientId;
    this.fetcher = options.fetch;
  }
  private client(credentials: Credentials): HttpClient {
    let client = this.clients.get(credentials.token);
    if (!client) {
      client = new HttpClient('https://api.simkl.com', {
        headers: { Authorization: `Bearer ${credentials.token}`, 'User-Agent': 'aiostreams-tracker-bridge/1.0.0', 'Content-Type': 'application/json' },
        fetch: this.fetcher, intervalMs: this.fetcher ? 0 : 1100, limiterKey: `simkl:${credentials.token}`,
      });
      this.clients.set(credentials.token, client);
    }
    return client;
  }
  private path(path: string, params: Record<string, string> = {}): string {
    return `${path}?${new URLSearchParams({ client_id: this.clientId, 'app-name': 'aiostreams-tracker-bridge', 'app-version': '1.0.0', ...params })}`;
  }
  private async serial<T>(token: string, operation: () => Promise<T>): Promise<T> {
    const before = this.operations.get(token) ?? Promise.resolve();
    const pending = before.catch(() => {}).then(operation);
    this.operations.set(token, pending);
    try { return await pending; } finally {
      if (this.operations.get(token) === pending) this.operations.delete(token);
    }
  }
  async validate(credentials: Credentials): Promise<void> {
    const result = await this.client(credentials).json(this.path('/users/settings'), { method: 'POST' });
    if (!result?.account?.id) throw new Error('SIMKL : la réponse ne confirme pas de compte authentifié.');
  }
  async push(event: WatchEvent, type: MediaType, credentials: Credentials, checkpoint: Checkpoint): Promise<PushResult> {
    return this.serial(credentials.token, () => this.pushOnce(event, type, credentials, checkpoint));
  }
  private async pushOnce(event: WatchEvent, type: MediaType, credentials: Credentials, checkpoint: Checkpoint): Promise<PushResult> {
    const client = this.client(credentials);
    const bulk = event.scope === 'season' || event.scope === 'series';
    if (bulk && (!event.videos?.length || !['played', 'unplayed'].includes(event.event))) throw new UpstreamError('SIMKL : marque groupée sans liste exacte des épisodes.', 422);
    const targets = bulk ? event.videos!.map(video => target(event, type, video)) : [target(event, type)];
    const watched = event.event === 'played' || event.event === 'stop' && event.played === true;
    if (watched || event.event === 'unplayed') {
      const body: Json = {};
      const watchedAt = new Date(event.at * 1000).toISOString();
      if (type === 'movie') body.movies = targets.map(t => ({ ids: t.ids, ...(watched ? { watched_at: watchedAt } : {}) }));
      else {
        const groups = new Map<string, Json>();
        for (const t of targets) {
          const key = JSON.stringify([t.ids, t.native]);
          let show = groups.get(key);
          if (!show) { show = { ids: t.ids, ...(t.native ? { episodes: [] } : { use_tvdb_anime_seasons: true, seasons: [] }) }; groups.set(key, show); }
          const ep = { number: t.episode, ...(watched ? { watched_at: watchedAt } : {}) };
          if (t.native) show.episodes.push(ep);
          else {
            let season = show.seasons.find((s: Json) => s.number === t.season);
            if (!season) { season = { number: t.season, episodes: [] }; show.seasons.push(season); }
            if (!season.episodes.some((e: Json) => e.number === ep.number)) season.episodes.push(ep);
          }
        }
        body.shows = [...groups.values()];
      }
      const outcome = await checkpoint('simkl:history', async () => {
        const result = await client.json(this.path(watched ? '/sync/history' : '/sync/history/remove'), { method: 'POST', body: JSON.stringify(body) });
        return { warning: checkWrite(result, bulk) };
      });
      // A manual unwatch must clear the old Continue Watching entry as well.
      // History marks already hide prior playbacks; this also removes future-dated stale sessions.
      const saved = await checkpoint('simkl:resume-list', () => client.json(this.path('/sync/playback', { hide_watched: 'false' })));
      if (!Array.isArray(saved)) throw new Error('SIMKL : liste de reprises invalide.');
      for (const playback of saved) {
        if (!this.matches(playback, targets, type)) continue;
        const id = String(playback.id ?? '');
        if (!/^\d+$/.test(id)) throw new Error('SIMKL : identifiant de reprise invalide.');
        await checkpoint(`simkl:resume-delete:${id}`, () => client.json(this.path(`/sync/playback/${id}`), { method: 'DELETE' }));
      }
      const cache = this.caches.get(credentials.token);
      if (cache) cache.dirty = true;
      return outcome?.warning ? { warning: outcome.warning } : undefined;
    }
    if (event.durationMs === undefined || event.durationMs <= 0 || event.positionMs === undefined) {
      return { localOnly: true, warning: 'SIMKL : progression inconnue (durée ou position absente), aucun point de reprise n’a été écrasé.' };
    }
    const progress = Math.max(0, Math.min(100, event.positionMs / event.durationMs * 100));
    const t = targets[0]!;
    const body = type === 'movie' ? { movie: { ids: t.ids }, progress } : {
      [t.native ? 'anime' : 'show']: { ids: t.ids },
      episode: { ...(t.native ? {} : { season: t.season }), number: t.episode }, progress,
    };
    // Simkl stop auto-completes at 80%, AIOStreams at 90%. AIOStreams' explicit played flag wins.
    const action = event.event === 'start' ? 'start' : 'pause';
    await checkpoint(`simkl:scrobble:${action}`, async () => {
      checkWrite(await client.json(this.path(`/scrobble/${action}`), { method: 'POST', body: JSON.stringify(body) }));
    });
  }
  private matches(playback: Json, targets: Target[], type: MediaType): boolean {
    const value = movieIds(playback);
    if (type === 'movie' && !playback.movie) return false;
    if (type === 'series' && !playback.episode) return false;
    return targets.some(t => {
      if (!Object.entries(t.ids).some(([key, val]) => value[key] === val)) return false;
      if (type === 'movie') return true;
      const ep = playback.episode;
      return t.native ? number(ep.number ?? ep.episode) === t.episode :
        number(ep.tvdb_season ?? ep.season) === t.season && number(ep.tvdb_number ?? ep.number ?? ep.episode) === t.episode;
    });
  }
  async pull(credentials: Credentials): Promise<Snapshot> {
    const existing = this.pulls.get(credentials.token);
    if (existing) return existing;
    const pending = this.serial(credentials.token, () => this.pullOnce(credentials));
    this.pulls.set(credentials.token, pending);
    try { return await pending; } finally { this.pulls.delete(credentials.token); }
  }
  private async pullOnce(credentials: Credentials): Promise<Snapshot> {
    const client = this.client(credentials);
    const activity = await client.json(this.path('/sync/activities'));
    if (!activity || typeof activity !== 'object' || 'error' in activity || typeof activity.all !== 'string') throw new Error('SIMKL : horodatage de synchronisation invalide.');
    const prior = this.caches.get(credentials.token);
    const cache: Cache = { activity, entries: new Map(prior?.entries ?? []), dirty: false };
    const full = { extended: 'full_anime_seasons', episode_watched_at: 'yes', include_all_episodes: 'yes', next_watch_info: 'yes' };
    const merge = (response: unknown, expectedBucket?: Bucket) => {
      assertLibrary(response, expectedBucket);
      for (const bucket of BUCKETS) {
        if (response[bucket] !== undefined && !Array.isArray(response[bucket])) throw new Error('SIMKL : historique invalide.');
        for (const row of response[bucket] ?? []) {
          const value = movieIds(row);
          if (!value.simkl) throw new Error('SIMKL : historique sans identifiant stable.');
          if (!['watching', 'plantowatch', 'hold', 'completed', 'dropped'].includes(row.status)) throw new UpstreamError('SIMKL : état de visionnage manquant ou invalide.', 502);
          cache.entries.set(`${bucket}:${value.simkl}`, { bucket, row });
        }
      }
    };
    if (!prior) {
      for (const bucket of BUCKETS) merge(await client.json(this.path(`/sync/all-items/${bucket}`, full)), bucket);
    } else if (activity.all !== prior.activity.all || prior.dirty) {
      merge(await client.json(this.path('/sync/all-items', { ...full, date_from: prior.activity.all })));
      const removed = BUCKETS.some(bucket => {
        const key = bucket === 'shows' ? 'tv_shows' : bucket;
        return activity[key]?.removed_from_list !== prior.activity[key]?.removed_from_list;
      });
      if (removed || prior.dirty) {
        const current = await client.json(this.path('/sync/all-items', { extended: 'simkl_ids_only' }));
        assertLibrary(current);
        const keys = new Set<string>();
        for (const bucket of BUCKETS) {
          if (current[bucket] !== undefined && !Array.isArray(current[bucket])) throw new Error('SIMKL : réconciliation des suppressions invalide.');
          for (const row of current[bucket] ?? []) {
            // Full AllItemsEntry uses movie/show.ids; the thin mode is also described as ids.simkl.
            // Accept either explicit identifier object, never positional/numeric guesses.
            const simkl = movieIds(row).simkl ?? ids(row.ids).simkl;
            if (!simkl) throw new Error('SIMKL : identifiant manquant pendant la réconciliation.');
            keys.add(`${bucket}:${simkl}`);
          }
        }
        for (const key of cache.entries.keys()) if (!keys.has(key)) cache.entries.delete(key);
      }
    }
    const playbacks = await client.json(this.path('/sync/playback', { limit: '10000' }));
    if (!Array.isArray(playbacks)) throw new Error('SIMKL : liste de reprises invalide.');
    if (playbacks.length >= 10000) throw new Error('SIMKL : limite de 10 000 reprises atteinte ; réponse potentiellement tronquée.');
    const snapshot = this.snapshot(cache, playbacks);
    // Commit only after every upstream read and mapping succeeds; errors never erase a prior snapshot.
    this.caches.set(credentials.token, cache);
    return snapshot;
  }
  private snapshot(cache: Cache, playbacks: Json[]): Snapshot {
    const movies = new Set<string>();
    const episodes = new Set<string>();
    const counts: Snapshot['watched']['counts'] = {};
    const nextUp: WatchItem[] = [];
    for (const { bucket, row } of cache.entries.values()) {
      const value = movieIds(row);
      const anime = bucket === 'anime';
      const film = bucket === 'movies' || anime && row.anime_type === 'movie';
      if (film) {
        if (row.status === 'completed') for (const alias of aliases(value)) movies.add(alias);
        continue;
      }
      for (const season of row.seasons ?? []) for (const episode of season.episodes ?? []) {
        // /all-items returns watched rows, unlike /sync/watched which includes watched:false rows.
        if (episode.watched === false) continue;
        for (const item of episodeRows(value, anime, episode, number(season.number))) episodes.add(item.videoId);
      }
      const watched = number(row.watched_episodes_count);
      const total = number(row.total_episodes_count) ?? 0;
      if (watched !== undefined) for (const alias of aliases(value)) {
        // Different anime cours may share a TV ID. Their per-title counts are NOT franchise totals.
        if (anime && televisionAliases(value, true).includes(alias)) continue;
        counts[alias] = { watched, total };
      }
      if (row.status !== 'watching') continue;
      const info = row.next_to_watch_info;
      const marker = typeof row.next_to_watch === 'string' ? /^(?:S(\d+))?E(\d+)$/.exec(row.next_to_watch) : null;
      const ep = number(info?.episode ?? marker?.[2]);
      if (ep === undefined) continue;
      const season = number(info?.season ?? marker?.[1]);
      const candidates = episodeRows(value, anime, { number: ep, ...(info?.tvdb ? { tvdb: info.tvdb } : {}) }, season);
      // One provider-authoritative pointer, using the best mapped identity; no '+1' inference.
      nextUp.push({ ...bestItem(candidates), ...(epoch(row.last_watched_at) !== undefined ? { at: epoch(row.last_watched_at) } : {}) });
    }
    const items: WatchItem[] = [];
    const runtimeById = new Map<string, number | null>();
    for (const { bucket, row } of cache.entries.values()) {
      const runtime = number((row.movie ?? row.show ?? row.anime)?.runtime);
      if (runtime === undefined || runtime <= 0) continue;
      const kind = bucket === 'movies' || bucket === 'anime' && row.anime_type === 'movie' ? 'movie' : 'series';
      for (const alias of aliases(movieIds(row))) {
        const key = `${kind}:${alias}`;
        if (runtimeById.has(key) && runtimeById.get(key) !== runtime) runtimeById.set(key, null);
        else if (!runtimeById.has(key)) runtimeById.set(key, runtime);
      }
    }
    for (const playback of playbacks) {
      const progress = number(playback.progress);
      if (progress === undefined || progress < 0 || progress > 100) throw new Error('SIMKL : pourcentage de reprise invalide.');
      const value = movieIds(playback);
      let runtime = number((playback.movie ?? playback.show ?? playback.anime)?.runtime);
      if (runtime === undefined) {
        const kind = playback.movie ? 'movie' : 'series';
        const lookup = value.simkl ? [`simkl:${value.simkl}`, ...aliases(value)] : aliases(value);
        for (const alias of lookup) {
          const candidate = runtimeById.get(`${kind}:${alias}`);
          if (candidate !== undefined && candidate !== null) { runtime = candidate; break; }
        }
      }
      const durationMs = runtime !== undefined && runtime > 0 ? runtime * 60000 : undefined;
      const extras = {
        progressPercent: progress,
        ...(durationMs !== undefined ? { durationMs, positionMs: Math.round(durationMs * progress / 100) } : {}),
        ...(epoch(playback.paused_at) !== undefined ? { at: epoch(playback.paused_at) } : {}),
      };
      if (playback.movie) {
        const candidate = bestItem(aliases(value).map((metaId): WatchItem => ({ type: 'movie', metaId, videoId: metaId })));
        items.push({ ...candidate, ...extras });
      } else if (playback.episode) {
        const anime = !!playback.anime || [...NATIVE].some(key => value[key]);
        const candidate = bestItem(episodeRows(value, anime, playback.episode, number(playback.episode.season)));
        items.push({ ...candidate, ...extras });
      } else throw new Error('SIMKL : reprise sans film ni épisode.');
    }
    items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return { items, watched: { movies: [...movies].sort(), episodes: [...episodes].sort(), counts, nextUp } };
  }
}
