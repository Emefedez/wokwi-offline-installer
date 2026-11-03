# Wokwi Embedded Simulator

Wokwi is an embedded systems and IoT simulator supporting ESP32, Arduino, and the Raspberry Pi Pico. Your code never leaves your computer - Wokwi runs the simulation inside VS Code, using the firmware binaries from your project.

<video src="https://wokwi.github.io/video-assets/vscode/wokwi-vscode-1s.mp4" autoplay muted loop></video>

## Features

- Supported architectures: RISC-V, ARM, Xtensa, and AVR.
- Huge library of electronic components: sensors, LEDs, LCDs, motors, relays, etc.
- Integration with ESP-IDF, PlatformIO, and Arduino.
- Virtual Logic Analyzer - Capture digital signals in your simulation (e.g. UART, I2C, SPI) and analyze them on your computer.
- Built-in WiFi Gateway that allows the simulated ESP32 to connect to the your local network and the internet, and use cloud services.
- Virtual Logic Analyzer - Capture digital signals in your simulation (e.g. UART, I2C, SPI).
- GDB integration - Debug your code using the VS Code debugger.

Please note that Wokwi for VS Code is a commercial product and requires a license after a free trial period.

## Usage

1. Follow the [Quick Start Guide](https://docs.wokwi.com/vscode/getting-started) to configure your project for Wokwi.
2. Open the Command Palette (F1 or Ctrl+Shift+P) and select "Wokwi: Start Simulator".

When you make changes to your project's code, rebuild it and Wokwi will automatically reload the new firmware and restart the simulation.

## Getting Help

- [Wokwi for VS Code documentation](https://docs.wokwi.com/vscode/getting-started)
- [Discord community](https://wokwi.com/discord)
- [GitHub issues](https://github.com/wokwi/wokwi-features/issues)

## Telemetry

This extension collects telemetry data to help us build a better product. The data is anonymous and does not include any personal information. The extension respects the `telemetry.enableTelemetry` setting in VS Code. To opt out of telemetry, set `"telemetry.enableTelemetry": false` in your VS Code settings.
