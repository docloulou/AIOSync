# PublicMetaDB

PublicMetaDB uses a personal API key from **Settings → API**, sent as `Authorization: Bearer …`. It does not require OAuth application credentials. See the [official API documentation](https://publicmetadb.com/api-docs).

## Endpoints

| Operation | Endpoint |
| --- | --- |
| Pull watched history | `GET /api/external/watched?page=N&perPage=500` |
| Pull resume points | `GET /api/external/resume?page=N&perPage=500` |
| Mark watched | `POST /api/external/watched?dedupe=true` |
| Mark unwatched | `DELETE /api/external/watched`, filtered to the exact video |
| Save a resume point | `POST /api/external/resume` |
| Clear a resume point | `DELETE /api/external/resume/:id` |
| Resolve an IMDb ID | `GET /api/external/mappings/lookup` |

These are watched/resume APIs, not a separate native scrobble session API. Bulk marks are split into individual videos. Calls share an instance-wide rate budget; retries respect rate-limit responses, and completed sub-operations have durable checkpoints.

## Resume protection

Start, pause, and incomplete stop events save progress only when position and duration are valid and progress is **at least 2% and below 80%**. A start event no longer deletes the last saved point. Missing, invalid, or unsupported progress leaves the remote point unchanged. Valid positions that PMDB cannot represent are retained in AIOSync's local state for its pull responses.

PublicMetaDB ignores progress below 2% and removes resume entries at 80% or above. AIOSync does not send those values to the resume endpoint or infer completion from them. Explicit watched events, completed stops, and unwatched events still clear the corresponding resume entries.

The local state is visible through AIOSync, not through other applications querying PublicMetaDB directly. Those applications may retain the older remote position. Resume timestamps are assigned by PublicMetaDB; history writes use the event's timestamp.

## History and identifiers

- All pages must validate before a pull is committed. Incomplete, malformed, duplicated, or changing pagination causes an error instead of exposing partial history.
- Unwatched marks delete all watches of the specified video, preserving other episodes. `dedupe=true` avoids duplicate watched entries, but does not promise a complete rewatch counter.
- Output uses TMDB IDs. IMDb mapping is filtered by media type; missing or ambiguous results are reported instead of guessed.
- Absolute anime numbering is not converted into TMDB seasons without a verified mapping. Unsupported identities remain visible in diagnostics.
- Episode counts include unique watched episodes. Unknown totals are `0`; `nextUp` is empty because this API provides no reliable next-episode pointer.

Automated tests use simulated responses. Real account authentication and writes require validation on your installation.
