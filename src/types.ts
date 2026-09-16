export type ProviderName = 'simkl' | 'pmdb' | 'mdblist';
export type MediaType = 'movie' | 'series';
export type Credentials = { token: string };
export type Video = { videoId: string; season?: number | null; episode?: number };
export type WatchEvent = {
  id: string; event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed';
  at: number; scope?: 'movie' | 'episode' | 'season' | 'series';
  metaId: string; videoId?: string; season?: number | null; episode?: number;
  positionMs?: number; durationMs?: number; played?: boolean;
  ids?: Record<string, string>; videos?: Video[]; part?: number; parts?: number;
};
export type WatchItem = {
  type: MediaType; metaId: string; videoId: string; season?: number | null; episode?: number;
  progressPercent?: number; positionMs?: number; durationMs?: number; played?: boolean; at?: number;
};
export type Watched = {
  movies: string[]; episodes: string[];
  counts: Record<string, { watched: number; total: number }>;
  nextUp: WatchItem[];
};
export type Snapshot = { items: WatchItem[]; watched: Watched };
export type Checkpoint = <T>(key: string, operation: () => Promise<T>) => Promise<T>;
export type PushResult = { warning?: string; localOnly?: boolean } | void;
export interface Provider {
  name: ProviderName;
  validate(credentials: Credentials): Promise<void>;
  push(event: WatchEvent, type: MediaType, credentials: Credentials, checkpoint: Checkpoint): Promise<PushResult>;
  pull(credentials: Credentials): Promise<Snapshot>;
}
export type Profile = {
  id: string; name: string; token: string; pullProvider: ProviderName | null;
  pushProviders: ProviderName[]; consent: boolean; created: number;
};
