#!/usr/bin/env node
// Decides whether the slow 3D-view browser test is worth running for a set
// of changed files. Exit code 0 = yes, run it; 1 = no, skip it.
//
//   node tools/needs-3d.js js/audio.js assets/music/x.mp3      -> skip (exit 1)
//   git diff --name-only main | node tools/needs-3d.js --stdin  -> reads paths from stdin
//
// "Relevant" means: changes to how fighters/effects are drawn or animated, the
// 3D renderer itself, the page that hosts it, its assets, or the test.
// Sim-only changes (balance numbers, physics, netcode, sound, menus) are
// already covered by the fast 2D tests, so they don't trigger it.
const RELEVANT = [
  /^js\/renderer3d\.js$/,
  /^js\/graphics\.js$/,      // the graphics settings the 3D view runs on
  /^assets\/stages\//,       // the stage scenes (and their lite copies)
  /^js\/renderer\.js$/,
  /^js\/animator\.js$/,
  /^js\/abilityfx\.js$/,
  /^js\/effects\.js$/,
  /^js\/game\.js$/,          // owns the render hook that hands off to the 3D view
  /^js\/characterHeads\.js$/,
  /^index\.html$/,
  /^assets\/(heads|sprites)\//,
  /^tests\/e2e\.test\.js$/,
  /^tests\/helpers\.js$/,
  /^tools\/needs-3d\.js$/,
  /^package(-lock)?\.json$/,
];

function needs3d(files) {
  return files.map((f) => f.trim().replace(/^\.\//, '')).filter(Boolean).some((f) => RELEVANT.some((re) => re.test(f)));
}

module.exports = { needs3d, RELEVANT };

if (require.main === module) {
  const args = process.argv.slice(2);
  const run = (files) => {
    const yes = needs3d(files);
    console.log(yes ? 'yes: these changes affect the 3D view' : 'no: nothing here affects the 3D view');
    process.exit(yes ? 0 : 1);
  };
  if (args.includes('--stdin')) {
    let data = '';
    process.stdin.on('data', (d) => { data += d; });
    process.stdin.on('end', () => run(data.split('\n')));
  } else {
    run(args);
  }
}
