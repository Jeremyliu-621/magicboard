# 11 — Online Lobbies & Phone Controllers

Players join a match by **scanning a QR code** with their phone; the phone becomes a landscape
**Brawlhalla-style** pad — a D-pad (bottom-left), a jump button (top-right), an attack button
(bottom-right), and a small special-aim joystick. Up to **6** can join one lobby. This is the one
part of the project that needs a server — everything else still runs from `file://`.

## Pieces
| File | Role |
|---|---|
| `server.js` | Node server: serves the game + the controller page + a `/qr` image + a **WebSocket relay** (`/ws`). Uses `ws` and `qrcode` (server-only deps in `package.json`). |
| `controller.html` | Mobile controller **and** the pre-game setup screen — draw your fighter, pick an ult, hit Ready; then a Brawlhalla-style pad. Loads `rng.js`/`draw.js`/`skin.js` so the phone builds the exact skin the host animates. |
| `js/net.js` | `DS.Net` — host-side: registers a lobby, receives phone input, exposes `DS.Net.player(slot)` in the **exact shape of `DS.Input.player(i)`**. |
| `js/main.js` | Builds the lobby UI in the menu (QR + 6-slot roster) and routes each phone slot to a fighter (`inputSource`). |

## How it connects
```
 phone (controller.html)  ──WS──▶  server.js relay  ◀──WS──  host browser (js/net.js)
        joystick+buttons            (lobby: 1 host             game reads DS.Net.player(slot)
        sends {x,y,a,b}              + up to 6 phones)          as if it were the keyboard
```
- Nothing is peer-to-peer; all input hops through the relay, so it works **across the internet**
  once `server.js` is deployed to a public host. The QR encodes `location.origin + '/c?lobby=CODE'`,
  so a deployed copy "just works" — the phone opens whatever URL the host is reachable at.
- The host page must be opened **via the server** (http/https) for multiplayer. From `file://`,
  `DS.Net.available()` is false and the lobby panel shows a keyboard-only note; the game is otherwise
  unchanged.

## Lobby on the phone (draw · ult · ready)
When a phone joins, it lands on a **setup screen** before the game pad:
- **Draw your fighter** — a draw pad that reuses the host's own `DS.skin`/`DS.draw` (same
  mannequin ghost, same stroke→body-part auto-assignment, same coordinate transform), so the
  phone builds the identical skin object the host already knows how to animate. Each finished
  stroke (and Undo/Clear) re-sends the whole skin, so the host preview updates live.
- **Pick an ultimate** — Hammer / Sniper / Werewolf, drawn with the same doodle icons as the host.
- **Ready** — flips the host's roster column to ✓ Ready. When every slot is ready the host's
  countdown fires; on match start the host broadcasts `play` and the phone flips to the pad.

The host lobby column for a phone slot is **read-only** (`📱 Pn`, "drawing on phone…", the
selected ult, and the live ready badge) — the phone owns those choices. Keyboard-only slots
(no phone on that slot) keep the host's own draw/ult/ready buttons as before. The host clears
stale `ready` and broadcasts `lobby` whenever the lobby (re)opens, so phones return to setup and
re-send their state between matches.

## The controller (Brawlhalla-style)
`controller.html` is a full-screen landscape pad — no top bar, so the buttons get the whole height;
the "You are Player N" status sits in the **centre** (non-interactive). Multitouch, a finger per side.
- **Left — D-pad:** four big overlapping circular arrow buttons (discrete). **◀/▶ = move** (held;
  **double-tap = dash** via the latched left/right press edges). **▲ = jump** (tap; multi-jump by
  tapping). **▼ = crouch / fast-fall / drop-through** (held).
- **Right — staggered cluster** (big, packed along the bottom-right diagonal):
  - **Attack** (largest, bottom-right corner) — tap = jab.
  - **Special joystick** (up-left of Attack) — press-drag-**release to fire**; **up/down drag aims**
    the shot (up / straight / down); a quick tap fires straight.
  - **Jump button** (up-left again) — a second jump (the ▲ arrow is the first); both send `{ev:'jump'}`.

So `▲`/jump-button send `{ev:'jump'}`, `▼` sends `{my:1}`, `◀/▶` send `{mx:∓1}`, Attack `{ev:'jab'}`,
Special `{ev:'special',aim}`. (Up-aim for the special comes from the joystick drag, not the D-pad.)

**Finger-slide:** a single touch manager on `#pad` hit-tests each finger's *current* position every
move (`document.elementFromPoint`), so you can **slide from one button to another without lifting**
(flick ◀→▶, etc.) — the old button releases and the new one presses (a tap button fires on slide-on).
A finger that *begins* on the special joystick is captured by it for aiming and won't trigger buttons
it passes over. Icons are hand-drawn rough-stroke SVGs (`<use>` of `#g-arrow`/`#g-star`/`#g-spark`,
ink via `currentColor`), no emoji.

