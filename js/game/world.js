// The village.
//
// A deterministic night-time settlement: a tiled ground plane, ground decals, and solid
// props (houses, the church, trees, fences), all generated from the run seed so two
// players on the same Daily Run walk the same streets.
//
// Three things this module is careful about:
//
//   1. **Determinism without touching the gameplay streams.** Generation runs off its
//      own Rng derived from the seed (`seed ^ 0x27d4eb2d`). It never touches `rng`,
//      `rngUpgrade` or `rngAux`, so adding or changing world generation can't shift the
//      wave pattern or the upgrade offers of an existing daily.
//
//   2. **Collision is a bitmap, not a list.** Every solid thing — water, house
//      footprints, tree trunks, fence posts — is rasterised once at generation time into
//      a flat Uint8Array at tile resolution. Movement collision is then four array reads
//      per entity per axis, independent of how many props exist, and allocates nothing.
//      A per-prop AABB scan would have been ~60 rectangles x 120 enemies x 120Hz.
//
//   3. **Drawing is viewport-culled and depth-sorted.** Only tiles inside the camera
//      rect are blitted, and props hand back a y-sorted list so the run's draw pass can
//      interleave them with characters — a survivor standing above a house has to be
//      occluded by its roof, or the whole village reads as a flat painted backdrop.
//
// Scale: the tileset is 16px art with a much chunkier pixel density than the 64px LPC
// frames. Tiles are drawn at 2x (16 source px -> 32 world px) and characters at a 64px
// world height, which puts a character at two tiles tall and a house at seven — the
// proportion the tileset itself is drawn for. `imageSmoothingEnabled = false` throughout;
// bilinear filtering on 16px art turns it to mush at this magnification.

import { Rng } from '../core/rng.js';
import { clamp } from '../core/math.js';

export const TILE_SRC = 16;
export const TILE_SCALE = 2;
export const TS = TILE_SRC * TILE_SCALE;   // 32 world px per tile

/**
 * Tiles are blitted one world unit larger than their footprint.
 *
 * The world-to-screen scale is fractional (it's derived from the viewport's short edge),
 * so a 32-unit tile lands on something like 53.4 device pixels. Consecutive tiles
 * therefore round to destination rects that sometimes leave a sub-pixel gap, and against
 * a dark backdrop that gap reads as a lit grid drawn over the ground — which is exactly
 * the neon grid this rewrite was supposed to delete. Overlapping each blit by one world
 * unit closes the seam. The cost is half a source pixel of stretch on the trailing edge,
 * invisible at this magnification with smoothing off.
 */
const BLEED = 1;

const DIR = 'assets/tiles/';
const N = ' - NIGHT.png';

// ------------------------------------------------------------------ atlas
//
// Loaded once per page and shared by every Run (including the menu's ambient one).
// `under` names a tile that must be blitted first: the water detail tiles have an alpha
// channel and are meant to overlay the flat water fill, unlike the grass/ground details
// which are fully opaque replacements.

// Asphalt/concrete/puddle in place of grass/dirt/water — a procedurally generated street
// set (tools/make-street-tiles.mjs) instead of the Craftpix village pack. Same three-
// terrain-type structure the generator below already understands (open ground / path /
// hazard-to-route-around), just reskinned: nothing in the placement logic changed, only
// which files each index points at and how many detail variants exist per type.
const TILE_DEFS = [
  { file: 'ASPHALT TILE' },                                 // 0
  { file: 'ASPHALT DETAIL 1' }, { file: 'ASPHALT DETAIL 2' },
  { file: 'ASPHALT DETAIL 3' }, { file: 'ASPHALT DETAIL 4' }, // 1-4
  { file: 'CONCRETE TILE' },                                // 5
  { file: 'CONCRETE DETAIL 1' }, { file: 'CONCRETE DETAIL 2' },
  { file: 'CONCRETE DETAIL 3' },                            // 6-8
  { file: 'PUDDLE TILE' },                                  // 9
  { file: 'PUDDLE DETAIL 1', under: 9 }, { file: 'PUDDLE DETAIL 2', under: 9 }, // 10-11
];

const T_GRASS = 0, T_GRASS_D0 = 1, T_GRASS_DN = 4;
const T_DIRT = 5, T_DIRT_D0 = 6, T_DIRT_DN = 8;
const T_WATER = 9, T_WATER_D0 = 10, T_WATER_DN = 11;

