// Touch-first input.
//
// Left half  = floating virtual joystick (spawns where you press, follows your thumb).
// Right half = dash button (tap anywhere on that half).
//
// Judgment call: firing is automatic with auto-aim at the highest-threat target, and the
// right thumb gets Dash instead of a fire button. A fire button on a bullet-hell auto-
// shooter is busywork; a dash is a real decision. Manual aim is available in Settings
// (right side becomes a second stick) for players who want it.
//
// Multi-touch is tracked by pointerId, so the two thumbs never steal each other's input.

import { clamp } from './math.js';

const DEAD_ZONE = 0.16;
const MAX_RADIUS = 62;      // css px of travel for full deflection

/**
 * How long the action side must be held before it becomes a heavy swing rather than a
 * dash, in milliseconds.
 *
 * Short on purpose. Everything above this is a heavy and everything below is a dash, so
 * the number is simultaneously "how long a heavy takes to commit" and "how long a player
 * can hold the button before losing their dash". 190ms is comfortably longer than a
 * deliberate tap and comfortably shorter than a panic press that turns into a hold.
 */
const HOLD_HEAVY = 190;

export class Input {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.leftHanded = !!opts.leftHanded;
    this.manualAim = !!opts.manualAim;

    // Movement axis, -1..1, already dead-zoned and magnitude-clamped.
    this.moveX = 0; this.moveY = 0; this.moveMag = 0;
    // Aim axis (manual mode only).
    this.aimX = 0; this.aimY = 0; this.aimMag = 0;

    this.dashPressed = false;   // edge-triggered, cleared by consumeDash()
    this.heavyPressed = false;  // edge-triggered, cleared by consumeHeavy()
    this.hold = null;           // { id, t, fired } while the action side is held
    this.firing = false;        // manual-fire hold state

