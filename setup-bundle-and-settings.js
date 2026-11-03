#!/usr/bin/env node
/**
 * Helper for Wokwi Offline Installer:
 *  1. Disables VS Code extension auto-update in settings.json
 *  2. Extracts a valid Wokwi .wpk offline bundle into ~/.vscode/extensions/wokwi.wokwi-vscode-4.1.0/.cache
 *  3. Validates and writes a valid Wokwi license key into ~/.wokwi/user.tok
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const HOME = os.homedir();
const WOKWI_DIR = path.join(HOME, '.wokwi');
const EXT_VERSION = process.env.WOKWI_EXT_VERSION || '3.7.0';
const EXT_DIR = path.join(HOME, '.vscode', 'extensions', `wokwi.wokwi-vscode-${EXT_VERSION}`);
const CACHE_DIR = path.join(EXT_DIR, '.cache');
const VSCODE_SETTINGS =
  os.platform() === 'win32'
    ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json')
    : os.platform() === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    : path.join(HOME, '.config', 'Code', 'User', 'settings.json');

function disableVsCodeAutoUpdate() {
  fs.mkdirSync(path.dirname(VSCODE_SETTINGS), { recursive: true });
  let settings = {};
  if (fs.existsSync(VSCODE_SETTINGS)) {
    try {
      const raw = fs.readFileSync(VSCODE_SETTINGS, 'utf8');
      settings = JSON.parse(raw);
      fs.copyFileSync(VSCODE_SETTINGS, `${VSCODE_SETTINGS}.wokwi-bak`);
    } catch {
      // If settings.json has comments, preserve file and only warn
      console.log('[!] Could not parse settings.json as strict JSON; please ensure "extensions.autoUpdate": false is set.');
      return;
    }
  }
  settings['extensions.autoUpdate'] = false;
  settings['extensions.autoCheckUpdates'] = false;
  fs.writeFileSync(VSCODE_SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log('[+] Disabled extension auto-updates in VS Code settings.json');
}

function base64DblClickDecode(s) {
  let e = s.replace(/_P/g, '+').replace(/_S/g, '/').replace(/=/g, '');
  if (e.length % 4 === 2) e += '==';
  if (e.length % 4 === 3) e += '=';
  return e;
}

function parseLicense(keyStr) {
  try {
    const clean = keyStr.trim();
    const buf = Buffer.from(base64DblClickDecode(clean), 'base64');
    const nulIdx = buf.indexOf(0);
    if (nulIdx < 0) return null;
    const qs = buf.slice(0, nulIdx).toString('utf8');
    const params = new URLSearchParams(qs);
    const u = params.get('u');
    const n = params.get('n');
    const e = params.get('e');
    const x = params.get('x');
    const p = params.get('p') || 'Standard';
    const f = parseInt(params.get('f') || '0', 16) || 0;
    if (!u || !n || !e || !x || !/^[0-9]{8}$/.test(x)) return null;
    const exp = new Date(
      parseInt(x.slice(0, 4), 10),
      parseInt(x.slice(4, 6), 10) - 1,
      parseInt(x.slice(6, 8), 10)
    );
    return { userId: u, name: n, email: e, expiration: exp, plan: p, featuresMask: f };
  } catch {
    return null;
  }
}

function saveLicenseToken(inputKeyOrPath) {
  if (!inputKeyOrPath) return;
  const trimmed = inputKeyOrPath.trim();
  fs.mkdirSync(WOKWI_DIR, { recursive: true });
  const tokDest = path.join(WOKWI_DIR, 'user.tok');

  if (fs.existsSync(trimmed) && fs.statSync(trimmed).isFile()) {
    if (path.resolve(trimmed) !== path.resolve(tokDest)) {
      fs.copyFileSync(trimmed, tokDest);
    }
    const content = fs.readFileSync(tokDest, 'utf8');
    const keyLine = content.split(/\r?\n/).find((l) => l.trim().startsWith('key='));
    const key = keyLine ? keyLine.split('=')[1].trim() : null;
    const parsed = key ? parseLicense(key) : null;
    if (parsed) {
      console.log(`[+] Loaded valid license for ${parsed.name} <${parsed.email}> (Plan: ${parsed.plan}, Expires: ${parsed.expiration.toISOString().slice(0, 10)})`);
    } else {
      console.log(`[+] Copied license token file to ${tokDest}`);
    }
    return;
  }

  const parsed = parseLicense(trimmed);
  if (!parsed) {
    console.error('[!] Warning: Provided key did not match expected Wokwi license format, saving raw key to user.tok anyway.');
  } else {
    console.log(`[+] Validated Wokwi license for ${parsed.name} <${parsed.email}> (Plan: ${parsed.plan}, Expires: ${parsed.expiration.toISOString().slice(0, 10)})`);
  }

  const content = [
    '# Wokwi License',
    `# User: ${parsed ? parsed.name : 'Unknown'}`,
    `# Email: ${parsed ? parsed.email : 'Unknown'}`,
    '',
    `key=${trimmed}`,
    `ts=${Date.now()}`,
    '',
  ].join('\n');

  fs.writeFileSync(tokDest, content, 'utf8');
  console.log(`[+] Saved license token to ${tokDest}`);
}

function extractTarBuffer(tarBuf, destDir) {
  let offset = 0;
  let fileCount = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0/g, '');
    if (!name || name === '././@LongLink') {
      offset += 512;
      continue;
    }
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0/g, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    if (size > 0) {
      const fileData = tarBuf.subarray(offset + 512, offset + 512 + size);
      if (!name.includes('..') && !name.includes(':')) {
        const outPath = path.join(destDir, name);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, fileData);
        fileCount++;
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return fileCount;
}

function installBundleWpk(bundlePath) {
  if (!bundlePath) return;
  const resolved = path.resolve(process.cwd(), bundlePath.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Bundle file not found: ${resolved}`);
  }
  fs.mkdirSync(WOKWI_DIR, { recursive: true });
  const targetWpk = path.join(WOKWI_DIR, 'bundle.wpk');
  if (path.resolve(resolved) !== path.resolve(targetWpk)) {
    fs.copyFileSync(resolved, targetWpk);
    console.log(`[+] Copied bundle to ${targetWpk}`);
  }

  const raw = fs.readFileSync(targetWpk);
  const nlIdx = raw.indexOf(10);
  if (nlIdx < 0) {
    throw new Error('Invalid .wpk bundle header');
  }
  const headerStr = raw.subarray(0, nlIdx).toString('utf8').trim();
  const meta = headerStr.split(';').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = decodeURIComponent(v || '');
    return acc;
  }, {});

  if (meta.v !== '1' || meta.t !== 'vsc1') {
    throw new Error(`Unsupported .wpk bundle format: ${headerStr}`);
  }

  const payload = Buffer.from(raw.subarray(nlIdx + 1));
  for (let i = 0; i < payload.length; i++) {
    payload[i] ^= 66;
  }

  const ungzipped = zlib.gunzipSync(payload);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const extractedCount = extractTarBuffer(ungzipped, CACHE_DIR);
  console.log(`[+] Extracted ${extractedCount} files from bundle.wpk into ${CACHE_DIR}`);
}

const cmd = process.argv[2];
const arg = process.argv[3];

if (cmd === 'disable-autoupdate') {
  disableVsCodeAutoUpdate();
} else if (cmd === 'install-bundle') {
  installBundleWpk(arg);
} else if (cmd === 'save-license') {
  saveLicenseToken(arg);
}
