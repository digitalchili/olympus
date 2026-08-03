#!/bin/sh
set -eu

source_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
install_root=${OLYMPUS_INSTALL_ROOT:-$HOME/.olympus-dispatch/app}
releases="$install_root/releases"
current="$install_root/current"
label=${OLYMPUS_LAUNCHD_LABEL:-com.olympus.dispatch}
plist=${OLYMPUS_PLIST_PATH:-$HOME/Library/LaunchAgents/$label.plist}
state_home=${OLYMPUS_STATE_HOME:-$HOME/.olympus-dispatch}
operation_lock="$install_root/.operation.lock"
operation_lock_owned=0

acquire_operation_lock() {
  mkdir -p "$install_root"
  if ! mkdir "$operation_lock" 2>/dev/null; then
    owner=$(cat "$operation_lock/pid" 2>/dev/null || true)
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      printf 'Another Olympus operation is running (PID %s).\n' "$owner" >&2
      return 1
    fi
    rm -rf "$operation_lock"
    mkdir "$operation_lock"
  fi
  printf '%s\n' "$$" > "$operation_lock/pid"
  operation_lock_owned=1
}

release_operation_lock() {
  [ "$operation_lock_owned" = 0 ] || rm -rf "$operation_lock"
  operation_lock_owned=0
}

select_node() {
  if [ -x /opt/homebrew/opt/node@22/bin/node ]; then node=/opt/homebrew/opt/node@22/bin/node
  else node=$(command -v node) || { printf 'Node.js is required.\n' >&2; return 1; }; fi
  version=$($node -p 'process.versions.node')
  "$node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major > 22 || (major === 22 && minor >= 22)) && major < 26 ? 0 : 1)' \
    || { printf 'Node.js %s is unsupported; use Node 22.22-25 (Node 22 LTS recommended).\n' "$version" >&2; return 1; }
  PATH="$(dirname "$node"):$PATH"; export PATH
  npm=$(command -v npm) || { printf 'npm is required.\n' >&2; return 1; }
}

build_release() {
  release=$1
  mkdir -p "$release"
  (cd "$source_root" && tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=.worktrees \
    --exclude=.env --exclude='.env.*' --exclude='.tmp-*' --exclude='.olympus-*' --exclude=backups -cf - .) | (cd "$release" && tar -xf -)
  [ ! -f "$source_root/.env.example" ] || cp "$source_root/.env.example" "$release/.env.example"
  (cd "$release" && "$npm" ci --include=dev && "$npm" test && "$npm" run typecheck && "$npm" run build)
  test -f "$release/dist/server/server/index.js"
}

atomic_link() {
  target=$1
  temporary="$install_root/.current.$$"
  ln -s "$target" "$temporary"
  "$node" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$temporary" "$current"
}

maintenance_request() {
  method=$1 path=$2 token=$3
  { printf 'url="http://127.0.0.1:%s/api/maintenance/%s"\n' "${PORT:-6969}" "$path"; printf 'request="%s"\n' "$method"; printf 'header="Authorization: Bearer %s"\nfail\nsilent\nshow-error\n' "$token"; } | curl --config -
}

wait_idle() {
  i=0
  while [ "$i" -lt "${DRAIN_ATTEMPTS:-120}" ]; do
    maintenance_request GET status "$1" | grep -Eq '"activeRuns"[[:space:]]*:[[:space:]]*0' && return 0
    i=$((i+1)); sleep "${DRAIN_INTERVAL_SECONDS:-1}"
  done
  return 1
}

wait_ready_mac() { curl --retry 30 --retry-delay 2 --retry-connrefused --fail --silent --show-error "http://127.0.0.1:${PORT:-6969}/api/ready" >/dev/null; }

backup_native_release() {
  release_root=$1
  destination=${OLYMPUS_BACKUP_DIR:-$state_home/backups}
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  database=${DB_PATH:-$state_home/data/olympus-dispatch.db}
  [ -f "$database" ] || { printf 'Olympus database not found: %s\n' "$database" >&2; return 1; }
  mkdir -p "$destination"
  absolute_destination=$(CDPATH= cd -- "$destination" && pwd)
  (cd "$release_root" && BACKUP_SOURCE="$database" BACKUP_DESTINATION="$absolute_destination/olympus-$stamp.sqlite" "$node" -e '
    const Database = require("better-sqlite3");
    const source = new Database(process.env.BACKUP_SOURCE);
    source.pragma("busy_timeout=5000");
    source.pragma("wal_checkpoint(TRUNCATE)");
    source.backup(process.env.BACKUP_DESTINATION).then(() => {
      source.close();
      const copy = new Database(process.env.BACKUP_DESTINATION, { readonly: true });
      const check = copy.pragma("integrity_check", { simple: true });
      copy.close();
      if (check !== "ok") throw new Error(`integrity_check: ${check}`);
    }).catch((error) => { console.error(error.message); process.exit(1); });
  ')
  printf 'ok\n' > "$destination/olympus-$stamp.integrity"
  (cd "$state_home" && tar --exclude='./backups' --exclude='./data/olympus-dispatch.db' --exclude='./data/olympus-dispatch.db-wal' --exclude='./data/olympus-dispatch.db-shm' -czf "$absolute_destination/olympus-$stamp-state.tgz" .)
  printf 'timestamp=%s\nrelease=%s\n' "$stamp" "$release_root" > "$destination/olympus-$stamp.metadata"
  chmod 600 "$destination/olympus-$stamp.metadata" "$destination/olympus-$stamp.integrity"
  printf 'Verified native backup created: %s/olympus-%s.sqlite\n' "$destination" "$stamp"
}
