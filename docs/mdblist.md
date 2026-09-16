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

Manual watched writes retain the event timestamp. Native completed scrobbles use MDBList's server timestamp. Synchronization maintains watched state, not exact rewatch counts. Unwatching clears the current watched status without deleting MDBList's separate play-history records.

## History and limits

Each refresh reads activity timestamps and paused playback. Complete watched history and up-next data are refreshed after history/journal changes, after AIOSync writes watched state, and at least daily. Removal notifications cause a full snapshot refresh. Missing activity markers disable history caching. API quotas depend on the MDBList account; HTTP 429 and `Retry-After` use the existing retry mechanism. Increase `SYNC_INTERVAL_SECONDS` if your plan's quota is too low for your usage.

History pagination must complete before a new snapshot is published. Errors, repeated cursors, or inconsistent totals preserve the last complete state. MDBList episode IDs are never treated as show IDs. Bulk operations are split into exact episodes with independent checkpoints; unrelated episodes and ratings are left intact. Absolute anime numbering requires a verified TV mapping and is otherwise rejected.

Next-up entries use MDBList's explicit next episode. Totals are reported only when provided; unknown totals remain `0`. IMDb is preferred for returned items, followed by TMDB, TVDB, Trakt and MDBList IDs. Your metadata addons must resolve the identifiers used by your account.

The adapter is tested against simulated responses based on the public API schema. See [validation](validation.md) for checks with a real account.
