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

const TILE_DEFS = [
  { file: 'GRASS TILE' },                                   // 0
  { file: 'GRASS DETAIL 1' }, { file: 'GRASS DETAIL 2' },
  { file: 'GRASS DETAIL 3' }, { file: 'GRASS DETAIL 4' },
  { file: 'GRASS DETAIL 5' }, { file: 'GRASS DETAIL 6' },   // 1-6
  { file: 'GROUND TILE' },                                  // 7
  { file: 'GROUND DETAIL 1' }, { file: 'GROUND DETAIL 2' },
  { file: 'GROUND DETAIL 3' }, { file: 'GROUND DETAIL 4' },
  { file: 'GROUND DETAIL 5' },                              // 8-12
  { file: 'WATER TILE' },                                   // 13
  { file: 'WATER DETAIL 1', under: 13 }, { file: 'WATER DETAIL 2', under: 13 },
  { file: 'WATER DETAIL 3', under: 13 }, { file: 'WATER DETAIL 4', under: 13 },
  { file: 'WATER DETAIL 5', under: 13 },                    // 14-18
];

const T_GRASS = 0, T_GRASS_D0 = 1, T_GRASS_DN = 6;
const T_DIRT = 7, T_DIRT_D0 = 8, T_DIRT_DN = 12;
const T_WATER = 13, T_WATER_D0 = 14, T_WATER_DN = 18;

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
 * from the neighbour mask. Until that exists, the 16px GRASS/GROUND DETAIL tiles already
 * scatter through the tile map itself and carry the decoration on their own.
 */
const DECAL_DEFS = [];

/**
 * Props. `foot` is the solid footprint as a fraction of the sprite box
 * [left, top, right, bottom] — a house is only solid across its lower storey, so you can
 * walk behind the roof, and a tree is only solid at its trunk.
 */
const PROP_DEFS = {
  house1: { file: 'HOUSE 1', w: 80, h: 112, foot: [0.06, 0.55, 0.94, 0.98] },
  house2: { file: 'HOUSE 2', w: 128, h: 112, foot: [0.08, 0.55, 0.92, 0.98] },
  church: { file: 'CHURCH', w: 128, h: 112, foot: [0.06, 0.55, 0.94, 0.98] },
  tree1:  { file: 'TREE 1', w: 48, h: 48, foot: [0.32, 0.70, 0.68, 0.98] },
  tree2:  { file: 'TREE 2', w: 48, h: 48, foot: [0.32, 0.70, 0.68, 0.98] },
  tree3:  { file: 'TREE 3', w: 48, h: 48, foot: [0.32, 0.70, 0.68, 0.98] },
  fence1: { file: 'FENCE 1', w: 16, h: 16, foot: [0, 0.25, 1, 1] },
  fence2: { file: 'FENCE 2', w: 16, h: 16, foot: [0, 0.25, 1, 1] },
  pit:    { file: 'PIT', w: 32, h: 48, foot: [0.05, 0.35, 0.95, 0.95] },
};

function loadImage(file) {
  const img = new Image();
  img.onerror = () => console.warn('[world] failed to load', file);
  img.src = DIR + file + N;
  return img;
}

/** Lazily built once, shared process-wide. */
let ATLAS = null;
function atlas() {
  if (ATLAS) return ATLAS;
  ATLAS = { tiles: [], decals: [], props: {} };
  for (const d of TILE_DEFS) ATLAS.tiles.push({ img: loadImage(d.file), under: d.under ?? -1 });
  for (const d of DECAL_DEFS) ATLAS.decals.push({ img: loadImage(d.file), w: d.w, h: d.h });
  for (const k in PROP_DEFS) {
    const d = PROP_DEFS[k];
    ATLAS.props[k] = { img: loadImage(d.file), w: d.w, h: d.h, foot: d.foot };
  }
  return ATLAS;
}

/** Every tile file this module can request, for the service worker shell list. */
export function shellAssets() {
  const out = [];
  for (const d of TILE_DEFS) out.push(`./${DIR}${d.file}${N}`);
  for (const d of DECAL_DEFS) out.push(`./${DIR}${d.file}${N}`);
  for (const k in PROP_DEFS) out.push(`./${DIR}${PROP_DEFS[k].file}${N}`);
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
    // The church anchors the square; houses line the two roads. Placement is rejection
    // sampled against the claim map so nothing overlaps a road or another building.
    this._placeProp('church', cx - 2, cy - sqh - 4, rng, true);

    const houseTries = 260;
    let housed = 0;
    for (let i = 0; i < houseTries && housed < 26; i++) {
      const kind = rng.next() < 0.55 ? 'house1' : 'house2';
      const tx = 2 + Math.floor(rng.next() * (cols - 10));
      const ty = 2 + Math.floor(rng.next() * (rows - 10));
      // Want a house *near* a road but not on it — that's what makes it read as a
      // street rather than scattered cabins in a field.
      if (!this._nearClaimed(tx, ty, 5, 4)) continue;
      if (this._placeProp(kind, tx, ty, rng, true)) housed++;
    }

    // Fences and open graves are cut on purpose — they read as clutter at this scale and
    // both are solid, so every one was also a collider the player could snag on. The
    // placement passes are gone rather than commented out; PROP_DEFS still carries the
    // definitions if either is ever wanted back.

    // --- treeline: dense at the arena edge, thinning toward the village ---
    const trees = ['tree1', 'tree2', 'tree3'];
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
  _placeProp(key, tx, ty, rng, strict) {
    const def = this.atlas.props[key];
    const tw = Math.ceil(def.w / TILE_SRC), th = Math.ceil(def.h / TILE_SRC);
    const pad = strict ? 1 : 0;
    if (!this._isFree(tx - pad, ty - pad, tw + pad * 2, th + pad * 2)) return false;

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

  drawPropAt(ctx, i) {
    const p = this.props[i];
    if (p.def.img.complete) ctx.drawImage(p.def.img, p.x, p.y, p.w, p.h);
  }

  propBaseY(i) { return this.props[i].baseY; }
}

export { clamp };
