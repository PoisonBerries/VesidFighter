// Match stats: the round log the sim keeps, who reports a match (js/stats.js),
// and the server's /stats endpoints (server/server.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { ROOT } = require('./helpers');

const SIM_FILES = ['constants.js', 'stages.js', 'input.js', 'characters.js', 'effects.js', 'fighter.js', 'game.js'];
const ACTIONS = ['left', 'right', 'block', 'guard', 'jump', 'attack', 'special', 'ultimate'];
const source = SIM_FILES.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
const PRELUDE = `
  const window = { addEventListener() {} };
  const VCONTROLS = {};
  for (const slot of ['p1', 'p2']) { VCONTROLS[slot] = {}; for (const a of ${JSON.stringify(ACTIONS)}) VCONTROLS[slot][a] = 'V_' + slot + '_' + a; }
  const Net = { controlsFor: (slot) => VCONTROLS[slot] };
`;
const script = new vm.Script(PRELUDE + source + '\n({ Game, FIXED_STEP, ROUND_TIME });', { filename: 'sim.js' });
// The sim's arrays come from another realm; plain copies compare cleanly.
const plain = (v) => JSON.parse(JSON.stringify(v));
const createSim = () => script.runInContext(vm.createContext({ console, Math, JSON, performance: { now: () => 0 } }));

// Runs the sim until `ender` (called every fight frame) has finished the match.
function playOut(sim, ender) {
  let winner = null;
  for (let i = 0; i < 60 * 60 * 10 && !winner; i++) {
    if (sim.Game.getState() === 'fight') ender(sim.Game.world());
    sim.Game.update(sim.FIXED_STEP);
    if (sim.done) winner = sim.done;
  }
  return winner;
}

test('the sim logs how each round ended, for the stats', () => {
  const sim = createSim();
  sim.Game.startMatch('keenan', 'owen', (w) => { sim.done = w; }, { ball: 'off', balance: false });
  let round = 0;
  const winner = playOut(sim, (w) => {
    // Round 1: p2 KO'd. Round 2: p1 falls off. Round 3: p2 KO'd.
    if (round === 0) { w.p2.hp = 0; round++; } else if (round === 1 && w.p1.hp === w.p1.maxHp) { w.p1.y = 5000; w.p1.grounded = false; round++; } else if (round === 2 && w.p2.hp === w.p2.maxHp) { w.p2.hp = 0; round++; }
  });
  assert.strictEqual(winner, 'p1');
  const s = sim.Game.matchSummary();
  assert.deepStrictEqual(plain(s.rounds.map((r) => [r.w, r.how])), [['p1', 'ko'], ['p2', 'ringout'], ['p1', 'ko']]);
  for (const r of s.rounds) assert.ok(r.t >= 0 && r.t <= sim.ROUND_TIME);
  assert.strictEqual(s.hp[1], 0, 'the KO\'d fighter has no health left');
  assert.ok(s.hp[0] > 0);
});

test('a round that runs out of time is logged as "time"', () => {
  const sim = createSim();
  sim.Game.startMatch('sam', 'john', (w) => { sim.done = w; }, { ball: 'off', balance: false });
  const winner = playOut(sim, (w) => { w.p1.hp = w.p1.maxHp * 0.4; }); // nobody attacks: p2 ahead on health
  assert.strictEqual(winner, 'p2');
  assert.deepStrictEqual(plain(sim.Game.matchSummary().rounds.map((r) => r.how)), ['time', 'time']);
});

test('the round log is part of the rollback state (a replayed round is not logged twice)', () => {
  const sim = createSim();
  sim.Game.startMatch('carlos', 'ryan', () => {}, { ball: 'off', balance: false });
  while (sim.Game.getState() !== 'fight') sim.Game.update(sim.FIXED_STEP);
  const saved = JSON.parse(JSON.stringify(sim.Game.saveState()));
  sim.Game.world().p2.hp = 0;
  sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(sim.Game.matchSummary().rounds.length, 1);
  sim.Game.loadState(saved);
  assert.strictEqual(sim.Game.matchSummary().rounds.length, 0);
  sim.Game.world().p2.hp = 0;
  sim.Game.update(sim.FIXED_STEP);
  assert.strictEqual(sim.Game.matchSummary().rounds.length, 1);
});

