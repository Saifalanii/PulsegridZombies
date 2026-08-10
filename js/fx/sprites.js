// LPC spritesheet loading, animation state, and blitting.
//
// Everything else in this game used to be drawn procedurally; now the characters are
// real pixel art and this module owns every frame of it.
//
// SHEET GEOMETRY — verified by decoding the alpha channel of the actual PNGs on disk
// (a per-row occupancy scan, not remembered from a spec). Two geometries are in play:
//
//   Standard sheets (`zombie_*.png`, `player_hero_alt.png`) — 832x3456, 13 columns of
//   64x64 frames, 54 rows, laid out in the fixed LPC animation blocks below.
//
//   `player_hero.png` — 1152x4480. The top 3456px are the same 54 rows of 64x64 frames
//   but in a 1152px-wide canvas (18 columns; only the first 13 carry art). The bottom
//   1024px are 8 rows of *128x128* oversized frames, 9 columns, holding the big
//   sword-swing animations — the only frames in the whole asset set where a weapon is
//   actually visible in the character's hands. That is why the player uses this sheet
//   and not the tidier alt one.
//
// Measured occupancy, both geometries:
//   rows  0-3   spellcast   7 frames
//   rows  4-7   thrust      8 frames   (zombie sheets carry a 9th; we use 8)
//   rows  8-11  walk        9 frames
//   rows 12-15  slash       6 frames
//   rows 16-19  shoot      13 frames
//   row  20     hurt        6 frames   ONE row, not four — non-directional, and it
//                                      collapses to a prone body. LPC has no separate
//                                      death animation; this IS the death animation.
//   row  21     climb       6 frames
//   rows 22-25  idle        2 frames
//   rows 26-29  jump        5 frames
//   rows 30-33  sit         3 frames
//   rows 34-37  emote       3 frames
//   rows 38-41  run         8 frames
//   rows 42-45  combat idle 2 frames
//   oversized @ y=3456      4 rows x 9 frames  big overhead sword slash   (128px cells)
//   oversized @ y=3968      4 rows x 6 frames  big sword backslash        (128px cells)
//
//   `player_hero_axe.png` — 1152x4224. Standard 54-row body block on top, and below it a
//   4 rows x 6 frames axe swing in *192px* cells at y=3456. The larger cell is the only
//   thing that makes this sheet look unusual; see `axechop` and drawAnim's big branch.
//
// Direction order within every 4-row block is up, left, down, right.

export const FRAME = 64;
export const BIG_FRAME = 128;

/**
 * The head crop used for menu portraits (HOLT keeps the same identity across every
 * loadout, so this is the single face the UI draws — see Portrait
 * in fx/face.js). Down-facing idle, frame 0: row 22 (idle) + 2 (down is the 3rd of
 * up/left/down/right) = row 24, column 0.
 *
 * Rect found by scanning the decoded PNG's alpha channel for the head's bounding box
 * within the top 36px of that frame (the body starts lower), not eyeballed — it's tight
 * to the cap and collar with 1px of padding on every side.
 */
export const PORTRAIT_HEAD = { row: 24, col: 0, sx: 18, sy: 14, sw: 28, sh: 22 };

export const DIR_UP = 0, DIR_LEFT = 1, DIR_DOWN = 2, DIR_RIGHT = 3;

/**
 * Animation clips. `row` is the first of `dirs` consecutive rows; a clip with dirs=1 is
 * non-directional and always reads from that single row.
 *
 * `big` clips live in the oversized 128px region and are only present on the player
 * sheet — sheets without it fall back (see resolveClip).
 */
