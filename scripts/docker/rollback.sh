#!/bin/sh
set -eu
# Restores the retained slot and its immutable pin. Supports --dry-run and --yes.
. "$(dirname "$0")/lib.sh"; parse_common "$@"
current=$(active_slot)
[ "$current" = blue ] && target=green || target=blue
eval "target_pin=\${OLYMPUS_$(printf '%s' "$target" | tr '[:lower:]' '[:upper:]')_IMAGE:-}"
[ -n "$target_pin" ] || { printf 'Rollback slot %s has no retained image pin.\n' "$target" >&2; exit 1; }
if [ "$DRY_RUN" = 1 ]; then printf 'dry-run: drain %s, verify backup, start retained %s at %s, switch and verify proxy, stop %s\n' "$current" "$target" "$target_pin" "$current"; exit 0; fi

proxy_config_changed=0; target_started=0; active_slot_changed=0
recover() {
  status=$?
  if [ "$proxy_config_changed" = 1 ]; then cp "deploy/nginx/active-$current.conf" deploy/nginx/conf.d/active.conf; compose exec -T proxy nginx -s reload >/dev/null 2>&1 || true; fi
  [ "$target_started" = 0 ] || compose --profile "$target" stop "olympus-$target" >/dev/null 2>&1 || true
  if [ "$active_slot_changed" = 1 ]; then printf '%s\n' "$current" > "$ACTIVE_SLOT_FILE.tmp.recover.$$"; mv "$ACTIVE_SLOT_FILE.tmp.recover.$$" "$ACTIVE_SLOT_FILE"; fi
  maintenance POST cancel >/dev/null 2>&1 || true
  cancel_drain_in_service "olympus-$current" >/dev/null 2>&1 || true
  wait_service_ready "olympus-$current" || printf 'CRITICAL: recovery could not verify readiness of olympus-%s.\n' "$current" >&2
  release_operation_lock
  exit "$status"
}
acquire_operation_lock
trap recover EXIT INT TERM
maintenance POST drain >/dev/null
wait_idle || { printf 'Drain timed out; rollback cancelled.\n' >&2; exit 1; }
ALREADY_DRAINED=1 "$(dirname "$0")/backup.sh"
compose --profile "$target" up -d --no-deps "olympus-$target"; target_started=1
wait_ready "$(docker compose -f "$COMPOSE_FILE" ps -q "olympus-$target")" || { printf 'Retained slot readiness failed.\n' >&2; exit 1; }
cp "deploy/nginx/active-$target.conf" deploy/nginx/conf.d/active.conf
proxy_config_changed=1
compose exec -T proxy nginx -s reload
curl --fail --silent --show-error --retry 10 --retry-delay 1 "http://127.0.0.1:${OLYMPUS_DISPATCH_PORT:-6969}/api/ready" >/dev/null
printf '%s\n' "$target" > "$ACTIVE_SLOT_FILE.tmp.$$"
active_slot_changed=1
mv "$ACTIVE_SLOT_FILE.tmp.$$" "$ACTIVE_SLOT_FILE"
trap 'status=$?; release_operation_lock; exit "$status"' EXIT INT TERM
compose --profile "$current" stop "olympus-$current" || printf 'Warning: olympus-%s remains drained; traffic is already on %s.\n' "$current" "$target" >&2
release_operation_lock
trap - EXIT INT TERM
printf 'Rolled back to %s at %s.\n' "$target" "$target_pin"
