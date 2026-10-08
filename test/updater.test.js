const test = require('node:test');
const assert = require('node:assert/strict');
const { pickAsset, sha256Of, bundleOf, blocker } = require('../updater');

const assets = [
  { name: 'Lamplight-0.4.1.dmg', digest: `sha256:${'a'.repeat(64)}` },
  { name: 'Lamplight-0.4.1-arm64.dmg', digest: `sha256:${'B'.repeat(64)}` },
  { name: 'Lamplight-0.4.1-arm64.dmg.blockmap' },
];

test('pickAsset takes the DMG for this architecture', () => {
  assert.equal(pickAsset(assets, 'arm64').name, 'Lamplight-0.4.1-arm64.dmg');
  assert.equal(pickAsset(assets, 'x64').name, 'Lamplight-0.4.1.dmg');
  assert.equal(pickAsset([], 'arm64'), null);
});

test('sha256Of reads GitHub asset digests, or null', () => {
  assert.equal(sha256Of(assets[1]), 'b'.repeat(64));
  assert.equal(sha256Of(assets[2]), null);
  assert.equal(sha256Of({ digest: 'sha512:abc' }), null);
});

test('bundleOf finds the .app around the executable', () => {
  assert.equal(bundleOf('/Applications/Lamplight.app/Contents/MacOS/Lamplight'), '/Applications/Lamplight.app');
  assert.equal(bundleOf('/usr/local/bin/electron'), null);
});

test('blocker refuses copies that cannot replace themselves', () => {
  assert.equal(blocker('/Applications/Lamplight.app'), null);
  assert.equal(blocker('/private/var/folders/x/AppTranslocation/ABC/d/Lamplight.app'), 'translocated');
  assert.equal(blocker('/Volumes/Lamplight 0.4.0/Lamplight.app'), 'volume');
  assert.equal(blocker(null), 'not-bundle');
});
