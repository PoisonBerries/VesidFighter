// Catches the "this function/variable doesn't exist" class of bug -- the kind
// that node --check can't see and only blows up at runtime, on whichever
// screen or move happens to reach it (e.g. a helper deleted by mistake while
// something still calls it).
//
// The game's files are classic scripts sharing globals, so the set of valid
// global names is everything the files declare at top level, plus the browser.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Linter } = require('eslint');
const globals = require('globals');
const { ROOT } = require('./helpers');

const dir = path.join(ROOT, 'js');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

// Names declared at the top level of any script -- read with a real parser, so
// `const A = 1, B = 2;` and destructuring count, not just the first name.
const espree = require('espree');
const gameGlobals = {};
const patternNames = (p, out) => {
  if (!p) return;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((q) => patternNames(q.value || q.argument, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((q) => patternNames(q, out));
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
};
for (const src of Object.values(sources)) {
  const isModule = /^\s*import\s/m.test(src);
  if (isModule) continue; // a module's top level is not global
  const ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script' });
  for (const node of ast.body) {
    const names = [];
    if (node.type === 'VariableDeclaration') node.declarations.forEach((d) => patternNames(d.id, names));
    else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) names.push(node.id.name);
    for (const n of names) gameGlobals[n] = 'readonly';
  }
}
// Loaded from CDNs / the page rather than declared in our files. Renderer3D only
// exists once the optional 3D module has loaded (game.js checks window.Renderer3D first).
Object.assign(gameGlobals, { Peer: 'readonly', THREE: 'readonly', Renderer3D: 'readonly' });

const linter = new Linter();

test('no code refers to a function or variable that does not exist (no-undef)', () => {
  const problems = [];
  for (const [file, code] of Object.entries(sources)) {
    const isModule = /^\s*import\s/m.test(code); // renderer3d.js is an ES module
    const messages = linter.verify(code, {
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: isModule ? 'module' : 'script',
        globals: { ...globals.browser, ...gameGlobals },
      },
      rules: { 'no-undef': 'error' },
    }, { filename: file });
    for (const m of messages) problems.push(`${file}:${m.line}:${m.column} ${m.message}`);
  }
  assert.deepStrictEqual(problems, [], 'undefined names found:\n' + problems.join('\n'));
});

test('the check itself works: it flags a call to a function that is not defined', () => {
  const messages = linter.verify('function a() { drawGoneMissing(1); }', {
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: {} },
    rules: { 'no-undef': 'error' },
  });
  assert.ok(messages.some((m) => /drawGoneMissing/.test(m.message)));
});
