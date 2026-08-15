#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${HTTP_PROXY:-}${http_proxy:-}${HTTPS_PROXY:-}${https_proxy:-}${ALL_PROXY:-}${all_proxy:-}" ]; then
    export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"
fi

exec node "$SCRIPT_DIR/wechat_draft.mjs" "$@"
