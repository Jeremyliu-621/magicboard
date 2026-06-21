// js/mechanics.js — DS.Mechanics: the bounded "what does a drawn thing DO" library.
//
// Two halves of the pipeline read this:
//   - the label -> ARCHETYPE map MIRRORS services/caellum/config.py CATEGORY_BEHAVIOR
//     (keep in sync); your teammates' pre-runtime "mode" / CHLOE picks the archetype.
//   - DEFAULTS gives a ready-to-play mechanic cfg per archetype so a drawn item is functional
//     the instant it drops in. CHLOE later REPLACES these with tuned params (same shape) — there
//     is no eval, just data.
//
// A ranged/throwable cfg IS the engine's projectile shape, so DS.Prop.fire() can call
// world.spawnProjectile(holder, cfg, aim) with zero translation.
(function (global) {
  'use strict';
  const DS = global.DS;

  // label -> archetype (mirror of config.CATEGORY_BEHAVIOR keys; general nouns)
  const ARCHETYPE = {
    sword: 'melee_weapon', knife: 'melee_weapon', bat: 'melee_weapon', hammer: 'melee_weapon', axe: 'melee_weapon',
    gun: 'ranged_weapon', bow: 'ranged_weapon', slingshot: 'ranged_weapon', pistol: 'ranged_weapon',
    bomb: 'throwable', ball: 'throwable', rock: 'throwable', bottle: 'throwable', dart: 'throwable',
    food: 'heal', fruit: 'heal', bread: 'heal', cake: 'heal',
    star: 'buff', heart: 'buff', gem: 'buff', crown: 'buff',
    spikes: 'hazard', saw: 'hazard', fire: 'hazard', trap: 'hazard',
    spring: 'bouncy', trampoline: 'bouncy',
    cloud: 'platform', block: 'platform', plank: 'platform',
    crate: 'prop', barrel: 'prop', balloon: 'prop', key: 'prop', coin: 'prop',
  };

  // ELEMENT weapons: a drawn element FIRES ITSELF as a tagged projectile — the drawing flies as the
  // shot — and CLASHES with other elements via DS.Graph.resolveContacts (fire+water fizzle, fire beats
  // plant and flies on, ...). Synonyms + the recognizer's element classes -> one of graph.js ELEMENTS.
  // (Checked BEFORE ARCHETYPE in defaultFor, so e.g. a drawn campfire is now a fire weapon, not a zone.)
  const ELEMENT_LABELS = {
    fire: 'fire', flame: 'fire', flames: 'fire', campfire: 'fire', ember: 'fire',
    water: 'water', waterdrop: 'water', droplet: 'water', splash: 'water', wave: 'water',
    ice: 'ice', snowflake: 'ice', frost: 'ice', snow: 'ice',
    electric: 'electric', lightning: 'electric', bolt: 'electric', spark: 'electric', thunder: 'electric',
    plant: 'plant', leaf: 'plant', vine: 'plant', tree: 'plant', flower: 'plant',
    poison: 'poison', toxic: 'poison', venom: 'poison', slime: 'poison',
    light: 'light', holy: 'light', glow: 'light',
    dark: 'dark', shadow: 'dark', skull: 'dark', void: 'dark',
    metal: 'metal', steel: 'metal', anvil: 'metal', iron: 'metal',
    rock: 'rock', stone: 'rock', boulder: 'rock',
    wind: 'wind', gust: 'wind', tornado: 'wind',
  };
  function elementOf(label) { return ELEMENT_LABELS[(label || '').toLowerCase()] || null; }

  // default mechanic cfg per archetype (demo-tuned, clamped; CHLOE overrides). ranged/throwable
  // cfgs use the engine projectile fields {speed,damage,kbBase,kbScale,angle,gravity,life,r,cooldown}.
  const DEFAULTS = {
    ranged_weapon: { kind: 'ranged', speed: 1150, damage: 7, kbBase: 22, kbScale: 0.09, angle: 0, gravity: 0, life: 1.3, r: 13, cooldown: 0.30 },
    throwable:     { kind: 'ranged', speed: 760, damage: 15, kbBase: 44, kbScale: 0.17, angle: 22, gravity: 1500, life: 2.2, r: 20, cooldown: 0.70 },
    melee_weapon:  { kind: 'melee', reach: 52, r: 34, damage: 12, kbBase: 30, kbScale: 0.13, angle: 10, cooldown: 0.30 }, // a real swing — arc hitbox in front of the holder (DS.Prop.fire)
    heal:          { kind: 'heal', amount: 30, cooldown: 0 },
    buff:          { kind: 'buff', effect: 'invuln', dur: 5, cooldown: 0 },
    hazard:        { kind: 'hazard', damage: 10, cooldown: 0 },     // (environment placement — Track B)
    bouncy:        { kind: 'bouncy', bounce: 1300 },                // (environment placement — Track B)
    platform:      { kind: 'platform' },                           // (environment placement — Track B)
    prop:          { kind: 'ranged', speed: 700, damage: 6, kbBase: 18, kbScale: 0.08, angle: 10, gravity: 1400, life: 1.6, r: 16, cooldown: 0.60 },
  };

  const Mechanics = {
    ARCHETYPE: ARCHETYPE,
    DEFAULTS: DEFAULTS,
    archetypeFor: function (label) { return ARCHETYPE[(label || '').toLowerCase()] || 'throwable'; },
    elementOf: elementOf,
    // a drawn element -> a weapon that fires ITSELF (its sprite, set by DS.Prop.fire) as an `el`-tagged
    // projectile. tags drive the clash reactions; useSprite tells the renderer to draw the drawing.
    elementWeapon: function (el) {
      return { kind: 'ranged', archetype: 'element', element: el, tags: [el], useSprite: true,
        speed: 720, damage: 7, kbBase: 16, kbScale: 0.07, angle: 0, gravity: 0, life: 1.6, r: 26, cooldown: 0.5 };
    },
    // a fresh cfg copy tagged with its archetype + label (so a Prop owns its own params).
    // element labels win first (fire/ice/plant/... -> a self-firing elemental weapon).
    defaultFor: function (label) {
      const el = elementOf(label);
      if (el) { const w = this.elementWeapon(el); w.label = label; return w; }
      const arch = this.archetypeFor(label);
      const cfg = Object.assign({}, DEFAULTS[arch] || DEFAULTS.throwable);
      cfg.archetype = arch; cfg.label = label;
      return cfg;
    },
  };

  DS.Mechanics = Mechanics;
})(window);
