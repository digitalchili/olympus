#!/bin/sh
set -eu
# Supports --dry-run, --yes, and --hermes-volume NAME.
. "$(dirname "$0")/lib.sh"
parse_common "$@"
require_command docker
require_command openssl
require_command curl

image=${OLYMPUS_DISPATCH_IMAGE:-ghcr.io/leakim69/olympus-dispatch:0.3.0}
state_volume=${OLYMPUS_DISPATCH_STATE_VOLUME:-olympus-dispatch-state}
[ ! -e "$ACTIVE_SLOT_FILE" ] && [ ! -e "$METADATA_FILE" ] || { printf 'Portable slot metadata already exists; use update or uninstall instead of reinstalling.\n' >&2; exit 1; }

if [ -z "${HERMES_DATA_VOLUME:-}" ]; then
  volumes=$(docker ps --format '{{.ID}}' | while IFS= read -r id; do
    docker inspect "$id" --format '{{range .Mounts}}{{if eq .Destination "/opt/data"}}{{.Name}}{{"\n"}}{{end}}{{end}}'
  done | sed '/^$/d' | sort -u)
  count=$(printf '%s\n' "$volumes" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$count" = 1 ] || { printf 'Specify --hermes-volume; detected %s candidates.\n' "$count" >&2; exit 1; }
  HERMES_DATA_VOLUME=$volumes
  printf 'Detected one running /opt/data volume: name=%s\n' "$HERMES_DATA_VOLUME"
fi

docker volume inspect "$HERMES_DATA_VOLUME" >/dev/null 2>&1 || { printf 'Hermes volume does not exist: %s\n' "$HERMES_DATA_VOLUME" >&2; exit 1; }
if [ "$YES" != 1 ]; then
  printf 'Install using Hermes volume %s? [y/N] ' "$HERMES_DATA_VOLUME"; read -r answer
  [ "$answer" = y ] || [ "$answer" = Y ] || exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  printf 'dry-run: create/check Olympus state volume %s\n' "$state_volume"
  printf 'dry-run: authenticate to GHCR if required, pull and resolve an immutable image pin\n'
  printf 'dry-run: create mode-600 environment and slot metadata; start proxy and blue slot\n'
  exit 0
fi

env_created=0
env_backup=
recover_install() {
  status=$?
  docker compose -f "$COMPOSE_FILE" --profile blue stop olympus-blue proxy >/dev/null 2>&1 || true
  rm -f "$ACTIVE_SLOT_FILE" "$METADATA_FILE" deploy/nginx/conf.d/active.conf
  if [ "$env_created" = 1 ]; then rm -f .env
  elif [ -n "$env_backup" ]; then cp "$env_backup" .env; fi
  [ -z "$env_backup" ] || rm -f "$env_backup"
  release_operation_lock
  exit "$status"
}
acquire_operation_lock
trap recover_install EXIT INT TERM
[ ! -f .env ] || { env_backup=".env.before-install.$$"; umask 077; cp .env "$env_backup"; }

docker volume inspect "$state_volume" >/dev/null 2>&1 || docker volume create "$state_volume" >/dev/null
if ! docker pull "$image" >/dev/null 2>&1; then
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    require_command gh
    gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin >/dev/null
    docker pull "$image" >/dev/null
  fi
fi
pin=$(resolve_image_pin "$image")
# A newly-created named volume is root-owned. Make only its mount root writable by
# the unprivileged runtime UID; existing contents and ownership are untouched.
docker run --rm --network none --user 0:0 -v "$state_volume:/state" --entrypoint sh "$pin" \
  -c 'chown 10000:10000 /state && chmod 700 /state'

umask 077
if [ ! -f .env ]; then
  env_created=1
  token=$(openssl rand -hex 32)
  OLYMPUS_MAINTENANCE_TOKEN=$token
  { printf 'HERMES_DATA_VOLUME=%s\n' "$HERMES_DATA_VOLUME"; printf 'OLYMPUS_DISPATCH_STATE_VOLUME=%s\n' "$state_volume"; printf 'OLYMPUS_MAINTENANCE_TOKEN=%s\n' "$token"; } > .env
  chmod 600 .env
fi
[ -n "${OLYMPUS_MAINTENANCE_TOKEN:-}" ] || { printf 'Existing .env has no maintenance token.\n' >&2; exit 1; }
OLYMPUS_BLUE_IMAGE=$pin OLYMPUS_GREEN_IMAGE=$pin write_slot_metadata "$pin" "$pin"
printf 'blue\n' > "$ACTIVE_SLOT_FILE"
mkdir -p deploy/nginx/conf.d
cp deploy/nginx/active-blue.conf deploy/nginx/conf.d/active.conf
export HERMES_DATA_VOLUME OLYMPUS_DISPATCH_STATE_VOLUME=$state_volume
compose --profile blue up -d proxy olympus-blue
wait_ready "$(docker compose -f "$COMPOSE_FILE" ps -q olympus-blue)"
curl --retry 30 --retry-delay 2 --retry-connrefused --fail --silent --show-error "http://127.0.0.1:${OLYMPUS_DISPATCH_PORT:-6969}/api/ready" >/dev/null
[ -z "$env_backup" ] || rm -f "$env_backup"
trap 'status=$?; release_operation_lock; exit "$status"' EXIT INT TERM
release_operation_lock
trap - EXIT INT TERM
printf 'Olympus Dispatch is ready on the immutable image %s.\n' "$pin"
