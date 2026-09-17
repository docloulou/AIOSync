# MDBList

Connect using a personal API key from [MDBList preferences](https://mdblist.com/preferences/#api). Enter it in the profile's MDBList panel, or set `MDBLIST_API_KEY` in `.env` as an optional default. Profiles may use different accounts. A client ID or secret is not required.

Select MDBList as a push destination, a pull source, or both. Only one pull source is used per profile; push destinations can include all three providers. Connecting an account alone does not enable synchronization.

## API mapping

AIOSync uses the authenticated [MDBList API](https://api.mdblist.com/docs/), with requests to `https://api.mdblist.com`:

| Operation | Endpoint / behavior |
| --- | --- |
| Validate key | `GET /user` |
| Start/resume | `POST /scrobble/start` |
| Pause | `POST /scrobble/pause` below 80% |
| Incomplete stop | `POST /scrobble/stop` below 80% |
| Completed stop | Native `/scrobble/stop` at 80% or above; otherwise an explicit watched write |
| Mark watched | `POST /sync/watched`, with the event timestamp |
| Mark unwatched | `POST /sync/watched/remove` |
| Clear a manually marked item's resume | `POST /scrobble/clear`, scoped to that movie or episode |
| Pull progress | `GET /sync/playback` |
| Pull watched history | Paginated `GET /sync/watched` for movies and episodes |
| Next episodes | Paginated `GET /upnext` |
| Detect history changes | `GET /sync/last_activities` |

API keys are sent server-side using MDBList's `apikey` query parameter. Stored credentials are encrypted and are never returned by configuration or diagnostics responses.

## Progress and completion

MDBList's pause **and** stop endpoints automatically mark a title watched at **80%**. If AIOStreams has not confirmed completion, AIOSync keeps positions at or above that threshold locally instead of sending a false completion. The prior remote point remains unchanged. Missing or invalid position/duration also leaves the remote resume intact. Explicit watched/unwatched actions still work normally.

Starting playback uses the native start endpoint. AIOSync also keeps a local backup while playback is active; that backup expires after 24 hours without further events. Paused local fallback points remain until superseded. A newer timestamped remote resume replaces an older local backup, so progress made with another player can be imported on the next refresh. Absolute positions require a known runtime; otherwise MDBList's stored percentage is returned.

Playback percentages accept both numbers and decimal strings such as `"45.00"`, a live format documented by [NuvioTV's MDBList client](https://github.com/Cxsmo-ai/NuvioTV-Custom/blob/10ce149523374d3407d691afe392a7ae3e95b9b3/app/src/main/java/com/nuvio/tv/data/remote/dto/mdblist/MDBListSyncDtos.kt). If `progress` is absent or null, the documented `progress_at_update` can supply the stored point. Zero is preserved; elapsed time is never added. Missing, malformed or out-of-range values preserve the complete previous snapshot and report the row and field without exposing raw account data.

Scrobble confirmations also accept decimal strings, including HTTP 201 with `"progress": "0.00"` for a start. Episode scrobbles use MDBList's canonical nested `show.season.number` / `show.season.episode.number` shape, and seek percentages are rounded to two decimals before sending. A `played: true` flag on a start does not mark the title watched. After updating from a version that rejected these confirmations, use **Retry events** to restart delayed pending or failed jobs. Saved checkpoints and event order are retained. MDBList validation text from JSON error responses is shown in a bounded, redacted form when available. For unplayed writes, AIOSync accepts both the schema's `deleted` confirmation and the live API's equivalent `removed` bucket.

**Purge queue** cancels queued pushes locally; it does not end a session already accepted by MDBList. The paused playback list alone cannot confirm that a "Live now" session has ended. During a live zero-progress test, `/scrobble/clear` returned 404 while playback remained active; an explicit `/scrobble/stop` at zero, followed by `/scrobble/clear`, returned `deleted: true`. This was a targeted cleanup of that test session, not a general reset of account progress.

Manual watched writes retain the event timestamp. Native completed scrobbles use MDBList's server timestamp. Synchronization maintains watched state, not exact rewatch counts. Unwatching clears the current watched status without deleting MDBList's separate play-history records. An already absent resume (`404` on `/scrobble/clear`) is treated as successful cleanup; authentication and server failures remain errors.

## History and limits

Each refresh reads activity timestamps and paused playback. Complete watched history and up-next data are refreshed after history/journal changes, after AIOSync writes watched state, and at least daily. Removal notifications cause a full snapshot refresh. Missing activity markers disable history caching. API quotas depend on the MDBList account; HTTP 429 and `Retry-After` use the existing retry mechanism. Increase `SYNC_INTERVAL_SECONDS` if your plan's quota is too low for your usage.

History pagination follows `next_cursor` without requiring `total` or `limit`. Older responses using `has_more`, offsets or per-media totals (`total_movies` / `total_episodes`) are also supported. A new snapshot is published only after a completion signal; a short page alone is not sufficient. Errors, repeated cursors, conflicting signals or inconsistent totals preserve the last complete state. Episode parent IDs may be in `show.ids` or `episode.show.ids`; episode IDs are never treated as show IDs. Bulk operations are split into exact episodes with independent checkpoints; unrelated episodes and ratings are left intact. Absolute anime numbering requires a verified TV mapping and is otherwise rejected.

Next-up entries use MDBList's explicit next episode. Totals are reported only when provided; unknown totals remain `0`. IMDb is preferred for returned items, followed by TMDB, TVDB, Trakt and MDBList IDs. Your metadata addons must resolve the identifiers used by your account.

The eleven HTTP operations across the ten endpoint paths above were reviewed against the MDBList OpenAPI 1.0.0 schema on 2026-09-16. That schema does not declare required response fields and leaves episode/up-next item structures generic, so schema review alone cannot prove live compatibility. Cursor responses without totals and nested parent-show IDs are also represented in [AIO Metadata's MDBList client](https://github.com/cedya77/aiometadata/blob/6fc867a043295bc61a419d2986c296fc8a71f754/addon/utils/mdbList.ts). Absent-session cleanup handling is corroborated by [Scrob's client](https://github.com/ellite/scrob/blob/3d75f172fc054ed90c39af9d336d5f5feda40d54/backend/core/mdblist.py).

The adapter is tested against simulated responses covering these formats, later-page failures and snapshot recovery. See [validation](validation.md) for checks with a real account.