export const CLIPS = {
  idle:     { row: 22, frames: 2,  dirs: 4, fps: 2.2, loop: true },
  walk:     { row: 8,  frames: 9,  dirs: 4, fps: 8,   loop: true },
  slash:    { row: 12, frames: 6,  dirs: 4, fps: 12,  loop: false, hit: 0.55 },
  // `thrust` doubles as the bow's draw-and-loose on player_hero_alt.png — see the note
  // above PLAYER_SHEET_BOW in run.js. On every other sheet these same 4 rows are a
  // generic unarmed lunge (used by the Runner/Crawler zombies), which is why the clip
  // itself is weapon-agnostic: what it draws depends entirely on which sheet it's asked
  // to read from.
  thrust:   { row: 4,  frames: 8,  dirs: 4, fps: 12,  loop: false, hit: 0.5 },
  // Frame 0 of the draw, held — the bow equivalent of `swordstand` below: a standing
  // survivor with an empty bow row would be holding nothing, same problem the machete
  // had before `swordcarry` existed.
  bowstand: { row: 4,  frames: 1,  dirs: 4, fps: 1,   loop: true },
  shoot:    { row: 16, frames: 13, dirs: 4, fps: 20,  loop: false, hit: 0.72 },
  spell:    { row: 0,  frames: 7,  dirs: 4, fps: 11,  loop: false, hit: 0.6 },
  // The dash is 0.19s (see Run.update); 5 frames at 26fps is ~0.19s, so the tuck-and-roll
  // finishes right as control returns instead of freezing on frame 4 or looping past it.
  jump:     { row: 26, frames: 5,  dirs: 4, fps: 26,  loop: false },
  hurt:     { row: 20, frames: 6,  dirs: 1, fps: 9,   loop: false },
  // The first three frames of the hurt row only: recoil and hunch, stopping short of
  // the collapse. Taking a hit and dying share art in LPC, so the flinch has to be a
  // truncation of the death or every scratch looks fatal.
  flinch:   { row: 20, frames: 3,  dirs: 1, fps: 11,  loop: false },
  // Oversized, player sheet only. There are two 4-direction blocks down here and they
  // are NOT interchangeable:
  //
  //   y=3456, 9 frames — the weapon *carry*: the blade stays couched against the body
  //                      and the legs cycle. It is a walk-with-sword pose, not a strike.
  //   y=3968, 6 frames — the actual swing: the blade leaves the body and arcs through.
  //
  // Both were previously wired as if they were two different attacks, so the machete
  // "attacked" by walking at things with the blade tucked in. Every strike now reads
  // from the swing block; the carry block is exposed separately for locomotion.
  swordcarry: { big: 3456, frames: 9, dirs: 4, fps: 8,  loop: true },
  // Frame 0 of the carry, held. Standing still can't reuse `swordcarry` itself — that
  // is a walk cycle, and looping it stationary marches the survivor on the spot.
  swordstand: { big: 3456, frames: 1, dirs: 4, fps: 1,  loop: true },
  bigslash:   { big: 3968, frames: 6, dirs: 4, fps: 15, loop: false, hit: 0.5 },
  // Same swing art, wound down — a fire axe is the same motion carrying more mass.
  bigchop:    { big: 3968, frames: 6, dirs: 4, fps: 9,  loop: false, hit: 0.58 },

  // The Fire Axe's own sheet (player_hero_axe.png — see PLAYER_SHEET_AXE in run.js).
  //
  // This block is 192px cells, not 128 — hence `cell`. That is the whole story of this
  // clip: read at the usual BIG_FRAME stride the block looks like a mangled export with
  // blank columns scattered through it, because a 128px grid slices every third 192px
  // cell in half. Scanned on its own stride it is a completely ordinary LPC swing:
  // 4 rows x 6 columns at y=3456, up/left/down/right, all 24 frames substantive.
  //
  // Verified by scanline occupancy on the actual PNG, not assumed — the four rows of
  // content sit at y=3527-3582, 3727-3773, 3919-3974 and 4111-4157, i.e. one band per
  // 192px row starting at 3456. The body occupies the middle 64x64 of each cell, the
  // same convention the 128px blocks use, which is what lets drawAnim handle both from
  // one formula.
  axechop:  { big: 3456, cell: 192, frames: 6, dirs: 4, fps: 9, loop: false, hit: 0.58 },
  // Frame 0 of the swing, held — the axe equivalent of `swordstand`. There is no
  // separate walk-with-axe block on this sheet (the big region is this one animation and
  // nothing else), so the axe shows while standing and the survivor walks with the
  // sheet's body-only walk rows. Same limitation the bow has.
  axestand: { big: 3456, cell: 192, frames: 1, dirs: 4, fps: 1, loop: true },
};

/** Clips that fall back to a standard-geometry equivalent on sheets without big rows. */
const BIG_FALLBACK = {
  bigslash: 'slash', bigchop: 'slash', swordcarry: 'walk', swordstand: 'idle',
  axechop: 'slash', axestand: 'idle',
};

export class LpcSheet {
  /**
   * @param {string} src
   * @param {object} [opts]
   * @param {boolean} [opts.big]  sheet carries the oversized 128px region
   */
  constructor(src, opts = {}) {
    this.ready = false;
    this.big = !!opts.big;
    this.src = src;
    this.img = new Image();
    this.img.onload = () => { this.ready = true; };
    this.img.onerror = () => { console.warn('[sprites] failed to load', src); };
    this.img.src = src;
  }
}

// Shared instance for the portrait system (fx/face.js), which draws before a Run exists
// and so can't reach into Run's own PLAYER_SHEET. Loading the same URL a second time
// here doesn't cost a second download — the browser's HTTP cache (and the service
// worker's SHELL cache) dedupes it — it only costs one small Image/decode object.
export const PORTRAIT_SHEET = new LpcSheet('assets/characters/player_hero_alt.png');

