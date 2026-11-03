#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
node "$HOME/.wokwi/firmware-fallbacks/pio-fallback.js" run -e esp32-s3-wokwi "$@"
