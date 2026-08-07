#!/bin/sh
set -eu
# Supports --dry-run. Builds an isolated release and atomically initializes current.
DRY_RUN=0
HOST_VALUE=${OLYMPUS_HOST:-127.0.0.1}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --tailscale)
      command -v tailscale >/dev/null 2>&1 || { printf 'Tailscale is required for --tailscale.\n' >&2; exit 2; }
      HOST_VALUE=$(tailscale ip -4 | head -n 1)
      [ -n "$HOST_VALUE" ] || { printf 'No Tailscale IPv4 address is available.\n' >&2; exit 2; }
      ;;
    --host)
      shift
      HOST_VALUE=${1:-}
      [ -n "$HOST_VALUE" ] || { printf 'A host is required after --host.\n' >&2; exit 2; }
      ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
. "$(dirname "$0")/lib.sh"
select_node
if [ "$DRY_RUN" = 0 ] && [ -L "$current" ]; then
  exec "$source_root/scripts/macos/update.sh"
fi
hermes=${HERMES_AGENT_DIR:-$HOME/.hermes/hermes-agent}
[ -x "$hermes/venv/bin/python" ] || [ -x "$hermes/.venv/bin/python" ] || { printf 'Hermes Python environment not found at %s\n' "$hermes" >&2; exit 1; }
python="$hermes/venv/bin/python"; [ -x "$python" ] || python="$hermes/.venv/bin/python"
version=$($node -p 'require(process.argv[1]).version' "$source_root/package.json")
release="$releases/$version-$(date -u +%Y%m%dT%H%M%SZ)-$$"
if [ "$DRY_RUN" = 1 ]; then printf 'dry-run: build candidate release under %s with Node 22 preference; atomically initialize current and %s (host %s)\n' "$releases" "$plist" "$HOST_VALUE"; exit 0; fi
recover_install() {
  status=$?
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  rm -f "$current" "$plist"
  release_operation_lock
  exit "$status"
}
acquire_operation_lock
trap recover_install EXIT INT TERM
build_release "$release"
mkdir -p "$install_root" "$(dirname "$plist")" "$state_home/logs"; atomic_link "$release"; umask 077
token=$(openssl rand -hex 32)
escape_sed() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
sed -e "s|@@LABEL@@|$(escape_sed "$label")|g" -e "s|@@ROOT@@|$(escape_sed "$current")|g" -e "s|@@NODE@@|$(escape_sed "$node")|g" -e "s|@@PYTHON@@|$(escape_sed "$python")|g" -e "s|@@STATE_HOME@@|$(escape_sed "$state_home")|g" -e "s|@@PORT@@|${PORT:-6969}|g" -e "s|@@HOST@@|$(escape_sed "$HOST_VALUE")|g" -e "s|@@TOKEN@@|$token|g" "$release/deploy/macos/com.olympus.dispatch.plist" > "$plist"
chmod 600 "$plist"
restart_launchd
wait_ready_mac "$version"
trap 'status=$?; release_operation_lock; exit "$status"' EXIT INT TERM
release_operation_lock
trap - EXIT INT TERM
printf 'Olympus Dispatch is ready from %s.\n' "$release"