/**
 * Ground decals — deliberately empty.
 *
 * This used to blit `TERRAIN SET 1-5` whole, as "opaque patches with the grass baked
 * in". They are not decoration: each one is a 3x3 *autotile block* — nine sub-tiles
 * (four corners, four edges, one centre) that a tilemap slices apart and reassembles to
 * blend one surface into another. Drawn whole, each dropped a hard-edged rectangle on
 * the grass with the block's own internal border art inside it, seventy times per map.
 * That is the rectangular patchwork that reads as the ground flickering as you scroll.
 *
 * Blending terrain properly means slicing these into a 9-patch and picking the sub-tile
 * from the neighbour mask. Until that exists, the 16px ASPHALT/CONCRETE DETAIL tiles
 * already scatter through the tile map itself and carry the decoration on their own.
 */
const DECAL_DEFS = [];

// ------------------------------------------------------------------ city sheet
//
// One atlas — `assets/city/simple-city-32.png`, the SIMPLE CITY 32x32 pack — carries the
// buildings, vehicles, trees and street furniture. Two things about it are load-bearing:
//
//   **Scale.** Its cells are 32 source px where the tileset's are 16, and it is drawn at
//   the same TILE_SCALE as everything else. That is not a coincidence to be tidied away:
//   16px art at 2x and 32px art at 2x land on the *same* number of world pixels per
//   source pixel, so the two sets have identical apparent pixel density and read as one
//   set of art. Drawing this sheet at 1x to "correct" for its larger cells would make it
//   twice as fine-grained as the ground it stands on, and that reads as a sticker.
//
//   **It is daylight art.** Every other asset in the game is a pre-darkened `- NIGHT`
//   export; this pack is not, and dropped in raw its buildings sit at ~105 mean luminance
//   against 61 for the asphalt they stand on — they glow. `nightTint` below darkens and
//   cools the whole sheet once at load rather than per draw, so the cost is one pass over
//   412k pixels at startup and nothing at all per frame.
const CITY_SRC = 'assets/city/simple-city-32.png';

// Multipliers per channel. Blue is attenuated least, so the sheet loses more of its warm
// daylight than its cool tones and settles at roughly the luminance of the existing night
// tiles instead of merely getting darker.
const NIGHT_TINT = [0.58, 0.62, 0.74];

/**
 * Sprite rectangles within the city sheet, in source pixels: [sx, sy, sw, sh].
 *
 * Measured, not eyeballed — connected-component analysis of the sheet's alpha channel for
 * the free-standing sprites, and dark-outline column detection for the building row,
 * whose facades touch each other with no transparent gutter to separate them.
 */
const CITY = {
  // Buildings. The tall pair share a silhouette; the brown one is wider because it
  // carries a lower annex on its right, which the outline scan shows is part of the same
  // structure rather than a separate 32px building.
  apt_grey:    [480,  96,  96, 159],
  apt_purple:  [576,  96,  96, 159],
  apt_brown:   [672, 128, 128, 127],
  shop_red:    [480, 256,  96,  95],
  shop_white:  [576, 256,  96,  95],
  shop_blue:   [672, 256,  96,  95],

  // Vehicles: twelve facing along the sheet's vertical axis, six along its horizontal.
  // Which one gets placed depends on the road it's abandoned on — see _placeCars.
  car_v0: [258, 110, 28, 37], car_v1: [290, 110, 28, 37],
  car_v2: [322, 110, 28, 37], car_v3: [354, 110, 28, 37],
  car_v4: [258, 206, 28, 37], car_v5: [290, 206, 28, 37],
  car_v6: [322, 206, 28, 37], car_v7: [354, 206, 28, 37],
  car_v8: [258, 302, 28, 37], car_v9: [290, 302, 28, 37],
  car_v10:[322, 302, 28, 37], car_v11:[354, 302, 28, 37],
  car_h0: [267, 161, 43, 30], car_h1: [331, 160, 43, 31],
  car_h2: [267, 257, 43, 30], car_h3: [331, 256, 43, 31],
  car_h4: [267, 353, 43, 30], car_h5: [331, 353, 43, 30],

  // Greenery and street furniture.
  tree_leafy: [ 13, 112, 38, 41],
  tree_pine:  [ 78, 105, 36, 50],
  bush_a:     [193, 162, 30, 29],
  bush_b:     [225,  98, 30, 29],
  hedge:      [131,  98, 90, 29],
  pole:       [384, 134, 32, 89],
  light:      [388, 233, 56, 46],
  sign_a:     [390,  96, 20, 32],
  sign_b:     [416,  96, 16, 32],
  bench:      [128, 293, 23, 25],
  bin:        [  1, 293, 14, 24],
  crate:      [419, 294, 26, 23],
};

const CAR_V = ['car_v0','car_v1','car_v2','car_v3','car_v4','car_v5',
               'car_v6','car_v7','car_v8','car_v9','car_v10','car_v11'];
const CAR_H = ['car_h0','car_h1','car_h2','car_h3','car_h4','car_h5'];

