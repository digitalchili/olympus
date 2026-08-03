#!/bin/sh
set -eu
# Supports --dry-run. User state and versioned releases are preserved.
DRY_RUN=0; [ "${1:-}" = --dry-run ] && DRY_RUN=1
. "$(dirname "$0")/lib.sh"
if [ "$DRY_RUN" = 1 ]; then printf 'dry-run: unload and remove %s\n' "$plist"; exit 0; fi
acquire_operation_lock
trap 'status=$?; release_operation_lock; exit "$status"' EXIT INT TERM
launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
if [ -f "$plist" ]; then
  mkdir -p "$HOME/.Trash"
  mv "$plist" "$HOME/.Trash/$(basename "$plist").$(date +%s)"
fi
release_operation_lock
trap - EXIT INT TERM
printf 'Uninstalled LaunchAgent; releases and user state were preserved.\n'
