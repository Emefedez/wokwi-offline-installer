# Wokwi Offline Suite — 3-Step Guided Setup & Hardware TOML Generator

This repository contains the complete offline Wokwi setup tool, dual-version patched VS Code extension (`v3.7.0` and `v4.1.0`), pre-bundled internal testing offline simulator bundle (`files/bundle.wpk`) & license (`files/user.tok`), local MCP server (`127.0.0.1:47129/mcp`), custom WebAssembly hardware chips, and the multi-mode (**GUI**, **TUI**, and **CLI**) `wokwi.toml` + `diagram.json` generator for **Windows**, **macOS**, and **Linux** (`x86_64` & `ARM64`).

---

## Guided 3-Step GUI Workflow Screenshots

### Step 1: Install Wokwi Extension (`v3.7.0` / `v4.1.0`) & Auto-Load Offline Bundle (`bundle.wpk`)
First installs the patched Wokwi VS Code extension, disables extension auto-updates, and automatically loads/extracts the bundled internal testing `bundle.wpk` (`files/bundle.wpk` -> `~/.wokwi/bundle.wpk`, or lets you pick another `.wpk` file):

![Step 1: Install Extension & Load bundle.wpk](docs/screenshots/gui-step1-install-extension-bundle.png)

### Step 2: Auto-Loaded Internal Testing License (`user.tok`) — Or Pick Another If Wanted
Automatically fetches and activates the internal testing license (`user@wokwi.com`, Plan: `pro`, Expires: `99991231`) into `~/.wokwi/user.tok`, and lets you optionally pick or overwrite with another `.tok` file without any LLM:

![Step 2: Load user.tok License](docs/screenshots/gui-step2-load-usertok.png)

### Step 3: Choose Hardware Elements (`N` of Each) & Generate `wokwi.toml` + `diagram.json`
Choose what components to add to `wokwi.toml` and `diagram.json` (with presets for the RC Car or ESP32 Calculator, custom $N$ quantities, live electrical/power rail calculations, and custom `.chip.wasm` / `.chip.json` importing):

![Step 3: Choose Hardware & Generate wokwi.toml](docs/screenshots/gui-step3-hardware-toml-generator.png)
