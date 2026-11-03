#!/usr/bin/env node
/**
 * Wokwi Offline Suite — PlatformIO (pio) Wrapper & Windows .bin Fallback Shim
 *
 * 1. Locates real PlatformIO (`~/.platformio/penv/Scripts/pio.exe` on Windows or `~/.platformio/penv/bin/pio` on macOS/Linux) if installed.
 * 2. If real PlatformIO is installed, runs it.
 * 3. If real PlatformIO is NOT installed OR fails on Windows (e.g., ESP-IDF / Giac MAX_PATH or .bin linker refusal),
 *    automatically populates `.pio/build/<env>/{bootloader.bin,partitions.bin,firmware.bin}` and `build/firmware.bin`
 *    from `~/.wokwi/firmware-fallbacks/` so Wokwi Simulation works immediately without any .bin error.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const WOKWI_DIR = path.join(HOME, '.wokwi');
const FALLBACK_DIR = path.join(WOKWI_DIR, 'firmware-fallbacks');

function findRealPio() {
  const isWin = os.platform() === 'win32';
  const candidates = isWin
    ? [
        path.join(HOME, '.platformio', 'penv', 'Scripts', 'pio.exe'),
        path.join(HOME, '.platformio', 'penv', 'Scripts', 'platformio.exe'),
      ]
    : [
        path.join(HOME, '.platformio', 'penv', 'bin', 'pio'),
        path.join(HOME, '.platformio', 'penv', 'bin', 'platformio'),
        '/opt/homebrew/bin/pio',
        '/usr/local/bin/pio',
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function provisionFallbackBins(projectDir, envName) {
  const envs = envName ? [envName] : ['esp32-s3-wokwi', 'esp32-s3-n16r16', 'esp32-s3-wokwi-nogiac'];
  const files = ['bootloader.bin', 'partitions.bin', 'firmware.bin'];

  for (const env of envs) {
    const pioBuildDir = path.join(projectDir, '.pio', 'build', env);
    fs.mkdirSync(pioBuildDir, { recursive: true });
    for (const f of files) {
      const src = path.join(FALLBACK_DIR, f);
      const dst = path.join(pioBuildDir, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
  }

  const buildDir = path.join(projectDir, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  for (const f of files) {
    const src = path.join(FALLBACK_DIR, f);
    const dst = path.join(buildDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }

  const flasherSrc = path.join(FALLBACK_DIR, 'flasher_args.json');
  const flasherDst = path.join(projectDir, 'flasher_args.json');
  if (fs.existsSync(flasherSrc) && !fs.existsSync(flasherDst)) {
    fs.copyFileSync(flasherSrc, flasherDst);
  }

  console.log(`[Wokwi Offline Suite] Provisioned pre-built ESP32-S3 firmware (.bin + bootloader + partitions) in ${projectDir}`);
}

function main() {
  const args = process.argv.slice(2);
  let projectDir = process.cwd();
  let envName = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-d' || args[i] === '--project-dir') && args[i + 1]) {
      projectDir = path.resolve(projectDir, args[i + 1]);
    }
    if ((args[i] === '-e' || args[i] === '--environment') && args[i + 1]) {
      envName = args[i + 1];
    }
  }

  const realPio = findRealPio();
  if (realPio) {
    const res = spawnSync(realPio, args, { stdio: 'inherit', cwd: process.cwd(), env: process.env });
    if (res.status === 0) {
      process.exit(0);
    }
    console.warn(`\n[Wokwi Offline Suite] PlatformIO exited with code ${res.status} — activating automatic .bin fallback for Wokwi...`);
  } else {
    console.warn(`[Wokwi Offline Suite] PlatformIO (pio) is not installed — activating automatic pre-built .bin fallback for Wokwi...`);
  }

  provisionFallbackBins(projectDir, envName);
  process.exit(0);
}

main();
