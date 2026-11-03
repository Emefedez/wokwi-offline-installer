#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /opt/homebrew/bin/node "${SCRIPT_DIR}/install-mcp.js" "$@"
