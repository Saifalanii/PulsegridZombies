// Night phases. Each phase is ~55s of survival; the village cross-fades between them so
// a long night visibly gets worse.
//
// Judgment calls on colour, flagged:
//  - This is no longer a black void with emissive shapes on it, it's lit pixel art on a
//    ground plane. So the palette's job changed: `bg` and `bgGrid` used to *be* the
//    scene, and now they only tint the darkness overlay and the ambient fog. The village
//    tiles carry the colour; the palette carries the mood on top of them.
//  - `night` is the strength of the darkness overlay outside your lantern radius, and
//    `nightRgb` its colour. That is the single most expressive control here: DUSK is a
//    thin blue wash, THE LONG DARK is nearly opaque.
//  - Blood is locked to one dark red across every phase, and bile projectiles to one
//    sick green. Those two are the most important reads in the game, so they never
//    change meaning — the same principle the original applied to hazard projectiles.
//  - `colorblind: true` collapses the hue axis to blue/orange. Scale and movement still
//    carry the primary threat signal regardless, which is the point.

import { hslToRgb, lerpHue, lerp } from '../core/math.js';

export const TIERS = [
  { name: 'DUSK',          hue: 210, enemyHue: 96,  bgHue: 224, accentHue: 38,  night: 0.66, lightR: 270 },
  { name: 'NIGHTFALL',     hue: 218, enemyHue: 92,  bgHue: 230, accentHue: 34,  night: 0.78, lightR: 235 },
  { name: 'SMALL HOURS',   hue: 226, enemyHue: 88,  bgHue: 236, accentHue: 30,  night: 0.84, lightR: 220 },
  { name: 'BLOOD MOON',    hue: 356, enemyHue: 84,  bgHue: 348, accentHue: 22,  night: 0.84, lightR: 215 },
  { name: 'THE LONG DARK', hue: 246, enemyHue: 80,  bgHue: 250, accentHue: 28,  night: 0.88, lightR: 200 },
  { name: 'FALSE DAWN',    hue: 28,  enemyHue: 100, bgHue: 20,  accentHue: 44,  night: 0.70, lightR: 265 },
];

// Locked, phase-independent reads.
export const BLOOD_RGB  = [148, 22, 26];    // gore, damage numbers, death sprays
export const HAZARD_RGB = [126, 196, 62];   // bile — the one thing you must never eat
export const HEAL_RGB   = [126, 255, 168];  // medical supplies
export const SHARD_RGB  = [232, 196, 116];  // scrap
export const XP_RGB     = [150, 200, 255];  // salvage motes

const CB = { hue: 205, enemyHue: 32, bgHue: 214, accentHue: 34 };

export class Palette {
  constructor() {
    this.tierIndex = 0;
    this.blend = 1;           // 0..1 progress of the cross-fade into tierIndex
    this.colorblind = false;
    this._prev = TIERS[0];
    this._cur = TIERS[0];
    this.compute();
  }

  setColorblind(on) { this.colorblind = on; this.compute(); }

  /** Begin a cross-fade to `i`. */
  goToTier(i) {
    this._prev = this._cur;
    this.tierIndex = Math.min(i, TIERS.length - 1);
    this._cur = TIERS[this.tierIndex];
    this.blend = 0;
  }

  update(dt) {
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 2.6); // 2.6s cross-fade
      this.compute();
    }
  }

  compute() {
    const t = this.blend;
    const a = this._prev, b = this._cur;
    let hue = lerpHue(a.hue, b.hue, t);
    let enemyHue = lerpHue(a.enemyHue, b.enemyHue, t);
    let bgHue = lerpHue(a.bgHue, b.bgHue, t);
    let accentHue = lerpHue(a.accentHue, b.accentHue, t);

    if (this.colorblind) {
      hue = CB.hue; enemyHue = CB.enemyHue; bgHue = CB.bgHue; accentHue = CB.accentHue;
    }

    this.hue = hue;
    this.enemyHue = enemyHue;

    // How dark it is outside your light, and how far that light reaches. These drive
    // the renderer's darkness pass and are the strongest mood control in the game.
    this.night = lerp(a.night, b.night, t);
    this.lightR = lerp(a.lightR, b.lightR, t);

    this.primary = hslToRgb(hue, 62, 68);      // lantern light / UI
    this.primaryDim = hslToRgb(hue, 50, 34);
    this.accent = hslToRgb(accentHue, 88, 62); // firelight warmth
    this.enemy = BLOOD_RGB;
    this.enemyDim = hslToRgb(enemyHue, 40, 22);
    this.enemyBright = hslToRgb(enemyHue, 62, 52);
    // The colour the unlit parts of the village fall toward.
    this.bg = hslToRgb(bgHue, 46, 4);
    this.nightRgb = hslToRgb(bgHue, 58, 6);
    this.bgGrid = hslToRgb(bgHue, 40, 16);
    this.mote = hslToRgb(bgHue, 22, 62);       // drifting ash / fog

    this.css = {
      primary: rgbCss(this.primary),
      accent: rgbCss(this.accent),
      enemy: rgbCss(this.enemyBright),
      bg: rgbCss(this.bg),
    };
  }

  get tierName() { return this._cur.name; }
}

export const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/**
 * The lantern you carry. Cosmetic only — it colours your light, your footfall dust and
 * your sprint blur, and nothing else.
 */
export const TRAILS = {
  trail_cyan:   { name: 'Storm Lantern', rgb: [186, 214, 235] },
  trail_ember:  { name: 'Ember Lantern', rgb: [255, 150, 60] },
  trail_prism:  { name: 'Broken Prism',  rgb: [190, 130, 255], shift: true },
  trail_void:   { name: 'Cold Fire',     rgb: [225, 235, 255], dark: true },
  trail_toxic:  { name: 'Bile Lantern',  rgb: [160, 235, 90] },
  trail_rose:   { name: 'Signal Flare',  rgb: [255, 110, 150] },
};

/** Broken Prism cycles hue over time; everything else is static. */
export function trailColor(id, time) {
  const t = TRAILS[id] || TRAILS.trail_cyan;
  if (t.shift) return hslToRgb((time * 60) % 360, 95, 68);
  return t.rgb;
}

export { lerp };
