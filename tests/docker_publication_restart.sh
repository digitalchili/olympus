#!/bin/sh
# Usage: tests/docker_publication_restart.sh LOCAL_CANDIDATE_IMAGE
# Uses compiled production modules; no GitHub access, credentials, or model calls.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
image=${1:?Pass the locally built candidate image as the first argument}
node=/opt/olympus-node/bin/node
sandbox=$(mktemp -d "${TMPDIR:-/tmp}/olympus-publication.XXXXXX")
name="olympus-publication-$(basename "$sandbox" | tr '[:upper:]' '[:lower:]')-$$"
volume="$name-state"
volume_created=0
container_created=0

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ] && [ "$container_created" -eq 1 ]; then docker logs --tail 10 "$name" >&2 || true; fi
  if [ "$container_created" -eq 1 ]; then docker rm -f "$name" >/dev/null; fi
  if [ "$volume_created" -eq 1 ]; then docker volume rm "$volume" >/dev/null; fi
  rm -rf "$sandbox"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v docker >/dev/null
docker info >/dev/null
# Resolve once: never pull, and never follow a mutable tag midway through the test.
image_id=$(docker image inspect "$image" --format '{{.Id}}')
docker volume create "$volume" >/dev/null
volume_created=1
docker run --rm --network none --user 0:0 -v "$volume:/fixture" --entrypoint sh "$image_id" \
  -c 'chown 10000:10000 /fixture'
docker create --name "$name" --network none --no-healthcheck \
  -v "$volume:/fixture" -v "$root/tests/docker_publication_fixture.mjs:/test/publication.mjs:ro" \
  -e HOME=/fixture/home -e HERMES_HOME=/fixture/hermes -e OLYMPUS_DISPATCH_HOME=/fixture/state \
  -e DB_PATH=/fixture/state/data/publication.db --entrypoint "$node" "$image_id" /test/publication.mjs >/dev/null
container_created=1
docker start "$name" >/dev/null

request() {
  docker exec "$name" "$node" -e '
    const [path, state, restarted] = process.argv.slice(1);
    fetch(`http://127.0.0.1:18080/${path}`, {method:path === "retry" ? "POST" : "GET"})
      .then(async response => {
        if (!response.ok) throw Error("Fixture request failed");
        const result = await response.json();
        if (result.state !== state || result.restarted !== (restarted === "true")) throw Error("Unexpected fixture state");
        console.log(JSON.stringify(result));
      }).catch(() => process.exit(1));
  ' "$1" "$2" "$3"
}

wait_pending() {
  attempts=0
  while ! request status pending "$1" > "$sandbox/result.json" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ] || [ "$(docker inspect "$name" --format '{{.State.Running}}')" != true ]; then
      printf 'Publication fixture did not reach the expected pending state.\n' >&2
      return 1
    fi
    sleep 1
  done
  cat "$sandbox/result.json"
}

wait_pending false
# Kill PID 1 with the production SQLite connection still open. The same container
# and volume then start a new process, which may only inspect the saved receipt.
docker kill --signal KILL "$name" >/dev/null
[ "$(docker inspect "$name" --format '{{.State.ExitCode}}')" = 137 ]
docker start "$name" >/dev/null
wait_pending true
# Exercise real production startup/reconciliation against the recovered database,
# still isolated from the network and from every installed Olympus/Hermes volume.
# Leave this child alive until container cleanup; the fixture owns only the retry.
docker exec -d -e HOST=127.0.0.1 -e PORT=6969 "$name" \
  "$node" /opt/olympus-dispatch/dist/server/server/index.js
attempts=0
while ! docker exec "$name" "$node" -e '
  fetch("http://127.0.0.1:6969/api/ready", {signal: AbortSignal.timeout(2000)})
    .then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));
' >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 60 ]; then
    printf 'Production Olympus server did not become ready after publication restart.\n' >&2
    exit 1
  fi
  sleep 1
done
request status pending true
printf 'Production HTTP startup ready; saved publication remains pending with unchanged refs, commits, and versions.\n'
request retry confirmed true
request retry confirmed true
printf 'Docker publication restart passed: exact saved commit, no automatic publication, one push, one version, idempotent explicit retry.\n'
