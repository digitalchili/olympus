#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
port=${OLYMPUS_E2E_PORT:-16969}
suffix="$$"
project="olympus-e2e-$suffix"
hermes_volume="$project-hermes"
state_volume="$project-state"
image_v1=${OLYMPUS_E2E_IMAGE_V1:-olympus-dispatch:e2e-v1}
image_v2=${OLYMPUS_E2E_IMAGE_V2:-olympus-dispatch:e2e-v2}
sandbox=$(mktemp -d "${TMPDIR:-/tmp}/olympus-e2e.XXXXXX")

cleanup() {
  status=$?
  if [ "${KEEP_OLYMPUS_E2E:-0}" != 1 ]; then
    (cd "$sandbox" && COMPOSE_PROJECT_NAME="$project" docker compose -f docker-compose.ha.yml --profile blue --profile green down --remove-orphans >/dev/null 2>&1) || true
    docker volume rm "$state_volume" "$hermes_volume" >/dev/null 2>&1 || true
    rm -rf "$sandbox"
  else
    printf 'Retained E2E sandbox: %s\n' "$sandbox" >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

for command in docker curl openssl; do command -v "$command" >/dev/null 2>&1 || { printf 'Required command not found: %s\n' "$command" >&2; exit 1; }; done

docker info >/dev/null
if [ "${OLYMPUS_E2E_SKIP_BUILD:-0}" != 1 ]; then
  docker build --build-arg VERSION=0.3.0-e2e1 --build-arg REVISION=e2e1 -t "$image_v1" "$root" >/dev/null
  docker build --build-arg VERSION=0.3.0-e2e2 --build-arg REVISION=e2e2 -t "$image_v2" "$root" >/dev/null
fi

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

./scripts/docker/install.sh --yes --hermes-volume "$hermes_volume" --image "$image_v1"
curl --fail --silent "http://127.0.0.1:$port/api/health" >/dev/null
curl --fail --silent -X POST -H 'Content-Type: application/json' \
  -d '{"title":"E2E persistence sentinel","description":"Prove the live database and verified backup contain operator data."}' \
  "http://127.0.0.1:$port/api/tasks" >/dev/null
blue_id=$(docker compose -f docker-compose.ha.yml ps -q olympus-blue)
[ "$(docker inspect "$blue_id" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')" = 0.3.0-e2e1 ]
docker run --rm --network none -v "$state_volume:/state:ro" --entrypoint sh "$image_v1" -c 'test -f /state/data/olympus-dispatch.db'
docker run --rm --network none -v "$hermes_volume:/hermes:ro" --entrypoint sh "$image_v1" -c 'test ! -e /hermes/home/.olympus-dispatch/data/olympus-dispatch.db'

curl --fail --silent -X POST -H 'Authorization: Bearer e2e-maintenance-token' "http://127.0.0.1:$port/api/maintenance/drain" >/dev/null
[ "$(curl --silent -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/ready")" = 503 ]
[ "$(curl --silent -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$port/api/tasks")" = 503 ]
curl --fail --silent -X POST -H 'Authorization: Bearer e2e-maintenance-token' "http://127.0.0.1:$port/api/maintenance/cancel" >/dev/null
curl --fail --silent "http://127.0.0.1:$port/api/ready" >/dev/null

./scripts/docker/update.sh --yes --image "$image_v2"
[ "$(cat .olympus-active-slot)" = green ]
green_id=$(docker compose -f docker-compose.ha.yml ps -q olympus-green)
[ "$(docker inspect "$green_id" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')" = 0.3.0-e2e2 ]
curl --fail --silent "http://127.0.0.1:$port/api/ready" >/dev/null
[ -n "$(find backups -name '*.integrity' -print -quit)" ]
[ "$(cat "$(find backups -name '*.integrity' -print -quit)")" = ok ]
backup_file=$(find backups -name '*.sqlite' -print -quit)
docker run --rm --network none -v "$sandbox/backups:/backups:ro" --entrypoint node "$image_v2" -e \
  'const Database=require("better-sqlite3"); const db=new Database(process.argv[1],{readonly:true}); const row=db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = ?").get("E2E persistence sentinel"); if(row.n !== 1) process.exit(1)' \
  "/backups/$(basename "$backup_file")"

# Force a valid Nginx reload to an unreachable candidate and prove recovery.
cp deploy/nginx/active-blue.conf deploy/nginx/active-blue.conf.good
printf 'upstream olympus_active { server olympus-blue:9; keepalive 16; }\n' > deploy/nginx/active-blue.conf
if ./scripts/docker/update.sh --yes --image "$image_v2"; then
  printf 'Expected forced proxy verification failure.\n' >&2
  exit 1
fi
mv deploy/nginx/active-blue.conf.good deploy/nginx/active-blue.conf
[ "$(cat .olympus-active-slot)" = green ]
curl --fail --silent "http://127.0.0.1:$port/api/ready" >/dev/null
[ -z "$(docker compose -f docker-compose.ha.yml ps -q olympus-blue)" ]

./scripts/docker/rollback.sh --yes
[ "$(cat .olympus-active-slot)" = blue ]
blue_id=$(docker compose -f docker-compose.ha.yml ps -q olympus-blue)
[ "$(docker inspect "$blue_id" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')" = 0.3.0-e2e1 ]
curl --fail --silent "http://127.0.0.1:$port/api/ready" >/dev/null

./scripts/docker/backup.sh --yes
[ -n "$(find backups -name '*.sqlite' -print -quit)" ]
[ -n "$(find backups -name '*-state.tgz' -print -quit)" ]

printf 'Docker E2E passed: fresh install, drain guard, verified backup, promotion, failed-promotion recovery, and immutable rollback.\n'
