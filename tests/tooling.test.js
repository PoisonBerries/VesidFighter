// The rule that decides when the slow 3D test runs.
const { test } = require('node:test');
const assert = require('node:assert');
const { needs3d } = require('../tools/needs-3d');

test('drawing/animation/3D changes trigger the 3D test', () => {
  for (const f of ['js/renderer3d.js', 'js/graphics.js', 'assets/stages/orchard-lite.glb', 'js/animator.js', 'js/abilityfx.js', 'js/renderer.js', 'js/effects.js', 'index.html', 'assets/heads/sam.png', 'assets/sprites/x.png', 'tests/e2e.test.js', 'package.json']) {
    assert.ok(needs3d([f]), `${f} should trigger the 3D test`);
  }
});

test('sound, netcode, balance, menus, music and docs do not', () => {
  for (const f of ['js/audio.js', 'js/net.js', 'js/ui.js', 'js/fighter.js', 'js/characters.js', 'js/constants.js', 'server/server.js', 'assets/music/a.mp3', 'assets/music/playlist.json', 'tests/sim.test.js', 'tests/README.md', 'style.css']) {
    assert.ok(!needs3d([f]), `${f} should not trigger the 3D test`);
  }
});

test('a mixed change triggers it if any file is relevant', () => {
  assert.ok(needs3d(['js/audio.js', 'js/animator.js']));
  assert.ok(!needs3d(['js/audio.js', 'js/net.js']));
  assert.ok(!needs3d([]));
});
