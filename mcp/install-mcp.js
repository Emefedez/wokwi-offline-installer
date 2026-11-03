#!/usr/bin/env node
/**
 * Multi-Client Wokwi Offline MCP Installer
 *
 * Supports installing, removing, and checking status of the Wokwi Offline MCP
 * across:
 *   - t3          (T3 Code: configures Claude Code, Codex, and ~/.t3code/mcp.json)
 *   - anthropic   (Anthropic Claude Desktop + Claude Code CLI)
 *   - claude-code (~/.claude.json)
 *   - claude-desktop (~/Library/Application Support/Claude/claude_desktop_config.json)
 *   - opencode    (~/.config/opencode/opencode.json)
 *   - codex       (~/.codex/config.toml)
 *   - antigravity (~/.gemini/config/mcp_config.json)
 *   - vscode      (~/Library/Application Support/Code/User/mcp.json)
 *   - cursor      (~/.cursor/mcp.json)
 *   - zed         (~/.config/zed/settings.json)
 *   - all         (All detected clients on this machine)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const NODE_BIN = process.execPath || '/opt/homebrew/bin/node';
const SERVER_SCRIPT = path.join(HOME, '.wokwi', 'mcp', 'server.js');
const SERVER_NAME = 'wokwi';

const TARGETS = {
  'claude-code': {
    label: 'Anthropic Claude Code (~/.claude.json)',
    configPath: path.join(HOME, '.claude.json'),
    format: 'mcpServers-stdio',
  },
  'claude-desktop': {
    label: 'Anthropic Claude Desktop (claude_desktop_config.json)',
    configPath: path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    format: 'mcpServers',
  },
  opencode: {
    label: 'OpenCode (~/.config/opencode/opencode.json)',
    configPath: path.join(HOME, '.config', 'opencode', 'opencode.json'),
    format: 'opencode',
  },
  codex: {
    label: 'Codex (~/.codex/config.toml)',
    configPath: path.join(HOME, '.codex', 'config.toml'),
    format: 'codex-toml',
  },
  't3-standalone': {
    label: 'T3 Code (~/.t3code/mcp.json)',
    configPath: path.join(HOME, '.t3code', 'mcp.json'),
    format: 'mcpServers',
  },
  antigravity: {
    label: 'Antigravity / Gemini CLI (~/.gemini/config/mcp_config.json)',
    configPath: path.join(HOME, '.gemini', 'config', 'mcp_config.json'),
    format: 'mcpServers',
  },
  vscode: {
    label: 'VS Code (~/Library/Application Support/Code/User/mcp.json)',
    configPath: path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    format: 'vscode-servers',
  },
  cursor: {
    label: 'Cursor (~/.cursor/mcp.json)',
    configPath: path.join(HOME, '.cursor', 'mcp.json'),
    format: 'mcpServers',
  },
  zed: {
    label: 'Zed (~/.config/zed/settings.json)',
    configPath: path.join(HOME, '.config', 'zed', 'settings.json'),
    format: 'zed-context-servers',
  },
};

function backupFile(filePath) {
  if (fs.existsSync(filePath)) {
    const bakPath = `${filePath}.wokwi-bak`;
    fs.copyFileSync(filePath, bakPath);
  }
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeJsonSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function installTarget(key, customToken) {
  const target = TARGETS[key];
  if (!target) throw new Error(`Unknown target: ${key}`);

  const envObj = {
    WOKWI_HOME: path.join(HOME, '.wokwi'),
    WASI_SDK_PATH: path.join(HOME, '.wokwi', 'wasi-sdk'),
    ...(customToken ? { WOKWI_CLI_TOKEN: customToken } : {}),
  };

  if (target.format === 'codex-toml') {
    fs.mkdirSync(path.dirname(target.configPath), { recursive: true });
    let content = fs.existsSync(target.configPath)
      ? fs.readFileSync(target.configPath, 'utf8')
      : '';
    backupFile(target.configPath);
    content = removeCodexSection(content, SERVER_NAME);
    const block = [
      '',
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${JSON.stringify(NODE_BIN)}`,
      `args = [${JSON.stringify(SERVER_SCRIPT)}]`,
      '',
      `[mcp_servers.${SERVER_NAME}.env]`,
      `WOKWI_HOME = ${JSON.stringify(envObj.WOKWI_HOME)}`,
      `WASI_SDK_PATH = ${JSON.stringify(envObj.WASI_SDK_PATH)}`,
      ...(customToken ? [`WOKWI_CLI_TOKEN = ${JSON.stringify(customToken)}`] : []),
      '',
    ].join('\n');
    fs.writeFileSync(target.configPath, content.trimEnd() + '\n' + block, 'utf8');
    console.log(`[+] Installed '${SERVER_NAME}' into ${target.label}`);
    return;
  }

  const data = readJsonSafe(target.configPath);

  if (target.format === 'mcpServers' || target.format === 'mcpServers-stdio') {
    if (!data.mcpServers || typeof data.mcpServers !== 'object') {
      data.mcpServers = {};
    }
    data.mcpServers[SERVER_NAME] = {
      ...(target.format === 'mcpServers-stdio' ? { type: 'stdio' } : {}),
      command: NODE_BIN,
      args: [SERVER_SCRIPT],
      env: envObj,
    };
  } else if (target.format === 'opencode') {
    if (!data.mcp || typeof data.mcp !== 'object') {
      data.mcp = {};
    }
    data.mcp[SERVER_NAME] = {
      type: 'local',
      enabled: true,
      timeout: 30000,
      command: [NODE_BIN, SERVER_SCRIPT],
      environment: envObj,
    };
  } else if (target.format === 'vscode-servers') {
    if (!data.servers || typeof data.servers !== 'object') {
      data.servers = {};
    }
    data.servers[SERVER_NAME] = {
      type: 'stdio',
      command: NODE_BIN,
      args: [SERVER_SCRIPT],
      env: envObj,
    };
  } else if (target.format === 'zed-context-servers') {
    if (!data.context_servers || typeof data.context_servers !== 'object') {
      data.context_servers = {};
    }
    data.context_servers[SERVER_NAME] = {
      command: {
        path: NODE_BIN,
        args: [SERVER_SCRIPT],
        env: envObj,
      },
    };
  }

  writeJsonSafe(target.configPath, data);
  console.log(`[+] Installed '${SERVER_NAME}' into ${target.label}`);
}

function removeCodexSection(tomlContent, serverName) {
  const lines = tomlContent.split(/\r?\n/);
  const out = [];
  let skipping = false;
  const headerPrefix = `[mcp_servers.${serverName}`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      if (trimmed === `[mcp_servers.${serverName}]` || trimmed.startsWith(`${headerPrefix}.`)) {
        skipping = true;
        continue;
      } else {
        skipping = false;
      }
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function uninstallTarget(key) {
  const target = TARGETS[key];
  if (!target || !fs.existsSync(target.configPath)) return;

  if (target.format === 'codex-toml') {
    const content = fs.readFileSync(target.configPath, 'utf8');
    const updated = removeCodexSection(content, SERVER_NAME);
    fs.writeFileSync(target.configPath, updated, 'utf8');
    console.log(`[-] Removed '${SERVER_NAME}' from ${target.label}`);
    return;
  }

  const data = readJsonSafe(target.configPath);
  if (data.mcpServers && data.mcpServers[SERVER_NAME]) delete data.mcpServers[SERVER_NAME];
  if (data.mcp && data.mcp[SERVER_NAME]) delete data.mcp[SERVER_NAME];
  if (data.servers && data.servers[SERVER_NAME]) delete data.servers[SERVER_NAME];
  if (data.context_servers && data.context_servers[SERVER_NAME]) delete data.context_servers[SERVER_NAME];
  writeJsonSafe(target.configPath, data);
  console.log(`[-] Removed '${SERVER_NAME}' from ${target.label}`);
}

function statusTargets() {
  console.log('Wokwi Offline MCP Server Status:');
  console.log(`  Server Script : ${SERVER_SCRIPT} (${fs.existsSync(SERVER_SCRIPT) ? 'OK' : 'MISSING'})`);
  console.log(`  Node Runtime  : ${NODE_BIN}`);
  console.log('');
  for (const [key, target] of Object.entries(TARGETS)) {
    const exists = fs.existsSync(target.configPath);
    let installed = false;
    if (exists) {
      try {
        const raw = fs.readFileSync(target.configPath, 'utf8');
        if (target.format === 'codex-toml') {
          installed = raw.includes(`[mcp_servers.${SERVER_NAME}]`);
        } else {
          const j = JSON.parse(raw);
          installed = Boolean(
            (j.mcpServers && j.mcpServers[SERVER_NAME]) ||
              (j.mcp && j.mcp[SERVER_NAME]) ||
              (j.servers && j.servers[SERVER_NAME]) ||
              (j.context_servers && j.context_servers[SERVER_NAME])
          );
        }
      } catch {}
    }
    console.log(
      `  [${installed ? 'INSTALLED' : exists ? 'NOT SET  ' : 'NO CONFIG'}] ${key.padEnd(16)} -> ${target.configPath}`
    );
  }
}

function expandTargetAliases(rawArgs) {
  const expanded = new Set();
  for (const arg of rawArgs) {
    const a = arg.toLowerCase();
    if (a === 'anthropic' || a === 'claude') {
      expanded.add('claude-code');
      expanded.add('claude-desktop');
    } else if (a === 't3' || a === 't3-code' || a === 't3code') {
      // T3 Code uses Claude Code + Codex backends as well as its own config
      expanded.add('claude-code');
      expanded.add('codex');
      expanded.add('t3-standalone');
    } else if (a === 'gemini') {
      expanded.add('antigravity');
    } else if (a === 'all') {
      for (const k of Object.keys(TARGETS)) {
        const cfgDir = path.dirname(TARGETS[k].configPath);
        if (fs.existsSync(TARGETS[k].configPath) || fs.existsSync(cfgDir) || k === 'antigravity' || k === 't3-standalone') {
          expanded.add(k);
        }
      }
    } else if (TARGETS[a]) {
      expanded.add(a);
    } else {
      throw new Error(
        `Unknown client "${arg}". Valid targets: t3, anthropic, claude-code, claude-desktop, opencode, codex, antigravity, vscode, cursor, zed, all`
      );
    }
  }
  return Array.from(expanded);
}

function installCustomJsonFile(filePath, customToken) {
  const abs = path.resolve(process.cwd(), filePath);
  const data = readJsonSafe(abs);
  const envObj = {
    WOKWI_HOME: path.join(HOME, '.wokwi'),
    WASI_SDK_PATH: path.join(HOME, '.wokwi', 'wasi-sdk'),
    ...(customToken ? { WOKWI_CLI_TOKEN: customToken } : {}),
  };
  if (data.mcp && !data.mcpServers) {
    data.mcp[SERVER_NAME] = {
      type: 'local',
      enabled: true,
      timeout: 30000,
      command: [NODE_BIN, SERVER_SCRIPT],
      environment: envObj,
    };
  } else {
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers[SERVER_NAME] = {
      command: NODE_BIN,
      args: [SERVER_SCRIPT],
      env: envObj,
    };
  }
  writeJsonSafe(abs, data);
  console.log(`[+] Installed '${SERVER_NAME}' into custom config: ${abs}`);
}

function printHelp() {
  console.log(`Usage: install-mcp.sh <command> [targets...] [options]

Commands:
  install <targets...>   Install Wokwi Offline MCP into specified client(s)
  uninstall <targets...> Remove Wokwi Offline MCP from specified client(s)
  status                 Show installation status across all supported AI tools

Targets:
  t3               T3 Code (configures Claude Code, Codex, and ~/.t3code/mcp.json)
  anthropic        Anthropic Claude Desktop & Claude Code CLI
  claude-code      Anthropic Claude Code (~/.claude.json)
  claude-desktop   Anthropic Claude Desktop (claude_desktop_config.json)
  opencode         OpenCode (~/.config/opencode/opencode.json)
  codex            Codex (~/.codex/config.toml)
  antigravity      Antigravity / Gemini CLI (~/.gemini/config/mcp_config.json)
  vscode           VS Code User MCP (~/Library/Application Support/Code/User/mcp.json)
  cursor           Cursor (~/.cursor/mcp.json)
  zed              Zed (~/.config/zed/settings.json)
  all              All detected AI coding clients on this machine

Options:
  --file <path>    Install into a custom JSON config file path
  --token <tok>    Optional WOKWI_CLI_TOKEN to include in MCP environment

Examples:
  ~/.wokwi/mcp/install-mcp.sh install t3 anthropic
  ~/.wokwi/mcp/install-mcp.sh install all
  ~/.wokwi/mcp/install-mcp.sh status
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const cmd = argv[0];
  if (cmd === 'status') {
    statusTargets();
    return;
  }

  let customFile = null;
  let customToken = process.env.WOKWI_CLI_TOKEN || null;
  const rawTargets = [];

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--file' && argv[i + 1]) {
      customFile = argv[++i];
    } else if (argv[i] === '--token' && argv[i + 1]) {
      customToken = argv[++i];
    } else {
      rawTargets.push(argv[i]);
    }
  }

  if (cmd === 'install') {
    if (customFile) {
      installCustomJsonFile(customFile, customToken);
    }
    const targets = expandTargetAliases(rawTargets.length === 0 && !customFile ? ['all'] : rawTargets);
    for (const t of targets) {
      installTarget(t, customToken);
    }
  } else if (cmd === 'uninstall' || cmd === 'remove') {
    const targets = expandTargetAliases(rawTargets.length === 0 ? ['all'] : rawTargets);
    for (const t of targets) {
      uninstallTarget(t);
    }
  } else {
    // Allow shorthand: `install-mcp.sh t3 anthropic`
    const targets = expandTargetAliases(argv);
    for (const t of targets) {
      installTarget(t, customToken);
    }
  }
}

main();
