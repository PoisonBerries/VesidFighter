// Builds the Blender template for a stage from its gameplay layout in
// js/stages.js, so the two can't drift apart:
//
//   node tools/blender/make-template.js            -> blender/orchard_template.blend
//
// Needs Blender (set BLENDER=/path/to/blender if it isn't in /Applications).
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ctx = vm.createContext({});
const src = ['constants.js', 'stages.js'].map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
const { STAGES, GROUND_Y } = vm.runInContext(src + '\n;({ STAGES, GROUND_Y })', ctx);

const blender = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
const layoutFile = path.join(os.tmpdir(), 'vf-orchard-layout.json');
fs.writeFileSync(layoutFile, JSON.stringify({ groundY: GROUND_Y, stage: STAGES.orchard }));
const out = path.join(ROOT, 'blender', 'orchard_template.blend');
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(blender, ['-b', '--factory-startup', '-P', path.join(__dirname, 'orchard_template.py'), '--', layoutFile, out], { stdio: 'inherit' });
