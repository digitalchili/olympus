#!/bin/sh
set -eu
# Strict single-writer updater. Supports --dry-run and --yes.
. "$(dirname "$0")/lib.sh"; parse_common "$@"
active=$(active_slot)
[ "$active" = blue ] && candidate=green || candidate=blue
active_service=olympus-$active; candidate_service=olympus-$candidate
requested_image=${OLYMPUS_DISPATCH_IMAGE:-ghcr.io/leakim69/olympus-dispatch:0.3.0}

if [ "$DRY_RUN" = 1 ]; then
  printf 'dry-run: pull and pin candidate; preflight with disposable Olympus state and read-only Hermes volume\n'
  printf 'dry-run: drain %s, wait idle, verified backup, start/verify %s, switch/verify proxy, stop %s\n' "$active" "$candidate" "$active"
  exit 0
fi

acquire_operation_lock
pre_state=olympus-preflight-state-$$; pre_container=olympus-preflight-$$
cleanup_preflight() { docker rm -f "$pre_container" >/dev/null 2>&1 || true; docker volume rm "$pre_state" >/dev/null 2>&1 || true; }
preflight_failure() { status=$?; cleanup_preflight; release_operation_lock; exit "$status"; }
trap preflight_failure EXIT INT TERM

if ! docker pull "$requested_image" >/dev/null 2>&1; then
  docker image inspect "$requested_image" >/dev/null 2>&1 || { printf 'Could not pull or find candidate image: %s\n' "$requested_image" >&2; exit 1; }
fi
candidate_pin=$(resolve_image_pin "$requested_image")
docker volume create "$pre_state" >/dev/null
docker run --rm --network none --user 0:0 -v "$pre_state:/state" --entrypoint sh "$candidate_pin" \
  -c 'chown 10000:10000 /state && chmod 700 /state'
docker run -d --name "$pre_container" --env-file .env \
  -e NODE_ENV=production -e PORT=6969 -e OLYMPUS_STRICT_PORT=1 \
  -e HOME=/opt/data/home -e HERMES_HOME=/opt/data -e HERMES_AGENT_DIR=/opt/hermes \
  -e HERMES_PYTHON=/opt/hermes/.venv/bin/python -e HERMES_DISABLE_LAZY_INSTALLS=1 \
  -e HERMES_WRITE_SAFE_ROOT=/opt/data \
  -e OLYMPUS_DISPATCH_HOME=/opt/data/olympus-dispatch \
  -e DB_PATH=/opt/data/olympus-dispatch/data/olympus-dispatch.db \
  -v "${HERMES_DATA_VOLUME:?set HERMES_DATA_VOLUME}:/opt/data:ro" \
  -v "$pre_state:/opt/data/olympus-dispatch" "$candidate_pin" >/dev/null
wait_ready "$pre_container" || { printf 'Candidate preflight failed; active slot unchanged.\n' >&2; exit 1; }
cleanup_preflight; trap - EXIT INT TERM

proxy_config_changed=0
candidate_started=0
active_slot_changed=0
recover() {
  status=$?
  if [ "$proxy_config_changed" = 1 ]; then
    cp "deploy/nginx/active-$active.conf" deploy/nginx/conf.d/active.conf
    docker compose -f "$COMPOSE_FILE" exec -T proxy nginx -s reload >/dev/null 2>&1 || true
  fi
  cp ".env.before-update.$$" .env >/dev/null 2>&1 || true
  cp "$METADATA_FILE.before-update.$$" "$METADATA_FILE" >/dev/null 2>&1 || true
  if [ "$active_slot_changed" = 1 ]; then printf '%s\n' "$active" > "$ACTIVE_SLOT_FILE.tmp.recover.$$"; mv "$ACTIVE_SLOT_FILE.tmp.recover.$$" "$ACTIVE_SLOT_FILE"; fi
  rm -f ".env.before-update.$$" "$METADATA_FILE.before-update.$$"
  [ "$candidate_started" = 0 ] || docker compose -f "$COMPOSE_FILE" --profile "$candidate" stop "$candidate_service" >/dev/null 2>&1 || true
  maintenance POST cancel >/dev/null 2>&1 || true
  cancel_drain_in_service "$active_service" >/dev/null 2>&1 || true
  wait_service_ready "$active_service" || printf 'CRITICAL: recovery could not verify readiness of %s.\n' "$active_service" >&2
  release_operation_lock
  exit "$status"
}
trap recover EXIT INT TERM
umask 077
cp .env ".env.before-update.$$"
cp "$METADATA_FILE" "$METADATA_FILE.before-update.$$"
maintenance POST drain >/dev/null
wait_idle || { printf 'Drain timed out; promotion cancelled.\n' >&2; exit 1; }
ALREADY_DRAINED=1 "$(dirname "$0")/backup.sh"

if [ "$candidate" = blue ]; then OLYMPUS_BLUE_IMAGE=$candidate_pin; export OLYMPUS_BLUE_IMAGE; else OLYMPUS_GREEN_IMAGE=$candidate_pin; export OLYMPUS_GREEN_IMAGE; fi
docker compose -f "$COMPOSE_FILE" --profile "$candidate" up -d --no-deps "$candidate_service"
candidate_started=1
candidate_id=$(docker compose -f "$COMPOSE_FILE" ps -q "$candidate_service")
[ -n "$candidate_id" ] && wait_ready "$candidate_id" || { printf 'Candidate direct readiness failed.\n' >&2; exit 1; }

cp "deploy/nginx/active-$candidate.conf" deploy/nginx/conf.d/active.conf
proxy_config_changed=1
docker compose -f "$COMPOSE_FILE" exec -T proxy nginx -s reload
curl --fail --silent --show-error --retry 10 --retry-delay 1 "http://127.0.0.1:${OLYMPUS_DISPATCH_PORT:-6969}/api/ready" >/dev/null || { printf 'Proxy readiness failed after switch.\n' >&2; exit 1; }

blue_pin=$OLYMPUS_BLUE_IMAGE; green_pin=$OLYMPUS_GREEN_IMAGE
write_slot_metadata "$blue_pin" "$green_pin"
printf '%s\n' "$candidate" > "$ACTIVE_SLOT_FILE.tmp.$$"
active_slot_changed=1
mv "$ACTIVE_SLOT_FILE.tmp.$$" "$ACTIVE_SLOT_FILE"
rm -f ".env.before-update.$$" "$METADATA_FILE.before-update.$$"
trap 'status=$?; release_operation_lock; exit "$status"' EXIT INT TERM
docker compose -f "$COMPOSE_FILE" --profile "$active" stop "$active_service" || printf 'Warning: %s remains drained but stopped traffic is already on %s.\n' "$active_service" "$candidate" >&2
release_operation_lock
trap - EXIT INT TERM
printf 'Promoted %s at %s; retained %s at its immutable prior image.\n' "$candidate" "$candidate_pin" "$active"
