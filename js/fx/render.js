// Canvas 2D renderer.
//
// This pipeline used to be a fake-HDR bloom rig built for glowing vector shapes on a
// near-black void. The game is now lit pixel art on a village ground plane, and that
// changes what the post chain is for. Two things were retuned hard:
//
// **Bloom is now gated by a bright pass.** Before, the whole scene was downsampled,
// blurred and added back at 0.52 alpha. Against a black arena that only lifted the
// emissive shapes, because everything else was already near zero — the README's note
// about 0.78 washing the far corners from ~(12,7,5) to ~(106,50,42) is exactly that
// effect getting out of hand. Against a lit ground plane *everything* is mid-grey, so a
// flat full-frame bloom lifts the grass, the houses and the survivor's face equally and
// the pixel art turns to fog. The fix is a genuine bright pass: the downsampled scene is
// multiplied by itself, which squares every channel. A grass tile at 0.45 falls to 0.20;
// a muzzle spark at 0.98 stays at 0.96. Only things that were already close to white
// survive, so bloom can be raised (0.62) and still only touches sparks, bile, salvage
// motes and the lantern — which is what the brief meant by gating it to emissive things.
//
// **A darkness pass replaced the void.** The frame is now covered by a dark wash with a
// soft hole punched around the survivor's lantern. Its opacity and radius come from the
// night phase (see palette.js), so DUSK is a blue haze and THE LONG DARK is a keyhole.
// This is what a full-frame bloom used to be doing badly: giving the picture a mood.
//
// Pipeline per frame:
//   1. clear to the phase's night colour
//   2. world: ground plane, depth-sorted characters and props (source-over), then the
//      genuinely emissive layer (additive)
//   3. bright-pass bloom
//   4. chromatic aberration (only when juice.chroma is live)
//   5. darkness + lantern, damage vignette, flash
//
// `ctx.filter` is the fast path for the blur. Where it's missing (older WebKit) we fall
// back to a 5-tap offset accumulation, which is blurrier and cheaper — acceptable.

import { rgba, HAZARD_RGB } from '../game/palette.js';
import { TAU, clamp } from '../core/math.js';
import { P_SPARK, P_DOT, P_RING, P_SHARD, P_MOTE, P_TEXT } from './particles.js';

