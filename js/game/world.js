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
// ------------------------------------------------------------------ ground grid
//
// The ground is a second, coarser grid laid over the same arena as the collision map.
//
// It has to be. The city sheet's cells are 32 source px and are drawn — like everything
// else — at TILE_SCALE, so one ground tile covers 64 world px, which is a 2x2 block of
// 32px collision tiles. Drawing them per collision tile would mean slicing each into
// quadrants, and a lane marking does not survive that: a dashed centre line lives in the
// middle three columns of its cell and simply vanishes from the half of the quadrants
// that don't contain it. So `ground` is indexed at GTS and `solid`/`claim` stay at TS.
export const GTS = TILE_SRC * 2 * TILE_SCALE;   // 64 world px

// Night tint multipliers, per channel. Blue is attenuated least, so the daylight art
// loses more of its warmth than its cool tones and settles at roughly the luminance the
// game already had, instead of merely getting darker. Declared up here because both the
// sheet tint (loadCitySheet) and the flat ground fills below need it — and a `const` used
// above its declaration is a ReferenceError, not a hoisted undefined.
const NIGHT_TINT = [0.58, 0.62, 0.74];
/** Collision tiles per ground tile, per axis. */
const G_SUB = GTS / TS;                          // 2

/**
 * Ground tiles, as [col, row] cells in the city sheet.
 *
 * Identified by where the bright pixels sit inside each cell rather than by eye: a solid
 * line is bright across 4 columns and all 32 rows, its horizontal twin across all 32
 * columns and 4 rows, a dashed centre line is the same shape at 3x18, and a crossing is
 * 582 bright pixels banded across 21 of the 32 rows.
 */
const GROUND_TILES = [
  // Tarmac is painted as a colour rather than blitted from a cell.
  //
  // That began as a workaround: (3,0)/(5,0) carry a small repeated arch — 9 light pixels
  // and 7 dark — which vanishes in a mean-colour probe and reads as a field of bumps once
  // fifty of them tile down a street, and at the time no cell was both fully opaque and
  // untextured. The sheet has since been redrawn and c6..c11 *are* now perfectly flat
  // (1024 opaque pixels, zero off-dominant), so the workaround is no longer forced.
  //
  // It stays for a better reason than the one it started with: a fillRect is cheaper than
  // a texture read, this is the most-drawn thing on screen by a wide margin, and we are
  // fighting for frames on a 120Hz display. The colour is the sheet's own tarmac, so the
  // seam against the marking cells — whose background is that same 75,78,85 — is invisible.
  //
  // The key is `paint` and not `fill` for a sharp reason: this table mixes [col,row]
  // arrays with objects, and every array inherits Array.prototype.fill, so `if (t.fill)`
  // is truthy for every entry and hands you a function to destructure.
  { paint: [75, 78, 85] },   //  0 G_ROAD
  { paint: [75, 78, 85] },   //  1 G_ROAD2   same surface; kept as a separate id
  // The lane centre.
  //
  // This was the dashed pair at (8,1)/(10,1) until the roads were redrawn clean, which
  // removed the dashes altogether — those cells are now blank tarmac, so leaving the
  // table pointed at them would have silently deleted every road marking on the map
  // while still costing a blit. The solid lines survived the redraw and take over.
  [3, 1],   //  2 G_CENTRE_V   solid centre line, running north-south
  [4, 0],   //  3 G_CENTRE_H   solid centre line, running east-west
  [0, 1],   //  4 G_CROSS_H    zebra crossing, stripes banded east-west
  [1, 0],   //  5 G_CROSS_V    zebra crossing, stripes banded north-south
  // Pavement. Cells 12-14 look like pavement and are not: that 3x3 block is a *grass
  // planter* autotile — its corners carry 41 green pixels and its edges and centre 227.
  // Using a corner as the pavement tile stamped the same tuft of grass onto every
  // kerbside tile on the map. (4,1) is flat concrete: uniform luminance, no green at all.
  // The sheet has no second clean pavement variant, so both entries point at it rather
  // than reintroducing texture that would have to tile seamlessly with itself.
  [4, 1],   //  6 G_WALK       pavement
  [4, 1],   //  7 G_WALK2      kept as a distinct id; _isWalkTile tests for both
  [16, 1],  //  8 G_GRASS      the lots, gone to seed
  [28, 1],  //  9 G_COBBLE     the plaza
  [29, 1],  // 10 G_COBBLE2
  [1, 1],   // 11 G_LOT        darker asphalt — yards, alleys, forecourts
];

// Bake the night tint into every flat fill once, so drawGround never computes a colour.
// The sheet gets the same treatment pixel-by-pixel in loadCitySheet; doing it here too is
// what keeps a painted surface and a blitted tile the same shade of dark.
for (const t of GROUND_TILES) {
  if (!Array.isArray(t) && t.paint) {
    const [r, g, b] = t.paint;
    t.css = `rgb(${Math.round(r * NIGHT_TINT[0])},${Math.round(g * NIGHT_TINT[1])},${Math.round(b * NIGHT_TINT[2])})`;
  }
}

const G_ROAD = 0, G_ROAD2 = 1, G_CENTRE_V = 2, G_CENTRE_H = 3,
      G_CROSS_H = 4, G_CROSS_V = 5, G_WALK = 6, G_WALK2 = 7, G_GRASS = 8,
      G_COBBLE = 9, G_COBBLE2 = 10, G_LOT = 11;

/** Anything a car may be abandoned on. */
const ROAD_TILES = new Set([G_ROAD, G_ROAD2, G_CENTRE_V, G_CENTRE_H, G_CROSS_H, G_CROSS_V]);

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

