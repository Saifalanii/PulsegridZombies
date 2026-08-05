// Generates a grey low-poly urban tileset as real PNG files, in code, with zero
// dependencies — same technique as tools/make-icons.mjs (flat shapes into an RGBA
// buffer, then a hand-rolled PNG writer; Node's zlib does the deflate).
//
//   node tools/make-street-tiles.mjs
//
// Output lands in assets/tiles/ alongside the original Craftpix village set, under new
// filenames — nothing here overwrites that pack. world.js's TILE_DEFS/PROP_DEFS point
// at whichever set is currently wired in.
//
// "Low-poly" here means what it means in code: flat colour fields with a bevel (a
// lighter top/left edge, a darker bottom/right edge) standing in for a lit facet, no
// gradients or painterly shading. Deterministic — same seed, same output, so re-running
// this after a palette tweak is safe to diff.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tiles');
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ PNG writer (see
// tools/make-icons.mjs for the identical, previously-reviewed implementation)

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function save(name, rgba, w, h) {
  writeFileSync(join(OUT, `${name} - NIGHT.png`), encodePng(rgba, w, h));
  console.log('wrote', `${name} - NIGHT.png`, `${w}x${h}`);
}

// ------------------------------------------------------------------ tiny seeded RNG
// (mulberry32 — deterministic, no dependency)

function rngFor(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ pixel buffer helpers

class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.px = new Uint8ClampedArray(w * h * 4);
  }
  set(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; this.px[i + 3] = a;
  }
  get(x, y) {
    const i = (y * this.w + x) * 4;
    return [this.px[i], this.px[i + 1], this.px[i + 2], this.px[i + 3]];
  }
  fillRect(x0, y0, w, h, rgb, a = 255) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, rgb[0], rgb[1], rgb[2], a);
  }
  /** Flat colour field with a 1px lighter bevel on top/left and darker on bottom/right — the whole "low-poly facet" look. */
  bevelRect(x0, y0, w, h, rgb, bevel = 26) {
    const lo = rgb.map((v) => Math.max(0, v - bevel));
    const hi = rgb.map((v) => Math.min(255, v + bevel));
    this.fillRect(x0, y0, w, h, rgb);
    for (let x = x0; x < x0 + w; x++) { this.set(x, y0, ...hi); this.set(x, y0 + h - 1, ...lo); }
    for (let y = y0; y < y0 + h; y++) { this.set(x0, y, ...hi); this.set(x0 + w - 1, y, ...lo); }
  }
  line(x0, y0, x1, y1, rgb, a = 255) {
    // Integer Bresenham — plenty for 1px architectural lines at this scale.
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
      this.set(x0, y0, rgb[0], rgb[1], rgb[2], a);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  speckle(rng, n, rgbLo, rgbHi, aRange = [40, 140]) {
    for (let i = 0; i < n; i++) {
      const x = Math.floor(rng() * this.w), y = Math.floor(rng() * this.h);
      const t = rng();
      const rgb = t < 0.5 ? rgbLo : rgbHi;
      this.set(x, y, rgb[0], rgb[1], rgb[2], Math.floor(aRange[0] + rng() * (aRange[1] - aRange[0])));
    }
  }
}

// ------------------------------------------------------------------ palette
//
// One family of greys, kept narrow on purpose — the brief was "everything is kinda
// greyish". Warmth is reserved entirely for lit windows, so they're the one thing that
// pulls the eye in an otherwise desaturated scene.

const ASPHALT = [58, 59, 63];
const ASPHALT_CRACK = [30, 31, 34];
const CONCRETE = [104, 106, 111];
const CONCRETE_JOINT = [76, 78, 83];
const PUDDLE = [40, 46, 58];
const PUDDLE_HI = [90, 108, 130];
const BUILDING_BASE = [70, 72, 78];
const BUILDING_TRIM = [48, 50, 55];
const WINDOW_LIT = [214, 150, 70];
const WINDOW_DARK = [34, 35, 39];
const CHAINLINK = [52, 54, 58];
const DRAIN_METAL = [66, 68, 73];

// ------------------------------------------------------------------ ground tiles (16x16)