const MAX_DPR = 2;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    // brightCanvas holds the squared bright pass; bloomCanvas the blurred copy of it;
    // chromaCanvas the per-channel offset copies. All quarter-res, so the extra buffer
    // costs a few hundred KB and saves a full-res blur.
    this.brightCanvas = document.createElement('canvas');
    this.brightCtx = this.brightCanvas.getContext('2d');
    this.bloomCanvas = document.createElement('canvas');
    this.bloomCtx = this.bloomCanvas.getContext('2d');
    this.chromaCanvas = document.createElement('canvas');
    this.chromaCtx = this.chromaCanvas.getContext('2d');

    // World-space lantern, set by Run.draw each frame and consumed by _darkness().
    this.lightX = 0; this.lightY = 0; this.lightR = 520;

    // Pre-rendered sprites, keyed by quantised colour. See _glowSprite / _polySprite.
    this._glowCache = new Map();
    this._polyCache = new Map();

    this.supportsFilter = typeof this.bloomCtx.filter === 'string';
    this.quality = 'high';   // high | low
    this.bloomDiv = 4;

    this.camX = 0; this.camY = 0;
    this.baseScale = 1;
    // Slow danger zoom, driven by updateCamera(). Kept as a multiplier on baseScale
    // rather than a separate transform so that viewW/viewH — and therefore the camera
    // clamping and the grid's draw extents — stay consistent with what's on screen.
    this.zoomBias = 1;
    this.w = 0; this.h = 0;      // css px
    this.dpr = 1;

    this.resize();
  }

  setQuality(q) {
    this.quality = q;
    this.bloomDiv = q === 'high' ? 4 : 6;
    this.resize();
  }

  resize() {
    // A resize event can fire while the viewport still reports 0 — mid orientation
    // change, or on a backgrounded tab. Without the clamp the canvas becomes 0x0 and
    // the next bloom pass throws InvalidStateError on drawImage with an empty source,
    // killing the render loop for good.
    const cssW = Math.max(1, window.innerWidth || 1);
    const cssH = Math.max(1, window.innerHeight || 1);
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'low' ? 1.5 : MAX_DPR);
    this.w = cssW; this.h = cssH; this.dpr = dpr;

    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    const bw = Math.max(1, Math.round(this.canvas.width / this.bloomDiv));
    const bh = Math.max(1, Math.round(this.canvas.height / this.bloomDiv));
    this.brightCanvas.width = bw; this.brightCanvas.height = bh;
    this.bloomCanvas.width = bw; this.bloomCanvas.height = bh;
    this.chromaCanvas.width = bw; this.chromaCanvas.height = bh;

    // World-units-visible: keeps the player a consistent physical size across devices.
    const minDim = Math.min(cssW, cssH);
    this.baseScale = clamp(minDim / 480, 0.5, 1.7);

    this._vignette = null;
    this._dmgVignette = null;
  }

  /**
   * World -> screen, for placing DOM elements over the canvas (the voice speech-bubble
   * and its tail).
   *
   * Bug this fixes: this used to ignore juice's screen-shake offset, zoom-punch and
   * rotation, while the actual face/hull render pass (begin() / withWorldTransform())
   * applies all three. The DOM bubble and the canvas face were computed from two
   * different transforms that only agreed when juice was fully at rest — the instant
   * any shake kicked in (getting hit, a kill, even ordinary weapon recoil), the two
   * positions diverged. The bubble has a solid dark background, so when it drifted onto
   * the player it visually blotted out the eyes. Now it takes the same `juice` used for
   * begin()/withWorldTransform() and applies the identical transform, so the two can
   * never disagree.
   */
  worldToScreen(wx, wy, juice, out = {}) {
    const z = this.scale * juice.zoom;
    // Rotate the world offset by juice.rot before scaling — must match begin()'s
    // ctx.rotate(juice.rot) applied before ctx.scale(), or the two paths diverge again
    // the moment shake introduces any rotation.
    const dx = wx - this.camX, dy = wy - this.camY;
    const cos = Math.cos(juice.rot), sin = Math.sin(juice.rot);
    const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
    out.x = rx * z + juice.ox + this.w / 2;
    out.y = ry * z + juice.oy + this.h / 2;
    return out;
  }

  /** Effective world->screen scale, including the slow danger zoom. */
  get scale() { return this.baseScale * this.zoomBias; }

  /** Cheap world-space frustum test, with `pad` world units of slack. */
  inView(wx, wy, pad = 0) {
    const hw = this.viewW / 2 + pad, hh = this.viewH / 2 + pad;
    return Math.abs(wx - this.camX) <= hw && Math.abs(wy - this.camY) <= hh;
  }

  get viewW() { return this.w / this.scale; }
  get viewH() { return this.h / this.scale; }

  /**
   * Follow the player, clamped so the camera never shows outside the arena.
   *
   * @param {number} intensity 0..1 danger level; drives a slow zoom-in so the frame
   *   tightens as things get hairy. Separate from juice.zoom, which is the sharp
   *   per-impact punch — this is the slow one you feel rather than see.
   */
  updateCamera(targetX, targetY, arena, dt, lead = { x: 0, y: 0 }, intensity = 0) {
    const vw = this.viewW, vh = this.viewH;

    // Very slow lissajous drift. Amplitude is a few world units — far too small to
    // fight the player for control of the framing, but enough that a held-still camera
    // never looks frozen. Two incommensurate periods so it doesn't visibly loop.
    this._driftT = (this._driftT || 0) + dt;
    const dxDrift = Math.sin(this._driftT * 0.23) * 7 + Math.sin(this._driftT * 0.61) * 2.5;
    const dyDrift = Math.cos(this._driftT * 0.19) * 6 + Math.cos(this._driftT * 0.47) * 2.0;

    let tx = targetX + lead.x + dxDrift, ty = targetY + lead.y + dyDrift;

    if (arena.w > vw) tx = clamp(tx, arena.x + vw / 2, arena.x + arena.w - vw / 2);
    else tx = arena.x + arena.w / 2;
    if (arena.h > vh) ty = clamp(ty, arena.y + vh / 2, arena.y + arena.h - vh / 2);
    else ty = arena.y + arena.h / 2;

    const k = 1 - Math.exp(-9 * dt);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;

    // Danger zoom: up to +6% at full intensity, eased over ~2s so it never snaps.
    // Applied to `scale` via zoomBias, which resize() re-reads.
    const wantBias = 1 + intensity * 0.06;
    this.zoomBias += (wantBias - this.zoomBias) * (1 - Math.exp(-0.9 * dt));
  }

  snapCamera(x, y) { this.camX = x; this.camY = y; }

  // ------------------------------------------------------------------ frame

  /** Self-heal if a bogus resize left us sized to something the viewport isn't. */
  syncSize() {
    const w = Math.max(1, window.innerWidth || 1);
    const h = Math.max(1, window.innerHeight || 1);
    if (w !== this.w || h !== this.h) this.resize();
  }

  /**
   * Re-applies the exact camera/shake/zoom transform begin() used, without touching
   * the background or compositing state, then hands the context to `fn` and restores.
   *
   * Exists so a caller can draw something in world coordinates that lands in the
   * right place on screen but *after* end() has already run the bloom/chroma/vignette
   * pipeline — e.g. the player's face, which needs to track the hull exactly but must
   * not be smeared by the full-scene blur bloom does. Call after end(), not between
   * begin()/end(); this only sets the transform, it doesn't clear or composite.
   */
  withWorldTransform(juice, fn) {
    const ctx = this.ctx;
    ctx.save();
    this._applyWorldTransform(juice);
    fn(ctx);
    ctx.restore();
  }

  /**
   * Sets the camera/shake/zoom transform from scratch (resets any existing transform
   * first). Single source of truth — begin(), withWorldTransform() and the background
   * pass all route through here, so they can't drift apart the way worldToScreen()
   * once did.
   */
  _applyWorldTransform(juice) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const z = this.scale * juice.zoom;
    const s = z * this.dpr;
    ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
    ctx.rotate(juice.rot);
    ctx.scale(s, s);

    // Snap the camera to whole *device* pixels.
    //
    // The world scale is a continuous float (viewport/480, ~1.24 here), the ground is
    // nearest-neighbour pixel art, and the camera eases toward the player with an
    // exponential, so camX lands on a different fraction of a pixel every single frame.
    // At that point a source texel covers a non-integer number of device pixels and
    // *which* texels get doubled or dropped changes per frame — the whole ground
    // shimmers while you move and is rock steady when you stop. Rounding the translation
    // in device space pins that pattern in place: the map still scrolls smoothly, it just
    // scrolls in whole pixels, which is what pixel art requires.
    //
    // Rotation is left out of the snap deliberately — juice.rot is only non-zero during
    // a hit shake, where the frame is meant to be violent and a sub-pixel offset is not
    // what anyone is looking at.
    const tx = -this.camX + juice.ox / z;
    const ty = -this.camY + juice.oy / z;
    ctx.translate(Math.round(tx * s) / s, Math.round(ty * s) / s);
  }

  begin(palette, juice) {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    // Stashed so drawBackground() can restore the world transform after its
    // screen-space ambient wash without needing juice threaded through every caller.
    this._lastJuice = juice;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.css.bg;
    ctx.fillRect(0, 0, width, height);

    this._applyWorldTransform(juice);
  }

  /** World-space lantern position + reach for the darkness pass. */
  setLight(x, y, radius) { this.lightX = x; this.lightY = y; this.lightR = radius; }

  end(palette, juice) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    this._bloom(juice);
    if (this.quality === 'high' && juice.chroma > 0.015) this._chroma(juice);

    this._darkness(palette, juice);
    this._vignettes(palette, juice);

    // Damage flash. This runs *after* the darkness pass, so nothing attenuates it — and
    // a full-white additive fill inherited from the neon original blew a night scene
    // sitting around luminance 15 up to 87, six times its own baseline, several times a
    // second. Measured, not guessed: it is the single thing that reads as the screen
    // flickering once the tiers get dark.
    //
    // Two corrections. It scales *down* as the night deepens, because a dark-adapted eye
    // needs less absolute light for the same perceived punch, not the same amount. And
    // it's warm rather than pure white, so a hit reads as blood and muzzle rather than a
    // camera fault.
    if (juice.flash > 0.004) {
      const nightAtten = 1 - (palette.night ?? 0) * 0.55;
      const a = juice.flash * 0.55 * nightAtten;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,238,224,${a})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /**
   * Bright-pass bloom.
   *
   * The bright pass is the whole point. `multiply` a downsampled copy of the scene by
   * itself and every channel is squared: mid-tones (the ground plane, the houses, a
   * zombie's coat) collapse toward black, and only things already near 1.0 survive with
   * their brightness intact. That's a real threshold without needing a shader or a
   * per-pixel loop — two extra scaled blits.
   *
   * Because the source is now genuinely sparse, the composite alpha can go *up* rather
   * than down: the emissive layer blooms harder than it ever did, and the pixel art
   * underneath is untouched.
   */
  _bloom(juice) {
    const br = this.brightCtx, brc = this.brightCanvas;
    const b = this.bloomCtx, bc = this.bloomCanvas;
    const bw = bc.width, bh = bc.height;

    br.setTransform(1, 0, 0, 1, 0, 0);
    br.globalAlpha = 1;
    br.globalCompositeOperation = 'source-over';
    br.clearRect(0, 0, bw, bh);
    br.drawImage(this.canvas, 0, 0, bw, bh);
    br.globalCompositeOperation = 'multiply';
    br.drawImage(this.canvas, 0, 0, bw, bh);
    br.drawImage(this.canvas, 0, 0, bw, bh);   // cubed: x^3, not x^2
    br.globalCompositeOperation = 'source-over';

    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'source-over';
    b.globalAlpha = 1;
    b.clearRect(0, 0, bw, bh);

    if (this.supportsFilter) {
      b.filter = `blur(${this.quality === 'high' ? 3.0 : 2.0}px)`;
      b.drawImage(brc, 0, 0);
      b.filter = 'none';
    } else {
      // 5-tap cross. Cheap, and after the 4x downsample it's close enough.
      b.globalAlpha = 0.28;
      const o = 1.4;
      b.drawImage(brc, 0, 0);
      b.drawImage(brc, -o, 0);
      b.drawImage(brc, o, 0);
      b.drawImage(brc, 0, -o);
      b.drawImage(brc, 0, o);
      b.globalAlpha = 1;
    }

    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = this.quality === 'high' ? 0.42 : 0.34;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bc, 0, 0, this.canvas.width, this.canvas.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** RGB split, driven off the (already blurred) bloom buffer so it stays cheap. */
  _chroma(juice) {
    const c = this.chromaCtx, cc = this.chromaCanvas;
    const cw = cc.width, ch = cc.height;
    const ctx = this.ctx;
    const off = juice.chroma * this.canvas.width * 0.006;

    for (const [tint, dx] of [['#ff0000', off], ['#00ffff', -off]]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
      c.clearRect(0, 0, cw, ch);
      c.drawImage(this.bloomCanvas, 0, 0);
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = tint;
      c.fillRect(0, 0, cw, ch);
      // Re-mask to the source alpha so the tint doesn't fill the empty void.
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(this.bloomCanvas, 0, 0);

      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = juice.chroma * 0.55;
      ctx.drawImage(cc, dx, 0, this.canvas.width, this.canvas.height);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Night, and the light you carry.
   *
   * A pre-rendered soft-edged mask is blitted over the survivor and the four regions
   * outside it are flooded flat. Building the gradient once and reusing it means the
   * whole pass is one drawImage plus four fillRects, with no per-frame gradient
   * allocation — the same rule the glow sprites follow, for the same reason.
   *
   * The mask is drawn with the phase's night colour rather than pure black. Absolute
   * black reads as a rendering failure; a very dark blue reads as three in the morning.
   */
  _darkness(palette, juice) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const strength = palette.night ?? 0.6;
    if (strength <= 0.01) return;

    if (!this._lightMask) {
      const S = 512;
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g2 = c.getContext('2d');
      const g = g2.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      // Flat and clear out to a third of the radius, then a long soft falloff. A linear
      // ramp reads as a spotlight cut-out; this reads as a lantern.
      // Not fully transparent even at the centre: a lantern lights the ground in front
      // of you, it does not restore daylight. A hard zero here made the lit disc read as
      // a hole cut in the night rather than as light falling on a village.
      g.addColorStop(0.00, 'rgba(0,0,0,0.16)');
      g.addColorStop(0.34, 'rgba(0,0,0,0.26)');
      g.addColorStop(0.58, 'rgba(0,0,0,0.56)');
      g.addColorStop(0.80, 'rgba(0,0,0,0.84)');
      g.addColorStop(1.00, 'rgba(0,0,0,1)');
      g2.fillStyle = g;
      g2.fillRect(0, 0, S, S);
      this._lightMask = c;
    }

    const p = this.worldToScreen(this.lightX, this.lightY, juice, this._lightPt || (this._lightPt = {}));
    const px = p.x * this.dpr, py = p.y * this.dpr;
    const rad = (palette.lightR ?? 520) * this.scale * juice.zoom * this.dpr;

    // The mask and the surround must be the *same* colour or the mask's bounding box
    // becomes visible as a hard-edged square around the survivor. An earlier version
    // filled the surround with the phase's night colour and drew the mask in black, and
    // at THE LONG DARK's opacity that mismatch drew a literal rectangle on screen. Both
    // are black now; the phase's hue is applied afterwards as one flat pass over the
    // whole frame, which cannot produce a seam because it has no edges.
    // The box is snapped to whole pixels, and that is not cosmetic — it is the whole
    // reason this pass stopped drawing a box on screen.
    //
    // The surround and the mask are two separate layers that meet along this rectangle.
    // With fractional edges, the boundary pixel gets *partial* coverage from both: the
    // fill antialiases to ~60% of it and the mask covers the other ~40%. Source-over does
    // not add, it composites — a then b lands on `a + b - ab`, not `a + b`. At THE LONG
    // DARK's 0.78 that seam pixel resolves to ~0.63 instead of 0.78, i.e. *lighter than
    // the darkness on either side of it*: a bright hairline down each edge of the box.
    // Worse, `l` and `r` shift by a fraction of a pixel every frame as the survivor
    // moves, so the hairline's intensity churns frame to frame — which is what read as
    // the screen flickering while walking and being steady while standing still.
    //
    // Integer edges make the two layers abut exactly. Every pixel belongs to the fill or
    // to the mask, never to both, so there is no blended seam left to shimmer.
    const l = Math.round(px - rad), t = Math.round(py - rad);
    const r = Math.round(px + rad), b = Math.round(py + rad);
    ctx.globalAlpha = strength;
    ctx.fillStyle = '#000';
    if (t > 0) ctx.fillRect(0, 0, W, Math.min(H, t));
    if (b < H) ctx.fillRect(0, Math.max(0, b), W, H - Math.max(0, b));
    const yTop = Math.max(0, t), yBot = Math.min(H, b);
    if (l > 0) ctx.fillRect(0, yTop, Math.min(W, l), yBot - yTop);
    if (r < W) ctx.fillRect(Math.max(0, r), yTop, W - Math.max(0, r), yBot - yTop);
    // Sized from the snapped corners, not from rad*2, so the mask lands exactly on the
    // rectangle the fills were cut around — a half-pixel disagreement here would put the
    // seam straight back.
    ctx.drawImage(this._lightMask, l, t, r - l, b - t);

    // Moonlight cast. Cheap, uniform, and it stops the unlit village from reading as an
    // absence of rendering rather than as darkness.
    const n = palette.nightRgb || [4, 6, 12];
    ctx.globalAlpha = strength * 0.34;
    ctx.fillStyle = `rgb(${n[0]},${n[1]},${n[2]})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  _vignettes(palette, juice) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    if (!this._vignette) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.30, W / 2, H / 2, Math.max(W, H) * 0.66);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.7, 'rgba(0,0,0,0.24)');
      g.addColorStop(1, 'rgba(0,0,0,0.72)');
      this._vignette = g;
    }
    ctx.fillStyle = this._vignette;
    ctx.fillRect(0, 0, W, H);

    if (juice.vignettePulse > 0.004) {
      // Built once and modulated with globalAlpha — creating this gradient per frame
      // meant allocating one on every frame of every hit reaction.
      if (!this._dmgVignette) {
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.18, W / 2, H / 2, Math.max(W, H) * 0.62);
        // Pulled down from 0.62 and darkened toward blood rather than signal-red. On a
        // black arena this pass had nothing to wash out; over a lit village, taking hits
        // in a crowd means it is up almost continuously, and at the old strength it
        // flooded the whole frame and hid the thing that was hitting you.
        g.addColorStop(0, 'rgba(190,20,40,0)');
        g.addColorStop(0.55, 'rgba(180,18,36,0.10)');
        g.addColorStop(1, 'rgba(170,16,34,0.40)');
        this._dmgVignette = g;
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = juice.vignettePulse;
      ctx.fillStyle = this._dmgVignette;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ------------------------------------------------------------ background

  /**
   * The world beyond the village edge.
   *
   * The parallax neon grid and the glowing containment brackets that used to live here
   * are gone — they were the arena's floor, and the arena now has a real one made of
   * tiles. What's left is the honest problem the border still has: the tile map stops,
   * and something has to be on the other side of it. That something is unlit ground, so
   * the outside is simply flooded with the phase's night colour at full strength, which
   * reads as woods too dark to walk into rather than as the edge of the map.
   */
  drawEdges(palette, a) {
    const ctx = this.ctx;
    const vw = this.viewW, vh = this.viewH;
    const l = this.camX - vw, r = this.camX + vw;
    const t = this.camY - vh, b = this.camY + vh;
    ctx.fillStyle = rgba(palette.nightRgb, 0.97);
    if (a.x > l) ctx.fillRect(l, t, a.x - l, b - t);
    if (a.x + a.w < r) ctx.fillRect(a.x + a.w, t, r - (a.x + a.w), b - t);
    if (a.y > t) ctx.fillRect(a.x, t, a.w, a.y - t);
    if (a.y + a.h < b) ctx.fillRect(a.x, a.y + a.h, a.w, b - (a.y + a.h));
  }

  // ------------------------------------------------------- shape primitives
  //
  // Every emissive shape goes through the same 2-pass treatment. `intensity` scales
  // the core brightness — used for flash-on-hit without allocating new colours.

  polyPath(ctx, x, y, r, sides, rot) {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * TAU;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /** Stroked emissive polygon. */
  glowPoly(x, y, r, sides, rot, rgb, width = 3, intensity = 1, fillAlpha = 0.08) {
    const ctx = this.ctx;
    this.polyPath(ctx, x, y, r, sides, rot);
    if (fillAlpha > 0) { ctx.fillStyle = rgba(rgb, fillAlpha * intensity); ctx.fill(); }
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(rgb, 0.85 * intensity);
    ctx.stroke();
    ctx.lineWidth = width * 0.36;
    ctx.strokeStyle = `rgba(255,255,255,${0.85 * intensity})`;
    ctx.stroke();
  }

  glowCircle(x, y, r, rgb, width = 3, intensity = 1, fillAlpha = 0.08) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    if (fillAlpha > 0) { ctx.fillStyle = rgba(rgb, fillAlpha * intensity); ctx.fill(); }
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(rgb, 0.85 * intensity);
    ctx.stroke();
    ctx.lineWidth = width * 0.36;
    ctx.strokeStyle = `rgba(255,255,255,${0.85 * intensity})`;
    ctx.stroke();
  }

  /**
   * Pre-rendered soft radial glow, one sprite per colour.
   *
   * This used to build a fresh createRadialGradient on every call. With a few hundred
   * projectiles, pickups and orbs on screen that was ~600 gradient objects allocated and
   * thrown away every frame — the single biggest cost in the renderer and a direct
   * contradiction of the no-allocation-in-hot-loops rule.
   *
   * Colours are quantised to 5 bits per channel so the 2.2s tier cross-fade (which walks
   * the hue continuously) reuses sprites instead of minting a new one per frame. The
   * cache is cleared if it ever grows past a sane bound.
   */
  _glowSprite(rgb) {
    const key = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3);
    let s = this._glowCache.get(key);
    if (s) return s;

    if (this._glowCache.size > 96) this._glowCache.clear();
    const S = 64;
    s = document.createElement('canvas');
    s.width = s.height = S;
    const c = s.getContext('2d');
    // Multi-stop falloff approximating inverse-square, replacing a near-linear 3-stop
    // ramp. A linear alpha ramp is exactly what reads as a flat halo pasted around the
    // shape: it holds too much brightness out at the rim, then stops abruptly. Real
    // light falls off steeply near the source and then trails a long way — which is
    // what these stops describe: steep to ~0.38, then a long low skirt to the edge.
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.00, 'rgba(255,255,255,0.98)');
    g.addColorStop(0.12, 'rgba(255,255,255,0.70)');
    g.addColorStop(0.24, rgba(rgb, 0.76));
    g.addColorStop(0.38, rgba(rgb, 0.40));
    g.addColorStop(0.55, rgba(rgb, 0.17));
    g.addColorStop(0.74, rgba(rgb, 0.055));
    g.addColorStop(1.00, rgba(rgb, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
    this._glowCache.set(key, s);
    return s;
  }

  /**
   * Pre-rendered emissive polygon sprite (glow + saturated edge + white core baked in).
   *
   * For objects that appear in the hundreds and never change size — enemy bullets above
   * all — this collapses a fill plus two strokes plus a gradient orb into one drawImage.
   * Path stroking is the single most expensive thing in the entity pass, so trading
   * per-instance rotation for a static sprite is a good deal on the bullets; enemies
   * keep the real path renderer because their rotation is a readability cue.
   */
  _polySprite(sides, rgb) {
    const key = `${sides}:${(rgb[0] >> 3)},${(rgb[1] >> 3)},${(rgb[2] >> 3)}`;
    let s = this._polyCache.get(key);
    if (s) return s;
    if (this._polyCache.size > 48) this._polyCache.clear();

    const S = 64, c0 = S / 2, rad = S * 0.24;
    s = document.createElement('canvas');
    s.width = s.height = S;
    const c = s.getContext('2d');

    const g = c.createRadialGradient(c0, c0, 0, c0, c0, c0);
    g.addColorStop(0, rgba(rgb, 0.55));
    g.addColorStop(1, rgba(rgb, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);

    c.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + (i / sides) * TAU;
      const px = c0 + Math.cos(a) * rad, py = c0 + Math.sin(a) * rad;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
    c.fillStyle = rgba(rgb, 0.35);
    c.fill();
    c.lineJoin = 'round';
    c.lineWidth = 4;
    c.strokeStyle = rgba(rgb, 0.9);
    c.stroke();
    c.lineWidth = 1.6;
    c.strokeStyle = 'rgba(255,255,255,0.95)';
    c.stroke();

    this._polyCache.set(key, s);
    return s;
  }

  /** Draws a _polySprite centred at x,y with the given world radius. */
  spritePoly(x, y, r, sides, rgb, intensity = 1) {
    const s = this._polySprite(sides, rgb);
    const ctx = this.ctx;
    // The sprite's polygon radius is 0.24 of the sheet, so drawing the sheet at
    // r / 0.24 across makes `r` mean the same thing it does for glowPoly.
    const half = r / 0.48;
    if (intensity !== 1) ctx.globalAlpha = intensity;
    ctx.drawImage(s, x - half, y - half, half * 2, half * 2);
    if (intensity !== 1) ctx.globalAlpha = 1;
  }

  /** Soft filled orb — used for the player core, pickups, projectile heads. */
  glowOrb(x, y, r, rgb, intensity = 1) {
    const ctx = this.ctx;
    const s = this._glowSprite(rgb);
    if (intensity !== 1) ctx.globalAlpha = intensity;
    ctx.drawImage(s, x - r, y - r, r * 2, r * 2);
    if (intensity !== 1) ctx.globalAlpha = 1;
  }

  glowArc(x, y, r, from, to, rgb, width, intensity = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, from, to);
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(rgb, 0.85 * intensity);
    ctx.stroke();
    ctx.lineWidth = width * 0.4;
    ctx.strokeStyle = `rgba(255,255,255,${0.8 * intensity})`;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /** Motion-stretched projectile: a capsule aligned to velocity. */
  glowStreak(x, y, dx, dy, len, width, rgb, intensity = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.lineTo(0, 0);
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(rgb, 0.7 * intensity);
    ctx.stroke();
    ctx.lineWidth = width * 0.42;
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * intensity})`;
    ctx.stroke();
    ctx.restore();
    ctx.lineCap = 'butt';
  }

  /**
   * An arrow in flight: a shaft, a triangular head at the leading edge, and a small V
   * fletching at the tail. `glowStreak` (above) was doing duty for every player
   * projectile, arrows included — a thick round-capped line with a bright core, which is
   * exactly right for an energy bolt and reads as a glowing pill for anything with a
   * physical silhouette. An arrow needs an actual point, or it doesn't parse as one at
   * a glance in a crowd.
   *
   * `len` is the *total* visual length, the same budget glowStreak spends on its
   * capsule — the head and fletching are carved out of it, not added on top. The first
   * version added them on top of a streak-sized shaft and came out roughly 70% longer
   * than the projectile it replaced, which read as oversized. `width` scales down hard
   * (0.55x) before touching the head/fletch spread, because an arrow is a fine line with
   * a point, not a thick capsule with a point stuck on the end.
   */
  glowArrow(x, y, dx, dy, len, width, rgb, intensity = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dy, dx));

    const w = width * 0.55;
    const headLen = len * 0.34;
    const headW = w * 1.3;
    const fletchLen = len * 0.16;
    const fletchW = w * 0.9;
    const shaftEnd = -len;   // shaft runs from the tail to the base of the head

    ctx.lineCap = 'butt';

    // Shaft: a plain stroke, no bright core — the point is what should read as "sharp",
    // not the whole shape glowing uniformly.
    ctx.beginPath();
    ctx.moveTo(shaftEnd, 0);
    ctx.lineTo(-headLen * 0.15, 0);
    ctx.lineWidth = Math.max(1, w * 0.4);
    ctx.strokeStyle = rgba(rgb, 0.85 * intensity);
    ctx.stroke();

    // Head: solid triangle at the tip (x=0 is the leading point, matching how
    // glowStreak's `-len..0` convention puts 0 at the direction of travel).
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-headLen, -headW / 2);
    ctx.lineTo(-headLen, headW / 2);
    ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${0.95 * intensity})`;
    ctx.fill();
    ctx.strokeStyle = rgba(rgb, 0.9 * intensity);
    ctx.lineWidth = 1;
    ctx.stroke();

    // Fletching: two small triangles flared out from the tail, one per side.
    ctx.beginPath();
    ctx.moveTo(shaftEnd, 0);
    ctx.lineTo(shaftEnd - fletchLen, -fletchW);
    ctx.lineTo(shaftEnd - fletchLen * 0.4, 0);
    ctx.lineTo(shaftEnd - fletchLen, fletchW);
    ctx.closePath();
    ctx.fillStyle = rgba(rgb, 0.75 * intensity);
    ctx.fill();

    ctx.restore();
  }

  // ------------------------------------------------------------- particles

  drawParticles(particles) {
    const ctx = this.ctx;
    const pool = particles.pool;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    for (let i = 0; i < pool.active; i++) {
      const p = pool.items[i];
      const t = p.kind === P_MOTE ? 1 : p.life / p.maxLife;

      switch (p.kind) {
        case P_SPARK: {
          const a = t * t;
          const sp = Math.hypot(p.vx, p.vy);
          const stretch = Math.min(22, sp * 0.02);
          ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
          ctx.lineWidth = p.size * t;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - (p.vx / (sp || 1)) * stretch, p.y - (p.vy / (sp || 1)) * stretch);
          ctx.stroke();
          break;
        }
        case P_DOT: {
          const a = t * t * 0.9;
          const r = Math.max(0.4, p.size * t);
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
          break;
        }
        case P_MOTE: {
          // Parallax by depth: a far mote (depth -> 1) is pulled back toward the
          // camera centre, so it slides across the screen more slowly than the world
          // does. This is what actually sells the layering — size and alpha alone just
          // look like differently-sized dots on one plane.
          const par = p.depth * 0.55;
          const mx = p.x + (this.camX - p.x) * par;
          const my = p.y + (this.camY - p.y) * par;
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
          ctx.beginPath(); ctx.arc(mx, my, p.size, 0, TAU); ctx.fill();
          break;
        }
        case P_RING: {
          const k = 1 - t;
          const r = p.size + (p.endSize - p.size) * (1 - Math.pow(1 - k, 3));
          ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${t * 0.85})`;
          ctx.lineWidth = Math.max(0.5, p.rot * t);
          ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, r), 0, TAU); ctx.stroke();
          break;
        }
        case P_SHARD: {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          const s = p.size * t * 1.6;
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${t})`;
          ctx.beginPath();
          ctx.moveTo(0, -s); ctx.lineTo(s * 0.86, s * 0.5); ctx.lineTo(-s * 0.86, s * 0.5);
          ctx.closePath(); ctx.fill();
          ctx.restore();
          break;
        }
        case P_TEXT: {
          const a = Math.min(1, t * 2.2);
          ctx.font = `700 ${p.size}px "Rajdhani", system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
          ctx.fillText(p.text, p.x, p.y);
          break;
        }
      }
    }
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
  }

  /** On-screen joystick ring, drawn in screen space after the world pass. */
  drawStick(visual, palette) {
    if (!visual) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(palette.primary, 0.28);
    ctx.beginPath(); ctx.arc(visual.ox, visual.oy, visual.r, 0, TAU); ctx.stroke();
    ctx.fillStyle = rgba(palette.primary, 0.05);
    ctx.fill();
    ctx.strokeStyle = rgba(palette.primary, 0.7);
    ctx.beginPath(); ctx.arc(visual.kx, visual.ky, 24, 0, TAU); ctx.stroke();
    ctx.fillStyle = rgba(palette.primary, 0.18);
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  set globalAlpha(v) { this.ctx.globalAlpha = v; }
}

export { HAZARD_RGB };