/**
 * Props. `foot` is the solid footprint as a fraction of the sprite box
 * [left, top, right, bottom] — a building is only solid across its lower storey, so you
 * can walk behind the roof, and a tree is only solid at its trunk.
 *
 * `city` names a rect in the sheet above; those entries take their `w`/`h` from that rect
 * rather than carrying their own, and they have no `file`.
 */
const PROP_DEFS = {
  // Buildings, from the city sheet. These replaced the procedurally generated TENEMENT/
  // FACTORY blocks outright rather than sitting alongside them: the generated ones were
  // flat colour fields with a bevel, these are drawn facades with windows, doors, awnings
  // and roof clutter, and a street holding both reads as a bug rather than as variety.
  // tools/make-street-tiles.mjs still *emits* the old buildings — it is the source of the
  // ground tiles, which are still in use — they are simply no longer wired up here.
  //
  // The footprint is the lower ~45% in each case. These facades are drawn front-on with
  // the roof foreshortened above, so the solid band has to stop where the wall meets the
  // roofline or a survivor walking behind the building collides with its gutter.
  apt_grey:   { city: 'apt_grey',   foot: [0.04, 0.58, 0.96, 0.99] },
  apt_purple: { city: 'apt_purple', foot: [0.04, 0.58, 0.96, 0.99] },
  apt_brown:  { city: 'apt_brown',  foot: [0.04, 0.55, 0.96, 0.99] },
  shop_red:   { city: 'shop_red',   foot: [0.04, 0.45, 0.96, 0.99] },
  shop_white: { city: 'shop_white', foot: [0.04, 0.45, 0.96, 0.99] },
  shop_blue:  { city: 'shop_blue',  foot: [0.04, 0.45, 0.96, 0.99] },

  // Wrecks. Solid across nearly their whole box on purpose: a car in the road is a
  // barricade you have to go around, which is the only reason it earns a collider at all.
  ...Object.fromEntries([...CAR_V, ...CAR_H].map(
    (k) => [k, { city: k, foot: [0.08, 0.16, 0.92, 0.96] }])),

  tree_leafy: { city: 'tree_leafy', foot: [0.34, 0.68, 0.66, 0.97] },
  tree_pine:  { city: 'tree_pine',  foot: [0.34, 0.72, 0.66, 0.97] },
  bush_a:     { city: 'bush_a',     foot: [0.15, 0.45, 0.85, 0.95] },
  bush_b:     { city: 'bush_b',     foot: [0.15, 0.45, 0.85, 0.95] },
  hedge:      { city: 'hedge',      foot: [0.02, 0.35, 0.98, 0.97] },
  // Street furniture. A pole and a traffic light are thin things standing on a small
  // base — the footprint is the base only, not the mast, or the survivor snags on
  // something they can visibly walk past.
  pole:       { city: 'pole',   foot: [0.36, 0.86, 0.64, 1.0] },
  light:      { city: 'light',  foot: [0.30, 0.78, 0.70, 1.0] },
  sign_a:     { city: 'sign_a', foot: [0.34, 0.86, 0.66, 1.0] },
  sign_b:     { city: 'sign_b', foot: [0.34, 0.86, 0.66, 1.0] },
  bench:      { city: 'bench',  foot: [0.06, 0.45, 0.94, 0.98] },
  bin:        { city: 'bin',    foot: [0.10, 0.35, 0.90, 0.98] },
  crate:      { city: 'crate',  foot: [0.08, 0.30, 0.92, 0.98] },

  // Unplaced, kept wired: see the note in _generate on why the fence and grave passes
  // were cut. Both still resolve, so restoring a placement pass needs no work here.
  fence1: { file: 'CHAINLINK A', w: 16, h: 16, foot: [0, 0.25, 1, 1] },
  fence2: { file: 'CHAINLINK B', w: 16, h: 16, foot: [0, 0.25, 1, 1] },
  pit:    { file: 'STORM DRAIN', w: 32, h: 48, foot: [0.05, 0.35, 0.95, 0.95] },
};

function loadImage(file) {
  const img = new Image();
  img.onerror = () => console.warn('[world] failed to load', file);
  img.src = DIR + file + N;
  return img;
}

/**
 * The city sheet, darkened to night.
 *
 * Returns a canvas immediately and fills it in when the PNG decodes — every draw path
 * already guards on `img.complete`, and a canvas is a legal drawImage source whether or
 * not anything has been painted into it yet, so nothing has to learn about loading state.
 *
 * The tint is a straight per-channel multiply over the decoded pixels. Doing it with
 * canvas blend modes instead would need a second pass to restore the alpha mask (a
 * `multiply` fill paints the transparent margin too), and doing it per-draw with
 * ctx.filter would put a filter change in front of every prop blit in the frame.
 */
