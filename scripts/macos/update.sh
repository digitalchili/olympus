#!/bin/sh
set -eu
# Supports --dry-run. Candidate build never mutates the running release.
DRY_RUN=0
requested_version=${OLYMPUS_UPDATE_VERSION:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --version) shift; requested_version=${1:-} ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
. "$(dirname "$0")/lib.sh"
select_node
if [ -n "$requested_version" ]; then
  printf '%s' "$requested_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || {
    printf 'A semantic --version is required.\n' >&2
    exit 2
  }
  version=$requested_version
else
  version=$($node -p 'require(process.argv[1]).version' "$source_root/package.json")
fi
release="$releases/$version-$(date -u +%Y%m%dT%H%M%SZ)-$$"
if [ "$DRY_RUN" = 1 ]; then printf 'dry-run: fetch requested release %s; build and verify candidate in %s; drain activeRuns=0; verified backup; atomically switch current; restart/verify with rollback\n' "$version" "$release"; exit 0; fi
[ -L "$current" ] || { printf 'Current release link is missing; run install first.\n' >&2; exit 1; }
previous_current=$(readlink "$current")
previous_version=$($node -p 'require(process.argv[1]).version' "$previous_current/package.json")
candidate_source=
acquire_operation_lock
cleanup_candidate() { [ -z "$candidate_source" ] || rm -rf "$candidate_source"; }
trap 'status=$?; cleanup_candidate; release_operation_lock; exit "$status"' EXIT INT TERM
build_source=$source_root
if [ -n "$requested_version" ]; then
  candidate_source="$install_root/.candidate-source.$$"
  fetch_release_source "$version" "$candidate_source"
  build_source=$candidate_source
fi
build_release "$release" "$build_source"
candidate_version=$($node -p 'require(process.argv[1]).version' "$release/package.json")
[ "$candidate_version" = "$version" ] || { printf 'Built candidate version %s does not match requested release %s.\n' "$candidate_version" "$version" >&2; exit 1; }
cleanup_candidate; candidate_source=
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
    if ! restart_launchd || ! wait_ready_mac "$previous_version"; then
      printf 'Warning: previous release did not become ready automatically.\n' >&2
    fi
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
restart_launchd
wait_ready_mac "$version"
rm -f "$plist_backup"
trap 'status=$?; release_operation_lock; exit "$status"' EXIT INT TERM
release_operation_lock
trap - EXIT INT TERM
printf 'Updated current to %s; previous release retained at %s.\n' "$release" "$previous_current"
