// Characters: who you are, who's watching, and why any of it matters.
//
// Weapons aren't stat blocks, they're roles. Picking up the axe instead of the machete
// changes how you have to stand in a crowd, and the game treats that as changing who
// you are for the night — which costs nothing mechanically and gives the meta
// progression something to be about.
//
// The `id` keys are still `weapon_*` because they double as the save's equipped-weapon
// ids and the stockpile's unlock ids.

// ---------------------------------------------------------------- the survivor

export const CORES = {
  weapon_machete: {
    id: 'weapon_machete',
    name: 'HOLT',
    role: 'Machete',
    blurb: 'Gets in close. Never explains why.',
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
    name: 'MAREN',
    role: 'Hunting Bow',
    blurb: 'Picks her moment. Only needs the one.',
    long: 'Hunted this treeline for eleven years. The dead move slower than deer and stand in straighter lines, and she considers that an insult.',
    eyeStyle: 'calm',
    sides: 6,
    rgb: [176, 210, 160],
    pupilRgb: [255, 255, 255],
    spin: 0.28,
    sprite: true,
  },
  weapon_axe: {
    id: 'weapon_axe',
    name: 'BRIAR',
    role: 'Fire Axe',
    blurb: 'Solves crowds by making them smaller.',
    long: 'Took the axe off the station wall the first night and has not put it down since. Swings slow. Only has to connect once.',
    eyeStyle: 'eager',
    sides: 5,
    rgb: [235, 150, 90],
    pupilRgb: [255, 255, 255],
    spin: 1.4,
    sprite: true,
  },
};

export const coreFor = (weaponId) => CORES[weaponId] || CORES.weapon_machete;

// ---------------------------------------------------------------- the radio

/**
 * The voice on the emergency band. Never seen, never helps, keeps the count.
 *
 * Replaces the Grid's custodian in the same structural slot: it announces the night's
 * conditions, taunts a broken streak, and grudgingly concedes at milestones. Somebody
 * has to be keeping score or the daily has no audience.
 */
export const RIVAL = {
  name: 'THE BAND',
  role: 'Voice on the emergency channel',
  eyeStyle: 'smug',
  sides: 6,
  rgb: [200, 170, 130],
  pupilRgb: [255, 230, 210],
  spin: -0.34,
};

/**
 * One short framing sentence, shown on first launch and from the About screen.
 * The daily loop needs a "why" and this is it: the village resets, you don't.
 */
export const STAKES = {
  title: 'WHY ANY OF THIS',
  line: 'Every night the village fills up again and forgets everyone who held it.',
  line2: 'Holt walks back in anyway. The streak is the only proof any of it happened.',
  signoff: '— The emergency band finds this funny. Prove it wrong.',
};

// ---------------------------------------------------------------- lantern flavour
//
// Cosmetics get one line each, so the stockpile reads as a shelf rather than a table of
// SKUs.

export const TRAIL_BLURBS = {
  trail_cyan:  'Standard issue. Honest light.',
  trail_ember: 'Three nights running. Something noticed.',
  trail_prism: 'A week of stubbornness, refracted.',
  trail_void:  'Thirty nights. Burns cold and does not gutter.',
  trail_toxic: 'Sickly. Attracts things. You knew that.',
  trail_rose:  'Visible for a mile. Purely a flex.',
};