function loadCitySheet() {
  const canvas = document.createElement('canvas');
  canvas.width = 992; canvas.height = 416;
  const img = new Image();
  img.onerror = () => console.warn('[world] failed to load', CITY_SRC);
  img.onload = () => {
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = px.data;
    const [tr, tg, tb] = NIGHT_TINT;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      d[i] = d[i] * tr; d[i + 1] = d[i + 1] * tg; d[i + 2] = d[i + 2] * tb;
    }
    ctx.putImageData(px, 0, 0);
    canvas.complete = true;
  };
  img.src = CITY_SRC;
  // Matches the `img.complete` guard the tile/prop draw paths already use.
  canvas.complete = false;
  return canvas;
}

/** Lazily built once, shared process-wide. */
let ATLAS = null;
function atlas() {
  if (ATLAS) return ATLAS;
  ATLAS = { tiles: [], decals: [], props: {}, city: loadCitySheet() };
  for (const d of TILE_DEFS) ATLAS.tiles.push({ img: loadImage(d.file), under: d.under ?? -1 });
  for (const d of DECAL_DEFS) ATLAS.decals.push({ img: loadImage(d.file), w: d.w, h: d.h });
  for (const k in PROP_DEFS) {
    const d = PROP_DEFS[k];
    if (d.city) {
      const [sx, sy, sw, sh] = CITY[d.city];
      ATLAS.props[k] = { img: ATLAS.city, crop: [sx, sy, sw, sh], w: sw, h: sh, foot: d.foot };
    } else {
      ATLAS.props[k] = { img: loadImage(d.file), crop: null, w: d.w, h: d.h, foot: d.foot };
    }
  }
  return ATLAS;
}

/** Every image file this module can request, for the service worker shell list. */
export function shellAssets() {
  const out = [];
  for (const d of TILE_DEFS) out.push(`./${DIR}${d.file}${N}`);
  for (const d of DECAL_DEFS) out.push(`./${DIR}${d.file}${N}`);
  for (const k in PROP_DEFS) {
    const d = PROP_DEFS[k];
    if (!d.city) out.push(`./${DIR}${d.file}${N}`);
  }
  out.push(`./${CITY_SRC}`);
  return out;
}

// ------------------------------------------------------------------ World

export class World {
  /**
   * @param {{x:number,y:number,w:number,h:number}} arena world-space bounds
   * @param {number} seed
   */
  constructor(arena, seed) {
    this.atlas = atlas();
    this.arena = arena;
    this.ox = arena.x;
    this.oy = arena.y;
    this.cols = Math.ceil(arena.w / TS);
    this.rows = Math.ceil(arena.h / TS);

    this.map = new Uint8Array(this.cols * this.rows);
    this.solid = new Uint8Array(this.cols * this.rows);
    // Marks tiles that generation has claimed (roads, buildings, yards) so later passes
    // don't drop a tree in the middle of the square.
    this.claim = new Uint8Array(this.cols * this.rows);

    this.decals = [];   // { idx, x, y }
    this.props = [];    // { def, x, y, baseY }

    const rng = new Rng(seed ^ 0x27d4eb2d);
    this._generate(rng);
    // Ascending base-Y once, at build time: the draw pass then only has to merge, not
    // sort, and props never move.
    this.props.sort((a, b) => a.baseY - b.baseY);

    // Preallocated merge scratch for the draw pass.
    this._visProps = new Int32Array(256);
    this._visCount = 0;
  }

  // ------------------------------------------------------------ generation