/**
 * The zombie head used for THE BAND's portrait.
 *
 * The rotting sheet rather than the plain green one: at a 28px crop the green zombie
 * reads as a person with an unusual complexion, while this one has enough broken
 * silhouette around the jaw to be unmistakable at portrait size. Same standard LPC
 * geometry as every other sheet, so PORTRAIT_HEAD indexes it unchanged.
 */
export const ZOMBIE_PORTRAIT_SHEET = new LpcSheet('assets/characters/zombie_rotting.png');

/**
 * Draw the portrait head (see PORTRAIT_HEAD) centred at (cx, cy), scaled so its width
 * fills `targetW` CSS px. Caller is responsible for imageSmoothingEnabled = false —
 * portraits share a canvas with other UI that may want smoothing on.
 */
export function drawPortraitHead(ctx, sheet, cx, cy, targetW) {
  if (!sheet.ready) return false;
  const h = PORTRAIT_HEAD;
  const scale = targetW / h.sw;
  const dw = h.sw * scale, dh = h.sh * scale;
  ctx.drawImage(sheet.img,
    h.col * FRAME + h.sx, h.row * FRAME + h.sy, h.sw, h.sh,
    cx - dw / 2, cy - dh / 2, dw, dh);
  return true;
}

/** Snap a movement/facing vector to the nearest of the 4 LPC cardinal directions. */
export function dirFromVector(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return dx >= 0 ? DIR_RIGHT : DIR_LEFT;
  return dy >= 0 ? DIR_DOWN : DIR_UP;
}

/**
 * Per-entity animation state. A plain object so it can live on a pooled entity and be
 * reset in place — nothing here allocates after the pool is built.
 */
export function createAnim() {
  return {
    dir: DIR_DOWN,
    clip: 'idle',
    t: 0,           // seconds into the current clip
    frame: 0,
    locked: false,  // a one-shot clip is playing; locomotion must not override it
    done: false,
    fired: false,   // the clip's hit frame has already been actioned
    speed: 1,       // clip playback rate multiplier
    distAcc: 0,
    idleT: 0,
  };
}

export function resetAnim(a) {
  a.dir = DIR_DOWN; a.clip = 'idle'; a.t = 0; a.frame = 0;
  a.locked = false; a.done = false; a.fired = false; a.speed = 1;
  a.distAcc = 0; a.idleT = 0;
  // Cleared on reset so a loadout change can't leak a weapon pose into the next run.
  a.walkClip = null; a.idleClip = null;
}

/**
 * Start a one-shot clip. `duration` (seconds) stretches the clip to fit — this is how
 * an attack animation is made to land exactly on the frame the damage is applied.
 */
export function playClip(a, clip, duration = 0, dir = -1) {
  const def = CLIPS[clip];
  if (!def) return;
  a.clip = clip;
  a.t = 0;
  a.frame = 0;
  a.done = false;
  a.fired = false;
  a.locked = !def.loop;
  if (dir >= 0) a.dir = dir;
  a.speed = duration > 0 ? (def.frames / def.fps) / duration : 1;
}

/** True once a playing one-shot has passed its designated contact frame. */
export function clipHitReady(a) {
  const def = CLIPS[a.clip];
  if (!def || !def.hit || a.fired) return false;
  const dur = (def.frames / def.fps) / a.speed;
  if (a.t >= dur * def.hit) { a.fired = true; return true; }
  return false;
}

/**
 * Advance an anim. If a one-shot clip is locked in, only that clip advances; otherwise
 * the walk/idle locomotion cycle is driven from the entity's velocity.
 */
export function updateAnim(a, dt, vx, vy) {
  if (a.locked) {
    const def = CLIPS[a.clip];
    a.t += dt * a.speed;
    const per = 1 / def.fps;
    const f = Math.floor(a.t / per);
    if (f >= def.frames) {
      a.frame = def.frames - 1;
      a.done = true;
      a.locked = false;
      a.clip = a.idleClip || 'idle';
      a.t = 0;
    } else {
      a.frame = f;
    }
    return;
  }

  // Locomotion clips are overridable so a survivor holding a blade keeps holding it
  // while walking. The bare `walk`/`idle` rows draw the body only — the weapon lives
  // in the oversized carry block — so without this the machete vanishes between swings.
  const walkClip = a.walkClip || 'walk';
  const idleClip = a.idleClip || 'idle';

  const speed = Math.hypot(vx, vy);
  if (speed > 8) {
    a.dir = dirFromVector(vx, vy);
    a.clip = walkClip;
    // Distance-driven so the cadence matches the actual movement instead of sliding.
    a.distAcc += speed * dt;
    const STEP = 13;
    const nFrames = CLIPS[walkClip].frames;
    if (a.distAcc >= STEP) {
      const steps = Math.floor(a.distAcc / STEP);
      a.frame = (a.frame + steps) % nFrames;
      a.distAcc -= steps * STEP;
    }
    if (a.frame >= nFrames) a.frame = 0;
  } else {
    a.clip = idleClip;
    a.idleT += dt;
    a.frame = Math.floor(a.idleT * CLIPS[idleClip].fps) % CLIPS[idleClip].frames;
  }
}