// ---- js/stats.js: who reports ----
function loadStats({ host = 'poisonberries.github.io', protocol = 'https:', search = '', leader = true, webdriver = false } = {}) {
  const sent = [];
  const ctx = vm.createContext({
    GAME_SERVER_URL: 'wss://example.test',
    location: { hostname: host, host, protocol, search },
    navigator: { webdriver },
    URLSearchParams,
    Net: { isLeader: () => leader },
    Game: { matchSummary: () => ({ rounds: [{ w: 'p1', how: 'ko', t: 30 }, { w: 'p1', how: 'ringout', t: 20 }], hp: [0.5, 0] }) },
    fetch: (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve(); },
  });
  const Stats = new vm.Script(fs.readFileSync(path.join(ROOT, 'js/stats.js'), 'utf8') + '\nStats;').runInContext(ctx);
  return { Stats, sent };
}
const OPTS = { stage: 'orchard', ball: 'rally', balance: true };

test('local matches are reported from the live site only, never from localhost or the home network', () => {
  const { Stats, sent } = loadStats();
  assert.ok(Stats.reportMatch('local', 'keenan', 'owen', 'p1', OPTS));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].url, 'https://example.test/stats/match');
  assert.strictEqual(sent[0].body.duration, 50);
  for (const host of ['localhost', '127.0.0.1', '192.168.1.20', '10.0.0.5', '172.20.1.1', 'my-mac.local']) {
    const s = loadStats({ host });
    assert.strictEqual(s.Stats.reportMatch('local', 'keenan', 'owen', 'p1', OPTS), null, host);
    assert.strictEqual(s.sent.length, 0, host);
  }
  assert.strictEqual(loadStats({ host: '', protocol: 'file:' }).Stats.reportMatch('local', 'keenan', 'owen', 'p1', OPTS), null);
});

test('online matches are reported once (by player 1), from anywhere', () => {
  assert.ok(loadStats({ host: 'localhost' }).Stats.reportMatch('online', 'keenan', 'owen', 'p2', OPTS));
  assert.strictEqual(loadStats({ leader: false }).Stats.reportMatch('online', 'keenan', 'owen', 'p2', OPTS), null);
});

test('nothing is reported with ?nostats, from automated browsers, or for other modes', () => {
  assert.strictEqual(loadStats({ search: '?nostats' }).Stats.reportMatch('online', 'keenan', 'owen', 'p1', OPTS), null);
  assert.strictEqual(loadStats({ webdriver: true }).Stats.reportMatch('online', 'keenan', 'owen', 'p1', OPTS), null);
  assert.strictEqual(loadStats().Stats.reportMatch('cpu', 'keenan', 'owen', 'p1', OPTS), null);
});

test('vs CPU matches never reach the stats (ui.js only reports when not playing the CPU)', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');
  assert.match(ui, /if \(!cpuMode\) Stats\.reportMatch\(/);
});

// ---- server/server.js: /stats endpoints ----
test('the server stores valid matches and serves them back, filtered by date', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-stats-'));
  const file = path.join(dir, 'matches.jsonl');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: String(port), STATS_FILE: file }, stdio: 'pipe' });
  try {
    await new Promise((resolve, reject) => {
      proc.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
      proc.on('exit', () => reject(new Error('server exited')));
    });
    const base = `http://127.0.0.1:${port}`;
    const post = (body) => fetch(base + '/stats/match', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
    const good = { mode: 'online', p1: 'keenan', p2: 'owen', winner: 'p2', rounds: [{ w: 'p2', how: 'ko', t: 31.5 }, { w: 'p2', how: 'ringout', t: 12 }], hp: [0, 0.4], duration: 43.5, stage: 'orchard', ball: 'rally', balance: false, site: 'x' };
    assert.strictEqual((await post(good)).status, 200);
    assert.strictEqual((await post({ ...good, mode: 'local', winner: 'p1' })).status, 200);
    // Rejected: CPU games, unknown characters, missing winner, junk.
    assert.strictEqual((await post({ ...good, mode: 'cpu' })).status, 400);
    assert.strictEqual((await post({ ...good, p1: 'nobody' })).status, 400);
    assert.strictEqual((await post({ ...good, winner: 'p3' })).status, 400);
    assert.strictEqual((await fetch(base + '/stats/match', { method: 'POST', body: 'not json' })).status, 400);

    const res = await fetch(base + '/stats/matches');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    const { matches } = await res.json();
    assert.strictEqual(matches.length, 2);
    assert.deepStrictEqual(matches[0].rounds, good.rounds);
    assert.strictEqual(matches[0].winner, 'p2');
    assert.ok(Date.parse(matches[0].at) > Date.now() - 60000, 'the server stamps the time');
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);

    const future = new Date(Date.now() + 86400000).toISOString();
    assert.strictEqual((await (await fetch(base + '/stats/matches?from=' + future)).json()).matches.length, 0);
    assert.strictEqual((await (await fetch(base + '/stats/matches?to=' + future)).json()).matches.length, 2);
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
