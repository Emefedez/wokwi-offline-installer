# Wokwi Offline Suite — RC Car & Embedded Hardware Setup + TOML Generator

This repository (`/Users/m1-max/Documents/wokwi-offline-installer`) contains the complete offline Wokwi setup tool, MCP server, custom WebAssembly hardware chips, and the multi-mode (**GUI**, **TUI**, and **CLI**) `wokwi.toml` + `diagram.json` generator for **Windows** and **macOS**.

---

## 1. Executables & Supported Modes (GUI, TUI, CLI)

| Platform | Executable / Launcher | Description |
| :--- | :--- | :--- |
| **Windows (x86_64)** | `WokwiOfflineSetup.exe` / `install.bat` | Standalone native 64-bit Windows executable |
| **macOS (ARM64)** | `./wokwi-offline-setup-macos` / `./install.sh` | Standalone native Apple Silicon executable & shell script |

### Launch Modes

1. **GUI Mode (Default when launched without arguments or with `--gui`)**:
   ```bash
   # macOS
   ./wokwi-offline-setup-macos --gui
   # or: ./install.sh --gui

   # Windows
   WokwiOfflineSetup.exe --gui
   # or double-click WokwiOfflineSetup.exe / install.bat
   ```
   Opens the interactive **Hardware & TOML Generator + Offline Setup GUI** at `http://127.0.0.1:47130`, where you can:
   - Choose the **RC Car Preset (Default)**, **ESP32 Calculator Preset**, or **Custom** counts.
   - Set quantity **$N$** of each component (`0, 1, 2, 3, 4...`) with live power-rail calculations (`7.0V Servo Buck Rail`, `12V/24V Motor Bus`, `5.0V IP5306 Rail`, `3.3V ESP32-S3 Logic Rail`).
   - **Import Other / Custom Elements** (`.chip.json`, `.chip.wasm`, `.chip.c`, or custom Wokwi parts).
   - Preview and write `wokwi.toml`, `diagram.json`, and all required `.chip.wasm` + `.chip.json` files directly to any project folder.
   - Run the full **Offline Environment Setup** (install extension, disable extension auto-updates, extract `.wpk` bundle, save valid license key to `user.tok`, and register the MCP server in T3 Code, Anthropic, OpenCode, Codex, Antigravity, VS Code, Cursor, Zed).

2. **TUI Mode (`--tui` — Interactive Terminal UI)**:
   ```bash
   # macOS
   ./wokwi-offline-setup-macos --tui

   # Windows
   WokwiOfflineSetup.exe --tui
   ```
   Walks you interactively in the terminal through:
   - Full Offline Environment Setup (`.wpk` bundle, valid license key, MCP client installation)
   - Picking a preset (`rc-car`, `esp32calc`, `zero`), setting $N$ of each component, importing custom chips, and generating `wokwi.toml` + `diagram.json`.

3. **CLI Mode (`--cli` — Flag-Driven Automation)**:
   ```bash
   # Generate an RC Car project with custom N counts:
   ./wokwi-offline-setup-macos --cli \
     --preset rc-car \
     --counts "esp32_s3_n16r8=1,yb_p20m=2,jgb37_520=4,cjmcu_230=1,irf520_pwm=4,ip5306=1,reg_7v=1" \
     --out ./my-rc-car

   # Run full offline setup + MCP registration via CLI:
   ./wokwi-offline-setup-macos --cli \
     --bundle ~/.wokwi/bundle.wpk \
     --license ~/.wokwi/user.tok \
     --mcp "t3 anthropic opencode"
   ```

---

## 2. Bundled Hardware Elements (`tabla_piezas_voltajes_amperajes.pdf`)

All elements below are pre-compiled into WebAssembly custom chips (`.chip.wasm` + `.chip.json` + `.chip.c` in `hardware/`) using `wasi-sdk` and registered in `hardware/catalog.json`:

1. **YB-P20M High-Torque Digital Servo (`chip-yb_p20m`)**:
   - **Operating Voltage**: `6.0 – 7.4 V`
   - **Current-per-Torque Ratio**: `1.317 A / (N·m)` (`0.0093 A/oz-in`)
   - **Stall Current (Max)**: `≤ 3.6 A`
   - **Torque**: `2.7 N·m @ 7.4 V`
   - **Pins**: `["PWM", "VCC", "GND", "FB"]`
