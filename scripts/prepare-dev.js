#!/usr/bin/env node
/* Builds the native speech helper and, for `npm start`, gives the stock
 * Electron.app the speech-recognition usage string macOS requires before it
 * will show the permission prompt. Packaged builds get the same key from
 * electron-builder's extendInfo, so this only touches node_modules. */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);

const root = path.join(__dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

// 1. native helper — a universal binary (Apple silicon + Intel) that runs on
//    the same macOS versions as Electron itself (13.0+).
const outDir = path.join(root, 'native', 'bin');
fs.mkdirSync(outDir, { recursive: true });
const MIN_MACOS = '13.0';
const slices = ['arm64', 'x86_64'].map((arch) => {
  const out = path.join(outDir, `lamplight-transcriber-${arch}`);
  run('swiftc', [
    '-O',
    '-target', `${arch}-apple-macos${MIN_MACOS}`,
    path.join(root, 'native', 'Transcriber.swift'),
    '-o', out,
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
    '-Xlinker', path.join(root, 'native', 'Info.plist'),
  ]);
  return out;
});
run('lipo', ['-create', ...slices, '-output', path.join(outDir, 'lamplight-transcriber')]);
slices.forEach((f) => fs.rmSync(f));
console.log('built native/bin/lamplight-transcriber (universal, macOS ' + MIN_MACOS + '+)');

// 2. dev Electron.app: speech usage string, plus the Lamplight name and icon
//    so the Dock and menu bar don't say "Electron" during development.
const app = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(app, 'Contents', 'Info.plist');
if (fs.existsSync(plist)) {
  const read = (key) => {
    try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim(); } catch { return null; }
  };
  const set = (key, value) => {
    const op = read(key) === null ? `Add :${key} string ${value}` : `Set :${key} ${value}`;
    run('/usr/libexec/PlistBuddy', ['-c', op, plist]);
  };
  let changed = false;
  const want = {
    NSSpeechRecognitionUsageDescription: '회의 녹음을 실시간으로 받아 적기 위해 음성 인식이 필요합니다.',
    CFBundleName: 'Lamplight',
    CFBundleDisplayName: 'Lamplight',
  };
  for (const [key, value] of Object.entries(want)) {
    if (read(key) !== value) { set(key, value); changed = true; }
  }
  const icon = path.join(root, 'build', 'icon.icns');
  const devIcon = path.join(app, 'Contents', 'Resources', 'electron.icns');
  if (fs.existsSync(icon) && !fs.readFileSync(icon).equals(fs.readFileSync(devIcon))) {
    fs.copyFileSync(icon, devIcon);
    changed = true;
  }
  if (changed) {
    // Editing the bundle breaks its seal; re-sign ad hoc so macOS accepts it.
    run('codesign', ['--force', '--deep', '--sign', '-', app]);
    console.log('prepared dev Electron.app (speech permission text, name, icon)');
  }
}
