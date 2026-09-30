# Tests

Run everything with `npm test` (about a minute). First time: `npm install`.

| File | What it checks | Needs a browser |
|------|----------------|-----------------|
| `static.test.js` | Every script/asset/element id the code references actually exists; the server can load the sim files. Catches "I deleted a piece of the page and something else needed it". | no |
| `sim.test.js` | The simulation, built the same way `server/server.js` builds it: full matches for every character pairing with random inputs, determinism, snapshot round trips, the ledge rule, every move finishing. | no |
| `e2e.test.js` | The real page in headless Chrome: menus, starting a fight, both fighters actually drawn (pixel check), every character running its whole move set with rendering on, the online-guest snapshot path, mirror matches, sound and the playlist. | yes |

`npm run test:fast` skips the browser test (a few seconds).

The browser test uses your installed Chrome; set `CHROME_PATH` if it isn't found.
GitHub Actions runs `npm test` on every push (`.github/workflows/test.yml`).

## Running against another checkout

`ROOT=/path/to/other/checkout npm test` runs the same tests against different game files.
That is how a regression can be bisected: check out old commits and run the same test on each.

## When you add something

- New element the JS looks up by id: put it in `index.html` (the static test fails otherwise).
- New file in `js/`: add its `<script>` to `index.html` (also enforced).
- New character: add `assets/heads/<id>.png`; the sim and e2e tests pick the character up automatically.
- New ability type: the sim and e2e "every move finishes / is drawn" tests cover it as soon as a character uses it.
- Changes to `fighter.js`, `game.js`, `effects.js`, `characters.js` or `constants.js` also affect the online server; redeploy it.