function asphaltTile(seed) {
  const rng = rngFor(seed);
  const c = new Canvas(16, 16);
  c.fillRect(0, 0, 16, 16, ASPHALT);
  c.speckle(rng, 22, [0, 0, 0], [255, 255, 255], [18, 46]);
  return c;
}

function asphaltDetail(kind, seed) {
  const rng = rngFor(seed);
  const c = new Canvas(16, 16);
  // Fully opaque replacement tile (matches how GRASS/GROUND DETAIL work in world.js —
  // baked-in background, not an overlay), so start from a fresh base coat.
  c.fillRect(0, 0, 16, 16, ASPHALT);
  c.speckle(rng, 14, [0, 0, 0], [255, 255, 255], [14, 34]);
  if (kind === 'crack') {
    let x = 2 + Math.floor(rng() * 3), y = 0;
    while (y < 16) {
      c.line(x, y, x, y + 1, ASPHALT_CRACK);
      y += 1; x += rng() < 0.5 ? 0 : (rng() < 0.5 ? -1 : 1);
      x = Math.max(1, Math.min(14, x));
    }
  } else if (kind === 'stain') {
    const cx = 5 + Math.floor(rng() * 6), cy = 5 + Math.floor(rng() * 6);
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
      if (x * x + y * y <= 9 + rng() * 4) c.set(cx + x, cy + y, 20, 19, 18, 90 + Math.floor(rng() * 60));
    }
  } else if (kind === 'skid') {
    const y0 = 3 + Math.floor(rng() * 3);
    for (let x = 0; x < 16; x++) {
      if ((x + Math.floor(rng() * 2)) % 3 !== 0) { c.set(x, y0, 22, 22, 24, 130); c.set(x, y0 + 5, 22, 22, 24, 110); }
    }
  } else if (kind === 'grate') {
    c.bevelRect(3, 3, 10, 10, DRAIN_METAL, 18);
    for (let i = 4; i < 13; i += 2) c.line(4, i, 12, i, [30, 31, 33]);
  }
  return c;
}

function concreteTile() {
  const c = new Canvas(16, 16);
  c.fillRect(0, 0, 16, 16, CONCRETE);
  // Expansion joints: a sparse grid, the one texture real sidewalk slabs actually have.
  c.line(0, 0, 15, 0, CONCRETE_JOINT);
  c.line(0, 0, 0, 15, CONCRETE_JOINT);
  return c;
}

function concreteDetail(kind, seed) {
  const rng = rngFor(seed);
  const c = new Canvas(16, 16);
  c.fillRect(0, 0, 16, 16, CONCRETE);
  c.line(0, 0, 15, 0, CONCRETE_JOINT);
  c.line(0, 0, 0, 15, CONCRETE_JOINT);
  c.speckle(rng, 10, [60, 61, 65], [140, 141, 145], [20, 50]);
  if (kind === 'crack') {
    let x = 3 + Math.floor(rng() * 8), y = 2;
    while (y < 15) { c.set(x, y, 70, 71, 76, 200); y++; x += rng() < 0.6 ? 0 : (rng() < 0.5 ? -1 : 1); }
  } else if (kind === 'weed') {
    const bx = 4 + Math.floor(rng() * 8);
    c.set(bx, 13, 40, 90, 46, 220); c.set(bx - 1, 12, 46, 100, 52, 200); c.set(bx + 1, 12, 46, 100, 52, 200);
    c.set(bx, 11, 52, 110, 58, 180);
  }
  return c;
}

function puddleTile() {
  const c = new Canvas(16, 16);
  c.fillRect(0, 0, 16, 16, PUDDLE);
  for (let x = 0; x < 16; x++) c.set(x, 3, ...PUDDLE_HI, 60);
  return c;
}

function puddleDetail(kind, seed) {
  const rng = rngFor(seed);
  const c = new Canvas(16, 16);
  c.fillRect(0, 0, 16, 16, PUDDLE);
  if (kind === 'ripple') {
    const cx = 8, cy = 8;
    for (const r of [3, 6]) {
      for (let a = 0; a < 360; a += 8) {
        const x = Math.round(cx + Math.cos(a * Math.PI / 180) * r);
        const y = Math.round(cy + Math.sin(a * Math.PI / 180) * r * 0.5);
        if (rng() < 0.7) c.set(x, y, ...PUDDLE_HI, 70);
      }
    }
  } else if (kind === 'glint') {
    for (let i = 0; i < 6; i++) c.set(4 + Math.floor(rng() * 8), 4 + Math.floor(rng() * 8), 255, 255, 255, 60 + Math.floor(rng() * 60));
  }
  return c;
}