  _generate(rng) {
    const { cols, rows, map } = this;
    map.fill(T_GRASS);

    const cx = cols >> 1, cy = rows >> 1;

    // --- the square: a beaten-earth clearing at the heart of the village ---
    // Kept small on purpose. An earlier pass made it 26 tiles across and it filled the
    // entire viewport with flat dirt — you could not tell you were in a village at all,
    // because nothing but ground was ever on screen.
    const sqw = 5 + Math.floor(rng.next() * 3);
    const sqh = 4 + Math.floor(rng.next() * 3);
    this._rect(cx - sqw, cy - sqh, sqw * 2, sqh * 2, T_DIRT, true);

    // --- roads: one N-S, one E-W, each with a slow wobble so nothing is a ruler line ---
    const roadW = 2;
    const phaseA = rng.angle(), phaseB = rng.angle();
    for (let y = 0; y < rows; y++) {
      const x = cx + Math.round(Math.sin(y * 0.06 + phaseA) * 3.5);
      this._rect(x - roadW, y, roadW * 2 + 1, 1, T_DIRT, true);
    }
    for (let x = 0; x < cols; x++) {
      const y = cy + Math.round(Math.sin(x * 0.055 + phaseB) * 3.0);
      this._rect(x, y - roadW, 1, roadW * 2 + 1, T_DIRT, true);
    }

    // --- a pond, well off the square ---
    const pondQuad = Math.floor(rng.next() * 4);
    const px = pondQuad & 1 ? cols * 0.76 : cols * 0.22;
    const py = pondQuad & 2 ? rows * 0.76 : rows * 0.24;
    const prx = 4 + rng.next() * 3, pry = 3 + rng.next() * 2.5;
    for (let y = Math.floor(py - pry - 1); y <= py + pry + 1; y++) {
      for (let x = Math.floor(px - prx - 1); x <= px + prx + 1; x++) {
        if (!this._in(x, y)) continue;
        const dx = (x - px) / prx, dy = (y - py) / pry;
        const d = dx * dx + dy * dy;
        // Ragged edge, cosmetic-only noise but drawn from the seeded stream so the
        // pond's shape is part of the shared daily.
        if (d < 1 + (rng.next() - 0.5) * 0.28) {
          const i = y * cols + x;
          map[i] = T_WATER;
          this.solid[i] = 1;
          this.claim[i] = 1;
        }
      }
    }

    // --- buildings ---
    // The big brown block anchors the square; the rest line the two roads. Placement is
    // rejection sampled against the claim map so nothing overlaps a road or another
    // building.
    // The block that anchors the square.
    //
    // This is tried at several offsets rather than dropped at one fixed spot, because the
    // one fixed spot never worked. The old `('church', cx - 2, cy - sqh - 4)` call sat
    // directly on top of the N-S road: that road claims a band about cx-5..cx+5 across
    // every row, and a building 8 tiles wide starting at cx-2 spans cx-2..cx+5, so
    // `_isFree` rejected it on every seed and the square has been quietly unanchored the
    // whole time. _placeProp returns false rather than throwing, which is exactly why it
    // went unnoticed. The offsets below clear the road band on one side or the other.
    const anchorSpots = [
      [cx - 15, cy - sqh - 9], [cx + 7, cy - sqh - 9],
      [cx - 15, cy + sqh + 2], [cx + 7, cy + sqh + 2],
    ];
    for (const [ax, ay] of anchorSpots) {
      if (this._placeProp('apt_brown', ax, ay, rng, true)) break;
    }

    // Shops are shorter than the apartment blocks and read as street level, so they're
    // drawn from more often — a street of nothing but six-storey towers looks like a
    // canyon, and the point of the square is that you can see across it.
    const BUILDINGS = ['shop_red', 'shop_white', 'shop_blue',
                       'shop_red', 'shop_white', 'shop_blue',
                       'apt_grey', 'apt_purple'];
    const houseTries = 260;
    let housed = 0;
    for (let i = 0; i < houseTries && housed < 24; i++) {
      const kind = BUILDINGS[Math.floor(rng.next() * BUILDINGS.length)];
      const tx = 2 + Math.floor(rng.next() * (cols - 10));
      const ty = 2 + Math.floor(rng.next() * (rows - 10));
      // Want a building *near* a road but not on it — that's what makes it read as a
      // street rather than scattered cabins in a field.
      if (!this._nearClaimed(tx, ty, 5, 4)) continue;
      if (this._placeProp(kind, tx, ty, rng, true)) housed++;
    }

    // --- abandoned traffic ---
    //
    // Cars go *on* the roads, which no other pass does — every other prop is rejected
    // from claimed ground precisely to keep the roads clear. That's the whole point of
    // them: the streets stop being empty corridors and start being something you have to
    // pick your way through, and a wreck is cover you can put between yourself and a
    // Lurker. Orientation is chosen from the road the car lands on, so nothing is parked
    // broadside across a lane it couldn't have driven down.
    let cars = 0;
    for (let i = 0; i < 420 && cars < 26; i++) {
      const tx = 2 + Math.floor(rng.next() * (cols - 6));
      const ty = 2 + Math.floor(rng.next() * (rows - 6));
      // The square is the same T_DIRT surface as the roads, so without this a wreck can
      // park in the middle of it — including on the tile the survivor spawns on. The
      // spawn would survive it (Run nudges to `nearestOpen`), but opening the night
      // wedged against a car door is not the intended first impression.
      if (Math.abs(tx - cx) <= sqw + 3 && Math.abs(ty - cy) <= sqh + 3) continue;
      // Which way does the road run here? Sample the road surface either side: a N-S
      // road is narrow across x and continuous along y.
      const horiz = this._roadRuns(tx, ty, 1, 0), vert = this._roadRuns(tx, ty, 0, 1);
      if (!horiz && !vert) continue;
      const alongY = vert && (!horiz || rng.next() < 0.5);
      const pool = alongY ? CAR_V : CAR_H;
      const kind = pool[Math.floor(rng.next() * pool.length)];
      if (this._placeProp(kind, tx, ty, rng, false, true)) cars++;
    }

    // --- street furniture ---
    //
    // Placed off the road but hard against it, so the kerb line reads. These are the
    // cheapest thing on the map that says "town" rather than "clearing with sheds in it".
    const STREET = ['pole', 'light', 'sign_a', 'sign_b', 'bench', 'bin', 'crate',
                    'bush_a', 'bush_b', 'hedge'];
    let street = 0;
    for (let i = 0; i < 500 && street < 40; i++) {
      const kind = STREET[Math.floor(rng.next() * STREET.length)];
      const tx = 2 + Math.floor(rng.next() * (cols - 6));
      const ty = 2 + Math.floor(rng.next() * (rows - 6));
      if (Math.abs(tx - cx) <= sqw + 1 && Math.abs(ty - cy) <= sqh + 1) continue;
      if (!this._nearClaimed(tx, ty, 1, 2)) continue;
      if (this._placeProp(kind, tx, ty, rng, false)) street++;
    }

    // Fences and open graves are cut on purpose — they read as clutter at this scale and
    // both are solid, so every one was also a collider the player could snag on. The
    // placement passes are gone rather than commented out; PROP_DEFS still carries the
    // definitions if either is ever wanted back.

    // --- treeline: dense at the arena edge, thinning toward the village ---
    const trees = ['tree_leafy', 'tree_pine', 'tree_leafy'];
    for (let i = 0; i < 900; i++) {
      const tx = Math.floor(rng.next() * cols);
      const ty = Math.floor(rng.next() * rows);
      // Distance from centre, normalised: 0 at the square, 1 at a corner. Squaring it
      // gives a treeline that is dense at the arena edge and thins toward the village
      // without a hard boundary anywhere — the wood encroaches, it doesn't stop.
      const edge = Math.max(Math.abs(tx - cx) / cx, Math.abs(ty - cy) / cy);
      if (rng.next() > edge * edge * 1.05 + 0.10) continue;
      this._placeProp(trees[Math.floor(rng.next() * 3)], tx, ty, rng, false);
    }

    // --- ground decals on open grass ---
    // Skipped while DECAL_DEFS is empty (see the note there — the terrain sets are
    // autotile blocks, not patches). Guarded rather than deleted so restoring a real
    // 9-patch implementation only needs the defs filled back in.
    for (let i = 0; this.atlas.decals.length && i < 70; i++) {
      const di = Math.floor(rng.next() * this.atlas.decals.length);
      const d = this.atlas.decals[di];
      const tw = Math.ceil(d.w / TILE_SRC), th = Math.ceil(d.h / TILE_SRC);
      const tx = Math.floor(rng.next() * (cols - tw));
      const ty = Math.floor(rng.next() * (rows - th));
      if (!this._areaIs(tx, ty, tw, th, T_GRASS)) continue;
      this._claimRect(tx, ty, tw, th);
      this.decals.push({ idx: di, x: this.ox + tx * TS, y: this.oy + ty * TS });
    }

    // --- detail scatter, last, so it decorates whatever survived ---
    for (let i = 0; i < cols * rows; i++) {
      if (this.solid[i]) continue;
      const r = rng.next();
      if (map[i] === T_GRASS && r < 0.10) {
        map[i] = T_GRASS_D0 + Math.floor(rng.next() * (T_GRASS_DN - T_GRASS_D0 + 1));
      } else if (map[i] === T_DIRT && r < 0.09) {
        map[i] = T_DIRT_D0 + Math.floor(rng.next() * (T_DIRT_DN - T_DIRT_D0 + 1));
      }
    }
    for (let i = 0; i < cols * rows; i++) {
      if (map[i] === T_WATER && rng.next() < 0.16) {
        map[i] = T_WATER_D0 + Math.floor(rng.next() * (T_WATER_DN - T_WATER_D0 + 1));
      }
    }

    // The arena border itself is solid, so nothing can be pushed through the wall by
    // the separation forces.
    for (let x = 0; x < cols; x++) { this.solid[x] = 1; this.solid[(rows - 1) * cols + x] = 1; }
    for (let y = 0; y < rows; y++) { this.solid[y * cols] = 1; this.solid[y * cols + cols - 1] = 1; }
  }