// ------------------------------------------------------------------ authored maps
//
// A map hand-drawn in a tile editor and exported as assets/maps/town.json, painted from
// its own tileset (assets/maps/town-tiles.png, an 8-column grid of 32px tiles). When a
// map is supplied, World renders and collides *it* instead of generating a procedural
// city — the deliberate layout the player asked for, in place of the scattered one.
//
// 32px tiles, drawn at 2x like the city sheet, so one map tile is one 64px ground cell
// (GTS) and two collision cells (TS) on a side. Authoring at 32px is therefore correct;
// 64px art would come out doubled.
const TOWN_SRC = 'assets/maps/town-tiles.png';
const TOWN_COLS = 8;

// Which tile ids are walkable ground, when the map doesn't say for itself.
//
// Hard surfaces only — tarmac, road markings, pavement, concrete, cobble. Grass and
// foliage are NOT here: in a city you walk on the street and go *around* the planted
// ground, so bushes, hedges and verges block like the buildings do. That matches what
// the map actually looks like (you stand on the crosswalk, not in the hedge) and it is
// the fix for walking straight through tall grass.
//
// This is only the fallback. If a tile in the map carries its own `collider` flag —
// painted in the editor — that wins, so any map can override this per tile: make a park
// walkable, make a specific post passable, whatever the author drew.
const TOWN_WALKABLE = new Set([
  2, 3, 4, 5, 22, 23, 28, 29,                                           // concrete / pavement
  143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 156, 157, 158, 159, // road / cobble
]);


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
  // No bush_a. It was the flowered bush at (193,162); the sheet redraw deleted it, and
  // that rect now holds a single stray pixel.
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
  bush_b:     { city: 'bush_b',     foot: [0.15, 0.45, 0.85, 0.95] },
  hedge:      { city: 'hedge',      foot: [0.02, 0.35, 0.98, 0.97] },
  // Street furniture — deliberately NOT solid.
  //
  // Collision is a bitmap at TS (32 world px), so any footprint at all rounds up to whole
  // tiles: a road sign whose base is 13px wide still marks a full 32px tile, an invisible
  // wall more than twice the width of the thing you can see. Two of those either side of
  // a wreck leave a gap narrower than the survivor's 26px diameter, and you are wedged in
  // place by scenery you could obviously step around. Cars, buildings and trees are big
  // enough that their collider matches their art; a bin is not.
  //
  // They still claim their space, so they don't stack on top of each other.
  pole:       { city: 'pole',   foot: [0.36, 0.86, 0.64, 1.0], solid: false },
  light:      { city: 'light',  foot: [0.30, 0.78, 0.70, 1.0], solid: false },
  sign_a:     { city: 'sign_a', foot: [0.34, 0.86, 0.66, 1.0], solid: false },
  sign_b:     { city: 'sign_b', foot: [0.34, 0.86, 0.66, 1.0], solid: false },
  bench:      { city: 'bench',  foot: [0.06, 0.45, 0.94, 0.98], solid: false },
  bin:        { city: 'bin',    foot: [0.10, 0.35, 0.90, 0.98], solid: false },
  crate:      { city: 'crate',  foot: [0.08, 0.30, 0.92, 0.98], solid: false },

  // The CHAINLINK/STORM DRAIN props are gone. They were the last three entries pointing
  // at the old generated tileset, no pass had placed any of them since the city rewrite,
  // and keeping them meant the whole legacy loader — loadImage, the DIR/N filename
  // convention, the non-city branch of the atlas — stayed alive for three sprites nobody
  // could see. The city sheet has its own fences if a boundary pass ever wants one.
};

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
function loadCitySheet(src = CITY_SRC) {
  const canvas = document.createElement('canvas');
  canvas.width = 992; canvas.height = 416;
  const img = new Image();
  img.onerror = () => console.warn('[world] failed to load', src);
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
  img.src = src;
  // Matches the `img.complete` guard the tile/prop draw paths already use.
  canvas.complete = false;
  return canvas;
}

/**
 * The supply-drop chest, tinted to match everything else.
 *
 * Its own file rather than a rect on the sheet, so it goes through the same loader: an
 * untinted 16px sprite dropped into a night scene reads as lit from a different sun, and
 * this one is deliberately the brightest object on the map already.
 */
export const CHEST_SRC = 'assets/city/chest.png';
let CHEST = null;
export function chestImage() {
  if (!CHEST) CHEST = loadCitySheet(CHEST_SRC);
  return CHEST;
}

// The authored-map tileset, tinted to night through the same loader as everything else.
let TOWN = null;
function townSheet() {
  if (!TOWN) TOWN = loadCitySheet(TOWN_SRC);
  return TOWN;
}

/** Lazily built once, shared process-wide. */
let ATLAS = null;
function atlas() {
  if (ATLAS) return ATLAS;
  ATLAS = { props: {}, city: loadCitySheet() };
  // Every prop is a rect on the one city sheet now, so there is no second image path and
  // no per-prop Image to wait on: if the sheet has decoded, everything has.
  for (const k in PROP_DEFS) {
    const d = PROP_DEFS[k];
    const [sx, sy, sw, sh] = CITY[d.city];
    ATLAS.props[k] = { img: ATLAS.city, crop: [sx, sy, sw, sh], w: sw, h: sh, foot: d.foot,
                       solid: d.solid !== false };
  }
  return ATLAS;
}

/** Every image file this module can request, for the service worker shell list. */
export function shellAssets() {
  return [`./${CITY_SRC}`, `./${CHEST_SRC}`, `./${TOWN_SRC}`, './assets/maps/town.json'];
}