    this.stick = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
    this.aimStick = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };

    this.keys = new Set();
    this.mouse = { x: 0, y: 0, down: false, inside: false };
    this.usingTouch = false;

    this._bind();
  }

  setOptions({ leftHanded, manualAim }) {
    if (leftHanded !== undefined) this.leftHanded = leftHanded;
    if (manualAim !== undefined) this.manualAim = manualAim;
  }

  /** True if this screen-x belongs to the movement half. */
  _isMoveSide(x) {
    const mid = window.innerWidth / 2;
    return this.leftHanded ? x > mid : x < mid;
  }

  _bind() {
    const el = this.canvas;
    const opts = { passive: false };

    el.addEventListener('pointerdown', (e) => this._onDown(e), opts);
    el.addEventListener('pointermove', (e) => this._onMove(e), opts);
    el.addEventListener('pointerup', (e) => this._onUp(e), opts);
    el.addEventListener('pointercancel', (e) => this._onUp(e), opts);
    el.addEventListener('pointerleave', (e) => this._onUp(e), opts);

    // Belt-and-braces against iOS double-tap zoom / long-press callout over the canvas.
    el.addEventListener('touchstart', (e) => e.preventDefault(), opts);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('gesturestart', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'ShiftLeft') { this.dashPressed = true; e.preventDefault(); }
      // Desktop gets the heavy on its own key rather than on a hold: a keyboard has spare
      // keys, and there is no reason to make a mouse-and-keyboard player wait 190ms for
      // something a touch player only waits for because their thumb has one zone.
      if (e.code === 'KeyE' || e.code === 'KeyF') { this.heavyPressed = true; e.preventDefault(); }
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this._resetSticks(); });
  }

  _resetSticks() {
    this.stick.active = false; this.stick.id = -1;
    this.aimStick.active = false; this.aimStick.id = -1;
    this.moveX = this.moveY = this.moveMag = 0;
    this.aimX = this.aimY = this.aimMag = 0;
    this.firing = false;
  }

  _onDown(e) {
    if (e.pointerType === 'touch') this.usingTouch = true;
    if (e.pointerType === 'mouse') {
      this.mouse.down = true; this.mouse.inside = true;
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      this.firing = true;
      return; // desktop steers with keys, aims with the cursor — no on-screen stick
    }
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();

    if (this._isMoveSide(e.clientX) && !this.stick.active) {
      const s = this.stick;
      s.active = true; s.id = e.pointerId;
      s.ox = s.x = e.clientX; s.oy = s.y = e.clientY;
    } else if (this.manualAim && !this.aimStick.active) {
      const s = this.aimStick;
      s.active = true; s.id = e.pointerId;
      s.ox = s.x = e.clientX; s.oy = s.y = e.clientY;
      this.firing = true;
    } else if (!this.manualAim) {
      // Action side. Tap = dash, hold = heavy swing. See the note on HOLD_HEAVY.
      //
      // Dash cannot fire here, on the press, or every heavy would dash first: the two
      // actions share one zone, and the only thing that tells them apart is how long the
      // finger stays down. So the press just starts a clock.
      this.hold = { id: e.pointerId, t: performance.now(), fired: false };
    }
  }

  _onMove(e) {
    if (e.pointerType === 'mouse') {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.inside = true;
      return;
    }
    e.preventDefault();
    if (this.stick.active && e.pointerId === this.stick.id) {
      this.stick.x = e.clientX; this.stick.y = e.clientY;
    } else if (this.aimStick.active && e.pointerId === this.aimStick.id) {
      this.aimStick.x = e.clientX; this.aimStick.y = e.clientY;
    }
  }

  _onUp(e) {
    if (e.pointerType === 'mouse') { this.mouse.down = false; this.firing = false; return; }
    if (this.stick.active && e.pointerId === this.stick.id) {
      this.stick.active = false; this.stick.id = -1;
      this.moveX = this.moveY = this.moveMag = 0;
    }
    if (this.aimStick.id === e.pointerId) {
      this.aimStick.active = false; this.aimStick.id = -1;
      this.aimX = this.aimY = this.aimMag = 0;
      this.firing = false;
    }
    // Released the action side: if the heavy hadn't already fired, this was a tap.
    if (this.hold && this.hold.id === e.pointerId) {
      if (!this.hold.fired) this.dashPressed = true;
      this.hold = null;
    }
  }

  /**
   * Promote a held press into a heavy swing, without waiting for release.
   *
   * Called from update(), so the heavy lands the instant the threshold passes and the
   * player feels the button commit under their thumb rather than on lift-off.
   *
   * The cost of this scheme, stated plainly: a tapped dash now fires when the finger
   * lifts, not when it lands, so it carries whatever the player's own tap duration is —
   * typically 60-100ms. Dash is the panic button and that latency is the one thing here
   * worth watching. HOLD_HEAVY is deliberately short to keep it small.
   */
  _pollHold() {
    const h = this.hold;
    if (!h || h.fired) return;
    if (performance.now() - h.t >= HOLD_HEAVY) {
      h.fired = true;
      this.heavyPressed = true;
    }
  }

  /** Resolve one stick's raw offset into a dead-zoned, clamped axis pair. */
  static _axis(s) {
    const dx = s.x - s.ox, dy = s.y - s.oy;
    const len = Math.hypot(dx, dy);
    if (len < 0.0001) return [0, 0, 0];
    let mag = clamp(len / MAX_RADIUS, 0, 1);
    if (mag < DEAD_ZONE) return [0, 0, 0];
    // Rescale past the dead zone so the first responsive pixel maps to a small speed,
    // not a jump to 16%.
    mag = (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
    return [(dx / len) * mag, (dy / len) * mag, mag];
  }

  /** Call once per frame before reading axes. */
  update() {
    this._pollHold();
    if (this.stick.active) {
      const [x, y, m] = Input._axis(this.stick);
      this.moveX = x; this.moveY = y; this.moveMag = m;
      // Let the origin trail the thumb once it exceeds max travel, so long drags
      // don't pin the stick and the player can re-centre without lifting.
      const dx = this.stick.x - this.stick.ox, dy = this.stick.y - this.stick.oy;
      const len = Math.hypot(dx, dy);
      if (len > MAX_RADIUS) {
        this.stick.ox = this.stick.x - (dx / len) * MAX_RADIUS;
        this.stick.oy = this.stick.y - (dy / len) * MAX_RADIUS;
      }
    } else if (!this.usingTouch) {
      // Keyboard fallback.
      let kx = 0, ky = 0;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) kx -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) kx += 1;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) ky -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) ky += 1;
      const len = Math.hypot(kx, ky);
      if (len > 0) { this.moveX = kx / len; this.moveY = ky / len; this.moveMag = 1; }
      else { this.moveX = this.moveY = this.moveMag = 0; }
    }

    if (this.aimStick.active) {
      const [x, y, m] = Input._axis(this.aimStick);
      this.aimX = x; this.aimY = y; this.aimMag = m;
    }
  }

  /** Edge-triggered read; returns true once per press. */
  consumeDash() {
    if (this.dashPressed) { this.dashPressed = false; return true; }
    return false;
  }

  /** Edge-triggered read for the held heavy swing. */
  consumeHeavy() {
    if (this.heavyPressed) { this.heavyPressed = false; return true; }
    return false;
  }

  /** Renderer needs this to draw the stick ring. Returns null when idle. */
  stickVisual() {
    if (!this.stick.active) return null;
    const dx = this.stick.x - this.stick.ox, dy = this.stick.y - this.stick.oy;
    const len = Math.hypot(dx, dy);
    const k = len > MAX_RADIUS ? MAX_RADIUS / len : 1;
    return { ox: this.stick.ox, oy: this.stick.oy, kx: this.stick.ox + dx * k, ky: this.stick.oy + dy * k, r: MAX_RADIUS };
  }
}
