# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Wokwi for VS Code is a commercial embedded systems and IoT simulator extension that runs simulations locally inside VS Code. It supports ESP32, Arduino, Raspberry Pi Pico, and other microcontroller platforms (RISC-V, ARM, Xtensa, AVR architectures). The extension provides features like GDB debugging integration, WiFi gateway simulation, virtual logic analyzer, and RFC2217 serial port access.

## Build Commands

```bash
# Build both extension and webviews
npm run compile

# Build for production
npm run package

# Watch mode - rebuilds both extension and webviews in parallel
npm run watch

# Watch only extension
npm run watch:extension

# Watch only webviews
npm run watch:webview

# Lint the code
npm run lint
```

The project uses two separate Vite builds:
- Extension build (`vite.config.ts`) - Builds the main extension code
- Webview build (`vite.webview.config.ts`) - Builds React-based webviews

Watch mode uses `concurrently` to run both builds in parallel for efficient development.

## Testing

```bash
# Run all tests (both unit tests with vitest and integration tests)
npm test

# Run only unit tests with vitest
npm run test:watch

# Watch mode for unit tests
npm run test:watch

# Compile tests only
npm run compile-tests
```

Unit tests use Vitest and are located in `*.spec.ts` files throughout the codebase (e.g., `src/detect/espBinary.spec.ts`, `src/license/license.spec.ts`). Integration tests use Mocha and are in `src/test/suite/`.

For end-to-end visual testing with a running simulation, see `docs/agent-testing.md` (uses code-server + Playwright MCP tools). You should always conduct end-to-end visual testing after making changes to the simulator or webview code to ensure the full experience works correctly.

## Architecture

### Core Session Management

The extension's lifecycle centers around two main session types:

- **WokwiSession** (`src/simulator/WokwiSession.ts`): The primary simulation session that manages the simulator runtime, firmware loading, GDB server, serial communication, WiFi gateway, and file watching. It acts as the central orchestrator for all simulator functionality. Uses a singleton pattern (`createSingleton()`) to ensure only one simulation runs at a time.

- **EditorSession** (`src/simulator/EditorSession.ts`): Manages the diagram editor experience when users edit `diagram.json` files in the custom editor. Handles bidirectional synchronization between the visual editor and text document.

### Key Subsystems

1. **Configuration System** (`src/config/`):
   - `ConfigService`: Singleton service that manages `wokwi.toml` configuration file location and parsing
   - `WokwiConfig`: Type definitions for the TOML configuration structure
   - `autoconfig`: Auto-detection logic for project types

2. **License Management** (`src/license/`):
   - `LicenseService`: Handles license storage and retrieval from VS Code's secret storage
   - License validation and expiration checking happens at session creation
   - Supports both manual entry and URI-based activation (via `vscode://` protocol)

3. **WiFi Gateway** (`src/wokwigw/` and `src/net/`):
   - `WokwiGW`: WebAssembly-based network gateway (`engine.wasm`) that enables simulated devices to access the network
   - Supports TCP port forwarding from simulated device to local/remote endpoints
   - `WebSocketGateway`: Alternative websocket-based gateway for external services

4. **GDB Integration** (`src/gdb/GDBServer.ts`):
   - Implements a GDB remote protocol server
   - Bidirectional communication between VS Code debugger and simulated device
   - Port configured via `gdbServerPort` in `wokwi.toml`

5. **Serial Communication** (`src/serial/`):
   - `RFC2217Server`: Implements RFC2217 protocol for remote serial port access
   - Integrated terminal display using VS Code's Pseudoterminal API
   - Bidirectional UART data flow between simulator and external tools

6. **Firmware Loading** (`src/firmware/`):
   - `EspIdfFirmware`: Specialized loader for ESP-IDF `flasher_args.json` format
   - Supports multiple firmware formats: raw binary, HEX, UF2
   - File watching system automatically reloads firmware when files change

7. **Diagram Editor** (`src/diagram/`):
   - `DiagramEditorProvider`: Custom editor provider for `diagram.json` files
   - Visual circuit diagram editing with schema validation (`schemas/diagram.schema.json`)
   - Supports `diagram.json` and `diagram.*.json` filename patterns

8. **Project Detection** (`src/detect/`):
   - Auto-detection of project types (ESP-IDF, PlatformIO, Arduino, etc.)
   - ESP binary format detection and validation

9. **Custom Chips** (`src/chips/loadChips.ts`):
   - Support for loading custom chip binaries and JSON configurations
   - Watches chip files and auto-reloads on changes

### UI Architecture

- **WokwiPanel** (`src/ui/WokwiPanel.ts`): Manages the webview panel lifecycle for the simulator
- **WokwiWebview** (`src/ui/WokwiWebview.ts`): Handles webview HTML generation and CSP configuration
- **WokwiExplorerProvider** (`src/ui/WokwiExplorer.ts`): Tree data provider for the sidebar view, displays context-sensitive actions based on license and session state