// ------------------------------------------------------------------ World

export class World {
  /**
   * @param {{x:number,y:number,w:number,h:number}} arena world-space bounds
   * @param {number} seed
   */
  constructor(arena, seed, mapData = null) {
    this.atlas = atlas();
    this.arena = arena;
    this.authored = null;
    if (mapData) { this._loadAuthored(arena, mapData); return; }
    this.ox = arena.x;
    this.oy = arena.y;
    this.cols = Math.ceil(arena.w / TS);
    this.rows = Math.ceil(arena.h / TS);

    // Ground is coarser than collision — see the note on GTS.
    this.gcols = Math.ceil(arena.w / GTS);
    this.grows = Math.ceil(arena.h / GTS);
    this.ground = new Uint8Array(this.gcols * this.grows);

    this.solid = new Uint8Array(this.cols * this.rows);
    // Marks tiles that generation has claimed (roads, buildings, yards) so later passes
    // don't drop a tree in the middle of the square.
    this.claim = new Uint8Array(this.cols * this.rows);

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

  /**
   * Load a hand-authored map in place of generating one.
   *
   * The map's own dimensions become the arena — it is 67x40 tiles where the procedural
   * arena was 37x37, so `arena` is resized in place (the same object Run holds, so its
   * spawn clamping and camera bounds follow). Every tile is painted from the map's
   * tileset; every non-walkable tile marks its 2x2 collision block solid. There are no
   * props: buildings are part of the tile layer, so `props` stays empty and the whole
   * depth-sorted prop pass simply finds nothing — the trade for authored layout is that
   * you don't walk behind roofs, which a top-down authored map doesn't promise anyway.
   */
  _loadAuthored(arena, map) {
    const W = map.mapWidth, H = map.mapHeight;
    arena.w = W * GTS; arena.h = H * GTS;
    arena.x = -arena.w / 2; arena.y = -arena.h / 2;
    this.ox = arena.x; this.oy = arena.y;
    this.gcols = W; this.grows = H;
    this.cols = W * G_SUB; this.rows = H * G_SUB;

    this.ground = null;
    this.solid = new Uint8Array(this.cols * this.rows);
    this.claim = new Uint8Array(this.cols * this.rows);
    this.props = [];
    this.town = townSheet();

    const markSolid = (gx, gy) => {
      for (let sy = gy * G_SUB; sy < gy * G_SUB + G_SUB; sy++)
        for (let sx = gx * G_SUB; sx < gx * G_SUB + G_SUB; sx++)
          this.solid[sy * this.cols + sx] = 1;
    };
    const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

    // Sprite Fusion exports one layer per drawing layer, each with a `collider` flag.
    // Every layer is drawn — a collider layer is real painted art (buildings, props) that
    // also blocks, not an invisible mask.
    //
    // Draw the non-collider layers first (the ground) and the collider layers last, on
    // top. This makes the one invariant that matters hold: what blocks is what you see.
    // Drawing them in raw export order put the collision art *under* the ground layer, so
    // a building's tile was hidden beneath pavement while its cell stayed solid — an
    // invisible wall on open-looking ground. Colliders on top removes that class of bug
    // regardless of how the editor happens to order its export.
    const layers = map.layers || [];
    const colliderLayers = layers.filter((L) => L.collider);
    const drawOrder = [...layers.filter((L) => !L.collider), ...colliderLayers];

    this.authoredLayers = drawOrder.map((L) => {
      const grid = new Int16Array(W * H).fill(-1);
      for (const c of (L.tiles || [])) if (inb(c.x, c.y)) grid[c.y * W + c.x] = +c.id;
      return grid;
    });
    // Back-compat alias: the top visual layer, for anything that reads a single grid.
    this.authored = this.authoredLayers[this.authoredLayers.length - 1] || new Int16Array(W * H).fill(-1);

    // Occluder cells — the tiles the survivor and the dead can walk *behind*. Same set as
    // the solid cells: if it blocks you it hides you, one rule the author controls just by
    // painting collision. Each becomes a depth-sorted prop below (see the note there), so
    // its own tile is drawn a second time over anything standing lower on the screen.
    // Solidity, and the cells you walk behind, come from the collision the author painted
    // — nothing guessed. The id-classification fallback is only for maps that ship no
    // collision layer at all; used *alongside* a painted layer it produces invisible walls,
    // because that classification is calibrated to one tileset and every map brings its own,
    // so an id that is road in this tileset can be a wall in the table. Trust the paint.
    const marked = new Uint8Array(W * H);
    const addOccluder = (gx, gy) => {
      const key = gy * W + gx;
      if (marked[key]) return;
      marked[key] = 1;
      markSolid(gx, gy);
    };
    if (colliderLayers.length) {
      for (const L of colliderLayers) for (const c of (L.tiles || [])) if (inb(c.x, c.y)) addOccluder(c.x, c.y);
    } else {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const id = this.authored[y * W + x];
        if (id >= 0 && !TOWN_WALKABLE.has(id)) addOccluder(x, y);
      }
    }
    const occluders = [];
    for (let i = 0; i < marked.length; i++) if (marked[i]) occluders.push(i);

    // Turn each occluder cell into a prop so the run's depth pass draws it over any body
    // whose feet are above the cell's base — the walk-behind effect. The visual tile is
    // whatever the top visual layer shows there; a collider cell with no art (a pure
    // collision mask over empty ground) simply doesn't occlude, which is correct.
    for (const cell of occluders) {
      const gx = cell % W, gy = (cell / W) | 0;
      let id = -1;
      for (const layer of this.authoredLayers) { const v = layer[cell]; if (v >= 0) id = v; }
      if (id < 0) continue;
      const x = this.ox + gx * GTS, y = this.oy + gy * GTS;
      this.props.push({ tile: id, x, y, w: GTS, h: GTS, baseY: y + GTS });
    }
    // Pre-sort by base-Y so the draw pass merges rather than sorts (as procedural props do).
    this.props.sort((a, b) => a.baseY - b.baseY);
    // Solid border so nothing is pushed off the edge.
    for (let x = 0; x < this.cols; x++) { this.solid[x] = 1; this.solid[(this.rows - 1) * this.cols + x] = 1; }
    for (let y = 0; y < this.rows; y++) { this.solid[y * this.cols] = 1; this.solid[y * this.cols + this.cols - 1] = 1; }

    this._visProps = new Int32Array(4);
    this._visCount = 0;
  }

