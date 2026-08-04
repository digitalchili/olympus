#!/bin/sh
set -eu

# Single-service Docker Compose updater used by update_runner.py. It pulls a
# versioned release image, drains active work, takes a consistent SQLite backup,
# recreates exactly one configured service, and restores the old image on error.

version=
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) shift; version=${1:-} ;;
    --dry-run) DRY_RUN=1 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || {
  printf 'A semantic --version is required.\n' >&2
  exit 2
}

COMPOSE_DIR=${OLYMPUS_UPDATER_COMPOSE_DIR:?set OLYMPUS_UPDATER_COMPOSE_DIR}
COMPOSE_FILE=${OLYMPUS_UPDATER_COMPOSE_FILE:-docker-compose.yml}
COMPOSE_PROJECT=${OLYMPUS_UPDATER_COMPOSE_PROJECT:?set OLYMPUS_UPDATER_COMPOSE_PROJECT}
SERVICE=${OLYMPUS_UPDATER_SERVICE:-olympus-dispatch}
ENV_FILE=${OLYMPUS_UPDATER_ENV_FILE:-$COMPOSE_DIR/.env}
IMAGE_REPOSITORY=${OLYMPUS_UPDATER_IMAGE_REPOSITORY:-ghcr.io/digitalchili/olympus}
IMAGE_SOURCE=${OLYMPUS_UPDATER_IMAGE_SOURCE:-https://github.com/digitalchili/olympus}
GHCR_USERNAME=${OLYMPUS_UPDATER_GHCR_USERNAME:-}
GHCR_TOKEN=${OLYMPUS_UPDATER_GHCR_TOKEN:-}
BACKUP_DIR=${OLYMPUS_UPDATER_BACKUP_DIR:-/var/lib/olympus-dispatch-updater/backups}
LOCK_DIR=${OLYMPUS_UPDATER_LOCK_DIR:-/run/olympus-dispatch-updater/operation.lock}
READY_ATTEMPTS=${OLYMPUS_UPDATER_READY_ATTEMPTS:-60}
DRAIN_ATTEMPTS=${OLYMPUS_UPDATER_DRAIN_ATTEMPTS:-120}
image="$IMAGE_REPOSITORY:$version"

for command in docker grep awk cp mv mkdir rm chmod date; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Required command not found: %s\n' "$command" >&2; exit 1; }
done
[ -d "$COMPOSE_DIR" ] || { printf 'Compose directory not found: %s\n' "$COMPOSE_DIR" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { printf 'Compose environment file not found: %s\n' "$ENV_FILE" >&2; exit 1; }

if [ "$DRY_RUN" = 1 ]; then
  printf 'dry-run: project=%s service=%s compose=%s image=%s\n' "$COMPOSE_PROJECT" "$SERVICE" "$COMPOSE_FILE" "$image"
  printf 'dry-run: pull and verify OCI labels; drain; SQLite backup; recreate one service; verify readiness; recover old image on failure\n'
  exit 0
fi

cd "$COMPOSE_DIR"
compose() { docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

if [ -n "$GHCR_TOKEN" ]; then
  [ -n "$GHCR_USERNAME" ] || { printf 'OLYMPUS_UPDATER_GHCR_USERNAME is required when a GHCR token is set.\n' >&2; exit 2; }
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin >/dev/null
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf 'Another standalone Olympus update is already running.\n' >&2
  exit 1
fi
lock_owned=1
env_backup=
env_changed=0
current_container=

maintenance() {
  container=$1 method=$2 endpoint=$3
  docker exec "$container" node -e '
    const token = process.env.OLYMPUS_MAINTENANCE_TOKEN;
    if (!token) process.exit(2);
    fetch(`http://127.0.0.1:6969/api/maintenance/${process.argv[2]}`, {
      method: process.argv[1],
      headers: { Authorization: `Bearer ${token}` },
    }).then(async (response) => {
      process.stdout.write(await response.text());
      process.exit(response.ok ? 0 : 1);
    }).catch(() => process.exit(1));
  ' "$method" "$endpoint"
}

wait_ready() {
  container=$1 i=0
  while [ "$i" -lt "$READY_ATTEMPTS" ]; do
    if docker exec "$container" node -e "fetch('http://127.0.0.1:6969/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1)); sleep 2
  done
  return 1
}

recover() {
  status=$?
  trap - EXIT INT TERM
  if [ "$env_changed" = 1 ] && [ -n "$env_backup" ] && [ -f "$env_backup" ]; then
    cp "$env_backup" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    if compose up -d --no-deps --no-build "$SERVICE" >/dev/null 2>&1; then
      restored=$(compose ps -q "$SERVICE" 2>/dev/null || true)
      [ -z "$restored" ] || wait_ready "$restored" || printf 'CRITICAL: old Olympus image was restored but readiness failed.\n' >&2
    else
      printf 'CRITICAL: automatic restoration of the old Olympus image failed.\n' >&2
    fi
  elif [ -n "$current_container" ]; then
    maintenance "$current_container" POST cancel >/dev/null 2>&1 || true
  fi
  [ -z "$env_backup" ] || rm -f "$env_backup"
  [ "$lock_owned" = 0 ] || rm -rf "$LOCK_DIR"
  exit "$status"
}
trap recover EXIT INT TERM

docker pull "$image"
requested_id=$(docker image inspect "$image" --format '{{.Id}}')
label_version=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
label_source=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')
[ "$label_version" = "$version" ] || { printf 'Candidate image version label is %s, expected %s.\n' "$label_version" "$version" >&2; exit 1; }
[ "$label_source" = "$IMAGE_SOURCE" ] || { printf 'Candidate image source label is unexpected: %s\n' "$label_source" >&2; exit 1; }

current_container=$(compose ps -q "$SERVICE")
[ -n "$current_container" ] || { printf 'Configured service is not running: %s\n' "$SERVICE" >&2; exit 1; }
old_image=$(docker inspect "$current_container" --format '{{.Config.Image}}')
printf 'Updating %s/%s from %s to %s\n' "$COMPOSE_PROJECT" "$SERVICE" "$old_image" "$image"

maintenance "$current_container" POST drain >/dev/null
i=0
while [ "$i" -lt "$DRAIN_ATTEMPTS" ]; do
  status=$(maintenance "$current_container" GET status)
  printf '%s' "$status" | grep -Eq '"activeRuns"[[:space:]]*:[[:space:]]*0' && break
  i=$((i + 1)); sleep 1
done
[ "$i" -lt "$DRAIN_ATTEMPTS" ] || { printf 'Drain timed out; update cancelled.\n' >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_name="olympus-dispatch-before-$version-$stamp.db"
container_backup="/opt/data/olympus-dispatch/data/.$backup_name"
host_backup_tmp="$BACKUP_DIR/.$backup_name.tmp.$$"
host_backup="$BACKUP_DIR/$backup_name"
docker exec -i "$current_container" node - "$container_backup" <<'NODE'
const Database = require("better-sqlite3");
const destination = process.argv[2];
const path = process.env.DB_PATH || "/opt/data/olympus-dispatch/data/olympus-dispatch.db";
const db = new Database(path, { readonly: true });
db.backup(destination).then(() => {
  db.close();
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
backup_ready=0
for backup_attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "$current_container" test -s "$container_backup"; then
    backup_ready=1
    break
  fi
  sleep 1
done
[ "$backup_ready" = 1 ] || { printf 'SQLite backup was not written in time.\n' >&2; exit 1; }
docker cp "$current_container:$container_backup" "$host_backup_tmp"
docker exec "$current_container" rm -f "$container_backup"
[ -s "$host_backup_tmp" ] || { printf 'SQLite backup is empty.\n' >&2; exit 1; }
chmod 600 "$host_backup_tmp"
mv "$host_backup_tmp" "$host_backup"
printf 'Verified non-empty SQLite backup: %s\n' "$host_backup"

env_backup="$ENV_FILE.before-update.$$"
cp "$ENV_FILE" "$env_backup"
chmod 600 "$env_backup"
tmp="$ENV_FILE.tmp.$$"
awk -F= -v value="$image" '
  BEGIN { found=0 }
  $1 == "OLYMPUS_DISPATCH_IMAGE" { print "OLYMPUS_DISPATCH_IMAGE=" value; found=1; next }
  { print }
  END { if (!found) print "OLYMPUS_DISPATCH_IMAGE=" value }
' "$ENV_FILE" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"
env_changed=1

compose up -d --no-deps --no-build "$SERVICE"
candidate_container=$(compose ps -q "$SERVICE")
[ -n "$candidate_container" ] || { printf 'Candidate service did not start.\n' >&2; exit 1; }
candidate_id=$(docker inspect "$candidate_container" --format '{{.Image}}')
[ "$candidate_id" = "$requested_id" ] || { printf 'Compose started image %s instead of requested %s.\n' "$candidate_id" "$requested_id" >&2; exit 1; }
wait_ready "$candidate_container" || { printf 'Candidate readiness check failed.\n' >&2; exit 1; }

rm -f "$env_backup"
env_backup=
env_changed=0
rm -rf "$LOCK_DIR"
lock_owned=0
trap - EXIT INT TERM
printf 'Olympus Dispatch %s is ready; previous image %s remains available locally.\n' "$version" "$old_image"
