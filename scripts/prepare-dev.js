#!/usr/bin/env node
/* For `npm start`: give the stock Electron.app the Lamplight name and icon so
 * the Dock and menu bar don't say "Electron" during development. Packaged
 * builds get both from electron-builder, so this only touches node_modules. */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);

const root = path.join(__dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

// Dev Electron.app: the Lamplight name and icon
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
    console.log('prepared dev Electron.app (name, icon)');
  }
}