## Protocol (JSON over `/ws`)
- host→server `{t:'host', lobby?}` → server replies `{t:'hosted', lobby}` (creates/reuses a 4-char code)
- phone→server `{t:'join', lobby, name}` → `{t:'joined', slot}` / `{t:'full'}` / `{t:'nolobby'}`; host is told `{t:'join', slot, name}`
- phone→server input (relayed to host as `{t:'in', slot, d}`):
  - movement (held): `{mx:-1|0|1, my:-1|0|1}`
  - one-shot actions: `{ev:'jab'}` · `{ev:'special', aim:-1|0|1}` · `{ev:'jump'}` (and the optional
    `{ev:'dash', dir:-1|1}`, which `DS.Net` still honors though the D-pad uses double-tap instead)
  - lobby choices (pre-match): `{ev:'skin', skin:{…}}` · `{ev:'ult', ult:'hammer'|'sniper'|'werewolf'}`
    · `{ev:'ready', ready:bool}` — `DS.Net` stores these on the player and fires `onChange` so the
    host lobby UI mirrors them live
- host→phones (broadcast via `DS.Net.broadcast`): `{t:'lobby'}` (re)open the setup screen ·
  `{t:'play'}` match started, flip to the pad · `{t:'assign', color}` tint the controller
- disconnect → host gets `{t:'leave', slot}`; if the host drops, phones get `{t:'hostgone'}`

`DS.Net` maps movement to held `left/right/up/down` and **latches each rising edge for one game
frame** (`DS.Net.update()` clears the latch after the game reads it). Because WS messages are
processed *between* animation frames, a latched tap is always read exactly once — taps are never
lost. Three correctness details:
- **D-pad left/right rising edges latch as `pressLeft`/`pressRight`**, so a quick double-tap of an
  arrow triggers the same double-tap dash the keyboard uses (`Fighter.update`); the explicit
  `input.dash` command is also honored for any controller that prefers a flick.
- **special aim holds `up`/`down` for a few frames *without* a jump press**, so aiming a special up
  never makes the fighter jump (jump only comes from the jump button's `{ev:'jump'}`).
- the contextual specials (`supershot`/`ultrapunch`) still apply: a phone that just dashed has
  momentum, so its special upgrades exactly like the keyboard's.

## Input routing & N-player matches
`inputSource.player(i)` returns `DS.Net.player(i+1)` if a phone is on that slot, else
`DS.Input.player(i)`. So **slot 1 → P1, slot 2 → P2, … slot 6 → P6** (keyboard still drives any
unfilled slot 1/2).

The match now spawns **one fighter per joined phone, up to 6** (free-for-all). `main.js` sets
`game.getPlayerCount = () => clamp(DS.Net.maxSlot() || 2, 2, 6)` (2 when keyboard-only), read live in
`Game.rebuild` so newly-joined phones are in the next match. What scaled to N:
- **Fighters/spawns:** `rebuild` builds N fighters; `_spawnPoints(n)` spreads them across the widest
  ground when a map has fewer than N spawns; `_variantChar` gives fighters 3–6 a distinct head +
  player colour (`PCOL`). `_respawn` drops you back above your own spawn.
- **Combat:** `world.opponents` was already N-aware; `_resolveBodies` now resolves all pairs;
  projectiles already hit any fighter; the demo AI targets the nearest opponent.
- **Scoring:** mode score arrays size to `game.fighters.length`; KotH banks time for a *sole*
  occupant (contested = nobody); `finishByScore`/`checkOver` pick the winner among N.
- **HUD:** 1v1 keeps the deluxe corner portraits; 3–6 show compact top-row cards (colour tag, face,
  %, hearts/score). Markers are player-coloured.

## Running it
```
npm install      # ws + qrcode (one time)
npm start        # = node server.js   → http://localhost:8080
```
Open `http://localhost:8080`, hit **≡ Menu** → the **Players** panel shows the QR + lobby code.
On the same network, point a phone's camera at the QR. (For LAN testing, phones need the host's LAN
IP, not `localhost` — set the QR origin accordingly or just deploy.)

### Going global
Deploy `server.js` to any Node host (Render / Fly / Railway / a VPS) with **HTTPS** (phones block the
camera on plain http, and an https page must use `wss://` — `net.js`/`controller.html` already pick
`wss` automatically on https). `npm start` is the start command; `/healthz` is a health check. No
state to persist — lobbies live in memory and vanish when empty.

## Ideas / backlog
- Let each phone pick its **colour** in the lobby (drawing + ult + ready already happen on the phone).
- A **"Start" button on the host phone**, and per-player names shown on the field.
- Spectator view / late-join as spectator until the next match.
