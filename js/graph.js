// js/graph.js — DS.Graph: the bounded-but-composable mechanic interpreter ("primitive graph").
//
// THE EVOLUTION of the single-node spec: instead of CHLOE picking 1 of 7 fixed mechanics, it
// COMPOSES a small set of PRIMITIVES (effects) under TRIGGERS. A few dozen parts -> thousands of
// behaviors. And it stays SAFE by construction: every `op` is a pre-wired function in EFFECTS —
// there is no eval, no codegen, so a composed graph can never crash or exploit a live match.
// Unknown ops / out-of-range params are skipped or clamped, never executed blindly.
//
// GRAPH SHAPE (pure data; validated + clamped before it reaches here):
//   {
//     name, flavor,
//     tags: ['fire'],                 // element tags -> the interaction matrix (fire+water=fizzle)
//     on: {                            // trigger -> ordered list of effects
//       fire:  [ {op:'projectile', speed, damage, ...} ],  // holder pressed attack
//       hit:   [ {op:'aoe', radius, damage}, {op:'status', kind:'burn'} ], // a projectile connected
//       land:  [ ... ],                // a thrown prop/projectile came to rest
//       timer: [ ... ],                // periodic (the trigger carries `every` seconds)
//       pickup:[ ... ],                // picked up
//     }
//   }
//
// ctx passed to run(): { world, prop, holder, aimDeg, x, y, facing, hitTarget }
//   - world   : the engine world (spawnProjectile, fighters, effects, settings)
//   - holder  : the Fighter wielding the item (for fire/heal/buff/recoil)
//   - hitTarget: the Fighter a projectile just struck (for hit-trigger status/knockback)
//   - x,y     : world point the effect originates from (holder muzzle, or contact point)
(function (global) {
  'use strict';
  const DS = global.DS;

  // ---- clamp helpers (the JS safety net; mirrors the server-side clamp the model is trained against) ----
  function num(v, lo, hi, d) { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; }
  function int(v, lo, hi, d) { return Math.round(num(v, lo, hi, d)); }
  function bool(v) { return v === true || v === 1 || v === 'true'; }

  // a clamped engine projectile cfg from an effect's params (+ optional modifiers)
  function projCfg(c) {
    return {
      speed: num(c.speed, 200, 1800, 1000), damage: num(c.damage, 0, 30, 8),
      kbBase: num(c.kbBase, 0, 80, 22), kbScale: num(c.kbScale, 0.02, 0.35, 0.09),
      angle: num(c.angle, -60, 60, 0), gravity: num(c.gravity, 0, 2400, 0),
      life: num(c.life, 0.3, 4, 1.3), r: num(c.r, 4, 34, 13),
      homing: bool(c.homing), pierce: bool(c.pierce),
    };
  }

  // ---- EFFECT REGISTRY: op -> (cfg, ctx) -> void. THIS is the wired primitive library. ----
  const EFFECTS = {
    projectile(c, ctx) {
      const w = ctx.world; if (!w || !w.spawnProjectile || !ctx.holder) return;
      w.spawnProjectile(ctx.holder, projCfg(c), ctx.aimDeg || 0);
    },
    spread(c, ctx) {                          // N projectiles fanned across an arc (shotgun / multishot)
      const w = ctx.world; if (!w || !w.spawnProjectile || !ctx.holder) return;
      const n = int(c.count, 2, 9, 3), arc = num(c.arc, 0, 90, 24), base = projCfg(c);
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        w.spawnProjectile(ctx.holder, base, (ctx.aimDeg || 0) + (t - 0.5) * arc);
      }
    },
    aoe(c, ctx) {                             // radial burst at ctx.x,y: hit nearby fighters
      const w = ctx.world; if (!w || !w.fighters) return;
      const R = num(c.radius, 20, 260, 80), dmg = num(c.damage, 0, 40, 12);
      for (const f of w.fighters) {
        if (f.dead || f.respawnT > 0 || f.invuln > 0 || f === ctx.holder) continue;
        const dx = f.x - ctx.x, dy = f.y - ctx.y;
        if (dx * dx + dy * dy <= R * R) {
          f._takeHit({ damage: dmg, kbBase: num(c.kbBase, 0, 80, 30), kbScale: num(c.kbScale, 0.02, 0.35, 0.12), angle: 40 },
            dx >= 0 ? 1 : -1, null, w);
        }
      }
      if (w.effects) w.effects.impact(ctx.x, ctx.y, 1.2);
    },
    heal(c, ctx) {
      const f = ctx.holder; if (!f) return;
      f.damage = Math.max(0, (f.damage || 0) - num(c.amount, 0, 80, 30));
      if (ctx.world && ctx.world.effects) ctx.world.effects.charge(f.x, f.y - 6, f.tagCol);
    },
    buff(c, ctx) {
      const f = ctx.holder; if (!f) return;
      if (c.effect === 'invuln') f.invuln = Math.max(f.invuln || 0, num(c.dur, 0, 12, 5));
      if (ctx.world && ctx.world.effects) ctx.world.effects.charge(f.x, f.y - 6, f.tagCol);
    },
    status(c, ctx) {                          // apply a damage-over-time / control status to the struck fighter
      const t = ctx.hitTarget; if (!t) return;
      const kind = (c.kind === 'freeze' || c.kind === 'shock') ? c.kind : 'burn';
      t._status = t._status || {};
      t._status[kind] = Math.max(t._status[kind] || 0, num(c.dur, 0.5, 8, 3));
    },
    knockback(c, ctx) {
      const t = ctx.hitTarget; if (!t) return;
      t._takeHit({ damage: 0, kbBase: num(c.force, 0, 90, 40), kbScale: 0.1, angle: num(c.angle, -30, 80, 30) },
        t.x >= ctx.x ? 1 : -1, null, ctx.world);
    },
    bounce(c, ctx) {                          // launch the contact target (or holder) upward — spring primitive
      const f = ctx.hitTarget || ctx.holder; if (!f) return;
      f.vy = -num(c.force, 600, 2400, 1300); f.onGround = false; f.ground = null;
    },
  };

  // ---- ELEMENT INTERACTION MATRIX: what happens when two tagged things meet (the fire+water magic). ----
  // Symmetric lookup keyed on an unordered pair. outcome = {a:'remove'|'keep', b:'remove'|'keep', fx, note}.
  // 'a' refers to the FIRST element of the queried pair, 'b' the second (react() normalizes orientation).
  const REACTIONS = {
    'fire|water':    { both: 'remove', fx: 'steam',  note: 'fizzle' },     // cancel each other
    'fire|ice':      { strong: 'fire', fx: 'melt',   note: 'fire melts ice' },
    'fire|plant':    { strong: 'fire', fx: 'ignite', note: 'plant catches fire' },
    'electric|water':{ both: 'keep',   fx: 'shock',  note: 'water conducts -> aoe shock' },
    'ice|electric':  { strong: 'electric', fx: 'shatter', note: 'shock shatters ice' },
    'water|plant':   { strong: 'plant', fx: 'grow',  note: 'water feeds plant' },
  };
  const ELEMENTS = ['fire', 'water', 'ice', 'electric', 'plant', 'rock'];

  // Resolve the reaction between two tag-sets. Returns null if no element pair reacts.
  // Result: { winner: <element>|null, loser: <element>|null, remove: [elements...], fx, note }.
  function react(tagsA, tagsB) {
    for (const ea of (tagsA || [])) {
      for (const eb of (tagsB || [])) {
        if (!ELEMENTS.includes(ea) || !ELEMENTS.includes(eb)) continue;
        const key = [ea, eb].sort().join('|');
        const r = REACTIONS[key];
        if (!r) continue;
        if (r.both === 'remove') return { winner: null, loser: null, remove: [ea, eb], fx: r.fx, note: r.note };
        if (r.both === 'keep') return { winner: null, loser: null, remove: [], fx: r.fx, note: r.note };
        // a 'strong' element survives, the other is consumed
        const winner = r.strong, loser = (winner === ea) ? eb : ea;
        return { winner: winner, loser: loser, remove: [loser], fx: r.fx, note: r.note };
      }
    }
    return null;
  }

  // ---- the interpreter: run one TRIGGER's effect list against the world. Safe: unknown ops are skipped. ----
  function run(graph, trigger, ctx) {
    if (!graph || !graph.on) return 0;
    const list = graph.on[trigger];
    if (!Array.isArray(list)) return 0;
    let ran = 0;
    for (const eff of list) {
      const fn = eff && EFFECTS[eff.op];
      if (!fn) continue;                       // unknown primitive -> skip (never throws into the loop)
      try { fn(eff, ctx); ran++; } catch (e) { /* one bad effect can't break the others */ }
    }
    return ran;
  }

  DS.Graph = {
    EFFECTS: EFFECTS, REACTIONS: REACTIONS, ELEMENTS: ELEMENTS,
    run: run, react: react, projCfg: projCfg,
    // a graph "is composable" sanity check used by the prop wiring (kind:'graph')
    isGraph: function (m) { return !!(m && m.on && typeof m.on === 'object'); },
  };
})(window);