  // ------------------------------------------------------------ generation

  /**
   * A city block plan, not a village.
   *
   * The previous generator drew two sine-wobbled roads through a field and then
   * rejection-sampled buildings anywhere that happened to be near one. That produces
   * scattered sheds, because nothing in it has any notion of a block, a frontage or a
   * kerb — which is exactly what made the map read as random.
   *
   * This lays a street grid first and derives everything else from it: streets, then the
   * pavements that flank them, then the blocks between, then buildings standing along a
   * block's street edge, then the lots behind them. Every later pass asks the grid where
   * it is allowed to put things instead of guessing and retrying.
   *
   * Straight streets are a deliberate reversal. The wobble existed so nothing looked like
   * a ruler line; in a city the ruler line *is* the point, and the variety has to come
   * from what fills the blocks rather than from bending the roads.
   */
  _generate(rng) {
    const { gcols, grows } = this;
    this.ground.fill(G_GRASS);

    // --- the street grid ---
    //
    // Period is street width plus block depth. Both are in ground cells (64 world px):
    // a 3-cell street is 192 world px, three times the survivor's height, which is about
    // right for two lanes plus the room a wreck needs to be an obstacle rather than a
    // wall. Blocks are deep enough for a building (up to 10 collision tiles) plus a yard.
    // Street width and block depth, tuned against a city drawn by hand in a tile editor
    // and then measured rather than eyeballed: its median open corridor is 4 cells and
    // 37.5% of its area is built on, where this generator was producing 3-cell streets
    // with only 14-19% built. Narrow roads and empty blocks is what reads as suburban;
    // wide roads and packed blocks is what reads as a city.
    //
    // The wider street is also the safer of the two changes for play: 256 world px of
    // tarmac leaves room to dodge around an abandoned car instead of being funnelled into
    // it, which matters more here than it did in the reference, since nothing was chasing
    // whoever drew that map.
    // Tuned against a city drawn by hand in a tile editor, measured with that map's own
    // tileset so ground and structure were told apart by what the tile actually depicts,
    // not guessed from frequency. Its proportions: 26.6% tarmac, 29.5% pavement, 13.2%
    // grass, 30.7% built — with road corridors only 2 cells wide.
    //
    // The surprising number is the pavement: there is more of it than road. That is most
    // of why the reference reads as a city and a grid of wide roads reads as a retail
    // park — beside a building you walk on kerb, not tarmac. The pavement ring the block
    // pass lays down is what carries that here.
    //
    // Streets hold at 3, not the reference's 2. At 2 cells a street is 128 world px and an
    // abandoned car is 86 of them, leaving a 40px gap for a 26px survivor with a horde
    // behind them — the reference was drawn to be looked at, not to be chased through.
    // Blocks are large (12-14) so the block interior dominates the road, as it does in
    // the reference.
    const SW = 3;                                   // street width, ground cells
    const BLOCK = 12 + Math.floor(rng.next() * 3);  // 12..14
    const P = SW + BLOCK;

    // Centre the grid so the middle of the arena lands inside a block, not on tarmac —
    // that block becomes the plaza and the survivor starts on it.
    // Phase the grid off a modulo rather than by walking outward from the centre. The
    // walk-outward form had a trap: `BLOCK / 2` is fractional for odd BLOCK, so every
    // street position came out on a half cell, every `onStreetX[sx + k]` wrote to a
    // non-integer index, and the map generated as unbroken grass with no streets and no
    // blocks — silently, because writing to array[9.5] is not an error.
    const gcx = gcols >> 1, gcy = grows >> 1;
    const half = BLOCK >> 1;
    const offX = (((gcx - SW - half) % P) + P) % P;
    const offY = (((gcy - SW - half) % P) + P) % P;
    const streetXs = [], streetYs = [];
    for (let x = offX - P; x < gcols; x += P) streetXs.push(x);
    for (let y = offY - P; y < grows; y += P) streetYs.push(y);

    const onStreetX = new Uint8Array(gcols), onStreetY = new Uint8Array(grows);
    for (const sx of streetXs) for (let k = 0; k < SW; k++) if (sx + k >= 0 && sx + k < gcols) onStreetX[sx + k] = 1;
    for (const sy of streetYs) for (let k = 0; k < SW; k++) if (sy + k >= 0 && sy + k < grows) onStreetY[sy + k] = 1;

    // Tarmac everywhere a street runs, with the centre lane marked. A cell that is on
    // both a north-south and an east-west street is an intersection and carries no
    // markings at all — painting a centre line through a junction is the one thing that
    // instantly reads as wrong to anyone who has seen a road.
    for (let gy = 0; gy < grows; gy++) {
      for (let gx = 0; gx < gcols; gx++) {
        const vx = onStreetX[gx], hy = onStreetY[gy];
        if (!vx && !hy) continue;
        let tile = rng.next() < 0.5 ? G_ROAD : G_ROAD2;
        if (vx && hy) {
          // junction: bare tarmac
        } else if (vx) {
          if (this._isLaneCentre(gx, streetXs, SW)) tile = G_CENTRE_V;
        } else {
          if (this._isLaneCentre(gy, streetYs, SW)) tile = G_CENTRE_H;
        }
        this.ground[gy * gcols + gx] = tile;
      }
    }

    // Zebra crossings on each approach to a junction: the street cells immediately
    // outside the intersection box, on all four sides.
    for (const sx of streetXs) {
      for (const sy of streetYs) {
        for (let k = 0; k < SW; k++) {
          this._setG(sx + k, sy - 1, G_CROSS_V);
          this._setG(sx + k, sy + SW, G_CROSS_V);
          this._setG(sx - 1, sy + k, G_CROSS_H);
          this._setG(sx + SW, sy + k, G_CROSS_H);
        }
      }
    }

    // --- pavements, and the blocks behind them ---
    //
    // Walked as a ring around each block rather than as an edge of each street: the ring
    // is what makes the corners join up, and a corner that doesn't join is the first
    // thing the eye finds.
    const blocks = [];
    for (let bi = 0; bi < streetXs.length - 1; bi++) {
      for (let bj = 0; bj < streetYs.length - 1; bj++) {
        const x0 = streetXs[bi] + SW, x1 = streetXs[bi + 1] - 1;
        const y0 = streetYs[bj] + SW, y1 = streetYs[bj + 1] - 1;
        if (x1 < x0 || y1 < y0) continue;
        if (x1 < 0 || y1 < 0 || x0 >= gcols || y0 >= grows) continue;
        // Pavement ring, two cells thick.
        //
        // A one-cell ring gave 5% pavement against the reference's 30%, and left block
        // interiors as vast empty grass lots. The reference's defining proportion is that
        // there is more kerb than road — so the ring is the width the block can spare
        // (two cells, or one if the block is too small to keep an interior), and it both
        // carries that proportion and shrinks the hollow middle to something a city would
        // actually have.
        const ring = (x1 - x0 >= 5 && y1 - y0 >= 5) ? 2 : 1;
        blocks.push({ x0, y0, x1, y1, ring });
        for (let k = 0; k < ring; k++) {
          for (let x = x0 + k; x <= x1 - k; x++) { this._setG(x, y0 + k, G_WALK); this._setG(x, y1 - k, G_WALK); }
          for (let y = y0 + k; y <= y1 - k; y++) { this._setG(x0 + k, y, G_WALK); this._setG(x1 - k, y, G_WALK); }
        }
      }
    }

    // Interiors: some blocks are paved yards, some have gone to seed. Grass earns its
    // place here rather than as a default surface — a lot with weeds coming through is a
    // city being taken back, whereas grass everywhere is just a field with sheds on it.
    const plaza = this._blockAt(blocks, gcx, gcy);
    for (const b of blocks) {
      // Interiors lean paved, not grassed. The reference is 30% pavement against 13%
      // grass — a city where the green is the exception — and filling big block interiors
      // mostly with grass inverted that into 40% grass and read as parkland with towers
      // on the edge. Grass stays as the minority "gone to seed" note it was meant to be.
      const paved = rng.next() < 0.72;
      const r = b.ring || 1;   // fill only what the pavement ring didn't take
      for (let y = b.y0 + r; y <= b.y1 - r; y++) {
        for (let x = b.x0 + r; x <= b.x1 - r; x++) {
          this._setG(x, y, paved ? G_LOT : G_GRASS);
        }
      }
    }
    if (plaza) {
      for (let y = plaza.y0; y <= plaza.y1; y++) {
        for (let x = plaza.x0; x <= plaza.x1; x++) {
          this._setG(x, y, rng.next() < 0.5 ? G_COBBLE : G_COBBLE2);
          // Claimed as well as paved. Cobble is neither road nor pavement, so the claim
          // pass below skips it, and without this the treeline pass plants in the middle
          // of the plaza — on the spawn.
          this._claimG(x, y);
        }
      }
    }

    // Streets and pavements are claimed, so trees and buildings stay off them. Cars and
    // street furniture opt back in explicitly — see _placeProp's `onRoad`.
    for (let gy = 0; gy < grows; gy++) {
      for (let gx = 0; gx < gcols; gx++) {
        const t = this.ground[gy * gcols + gx];
        if (ROAD_TILES.has(t) || t === G_WALK || t === G_WALK2) this._claimG(gx, gy);
      }
    }

    // --- buildings, standing on their frontage ---
    //
    // Along the *bottom* edge of each block, so the facade faces the street below it.
    // These sprites are drawn front-on with the roof foreshortened above; a building put
    // against the top edge would present its front to the block interior and its back to
    // the road, which looks like the row was laid out backwards.
    const TALL = ['apt_grey', 'apt_purple', 'apt_brown'];
    const SHORT = ['shop_red', 'shop_white', 'shop_blue'];
    for (const b of blocks) {
      if (b === plaza) continue;
      // Bounded by the block *interior* — inside the pavement ring, whose cells the claim
      // pass marks. A building started on the ring overlaps claimed ground and _isFree
      // rejects every placement silently; when the ring went from one cell to two, the
      // old `+1` offset landed on the ring and produced zero buildings on the whole map.
      // Offsetting by `b.ring` keeps the frontage on the block's own interior edge.
      const r = b.ring || 1;
      const txStart = (b.x0 + r) * G_SUB;
      const txEnd = (b.x1 - r + 1) * G_SUB;
      // Depth available behind the frontage decides whether a tower fits at all.
      const depthTiles = (b.y1 - b.y0 - 2 * r) * G_SUB;

      // A row of frontages, laid left to right until the block runs out.
      //
      // `anchorTop` decides which edge the row is measured from: the front row hangs its
      // *base* on the block's bottom edge, the back row hangs its *top* on the block's
      // top edge. Buildings differ in height, so this has to be resolved per building
      // rather than from one precomputed y.
      const row = (edgeTile, anchorTop, allowTall) => {
        let tx = txStart, guard = 0;
        while (tx < txEnd && guard++ < 12) {
          const wantTall = allowTall && depthTiles >= 10 && rng.next() < 0.45;
          const pool = wantTall ? TALL : SHORT;
          const key = pool[Math.floor(rng.next() * pool.length)];
          const def = this.atlas.props[key];
          const tw = Math.ceil((def.w * TILE_SCALE) / TS), th = Math.ceil((def.h * TILE_SCALE) / TS);
          if (tx + tw > txEnd) break;
          // _placeProp takes the top-left tile, so anchoring the top *is* the edge, and
          // anchoring the base backs up by the building's own height.
          this._placeProp(key, tx, anchorTop ? edgeTile : edgeTile - th + 1, rng, false);
          tx += tw + (rng.next() < 0.5 ? 1 : 2);
        }
      };

      // The street-facing row, on the interior edge just inside the bottom pavement.
      row((b.y1 - r + 1) * G_SUB - 1, false, true);

      // A second row along the top of the block, where there's depth for it.
      //
      // This is the density half of the tuning. One row per block leaves the middle of
      // every block empty, which is what made the map read as sheds in a field: a real
      // block is built on from both streets and hollow only in the middle. The back row
      // is capped to short buildings — a tower here would tuck its facade against the row
      // in front and occlude it — and only runs when the block is deep enough that the
      // two rows won't collide, which _placeProp would reject anyway but silently.
      if (b.y1 - b.y0 >= 6) row((b.y0 + r) * G_SUB, true, false);
    }

    // The plaza gets no building of its own. It is the one piece of open ground on the
    // map and it is where the survivor starts the night — an anchor block dropped in the
    // middle of it covers the spawn, which is how the first version of this generated:
    // every seed opened with the survivor shoved out from under a wall by nearestOpen.
    // apt_brown earns its place in the ordinary frontage pool above instead.

    // --- abandoned traffic ---
    //
    // On the tarmac, oriented along the lane. Cars are the only pass allowed onto claimed
    // ground, which is the whole point of them: an empty grid of streets is a racetrack,
    // and a street you have to pick your way down is somewhere to fight.
    let cars = 0;
    for (let i = 0; i < 600 && cars < 30; i++) {
      const tx = 2 + Math.floor(rng.next() * (this.cols - 6));
      const ty = 2 + Math.floor(rng.next() * (this.rows - 6));
      if (plaza && this._inBlock(plaza, tx / G_SUB, ty / G_SUB)) continue;   // keep the spawn clear
      const horiz = this._roadRuns(tx, ty, 1, 0), vert = this._roadRuns(tx, ty, 0, 1);
      if (!horiz && !vert) continue;
      const alongY = vert && (!horiz || rng.next() < 0.5);
      const pool = alongY ? CAR_V : CAR_H;
      const kind = pool[Math.floor(rng.next() * pool.length)];
      if (this._placeProp(kind, tx, ty, rng, false, 'road')) cars++;
    }

    // --- street furniture, on the pavement ---
    // No hedge here any more. It is a 180x58 slab of greenery drawn face-on, and dropped
    // at random on a pavement it reads as a fence panel someone abandoned — the one prop
    // on the sheet that needs to be placed deliberately, along a boundary, or not at all.
    const STREET = ['pole', 'light', 'sign_a', 'sign_b', 'bench', 'bin', 'crate'];
    let street = 0;
    for (let i = 0; i < 700 && street < 46; i++) {
      const kind = STREET[Math.floor(rng.next() * STREET.length)];
      const tx = 2 + Math.floor(rng.next() * (this.cols - 6));
      const ty = 2 + Math.floor(rng.next() * (this.rows - 6));
      if (this._placeProp(kind, tx, ty, rng, false, 'walk')) street++;
    }

    // --- what grew back ---
    //
    // Trees and scrub in the lots, densest at the edges of the map where the city thins
    // out. Kept off the pavement by the claim pass above.
    // bush_a is gone: the flowered bush was deleted from the sheet, and its rect now
    // holds a single stray pixel — placing it would have scattered invisible props that
    // still claimed ground and still cost a blit.
    const green = ['tree_leafy', 'tree_pine', 'tree_leafy', 'bush_b'];
    for (let i = 0; i < 900; i++) {
      const tx = Math.floor(rng.next() * this.cols);
      const ty = Math.floor(rng.next() * this.rows);
      const edge = Math.max(Math.abs(tx - this.cols / 2) / (this.cols / 2),
                            Math.abs(ty - this.rows / 2) / (this.rows / 2));
      if (rng.next() > edge * edge * 0.9 + 0.14) continue;
      this._placeProp(green[Math.floor(rng.next() * green.length)], tx, ty, rng, false);
    }

    // The arena border itself is solid, so nothing can be pushed through the wall by
    // the separation forces.
    const { cols, rows } = this;
    for (let x = 0; x < cols; x++) { this.solid[x] = 1; this.solid[(rows - 1) * cols + x] = 1; }
    for (let y = 0; y < rows; y++) { this.solid[y * cols] = 1; this.solid[y * cols + cols - 1] = 1; }
  }

