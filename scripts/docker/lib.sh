#!/bin/sh
set -eu

DRY_RUN=${DRY_RUN:-0}
YES=${YES:-0}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.ha.yml}
METADATA_FILE=${METADATA_FILE:-.olympus-slots.env}
ACTIVE_SLOT_FILE=${ACTIVE_SLOT_FILE:-.olympus-active-slot}
OPERATION_LOCK_DIR=${OLYMPUS_OPERATION_LOCK_DIR:-.olympus-operation.lock}
operation_lock_owned=0

read_env_value() { awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env; }
if [ -f .env ]; then
  value=$(read_env_value HERMES_DATA_VOLUME); [ -z "$value" ] || HERMES_DATA_VOLUME=$value
  value=$(read_env_value OLYMPUS_DISPATCH_STATE_VOLUME); [ -z "$value" ] || OLYMPUS_DISPATCH_STATE_VOLUME=$value
  value=$(read_env_value OLYMPUS_MAINTENANCE_TOKEN); [ -z "$value" ] || OLYMPUS_MAINTENANCE_TOKEN=$value
  value=$(read_env_value OLYMPUS_DISPATCH_PORT); [ -z "$value" ] || OLYMPUS_DISPATCH_PORT=$value
  value=$(read_env_value OLYMPUS_DISPATCH_IMAGE); [ -z "$value" ] || OLYMPUS_DISPATCH_IMAGE=$value
  export HERMES_DATA_VOLUME OLYMPUS_DISPATCH_STATE_VOLUME OLYMPUS_MAINTENANCE_TOKEN OLYMPUS_DISPATCH_PORT OLYMPUS_DISPATCH_IMAGE
fi
if [ -f "$METADATA_FILE" ]; then
  OLYMPUS_BLUE_IMAGE=$(awk -F= '$1=="OLYMPUS_BLUE_IMAGE" {sub(/^[^=]*=/,"");print;exit}' "$METADATA_FILE")
  OLYMPUS_GREEN_IMAGE=$(awk -F= '$1=="OLYMPUS_GREEN_IMAGE" {sub(/^[^=]*=/,"");print;exit}' "$METADATA_FILE")
  export OLYMPUS_BLUE_IMAGE OLYMPUS_GREEN_IMAGE
fi

run() {
  if [ "$DRY_RUN" = 1 ]; then printf 'dry-run:'; printf ' %s' "$@"; printf '\n'; else "$@"; fi
}

compose() { run docker compose -f "$COMPOSE_FILE" "$@"; }

acquire_operation_lock() {
  [ "${OLYMPUS_OPERATION_LOCK_HELD:-0}" != 1 ] || return 0
  if ! mkdir "$OPERATION_LOCK_DIR" 2>/dev/null; then
    owner=$(cat "$OPERATION_LOCK_DIR/pid" 2>/dev/null || true)
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      printf 'Another Olympus operation is running (PID %s).\n' "$owner" >&2
      return 1
    fi
    rm -rf "$OPERATION_LOCK_DIR"
    mkdir "$OPERATION_LOCK_DIR"
  fi
  printf '%s\n' "$$" > "$OPERATION_LOCK_DIR/pid"
  operation_lock_owned=1
  OLYMPUS_OPERATION_LOCK_HELD=1; export OLYMPUS_OPERATION_LOCK_HELD
}

release_operation_lock() {
  [ "$operation_lock_owned" = 0 ] || rm -rf "$OPERATION_LOCK_DIR"
  operation_lock_owned=0
}

parse_common() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --yes) YES=1 ;;
      --hermes-volume) shift; HERMES_DATA_VOLUME=${1:?missing volume} ;;
      --image) shift; OLYMPUS_DISPATCH_IMAGE=${1:?missing image}; export OLYMPUS_DISPATCH_IMAGE ;;
      *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
    shift
  done
}

require_command() { command -v "$1" >/dev/null 2>&1 || { printf 'Required command not found: %s\n' "$1" >&2; exit 1; }; }

set_env_value() {
  key=$1 value=$2 file=${3:-.env}
  tmp="$file.tmp.$$"
  umask 077
  if [ -f "$file" ]; then
    awk -F= -v key="$key" -v value="$value" '
      BEGIN { found=0 }
      $1 == key { print key "=" value; found=1; next }
      { print }
      END { if (!found) print key "=" value }
    ' "$file" > "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

maintenance_at() {
  base=$1 method=$2 path=$3
  token=${OLYMPUS_MAINTENANCE_TOKEN:?maintenance token is required}
  # Authentication is supplied only on curl's stdin. It is never an argv value.
  {
    [ -z "${CURL_UNIX_SOCKET:-}" ] || printf 'unix-socket = "%s"\n' "$CURL_UNIX_SOCKET"
    printf 'url = "%s/api/maintenance/%s"\n' "$base" "$path"
    printf 'request = "%s"\n' "$method"
    printf 'header = "Authorization: Bearer %s"\n' "$token"
    printf 'fail\nsilent\nshow-error\n'
  } | curl --config -
}

maintenance() { maintenance_at "http://127.0.0.1:${OLYMPUS_DISPATCH_PORT:-6969}" "$1" "$2"; }

cancel_drain_in_service() {
  service=$1
  # Read the token inside the container so it is absent from host argv and logs.
  docker compose -f "$COMPOSE_FILE" exec -T "$service" node -e '
    const token = process.env.OLYMPUS_MAINTENANCE_TOKEN;
    fetch("http://127.0.0.1:6969/api/maintenance/cancel", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));
  '
}

active_slot() {
  slot=$(cat "$ACTIVE_SLOT_FILE" 2>/dev/null || true)
  case "$slot" in blue|green) printf '%s\n' "$slot" ;; *) printf 'Active slot metadata is missing or invalid.\n' >&2; return 1 ;; esac
}

write_slot_metadata() {
  blue=$1 green=$2
  tmp="$METADATA_FILE.tmp.$$"
  umask 077
  { printf 'OLYMPUS_BLUE_IMAGE=%s\n' "$blue"; printf 'OLYMPUS_GREEN_IMAGE=%s\n' "$green"; } > "$tmp"
  mv "$tmp" "$METADATA_FILE"
  set_env_value OLYMPUS_BLUE_IMAGE "$blue"
  set_env_value OLYMPUS_GREEN_IMAGE "$green"
  export OLYMPUS_BLUE_IMAGE=$blue OLYMPUS_GREEN_IMAGE=$green
}

resolve_image_pin() {
  ref=$1
  pin=$(docker image inspect "$ref" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)
  [ -n "$pin" ] || pin=$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null || true)
  [ -n "$pin" ] || { printf 'Could not resolve immutable image for %s.\n' "$ref" >&2; return 1; }
  printf '%s\n' "$pin"
}

wait_idle() {
  i=0
  while [ "$i" -lt "${DRAIN_ATTEMPTS:-120}" ]; do
    maintenance GET status | grep -Eq '"activeRuns"[[:space:]]*:[[:space:]]*0' && return 0
    i=$((i + 1)); sleep "${DRAIN_INTERVAL_SECONDS:-1}"
  done
  return 1
}

wait_ready() {
  container=$1 attempts=${2:-30}
  i=0
  while [ "$i" -lt "$attempts" ]; do
    if docker exec "$container" node -e "fetch('http://127.0.0.1:6969/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 2
  done
  return 1
}

wait_service_ready() {
  service=$1
  container=$(docker compose -f "$COMPOSE_FILE" ps -q "$service")
  [ -n "$container" ] && wait_ready "$container"
}
