#!/bin/sh
# Keep Node and native helpers in the root-owned installation, not a user cache.
runtime=${0%/*}/../lib/emcli
exec "$runtime/bin/node" "$runtime/app/dist/main.js" "$@"
