#!/usr/bin/env bash
set -euo pipefail

INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
SETUP_BIN="${INSTALLER_DIR}/wokwi-offline-toolkit-macos"
if [ "${OS_NAME}" = "Linux" ]; then
  if [ "${ARCH_NAME}" = "aarch64" ] || [ "${ARCH_NAME}" = "arm64" ]; then
    SETUP_BIN="${INSTALLER_DIR}/wokwi-offline-toolkit-linux-arm64"
  else
    SETUP_BIN="${INSTALLER_DIR}/wokwi-offline-toolkit-linux-amd64"
  fi
fi

for arg in "$@"; do
  case "$arg" in
    --gui|--tui|--cli|--preset|--counts|--out|--load-user-tok|--overwrite-user-tok|--ext-version)
      exec "${SETUP_BIN}" "$@"
      ;;
  esac
done

WOKWI_HOME="${HOME}/.wokwi"
EXT_VERSION="${WOKWI_EXT_VERSION:-3.7.0}"
VSCODE_EXT_DIR="${HOME}/.vscode/extensions/wokwi.wokwi-vscode-${EXT_VERSION}"
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE_BIN="/opt/homebrew/bin/node"
else
  NODE_BIN="node"
fi

MCP_TARGETS=""
BUNDLE_PATH=""
LICENSE_INPUT=""
TARGET_PROJECT=""
NON_INTERACTIVE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mcp)
      MCP_TARGETS="$2"
      shift 2
      ;;
    --bundle)
      BUNDLE_PATH="$2"
      shift 2
      ;;
    --license)
      LICENSE_INPUT="$2"
      shift 2
      ;;
    --project)
      TARGET_PROJECT="$2"
      shift 2
      ;;
    -y|--non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    -h|--help)
      echo "Usage: ./install.sh [options]"
      echo ""
      echo "Options:"
      echo "  --mcp \"<targets>\"    MCP clients to configure (e.g. \"t3 anthropic opencode all\" or \"none\")"
      echo "  --bundle <path>      Path to offline bundle.wpk file"
      echo "  --license <key|file> Valid Wokwi license key or path to user.tok file"
      echo "  --project <dir>      Optional target project directory to copy ESP32-S3 + EPD elements into"
      echo "  -y, --non-interactive Run with defaults without interactive prompts"
      exit 0
      ;;
    *)
      shift
      ;;
  esac
done

echo "=================================================================="
echo "  Wokwi Offline Suite & Hardware Elements Installer (v4.1.0-MCP)"
echo "=================================================================="
echo ""

# 1. Install Wokwi VS Code Extension (with auto-offline mode & backported MCP bridge)
echo "[1/5] Installing Wokwi VS Code Extension (Offline-First + MCP Bridge)..."
mkdir -p "${VSCODE_EXT_DIR}" "${WOKWI_HOME}/bin" "${WOKWI_HOME}/mcp" "${WOKWI_HOME}/hardware-elements"
cp -R "${INSTALLER_DIR}/extension/"* "${VSCODE_EXT_DIR}/"
echo "[+] Installed extension to ${VSCODE_EXT_DIR}"

# Disable VS Code extension auto-update so our offline-first extension is not overwritten
"${NODE_BIN}" "${INSTALLER_DIR}/setup-bundle-and-settings.js" disable-autoupdate

# 2. Install Wokwi Offline MCP Server & Hardware Elements Library
echo ""
echo "[2/5] Installing Wokwi Offline MCP Server & ESP32-S3 + Screen Elements..."
cp -R "${INSTALLER_DIR}/mcp/"* "${WOKWI_HOME}/mcp/"
chmod +x "${WOKWI_HOME}/mcp/server.js" "${WOKWI_HOME}/mcp/install-mcp.js" "${WOKWI_HOME}/mcp/install-mcp.sh"
ln -sf "${WOKWI_HOME}/mcp/server.js" "${WOKWI_HOME}/bin/wokwi-mcp"
ln -sf "${WOKWI_HOME}/mcp/install-mcp.sh" "${WOKWI_HOME}/bin/install-wokwi-mcp"

cp -R "${INSTALLER_DIR}/hardware/"* "${WOKWI_HOME}/hardware-elements/"
echo "[+] Installed hardware elements into ${WOKWI_HOME}/hardware-elements:"
echo "    - ESP32-S3 (board-esp32-s3-devkitc-1, 16MB Flash / 16MB PSRAM)"
echo "    - WeAct 2.13\" B/W e-Paper Screen (weact_213_bw.chip.json + weact_213_bw.chip.wasm)"
echo "    - MicroSD Card (wokwi-microsd-card + sdcard/ seed tree)"
echo "    - Calculator Keypad Matrix + Slide Potentiometer (diagram.json + scenarios/)"

