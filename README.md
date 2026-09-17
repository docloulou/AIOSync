# AIOSync

Sync Jellyfin watch history and playback progress with **SIMKL**, **PublicMetaDB** and **MDBList** through the [AIOStreams `feat/jellyfin` branch](https://github.com/Viren070/AIOStreams/tree/feat/jellyfin).

AIOSync implements the [`watch_state` v2 addon resource](https://github.com/Viren070/AIOStreams/blob/feat/jellyfin/packages/docs/content/docs/reference/watch-state-resource.mdx). Install it in AIOStreams alongside your metadata and stream addons. It does not provide streams or track playback directly from a standalone Stremio client.

- Multiple profiles, each with its own accounts and addon URL.
- Push to any combination of SIMKL, PublicMetaDB and MDBList; choose one pull source per profile.
- Start, pause, stop, watched/unwatched events, and bulk episode updates.
- SIMKL OAuth or access tokens; PublicMetaDB and MDBList personal API keys.
- Persistent SQLite queue and snapshots, encrypted provider credentials.
- Shared administration protected by a global API key.

## Quick start

Requires Docker with Compose v2. Clone this repository and generate your configuration:

```bash
git clone https://github.com/docloulou/AIOSync.git
cd AIOSync
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work node:24-bookworm-slim \
  node scripts/generate-env.mjs https://tracker.example.com
```

Use your service's external origin instead of `https://tracker.example.com`, or `http://localhost:7000` for local use. With Node.js 24 installed, you can run `node scripts/generate-env.mjs <origin>` directly. The generator creates random keys and refuses to overwrite an existing `.env`.

Set your provider credentials in `.env`, then build and start:

```bash
docker compose up -d --build
docker compose logs -f tracker
```

Open your configured URL and sign in with `GLOBAL_API_KEY`. Compose builds the local source and stores data in the `tracker-data` volume. Use one instance per database. The host port binds to `127.0.0.1:7000` by default; configure HTTPS through your reverse proxy, or set `HOST_BIND` for your network. A proxy in another container must share a Docker network and connect to `tracker:7000`.

## Configuration

See [`.env.example`](.env.example) for all settings.

| Variable | Purpose |
| --- | --- |
| `GLOBAL_API_KEY` | Shared administration key, at least 32 characters. Generated automatically. |
| `ENCRYPTION_KEY` | Exactly 64 hexadecimal characters. Keep it with your database backup. |
| `PUBLIC_BASE_URL` | External HTTP(S) origin, without a path or query. |
| `SIMKL_CLIENT_ID` | SIMKL application ID, required for SIMKL requests. |
| `SIMKL_CLIENT_SECRET` | SIMKL application secret, required for OAuth. |
| `SIMKL_ACCESS_TOKEN` | Optional default user token, selectable when connecting a profile. |
| `PMDB_API_KEY` | Optional default PublicMetaDB personal API key. |
| `MDBLIST_API_KEY` | Optional default MDBList personal API key. |
| `SYNC_INTERVAL_SECONDS` | Remote snapshot refresh and cache freshness, default `300`, minimum `30`. Does not delay push events; `0` uses the default. |
| `START_EVENT_TTL_SECONDS` | Maximum age of a queued start, default `300` (5 minutes). |
| `JOB_MAX_AGE_SECONDS` | Maximum queue age for undelivered events, default `86400` (24 hours). |
| `HOST_BIND`, `HOST_PORT` | Compose host binding, default `127.0.0.1` and `7000`. |

For SIMKL OAuth, register `https://tracker.example.com/oauth/simkl/callback` as your application's redirect URI, using the same origin as `PUBLIC_BASE_URL`. Each profile connects its own account using the shared application. You can also enter an existing access token.

For PublicMetaDB, create a personal key in **Settings → API**. For MDBList, use [Preferences → API](https://mdblist.com/preferences/#api). Enter the key in each profile, or use the optional server default. Neither provider needs an OAuth client ID or secret.

Create a profile, connect its accounts, select push destinations and one pull source, then enable synchronization consent. Copy the profile's manifest URL into AIOStreams' custom addons. To switch accounts, disconnect the existing provider first; this clears its queued work and local state.

Everyone with the global key can manage all profiles. Addon URLs contain credentials and must be kept confidential. Rotating the global key invalidates admin sessions and all addon URLs; rotating a profile's secret invalidates that profile's URL. Avoid logging `/addon/` URLs in your proxy. Keep `.env` out of version control and retain the original encryption key when restoring a database.

## AIOStreams setup

Set these variables on **AIOStreams**, and keep the addon's **Watch State** resource enabled:

```dotenv
WATCH_STATE_REPORT_ENABLED=true
WATCH_STATE_PULL_ENABLED=true
```

If AIOStreams accesses the addon through an internal address, also set `WATCH_STATE_ALLOW_PRIVATE_URLS=true`. To allow background pulls for inactive configurations, set `WATCH_STATE_PULL_ACTIVE_WITHIN_HOURS=0`.

Your metadata addons must resolve the IDs returned by the tracker. PublicMetaDB uses TMDB IDs; SIMKL may also return IMDb or native anime IDs; MDBList prefers IMDb with TMDB/TVDB fallbacks. Episode numbering is not guessed or converted without a verified mapping.

Compatibility was reviewed against AIOStreams commit [`e3879da`](https://github.com/Viren070/AIOStreams/tree/e3879da60f65c741ada8375559903aa58a51a707). That branch may change. Its own pull schedule determines when imported changes appear in Jellyfin; the manifest's cache TTL does not guarantee an end-to-end refresh deadline.

## Playback behavior

AIOSync preserves the last useful resume point when a start/seek event lacks reliable progress. Valid local resume points remain available through the addon while the provider cannot represent them. Explicit watched/unwatched actions still clear the corresponding resume state.

- **SIMKL:** native scrobbling distinguishes active playback from paused resume sessions. Starting playback can remove the paused entry from SIMKL's own resume list. AIOSync preserves its local resume state, but does not change SIMKL's interface. Incomplete stops use `/scrobble/pause`; completed events use `/sync/history` to respect AIOStreams' completion decision.
- **PublicMetaDB:** resume points are supported from **2% inclusive to 80% exclusive**. Valid starts update the resume point; missing or unsupported progress leaves the previous remote point intact. Other positions are retained locally when usable, so apps reading PublicMetaDB directly may show the older point.
- **MDBList:** native `/scrobble/start`, `/scrobble/pause` and `/scrobble/stop`. Pause and stop automatically mark a title watched at **80%**, so incomplete positions at or above that threshold stay local until AIOStreams confirms completion. Remote playback changes are read on every refresh; history is cached using MDBList activity timestamps. Account API quotas apply.
- Bulk marks affect only the listed episodes. The service synchronizes watched state, not an exact rewatch counter. A failed or incomplete pull never becomes an empty history.

More details: [SIMKL](docs/simkl.md), [PublicMetaDB](docs/pmdb.md), [MDBList](docs/mdblist.md).

Queued starts expire after five minutes, using both their event timestamp and queue age. Other undelivered events, including watched/unwatched marks, expire after 24 hours in the queue. A newer event for the same video also cancels an older queued start. These rules apply to persisted jobs after a restart. **Purge queue** cancels a profile's pending, blocked, failed and running work; **Retry events** cannot revive cancelled work. Cancelled events remain in diagnostics for up to 30 days. Purging does not clear remote playback sessions, and a request already sent may still finish.

## Development and maintenance

Requires Node.js 24. No npm runtime dependencies are needed.

```bash
npm run dev
npm run check
npm test
```

`check` validates native Node syntax, not TypeScript types. Tests use simulated provider APIs; see [validation](docs/validation.md) for coverage and live integration checks.

After updating the source, rebuild with `docker compose up -d --build`. Preserve the data volume and `.env`; `docker compose down -v` deletes the database. Stop the service before copying SQLite data, and retain the matching `ENCRYPTION_KEY` with your backup.

## License

[MIT](LICENSE).
