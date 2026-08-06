// Seeded PRNG. mulberry32 — 32-bit state, fast, good enough distribution for a game,
// and critically: identical output across every browser for a given seed. That's what
// makes the Daily Run genuinely shared.

/** @returns {() => number} function producing floats in [0, 1) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** xmur3 string hash — turns "2026-08-03" into a well-mixed 32-bit seed. */
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** Wraps a raw float source with the sampling helpers the game actually uses. */
export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }
  static fromString(str) { return new Rng(hashSeed(str)); }
  static random() { return new Rng((Math.random() * 0xffffffff) >>> 0); }

  // What's left is what the game actually draws: next(), float(), angle() and weighted().
  // int/bool/sign/pick/shuffle were never called — placement and wave code picks from
  // arrays with an explicit `Math.floor(rng.next() * arr.length)` so the number of draws
  // taken from a seeded stream is visible at the call site, which is what keeps the daily
  // reproducible.
  float(min = 0, max = 1) { return min + this.next() * (max - min); }
  angle() { return this.next() * Math.PI * 2; }

  /** Weighted pick. `weights[i]` corresponds to `arr[i]`. */
  weighted(arr, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

}

/** Local calendar date as YYYY-MM-DD. Deliberately local, not UTC: the "day" should
 *  match the player's own midnight, not a timezone they don't live in. */
export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dayOffsetKey(offset, from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
  return todayKey(d);
}

/** Whole days between two YYYY-MM-DD keys (b - a). */
export function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((db - da) / 86400000);
}