2. **JGB37-520 Geared DC Motor + Encoder (`chip-jgb37_520`)**:
   - **12 V Mode**: `120 mA` no-load, `400 mA` (`400` in sheet) load/stall
   - **24 V Mode**: `50 mA` no-load, `200 mA` (`200` in sheet) load/stall
   - **Pins**: `["M1", "M2", "GND", "C1", "C2", "VCC"]`
3. **ESP32-S3 N16R8 (`board-esp32-s3-devkitc-1`, 16MB Flash / 8MB PSRAM)**:
   - **VDD33**: `3.0 – 3.6 V` (Typ `3.3 V`), external supply `≥ 0.5 A`
   - **Cumulative IO Output Current**: `1500 mA` max (`-40 to 105 °C`)
4. **CJMCU-230 SN65HVD230 CAN Bus Transceiver (`chip-cjmcu_230`)**:
   - **Vcc**: `-0.3 V to 6 V` (Typ `3.3 V`)
   - **CANH / CANL Voltage**: `-4 V to 6 V`
   - **Digital Input/Output Voltage VI (D or R)**: `-0.5 V to (VCC + 0.5) V`
   - **Receiver Output Current IO**: `-11 mA to +11 mA`
   - **Pins**: `["D", "GND", "VCC", "R", "VREF", "CANL", "CANH", "RS"]`
5. **IRF520 PWM MOSFET Driver Module (`chip-irf520_pwm`)**:
   - **Drain-Source Voltage ($V_{DS}$)**: `100 V` max | **Gate-Source Voltage ($V_{GS}$)**: `±20 V`
   - **Continuous Drain Current ($I_D$)**: `9.2 A` ($T_C=25^\circ\text{C}$) / `6.5 A` ($T_C=100^\circ\text{C}$) | **Pulsed ($I_{DM}$)**: `37 A` | **$P_D$**: `60 W`
   - **Pins**: `["SIG", "VCC", "GND", "VIN", "VPLUS", "VMINUS"]`
6. **IP5306 Power Bank & Li-Ion PMIC (`chip-ip5306`)**:
   - **Port Input Voltage ($V_{IN}$)**: `-0.3 V to 5.5 V` | **Operating Temp**: `0 ~ 70 °C` | **$R_{\theta JA}$**: `50 °C/W` | **ESD HBM**: `4 kV`
   - **Pins**: `["VIN", "BAT", "VOUT", "GND", "KEY", "LED1", "LED2", "LED3", "LED4"]`
7. **7V Buck Voltage Regulator (`chip-reg_7v`)**:
   - **Wiring Answer (PDF Section 7)**: Input is **12–24 V** (from the main motor battery rail) and output is regulated **7.0 V** (`VOUT_POS`) to power the **YB-P20M servos** (`6–7.4 V`). Connect the servos' `PWM` and `FB` signal lines to the **ESP32-S3** (`3.3 V` GPIO) with a **shared common `GND`**.
   - **Pins**: `["VIN_POS", "VIN_NEG", "VOUT_POS", "VOUT_NEG", "EN"]`
8. **Optional Elements**: `ESP32-S3 N16R16`, `WeAct 2.13" B/W e-Paper Display (weact_213_bw)`, and `MicroSD Card (wokwi-microsd-card)`.

---

## 3. Disabling VS Code Extension Auto-Updates

1. **Automatic (Done by Setup)**:
   Running setup automatically writes `"extensions.autoUpdate": false` and `"extensions.autoCheckUpdates": false` into your VS Code `settings.json` (`~/Library/Application Support/Code/User/settings.json` on macOS, `%APPDATA%\Code\User\settings.json` on Windows).
2. **Manual Verification in VS Code**:
   - Open Settings (`Cmd+,` on macOS / `Ctrl+,` on Windows).
   - Search for `extensions.autoUpdate` and set **Extensions: Auto Update** to **`None`**.
   - Uncheck **Extensions: Auto Check Updates**.
   - In the Extensions sidebar (`Cmd+Shift+X` / `Ctrl+Shift+X`), right-click **Wokwi Simulator** and ensure **Auto Update** is **unchecked**.
