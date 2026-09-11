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
  build_source=${2:-$source_root}
  mkdir -p "$release"
  (cd "$build_source" && tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=.worktrees \
    --exclude=.env --exclude='.env.*' --exclude='.tmp-*' --exclude='.olympus-*' --exclude=backups -cf - .) | (cd "$release" && tar -xf -)
  [ ! -f "$build_source/.env.example" ] || cp "$build_source/.env.example" "$release/.env.example"
  (cd "$release" && "$npm" ci --include=dev && "$npm" test && "$npm" run typecheck && "$npm" run build)
  test -f "$release/dist/server/server/index.js"
}

fetch_release_source() {
  requested_version=$1
  destination=$2
  printf '%s' "$requested_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || {
    printf 'A semantic release version is required.\n' >&2
    return 2
  }

  repository=${OLYMPUS_UPDATE_REPOSITORY:-digitalchili/olympus}
  case "$repository" in
    */*) remote=${OLYMPUS_UPDATE_GIT_URL:-https://github.com/$repository.git} ;;
    *) printf 'Invalid Olympus update repository: %s\n' "$repository" >&2; return 2 ;;
  esac

  rm -rf "$destination"
  mkdir -p "$destination"
  git -C "$destination" init -q
  git -C "$destination" fetch --quiet --depth 1 --no-tags "$remote" \
    "refs/tags/v$requested_version:refs/tags/v$requested_version"
  git -C "$destination" checkout --quiet --detach "refs/tags/v$requested_version"

  fetched_version=$($node -p 'require(process.argv[1]).version' "$destination/package.json")
  [ "$fetched_version" = "$requested_version" ] || {
    printf 'Fetched package version %s does not match requested release %s.\n' "$fetched_version" "$requested_version" >&2
    return 1
  }
}

atomic_link() {
  target=$1
  temporary="$install_root/.current.$$"
  ln -s "$target" "$temporary"
  "$node" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$temporary" "$current"
}

set_launch_agent_program_arguments() {
  entrypoint=$1
  plistbuddy=${PLISTBUDDY:-/usr/libexec/PlistBuddy}
  "$plistbuddy" -c 'Delete :ProgramArguments' "$plist" >/dev/null 2>&1 || true
  "$plistbuddy" -c 'Add :ProgramArguments array' "$plist"
  "$plistbuddy" -c "Add :ProgramArguments:0 string $node" "$plist"
  "$plistbuddy" -c "Add :ProgramArguments:1 string $entrypoint" "$plist"
  [ "$("$plistbuddy" -c 'Print :ProgramArguments:0' "$plist")" = "$node" ] || return 1
  [ "$("$plistbuddy" -c 'Print :ProgramArguments:1' "$plist")" = "$entrypoint" ] || return 1
}

maintenance_request() {
  method=$1 path=$2 token=$3
  { printf 'url="%s/api/maintenance/%s"\n' "$(local_probe_base_url)" "$path"; printf 'request="%s"\n' "$method"; printf 'header = "Authorization: Bearer %s"\nfail\nsilent\nshow-error\n' "$token"; } | curl --config -
}

local_probe_base_url() {
  host=${OLYMPUS_PROBE_HOST:-}
  if [ -z "$host" ] && [ -f "$plist" ]; then
    host=$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:HOST' "$plist" 2>/dev/null || true)
  fi
  case "$host" in
    ''|localhost|127.0.0.1|::1|'[::1]'|0.0.0.0|'::') host=127.0.0.1 ;;
    *:*) host="[$host]" ;;
  esac
  printf 'http://%s:%s' "$host" "${PORT:-6969}"
}

wait_idle() {
  i=0
  while [ "$i" -lt "${DRAIN_ATTEMPTS:-120}" ]; do
    maintenance_request GET status "$1" | grep -Eq '"activeRuns"[[:space:]]*:[[:space:]]*0' && return 0
    i=$((i+1)); sleep "${DRAIN_INTERVAL_SECONDS:-1}"
  done
  return 1
}

restart_launchd() {
  domain="gui/$(id -u)"
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  attempt=1
  attempts=${LAUNCHD_ATTEMPTS:-10}
  while [ "$attempt" -le "$attempts" ]; do
    if launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then
      launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
      return 0
    fi
    # bootout is asynchronous, so wait for the old registration to disappear
    # instead of accepting a kickstart that may still belong to the old job.
    [ "$attempt" -ge "$attempts" ] || sleep "${LAUNCHD_INTERVAL_SECONDS:-1}"
    attempt=$((attempt + 1))
  done
  printf 'Could not restart launchd service %s after %s attempts.\n' "$label" "$attempts" >&2
  return 1
}

wait_ready_mac() {
  expected_version=${1:-}
  i=0
  while [ "$i" -lt "${READY_ATTEMPTS:-30}" ]; do
    if curl --fail --silent --show-error "$(local_probe_base_url)/api/ready" >/dev/null; then
      if [ -z "$expected_version" ]; then return 0; fi
      live_version=$(curl --fail --silent --show-error "$(local_probe_base_url)/api/version" 2>/dev/null || true)
      printf '%s' "$live_version" | tr -d '[:space:]' | grep -Fq "\"version\":\"$expected_version\"" && return 0
    fi
    i=$((i + 1)); sleep "${READY_INTERVAL_SECONDS:-2}"
  done
  printf 'Olympus release %s did not become ready.\n' "${expected_version:-unknown}" >&2
  return 1
}

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
  # The release tree, logs, updater socket, and SQLite database are installation/runtime
  # material. Archive only durable non-database user state so a native update cannot
  # recursively package every retained release or its own backup directory.
  state_entries=
  for entry in workspace skills; do
    [ ! -e "$state_home/$entry" ] || state_entries="$state_entries ./$entry"
  done
  [ -n "$state_entries" ] || { printf 'No durable non-database state exists to archive.\n' >&2; return 1; }
  # shellcheck disable=SC2086 # state_entries is a controlled list of fixed names.
  (cd "$state_home" && tar -czf "$absolute_destination/olympus-$stamp-state.tgz" $state_entries)
  printf 'timestamp=%s\nrelease=%s\n' "$stamp" "$release_root" > "$destination/olympus-$stamp.metadata"
  chmod 600 "$destination/olympus-$stamp.metadata" "$destination/olympus-$stamp.integrity"
  printf 'Verified native backup created: %s/olympus-%s.sqlite\n' "$destination" "$stamp"
}