### Webview Architecture (React)

The extension uses React with the VS Code Webview UI Toolkit for building interactive webviews:

- **Technology Stack**:
  - React 19 with TypeScript
  - `@vscode/webview-ui-toolkit` for VS Code-native components (VSCodeButton, VSCodeBadge, etc.)
  - Vite for building and bundling
  - Separate build pipeline from main extension code

- **Webview Structure** (`src/webview/`):
  - Each webview is a standalone React application
  - Entry point: `*.tsx` file (e.g., `licenseInfo.tsx`)
  - Main component: `*App.tsx` (e.g., `LicenseInfoApp.tsx`)
  - Styles: `*.css` files using VS Code CSS variables for theming
  - Built to `dist/webview/` directory

- **Communication Pattern**:
  - Extension → Webview: `webview.postMessage()` sends data
  - Webview → Extension: `vscode.postMessage()` sends commands
  - Webviews use `acquireVsCodeApi()` to get VS Code API instance
  - Message types defined in panel classes (e.g., `LicenseInfoPanel`)

- **Current Webviews**:
  - **License Info Panel** (`LicenseInfoPanel` / `LicenseInfoApp`): Displays license details, plan information, and offline bundle version

### Extension Activation

The main entry point is `src/extension.ts`. On activation:
1. Initializes ConfigService, LicenseService, UpdateService
2. Registers commands (`wokwi-vscode.start`, `wokwi-vscode.startAndWait`, etc.)
3. Sets up URI handler for license activation
4. Registers custom diagram editor provider

### Message Flow

Communication between the extension and simulator webview uses a command-based message protocol:
- Extension → Webview: `start`, `gdbMessage`, `gdbBreak`, `uartData`, `wifiFrame`, etc.
- Webview → Extension: `start` (ready signal), `gdbResponse`, `uartData`, `wifiConnect`, `wifiFrame`, `chipOutput`, etc.

Messages are processed in `WokwiSession.processMessage()` and sent via `WokwiSession.writeToWokwi()`.

### File Watching Strategy

The extension uses VS Code's FileSystemWatcher to monitor:
- Firmware files (binary, HEX, UF2, or `flasher_args.json`)
- ESP-IDF flasher dependencies (bootloader, partition table, app binaries)
- Custom chip binaries and JSON files
- Automatically triggers simulation restart when files change

## Important Configuration

- `wokwi.toml`: Required configuration file that must exist in the project root
  - `[wokwi]` section with `firmware` path (required)
  - Optional: `gdbServerPort`, `rfc2217ServerPort`, `elf` path
  - Optional: `[net]` section for gateway and port forwarding configuration
  - Optional: `[chip.*]` sections for custom chip definitions

- `diagram.json`: Circuit diagram definition (required for simulation)
  - Schema validation provided via JSON schema in `schemas/diagram.schema.json`
  - Can use alternative naming: `diagram.*.json`

## Webview postMessage Binary Transfer Pitfall

VS Code's webview `postMessage()` serializer extracts `ArrayBuffer` and typed array instances for efficient binary transfer. It walks the entire message tree with `JSON.stringify`, detects `instanceof ArrayBuffer` and `ArrayBuffer.isView()`, and replaces them with `$vscode_array_buffer_reference$` placeholders while transferring the raw bytes separately.

**The pitfall**: Node.js `Buffer` extends `Uint8Array`, but `Buffer.constructor.name === "Buffer"`. The serializer's type mapper has a switch on constructor name that includes `"Uint8Array"`, `"Int8Array"`, etc. but NOT `"Buffer"`. When it encounters a Buffer, it falls through and `Buffer.toJSON()` produces `{type: "Buffer", data: [bytes...]}` -- a plain JSON object with a byte array, not an efficient binary transfer.

This affects `vscode.workspace.fs.readFile()`, which returns `Uint8Array` that is actually a `Buffer` instance in Node.js.

**Fix**: Always convert to a proper `ArrayBuffer` before including binary data in webview messages:
```ts
const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
```

This applies to any nesting level -- the serializer walks the full object tree, so `ArrayBuffer` inside arrays or nested objects is handled correctly.

## Development Notes

- The extension bundles a WebAssembly gateway (`engine.wasm`) and ESP32 ROM files at build time (see `vite.config.ts` copy-assets plugin)
- Uses Vite for bundling with CommonJS output format (VS Code requirement)
- Build constants are injected via Vite's `define` option: `_buildConst.extVersion` and `_buildConst.extGitHash`
- External Node.js modules (fs, path, vscode, etc.) are marked as external in Vite config
- TypeScript strict mode is enabled with additional checks for unused parameters and implicit returns
- The extension respects VS Code's `telemetry.enableTelemetry` setting for analytics