  /** True if ground column/row `v` is the middle lane of the street starting at one of `starts`. */
  _isLaneCentre(v, starts, sw) {
    for (const s of starts) if (v === s + (sw >> 1)) return true;
    return false;
  }

  _setG(gx, gy, tile) {
    if (gx < 0 || gy < 0 || gx >= this.gcols || gy >= this.grows) return;
    this.ground[gy * this.gcols + gx] = tile;
  }

  _getG(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= this.gcols || gy >= this.grows) return -1;
    return this.ground[gy * this.gcols + gx];
  }

  /** Ground tile under collision tile (tx, ty). */
  _groundAtTile(tx, ty) { return this._getG(Math.floor(tx / G_SUB), Math.floor(ty / G_SUB)); }

  _isWalkTile(tx, ty) {
    const t = this._groundAtTile(tx, ty);
    return t === G_WALK || t === G_WALK2;
  }

  /** Mark the G_SUB x G_SUB collision tiles under ground cell (gx, gy) as claimed. */
  _claimG(gx, gy) {
    for (let y = gy * G_SUB; y < (gy + 1) * G_SUB; y++) {
      for (let x = gx * G_SUB; x < (gx + 1) * G_SUB; x++) {
        if (this._in(x, y)) this.claim[y * this.cols + x] = 1;
      }
    }
  }

  _inBlock(b, gx, gy) { return gx >= b.x0 && gx <= b.x1 && gy >= b.y0 && gy <= b.y1; }

  _blockAt(blocks, gx, gy) {
    for (const b of blocks) if (this._inBlock(b, gx, gy)) return b;
    return null;
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
      if (!ROAD_TILES.has(this._groundAtTile(x, y))) return false;
    }
    return true;
  }

  _in(x, y) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }

  _claimRect(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (this._in(x, y)) this.claim[y * this.cols + x] = 1;
      }
    }
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

  /** Every tile under the box is street surface — tarmac, markings or crossing. */
  _areaIsRoad(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!this._in(x, y)) return false;
        if (!ROAD_TILES.has(this._groundAtTile(x, y))) return false;
      }
    }
    return true;
  }

  /** As above, but for the pavement — where the street furniture belongs. */
  _areaIsWalk(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!this._in(x, y) || !this._isWalkTile(x, y)) return false;
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

  /**
   * Place a prop with its top-left at tile (tx, ty), if the space is free.
   * @param {boolean} strict also claim a 1-tile margin, so buildings get breathing room
   */
  _placeProp(key, tx, ty, rng, strict, surface = null) {
    const def = this.atlas.props[key];
    // Footprint in tiles, computed from the prop's *world* size rather than from its
    // source pixels. Identical to the old `w / TILE_SRC` for the 16px tileset art, and
    // correct for the 32px city sheet, which the old form counted as double-width.
    const tw = Math.ceil((def.w * TILE_SCALE) / TS), th = Math.ceil((def.h * TILE_SCALE) / TS);
    const pad = strict ? 1 : 0;
    // Wrecks and street furniture are placed *onto* claimed ground — that is the whole
    // point of them — so they test solidity only, plus a check that they are standing on
    // the right surface. Everything else takes the ordinary unclaimed-space test.
    const free = surface === 'road'
      ? this._isClear(tx, ty, tw, th) && this._areaIsRoad(tx, ty, tw, th)
      : surface === 'walk'
      ? this._isClear(tx, ty, tw, th) && this._areaIsWalk(tx, ty, tw, th)
      : this._isFree(tx - pad, ty - pad, tw + pad * 2, th + pad * 2);
    if (!free) return false;

    const x = this.ox + tx * TS, y = this.oy + ty * TS;
    const w = def.w * TILE_SCALE, h = def.h * TILE_SCALE;
    const f = def.foot;
    // Rasterise the footprint into the collision bitmap — unless the prop is scenery.
    const fx0 = x + w * f[0], fy0 = y + h * f[1];
    const fx1 = x + w * f[2], fy1 = y + h * f[3];
    if (def.solid) {
      for (let gy = Math.floor((fy0 - this.oy) / TS); gy <= Math.floor((fy1 - this.oy) / TS); gy++) {
        for (let gx = Math.floor((fx0 - this.ox) / TS); gx <= Math.floor((fx1 - this.ox) / TS); gx++) {
          if (this._in(gx, gy)) this.solid[gy * this.cols + gx] = 1;
        }
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

  // ------------------------------------------------------------ flow field
  //
  // One shared shortest-path field, so the horde routes around buildings and trees
  // instead of grinding on them. A breadth-first sweep out from the survivor fills every
  // reachable cell with its step-distance to them; a zombie then just walks toward the
  // neighbour cell with the lower number. The whole crowd reads the one field — the cost
  // is a single sweep, not pathfinding per body — and it is only rebuilt when the survivor
  // crosses into a new tile, which is a few times a second at a walk.

  /** Rebuild the field from a world point. No-op if the source cell hasn't changed. */
  computeFlow(px, py) {
    const cols = this.cols, rows = this.rows, n = cols * rows;
    const sx = clamp(Math.floor((px - this.ox) / TS), 0, cols - 1);
    const sy = clamp(Math.floor((py - this.oy) / TS), 0, rows - 1);
    const start = sy * cols + sx;
    if (this._flow && start === this._flowStart) return;   // survivor still in the same cell
    if (!this._flow) { this._flow = new Int32Array(n); this._flowQ = new Int32Array(n); }
    const flow = this._flow, q = this._flowQ;
    flow.fill(-1);
    // If the survivor is somehow in a wall, seed the nearest open cell so the field exists.
    let seed = start;
    if (this.solid[seed]) { if (this.nearestOpen(px, py, 8) === false) {
      seed = clamp(Math.floor((this._oy - this.oy) / TS), 0, rows - 1) * cols
           + clamp(Math.floor((this._ox - this.ox) / TS), 0, cols - 1);
    } }
    this._flowStart = start;
    let head = 0, tail = 0;
    flow[seed] = 0; q[tail++] = seed;
    while (head < tail) {
      const c = q[head++], d = flow[c] + 1, cx = c % cols, cy = (c / cols) | 0;
      if (cx + 1 < cols) { const i = c + 1; if (!this.solid[i] && flow[i] < 0) { flow[i] = d; q[tail++] = i; } }
      if (cx - 1 >= 0)   { const i = c - 1; if (!this.solid[i] && flow[i] < 0) { flow[i] = d; q[tail++] = i; } }
      if (cy + 1 < rows) { const i = c + cols; if (!this.solid[i] && flow[i] < 0) { flow[i] = d; q[tail++] = i; } }
      if (cy - 1 >= 0)   { const i = c - cols; if (!this.solid[i] && flow[i] < 0) { flow[i] = d; q[tail++] = i; } }
    }
  }

  /**
   * Unit vector at (x, y) pointing down the field toward the survivor, or null if the
   * point is off the field (in a wall, or a pocket the sweep never reached — the caller
   * then falls back to steering straight at the player).
   */
  flowDir(x, y) {
    const flow = this._flow;
    if (!flow) return null;
    const cols = this.cols, rows = this.rows;
    const cx = clamp(Math.floor((x - this.ox) / TS), 0, cols - 1);
    const cy = clamp(Math.floor((y - this.oy) / TS), 0, rows - 1);
    const here = flow[cy * cols + cx];
    if (here < 0) return null;
    let best = here, bx = 0, by = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      // Don't cut a diagonal through a wall corner.
      if (dx && dy && (this.solid[cy * cols + nx] || this.solid[ny * cols + cx])) continue;
      const v = flow[ny * cols + nx];
      if (v >= 0 && v < best) { best = v; bx = dx; by = dy; }
    }
    if (!bx && !by) return null;
    const l = Math.hypot(bx, by);
    return [bx / l, by / l];
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

    const halfW = r.viewW / 2 + GTS, halfH = r.viewH / 2 + GTS;
    const x0 = Math.max(0, Math.floor((r.camX - halfW - this.ox) / GTS));
    const x1 = Math.min(this.gcols - 1, Math.ceil((r.camX + halfW - this.ox) / GTS));
    const y0 = Math.max(0, Math.floor((r.camY - halfH - this.oy) / GTS));
    const y1 = Math.min(this.grows - 1, Math.ceil((r.camY + halfH - this.oy) / GTS));
    const S = TILE_SRC * 2;   // 32px source cell

    // Authored map: paint each visual layer bottom-to-top, viewport-culled.
    if (this.authored) {
      const sheet = this.town;
      if (sheet.complete) {
        for (let gy = y0; gy <= y1; gy++) {
          const wy = this.oy + gy * GTS, row = gy * this.gcols;
          for (let gx = x0; gx <= x1; gx++) {
            const wx = this.ox + gx * GTS;
            for (const layer of this.authoredLayers) {
              const id = layer[row + gx];
              if (id < 0) continue;
              ctx.drawImage(sheet, (id % TOWN_COLS) * S, ((id / TOWN_COLS) | 0) * S, S, S,
                            wx, wy, GTS + BLEED, GTS + BLEED);
            }
          }
        }
      }
      ctx.imageSmoothingEnabled = prevSmooth;
      return;
    }

    const sheet = this.atlas.city;
    if (sheet.complete) {
      for (let gy = y0; gy <= y1; gy++) {
        const wy = this.oy + gy * GTS;
        const row = gy * this.gcols;
        for (let gx = x0; gx <= x1; gx++) {
          const cell = GROUND_TILES[this.ground[row + gx]];
          if (!cell) continue;
          const wx = this.ox + gx * GTS;
          if (cell.css) {
            // Flat surface (see G_ROAD). Pre-tinted at module load, so this costs a
            // fillRect and nothing else.
            ctx.fillStyle = cell.css;
            ctx.fillRect(wx, wy, GTS + BLEED, GTS + BLEED);
          } else {
            ctx.drawImage(sheet, cell[0] * S, cell[1] * S, S, S,
                          wx, wy, GTS + BLEED, GTS + BLEED);
          }
        }
      }
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
    const prev = ctx.globalAlpha;
    if (alpha !== 1) ctx.globalAlpha = prev * alpha;

    // Authored occluder tile — drawn from the town sheet by id. See _loadAuthored.
    if (p.tile != null) {
      const sheet = this.town;
      if (sheet && sheet.complete) {
        const S = TILE_SRC * 2;
        const prevSmooth = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sheet, (p.tile % TOWN_COLS) * S, ((p.tile / TOWN_COLS) | 0) * S, S, S,
                      p.x, p.y, p.w + BLEED, p.h + BLEED);
        ctx.imageSmoothingEnabled = prevSmooth;
      }
      if (alpha !== 1) ctx.globalAlpha = prev;
      return;
    }

    const def = p.def;
    if (!def.img.complete) { if (alpha !== 1) ctx.globalAlpha = prev; return; }
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
