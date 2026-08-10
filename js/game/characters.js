// Characters: who you are, who's watching, and why any of it matters.
//
// There is one survivor: HOLT. A loadout changes how HOLT fights, not who walks into the
// village. Keeping one identity matches the one actual survivor sprite and stops a weapon
// purchase from silently replacing the protagonist.

// ---------------------------------------------------------------- the survivor

export const CORES = {
  weapon_machete: {
    id: 'weapon_machete',
    name: 'HOLT',
    role: 'Machete',
    blurb: 'Fast, close, and built for making space.',
    long: 'Ran the hardware counter before. Knows every fence line and every back gate in this village, which is the only reason he is still standing in it.',
    eyeStyle: 'calm',
    sides: 3,
    rgb: [186, 214, 235],
    pupilRgb: [255, 255, 255],
    spin: 0.5,
    sprite: true,
  },
  weapon_bow: {
    id: 'weapon_bow',
    name: 'HOLT',
    role: 'Hunting Bow',
    blurb: 'Slow draw, long reach, and room to line them up.',
    long: 'Ran the hardware counter before. Knows every fence line and every back gate in this village, which is the only reason he is still standing in it.',
    eyeStyle: 'calm',
    sides: 3,
    rgb: [186, 214, 235],
    pupilRgb: [255, 255, 255],
    spin: 0.5,
    sprite: true,
  },
  weapon_axe: {
    id: 'weapon_axe',
    name: 'HOLT',
    role: 'Fire Axe',
    blurb: 'Slow, wide, and made for a crowded doorway.',
    long: 'Ran the hardware counter before. Knows every fence line and every back gate in this village, which is the only reason he is still standing in it.',
    eyeStyle: 'calm',
    sides: 3,
    rgb: [186, 214, 235],
    pupilRgb: [255, 255, 255],
    spin: 0.5,
    sprite: true,
  },
};

export const coreFor = (weaponId) => CORES[weaponId] || CORES.weapon_machete;

// ---------------------------------------------------------------- the radio

/**
 * The voice on the emergency band. Never seen, never helps, keeps the count.
 *
 * It knows the reset, marks useful supplies and keeps steering Holt toward locked doors.
 */
export const RIVAL = {
  name: 'THE BAND',
  role: 'A voice that should not still be broadcasting',
  // Draws a real zombie head rather than the abstract eyes-in-a-shape face — see the
  // sheet choice in Portrait.draw. `pupilRgb` and `eyeStyle` below are now only consulted
  // if that sheet fails to decode, which is the one case the fallback still covers.
  sprite: 'zombie',
  eyeStyle: 'smug',
  sides: 6,
  rgb: [200, 170, 130],
  pupilRgb: [255, 230, 210],
  spin: -0.34,
};

/**
 * One short framing sentence, shown on first launch and from the About screen.
 * The story loop needs a "why" and this is it: the village resets, Holt doesn't.
 */
export const STAKES = {
  title: 'THE LOOP',
  line: 'Whenever Holt falls, the village rolls back to dusk. The dead return exactly as they were.',
  line2: 'The Band is still transmitting through every reset. Holt keeps his memory, and anything carried back into the Safehouse.',
  signoff: 'Find the source of the signal. Break the loop.',
};

// ---------------------------------------------------------------- lantern flavour
//
// Cosmetics get one line each, so the stockpile reads as a shelf rather than a table of
// SKUs.

export const TRAIL_BLURBS = {
  trail_cyan:  'Standard issue. Honest light.',
  trail_ember: 'The Safehouse remembered this light.',
  trail_prism: 'Recovered beside the radio component.',
  trail_void:  'Cold light from the Butcher’s key.',
  trail_toxic: 'Sickly green light. Cosmetic; it attracts nothing.',
  trail_rose:  'Visible for a mile. Cosmetic, deeply unsubtle.',
};
