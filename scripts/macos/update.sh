#!/bin/sh
set -eu
# Supports --dry-run. Candidate build never mutates the running release.
DRY_RUN=0; [ "${1:-}" = --dry-run ] && DRY_RUN=1
. "$(dirname "$0")/lib.sh"
select_node
version=$($node -p 'require(process.argv[1]).version' "$source_root/package.json")
release="$releases/$version-$(date -u +%Y%m%dT%H%M%SZ)-$$"
if [ "$DRY_RUN" = 1 ]; then printf 'dry-run: build and verify candidate in %s; drain activeRuns=0; verified backup; atomically switch current; restart/verify with rollback\n' "$release"; exit 0; fi
[ -L "$current" ] || { printf 'Current release link is missing; run install first.\n' >&2; exit 1; }
previous_current=$(readlink "$current")
acquire_operation_lock
trap 'status=$?; release_operation_lock; exit "$status"' EXIT INT TERM
build_release "$release"
[ -f "$plist" ] || { printf 'LaunchAgent plist is missing: %s\n' "$plist" >&2; exit 1; }
token=${OLYMPUS_MAINTENANCE_TOKEN:-$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:OLYMPUS_MAINTENANCE_TOKEN' "$plist")}
PORT=${PORT:-$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PORT' "$plist")}; export PORT
[ -n "${OLYMPUS_STATE_HOME:-}" ] || state_home=$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:OLYMPUS_DISPATCH_HOME' "$plist")
[ -n "$token" ] || { printf 'Maintenance token is unavailable.\n' >&2; exit 1; }
plist_backup="$plist.before-update.$$"
cp "$plist" "$plist_backup"; chmod 600 "$plist_backup"
drained=0; switched=0; plist_changed=0
recover() {
  status=$?
  if [ "$plist_changed" = 1 ]; then cp "$plist_backup" "$plist"; fi
  if [ "$switched" = 1 ]; then
    atomic_link "$previous_current"
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
    wait_ready_mac || printf 'Warning: previous release did not become ready automatically.\n' >&2
  elif [ "$drained" = 1 ]; then
    maintenance_request POST cancel "$token" >/dev/null 2>&1 || true
  fi
  rm -f "$plist_backup"
  release_operation_lock
  exit "$status"
}
trap recover EXIT INT TERM
maintenance_request POST drain "$token" >/dev/null; drained=1
wait_idle "$token" || { printf 'Drain timed out.\n' >&2; exit 1; }
backup_native_release "$previous_current"
plist_changed=1
/usr/bin/plutil -replace ProgramArguments.0 -string "$node" "$plist"
switched=1
atomic_link "$release"
launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist"
wait_ready_mac
rm -f "$plist_backup"
trap 'status=$?; release_operation_lock; exit "$status"' EXIT INT TERM
release_operation_lock
trap - EXIT INT TERM
printf 'Updated current to %s; previous release retained at %s.\n' "$release" "$previous_current"