  /**
   * Does road surface continue for a few tiles in direction (dx, dy) from here?
   *
   * Used to orient a wreck along the lane it's abandoned in. Deliberately not symmetric
   * about the sample point: a car near a junction can satisfy both axes, and the caller
   * picks between them on the seeded stream.
   */
  _roadRuns(tx, ty, dx, dy) {
    for (let k = -2; k <= 2; k++) {
      const x = tx + dx * k, y = ty + dy * k;
      if (!this._in(x, y)) return false;
      const t = this.map[y * this.cols + x];
      if (t !== T_DIRT && (t < T_DIRT_D0 || t > T_DIRT_DN)) return false;
    }
    return true;
  }

  _in(x, y) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }

  _rect(x0, y0, w, h, tile, claim) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!this._in(x, y)) continue;
        const i = y * this.cols + x;
        this.map[i] = tile;
        if (claim) this.claim[i] = 1;
      }
    }
  }

  _claimRect(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (this._in(x, y)) this.claim[y * this.cols + x] = 1;
      }
    }
  }

  _areaIs(x0, y0, w, h, tile) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!this._in(x, y)) return false;
        const i = y * this.cols + x;
        if (this.claim[i] || this.solid[i] || this.map[i] !== tile) return false;
      }
    }
    return true;
  }

  /** Solid-only test: ignores `claim`, so a road counts as placeable ground. */
  _isClear(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!this._in(x, y)) return false;
        if (this.solid[y * this.cols + x]) return false;
      }
    }
    return true;
  }

  /** Every tile under the box is road/square surface (T_DIRT and its detail variants). */
  _areaIsRoad(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!this._in(x, y)) return false;
        const t = this.map[y * this.cols + x];
        if (t !== T_DIRT && (t < T_DIRT_D0 || t > T_DIRT_DN)) return false;
      }
    }
    return true;
  }

  _isFree(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!this._in(x, y)) return false;
        const i = y * this.cols + x;
        if (this.claim[i] || this.solid[i]) return false;
      }
    }
    return true;
  }

  _nearClaimed(x0, y0, w, radius) {
    for (let y = y0 - radius; y <= y0 + radius + 2; y++) {
      for (let x = x0 - radius; x <= x0 + radius + w; x++) {
        if (this._in(x, y) && this.claim[y * this.cols + x]) return true;
      }
    }
    return false;
  }

  /**
   * Place a prop with its top-left at tile (tx, ty), if the space is free.
   * @param {boolean} strict also claim a 1-tile margin, so buildings get breathing room
   */
  _placeProp(key, tx, ty, rng, strict, onRoad = false) {
    const def = this.atlas.props[key];
    // Footprint in tiles, computed from the prop's *world* size rather than from its
    // source pixels. Identical to the old `w / TILE_SRC` for the 16px tileset art, and
    // correct for the 32px city sheet, which the old form counted as double-width.
    const tw = Math.ceil((def.w * TILE_SCALE) / TS), th = Math.ceil((def.h * TILE_SCALE) / TS);
    const pad = strict ? 1 : 0;
    // Roadside props are placed *onto* claimed ground — that is the whole point of them —
    // so they test solidity only, plus a check that they're actually on road surface.
    const free = onRoad
      ? this._isClear(tx, ty, tw, th) && this._areaIsRoad(tx, ty, tw, th)
      : this._isFree(tx - pad, ty - pad, tw + pad * 2, th + pad * 2);
    if (!free) return false;

    const x = this.ox + tx * TS, y = this.oy + ty * TS;
    const w = def.w * TILE_SCALE, h = def.h * TILE_SCALE;
    const f = def.foot;
    // Rasterise the footprint into the collision bitmap.
    const fx0 = x + w * f[0], fy0 = y + h * f[1];
    const fx1 = x + w * f[2], fy1 = y + h * f[3];
    for (let gy = Math.floor((fy0 - this.oy) / TS); gy <= Math.floor((fy1 - this.oy) / TS); gy++) {
      for (let gx = Math.floor((fx0 - this.ox) / TS); gx <= Math.floor((fx1 - this.ox) / TS); gx++) {
        if (this._in(gx, gy)) this.solid[gy * this.cols + gx] = 1;
      }
    }
    this._claimRect(tx, ty, tw, th);

    this.props.push({ def, x, y, w, h, baseY: fy1 });
    return true;
  }

  // ------------------------------------------------------------ collision

  /** @returns {boolean} true if world position (x, y) is inside something solid. */
  solidAt(x, y) {
    const gx = Math.floor((x - this.ox) / TS);
    const gy = Math.floor((y - this.oy) / TS);
    if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) return true;
    return this.solid[gy * this.cols + gx] === 1;
  }

  /** True if any of the four corners of the r-box around (x,y) is solid. */
  blocked(x, y, r) {
    return this.solidAt(x - r, y - r) || this.solidAt(x + r, y - r)
        || this.solidAt(x - r, y + r) || this.solidAt(x + r, y + r);
  }

  /**
   * Axis-separated swept move. Resolving X and Y independently is what lets an entity
   * slide along a wall instead of sticking to it, which matters enormously for a game
   * where a dozen shamblers are funnelling down a lane between two houses.
   *
   * Writes back into `ent.x` / `ent.y` and zeroes the blocked velocity component.
   * Allocates nothing.
   *
   * @param {{x:number,y:number,vx:number,vy:number}} ent
   * @param {number} r collision radius
   * @param {number} nx,ny desired new position
   */
  moveResolved(ent, r, nx, ny) {
    if (!this.blocked(nx, ent.y, r)) ent.x = nx; else ent.vx *= -0.15;
    if (!this.blocked(ent.x, ny, r)) ent.y = ny; else ent.vy *= -0.15;
  }

  /** Nearest walkable position to (x, y), searched outward. Used to place spawns. */
  nearestOpen(x, y, r) {
    if (!this.blocked(x, y, r)) return true;
    for (let ring = 1; ring <= 6; ring++) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const tx = x + Math.cos(a) * ring * TS, ty = y + Math.sin(a) * ring * TS;
        if (!this.blocked(tx, ty, r)) { this._ox = tx; this._oy = ty; return false; }
      }
    }
    this._ox = x; this._oy = y;
    return false;
  }

  // ------------------------------------------------------------ drawing

  /**
   * Ground plane + decals. Viewport-culled: only the tiles the camera can actually see
   * are blitted, so the cost is bounded by screen area rather than arena area.
   */
  drawGround(r) {
    const ctx = r.ctx;
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;

    const halfW = r.viewW / 2 + TS, halfH = r.viewH / 2 + TS;
    const x0 = Math.max(0, Math.floor((r.camX - halfW - this.ox) / TS));
    const x1 = Math.min(this.cols - 1, Math.ceil((r.camX + halfW - this.ox) / TS));
    const y0 = Math.max(0, Math.floor((r.camY - halfH - this.oy) / TS));
    const y1 = Math.min(this.rows - 1, Math.ceil((r.camY + halfH - this.oy) / TS));

    const tiles = this.atlas.tiles;
    for (let gy = y0; gy <= y1; gy++) {
      const wy = this.oy + gy * TS;
      const row = gy * this.cols;
      for (let gx = x0; gx <= x1; gx++) {
        const t = tiles[this.map[row + gx]];
        if (!t) continue;
        const wx = this.ox + gx * TS;
        if (t.under >= 0) {
          const u = tiles[t.under];
          if (u.img.complete) ctx.drawImage(u.img, wx, wy, TS + BLEED, TS + BLEED);
        }
        if (t.img.complete) ctx.drawImage(t.img, wx, wy, TS + BLEED, TS + BLEED);
      }
    }

    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      const a = this.atlas.decals[d.idx];
      const w = a.w * TILE_SCALE, h = a.h * TILE_SCALE;
      if (!r.inView(d.x + w / 2, d.y + h / 2, Math.max(w, h))) continue;
      if (a.img.complete) ctx.drawImage(a.img, d.x, d.y, w, h);
    }

    ctx.imageSmoothingEnabled = prevSmooth;
  }

  /**
   * Collect the props inside the viewport into a preallocated index buffer, ready for
   * the run's depth-sorted merge. Already ascending by baseY, because `props` is.
   */
  cullProps(r) {
    let n = 0;
    const buf = this._visProps;
    for (let i = 0; i < this.props.length && n < buf.length; i++) {
      const p = this.props[i];
      if (!r.inView(p.x + p.w / 2, p.y + p.h / 2, Math.max(p.w, p.h))) continue;
      buf[n++] = i;
    }
    this._visCount = n;
    return n;
  }

  drawPropAt(ctx, i, alpha = 1) {
    const p = this.props[i];
    const def = p.def;
    if (!def.img.complete) return;
    const prev = ctx.globalAlpha;
    if (alpha !== 1) ctx.globalAlpha = prev * alpha;
    if (def.crop) {
      const c = def.crop;
      ctx.drawImage(def.img, c[0], c[1], c[2], c[3], p.x, p.y, p.w, p.h);
    } else {
      ctx.drawImage(def.img, p.x, p.y, p.w, p.h);
    }
    if (alpha !== 1) ctx.globalAlpha = prev;
  }

  /**
   * Is world point (x, y) inside prop `i`'s drawn box?
   *
   * Used to fade a prop that is standing between the camera and the survivor. The test is
   * against the whole sprite box, not the collision footprint: what matters here is what
   * is painted over you, and the roof of a building hides you just as completely as its
   * wall does.
   */
  propCovers(i, x, y) {
    const p = this.props[i];
    return x > p.x && x < p.x + p.w && y > p.y && y < p.y + p.h;
  }

  propBaseY(i) { return this.props[i].baseY; }
}

export { clamp };
