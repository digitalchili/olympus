#!/bin/sh
set -eu
# Supports --dry-run. Drains unless ALREADY_DRAINED=1 and never copies Hermes data.
. "$(dirname "$0")/lib.sh"; parse_common "$@"
destination=${BACKUP_DIR:-./backups}; stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
slot=$(active_slot)
eval "image=\${OLYMPUS_$(printf '%s' "$slot" | tr '[:lower:]' '[:upper:]')_IMAGE:-}"
[ -n "$image" ] || { printf 'No immutable image pin for active slot %s.\n' "$slot" >&2; exit 1; }
state_volume=${OLYMPUS_DISPATCH_STATE_VOLUME:-olympus-dispatch-state}

if [ "$DRY_RUN" = 1 ]; then
  printf 'dry-run: drain and wait for activeRuns=0; checkpoint and verify SQLite backup; archive non-DB Olympus state in %s\n' "$destination"
  exit 0
fi

standalone=0
if [ "${ALREADY_DRAINED:-0}" != 1 ]; then
  acquire_operation_lock
  standalone=1
  finish_backup() { status=$?; maintenance POST cancel >/dev/null 2>&1 || true; release_operation_lock; exit "$status"; }
  trap finish_backup EXIT INT TERM
  maintenance POST drain >/dev/null
  wait_idle || { printf 'Drain timed out; backup cancelled.\n' >&2; exit 1; }
fi
mkdir -p "$destination"
absolute_destination=$(CDPATH= cd -- "$destination" && pwd)
host_uid=$(id -u); host_gid=$(id -g)

# Run as root only inside the short-lived, networkless helper so it can checkpoint
# the UID-10000 state volume and return host-owned backup files through the bind mount.
docker run --rm --network none --user 0:0 \
  -e BACKUP_STAMP="$stamp" -e BACKUP_UID="$host_uid" -e BACKUP_GID="$host_gid" \
  -v "$state_volume:/state" -v "$absolute_destination:/backup" "$image" \
  node -e 'const Database=require("better-sqlite3"),fs=require("fs");const stamp=process.env.BACKUP_STAMP;const src="/state/data/olympus-dispatch.db",dst=`/backup/olympus-${stamp}.sqlite`;const db=new Database(src);db.pragma("busy_timeout=5000");db.pragma("wal_checkpoint(TRUNCATE)");db.backup(dst).then(()=>{db.close();const copy=new Database(dst,{readonly:true});const check=copy.pragma("integrity_check",{simple:true});copy.close();if(check!=="ok")throw Error("integrity_check: "+check);const marker=`/backup/olympus-${stamp}.integrity`;fs.writeFileSync(marker,"ok\n");fs.chownSync(dst,+process.env.BACKUP_UID,+process.env.BACKUP_GID);fs.chownSync(marker,+process.env.BACKUP_UID,+process.env.BACKUP_GID)}).catch(e=>{console.error(e.message);process.exit(1)})'

docker run --rm --network none --user 0:0 \
  -e BACKUP_STAMP="$stamp" -e BACKUP_UID="$host_uid" -e BACKUP_GID="$host_gid" \
  -v "$state_volume:/state:ro" -v "$absolute_destination:/backup" --entrypoint sh "$image" \
  -c 'cd /state && tar --exclude="./data/olympus-dispatch.db" --exclude="./data/olympus-dispatch.db-wal" --exclude="./data/olympus-dispatch.db-shm" -czf "/backup/olympus-${BACKUP_STAMP}-state.tgz" . && chown "${BACKUP_UID}:${BACKUP_GID}" "/backup/olympus-${BACKUP_STAMP}-state.tgz"'

version=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || printf unknown)
{
  printf 'timestamp=%s\nactive_slot=%s\nversion=%s\n' "$stamp" "$slot" "$version"
  printf 'blue_image=%s\ngreen_image=%s\n' "$OLYMPUS_BLUE_IMAGE" "$OLYMPUS_GREEN_IMAGE"
} > "$destination/olympus-$stamp.metadata"
chmod 600 "$destination/olympus-$stamp.metadata"
if [ "$standalone" = 1 ]; then maintenance POST cancel >/dev/null; release_operation_lock; trap - EXIT INT TERM; fi
printf 'Verified backup created: %s/olympus-%s.sqlite\n' "$destination" "$stamp"
