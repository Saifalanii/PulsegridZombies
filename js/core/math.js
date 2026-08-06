// Small math / easing helpers. Kept allocation-free: no vector objects, just scalars.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential approach. `rate` = how much of the gap closes per second. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

// The easing set, dist2, angleDelta/approachAngle and hslToRgbStr were removed in the
// dead-code sweep: nothing had called any of them since the rewrite away from the
// original neon shooter, where the tweened UI and the angular steering lived. Angles are
// now wrapped inline where they're needed (see the aim blend in Run._updatePlayer), which
// is the only place that ever wanted it.

// --- Colour helpers. Palettes are authored in HSL so tiers can be cross-faded. ---

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Interpolate two hues the short way round the wheel. */
export function lerpHue(a, b, t) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * t;
}

export function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
