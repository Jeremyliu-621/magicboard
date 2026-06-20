// js/prop.js — DS.Prop: a drawn item/object that drops into the live match.
//
// A prop is the home for an AI-enhanced drawing: it carries a SPRITE (the CAELLUM raster, set
// later by DS.AI) OR placeholder vector STROKES (shown instantly), an AABB hitbox, and a
// MECHANIC cfg (from DS.Mechanics / CHLOE). It falls, lands on platforms, is auto-picked-up on
// contact, and FIRES on the holder's attack button via world.spawnProjectile.
//
// Lives in WORLD space (same 1920-tall view as fighters); x,y is the prop's CENTRE.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  const GRAV = 2600;              // prop gravity (px/s^2)
  const MAXFALL = 2200;
  const HOLD_X = 30, HOLD_Y = 6;  // hand offset from the holder's centre

  function Prop(opts) {
    opts = opts || {};
    this.label = opts.label || 'thing';
    this.mechanic = opts.mechanic || (DS.Mechanics ? DS.Mechanics.defaultFor(this.label)
      : { kind: 'ranged', speed: 800, damage: 8, life: 1.2, r: 14, angle: 0, cooldown: 0.4 });
    this.archetype = this.mechanic.archetype || 'throwable';
    this.x = opts.x != null ? opts.x : 960;
    this.y = opts.y != null ? opts.y : 200;
    this.vx = opts.vx || 0; this.vy = opts.vy || 0;
    this.w = opts.w || 78; this.h = opts.h || 54;          // AABB hitbox (world px)
    this.spriteSize = opts.spriteSize || Math.max(this.w, this.h) * 1.35; // square draw box for the raster
    this.facing = opts.facing || 1;
    this.strokes = opts.strokes || null;                   // placeholder vector strokes (local coords)
    this.sprite = null;                                    // CAELLUM raster (Image), set by DS.AI later
    this.enhanced = false;
    this.held = null;                                      // the Fighter carrying it
    this.onGround = false;
    this.cooldown = 0;
    this.bornT = 0;
    this.dead = false;
    this._rnd = DS.makeRng(DS.hashSeed ? DS.hashSeed('prop' + this.label + (this.x | 0)) : (this.x | 0) + 7);
  }

  Prop.prototype.update = function (dt, world) {
    this.bornT += dt;
    if (this.cooldown > 0) this.cooldown -= dt;

    if (this.held) {
      const f = this.held;
      if (f.dead) { this.held = null; }                    // safety: also released in handlePickups
      else {
        this.facing = f.facing;
        this.x = f.x + f.facing * HOLD_X * (f.scale || 1);
        this.y = f.y - HOLD_Y;
        this.vx = this.vy = 0;
        return;
      }
    }

    // loose: gravity + simple platform landing
    this.vy = Math.min(MAXFALL, this.vy + GRAV * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= 0.985;

    this.onGround = false;
    const plats = (world.stage && world.stage.platforms) || world.platforms || [];
    const bottom = this.y + this.h / 2;
    for (const p of plats) {
      if ((this.x + this.w / 2) < p.x || (this.x - this.w / 2) > p.x + p.w) continue;
      if (this.vy >= 0 && bottom >= p.y && bottom <= p.y + Math.max(24, p.h * 0.6)) {
        this.y = p.y - this.h / 2; this.vy = 0; this.onGround = true; break;
      }
    }

    const floor = (world.view ? world.view.h : 1080) + 1600;
    if (this.y > floor) this.dead = true;                  // fell off the world
  };

  Prop.prototype.fire = function (world, aimDeg) {
    if (this.cooldown > 0 || !this.held) return;
    const f = this.held, m = this.mechanic;
    this.cooldown = m.cooldown || 0.3;
    if (m.kind === 'ranged') {
      if (world.spawnProjectile) world.spawnProjectile(f, m, aimDeg || 0);
      if (world.effects) world.effects.dust(f.x + f.facing * 40, f.y, f.facing);
    } else if (m.kind === 'heal') {
      f.damage = Math.max(0, (f.damage || 0) - (m.amount || 25));
      if (world.effects) world.effects.charge(f.x, f.y - 6, f.tagCol);
      this._consume(f);
    } else if (m.kind === 'buff') {
      if (m.effect === 'invuln') f.invuln = Math.max(f.invuln || 0, m.dur || 5);
      if (world.effects) world.effects.charge(f.x, f.y - 6, f.tagCol);
      this._consume(f);
    } else if (world.spawnProjectile) {
      // fallback: lob it like a throwable
      world.spawnProjectile(f, Object.assign({ speed: 700, damage: 8, life: 1.5, r: 16, angle: 12, gravity: 1400 }, m), aimDeg || 0);
    }
  };

  Prop.prototype._consume = function (f) {
    if (f && f.heldProp === this) f.heldProp = null;
    this.held = null; this.dead = true;
  };

  Prop.prototype.render = function (ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    if (!this.held && this.onGround) ctx.translate(0, Math.sin(this.bornT * 3) * 1.5); // idle bob
    const pop = this.bornT < 0.18 ? this.bornT / 0.18 : 1;                              // spawn pop
    if (pop < 1) ctx.scale(pop, pop);
    ctx.scale(this.facing, 1);

    if (this.sprite && this.sprite.complete && this.sprite.naturalWidth) {
      const s = this.spriteSize;
      ctx.drawImage(this.sprite, -s / 2, -s / 2, s, s);
    } else if (this.strokes && this.strokes.length) {
      for (const st of this.strokes) D.strokePts(ctx, st.pts, { width: st.w || 5, rnd: this._rnd, jitter: 0.5, passes: 1 });
    } else {
      D.strokePts(ctx, [[-this.w / 2, -this.h / 2], [this.w / 2, -this.h / 2], [this.w / 2, this.h / 2], [-this.w / 2, this.h / 2]], { width: 5, rnd: this._rnd, closed: true });
    }
    ctx.restore();
  };

  // auto-pickup on contact (keyboard AND phone — no new input field). Call from Game.update.
  Prop.handlePickups = function (game) {
    const props = game.props; if (!props || !props.length) return;
    for (const f of game.fighters) {
      if (f.dead) { if (f.heldProp) { f.heldProp.held = null; f.heldProp = null; } continue; }
      if (f.heldProp) continue;
      for (const p of props) {
        if (p.held || p.dead || p.bornT < 0.25) continue;
        if (Math.abs(f.x - p.x) < (f.w + p.w) / 2 && Math.abs(f.y - p.y) < (f.h + p.h) / 2) {
          f.heldProp = p; p.held = f; p.vx = 0; p.vy = 0;
          if (game.effects) game.effects.charge(f.x, f.y - 6, f.tagCol);
          break;
        }
      }
    }
  };

  DS.Prop = Prop;
})(window);
