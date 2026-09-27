#!/bin/sh
# Built-image worker checks. Only disposable tmpfs and read-only test files mount.
set -eu
image=${1:?Usage: tests/docker_worker_acceptance.sh IMAGE}
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
name="olympus-worker-acceptance-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --rm --name "$name" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --tmpfs /opt/data:rw,nosuid,nodev,uid=10000,gid=10000,mode=700 \
  --mount "type=bind,src=$root/tests,dst=/fixtures,readonly" \
  -e HOME=/tmp/worker-fixture/home -e HERMES_HOME=/tmp/worker-fixture/home/.hermes \
  -e CODEX_HOME=/tmp/worker-fixture/codex -e LOCALAPPDATA=/tmp/worker-fixture/local \
  -e OLYMPUS_DISPATCH_HOME=/tmp/worker-fixture/olympus \
  -e DB_PATH=/tmp/worker-fixture/olympus/data/dispatch.db \
  -e OLYMPUS_DISPATCH_PROJECT_ROOT=/tmp/worker-fixture/projects \
  --entrypoint /opt/hermes/.venv/bin/python "$image" /fixtures/docker_worker_acceptance.py
