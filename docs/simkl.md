# SIMKL

The operator supplies `SIMKL_CLIENT_ID` and, for OAuth, `SIMKL_CLIENT_SECRET`. Each profile stores its own user token. Register the exact callback `${PUBLIC_BASE_URL}/oauth/simkl/callback` in your SIMKL application. Existing access tokens are also supported. See [authentication](https://api.simkl.org/authentication) and [OAuth](https://api.simkl.org/api-reference/oauth).

## Push behavior

| AIOStreams event | SIMKL operation |
| --- | --- |
| Start with usable progress | `POST /scrobble/start` |
| Pause with usable progress | `POST /scrobble/pause` |
| Incomplete stop | `POST /scrobble/pause` |
| Completed stop or watched mark | `POST /sync/history` |
| Unwatched mark | `POST /sync/history/remove`, then clear matching resume sessions |

SIMKL's native start transitions into active playback and can remove the paused resume entry. AIOSync retains a useful local resume point for its pull responses; this does not force SIMKL's own paused list to show an active session. Active-session backups expire after 24 hours if no later event replaces them. A successful pause or incomplete stop returns to the provider's saved resume. Progress is updated when AIOStreams sends an event, not by continuously polling the video player.

Incomplete stops use pause intentionally: SIMKL's `/scrobble/stop` can mark content watched at 80%, whereas AIOSync follows AIOStreams' explicit completion decision. Missing position or duration produces a warning rather than a made-up zero position. An explicit watched event remains usable without playback duration.

Bulk marks include only the listed episodes, grouped by season. Unresolved items and partial successes are reported, and checkpoints preserve completed work. SIMKL's movie history removal also removes its list entry; episode removals target the specified episodes.

Sources: [scrobble lifecycle](https://api.simkl.org/guides/scrobble), [history writes](https://api.simkl.org/api-reference/simkl/add-to-history), [history removal](https://api.simkl.org/api-reference/simkl/remove-from-history).

## Pull behavior

The initial pull reads activities and the complete shows, movies, and anime library. Later pulls use activity changes and deltas to update the cache; removal activity triggers reconciliation. Resume sessions are read through `/sync/playback` on each pull. The addon always exposes a complete watched snapshot, not a provider delta.

The provider cache is held in memory and rebuilt after restart. Failed or malformed responses do not replace a valid snapshot with an empty library. Reaching SIMKL's 10,000-session playback limit produces an error instead of publishing potentially truncated data.

`SYNC_INTERVAL_SECONDS` controls AIOSync's background refresh and cache freshness. AIOStreams has its own pull schedule. Push operations are processed independently of this interval.

Sources: [library synchronization](https://api.simkl.org/guides/sync), [playback sessions](https://api.simkl.org/api-reference/simkl/get-playback-sessions).

## Identifiers and limitations

- Supported title IDs include IMDb, TMDB, TVDB, SIMKL, Kitsu, MAL, AniList, and AniDB. Episode coordinates are kept separate from title IDs.
- Native anime numbering is preserved unless a provider mapping gives valid TV episode coordinates. TVDB and TMDB season layouts are not assumed to be interchangeable. See [anime support](https://api.simkl.org/guides/anime).
- Resume data is a percentage. When SIMKL supplies a runtime, AIOSync derives milliseconds; this may be a nominal runtime rather than the video's exact duration. Without a duration, AIOStreams may not import the resume point unless it already knows the video's runtime.
- Counts and next-episode pointers use provider data. Unknown totals are `0`; a next episode is never invented.
- The connector synchronizes watched state, not an exhaustive rewatch session log. Resume retention also depends on SIMKL's account policy.
- Automated tests use simulated responses. Actual OAuth, account access, and playback must be verified in your installation.
