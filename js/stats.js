// Match stats: reports each finished online or local 2-player match to the
// game server (server/server.js keeps them; stats.html shows them).
//
// - Vs CPU matches are never reported.
// - Online, only player 1 reports, so a match is counted once.
// - Local matches are only reported from the deployed site, not from
//   localhost / a LAN address / a file, where the game gets tested.
// - ?nostats on the URL turns reporting off for that page load, and
//   automated browsers (the e2e tests) never report.

const Stats = (() => {
  const STATS_URL = GAME_SERVER_URL ? GAME_SERVER_URL.replace(/^ws/, 'http') : '';

  function isDevHost(loc) {
    if (!loc || loc.protocol === 'file:') return true;
    const h = loc.hostname;
    return h === 'localhost' || h === '' || h === '[::1]' || h === '::1' || h.endsWith('.local')
      || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  }

  // Off for ?nostats and for automated browsers (the e2e tests).
  function enabled() {
    if (typeof navigator !== 'undefined' && navigator.webdriver) return false;
    return typeof location !== 'undefined' && !new URLSearchParams(location.search).has('nostats');
  }

  // mode: 'online' | 'local'. Returns the record it sent (or null), mostly for tests.
  function reportMatch(mode, p1, p2, winner, opts) {
    if (!STATS_URL || !enabled()) return null;
    if (mode === 'online' && !Net.isLeader()) return null;
    if (mode === 'local' && isDevHost(location)) return null;
    if (mode !== 'online' && mode !== 'local') return null;
    const summary = Game.matchSummary() || { rounds: [], hp: null };
    const rec = {
      mode, p1, p2, winner,
      rounds: summary.rounds,
      hp: summary.hp,
      duration: summary.rounds.reduce((s, r) => s + (r.t || 0), 0),
      stage: opts.stage,
      ball: opts.ball,
      balance: opts.balance,
      site: location.host,
    };
    try {
      // text/plain keeps this a "simple" request (no CORS preflight); keepalive
      // lets it finish even if the tab is closed right after the match.
      fetch(STATS_URL + '/stats/match', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(rec),
        keepalive: true,
      }).catch(() => {});
    } catch (e) { /* stats are best-effort */ }
    return rec;
  }

  return { STATS_URL, isDevHost, reportMatch };
})();