// ------------------------------------------------------------------ buildings (props)
//
// Flat rooftop, viewed from directly above — matching the perspective every other prop
// in the game already uses (see world.js's header note on why: characters are drawn at
// a fixed world height, and this is the proportion the rest of the tileset was drawn
// for). A grid of small darker roof units plus a handful of lit-orange skylights is
// what actually reads as "building" at this scale; anything busier turns to noise.

/**
 * Roof + wall face, the standard top-down-building trick: nothing here is actually
 * three-dimensional, but a flat rooftop sitting directly on a darker "wall" band along
 * the bottom edge — with a door and a row of windows on that band — is what every
 * top-down tile game uses to imply height without an isometric camera. Without it (the
 * first version) a building is just a painted rectangle: correct silhouette, zero sense
 * of standing up off the ground. `wallFrac` is how much of the bottom the wall band
 * claims; `PROP_DEFS.foot` in world.js is sized to match it, so the survivor is only
 * blocked by the wall and can be occluded by the roof above it, same as the Craftpix
 * houses this replaced.
 */
function building(w, h, seed, { vents = true, tower = false, stripe = false, wallFrac = 0.32 } = {}) {
  const rng = rngFor(seed);
  const c = new Canvas(w, h);
  const wallH = Math.round(h * wallFrac);
  const roofH = h - wallH;

  // Roof: the flat facet, seen from above.
  c.bevelRect(0, 0, w, roofH, BUILDING_BASE, 20);
  if (stripe) {
    for (let x = 2; x < w - 2; x++) if (((x >> 1) & 1) === 0) { c.set(x, 4, 210, 160, 40, 200); c.set(x, 5, 210, 160, 40, 200); }
  }
  if (vents) {
    const cols = Math.max(2, Math.floor(w / 18)), rows = Math.max(1, Math.floor((roofH - 10) / 16));
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        const vx = 6 + rx * Math.floor((w - 12) / Math.max(1, cols - 1 || 1));
        const vy = 6 + ry * Math.floor((roofH - 14) / Math.max(1, rows - 1 || 1));
        const lit = rng() < 0.4;
        c.bevelRect(Math.min(w - 8, vx), Math.min(roofH - 8, vy), 5, 5, lit ? WINDOW_LIT : WINDOW_DARK, 14);
      }
    }
  }
  if (tower) {
    const tw = Math.floor(w * 0.22), th = Math.floor(roofH * 0.5);
    const tx = Math.floor(w * 0.62), ty = Math.max(2, Math.floor(roofH * 0.1));
    c.bevelRect(tx, ty, tw, th, BUILDING_TRIM, 16);
    c.set(tx + Math.floor(tw / 2), ty - 1, ...WINDOW_LIT, 220);
  }

  // Parapet: a dark seam where the wall meets the roof — the edge the eye reads as
  // "this surface turns a corner here".
  for (let x = 0; x < w; x++) { c.set(x, roofH - 1, ...BUILDING_TRIM, 255); c.set(x, roofH, 20, 20, 22, 255); }

  // Wall face: darker than the roof (it's in its own shadow), a centred door, and a row
  // of windows either side of it — lit ones read as the building's real height cue since
  // they line up in a single band instead of a grid.
  const wallRgb = BUILDING_TRIM;
  c.fillRect(0, roofH + 1, w, wallH - 1, wallRgb);
  for (let x = 0; x < w; x++) { c.set(x, h - 1, 18, 18, 20, 255); }   // ground-contact shadow line

  const doorW = Math.max(8, Math.round(w * 0.12)), doorH = wallH - 4;
  const doorX = Math.floor(w / 2 - doorW / 2), doorY = h - doorH - 2;
  c.fillRect(doorX, doorY, doorW, doorH, [26, 26, 29]);
  c.fillRect(doorX, doorY, doorW, 2, [16, 16, 18]);

  const winY = roofH + Math.max(3, Math.floor(wallH * 0.28));
  const winH = Math.max(3, Math.floor(wallH * 0.42));
  const winW = 6;
  const gap = Math.max(10, Math.floor(w / 8));
  for (let x = 6; x < doorX - winW; x += gap) {
    c.bevelRect(x, winY, winW, winH, rng() < 0.55 ? WINDOW_LIT : WINDOW_DARK, 12);
  }
  for (let x = doorX + doorW + 4; x < w - 6 - winW; x += gap) {
    c.bevelRect(x, winY, winW, winH, rng() < 0.55 ? WINDOW_LIT : WINDOW_DARK, 12);
  }

  // Outer border last, over both bands, so the silhouette stays crisp.
  for (let x = 0; x < w; x++) { c.set(x, 0, ...BUILDING_TRIM, 255); }
  for (let y = 0; y < h; y++) { c.set(0, y, ...BUILDING_TRIM, 255); c.set(w - 1, y, ...BUILDING_TRIM, 255); }

  return c;
}