if [ -z "${TARGET_PROJECT}" ] && [ "${NON_INTERACTIVE}" -eq 0 ]; then
  echo ""
  read -r -p "Optional: Enter a project folder path to copy these hardware elements into (or press Enter to skip): " TARGET_PROJECT
fi

if [ -n "${TARGET_PROJECT}" ]; then
  mkdir -p "${TARGET_PROJECT}"
  cp -R "${INSTALLER_DIR}/hardware/"* "${TARGET_PROJECT}/"
  echo "[+] Copied ESP32-S3 + WeAct EPD screen + keypad elements into ${TARGET_PROJECT}"
fi

# 3. Configure MCP Clients if wanted
echo ""
echo "[3/5] MCP Client Registration"
if [ -z "${MCP_TARGETS}" ] && [ "${NON_INTERACTIVE}" -eq 0 ]; then
  echo "Available AI clients: t3, anthropic, claude-code, claude-desktop, opencode, codex, antigravity, vscode, cursor, zed, all, none"
  read -r -p "Which tools should we install the Wokwi MCP into? [default: t3 anthropic]: " MCP_TARGETS
  if [ -z "${MCP_TARGETS}" ]; then
    MCP_TARGETS="t3 anthropic"
  fi
fi

if [ -n "${MCP_TARGETS}" ] && [ "${MCP_TARGETS}" != "none" ]; then
  # shellcheck disable=SC2086
  "${WOKWI_HOME}/mcp/install-mcp.sh" install ${MCP_TARGETS}
else
  echo "[-] Skipping MCP client registration (run ~/.wokwi/mcp/install-mcp.sh later if needed)."
fi

# 4. Ask for Offline Bundle (.wpk) to load
echo ""
echo "[4/5] Offline Simulation Bundle (.wpk)"
DEFAULT_BUNDLE="${WOKWI_HOME}/bundle.wpk"
if [ -z "${BUNDLE_PATH}" ] && [ "${NON_INTERACTIVE}" -eq 0 ]; then
  if [ -f "${DEFAULT_BUNDLE}" ]; then
    read -r -p "Enter path to offline bundle.wpk to load [default: ${DEFAULT_BUNDLE}]: " BUNDLE_PATH
    BUNDLE_PATH="${BUNDLE_PATH:-${DEFAULT_BUNDLE}}"
  else
    read -r -p "Enter path to offline bundle.wpk to load: " BUNDLE_PATH
  fi
elif [ -z "${BUNDLE_PATH}" ] && [ -f "${DEFAULT_BUNDLE}" ]; then
  BUNDLE_PATH="${DEFAULT_BUNDLE}"
fi

if [ -n "${BUNDLE_PATH}" ]; then
  "${NODE_BIN}" "${INSTALLER_DIR}/setup-bundle-and-settings.js" install-bundle "${BUNDLE_PATH}"
else
  echo "[!] No bundle.wpk provided. You can load one later via './install.sh --bundle /path/to/bundle.wpk'."
fi

# 5. Ask for Valid Wokwi License Key or user.tok
echo ""
echo "[5/5] Wokwi License Setup"
DEFAULT_TOK="${WOKWI_HOME}/user.tok"
if [ -z "${LICENSE_INPUT}" ] && [ "${NON_INTERACTIVE}" -eq 0 ]; then
  if [ -f "${DEFAULT_TOK}" ]; then
    read -r -p "Enter your valid Wokwi license key or path to user.tok [default: ${DEFAULT_TOK}]: " LICENSE_INPUT
    LICENSE_INPUT="${LICENSE_INPUT:-${DEFAULT_TOK}}"
  else
    read -r -p "Enter your valid Wokwi license key or path to user.tok: " LICENSE_INPUT
  fi
elif [ -z "${LICENSE_INPUT}" ] && [ -f "${DEFAULT_TOK}" ]; then
  LICENSE_INPUT="${DEFAULT_TOK}"
fi

if [ -n "${LICENSE_INPUT}" ]; then
  "${NODE_BIN}" "${INSTALLER_DIR}/setup-bundle-and-settings.js" save-license "${LICENSE_INPUT}"
else
  echo "[!] No license entered. You can enter it in VS Code via 'Wokwi: Manually Enter License Key'."
fi

echo ""
echo "=================================================================="
echo "  Installation Complete!"
echo "  - Extension opens automatically in Offline Mode when bundle + license are present"
echo "  - MCP Bridge listens on 127.0.0.1:47129 inside VS Code"
echo "  - VS Code extension auto-update has been disabled"
echo "  - See ${INSTALLER_DIR}/INSTRUCTIONS.md for full usage details"
echo "=================================================================="
