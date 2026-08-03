#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
suffix=$$
label=${OLYMPUS_MAC_E2E_LABEL:-com.olympus.dispatch.e2e-fail-$suffix}
install_root=${OLYMPUS_MAC_E2E_INSTALL_ROOT:-/tmp/olympus-dispatch-e2e-fail-app-$suffix}
state_home=${OLYMPUS_MAC_E2E_STATE_HOME:-/tmp/olympus-dispatch-e2e-fail-state-$suffix}
plist=${OLYMPUS_MAC_E2E_PLIST_PATH:-/tmp/$label.plist}
port=${OLYMPUS_MAC_E2E_PORT:-16971}

export OLYMPUS_LAUNCHD_LABEL="$label"
export OLYMPUS_INSTALL_ROOT="$install_root"
export OLYMPUS_STATE_HOME="$state_home"
export OLYMPUS_PLIST_PATH="$plist"
export HERMES_AGENT_DIR=${HERMES_AGENT_DIR:-$HOME/.hermes/hermes-agent}
export PORT="$port"

cleanup() {
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  rm -rf "$install_root" "$state_home" "$plist"
}
trap cleanup EXIT INT TERM
cleanup
mkdir -p "$state_home"
cd "$root"
./scripts/macos/install.sh
before=$(readlink "$install_root/current")

# After the updater has completed its verified backup, corrupt only the new
# candidate release. The retained release remains untouched.
(
  i=0
  while [ "$i" -lt 2400 ]; do
    marker=$(find "$state_home/backups" -name '*.integrity' -print -quit 2>/dev/null || true)
    candidate=$(find "$install_root/releases" -mindepth 1 -maxdepth 1 -type d ! -path "$before" -print -quit 2>/dev/null || true)
    if [ -n "$marker" ] && [ -f "$candidate/dist/server/server/index.js" ]; then
      CANDIDATE="$candidate/dist/server/server/index.js" python3 -c 'import os; p=os.environ["CANDIDATE"]; data=open(p).read(); open(p,"w").write("process.exit(42);\n"+data)'
      exit 0
    fi
    i=$((i + 1))
    sleep 0.05
  done
  exit 1
) &
watcher=$!

if ./scripts/macos/update.sh; then
  printf 'Expected candidate readiness failure.\n' >&2
  exit 1
fi
wait "$watcher"
after=$(readlink "$install_root/current")
[ "$after" = "$before" ]
curl --fail --silent "http://127.0.0.1:$port/api/ready" >/dev/null
[ ! -d "$install_root/.operation.lock" ]
printf 'macOS failed-update recovery passed: restored=%s\n' "$after"