function chainlink(seed) {
  const rng = rngFor(seed);
  const c = new Canvas(16, 16);
  // Transparent field, diagonal cross-hatch — reads as mesh at 2x without needing an
  // actual weave; a fence is a silhouette prop, not something anyone stares at.
  for (let x = -16; x < 16; x += 4) {
    c.line(x, 0, x + 16, 16, CHAINLINK, 210);
    c.line(x, 16, x + 16, 0, CHAINLINK, 210);
  }
  for (let x = 0; x < 16; x++) { c.set(x, 0, ...CHAINLINK, 255); c.set(x, 15, ...CHAINLINK, 255); }
  if (rng() < 1) { /* seed reserved for future post/rust variation */ }
  return c;
}

function stormDrain() {
  const c = new Canvas(32, 48);
  // A collapsed section of asphalt around a metal grate — reuses PIT's footprint box
  // (see world.js PROP_DEFS.pit) so it drops straight into the existing placement pass.
  c.fillRect(0, 0, 32, 48, ASPHALT);
  c.bevelRect(4, 8, 24, 34, [24, 25, 27], 10);
  for (let y = 12; y < 38; y += 4) c.line(6, y, 26, y, DRAIN_METAL, 200);
  for (let x = 8; x < 26; x += 6) c.line(x, 10, x, 40, DRAIN_METAL, 160);
  return c;
}

// ------------------------------------------------------------------ emit

save('ASPHALT TILE', asphaltTile(1).px, 16, 16);
save('ASPHALT DETAIL 1', asphaltDetail('crack', 11).px, 16, 16);
save('ASPHALT DETAIL 2', asphaltDetail('stain', 12).px, 16, 16);
save('ASPHALT DETAIL 3', asphaltDetail('skid', 13).px, 16, 16);
save('ASPHALT DETAIL 4', asphaltDetail('grate', 14).px, 16, 16);

save('CONCRETE TILE', concreteTile().px, 16, 16);
save('CONCRETE DETAIL 1', concreteDetail('crack', 21).px, 16, 16);
save('CONCRETE DETAIL 2', concreteDetail('weed', 22).px, 16, 16);
save('CONCRETE DETAIL 3', concreteDetail('crack', 23).px, 16, 16);

save('PUDDLE TILE', puddleTile().px, 16, 16);
save('PUDDLE DETAIL 1', puddleDetail('ripple', 31).px, 16, 16);
save('PUDDLE DETAIL 2', puddleDetail('glint', 32).px, 16, 16);

save('TENEMENT A', building(80, 112, 41, { vents: true }).px, 80, 112);
save('TENEMENT B', building(128, 112, 42, { vents: true, tower: true }).px, 128, 112);
save('FACTORY', building(128, 112, 43, { vents: true, stripe: true }).px, 128, 112);

save('CHAINLINK A', chainlink(51).px, 16, 16);
save('CHAINLINK B', chainlink(52).px, 16, 16);

save('STORM DRAIN', stormDrain().px, 32, 48);

console.log('done.');
