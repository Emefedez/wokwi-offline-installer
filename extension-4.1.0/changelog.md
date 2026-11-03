# Changelog

## 4.1.0 - 2026-10-23

- New "Stop Simulation" command (command palette and the Wokwi sidebar): stops the simulation and writes the SD card contents back when `writeback` is set

## 4.0.1 - 2026-10-18

- Fix a new GDB connection receiving a stale reply left over from the previous connection

## 4.0.0 - 2026-10-01

- SD card support (https://github.com/wokwi/wokwi-features/issues/581)
  - An `sdcard/` folder next to `wokwi.toml` is copied onto the simulated micro SD card at every start (no config needed)
  - New `[[sdcard]]` section in `wokwi.toml`: `folder` or `image` (raw disk image), `size` (`8M` default, up to `256M`), `writeback` (write the card contents back to the folder / image when the simulation stops or restarts), `part` (needed only with several cards)

## 3.7.0 - 2026-08-28

- Offer switching to offline mode when the simulator is slow to load (requires an offline license and a downloaded offline bundle)

## 3.6.1 - 2026-08-26

- Fix custom chips smaller than 4 KB failing to load
- Fix recompiled custom chips not being reloaded into a running simulation

## 3.6.0 - 2026-06-06

- ESP32-S31 simulation

## 3.5.0 - 2026-03-14

- ESP32-C61 simulation

## 3.4.1 - 2026-03-10

- Fix broken DNS in the Private IoT Gateway (for VS Code 1.111.0 and later)

## 3.4.0 - 2026-02-25

- Add privacy mode to hide personal info during streaming and presentations (https://github.com/wokwi/wokwi-features/issues/1087)
  - New setting: `wokwi.hidePersonalInfo` hides your name and email from the simulator toolbar, license info panel, and activation messages
  - New command: "Wokwi: Toggle Privacy Mode" for quick toggling via the command palette

## 3.3.0 - 2026-02-19

- Send individual ESP-IDF flash sections instead of merging into a single binary, fixing offset detection for chips like ESP32-C6

## 3.2.1 - 2026-01-29

- ESP32-P4 chip revision 1.0 support (esp32p4-eco2-20240710)

## 3.2.0 - 2026-01-25

- Add config option for logic analyzer (VCD file) export path (https://github.com/wokwi/wokwi-features/issues/561)

## 3.1.3 - 2026-01-23

- Bugfix: Don't open diagram editor in git diff views

## 3.1.2 - 2026-01-22

- Bugfix: Custom chips fail to load in offline mode

## 3.1.1 - 2026-01-21

- Add schema for custom chip JSON files (e.g., `mychip.chip.json`)

## 3.1.0 - 2025-12-08

- Update ESP32-P4 simulation to chip revision 3.1 (esp32p4-eco5-20250430)

## 3.0.0 - 2025-10-25

- Add a Wokwi sidebar with quick access to simulator commands and documentation links

## 2.8.0 - 2025-08-05

- Add support for offline installation of the extension (for Enterprise and Classroom customers)

## 2.7.0 - 2025-07-06

- Make the `elf` field in wokwi.toml optional

## 2.6.6 - 2025-06-07

- Bugfix: Simulation fails to start when the wokwi.toml file contains an empty `[[net.forward]]` section (https://github.com/wokwi/wokwi-features/issues/1014)

## 2.6.5 - 2025-03-02

- Bugfix: TCP connection to emulator device never disconnect (https://github.com/wokwi/wokwi-features/issues/856)

## 2.6.4 - 2025-02-21

- Bugfix: IoT Gateway module not available due to wrong file path

## 2.6.3 - 2025-02-20

- Bugfix: IoT Gateway fails to connect if a custom gateway URL is defined in wokwi.toml
- Show a proper error message when the IoT Gateway fails to connect

## 2.6.2 - 2025-02-20

- Bugfix: Fixed a regression where the extension failed to load

## 2.6.1 - 2025-02-20

- Bugfix: IoT gateway stops if a TCP connection is refused by the remote side

## 2.6.0 - 2024-12-10

- Update ESP32-P4 ROM to eco1 version (20240205)

## 2.5.6 - 2024-12-09

- When starting in debug mode, open the simulator in a side panel (so you can see the code and the simulator at the same time)

## 2.5.5 - 2024-11-16

- Bugfix: No error message when the `[wokwi]` section is missing from wokwi.toml (https://github.com/wokwi/wokwi-features/issues/913)

## 2.5.4 - 2024-10-14

- Bugfix: "Start Simulator and Wait for Debugger" does not indicate that gdbServerPort was not configured in wokwi.toml (https://github.com/wokwi/wokwi-features/issues/898)

## 2.5.3 - 2024-09-16

- Bugfix: Simulator tab doesn't retain its position when restarting the simulator (https://github.com/wokwi/wokwi-features/issues/880).

## 2.5.2 - 2024-08-28

- Bugfix: Simulator fails to show an error message where a firmware binary referenced from flasher_args.json is missing (https://github.com/wokwi/wokwi-features/issues/867).

## 2.5.1 - 2024-06-25

- Bugfix: GitHub Codespaces support

## 2.5.0 - 2024-06-08

- Support for multiple diagrams in the same directory, e.g. diagram.esp32.json, diagram.esp32c3.json, etc.

## 2.4.4 - 2024-05-02

- Bugfix: HTTP-GET request causes Wokwi for VS Code to hang (https://github.com/wokwi/wokwi-features/issues/768)

## 2.4.3 - 2024-03-07

- Bugfix: TCP connections are not properly closed by the Private IoT Gateway when terminated by the remote side (https://github.com/wokwi/wokwi-features/issues/747)

## 2.4.2 - 2024-02-24

- Add "Open in text editor" menu item to the diagram.json editor

## 2.4.1 - 2024-02-23

- Bugfix: Custom chips won't load in the diagram editor (https://github.com/wokwi/wokwi-features/issues/739)

## 2.4.0 - 2024-01-10

- ESP32-P4 simulation (early preview)

## 2.3.7 - 2024-01-08

- Improved support for VS Code virtual workspace folders
- Bugfix: auto reload doesn't work for PlatformIO projects

## 2.3.6 - 2024-01-07

- Bugfix: When starting the simulator from the diagram.json editor, the simulator does not always looks for the wokwi.toml file in the same folder as the diagram.json file.

## 2.3.5 - 2024-01-02

- Bugfix: The simulator fails to start in VS Code versions older than 1.82.0

## 2.3.4 - 2023-12-30

- Bugfix: The "Start Simulator" command does not restart the simulator if it's already running

## 2.3.3 - 2023-12-29

- Bugfix: Some of the board images do not load in offline mode

## 2.3.2 - 2023-12-27

- Bugfix: RFC2217/GDB servers do not close when the simulator is closed

## 2.3.1 - 2023-12-26

- Bugfix: A race condition may cause the simulator to consume large amounts of CPU / network bandwidth when working on a remote workspace or in WSL. The issue was introduced in v2.3.0.

## 2.3.0 - 2023-12-24

- Offline mode: use Wokwi without an internet connection! (for paying users)

Merry Christmas! 🎄

## 2.2.0 - 2023-12-19

- Performance: bundle ESP32 ROMs with the extension, speeding up the initial load time

## 2.1.2 - 2023-12-18

- Bugfix: diagram.json editor won't load if the firmware file is missing

## 2.1.1 - 2023-12-07

- Bugfix: Simulator does not auto reload the firmware when the firmware file changes

## 2.1.0 - 2023-12-06

- Use VS Code's built-in terminal for Wokwi's virtual serial port output

## 2.0.1 - 2023-12-05

- Bugfix: GDB server does not close when the simulator is closed

## 2.0.0 - 2023-12-03

- Interactive diagram editor for paying users. Open diagram.json to try it out!

## 1.5.0 - 2023-10-01

- Improved support for ESP-IDF projects: specify 'build/flasher_args.json' in wokwi.toml to automatically load your app's bootloader, partition table, and firmware into the simulator.

## 1.4.0 - 2023-08-08

- API for selecting the active configuration file (https://github.com/wokwi/wokwi-features/issues/631)

## 1.3.5 - 2023-07-06

- Select config should only show relative paths (https://github.com/wokwi/wokwi-features/issues/614)

## 1.3.4 - 2023-06-21

- Bugfix: simulator does not reload diagram.json (https://github.com/wokwi/wokwi-features/issues/601)

## 1.3.3 - 2023-05-07

- Update license file: link to terms of use, open source license list.

## 1.3.2 - 2023-03-18

- Validate diagram.json before starting simulation and show a proper error message if the file is invalid.

## 1.3.1 - 2023-02-24

- Initial support for running inside GitHub Codespaces

## 1.3.0 - 2023-02-16

- Support for the exposing serial port over TCP (RFC2217) using the "rfc2217ServerPort" configuration option.

## 1.2.0 - 2023-02-05

- Support for using an external IoT Gateway

## 1.1.1 - 2023-01-29

- Show an error message when the GDB server port is already in use
- Show an error message when a TCP net forwarding port is already in use

## 1.1.0 - 2023-01-27

- Support for multiple wokwi.toml files in the same workspace. Use "Wokwi: Select Config File" to select the active simulator configuration.

## 1.0.5 - 2023-01-26

- Add "Start Simulator and Wait For Debugger" command

## 1.0.4 - 2023-01-25

- Speed up GDB sessions by disabling Nagle's algorithm

## 1.0.3 - 2023-01-24

- Add "Edit wokwi.toml" button to "firmware not found" error dialog
- UF2 firmware support for ESP32 simulations
- Initial support for the ESP32-C6 chip

## 1.0.2 - 2023-01-21

- Improve "missing wokwi.toml" error message

## 1.0.1 - 2023-01-16

- Show proper error message when offline

## 1.0.0 - 2023-01-15

Initial public release.
