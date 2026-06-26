// How to Play: a live gallery of every mechanic. Each grid cell runs a REAL Fighter
// (DS.Fighter) in a tiny mock world, fed a scripted, looping input timeline, so the
// demos are the actual game — real dash arcs, weapon morphs, projectiles, ultimates.
// Rendered as a generic stick figure (BEAR_SKIN is nulled while drawing) so the rig,
// not a particular character, is what's being taught. Opened by the ? button.
(function (global) {
  'use strict';
  const DS = global.DS, D = DS.draw;

  const GY = 600;                                  // ground top (world units)
  const FIG = 0.8;                                 // shrink the demo figure in its box (feet stay planted)
  const HUGE = { left: -1e5, right: 1e5, top: -1e5, bottom: 1e5 }; // never KO in a demo
  const I = () => ({ left: 0, right: 0, up: 0, down: 0, pressLeft: 0, pressRight: 0,
    pressUp: 0, pressDown: 0, pressAttack: 0, pressSpecial: 0, shield: 0, dash: 0, specialDir: 0 });
  const edge = (tc, p, t) => p < t && tc >= t;      // a tap crossed time t this frame

  // ---- mock world (mirrors Game.world's projectile seams; no HUD/camera/KO) ----------
  function makeWorld(data, stage) {
    const effects = new DS.Effects();
    const game = { projectiles: [], mode: { elimination: false, onKO() {} } };
    const world = {
      settings: data.settings, platforms: stage.platforms, stage, view: data.view,
      effects, game, blast: HUGE, bounds: null,
      _opps: [],
      get fighters() { return world._opps.concat(world._self ? [world._self] : []); },
      opponents(self) { return world._opps.filter((o) => o !== self); },
      onChange() {}, damageBox() {},
      spawnProjectile(owner, cfg, aimDeg) {
        const a = ((cfg.angle || 0) + (aimDeg || 0)) * Math.PI / 180;
        game.projectiles.push({ owner, cfg, x: owner.x + 40 * owner.facing, y: owner.y - 6,
          vx: Math.cos(a) * owner.facing * cfg.speed, vy: -Math.sin(a) * cfg.speed,
          life: cfg.life, r: cfg.r, facing: owner.facing, spin: 0 });
        effects.dust(owner.x + 30 * owner.facing, owner.y, owner.facing);
      },
      spawnProjectileAt(owner, cfg, ang) {
        const ca = Math.cos(ang), sa = Math.sin(ang);
        game.projectiles.push({ owner, cfg, x: owner.x + ca * 46, y: owner.y - 6 + sa * 46,
          vx: ca * cfg.speed, vy: sa * cfg.speed, life: cfg.life, r: cfg.r, facing: ca >= 0 ? 1 : -1, spin: 0 });
        effects.dust(owner.x + ca * 34, owner.y - 6 + sa * 34, ca >= 0 ? 1 : -1);
      },
      spawnBoomerang(owner, cfg, aimDeg) {
        const a = (aimDeg || 0) * Math.PI / 180, ca = Math.cos(a) * owner.facing, sa = -Math.sin(a);
        game.projectiles.push({ owner, cfg, boomerang: true, phase: 'out', originX: owner.x, originY: owner.y - 6,
          x: owner.x + ca * 36, y: owner.y - 6 + sa * 36, vx: ca * cfg.speed, vy: sa * cfg.speed,
          life: 3.5, r: cfg.r, facing: owner.facing, spin: 0, hits: new Set() });
        effects.charge(owner.x + ca * 30, owner.y - 6 + sa * 30, owner.tagCol);
      },
    };
    return world;
  }

  // projectile sim — a trimmed copy of Game._updateProjectiles / _updateBoomerang
  function stepProjectiles(world, dt) {
    const arr = world.game.projectiles;
    for (const pr of arr) {
      if (pr.fade != null) { pr.fade -= dt; pr.spin += dt * 22; pr.x += pr.vx * dt; pr.y += pr.vy * dt; continue; }
      if (pr.boomerang) {
        const cfg = pr.cfg; pr.spin += dt * 26; pr.life -= dt;
        if (pr.phase === 'out') {
          pr.x += pr.vx * dt; pr.y += pr.vy * dt; const k = 1 - dt * 1.6; pr.vx *= k; pr.vy *= k;
          const dist = Math.hypot(pr.x - pr.originX, pr.y - pr.originY);
          if (dist >= cfg.range || Math.hypot(pr.vx, pr.vy) < cfg.speed * 0.18) { pr.phase = 'back'; pr.hits.clear(); }
        } else {
          const o = pr.owner, dx = o.x - pr.x, dy = (o.y - 6) - pr.y, d = Math.hypot(dx, dy) || 1, sp = cfg.speed * 1.1;
          pr.vx = dx / d * sp; pr.vy = dy / d * sp; pr.x += pr.vx * dt; pr.y += pr.vy * dt;
          if (d < 42 || pr.life <= 0) pr.dead = true;
        }
        continue;
      }
      pr.life -= dt; pr.spin += dt * 16;
      pr.vy += (pr.cfg.gravity || 0) * dt;
      pr.x += pr.vx * dt; pr.y += pr.vy * dt;
      if (pr.life <= 0) pr.fade = 0.2;
    }
    world.game.projectiles = arr.filter((p) => !p.dead && (p.fade == null || p.fade > 0));
  }

  function renderProjectiles(ctx, world) {
    for (const pr of world.game.projectiles) {
      const rnd = DS.makeRng(((pr.spin * 50) | 0) + 1);
      const oc = (pr.owner && pr.owner.tagCol) || D.COL.power, ocDeep = D.mix(oc, D.COL.ink, 0.45);
      const a = pr.fade != null ? Math.max(0, pr.fade / 0.2) : 1;
      ctx.save(); ctx.globalAlpha = a;
      if (pr.boomerang) {                              // spinning blue hammer
        ctx.translate(pr.x, pr.y); ctx.rotate(pr.spin); ctx.scale(1.85, 1.85);
        D.line(ctx, 0, 18, 0, -16, { width: 6, color: oc, rnd, passes: 1 });
        D.strokePts(ctx, [[-11, -16], [15, -16], [15, -33], [-11, -33]], { width: 5, color: oc, rnd, closed: true, fill: ocDeep });
      } else {                                         // a thrown doodle spark + motion streak
        const ult = pr.cfg && pr.cfg.ult, col = ult ? oc : D.COL.ink, sp = Math.hypot(pr.vx, pr.vy) || 1;
        const ux = pr.vx / sp, uy = pr.vy / sp, r = pr.r * 0.6;
        ctx.globalAlpha = a * 0.5;
        D.line(ctx, pr.x - ux * r * 3.4, pr.y - uy * r * 3.4, pr.x, pr.y, { width: r * 1.1, color: col, rnd, passes: 1 });
        ctx.globalAlpha = a;
        D.circle(ctx, pr.x, pr.y, r, { width: 4, color: col, rnd, fill: ult ? ocDeep : D.COL.paperShade, wob: 1.5 });
      }
      ctx.restore();
    }
  }

  function drawGround(ctx) {
    ctx.save();
    ctx.fillStyle = D.COL.paperShade; ctx.fillRect(-3000, GY, 6000, 800);
    D.line(ctx, -3000, GY, 3000, GY, { width: 5, color: D.COL.ink, passes: 1 });
    ctx.restore();
  }

  // ---- the mechanics catalogue ------------------------------------------------------
  // each: { section, name, keys, T (loop secs), spawn?, cam?, stage?(plats), ult?,
  //         dummy?:{x}, drive(d,tc,prev)->input, post?(d), overlay?(d,ctx) }
  // cam.cy is the world Y placed at fraction anchorY down the cell; ground (GY) sits low.
  // `follow` eases the camera toward the fighter each frame so dashes/jumps stay in frame.
  const BASECAM = { cx: 0, cy: GY, s: 1.0, anchorY: 0.82 };
  const FOLLOWGND = { cx: 0, cy: GY, s: 0.82, anchorY: 0.78, follow: true, groundBias: true };
  const FOLLOWAIR = { cx: 0, cy: GY, s: 0.62, anchorY: 0.52, follow: true };

  const DEMOS = [
    // ---------------- MOVE ---------------- (basic run/jump omitted — obvious)
    { section: 'Move', name: 'Dash', keys: 'double-tap ▶', T: 2.4, cam: FOLLOWGND,
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.2)) i.dash = 1; if (edge(tc, p, 1.3)) i.dash = -1; return i; } },

    { section: 'Move', name: 'Air-Dash', keys: 'Jump → dash', T: 2.0, cam: FOLLOWAIR,
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.12)) i.pressUp = 1; if (edge(tc, p, 0.5)) i.dash = 1; return i; } },

    { section: 'Move', name: 'Fast-Fall', keys: 'hold ▼ in air', T: 1.9, cam: FOLLOWAIR,
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.08)) i.pressUp = 1; if (tc > 0.5) i.down = 1; return i; } },

    { section: 'Move', name: 'Drop-Through', keys: '▼ on platform', T: 2.0, cam: { cy: GY - 110, s: 0.5, anchorY: 0.62 },
      stage: (plats) => { plats.push({ x: -130, y: GY - 220, w: 260, h: 20, pass: true }); },
      spawn: { x: 0, y: GY - 320 },
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.7)) { i.pressDown = 1; i.down = 1; } return i; } },

    { section: 'Move', name: 'Ledge Grab', keys: 'fall by an edge', T: 2.6, cam: { cx: 50, cy: GY - 60, s: 0.8, anchorY: 0.5 },
      stage: (plats) => { plats.push({ x: -60, y: GY - 70, w: 120, h: 270, pass: false }); },
      spawn: { x: 86, y: GY - 40 },
      drive: (d, tc, p) => { const i = I(); if (tc > 1.7) i.down = 1; return i; } },

    { section: 'Move', name: 'Shield', keys: 'hold Shield', T: 2.0, cam: BASECAM,
      drive: (d, tc) => { const i = I(); if (tc > 0.3 && tc < 1.8) i.shield = 1; return i; } },

    // ---------------- ATTACK ----------------
    { section: 'Attack', name: 'Jab', keys: 'Attack', T: 1.8, cam: BASECAM,
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.3) || edge(tc, p, 0.8) || edge(tc, p, 1.3)) i.pressAttack = 1; return i; } },

    { section: 'Attack', name: 'Hammer Slam', keys: 'Attack in air', T: 2.4, cam: FOLLOWAIR,
      spawn: { x: 0, y: GY - 360 },           // already airborne (no up-press) → an air jab is the hammer
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.35)) i.pressAttack = 1; return i; } },

    { section: 'Attack', name: 'Rising Spear', keys: 'Jump → Attack', T: 2.1, cam: FOLLOWAIR,
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.08)) i.pressUp = 1; if (edge(tc, p, 0.24)) i.pressAttack = 1; return i; } },

    { section: 'Attack', name: 'Super Punch', keys: 'dash → Attack', T: 2.2, cam: FOLLOWGND,
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.15)) i.dash = 1; if (edge(tc, p, 0.32)) i.pressAttack = 1; return i; } },

    // ---------------- SPECIAL ----------------
    { section: 'Special', name: 'Special Shot', keys: 'Special', T: 2.0, cam: { s: 0.82 },
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.5)) i.pressSpecial = 1; return i; } },

    { section: 'Special', name: 'Aim Up/Down', keys: 'hold ▲/▼ + Special', T: 2.2, cam: { s: 0.78 },
      drive: (d, tc, p) => { const i = I(); if (tc > 0.2 && tc < 0.85) i.up = 1; if (edge(tc, p, 0.55)) i.pressSpecial = 1; return i; } },

    { section: 'Special', name: 'Ultra Punch', keys: 'dash → Special (close)', T: 2.2, cam: FOLLOWGND, dummy: { x: 92 },
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.15)) i.dash = 1; if (edge(tc, p, 0.32)) i.pressSpecial = 1; return i; } },

    { section: 'Special', name: 'Super Shot', keys: 'dash → Special (far)', T: 2.2, cam: FOLLOWGND,
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.15)) i.dash = 1; if (edge(tc, p, 0.32)) i.pressSpecial = 1; return i; } },

    // ---------------- SYSTEMS ----------------
    { section: 'Systems', name: 'Momentum', keys: 'a dash charges it', T: 2.2, cam: FOLLOWGND,
      drive: (d, tc, p) => { const i = I(); if (edge(tc, p, 0.3)) i.dash = 1; return i; },
      overlay: (d, ctx) => {
        const f = d.fighter, m = Math.max(0, Math.min(1, f.momentum)), w = 96, h = 13, x = f.x - w / 2, y = f.y - f.h / 2 - 50;
        ctx.save();
        ctx.fillStyle = D.COL.paper; ctx.strokeStyle = D.COL.ink; ctx.lineWidth = 2.5;
        ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = m > 0.4 ? D.COL.accent : D.COL.inkSoft; ctx.fillRect(x + 1.5, y + 1.5, (w - 3) * m, h - 3);
        ctx.beginPath(); ctx.moveTo(x + w * 0.4, y - 4); ctx.lineTo(x + w * 0.4, y + h + 4); ctx.stroke();
        ctx.restore();
      } },

    { section: 'Systems', name: 'Combo', keys: 'chain hits', T: 2.6, cam: { s: 0.82 }, dummy: { x: 66 },
      drive: (d, tc, p) => { const i = I(); for (const t of [0.3, 0.55, 0.8, 1.05, 1.3, 1.55, 1.8]) if (edge(tc, p, t)) i.pressAttack = 1; return i; },
      overlay: (d, ctx) => {
        const f = d.fighter; if (f.combo > 1) {
          ctx.save(); ctx.fillStyle = D.COL.accent; ctx.textAlign = 'center';
          ctx.font = "26px 'Patrick Hand', sans-serif"; ctx.fillText(f.combo + '× COMBO', f.x, f.y - f.h / 2 - 44);
          ctx.restore();
        }
      } },

    // ---------------- ULTIMATES ----------------
    { section: 'Ultimates', name: 'Boomerang Hammer', keys: '2× Special (charged)', T: 3.0, cam: { cx: 150, cy: GY, s: 0.36, anchorY: 0.82 }, ult: 'hammer',
      drive: (d, tc, p) => { const i = I(); activate(d, tc, p, 0.4); return i; } },

    { section: 'Ultimates', name: 'Sniper', keys: '2× Special, aim, fire', T: 3.2, cam: { cx: 30, cy: GY, s: 0.55, anchorY: 0.8 }, ult: 'sniper',
      drive: (d, tc, p) => { const i = I(); activate(d, tc, p, 0.35); if (tc > 0.7 && tc < 1.4) { i.up = 1; i.right = 1; } if (edge(tc, p, 1.45)) i.pressSpecial = 1; return i; } },

    { section: 'Ultimates', name: 'Werewolf', keys: '2× Special, then maul', T: 3.4, cam: { cx: 20, cy: GY, s: 0.5, anchorY: 0.86 }, ult: 'werewolf', dummy: { x: 96 },
      drive: (d, tc, p) => { const i = I(); activate(d, tc, p, 0.4); for (const t of [1.1, 1.4, 1.7, 2.0]) if (edge(tc, p, t)) i.pressAttack = 1; if (edge(tc, p, 2.5)) i.pressSpecial = 1; return i; } },
  ];

  // per-move blurb + the button SEQUENCE shown under the box. each step lights up at time `t`
  // (synced to the demo's drive), so the chips "press" in the same order the move happens.
  // glyphs: ▲▼ a held/pressed direction · ▶▶ double-tap a direction (dash) · W jump ·
  // F attack · G special · ⇧ shield. (the footer legend maps these to the literal P1/P2 keys.)
  const META = {
    'Dash':            { desc: 'A quick forward burst — and it charges momentum.', seq: [{ t: 0.2, chips: ['▶', '▶'] }] },
    'Air-Dash':        { desc: 'Dash in mid-air; it refreshes on every jump.', seq: [{ t: 0.12, chips: ['W'] }, { t: 0.5, chips: ['▶', '▶'] }] },
    'Fast-Fall':       { desc: 'Hold down in the air to drop faster.', seq: [{ t: 0.08, chips: ['W'] }, { t: 0.5, hold: true, chips: ['▼'] }] },
    'Drop-Through':    { desc: 'Press down to fall through soft platforms.', seq: [{ t: 0.7, chips: ['▼'] }] },
    'Ledge Grab':      { desc: 'Fall past an edge to catch it, then jump to recover.', seq: [{ t: 1.7, chips: ['W'] }] },
    'Shield':          { desc: 'Hold to block hits — you take no knockback.', seq: [{ t: 0.3, hold: true, chips: ['⇧'] }] },
    'Jab':             { desc: 'Instant poke, zero startup. Spam it to start combos.', seq: [{ t: 0.3, chips: ['F'] }, { t: 0.8, chips: ['F'] }, { t: 1.3, chips: ['F'] }] },
    'Hammer Slam':     { desc: 'Attack in the air: an overhead meteor spike down.', seq: [{ t: 0.35, chips: ['F'] }] },
    'Rising Spear':    { desc: 'Attack right after a jump: rocket straight up.', seq: [{ t: 0.08, chips: ['W'] }, { t: 0.24, chips: ['F'] }] },
    'Super Punch':     { desc: 'With momentum, a committed power punch.', seq: [{ t: 0.15, chips: ['▶', '▶'] }, { t: 0.32, chips: ['F'] }] },
    'Special Shot':    { desc: 'Throw a ranged doodle projectile.', seq: [{ t: 0.5, chips: ['G'] }] },
    'Aim Up/Down':     { desc: 'Hold up or down as you fire to angle the shot.', seq: [{ t: 0.2, hold: true, chips: ['▲'] }, { t: 0.55, chips: ['G'] }] },
    'Ultra Punch':     { desc: 'Momentum + close range = a big launcher.', seq: [{ t: 0.15, chips: ['▶', '▶'] }, { t: 0.32, chips: ['G'] }] },
    'Super Shot':      { desc: 'Momentum + range = a bigger, faster blast.', seq: [{ t: 0.15, chips: ['▶', '▶'] }, { t: 0.32, chips: ['G'] }] },
    'Momentum':        { desc: 'A dash fills it; it powers all the super moves.', seq: [{ t: 0.3, chips: ['▶', '▶'] }] },
    'Combo':           { desc: 'Chain hits within the window — more damage each.', seq: [{ t: 0.3, chips: ['F'] }, { t: 0.55, chips: ['F'] }, { t: 0.8, chips: ['F'] }] },
    'Boomerang Hammer':{ desc: 'Ultimate: a hammer flies out, then homes back.', seq: [{ t: 0.4, chips: ['G', 'G'] }] },
    'Sniper':          { desc: 'Ultimate: aim a huge, hard-hitting laser shot.', seq: [{ t: 0.35, chips: ['G', 'G'] }, { t: 1.45, chips: ['G'] }] },
    'Werewolf':        { desc: 'Ultimate: transform — faster, more jumps, maul.', seq: [{ t: 0.4, chips: ['G', 'G'] }, { t: 1.1, chips: ['F'] }, { t: 1.4, chips: ['F'] }] },
  };

  // cleanly enter an ultimate at time t (skips the double-tap noise of a stray first shot)
  function activate(d, tc, p, t) {
    if (edge(tc, p, t) && !d.fighter.ult && !(d.fighter.action && d.fighter.action.name === 'ulthammer')) {
      d.fighter.charge = 1; d.fighter._activateUlt(d.world);
    }
  }

  // ---- build / lifecycle ------------------------------------------------------------
  let built = false, demos = [], grid = null, raf = 0, open = false, lastT = 0, data = null, chName = '';

  function baseStage(extra, spawn) {
    const plats = [{ x: -1400, y: GY, w: 2800, h: 500, pass: false }];
    if (extra) extra(plats);
    return { platforms: plats, spawns: [spawn || { x: 0, y: GY - 38 }], decor: [], bg: [] }; // feet on the ground
  }

  function resetDemo(d) {
    const f = d.fighter;
    f.reset(data); f.invuln = 0; f.damage = 0; f.combo = 0; f.comboT = 0; f.momentum = 0; f.charge = 0; f.ult = null;
    if (d.cfg.ult) f.ultType = d.cfg.ult; f._setSize ? (f.h = 74 * f.scale, f.w = 42 * f.scale) : 0;
    d.world.game.projectiles.length = 0; d.world.effects.reset();
    if (d.cam && d.cam.follow) { d.cam.cx = f.x; d.cam.cy = Math.min(GY, f.y); } // snap, no carry-over lag
    if (d.dummy) { const u = d.dummy; u.reset(data); u.x = d.cfg.dummy.x; u.y = GY - u.h / 2; u.facing = -1; u.invuln = 0; u.damage = 0; }
  }

  function buildDemo(cfg) {
    const stage = baseStage(cfg.stage, cfg.spawn);
    const world = makeWorld(data, stage);
    const fighter = new DS.Fighter(chName, data, 0, stage, cfg.spawn || stage.spawns[0]);
    fighter.tagCol = '#3f6fa0';
    world._self = fighter;
    const d = { cfg, fighter, world, tc: 0, cam: Object.assign({}, BASECAM, cfg.cam), drive: cfg.drive, overlay: cfg.overlay };
    if (cfg.dummy) { d.dummy = new DS.Fighter(chName, data, 1, stage, { x: cfg.dummy.x, y: GY - 60 }); world._opps.push(d.dummy); }
    resetDemo(d);
    return d;
  }

  // a fresh isolated data copy so demos never touch the user's saved characters/settings
  function loadData() {
    data = DS.data.defaults();
    chName = Object.keys(data.characters)[0];
    data.settings = Object.assign({}, data.settings, { blast: HUGE });
  }

  function buildGrid() {
    grid = document.getElementById('howto-grid');
    if (!grid) return;
    grid.innerHTML = '';
    loadData();
    demos = [];
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    let section = '', cells = null;
    for (const cfg of DEMOS) {
      if (cfg.section !== section) {                 // start a new section BLOCK (hugs its own cells, wraps 2-up)
        section = cfg.section;
        const sec = document.createElement('div'); sec.className = 'howto-sec';
        sec.style.setProperty('--n', Math.min(4, DEMOS.filter((x) => x.section === section).length));
        const h = document.createElement('div'); h.className = 'howto-section'; h.textContent = section;
        cells = document.createElement('div'); cells.className = 'howto-cells';
        sec.appendChild(h); sec.appendChild(cells); grid.appendChild(sec);
      }
      const meta = META[cfg.name] || { desc: '', seq: [] };
      const cell = document.createElement('div'); cell.className = 'howto-cell'; cell.title = cfg.name + (meta.desc ? ' — ' + meta.desc : '');
      const cv = document.createElement('canvas'); cv.className = 'howto-cv';
      const sq = document.createElement('div'); sq.className = 'howto-seq';   // floats over the canvas, top-right
      cell.appendChild(cv); cell.appendChild(sq); cells.appendChild(cell);
      const d = buildDemo(cfg); d.canvas = cv; d.ctx = cv.getContext('2d'); d.dpr = dpr;
      // build the animated button row: one .howto-step per press, '→' between steps
      d.steps = []; d._on = [];
      (meta.seq || []).forEach((step, si) => {
        if (si) { const ar = document.createElement('span'); ar.className = 'howto-arrow'; ar.textContent = '→'; sq.appendChild(ar); }
        const el = document.createElement('span'); el.className = 'howto-step' + (step.hold ? ' hold' : '');
        for (const c of step.chips) { const k = document.createElement('kbd'); k.textContent = c; el.appendChild(k); }
        sq.appendChild(el);
        d.steps.push({ el, t: step.t, hold: step.hold, dur: step.dur || 0.22 }); d._on.push(false);
      });
      demos.push(d);
    }
    built = true;
    sizeCanvases();
  }

  function sizeCanvases() {
    for (const d of demos) {
      const cw = d.canvas.clientWidth || 220, ch = d.canvas.clientHeight || 150;
      d.cw = cw; d.ch = ch;
      d.canvas.width = Math.round(cw * d.dpr); d.canvas.height = Math.round(ch * d.dpr);
    }
  }

  function renderDemo(d) {
    const ctx = d.ctx, cam = d.cam;
    ctx.setTransform(d.dpr, 0, 0, d.dpr, 0, 0);
    ctx.fillStyle = D.COL.paper; ctx.fillRect(0, 0, d.cw, d.ch);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, d.cw, d.ch); ctx.clip();
    ctx.translate(d.cw / 2, d.ch * cam.anchorY);
    ctx.scale(cam.s * FIG, cam.s * FIG);
    ctx.translate(-cam.cx, -cam.cy);
    drawGround(ctx);
    if (d.dummy) { ctx.save(); ctx.globalAlpha = 0.4; d.dummy.render(ctx, d.world); ctx.restore(); }
    d.fighter.render(ctx, d.world);
    renderProjectiles(ctx, d.world);
    d.world.effects.render(ctx);
    if (d.overlay) d.overlay(d, ctx);
    ctx.restore();
  }

  function loop(ts) {
    if (!open) return;
    const dt = Math.min(0.033, lastT ? (ts - lastT) / 1000 : 0.016); lastT = ts;
    const savedMuted = DS.Audio ? DS.Audio.muted : false; if (DS.Audio) DS.Audio.muted = true;
    const savedBear = DS.BEAR_SKIN; DS.BEAR_SKIN = null;   // force the generic stick-figure rig
    try {
      for (const d of demos) {
        d.tc += dt;
        if (d.tc >= d.cfg.T) { d.tc -= d.cfg.T; resetDemo(d); }
        const input = d.drive ? d.drive(d, d.tc, d.tc - dt) : I();
        d.fighter.update(dt, input, d.world);
        if (d.dummy) { const u = d.dummy; u.vx = 0; u.vy = 0; u.hitstun = 0; u.invuln = 0; u.damage = 0; u.x = d.cfg.dummy.x; u.y = GY - u.h / 2; u.onGround = true; }
        if (d.cam.follow) {                              // ease toward the fighter so it stays framed
          const ty = Math.min(GY - (d.cam.groundBias ? 6 : 0), d.fighter.y);
          d.cam.cx += (d.fighter.x - d.cam.cx) * Math.min(1, dt * 6);   // loose: lateral motion reads
          d.cam.cy += (ty - d.cam.cy) * Math.min(1, dt * 16);           // stiff: keep jumps in frame
        }
        stepProjectiles(d.world, dt);
        d.world.effects.update(dt);
        renderDemo(d);
        if (d.steps) for (let k = 0; k < d.steps.length; k++) {   // light each button as its press comes up
          const s = d.steps[k], on = s.hold ? d.tc >= s.t : (d.tc >= s.t && d.tc < s.t + s.dur);
          if (on !== d._on[k]) { d._on[k] = on; s.el.classList.toggle('on', on); }
        }
      }
    } finally {
      DS.BEAR_SKIN = savedBear;
      if (DS.Audio) DS.Audio.muted = savedMuted;
    }
    raf = requestAnimationFrame(loop);
  }

  function onResize() { if (open) sizeCanvases(); }

  const HowTo = {
    open() {
      if (!built) buildGrid();
      else { for (const d of demos) { d.tc = 0; resetDemo(d); } }
      open = true; lastT = 0;
      requestAnimationFrame(() => { sizeCanvases(); });   // measure after the overlay lays out
      cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
    },
    close() { open = false; cancelAnimationFrame(raf); },
    _probe() { return demos.map((d) => ({ name: d.cfg.name, act: d.fighter.action && d.fighter.action.name,
      ult: d.fighter.ult && d.fighter.ult.type, mom: +d.fighter.momentum.toFixed(2), combo: d.fighter.combo,
      onGround: d.fighter.onGround, ledge: !!d.fighter.ledge, proj: d.world.game.projectiles.length })); },
  };
  global.addEventListener('resize', onResize);
  DS.HowTo = HowTo;
})(window);
