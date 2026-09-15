#!/bin/sh
# Wyoming zone bridge entrypoint. All the real logic lives in bridge.mjs
# (env validation, the Wyoming handshake, spawning + supervising
# snapclient); this just execs it as PID 1.

set -e

exec node /app/bridge.mjs
