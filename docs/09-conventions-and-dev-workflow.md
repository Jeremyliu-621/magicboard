# 09 — Conventions & Dev Workflow

## Code style
- **Vanilla ES (browser), no build, no deps.** No TypeScript, no bundler, no npm.
- One global namespace: `window.DS`. Each file is an IIFE that attaches to `DS`
  (`DS.draw`, `DS.Store`, `DS.Fighter`, `DS.Game`, `DS.skin`, ...).
- **Classic `<script>` tags in dependency order** (see `01`). Do NOT switch to ES modules — the game
  must run from `file://` by double-clicking `index.html`, and module CORS breaks that.
- No `fetch` of local files (also `file://`-hostile). Default content is embedded in `js/data.js`;
  persistence is `localStorage`; sharing is Export/Import JSON.
- 2-space indent, semicolons, small focused functions, terse comments that explain *why*.
- All drawing goes through `js/draw.js`. All tunables go through `js/data.js`.

## Running it
- **Simplest:** open `index.html` in a browser (double-click).
- **Local server** (nicer URL, what we usually use):
  ```
  python3 -m http.server 8000 --bind 127.0.0.1 --directory /Users/jliu/Code2/doodle-smash
  ```
  → http://localhost:8000/  (a server is often left running in the background during sessions.)

## Dev URL hooks (hash routes in `js/main.js`)
Harmless, behind `location.hash`, useful for testing/demos:
- `#play` — start a match immediately.
- `#demo` — attract mode: two AI fighters battle (also zone with the projectile).
- `#editor`, `#editor-draw`, `#editor-stage`, `#editor-settings` — open the editor on a sub-tab.
- `#skindraw` — inject a test skin on both fighters + demo (verifies skin render/animation).
- **Self-tests** that print `PASS`/`FAIL` to the on-page banner: `#dragtest` (platform drag),
  `#drawtest` (stroke auto-tag), `#projtest` (projectile damage), `#pooftest` (projectile fade,
  freezes mid-fade), `#dashtest` (ground dash trail + air dash).

## How to verify (no console in normal runs)
There's no devtools console in the way these run, so:
1. **On-page error banner** — `index.html` installs `window.onerror`/`unhandledrejection` →
   `__showErr(msg)`, which paints a red banner at the bottom. JS errors show up in screenshots.
   Self-tests also use `window.__showErr(...)` to print results.
2. **Headless screenshots** (deterministic, repeatable):
   ```
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --headless=new --disable-gpu --hide-scrollbars --window-size=1500,860 \
     --virtual-time-budget=2500 --screenshot=/tmp/shot.png "http://localhost:8000/#play"
   ```
   Then view the PNG. Use `#...test` hooks for logic you can't eyeball, and freeze-then-`paused`
   tricks (see `#pooftest`/`#dashtest`) to capture a transient frame.
3. **Real browser** when you need true rAF timing (headless virtual-time doesn't advance the match
   timer normally). Activating/!sizing the Chrome window via AppleScript is finicky; prefer headless
   + hooks where possible.

## Git
- Personal remote (push under the personal identity, not work):
  `git@github-personal-host` → `git@github.com-personal:Jeremyliu-621/doodle-smash.git`.
  Repo-local `user.name=Jeremyliu-621`, `user.email=jeremyliu621@gmail.com`.
- Commit/push when a feature is verified. Keep commits scoped with a clear subject + why.

## Gotchas to remember
- Keep `canvas.width/height` synced to CSS size every frame (`syncSize` in `main.js`) — otherwise
  squished render + broken editor clicks (see `07`).
- Static shapes need a **stable seed**; only quick FX should "boil" (see `02 §3`).
- Editor mutates `Store.data` in place; the game reads it on `rebuild()` — "Play test" rebuilds.
- Changing the view size or default stage layout? Consider a storage-key bump or migration (`06`).
