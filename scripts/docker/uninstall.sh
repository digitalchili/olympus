#!/bin/sh
set -eu
# Supports --dry-run and --yes. Volumes are preserved unless REMOVE_DATA=1.
. "$(dirname "$0")/lib.sh"; parse_common "$@"
if [ "$DRY_RUN" != 1 ]; then acquire_operation_lock; trap 'status=$?; release_operation_lock; exit "$status"' EXIT INT TERM; fi
compose down
if [ "${REMOVE_DATA:-0}" = 1 ]; then [ "$YES" = 1 ] || { printf 'Use --yes with REMOVE_DATA=1.\n' >&2; exit 1; }; run docker volume rm "${OLYMPUS_DISPATCH_STATE_VOLUME:-olympus-dispatch-state}"; fi
if [ "$DRY_RUN" != 1 ]; then release_operation_lock; trap - EXIT INT TERM; fi
