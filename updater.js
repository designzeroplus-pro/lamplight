/* Self-update for unsigned builds. macOS's built-in updater (Squirrel) only
 * replaces signed apps, so Lamplight does it itself:
 *   1. download the DMG for this Mac from the GitHub release and check it
 *      against the SHA-256 digest GitHub publishes for that asset;
 *   2. mount it read-only, make sure the app inside is Lamplight (same bundle
 *      id) at the expected version, and copy it next to the running app;
 *   3. after the app quits, a small shell script swaps the two copies (putting
 *      the old one back if anything fails) and opens the new one.
 * Only copies that can safely replace themselves do this: not run from a DMG
 * or a translocated (quarantined, read-only) path, and in a writable folder. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

// The DMG built for this Mac's architecture.
function pickAsset(assets, arch) {
  const dmgs = (assets || []).filter((a) => /\.dmg$/.test(a.name));
  return dmgs.find((a) => (arch === 'arm64' ? /arm64/.test(a.name) : !/arm64/.test(a.name))) || null;
}

// GitHub's "sha256:<hex>" asset digest, or null when the release has none.
function sha256Of(asset) {
  const m = String(asset?.digest || '').match(/^sha256:([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : null;
}

// /Applications/Lamplight.app from …/Lamplight.app/Contents/MacOS/Lamplight.
function bundleOf(exePath) {
  const m = String(exePath).match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/);
  return m ? m[1] : null;
}

// Why this copy can't replace itself (judging by its path), or null.
function blocker(bundle) {
  if (!bundle) return 'not-bundle';
  if (bundle.includes('/AppTranslocation/')) return 'translocated';
  if (bundle.startsWith('/Volumes/')) return 'volume';
  return null;
}

async function canReplace(bundle) {
  const why = blocker(bundle);
  if (why) return why;
  try {
    await fsp.access(path.dirname(bundle), fs.constants.W_OK);
    await fsp.access(bundle, fs.constants.W_OK);
  } catch {
    return 'readonly';
  }
  return null;
}

async function plistValue(plist, key) {
  const { stdout } = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  return stdout.trim();
}

// Streams the file to disk, hashing as it goes; throws unless size and digest match.
async function download(url, file, { size, sha256, onProgress, signal } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Lamplight' }, signal });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let received = 0;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - last > 120) { last = Date.now(); onProgress?.(received, total); }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  onProgress?.(received, total);
  if (size && received !== size) throw new Error('size mismatch');
  if (hash.digest('hex') !== sha256) throw new Error('digest mismatch');
}

// Copies the app out of the DMG to a hidden folder beside `bundle`; returns its path.
async function stage({ dmg, bundle, version, bundleId }) {
  const mnt = await fsp.mkdtemp(path.join(os.tmpdir(), 'lamplight-mnt-'));
  await run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mnt]);
  try {
    const name = (await fsp.readdir(mnt)).find((n) => n.endsWith('.app'));
    if (!name) throw new Error('no app in the DMG');
    const src = path.join(mnt, name);
    const plist = path.join(src, 'Contents', 'Info.plist');
    if ((await plistValue(plist, 'CFBundleIdentifier')) !== bundleId) throw new Error('bundle id mismatch');
    if ((await plistValue(plist, 'CFBundleShortVersionString')) !== version) throw new Error('version mismatch');
    const staged = path.join(path.dirname(bundle), `.${path.basename(bundle, '.app')}-${version}.app`);
    await fsp.rm(staged, { recursive: true, force: true });
    await run('/usr/bin/ditto', [src, staged]);
    return staged;
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mnt, '-force']).catch(() => {});
    await fsp.rm(mnt, { recursive: true, force: true }).catch(() => {});
  }
}

const SWAP = `#!/bin/sh
# Lamplight self-update: wait for the app to quit, swap in the new copy, reopen.
APP="$1"; NEW="$2"; PID="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
OLD="$APP.old-$$"
if mv "$APP" "$OLD"; then
  if mv "$NEW" "$APP"; then rm -rf "$OLD"; else mv "$OLD" "$APP"; rm -rf "$NEW"; fi
fi
open "$APP"
rm -f "$0"
`;

// Starts the swap script, detached, to run once this process (pid) exits.
function swapAfterQuit(bundle, staged, { pid = process.pid, env = process.env } = {}) {
  const script = path.join(os.tmpdir(), `lamplight-swap-${pid}.sh`);
  fs.writeFileSync(script, SWAP, { mode: 0o700 });
  const child = spawn('/bin/sh', [script, bundle, staged, String(pid)], { detached: true, stdio: 'ignore', env });
  child.unref();
  return child;
}

module.exports = { pickAsset, sha256Of, bundleOf, blocker, canReplace, plistValue, download, stage, swapAfterQuit };
