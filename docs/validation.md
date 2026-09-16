# Validation

With Node.js 24, run:

```bash
npm run check
npm test
```

The suite covers HTTP authentication, OAuth state, profile isolation, credential encryption, durable queue checkpoints, retries, provider responses, pagination, watched-state versions, and resume handling. Provider APIs are simulated. SQLite persistence tests use a real temporary database on disk. MDBList regressions cover cursor pages without totals, legacy per-media totals, nested episode parents, missing activity markers, absent-session cleanup, numeric and decimal-string progress, the optional `progress_at_update` fallback, and preservation of the complete SQLite snapshot when a later page or playback entry fails.

`npm run check` checks the syntax executed by Node. It does not perform static TypeScript type checking.

GitHub Actions also builds the production container and runs `scripts/docker-smoke.sh`, checking startup, the non-root user, SQLite storage, health, static assets, and rejected unauthenticated administration requests. Test results are reported by the workflow for each revision; they do not validate your provider accounts.

## Live integration checks

Automated tests do not establish that an actual SIMKL/PMDB/MDBList account, OAuth application, Jellyfin client, or AIOStreams deployment works. After configuring your instance:

1. Connect each provider and check the first pull in the profile diagnostics.
2. Start a video, seek forward and backward, pause, resume, and stop before completion. Check the received events and their positions.
3. Check the resume state after the next pull, including restarting playback without a reliable position. SIMKL's active session and paused resume list are distinct; PublicMetaDB cannot store every percentage, and MDBList pause/stop auto-completes at 80%. Check MDBList at 79%, 80% and explicit completion, then pause in an external player and verify that the newer remote position is imported.
4. Mark an item watched, then unwatched; confirm the intended item changes and unrelated episodes remain intact.
5. Restart AIOSync and confirm that profiles and pending events survive.

Use a test profile for these checks: watched/unwatched operations change the connected account's real history. Compatibility was reviewed against AIOStreams commit `e3879da60f65c741ada8375559903aa58a51a707`; later branch changes may require an update.