/** Advance a death/corpse anim that has no owning entity velocity. */
export function updateClipOnly(a, dt) {
  const def = CLIPS[a.clip];
  if (!def) return;
  a.t += dt * a.speed;
  const f = Math.floor(a.t * def.fps);
  if (f >= def.frames) { a.frame = def.frames - 1; a.done = true; }
  else a.frame = f;
}

function resolveClip(sheet, clip) {
  const def = CLIPS[clip];
  if (def && def.big && !sheet.big) return CLIPS[BIG_FALLBACK[clip]] || CLIPS.slash;
  return def || CLIPS.idle;
}

/**
 * Draw one animation frame.
 *
 * `size` is the world height of a *standard* 64px frame. Oversized 128px frames are
 * drawn at 2x that around the same centre, which is exactly how LPC composes them — the
 * character body sits in the middle 64x64 of the 128x128 cell and the extra margin is
 * pure weapon swing.
 *
 * The sprite is anchored so the character's feet land slightly below (x, y): the entity
 * position is its footprint on the ground, not the centre of its bounding box, which is
 * what makes a character read as standing *on* a tile rather than floating over it.
 *
 * @returns {boolean} false if the sheet hasn't decoded yet.
 */
/**
 * Sheets with a colour filter already baked in, keyed by source + filter string.
 *
 * `ctx.filter` is the obvious way to tint a sprite and the wrong one in a crowd. WebKit
 * implements a canvas filter as a separate off-screen compositing pass *per drawImage*,
 * so five filtered enemy types on screen — each drawn twice while flashing — turn into
 * dozens of extra passes every frame. That is a Safari-shaped performance cliff: the
 * simulation stays at 0.04ms and the frame still misses, which is exactly the "fast phone,
 * still lagging" report this came from.
 *
 * Baking the filter into a copy of the sheet once moves that cost to a single pass at
 * first sighting, and every draw afterwards is an ordinary blit. Built lazily, so a run
 * only pays for the enemy types it actually meets: meeting nothing but shamblers costs
 * nothing at all.
 */
const FILTERED = new Map();

function filteredSheet(sheet, filter) {
  const key = sheet.src + '|' + filter;
  if (FILTERED.has(key)) return FILTERED.get(key);
  let out = null;
  try {
    const cv = document.createElement('canvas');
    cv.width = sheet.img.naturalWidth || sheet.img.width;
    cv.height = sheet.img.naturalHeight || sheet.img.height;
    const c = cv.getContext('2d');
    // If the platform can't filter here it can't filter in the draw path either, so the
    // null result below correctly falls back to drawing untinted rather than to ctx.filter.
    c.filter = filter;
    c.drawImage(sheet.img, 0, 0);
    c.filter = 'none';
    out = cv;
  } catch { out = null; }
  FILTERED.set(key, out);
  return out;
}

export function drawAnim(ctx, sheet, a, x, y, size, alpha = 1, filter = null) {
  if (!sheet.ready) return false;
  const def = resolveClip(sheet, a.clip);
  const frame = Math.min(a.frame, def.frames - 1);
  const dir = def.dirs === 1 ? 0 : a.dir;

  const prevAlpha = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha;

  // Tinted sprites blit from a pre-filtered copy of the sheet; see FILTERED. Only if
  // building that copy failed do we fall back to a per-draw ctx.filter.
  let src = sheet.img;
  let liveFilter = null;
  if (filter) {
    const baked = filteredSheet(sheet, filter);
    if (baked) src = baked; else liveFilter = filter;
  }
  if (liveFilter) ctx.filter = liveFilter;

  if (def.big) {
    // Oversized cells come in two sizes (128 for the sword block, 192 for the axe — see
    // `cell` on axechop). Both centre the same 64px body in the cell, so one formula
    // covers them: draw the whole cell at the body's scale, offset by however much
    // margin the cell carries around that body.
    const F = def.cell || BIG_FRAME;
    const scale = size / FRAME;
    const d = F * scale;
    const off = ((F - FRAME) / 2) * scale;
    ctx.drawImage(src,
      frame * F, def.big + dir * F, F, F,
      x - size / 2 - off, y - size * 0.86 - off, d, d);
  } else {
    const F = FRAME;
    ctx.drawImage(src,
      frame * F, (def.row + dir) * F, F, F,
      x - size / 2, y - size * 0.86, size, size);
  }

  if (liveFilter) ctx.filter = 'none';
  if (alpha !== 1) ctx.globalAlpha = prevAlpha;
  return true;
}
