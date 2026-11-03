#!/usr/bin/env node
/**
 * Wokwi Offline & Local Hardware Testing MCP Server
 *
 * Provides offline-first Model Context Protocol (MCP) tools for:
 *  - diagram.json linting (--offline) & programmatic editing (parts, connections, serialMonitor)
 *  - wokwi.toml configuration parsing, validation, and project auto-detection
 *  - Custom chip scaffolding, schema validation, and 100% offline WASM compilation via ~/.wokwi/wasi-sdk
 *  - Local VS Code extension (wokwi.wokwi-vscode) automation & RFC2217 UART serial / GDB testing
 *  - Full tool parity with the Wokwi MCP specification (start/stop/resume/restart/status/serial/pin/control/screenshot/vcd)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const WOKWI_HOME = process.env.WOKWI_HOME || path.join(os.homedir(), '.wokwi');
const WOKWI_CLI = process.env.WOKWI_CLI_PATH || path.join(WOKWI_HOME, 'bin', 'wokwi-cli');
const WASI_SDK = process.env.WASI_SDK_PATH || path.join(WOKWI_HOME, 'wasi-sdk');
const VSCODE_BRIDGE_PORT = parseInt(process.env.WOKWI_MCP_BRIDGE_PORT || '47129', 10);

function callVsCodeBridge(action, payload = {}, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ action, ...payload });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: VSCODE_BRIDGE_PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}
const ASSETS_DIR = path.join(__dirname, 'assets');
const WOKWI_API_H = path.join(ASSETS_DIR, 'wokwi-api.h');
const DIAGRAM_SCHEMA_PATH = path.join(ASSETS_DIR, 'diagram.schema.json');
const CHIP_SCHEMA_PATH = path.join(ASSETS_DIR, 'chip.schema.json');

// ---------------------------------------------------------------------------
// Active Simulation / Serial State (supports both local RFC2217 & wokwi-cli)
// ---------------------------------------------------------------------------
const simState = {
  mode: null, // 'rfc2217' | 'cli' | 'vscode' | null
  status: 'stopped', // 'running' | 'paused' | 'stopped'
  projectPath: null,
  serialBuffer: '',
  rfc2217Socket: null,
  rfc2217Port: null,
  gdbPort: null,
  cliProcess: null,
  startedAt: null,
};

function resolveProjectPath(inputPath) {
  if (!inputPath || inputPath === '.') {
    return process.cwd();
  }
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

// ---------------------------------------------------------------------------
// Minimal TOML Parser & Serializer for wokwi.toml
// ---------------------------------------------------------------------------
function parseWokwiToml(content) {
  const result = { wokwi: {}, net: {}, chips: [], rawSections: {} };
  let currentSection = null;
  let currentArrayItem = null;

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const arrayMatch = line.match(/^\[\[([a-zA-Z0-9_.-]+)\]\]$/);
    if (arrayMatch) {
      const secName = arrayMatch[1];
      currentSection = secName;
      currentArrayItem = {};
      if (secName === 'chip') {
        result.chips.push(currentArrayItem);
      } else if (secName === 'net.forward') {
        if (!Array.isArray(result.net.forward)) result.net.forward = [];
        result.net.forward.push(currentArrayItem);
      } else {
        if (!Array.isArray(result.rawSections[secName])) result.rawSections[secName] = [];
        result.rawSections[secName].push(currentArrayItem);
      }
      continue;
    }

    const secMatch = line.match(/^\[([a-zA-Z0-9_.-]+)\]$/);
    if (secMatch) {
      currentSection = secMatch[1];
      currentArrayItem = null;
      if (currentSection !== 'wokwi' && currentSection !== 'net' && !result.rawSections[currentSection]) {
        result.rawSections[currentSection] = {};
      }
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let valRaw = kvMatch[2].trim();
      let val = valRaw;
      if ((valRaw.startsWith('"') && valRaw.endsWith('"')) || (valRaw.startsWith("'") && valRaw.endsWith("'"))) {
        val = valRaw.slice(1, -1);
      } else if (valRaw === 'true') {
        val = true;
      } else if (valRaw === 'false') {
        val = false;
      } else if (/^-?\d+$/.test(valRaw)) {
        val = parseInt(valRaw, 10);
      } else if (/^-?\d+\.\d+$/.test(valRaw)) {
        val = parseFloat(valRaw);
      }

      if (currentArrayItem) {
        currentArrayItem[key] = val;
      } else if (currentSection === 'wokwi') {
        result.wokwi[key] = val;
      } else if (currentSection === 'net') {
        result.net[key] = val;
      } else if (currentSection) {
        result.rawSections[currentSection][key] = val;
      } else {
        result.wokwi[key] = val;
      }
    }
  }
  return result;
}

function serializeWokwiToml(config) {
  const lines = ['[wokwi]'];
  const wokwiSection = { version: 1, ...(config.wokwi || {}) };
  for (const [k, v] of Object.entries(wokwiSection)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k} = ${typeof v === 'string' ? JSON.stringify(v) : v}`);
  }

  if (config.net && Object.keys(config.net).length > 0) {
    const netScalars = Object.entries(config.net).filter(([k]) => k !== 'forward');
    if (netScalars.length > 0) {
      lines.push('', '[net]');
      for (const [k, v] of netScalars) {
        if (v === undefined || v === null) continue;
        lines.push(`${k} = ${typeof v === 'string' ? JSON.stringify(v) : v}`);
      }
    }
    if (Array.isArray(config.net.forward)) {
      for (const fwd of config.net.forward) {
        lines.push('', '[[net.forward]]');
        for (const [k, v] of Object.entries(fwd)) {
          lines.push(`${k} = ${typeof v === 'string' ? JSON.stringify(v) : v}`);
        }
      }
    }
  }

  if (Array.isArray(config.chips)) {
    for (const chip of config.chips) {
      if (!chip || !chip.name || !chip.binary) continue;
      lines.push('', '[[chip]]');
      lines.push(`name = ${JSON.stringify(chip.name)}`);
      lines.push(`binary = ${JSON.stringify(chip.binary)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Project Detection & Firmware Discovery (wokwi-vscode 4.1.0 parity)
// ---------------------------------------------------------------------------
function findFilesRecursive(rootDir, maxDepth = 3, currentDepth = 0) {
  const found = [];
  if (currentDepth > maxDepth || !fs.existsSync(rootDir)) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return found;
  }
  const ignoreDirs = new Set(['node_modules', '.git', '.pioenvs', '.venv', 'venv', 'target']);
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoreDirs.has(entry.name) || entry.name === '.pio' || entry.name === 'build') {
        found.push(...findFilesRecursive(fullPath, maxDepth, currentDepth + 1));
      }
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }
  return found;
}

function detectProject(projectPath) {
  const root = resolveProjectPath(projectPath);
  if (!fs.existsSync(root)) {
    throw new Error(`Project directory does not exist: ${root}`);
  }

  const allFiles = findFilesRecursive(root, 4);
  const relFiles = allFiles.map((f) => path.relative(root, f));

  let framework = 'generic';
  if (fs.existsSync(path.join(root, 'platformio.ini'))) {
    framework = 'platformio';
  } else if (fs.existsSync(path.join(root, 'sdkconfig')) || relFiles.some((f) => f.endsWith('flasher_args.json'))) {
    framework = 'esp-idf';
  } else if (relFiles.some((f) => f.endsWith('.ino')) || fs.existsSync(path.join(root, 'sketch.yaml'))) {
    framework = 'arduino';
  } else if (fs.existsSync(path.join(root, 'CMakeLists.txt')) && relFiles.some((f) => f.endsWith('.uf2'))) {
    framework = 'pico-sdk';
  } else if (relFiles.some((f) => f.endsWith('.ioc'))) {
    framework = 'stm32cube';
  } else if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    framework = 'rust-embedded';
  }

  const firmwareCandidates = relFiles.filter((f) =>
    /\.(bin|hex|uf2)$/i.test(f) || path.basename(f) === 'flasher_args.json'
  );
  const elfCandidates = relFiles.filter((f) => /\.elf$/i.test(f));
  const diagramFiles = relFiles.filter((f) => /^diagram(\..+)?\.json$/i.test(path.basename(f)));
  const chipJsonFiles = relFiles.filter((f) => /\.chip\.json$/i.test(f));
  const chipWasmFiles = relFiles.filter((f) => /\.chip\.wasm$|\.wasm$/i.test(f));
  const hasWokwiToml = fs.existsSync(path.join(root, 'wokwi.toml'));

  return {
    projectPath: root,
    framework,
    hasWokwiToml,
    diagramFiles,
    firmwareCandidates,
    elfCandidates,
    chipJsonFiles,
    chipWasmFiles,
  };
}

// ---------------------------------------------------------------------------
// Offline Diagram Linting & Validation (wokwi-cli --offline + Schema)
// ---------------------------------------------------------------------------
function validateDiagramStructure(diagram) {
  const errors = [];
  const warnings = [];

  if (!diagram || typeof diagram !== 'object') {
    errors.push('Diagram root must be a JSON object.');
    return { valid: false, errors, warnings };
  }

  for (const reqField of ['version', 'author', 'editor', 'parts', 'connections']) {
    if (!(reqField in diagram)) {
      errors.push(`Missing required top-level property: "${reqField}"`);
    }
  }

  if (diagram.version !== undefined && diagram.version !== 1) {
    errors.push(`Unsupported diagram version: ${diagram.version} (expected 1)`);
  }

  const partIds = new Set();
  if (Array.isArray(diagram.parts)) {
    for (let i = 0; i < diagram.parts.length; i++) {
      const part = diagram.parts[i];
      if (!part.id || typeof part.id !== 'string') {
        errors.push(`parts[${i}] is missing a valid string "id".`);
      } else if (partIds.has(part.id)) {
        errors.push(`Duplicate part ID "${part.id}" at parts[${i}].`);
      } else {
        partIds.add(part.id);
      }
      if (!part.type || typeof part.type !== 'string') {
        errors.push(`Part "${part.id || i}" is missing a valid string "type".`);
      }
    }
  } else {
    errors.push('"parts" must be an array.');
  }

  if (Array.isArray(diagram.connections)) {
    for (let i = 0; i < diagram.connections.length; i++) {
      const conn = diagram.connections[i];
      if (!Array.isArray(conn) || conn.length < 3 || conn.length > 4) {
        errors.push(`connections[${i}] must be a tuple of [fromPin, toPin, color, routing?].`);
        continue;
      }
      for (const endpointIdx of [0, 1]) {
        const endpoint = conn[endpointIdx];
        if (typeof endpoint !== 'string' || !/^.+:.+$/.test(endpoint)) {
          errors.push(`connections[${i}][${endpointIdx}] ("${endpoint}") must match "partId:pinName".`);
        } else {
          const refPartId = endpoint.split(':')[0];
          if (! refPartId.startsWith('$') && !partIds.has(refPartId)) {
            warnings.push(`connections[${i}] references unknown part ID "${refPartId}" in "${endpoint}".`);
          }
        }
      }
    }
  } else {
    errors.push('"connections" must be an array.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function runOfflineDiagramLint(targetPath, { ignoreWarnings = false, warningsAsErrors = false } = {}) {
  const resolved = resolveProjectPath(targetPath);
  const diagramPath = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? path.join(resolved, 'diagram.json')
    : resolved;

  if (!fs.existsSync(diagramPath)) {
    throw new Error(`Diagram file not found at ${diagramPath}`);
  }

  const raw = fs.readFileSync(diagramPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      valid: false,
      diagramPath,
      schemaValidation: { valid: false, errors: [`Invalid JSON: ${err.message}`], warnings: [] },
      cliLintOutput: '',
    };
  }

  const schemaValidation = validateDiagramStructure(parsed);

  let cliLintOutput = '';
  let cliExitCode = 0;
  if (fs.existsSync(WOKWI_CLI)) {
    const args = ['lint', '--offline'];
    if (ignoreWarnings) args.push('--ignore-warnings');
    if (warningsAsErrors) args.push('--warnings-as-errors');
    args.push(diagramPath);
    try {
      cliLintOutput = execFileSync(WOKWI_CLI, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      cliExitCode = err.status || 1;
      cliLintOutput = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    }
  }

  return {
    valid: schemaValidation.valid && cliExitCode === 0,
    diagramPath,
    partCount: Array.isArray(parsed.parts) ? parsed.parts.length : 0,
    connectionCount: Array.isArray(parsed.connections) ? parsed.connections.length : 0,
    schemaValidation,
    cliExitCode,
    cliLintOutput,
  };
}

// ---------------------------------------------------------------------------
// Custom Chip Validation & Offline Compilation via ~/.wokwi/wasi-sdk
// ---------------------------------------------------------------------------
function validateChipJson(chipJsonPath) {
  if (!fs.existsSync(chipJsonPath)) {
    return { valid: false, errors: [`File not found: ${chipJsonPath}`] };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(chipJsonPath, 'utf8'));
  } catch (err) {
    return { valid: false, errors: [`Invalid JSON in ${chipJsonPath}: ${err.message}`] };
  }

  const errors = [];
  if (!data.name || typeof data.name !== 'string') {
    errors.push('Missing required string property "name".');
  }
  if (!Array.isArray(data.pins) || data.pins.length === 0 || !data.pins.every((p) => typeof p === 'string')) {
    errors.push('Property "pins" must be a non-empty array of strings.');
  }
  if (data.controls !== undefined) {
    if (!Array.isArray(data.controls)) {
      errors.push('"controls" must be an array.');
    } else {
      for (let i = 0; i < data.controls.length; i++) {
        const c = data.controls[i];
        if (!c.id || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(c.id)) {
          errors.push(`controls[${i}].id must be camelCase alphanumeric.`);
        }
        if (!c.label || typeof c.label !== 'string') {
          errors.push(`controls[${i}].label is required.`);
        }
        if (!['range', 'boolean', 'string'].includes(c.type)) {
          errors.push(`controls[${i}].type must be one of "range", "boolean", "string".`);
        }
        if (c.type === 'range' && (typeof c.min !== 'number' || typeof c.max !== 'number')) {
          errors.push(`controls[${i}] of type "range" requires numeric "min" and "max".`);
        }
      }
    }
  }
  if (data.display !== undefined) {
    if (
      typeof data.display !== 'object' ||
      !Number.isInteger(data.display.width) ||
      data.display.width < 1 ||
      !Number.isInteger(data.display.height) ||
      data.display.height < 1
    ) {
      errors.push('"display" requires positive integer "width" and "height".');
    }
  }

  return { valid: errors.length === 0, errors, chip: data };
}

function compileChipOffline({ sources, output, projectPath, optimization = '-O2' }) {
  const root = resolveProjectPath(projectPath);
  const srcList = (Array.isArray(sources) ? sources : [sources]).map((s) =>
    path.isAbsolute(s) ? s : path.resolve(root, s)
  );

  for (const s of srcList) {
    if (!fs.existsSync(s)) {
      throw new Error(`Chip source file not found: ${s}`);
    }
  }

  const firstSrc = srcList[0];
  const srcDir = path.dirname(firstSrc);
  const baseName = path.basename(firstSrc).replace(/\.(chip\.)?(c|cpp|cc)$/i, '');
  const outPath = output
    ? path.isAbsolute(output)
      ? output
      : path.resolve(root, output)
    : path.join(srcDir, `${baseName}.chip.wasm`);

  // Ensure wokwi-api.h is available locally in the source directory or via -I so no internet is ever needed
  const localHeader = path.join(srcDir, 'wokwi-api.h');
  let copiedHeader = false;
  if (!fs.existsSync(localHeader) && fs.existsSync(WOKWI_API_H)) {
    fs.copyFileSync(WOKWI_API_H, localHeader);
    copiedHeader = true;
  }

  const clangBin = path.join(WASI_SDK, 'bin', 'clang');
  const sysroot = path.join(WASI_SDK, 'share', 'wasi-sysroot');
  if (!fs.existsSync(clangBin)) {
    throw new Error(`Offline WASI-SDK clang not found at ${clangBin}`);
  }

  const args = [
    '--target=wasm32-wasi',
    `--sysroot=${sysroot}`,
    '-nostartfiles',
    `-I${srcDir}`,
    `-I${ASSETS_DIR}`,
    optimization,
    '-Wl,--no-entry',
    '-Wl,--import-memory',
    '-Wl,--export-table',
    '-o',
    outPath,
    ...srcList,
  ];

  const stdout = execFileSync(clangBin, args, {
    cwd: srcDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stat = fs.statSync(outPath);
  const companionJson = outPath.replace(/\.wasm$/i, '.json');
  const altCompanionJson = path.join(srcDir, `${baseName}.chip.json`);
  const jsonPathToCheck = fs.existsSync(companionJson)
    ? companionJson
    : fs.existsSync(altCompanionJson)
    ? altCompanionJson
    : null;

  const chipJsonValidation = jsonPathToCheck ? validateChipJson(jsonPathToCheck) : null;

  return {
    success: true,
    outputWasm: outPath,
    sizeBytes: stat.size,
    compiler: clangBin,
    copiedOfflineHeader: copiedHeader,
    chipJsonPath: jsonPathToCheck,
    chipJsonValidation,
    compilerOutput: stdout.trim(),
  };
}

// ---------------------------------------------------------------------------
// Local RFC2217 / TCP UART Serial Connection & Port Probe
// ---------------------------------------------------------------------------
function checkPortOpen(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(ok);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function connectRfc2217Serial(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    if (simState.rfc2217Socket && !simState.rfc2217Socket.destroyed) {
      simState.rfc2217Socket.destroy();
    }
    const client = new net.Socket();
    let connected = false;
    client.setTimeout(2500);

    client.on('connect', () => {
      connected = true;
      client.setTimeout(0);
      simState.rfc2217Socket = client;
      simState.rfc2217Port = port;
      simState.mode = 'rfc2217';
      simState.status = 'running';
      simState.startedAt = new Date().toISOString();
      resolve(true);
    });

    client.on('data', (chunk) => {
      // Strip telnet IAC (0xFF) sequences if RFC2217 negotiation bytes are sent
      const filtered = [];
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0xff && i + 2 < chunk.length) {
          i += 2;
          continue;
        }
        filtered.push(chunk[i]);
      }
      simState.serialBuffer += Buffer.from(filtered).toString('utf8');
      if (simState.serialBuffer.length > 256 * 1024) {
        simState.serialBuffer = simState.serialBuffer.slice(-128 * 1024);
      }
    });

    client.on('close', () => {
      if (simState.rfc2217Socket === client) {
        simState.rfc2217Socket = null;
        if (simState.mode === 'rfc2217') {
          simState.status = 'stopped';
        }
      }
    });

    client.on('error', (err) => {
      if (!connected) {
        reject(err);
      }
    });

    client.on('timeout', () => {
      if (!connected) {
        client.destroy();
        reject(new Error(`Connection timed out to 127.0.0.1:${port}`));
      }
    });

    client.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// MCP Tool Definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'wokwi_detect_project',
    description:
      'Auto-detect embedded project framework (ESP-IDF, PlatformIO, Arduino, Pico SDK, STM32Cube, Rust) and discover firmware binaries (.bin/.hex/.uf2/flasher_args.json), ELF files, diagram.json, wokwi.toml, and custom chips.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project directory (defaults to current working directory)',
        },
      },
    },
  },
  {
    name: 'wokwi_read_config',
    description:
      'Read, parse, and validate wokwi.toml in a project directory, verifying that firmware, ELF, and custom chip binaries exist on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project directory or wokwi.toml file',
        },
      },
    },
  },
  {
    name: 'wokwi_write_config',
    description:
      'Create or update wokwi.toml with [wokwi] firmware/elf/rfc2217ServerPort/gdbServerPort, [net] port forwarding, and [[chip]] custom chip definitions.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project directory',
        },
        firmware: {
          type: 'string',
          description: 'Relative path to the firmware file (.bin, .hex, .uf2, or flasher_args.json)',
        },
        elf: {
          type: 'string',
          description: 'Relative path to the ELF file for debugging/symbols',
        },
        gdbServerPort: {
          type: 'number',
          description: 'Optional local TCP port for the Wokwi GDB server (e.g. 3333)',
        },
        rfc2217ServerPort: {
          type: 'number',
          description: 'Optional local TCP port for RFC2217 UART serial access (e.g. 4000)',
        },
        chips: {
          type: 'array',
          description: 'Optional list of custom chips to register in [[chip]] sections',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              binary: { type: 'string' },
            },
            required: ['name', 'binary'],
          },
        },
      },
      required: ['firmware'],
    },
  },
  {
    name: 'wokwi_lint_diagram',
    description:
      'Lint and validate a Wokwi diagram.json file 100% offline using both the local wokwi-cli (--offline) and the Wokwi VS Code 4.1.0 JSON schema.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to diagram.json or project directory (defaults to current directory)',
        },
        ignoreWarnings: {
          type: 'boolean',
          description: 'Ignore warning diagnostics',
        },
        warningsAsErrors: {
          type: 'boolean',
          description: 'Treat warnings as errors',
        },
      },
    },
  },
  {
    name: 'wokwi_read_diagram',
    description: 'Read and summarize a Wokwi diagram.json file (parts, pin connections, and serialMonitor config).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to diagram.json or project directory',
        },
      },
    },
  },
  {
    name: 'wokwi_edit_diagram',
    description:
      'Programmatically edit a Wokwi diagram.json file offline (add/update/remove parts, connect/disconnect pins, or configure serialMonitor) and validate the result.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to diagram.json or project directory',
        },
        createIfMissing: {
          type: 'boolean',
          description: 'Create a new diagram.json if it does not exist yet',
        },
        author: {
          type: 'string',
          description: 'Optional author name to set on the diagram',
        },
        addParts: {
          type: 'array',
          description: 'Parts to add or upsert into diagram.parts',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              top: { type: 'number' },
              left: { type: 'number' },
              rotate: { type: 'number' },
              attrs: { type: 'object' },
              hide: { type: 'boolean' },
            },
            required: ['id', 'type'],
          },
        },
        removePartIds: {
          type: 'array',
          description: 'Part IDs to remove (also removes their attached wire connections)',
          items: { type: 'string' },
        },
        addConnections: {
          type: 'array',
          description: 'Wire connections to add: [fromPin, toPin, color, routingArray]',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Source pin in "partId:pin" format' },
              to: { type: 'string', description: 'Target pin in "partId:pin" format' },
              color: { type: 'string', description: 'Wire color (e.g., "green", "red", "black")' },
              routing: {
                type: 'array',
                items: { type: 'string' },
                description: 'Wire routing steps (default: ["v0"])',
              },
            },
            required: ['from', 'to', 'color'],
          },
        },
        removeConnections: {
          type: 'array',
          description: 'Connections to remove by matching { from, to } endpoints',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
        serialMonitor: {
          type: 'object',
          description: 'Optional serialMonitor settings ({ display: "always"|"auto"|"plotter"|"terminal"|"never", newline: "lf"|"crlf"|"cr"|"none" })',
        },
      },
    },
  },
  {
    name: 'wokwi_chip_scaffold',
    description:
      'Scaffold a new Wokwi custom chip completely offline (<name>.chip.json, <name>.chip.c, local wokwi-api.h, offline Makefile, and optional registration in wokwi.toml).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project or output directory path',
        },
        name: {
          type: 'string',
          description: 'Custom chip name (e.g., "inverter" or "i2c-sensor")',
        },
        author: {
          type: 'string',
          description: 'Chip author name',
        },
        pins: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pin names starting from pin 1 (e.g. ["VCC", "GND", "IN", "OUT"])',
        },
        controls: {
          type: 'array',
          description: 'Optional interactive controls matching chip.schema.json',
          items: { type: 'object' },
        },
        registerInToml: {
          type: 'boolean',
          description: 'Automatically register [[chip]] in wokwi.toml if present (default: true)',
        },
      },
      required: ['name', 'pins'],
    },
  },
  {
    name: 'wokwi_chip_compile',
    description:
      'Compile custom chip C/C++ sources to WebAssembly (.chip.wasm) 100% offline using ~/.wokwi/wasi-sdk and bundled wokwi-api.h, and validate its companion .chip.json.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project root directory',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of C/C++ source files to compile (e.g. ["chips/inverter.chip.c"])',
        },
        output: {
          type: 'string',
          description: 'Optional output .wasm path (defaults to <source_name>.chip.wasm)',
        },
      },
      required: ['sources'],
    },
  },
  {
    name: 'wokwi_start_simulation',
    description:
      'Start a Wokwi simulation or attach to a local offline Wokwi VS Code simulator session (via rfc2217ServerPort in wokwi.toml or wokwi-cli).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project directory (defaults to current directory)',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'rfc2217', 'vscode', 'cli'],
          description: 'Execution backend: "auto" (prefers local RFC2217/VS Code offline session, falls back to cli), "rfc2217", "vscode", or "cli"',
        },
        waitForDebugger: {
          type: 'boolean',
          description: 'When starting via VS Code, pause on startup and wait for GDB debugger attachment',
        },
      },
    },
  },
  {
    name: 'wokwi_stop_simulation',
    description: 'Stop the current Wokwi simulation and disconnect any active serial session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wokwi_resume_simulation',
    description: 'Resume a paused Wokwi simulation.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wokwi_restart_simulation',
    description: 'Restart the current Wokwi simulation and clear the serial buffer.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wokwi_get_status',
    description:
      'Get current simulation status, local RFC2217/GDB port reachability, and offline Wokwi toolchain details (wokwi-cli, wasi-sdk, VS Code extension, bundle.wpk).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Optional project directory to check configured rfc2217ServerPort and gdbServerPort',
        },
      },
    },
  },
  {
    name: 'wokwi_read_serial',
    description: 'Read buffered UART serial output from the running Wokwi simulation.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: {
          type: 'boolean',
          description: 'Clear the serial buffer after reading (default: false)',
        },
      },
    },
  },
  {
    name: 'wokwi_write_serial',
    description: 'Write text data to the simulated UART serial monitor.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to send over serial (append \\n if a newline is needed)',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'wokwi_wait_for_serial',
    description:
      'Wait for specific text to appear in the simulation serial output (or fail early if failText appears) with a configurable timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        expectText: {
          type: 'string',
          description: 'Substring or regex pattern expected in serial output',
        },
        failText: {
          type: 'string',
          description: 'Optional substring that triggers an immediate failure if seen',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 10000)',
        },
      },
      required: ['expectText'],
    },
  },
  {
    name: 'wokwi_read_pin',
    description: 'Inspect pin connections and state for a component in the Wokwi project.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string', description: 'ID of the part/component in diagram.json' },
        pin: { type: 'string', description: 'Pin name or number' },
        projectPath: { type: 'string', description: 'Optional path to project directory' },
      },
      required: ['partId', 'pin'],
    },
  },
  {
    name: 'wokwi_set_control',
    description: 'Set a control or attribute value (e.g. potentiometer, button, bounce, color) on a component.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string', description: 'ID of the part/component' },
        control: { type: 'string', description: 'Control or attribute name' },
        value: { type: ['number', 'string', 'boolean'], description: 'Value to set' },
        projectPath: { type: 'string', description: 'Optional path to project directory' },
      },
      required: ['partId', 'control', 'value'],
    },
  },
  {
    name: 'wokwi_take_screenshot',
    description: 'Capture a display component screenshot via wokwi-cli.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string', description: 'ID of the display component' },
        outputPath: { type: 'string', description: 'Output PNG path (default: screenshot.png)' },
        timeMs: { type: 'number', description: 'Simulation timestamp in ms (default: 1000)' },
        projectPath: { type: 'string', description: 'Project directory path' },
      },
      required: ['partId'],
    },
  },
  {
    name: 'wokwi_export_vcd',
    description: 'Export logic analyzer capture as a VCD (Value Change Dump) file.',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: { type: 'string', description: 'Path where the VCD file will be saved' },
        timeoutMs: { type: 'number', description: 'Simulation duration in ms (default: 5000)' },
        projectPath: { type: 'string', description: 'Project directory path' },
      },
      required: ['outputPath'],
    },
  },
  {
    name: 'wokwi_vscode_control',
    description:
      'Open a Wokwi project or diagram.json in the local VS Code instance where wokwi.wokwi-vscode is installed, and optionally configure rfc2217ServerPort / gdbServerPort in wokwi.toml for offline automation.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Wokwi project directory',
        },
        openDiagram: {
          type: 'boolean',
          description: 'Open diagram.json in VS Code (default: true)',
        },
        ensurePorts: {
          type: 'boolean',
          description: 'Ensure rfc2217ServerPort (4000) and gdbServerPort (3333) are present in wokwi.toml so MCP can attach to UART and GDB (default: true)',
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'wokwi_configure_network',
    description:
      'Configure Wokwi virtual WiFi gateway and TCP port forwarding ([[net.forward]]) in wokwi.toml so simulated devices can communicate with local/external network services while the extension runs in offline mode.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the Wokwi project directory',
        },
        gateway: {
          type: 'string',
          description: 'Optional custom WebSocket IoT gateway URL (e.g. "ws://127.0.0.1:9001")',
        },
        forwards: {
          type: 'array',
          description: 'List of TCP port forwards between host and simulated device (e.g. [{ from: "localhost:8080", to: "target:80" }])',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'wokwi_provision_hardware',
    description:
      'Provision the bundled ESP32-S3 + WeAct 2.13" B/W e-Paper screen (weact_213_bw.chip.wasm + .chip.json) + SD card + keypad matrix hardware template into a target project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: {
          type: 'string',
          description: 'Target project directory to copy hardware elements into',
        },
        includeDiagram: {
          type: 'boolean',
          description: 'Copy the ESP32-S3 + WeAct EPD + SD + Keypad diagram.json (default: true)',
        },
        includeScenarios: {
          type: 'boolean',
          description: 'Copy test scenarios (solve-linear.yaml, keypad-press-only.yaml) (default: true)',
        },
      },
      required: ['targetPath'],
    },
  },
  {
    name: 'wokwi_load_user_tok',
    description:
      'Load and overwrite ~/.wokwi/user.tok from a custom user.tok file path or raw token/key content, and sync it with the active VS Code Wokwi extension.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to a user.tok file on disk to copy and overwrite ~/.wokwi/user.tok with',
        },
        content: {
          type: 'string',
          description: 'Raw user.tok file content or Wokwi license key string to write into ~/.wokwi/user.tok',
        },
        backupExisting: {
          type: 'boolean',
          description: 'Create ~/.wokwi/user.tok.bak before overwriting (default: true)',
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool Execution Handlers
// ---------------------------------------------------------------------------
async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'wokwi_detect_project': {
      return detectProject(args.projectPath);
    }

    case 'wokwi_read_config': {
      const root = resolveProjectPath(args.projectPath);
      const tomlPath = root.endsWith('.toml') ? root : path.join(root, 'wokwi.toml');
      if (!fs.existsSync(tomlPath)) {
        return {
          exists: false,
          tomlPath,
          error: `wokwi.toml not found at ${tomlPath}`,
        };
      }
      const projDir = path.dirname(tomlPath);
      const parsed = parseWokwiToml(fs.readFileSync(tomlPath, 'utf8'));
      const issues = [];
      if (!parsed.wokwi.firmware) {
        issues.push('Missing required "firmware" field in [wokwi] section.');
      } else {
        const fwPath = path.resolve(projDir, parsed.wokwi.firmware);
        if (!fs.existsSync(fwPath)) {
          issues.push(`Firmware file does not exist on disk: ${fwPath}`);
        }
      }
      if (parsed.wokwi.elf) {
        const elfPath = path.resolve(projDir, parsed.wokwi.elf);
        if (!fs.existsSync(elfPath)) {
          issues.push(`ELF file does not exist on disk: ${elfPath}`);
        }
      }
      for (const chip of parsed.chips) {
        const wasmPath = path.resolve(projDir, chip.binary || '');
        if (!fs.existsSync(wasmPath)) {
          issues.push(`Custom chip "${chip.name}" binary not found: ${wasmPath}`);
        }
      }
      return {
        exists: true,
        valid: issues.length === 0,
        tomlPath,
        config: parsed,
        issues,
      };
    }

    case 'wokwi_write_config': {
      const root = resolveProjectPath(args.projectPath);
      fs.mkdirSync(root, { recursive: true });
      const tomlPath = path.join(root, 'wokwi.toml');
      const existing = fs.existsSync(tomlPath)
        ? parseWokwiToml(fs.readFileSync(tomlPath, 'utf8'))
        : { wokwi: { version: 1 }, net: {}, chips: [] };

      existing.wokwi.version = 1;
      if (args.firmware !== undefined) existing.wokwi.firmware = args.firmware;
      if (args.elf !== undefined) existing.wokwi.elf = args.elf;
      if (args.gdbServerPort !== undefined) existing.wokwi.gdbServerPort = args.gdbServerPort;
      if (args.rfc2217ServerPort !== undefined) existing.wokwi.rfc2217ServerPort = args.rfc2217ServerPort;
      if (Array.isArray(args.chips)) existing.chips = args.chips;

      const serialized = serializeWokwiToml(existing);
      fs.writeFileSync(tomlPath, serialized, 'utf8');
      return {
        success: true,
        tomlPath,
        content: serialized,
      };
    }

    case 'wokwi_lint_diagram': {
      return runOfflineDiagramLint(args.path, {
        ignoreWarnings: Boolean(args.ignoreWarnings),
        warningsAsErrors: Boolean(args.warningsAsErrors),
      });
    }

    case 'wokwi_read_diagram': {
      const resolved = resolveProjectPath(args.path);
      const diagramPath =
        fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
          ? path.join(resolved, 'diagram.json')
          : resolved;
      if (!fs.existsSync(diagramPath)) {
        throw new Error(`diagram.json not found at ${diagramPath}`);
      }
      const diagram = JSON.parse(fs.readFileSync(diagramPath, 'utf8'));
      const validation = validateDiagramStructure(diagram);
      return {
        diagramPath,
        validation,
        diagram,
      };
    }

    case 'wokwi_edit_diagram': {
      const resolved = resolveProjectPath(args.path);
      const diagramPath =
        resolved.endsWith('.json')
          ? resolved
          : path.join(resolved, 'diagram.json');

      let diagram;
      if (fs.existsSync(diagramPath)) {
        diagram = JSON.parse(fs.readFileSync(diagramPath, 'utf8'));
      } else if (args.createIfMissing) {
        fs.mkdirSync(path.dirname(diagramPath), { recursive: true });
        diagram = {
          version: 1,
          author: args.author || 'Wokwi MCP',
          editor: 'wokwi',
          parts: [],
          connections: [],
        };
      } else {
        throw new Error(`diagram.json not found at ${diagramPath} (pass createIfMissing: true to create it)`);
      }

      if (args.author) diagram.author = args.author;
      if (!Array.isArray(diagram.parts)) diagram.parts = [];
      if (!Array.isArray(diagram.connections)) diagram.connections = [];

      if (Array.isArray(args.removePartIds) && args.removePartIds.length > 0) {
        const removeSet = new Set(args.removePartIds);
        diagram.parts = diagram.parts.filter((p) => !removeSet.has(p.id));
        diagram.connections = diagram.connections.filter(
          (c) => !removeSet.has(String(c[0]).split(':')[0]) && !removeSet.has(String(c[1]).split(':')[0])
        );
      }

      if (Array.isArray(args.addParts)) {
        for (const newPart of args.addParts) {
          const partObj = {
            type: newPart.type,
            id: newPart.id,
            top: newPart.top ?? 0,
            left: newPart.left ?? 0,
            ...(newPart.rotate !== undefined ? { rotate: newPart.rotate } : {}),
            attrs: newPart.attrs || {},
            ...(newPart.hide !== undefined ? { hide: newPart.hide } : {}),
          };
          const existingIdx = diagram.parts.findIndex((p) => p.id === newPart.id);
          if (existingIdx >= 0) {
            diagram.parts[existingIdx] = { ...diagram.parts[existingIdx], ...partObj };
          } else {
            diagram.parts.push(partObj);
          }
        }
      }

      if (Array.isArray(args.removeConnections)) {
        for (const rem of args.removeConnections) {
          diagram.connections = diagram.connections.filter(
            (c) =>
              !(
                (c[0] === rem.from && c[1] === rem.to) ||
                (c[0] === rem.to && c[1] === rem.from)
              )
          );
        }
      }

      if (Array.isArray(args.addConnections)) {
        for (const conn of args.addConnections) {
          const routing = Array.isArray(conn.routing) ? conn.routing : ['v0'];
          const exists = diagram.connections.some(
            (c) =>
              (c[0] === conn.from && c[1] === conn.to) ||
              (c[0] === conn.to && c[1] === conn.from)
          );
          if (!exists) {
            diagram.connections.push([conn.from, conn.to, conn.color || 'green', routing]);
          }
        }
      }

      if (args.serialMonitor && typeof args.serialMonitor === 'object') {
        diagram.serialMonitor = { ...(diagram.serialMonitor || {}), ...args.serialMonitor };
      }

      fs.writeFileSync(diagramPath, JSON.stringify(diagram, null, 2) + '\n', 'utf8');
      const lintResult = runOfflineDiagramLint(diagramPath);
      return {
        success: lintResult.valid,
        diagramPath,
        lintResult,
      };
    }

    case 'wokwi_chip_scaffold': {
      const root = resolveProjectPath(args.projectPath);
      fs.mkdirSync(root, { recursive: true });
      const chipName = args.name.replace(/\.chip$/i, '');
      const chipJsonPath = path.join(root, `${chipName}.chip.json`);
      const chipCPath = path.join(root, `${chipName}.chip.c`);
      const headerDest = path.join(root, 'wokwi-api.h');

      const chipJsonObj = {
        name: chipName,
        author: args.author || 'Wokwi Developer',
        pins: args.pins,
        ...(Array.isArray(args.controls) ? { controls: args.controls } : {}),
      };

      const validation = validateChipJsonData(chipJsonObj);
      if (!validation.valid) {
        throw new Error(`Invalid chip definition: ${validation.errors.join('; ')}`);
      }

      fs.writeFileSync(chipJsonPath, JSON.stringify(chipJsonObj, null, 2) + '\n', 'utf8');

      if (fs.existsSync(WOKWI_API_H) && !fs.existsSync(headerDest)) {
        fs.copyFileSync(WOKWI_API_H, headerDest);
      }

      if (!fs.existsSync(chipCPath)) {
        const pinDecls = args.pins
          .filter(Boolean)
          .map((p) => `  pin_t pin_${p.replace(/[^a-zA-Z0-9_]/g, '_')};`)
          .join('\n');
        const pinInits = args.pins
          .filter(Boolean)
          .map(
            (p) =>
              `  chip->pin_${p.replace(/[^a-zA-Z0-9_]/g, '_')} = pin_init("${p}", INPUT);`
          )
          .join('\n');

        const cSource = `#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
${pinDecls || '  int placeholder;'}
} chip_state_t;

void chip_init(void) {
  chip_state_t *chip = malloc(sizeof(chip_state_t));
${pinInits}
  printf("Custom chip ${chipName} initialized!\\n");
}
`;
        fs.writeFileSync(chipCPath, cSource, 'utf8');
      }

      let registeredInToml = false;
      const tomlPath = path.join(root, 'wokwi.toml');
      if (args.registerInToml !== false && fs.existsSync(tomlPath)) {
        const parsed = parseWokwiToml(fs.readFileSync(tomlPath, 'utf8'));
        const relWasm = `${chipName}.chip.wasm`;
        if (!parsed.chips.some((c) => c.name === chipName)) {
          parsed.chips.push({ name: chipName, binary: relWasm });
          fs.writeFileSync(tomlPath, serializeWokwiToml(parsed), 'utf8');
          registeredInToml = true;
        }
      }

      return {
        success: true,
        chipName,
        chipJsonPath,
        chipCPath,
        headerPath: headerDest,
        registeredInToml,
      };
    }

    case 'wokwi_chip_compile': {
      return compileChipOffline({
        projectPath: args.projectPath,
        sources: args.sources,
        output: args.output,
      });
    }

    case 'wokwi_start_simulation': {
      const root = resolveProjectPath(args.projectPath);
      const mode = args.mode || 'auto';
      simState.projectPath = root;
      simState.serialBuffer = '';

      const tomlPath = path.join(root, 'wokwi.toml');
      const parsedToml = fs.existsSync(tomlPath)
        ? parseWokwiToml(fs.readFileSync(tomlPath, 'utf8'))
        : { wokwi: {} };
      const rfcPort = parsedToml.wokwi.rfc2217ServerPort;
      const gdbPort = parsedToml.wokwi.gdbServerPort;
      simState.gdbPort = gdbPort || null;

      // 1. Try starting directly via the backported VS Code extension bridge (127.0.0.1:47129)
      if (mode === 'auto' || mode === 'vscode') {
        const bridgeRes = await callVsCodeBridge('start', {
          projectPath: root,
          waitForDebugger: Boolean(args.waitForDebugger),
        });
        if (bridgeRes && bridgeRes.ok) {
          simState.mode = 'vscode-bridge';
          simState.status = bridgeRes.status || 'running';
          simState.startedAt = new Date().toISOString();
          return {
            status: simState.status,
            mode: 'vscode-bridge',
            projectPath: root,
            rfc2217ServerPort: rfcPort || null,
            gdbServerPort: gdbPort || null,
            message: 'Started offline simulation directly inside VS Code via Wokwi MCP Bridge.',
          };
        }
      }

      // 2. Check if local offline simulator (VS Code Wokwi) is already listening on rfc2217ServerPort
      if ((mode === 'auto' || mode === 'rfc2217') && rfcPort) {
        const isOpen = await checkPortOpen(rfcPort);
        if (isOpen) {
          await connectRfc2217Serial(rfcPort);
          return {
            status: 'running',
            mode: 'rfc2217',
            projectPath: root,
            rfc2217ServerPort: rfcPort,
            gdbServerPort: gdbPort || null,
            message: `Attached to local offline Wokwi simulator via RFC2217 TCP port ${rfcPort}.`,
          };
        } else if (mode === 'rfc2217') {
          throw new Error(
            `RFC2217 port ${rfcPort} is not open yet. Start the Wokwi Simulator in VS Code first or use mode="vscode".`
          );
        }
      }

      // 3. If mode is 'cli' or ('auto' and WOKWI_CLI_TOKEN is present), start via wokwi-cli
      if (mode === 'cli' || (mode === 'auto' && process.env.WOKWI_CLI_TOKEN)) {
        if (simState.cliProcess) {
          simState.cliProcess.kill();
        }
        const child = spawn(WOKWI_CLI, ['--interactive', root], {
          cwd: root,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        simState.cliProcess = child;
        simState.mode = 'cli';
        simState.status = 'running';
        simState.startedAt = new Date().toISOString();

        child.stdout.on('data', (d) => {
          simState.serialBuffer += d.toString('utf8');
        });
        child.stderr.on('data', (d) => {
          simState.serialBuffer += d.toString('utf8');
        });
        child.on('exit', () => {
          if (simState.cliProcess === child) {
            simState.status = 'stopped';
            simState.cliProcess = null;
          }
        });

        return {
          status: 'running',
          mode: 'cli',
          pid: child.pid,
          projectPath: root,
        };
      }

      // 4. Offline VS Code trigger: open project in VS Code and connect to bridge / RFC2217 once ready
      simState.mode = 'vscode';
      simState.status = 'running';
      simState.startedAt = new Date().toISOString();
      return {
        status: 'ready_for_local_simulator',
        mode: 'vscode',
        projectPath: root,
        rfc2217ServerPort: rfcPort || null,
        gdbServerPort: gdbPort || null,
        hint: 'Open VS Code with the Wokwi extension active so the local MCP bridge (127.0.0.1:47129) or RFC2217 port can attach automatically.',
      };
    }

    case 'wokwi_stop_simulation': {
      await callVsCodeBridge('stop');
      if (simState.rfc2217Socket) {
        simState.rfc2217Socket.destroy();
        simState.rfc2217Socket = null;
      }
      if (simState.cliProcess) {
        simState.cliProcess.kill();
        simState.cliProcess = null;
      }
      simState.status = 'stopped';
      return { status: 'stopped' };
    }

    case 'wokwi_resume_simulation': {
      await callVsCodeBridge('resume');
      simState.status = 'running';
      return { status: simState.status, mode: simState.mode };
    }

    case 'wokwi_restart_simulation': {
      simState.serialBuffer = '';
      await callVsCodeBridge('restart');
      if (simState.mode === 'rfc2217' && simState.rfc2217Port) {
        const open = await checkPortOpen(simState.rfc2217Port);
        if (open) {
          await connectRfc2217Serial(simState.rfc2217Port);
        }
      }
      simState.status = 'running';
      return { status: simState.status, mode: simState.mode, serialBufferCleared: true };
    }

    case 'wokwi_get_status': {
      const root = resolveProjectPath(args.projectPath || simState.projectPath);
      const tomlPath = path.join(root, 'wokwi.toml');
      const parsedToml = fs.existsSync(tomlPath)
        ? parseWokwiToml(fs.readFileSync(tomlPath, 'utf8'))
        : { wokwi: {} };
      const rfcPort = parsedToml.wokwi.rfc2217ServerPort || simState.rfc2217Port;
      const gdbPort = parsedToml.wokwi.gdbServerPort || simState.gdbPort;

      const bridgeStatus = await callVsCodeBridge('status');
      const rfcListening = rfcPort ? await checkPortOpen(rfcPort) : false;
      const gdbListening = gdbPort ? await checkPortOpen(gdbPort) : false;

      const bundlePath = path.join(WOKWI_HOME, 'bundle.wpk');
      const tokenPath = path.join(WOKWI_HOME, 'user.tok');
      const wasiVersionPath = path.join(WASI_SDK, 'VERSION');

      return {
        simulation: {
          status:
            bridgeStatus && bridgeStatus.active
              ? bridgeStatus.status
              : rfcListening
              ? 'running'
              : simState.status,
          mode: bridgeStatus && bridgeStatus.ok ? 'vscode-bridge' : simState.mode,
          projectPath: root,
          startedAt: simState.startedAt,
          serialBufferedBytes:
            bridgeStatus && typeof bridgeStatus.serialLength === 'number'
              ? bridgeStatus.serialLength
              : Buffer.byteLength(simState.serialBuffer, 'utf8'),
          vsCodeBridgeActive: Boolean(bridgeStatus && bridgeStatus.ok),
          vsCodeBridgeState: bridgeStatus || null,
          rfc2217ServerPort: rfcPort || null,
          rfc2217Listening: rfcListening,
          gdbServerPort: gdbPort || null,
          gdbListening: gdbListening,
        },
        offlineEnvironment: {
          wokwiHome: WOKWI_HOME,
          hasOfflineBundle: fs.existsSync(bundlePath),
          bundleSizeBytes: fs.existsSync(bundlePath) ? fs.statSync(bundlePath).size : 0,
          hasUserToken: fs.existsSync(tokenPath),
          wokwiCliInstalled: fs.existsSync(WOKWI_CLI),
          wasiSdkInstalled: fs.existsSync(path.join(WASI_SDK, 'bin', 'clang')),
          wasiSdkVersion: fs.existsSync(wasiVersionPath)
            ? fs.readFileSync(wasiVersionPath, 'utf8').trim()
            : null,
          bundledOfflineHeader: fs.existsSync(WOKWI_API_H),
        },
      };
    }

    case 'wokwi_read_serial': {
      const bridgeSerial = await callVsCodeBridge('read_serial', { clear: Boolean(args.clear) });
      if (bridgeSerial && bridgeSerial.ok && (bridgeSerial.output || simState.mode === 'vscode-bridge')) {
        return {
          output: bridgeSerial.output || '',
          length: (bridgeSerial.output || '').length,
          mode: 'vscode-bridge',
          status: simState.status,
        };
      }
      const output = simState.serialBuffer;
      if (args.clear) {
        simState.serialBuffer = '';
      }
      return {
        output,
        length: output.length,
        mode: simState.mode,
        status: simState.status,
      };
    }

    case 'wokwi_write_serial': {
      const text = String(args.text ?? '');
      const bridgeWrite = await callVsCodeBridge('write_serial', { text });
      if (bridgeWrite && bridgeWrite.ok) {
        return { sent: true, bytes: bridgeWrite.bytes, mode: 'vscode-bridge' };
      }
      if (simState.rfc2217Socket && !simState.rfc2217Socket.destroyed) {
        simState.rfc2217Socket.write(text, 'utf8');
        return { sent: true, bytes: Buffer.byteLength(text, 'utf8'), mode: 'rfc2217' };
      }
      if (simState.cliProcess && simState.cliProcess.stdin.writable) {
        simState.cliProcess.stdin.write(text, 'utf8');
        return { sent: true, bytes: Buffer.byteLength(text, 'utf8'), mode: 'cli' };
      }
      throw new Error(
        'No active serial connection. Start simulation with wokwi_start_simulation in VS Code or via rfc2217ServerPort.'
      );
    }

    case 'wokwi_wait_for_serial': {
      const timeoutMs = args.timeoutMs || 10000;
      const expectStr = args.expectText;
      const failStr = args.failText;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const bridgeSerial = await callVsCodeBridge('read_serial', { clear: false });
        const currentSerial =
          bridgeSerial && bridgeSerial.ok && bridgeSerial.output
            ? bridgeSerial.output
            : simState.serialBuffer;

        if (failStr && currentSerial.includes(failStr)) {
          return {
            matched: false,
            failed: true,
            reason: `Fail text "${failStr}" detected in serial output.`,
            serialOutput: currentSerial,
          };
        }
        if (currentSerial.includes(expectStr)) {
          return {
            matched: true,
            failed: false,
            expected: expectStr,
            serialOutput: currentSerial,
          };
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      return {
        matched: false,
        failed: true,
        reason: `Timed out after ${timeoutMs}ms waiting for "${expectStr}".`,
        serialOutput: simState.serialBuffer,
      };
    }

    case 'wokwi_read_pin': {
      const root = resolveProjectPath(args.projectPath || simState.projectPath);
      const diagramPath = path.join(root, 'diagram.json');
      if (!fs.existsSync(diagramPath)) {
        throw new Error(`diagram.json not found at ${diagramPath}`);
      }
      const diagram = JSON.parse(fs.readFileSync(diagramPath, 'utf8'));
      const part = (diagram.parts || []).find((p) => p.id === args.partId);
      if (!part) {
        throw new Error(`Part "${args.partId}" not found in ${diagramPath}`);
      }
      const targetEndpoint = `${args.partId}:${args.pin}`;
      const connectedPeers = (diagram.connections || [])
        .filter((c) => c[0] === targetEndpoint || c[1] === targetEndpoint)
        .map((c) => ({
          peerPin: c[0] === targetEndpoint ? c[1] : c[0],
          color: c[2],
        }));

      return {
        partId: args.partId,
        partType: part.type,
        pin: args.pin,
        connectedTo: connectedPeers,
        attrs: part.attrs || {},
      };
    }

    case 'wokwi_set_control': {
      const bridgeCtrl = await callVsCodeBridge('set_control', {
        partId: args.partId,
        control: args.control,
        value: args.value,
      });
      const root = resolveProjectPath(args.projectPath || simState.projectPath);
      const diagramPath = path.join(root, 'diagram.json');
      if (fs.existsSync(diagramPath)) {
        const diagram = JSON.parse(fs.readFileSync(diagramPath, 'utf8'));
        const part = (diagram.parts || []).find((p) => p.id === args.partId);
        if (part) {
          if (!part.attrs) part.attrs = {};
          part.attrs[args.control] = String(args.value);
          fs.writeFileSync(diagramPath, JSON.stringify(diagram, null, 2) + '\n', 'utf8');
        }
      }
      return {
        updated: true,
        liveBridgeSent: Boolean(bridgeCtrl && bridgeCtrl.ok),
        partId: args.partId,
        control: args.control,
        value: args.value,
        diagramPath: fs.existsSync(diagramPath) ? diagramPath : null,
      };
    }

    case 'wokwi_take_screenshot': {
      const root = resolveProjectPath(args.projectPath || simState.projectPath);
      const outPath = args.outputPath
        ? path.resolve(root, args.outputPath)
        : path.join(root, 'screenshot.png');
      const timeMs = String(args.timeMs || 1000);
      const cliArgs = [
        '--screenshot-part',
        args.partId,
        '--screenshot-time',
        timeMs,
        '--screenshot-file',
        outPath,
        '--timeout',
        String(Number(timeMs) + 2000),
        root,
      ];
      const out = execFileSync(WOKWI_CLI, cliArgs, { encoding: 'utf8' });
      return {
        success: fs.existsSync(outPath),
        screenshotPath: outPath,
        output: out.trim(),
      };
    }

    case 'wokwi_export_vcd': {
      const bridgeVcd = await callVsCodeBridge('export_vcd');
      if (bridgeVcd && bridgeVcd.ok) {
        return {
          success: true,
          mode: 'vscode-bridge',
          message: 'Requested VCD export from running VS Code Wokwi session.',
        };
      }
      const root = resolveProjectPath(args.projectPath || simState.projectPath);
      const outPath = path.resolve(root, args.outputPath);
      const timeoutMs = String(args.timeoutMs || 5000);
      const cliArgs = ['--vcd-file', outPath, '--timeout', timeoutMs, root];
      const out = execFileSync(WOKWI_CLI, cliArgs, { encoding: 'utf8' });
      return {
        success: fs.existsSync(outPath),
        vcdPath: outPath,
        output: out.trim(),
      };
    }

    case 'wokwi_vscode_control': {
      const root = resolveProjectPath(args.projectPath);
      const tomlPath = path.join(root, 'wokwi.toml');
      const diagramPath = path.join(root, 'diagram.json');
      let updatedToml = false;

      if (args.ensurePorts !== false && fs.existsSync(tomlPath)) {
        const parsed = parseWokwiToml(fs.readFileSync(tomlPath, 'utf8'));
        if (!parsed.wokwi.rfc2217ServerPort) {
          parsed.wokwi.rfc2217ServerPort = 4000;
          updatedToml = true;
        }
        if (!parsed.wokwi.gdbServerPort) {
          parsed.wokwi.gdbServerPort = 3333;
          updatedToml = true;
        }
        if (updatedToml) {
          fs.writeFileSync(tomlPath, serializeWokwiToml(parsed), 'utf8');
        }
      }

      const targets = [root];
      if (args.openDiagram !== false && fs.existsSync(diagramPath)) {
        targets.push(diagramPath);
      }

      let launched = false;
      try {
        execFileSync('open', ['-a', 'Visual Studio Code', ...targets], { stdio: 'ignore' });
        launched = true;
      } catch {
        try {
          execFileSync('code', targets, { stdio: 'ignore' });
          launched = true;
        } catch {}
      }

      return {
        projectPath: root,
        launchedInVsCode: launched,
        updatedTomlWithPorts: updatedToml,
        rfc2217ServerPort: 4000,
        gdbServerPort: 3333,
      };
    }

    case 'wokwi_configure_network': {
      const root = resolveProjectPath(args.projectPath);
      const tomlPath = path.join(root, 'wokwi.toml');
      const existing = fs.existsSync(tomlPath)
        ? parseWokwiToml(fs.readFileSync(tomlPath, 'utf8'))
        : { wokwi: { version: 1, firmware: 'flasher_args.json' }, net: {}, chips: [] };

      if (!existing.net) existing.net = {};
      if (args.gateway !== undefined) {
        if (args.gateway === null || args.gateway === '') {
          delete existing.net.gateway;
        } else {
          existing.net.gateway = args.gateway;
        }
      }
      if (Array.isArray(args.forwards)) {
        existing.net.forward = args.forwards;
      }

      const serialized = serializeWokwiToml(existing);
      fs.writeFileSync(tomlPath, serialized, 'utf8');
      return {
        success: true,
        tomlPath,
        netConfig: existing.net,
        content: serialized,
      };
    }

    case 'wokwi_provision_hardware': {
      const targetDir = resolveProjectPath(args.targetPath);
      fs.mkdirSync(targetDir, { recursive: true });
      const hwDir = path.join(WOKWI_HOME, 'hardware-elements');
      if (!fs.existsSync(hwDir)) {
        throw new Error(`Hardware elements repository not found at ${hwDir}`);
      }

      const copied = [];
      for (const file of ['weact_213_bw.chip.json', 'weact_213_bw.chip.wasm', 'wokwi.toml', 'partitions.csv']) {
        const src = path.join(hwDir, file);
        const dst = path.join(targetDir, file);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
          copied.push(file);
        }
      }

      if (args.includeDiagram !== false) {
        const srcDiag = path.join(hwDir, 'diagram.json');
        const dstDiag = path.join(targetDir, 'diagram.json');
        if (fs.existsSync(srcDiag) && !fs.existsSync(dstDiag)) {
          fs.copyFileSync(srcDiag, dstDiag);
          copied.push('diagram.json');
        }
      }

      if (args.includeScenarios !== false && fs.existsSync(path.join(hwDir, 'scenarios'))) {
        const dstScen = path.join(targetDir, 'scenarios');
        fs.mkdirSync(dstScen, { recursive: true });
        for (const f of fs.readdirSync(path.join(hwDir, 'scenarios'))) {
          fs.copyFileSync(path.join(hwDir, 'scenarios', f), path.join(dstScen, f));
          copied.push(`scenarios/${f}`);
        }
      }

      return {
        success: true,
        targetPath: targetDir,
        copiedFiles: copied,
      };
    }

    case 'wokwi_load_user_tok': {
      fs.mkdirSync(WOKWI_HOME, { recursive: true });
      const tokDest = path.join(WOKWI_HOME, 'user.tok');
      if (args.backupExisting !== false && fs.existsSync(tokDest)) {
        fs.copyFileSync(tokDest, `${tokDest}.bak`);
      }

      let rawContent = '';
      if (args.filePath) {
        const src = resolveProjectPath(args.filePath);
        if (!fs.existsSync(src)) {
          throw new Error(`user.tok source file not found: ${src}`);
        }
        rawContent = fs.readFileSync(src, 'utf8');
      } else if (args.content) {
        const c = String(args.content).trim();
        if (c.includes('key=')) {
          rawContent = c.endsWith('\n') ? c : c + '\n';
        } else {
          rawContent = `# Wokwi License\n\nkey=${c}\nts=${Date.now()}\n`;
        }
      } else {
        throw new Error('Provide either filePath or content to overwrite ~/.wokwi/user.tok.');
      }

      fs.writeFileSync(tokDest, rawContent, 'utf8');
      const bridgeRes = await callVsCodeBridge('load_user_tok', { content: rawContent });

      return {
        overwritten: true,
        userTokPath: tokDest,
        backupCreated: fs.existsSync(`${tokDest}.bak`),
        vsCodeSynced: Boolean(bridgeRes && bridgeRes.ok),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function validateChipJsonData(data) {
  const tmpFile = path.join(os.tmpdir(), `wokwi-chip-validate-${process.pid}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf8');
    return validateChipJson(tmpFile);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 / MCP Stdio Transport (Supports both newline JSON & Content-Length)
// ---------------------------------------------------------------------------
let useContentLengthFraming = false;

function sendJsonRpc(messageObj) {
  const json = JSON.stringify(messageObj);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

async function processRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  // Notifications have no id
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === 'initialize') {
      const clientProto = (params && params.protocolVersion) || '2024-11-05';
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: clientProto,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: {
            name: 'wokwi-offline-mcp',
            version: '1.0.0',
          },
        },
      });
      return;
    }

    if (method === 'ping') {
      sendJsonRpc({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      return;
    }

    if (method === 'resources/list') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: 'wokwi://schemas/diagram.schema.json',
              name: 'Wokwi diagram.json JSON Schema',
              mimeType: 'application/json',
              description: 'Official Wokwi diagram.json schema from VS Code extension 4.1.0',
            },
            {
              uri: 'wokwi://schemas/chip.schema.json',
              name: 'Wokwi chip.json JSON Schema',
              mimeType: 'application/json',
              description: 'Official Wokwi custom chip JSON schema',
            },
            {
              uri: 'wokwi://headers/wokwi-api.h',
              name: 'Wokwi Custom Chip C Header (wokwi-api.h)',
              mimeType: 'text/x-c',
              description: 'Bundled offline wokwi-api.h for custom WASM chips',
            },
          ],
        },
      });
      return;
    }

    if (method === 'resources/read') {
      const uri = params && params.uri;
      let filePath = null;
      let mimeType = 'text/plain';
      if (uri === 'wokwi://schemas/diagram.schema.json') {
        filePath = DIAGRAM_SCHEMA_PATH;
        mimeType = 'application/json';
      } else if (uri === 'wokwi://schemas/chip.schema.json') {
        filePath = CHIP_SCHEMA_PATH;
        mimeType = 'application/json';
      } else if (uri === 'wokwi://headers/wokwi-api.h') {
        filePath = WOKWI_API_H;
        mimeType = 'text/x-c';
      } else {
        throw new Error(`Unknown resource URI: ${uri}`);
      }
      const text = fs.readFileSync(filePath, 'utf8');
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [{ uri, mimeType, text }],
        },
      });
      return;
    }

    if (method === 'prompts/list') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: { prompts: [] },
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      try {
        const output = await handleToolCall(toolName, toolArgs);
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(output, null, 2),
              },
            ],
            isError: false,
          },
        });
      } catch (toolErr) {
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: toolErr.message }, null, 2),
              },
            ],
            isError: true,
          },
        });
      }
      return;
    }

    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  } catch (err) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err.message,
      },
    });
  }
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length > 0) {
    const preview = inputBuffer.slice(0, 64).toString('utf8');
    if (/^Content-Length:/i.test(preview)) {
      useContentLengthFraming = true;
      const headerEnd = inputBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const headerStr = inputBuffer.slice(0, headerEnd).toString('utf8');
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (inputBuffer.length < bodyStart + len) break;
      const bodyStr = inputBuffer.slice(bodyStart, bodyStart + len).toString('utf8');
      inputBuffer = inputBuffer.slice(bodyStart + len);
      try {
        processRpcMessage(JSON.parse(bodyStr));
      } catch {}
    } else {
      const nlIdx = inputBuffer.indexOf(0x0a);
      if (nlIdx === -1) break;
      const lineStr = inputBuffer.slice(0, nlIdx).toString('utf8').trim();
      inputBuffer = inputBuffer.slice(nlIdx + 1);
      if (!lineStr) continue;
      try {
        processRpcMessage(JSON.parse(lineStr));
      } catch {}
    }
  }
});
