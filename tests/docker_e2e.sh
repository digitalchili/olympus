#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
port=${OLYMPUS_E2E_PORT:-16969}
suffix="$$"
project="olympus-e2e-$suffix"
hermes_volume="$project-hermes"
state_volume="$project-state"
restore_volume="$project-restored-state"
restore_container="$project-restored"
# Keep a real released baseline so this exercises schema/runtime upgrades too.
# v0.7.18 multi-platform manifest, deliberately independent of the checkout.
image_v1=${OLYMPUS_E2E_IMAGE_V1:-ghcr.io/digitalchili/olympus:0.7.18@sha256:2ac9aafcced1be576acdb650342508e1469285370173094b3d664b679e2bd954}
image_v2=${OLYMPUS_E2E_IMAGE_V2:-olympus-dispatch:e2e-candidate-$suffix}
version_v1=${OLYMPUS_E2E_VERSION_V1:-0.7.18}
version_v2=$(node -p 'require(process.argv[1]).version' "$root/package.json")
sandbox=$(mktemp -d "${TMPDIR:-/tmp}/olympus-e2e.XXXXXX")

cleanup() {
  status=$?
  if [ "${KEEP_OLYMPUS_E2E:-0}" != 1 ]; then
    (cd "$sandbox" && COMPOSE_PROJECT_NAME="$project" docker compose -f docker-compose.ha.yml --profile blue --profile green down --remove-orphans >/dev/null 2>&1) || true
    docker rm -f "$restore_container" >/dev/null 2>&1 || true
    docker volume rm "$state_volume" "$hermes_volume" "$restore_volume" >/dev/null 2>&1 || true
    rm -rf "$sandbox"
  else
    printf 'Retained E2E sandbox: %s\n' "$sandbox" >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

for command in docker curl openssl node; do command -v "$command" >/dev/null 2>&1 || { printf 'Required command not found: %s\n' "$command" >&2; exit 1; }; done

assert_bot_persisted() {
  curl --fail --silent -X POST "http://127.0.0.1:$port/api/bots/session?profile=default" | node -e \
    'const b=JSON.parse(require("fs").readFileSync(0,"utf8")); if(b.task?.id!==process.argv[1]||b.task.kind!=="bot")process.exit(1)' "$bot_id"
  curl --fail --silent "http://127.0.0.1:$port/api/tasks?profile=default" | node -e \
    'const b=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!Array.isArray(b.tasks)||b.tasks.some(t=>t.id===process.argv[1]||t.kind==="bot"))process.exit(1)' "$bot_id"
}

assert_version() {
  curl --fail --silent "http://127.0.0.1:$port/api/version" | node -e \
    'const b=JSON.parse(require("fs").readFileSync(0,"utf8")); if(b.version!==process.argv[1])process.exit(1)' "$1"
}

hermes_fixture() {
  docker exec -i -w /opt/hermes "$1" /opt/hermes/.venv/bin/python - "$2" < "$root/tests/docker_persistence_fixture.py"
  curl --fail --silent "http://127.0.0.1:$port/api/profiles" | node -e \
    'const b=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!b.profiles?.some(p=>p.id==="e2e-reviewer"&&p.health.status==="ready"))process.exit(1)'
}

docker info >/dev/null
docker pull "$image_v1" >/dev/null
if [ "${OLYMPUS_E2E_SKIP_BUILD:-0}" != 1 ]; then
  docker build --build-arg VERSION="$version_v2" --build-arg REVISION=e2e-candidate -t "$image_v2" "$root" >/dev/null
fi
baseline_id=$(docker image inspect "$image_v1" --format '{{.Id}}')
candidate_id=$(docker image inspect "$image_v2" --format '{{.Id}}')
[ "$baseline_id" != "$candidate_id" ] || { printf 'Upgrade baseline and candidate must be different images.\n' >&2; exit 1; }

sh "$root/tests/docker_worker_acceptance.sh" "$image_v2"
sh "$root/tests/docker_publication_restart.sh" "$image_v2"

cp "$root/docker-compose.ha.yml" "$sandbox/"
cp -R "$root/scripts" "$root/deploy" "$sandbox/"
mkdir -p "$sandbox/backups"
docker volume create "$hermes_volume" >/dev/null
docker volume create "$state_volume" >/dev/null
docker run --rm --network none --user 0:0 -v "$hermes_volume:/opt/data" --entrypoint sh "$image_v1" \
  -c 'mkdir -p /opt/data/home /opt/data/profiles/default && chown -R 10000:10000 /opt/data'

cat > "$sandbox/.env" <<EOF
HERMES_DATA_VOLUME=$hermes_volume
OLYMPUS_DISPATCH_STATE_VOLUME=$state_volume
OLYMPUS_MAINTENANCE_TOKEN=e2e-maintenance-token
OLYMPUS_DISPATCH_BIND_ADDRESS=127.0.0.1
OLYMPUS_DISPATCH_PORT=$port
EOF
chmod 600 "$sandbox/.env"

cd "$sandbox"
export COMPOSE_PROJECT_NAME="$project" BACKUP_DIR="$sandbox/backups"

./scripts/docker/install.sh --dry-run --yes --hermes-volume "$hermes_volume" --image "$image_v1"
./scripts/docker/install.sh --yes --hermes-volume "$hermes_volume" --image "$image_v1"
assert_version "$version_v1"
curl --fail --silent "http://127.0.0.1:$port/api/health" >/dev/null
curl --fail --silent -X POST -H 'Content-Type: application/json' \
  -d '{"title":"E2E persistence sentinel","description":"Prove the live database and verified backup contain operator data."}' \
  "http://127.0.0.1:$port/api/tasks" >/dev/null
bot_id=$(curl --fail --silent -X POST "http://127.0.0.1:$port/api/bots/session?profile=default" | node -e \
  'const b=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!b.task?.id||b.task.kind!=="bot")process.exit(1); process.stdout.write(b.task.id)')
assert_bot_persisted
blue_id=$(docker compose -f docker-compose.ha.yml ps -q olympus-blue)
[ "$(docker inspect "$blue_id" --format '{{.Image}}')" = "$baseline_id" ]
hermes_fixture "$blue_id" seed
docker run --rm --network none -v "$state_volume:/state:ro" --entrypoint sh "$image_v1" -c 'test -f /state/data/olympus-dispatch.db'
docker run --rm --network none -v "$hermes_volume:/hermes:ro" --entrypoint sh "$image_v1" -c 'test ! -e /hermes/home/.olympus-dispatch/data/olympus-dispatch.db'

curl --fail --silent -X POST -H 'Authorization: Bearer e2e-maintenance-token' "http://127.0.0.1:$port/api/maintenance/drain" >/dev/null
[ "$(curl --silent -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/ready")" = 503 ]
[ "$(curl --silent -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$port/api/tasks")" = 503 ]
curl --fail --silent -X POST -H 'Authorization: Bearer e2e-maintenance-token' "http://127.0.0.1:$port/api/maintenance/cancel" >/dev/null
curl --fail --silent "http://127.0.0.1:$port/api/ready" >/dev/null

./scripts/docker/update.sh --dry-run --image "$image_v2"
./scripts/docker/update.sh --yes --image "$image_v2"
[ "$(cat .olympus-active-slot)" = green ]
green_id=$(docker compose -f docker-compose.ha.yml ps -q olympus-green)
[ "$(docker inspect "$green_id" --format '{{.Image}}')" = "$candidate_id" ]
assert_version "$version_v2"
hermes_fixture "$green_id" verify
curl --fail --silent "http://127.0.0.1:$port/api/ready" >/dev/null
assert_bot_persisted
[ -n "$(find backups -name '*.integrity' -print -quit)" ]
[ "$(cat "$(find backups -name '*.integrity' -print -quit)")" = ok ]
backup_file=$(find backups -name '*.sqlite' -print -quit)
docker run --rm --network none -v "$sandbox/backups:/backups:ro" --entrypoint sh "$image_v2" \
  -c 'if [ -x /opt/olympus-node/bin/node ]; then exec /opt/olympus-node/bin/node "$@"; else exec node "$@"; fi' olympus-node -e \
  'const Database=require("better-sqlite3"); const db=new Database(process.argv[1],{readonly:true}); const row=db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = ?").get("E2E persistence sentinel"); const bot=db.prepare("SELECT kind FROM tasks WHERE id = ?").get(process.argv[2]); if(row.n !== 1||bot?.kind!=="bot") process.exit(1); db.close()' \
  "/backups/$(basename "$backup_file")" "$bot_id"

# Force a valid Nginx reload to an unreachable candidate and prove recovery.
cp deploy/nginx/active-blue.conf deploy/nginx/active-blue.conf.good
printf 'upstream olympus_active { server olympus-blue:9; keepalive 16; }\n' > deploy/nginx/active-blue.conf
if ./scripts/docker/update.sh --yes --image "$image_v2" > "$sandbox/failed-promotion.log" 2>&1; then
  cat "$sandbox/failed-promotion.log"
  printf 'Expected forced proxy verification failure.\n' >&2
  exit 1
fi
cat "$sandbox/failed-promotion.log"
grep -Fq 'Proxy readiness failed after switch.' "$sandbox/failed-promotion.log" || {
  printf 'Update failed before the intended proxy verification; recovery scenario not proven.\n' >&2
  exit 1
}
mv deploy/nginx/active-blue.conf.good deploy/nginx/active-blue.conf
[ "$(cat .olympus-active-slot)" = green ]
# Nginx reload is asynchronous; wait for the restored proxy route just as the
# updater waits for a promoted route, rather than sampling an old worker once.
curl --retry 10 --retry-delay 1 --retry-connrefused --fail --silent --show-error "http://127.0.0.1:$port/api/ready" >/dev/null
[ -z "$(docker compose -f docker-compose.ha.yml ps -q olympus-blue)" ]

./scripts/docker/rollback.sh --yes
[ "$(cat .olympus-active-slot)" = blue ]
blue_id=$(docker compose -f docker-compose.ha.yml ps -q olympus-blue)
[ "$(docker inspect "$blue_id" --format '{{.Image}}')" = "$baseline_id" ]
assert_version "$version_v1"
assert_bot_persisted
hermes_fixture "$blue_id" verify
curl --fail --silent "http://127.0.0.1:$port/api/ready" >/dev/null

./scripts/docker/backup.sh --yes
[ -n "$(find backups -name '*.sqlite' -print -quit)" ]
[ -n "$(find backups -name '*-state.tgz' -print -quit)" ]

# Restore a matching archive/database pair into a fresh volume and boot it.
# The active installation and its Hermes state are never used by this container.
backup_file=$(find backups -name '*.sqlite' -print | sort | tail -1)
backup_stem=$(basename "$backup_file" .sqlite)
docker volume create "$restore_volume" >/dev/null
docker run --rm --network none --user 0:0 -v "$restore_volume:/restore" \
  -v "$sandbox/backups:/backups:ro" -e BACKUP_STEM="$backup_stem" --entrypoint sh "$image_v1" \
  -c 'cd /restore && tar -xzf "/backups/$BACKUP_STEM-state.tgz" && mkdir -p data && cp "/backups/$BACKUP_STEM.sqlite" data/olympus-dispatch.db && chown -R 10000:10000 /restore'
docker run -d --name "$restore_container" --network none \
  --tmpfs /opt/data:uid=10000,gid=10000,mode=700 \
  -e HOME=/opt/data/home -e HERMES_HOME=/opt/data \
  -e HERMES_DISABLE_LAZY_INSTALLS=1 -e HERMES_WRITE_SAFE_ROOT=/opt/data \
  -e OLYMPUS_DISPATCH_HOME=/opt/data/olympus-dispatch \
  -e DB_PATH=/opt/data/olympus-dispatch/data/olympus-dispatch.db \
  -v "$restore_volume:/opt/data/olympus-dispatch" "$image_v1" >/dev/null
restore_ready=0
for attempt in $(seq 1 60); do
  if docker exec "$restore_container" /opt/olympus-node/bin/node -e \
    'fetch("http://127.0.0.1:6969/api/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
    restore_ready=1; break
  fi
  sleep 1
done
[ "$restore_ready" = 1 ] || { printf 'Restored server did not become ready.\n' >&2; exit 1; }
docker exec "$restore_container" /opt/olympus-node/bin/node -e \
  '(async()=>{const r=await fetch("http://127.0.0.1:6969/api/tasks"); if(!r.ok)throw Error("Restored board unavailable"); const b=await r.json(); if(!b.tasks.some(t=>t.title==="E2E persistence sentinel")||b.tasks.some(t=>t.kind==="bot"||t.id===process.argv[1]))throw Error("Restored board contents changed"); const opened=await fetch("http://127.0.0.1:6969/api/bots/session?profile=default",{method:"POST"}); if(!opened.ok)throw Error("Restored Bot unavailable"); const bot=(await opened.json()).task; if(bot?.id!==process.argv[1]||bot.kind!=="bot")throw Error("Restored canonical Bot changed")})().catch(e=>{console.error(e);process.exit(1)})' "$bot_id"

printf 'Docker E2E passed: released %s to candidate %s; Hermes profile, session and synthetic credential preservation; task/Bot persistence; drain; verified backup/restore; failed-promotion recovery; rollback to the released image.\n' "$version_v1" "$version_v2"
