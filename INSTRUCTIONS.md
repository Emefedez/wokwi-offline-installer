# Wokwi Offline Suite & Hardware Elements Installer — Instructions

This folder (`/Users/m1-max/Documents/wokwi-offline-installer`) is a self-contained installer package for your air-gapped / offline hardware testing workflow.

---

## 1. What Is Included in This Folder

```text
wokwi-offline-installer/
├── install.sh                      # Interactive & CLI installer script
├── setup-bundle-and-settings.js    # Bundle (.wpk) extractor, license writer, and VS Code settings helper
├── INSTRUCTIONS.md                 # This guide
├── extension/                      # Wokwi VS Code Extension (4.1.0) with:
│   └── dist/extension.js           #   - Automatic Offline Mode launch (no cloud iframe timeout)
│                                   #   - Backported localhost MCP Bridge (127.0.0.1:47129)
├── mcp/                            # Wokwi Offline MCP Server & Multi-Client Installer
│   ├── server.js                   #   - Zero-dependency Node.js MCP server
│   ├── install-mcp.sh              #   - Installer for T3 Code, Anthropic, OpenCode, Codex, etc.
│   └── assets/                     #   - Offline wokwi-api.h, diagram.schema.json, chip.schema.json
└── hardware/                       # Pre-packaged ESP32Calc Hardware Elements:
    ├── diagram.json                #   - ESP32-S3 (16MB Flash / 16MB PSRAM), WeAct EPD, SD card, Keypad
    ├── wokwi.toml                  #   - Firmware, ELF, and custom chip config
    ├── weact_213_bw.chip.json      #   - WeAct 2.13" B/W e-Paper Display (128x250) definition
    ├── weact_213_bw.chip.wasm      #   - Compiled WebAssembly binary for the e-Paper display
    ├── partitions.csv              #   - ESP32-S3 partition table
    ├── flasher_args.json           #   - ESP-IDF multi-partition flasher configuration
    ├── sdcard/                     #   - Seeded MicroSD card directory (/sdcard/config, /sdcard/programs)
    └── scenarios/                  #   - Automated test scenarios (solve-linear.yaml, keypad-press-only.yaml)
```

---

## 2. Running the Installer

### Interactive Mode (Recommended)
Run the installer from a terminal and follow the prompts:

```bash
cd /Users/m1-max/Documents/wokwi-offline-installer
./install.sh
```

During interactive setup, the script will:
1. Install the offline-first Wokwi extension into `~/.vscode/extensions/wokwi.wokwi-vscode-4.1.0`.
2. Automatically disable VS Code extension auto-updates so your extension is never overwritten.
3. Install the ESP32-S3 + WeAct 2.13" e-Paper screen + SD + Keypad elements into `~/.wokwi/hardware-elements/` (and optionally copy them into a project folder of your choice).
4. Ask which AI tools you want to register the Wokwi MCP server in (`t3`, `anthropic`, `opencode`, `codex`, `antigravity`, `vscode`, `cursor`, `zed`, `all`, or `none`).
5. Prompt for the path to your `.wpk` offline bundle (e.g. `~/.wokwi/bundle.wpk`) and extract it into the extension's `.cache` directory.
6. Prompt for your valid Wokwi license key (or path to `user.tok`) and save it to `~/.wokwi/user.tok`.

### Non-Interactive / Automated CLI Mode
You can also pass all options via flags for automated provisioning across machines:

```bash
./install.sh \
  --mcp "t3 anthropic opencode" \
  --bundle /Users/m1-max/.wokwi/bundle.wpk \
  --license /Users/m1-max/.wokwi/user.tok \
  --project /Users/m1-max/Documents/ESP32Calc/ESP32Calc/XCasFW \
  --non-interactive
```

---

## 3. Disabling Auto-Update for Extensions in VS Code

Keeping VS Code from auto-updating extensions is critical so it does not overwrite the backported MCP bridge and automatic offline-mode launch in `wokwi.wokwi-vscode-4.1.0`.

### A. Automatic (Done by `install.sh`)
`install.sh` automatically sets the following in `~/Library/Application Support/Code/User/settings.json`:

```json
{
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false
}
```

### B. Manual Verification in VS Code UI
1. Open **Visual Studio Code**.
2. Press `Cmd + ,` to open **Settings**.
3. Search for `extensions.autoUpdate` and set **Extensions: Auto Update** to **`None`** (`false`).
4. Search for `extensions.autoCheckUpdates` and uncheck **Extensions: Auto Check Updates**.
5. Open the **Extensions** sidebar (`Cmd + Shift + X`), right-click **Wokwi Simulator**, and ensure **Auto Update** is **unchecked**.

---

## 4. Loading the Offline Bundle (`.wpk`) & Valid License

### Option 1: Via the Installer Script
Run:
```bash
./install.sh --bundle /path/to/bundle.wpk --license "YOUR_VALID_WOKWI_LICENSE_KEY"
```

### Option 2: Inside VS Code
1. Open the Command Palette (`Cmd + Shift + P`).
2. Run **`Wokwi: Manually Enter License Key`** and paste your valid Wokwi license key.
3. Run **`Wokwi: View License Information`** and click **Install Offline Bundle** (or **Update Offline Bundle**) to select your `.wpk` file.

Once both a valid offline license and the extracted `.wpk` bundle are present, opening `diagram.json` or running **`Wokwi: Start Simulator`** will **immediately launch in Offline Mode** (`Wokwi Simulator (Offline)`) without attempting to load the online `wokwi.com` iframe.

---

## 5. How the Extension + MCP Architecture Works

- **VS Code Extension (`wokwi.wokwi-vscode-4.1.0`)**:
  - Automatically opens in **Offline Mode** whenever your valid license and offline bundle are present.
  - Runs a local MCP Bridge on `http://127.0.0.1:47129/mcp` on startup so local AI agents can start/stop/restart simulations, read/write UART serial output, press buttons (`wokwi_set_control`), and export VCD captures directly against the running offline simulator.
- **Wokwi MCP Server (`~/.wokwi/mcp/server.js`)**:
  - Connects to the VS Code Extension Bridge (`127.0.0.1:47129`) or `rfc2217ServerPort` for offline simulations, and falls back to `wokwi-cli` when online.
  - Handles network/gateway configuration via `wokwi_configure_network` (setting up `[net]` and `[[net.forward]]` TCP port forwarding in `wokwi.toml`).
  - Compiles custom chips 100% offline (`wokwi_chip_compile`) using `~/.wokwi/wasi-sdk` and the bundled `wokwi-api.h`.
  - Lints and edits `diagram.json` 100% offline (`wokwi_lint_diagram`, `wokwi_edit_diagram`).
  - Provisions the ESP32-S3 + WeAct 2.13" e-Paper screen + SD card + keypad hardware template into any project via `wokwi_provision_hardware`.
