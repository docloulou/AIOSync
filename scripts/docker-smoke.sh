#!/usr/bin/env bash
set -euo pipefail

image="${1:-aiosync:smoke}"
container="aiosync-smoke-${RANDOM}-${RANDOM}"
temp_dir="$(mktemp -d)"
cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

umask 077
node --input-type=module > "$temp_dir/runtime.env" <<'NODE'
import { randomBytes } from 'node:crypto';
process.stdout.write(`GLOBAL_API_KEY=${randomBytes(32).toString('hex')}\n`);
process.stdout.write(`ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`);
process.stdout.write('PUBLIC_BASE_URL=http://localhost:7000\n');
NODE

# No ports are published, no real credentials are passed, no external account is used.
docker run --detach --name "$container" --env-file "$temp_dir/runtime.env" "$image" >/dev/null

ready=false
for attempt in {1..30}; do
  if docker exec "$container" node -e "fetch('http://127.0.0.1:7000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    ready=true
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
    break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  docker logs "$container"
  exit 1
fi

docker exec --interactive "$container" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { existsSync, accessSync, constants } from 'node:fs';
assert.notEqual(process.getuid(), 0, 'The container must run as a non-root user');
assert.ok(existsSync('/app/data/tracker.sqlite'), 'SQLite database was not created');
accessSync('/app/data/tracker.sqlite', constants.W_OK);
for (const path of ['/', '/app.js', '/style.css', '/healthz', '/manifest.json']) {
  const response = await fetch(`http://127.0.0.1:7000${path}`);
  assert.equal(response.status, 200, path);
}
const denied = await fetch('http://127.0.0.1:7000/api/profiles');
assert.equal(denied.status, 401, 'Admin API must require authentication');
const manifest = await (await fetch('http://127.0.0.1:7000/manifest.json')).json();
assert.equal(manifest.behaviorHints.configurationRequired, true);
console.log('Container smoke test passed: startup, non-root, writable SQLite, assets and auth.');
NODE
