#!/bin/sh
set -eu
# Supports --dry-run.
. "$(dirname "$0")/lib.sh"; parse_common "$@"
compose ps
if [ "$DRY_RUN" != 1 ]; then curl --fail --silent --show-error "http://127.0.0.1:${OLYMPUS_DISPATCH_PORT:-6969}/api/ready"; printf '\n'; fi
