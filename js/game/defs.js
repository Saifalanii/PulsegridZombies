// All tunable game data in one place.
//
// Numbers here are judgment calls, tuned by playing. The shape of the difficulty curve
// matters more than any individual value: a night should be survivable for ~45s, tense
// by 2:00, and genuinely lethal past 4:00, landing most runs in the 3-6 minute window.

// ---------------------------------------------------------------- the dead
//
// Every enemy is undead and every one of them is drawn from one of four LPC zombie
// sheets. Four sheets cannot carry thirteen silhouettes on their own, so the roster is
// separated the way the original roster was — **silhouette first, colour second** — but
// silhouette here means *scale and motion*, not polygon count:
//
//   scale     a Brute is drawn at 1.65x a Shambler and a Crawler at 0.6x. Size is read
//             instantly and at any distance, before you can resolve a single pixel.
//   motion    a Shambler lurches straight at you, a Stalker weaves, a Runner freezes
//             then sprints, a Lurker stops dead and telegraphs a leap. How a thing moves
//             is legible from the corner of your eye; what it's wearing is not.
//   sheet     green (fresh), rotting (old, bloated), shadow (dark, fast), plague (sick,
//             swollen). Colour is the last differentiator, exactly as before.
//
// `filter` is an optional canvas filter applied to the sprite blit — used sparingly, and
// only where the type also differs in scale or behaviour, so it is never the only cue.
//
// MELEE MODEL. Nothing here deals contact damage. An enemy with an `atk` block closes to
// `atk.range`, stops, plays a swing, and applies damage on the contact frame — after
// `atk.windup` seconds of visible wind-up that a player can read and dash out of. That
// wind-up is the whole difference between "shapes bumping into you" and "being swarmed".

export const ENEMIES = {
  shambler: {
    name: 'Shambler', sheet: 'green', scale: 1.0,
    // Three bodies rather than one, picked per corpse at spawn.
    //
    // The Shambler is weight 100 at minTime 0, so it *is* the early game: the first
    // ninety seconds are a street full of one identical man, and identical is the thing
    // the eye notices fastest. These are cosmetic only — same stats, same behaviour, same
    // tell — so the variety costs the player nothing to read.
    sheets: ['green', 'fresh', 'charred'],
    r: 14, hp: 13, speed: 68, dmg: 9,
    xp: 1, score: 10, behavior: 'chase', weight: 100, minTime: 0,
    atk: { range: 40, windup: 0.42, recover: 0.34, cool: 0.55, clip: 'slash', reach: 54 },
    desc: 'Fresh. Slow, stupid, and never alone.',
  },

  stalker: {
    name: 'Stalker', sheet: 'rotting', scale: 0.96,
    r: 13, hp: 17, speed: 96, dmg: 10,
    xp: 2, score: 18, behavior: 'weave', weight: 55, minTime: 25,
    atk: { range: 42, windup: 0.32, recover: 0.28, cool: 0.45, clip: 'slash', reach: 56 },
    desc: 'Circles before it commits. Hard to lead.',
  },

  runner: {
    name: 'Runner', sheet: 'shadow', scale: 0.92,
    r: 12, hp: 11, speed: 72, dmg: 13,
    xp: 2, score: 22, behavior: 'charge', weight: 45, minTime: 45,
    chargeSpeed: 400, windup: 0.5, chargeTime: 0.8, restTime: 0.85,
    atk: { range: 40, windup: 0.24, recover: 0.24, cool: 0.35, clip: 'thrust', reach: 54 },
    desc: 'Stops. Watches. Then it is on you.',
  },

  bloater: {
    name: 'Bloater', sheet: 'plague', scale: 1.32,
    r: 21, hp: 36, speed: 44, dmg: 12,
    xp: 3, score: 34, behavior: 'chase', weight: 38, minTime: 60,
    atk: { range: 48, windup: 0.55, recover: 0.4, cool: 0.7, clip: 'slash', reach: 66 },
    splitInto: 'crawler', splitCount: 3,
    desc: 'Swollen. Splits open and spills what is inside.',
  },

  crawler: {
    name: 'Crawler', sheet: 'green', scale: 0.6,
    r: 9, hp: 7, speed: 128, dmg: 6,
    xp: 1, score: 8, behavior: 'chase', weight: 0, minTime: 0,   // spilled, never rolled
    atk: { range: 30, windup: 0.2, recover: 0.2, cool: 0.3, clip: 'thrust', reach: 40 },
    desc: 'Half a body, twice the hurry.',
  },

  screamer: {
    name: 'Screamer', sheet: 'plague', scale: 1.02,
    r: 15, hp: 30, speed: 88, dmg: 10,
    xp: 3, score: 30, behavior: 'circle', weight: 34, minTime: 80,
    circleRadius: 230, callEvery: 5.2, callCount: 3, call: 'shambler', maxCalls: 2,
    atk: { range: 42, windup: 0.4, recover: 0.3, cool: 0.5, clip: 'slash', reach: 54 },
    // A horde-caller, not a shooter. It keeps its distance, circles, and screams the
    // street awake. Killing it early is always the right call — which is the entire
    // reason it exists.
    desc: 'Will not close. Will not shut up.',
  },

  brute: {
    name: 'Brute', sheet: 'rotting', scale: 1.62,
    r: 28, hp: 92, speed: 38, dmg: 20,
    xp: 5, score: 55, behavior: 'chase', weight: 30, minTime: 100,
    armor: 2,
    atk: { range: 56, windup: 0.72, recover: 0.5, cool: 0.9, clip: 'slash', reach: 78, knock: 420 },
    desc: 'Enormous. Armoured by sheer mass. Hits like a door.',
  },

  spitter: {
    name: 'Spitter', sheet: 'plague', scale: 1.06, filter: 'hue-rotate(-25deg) saturate(1.3)',
    r: 16, hp: 52, speed: 26, dmg: 11,
    xp: 4, score: 44, behavior: 'standoff', weight: 26, minTime: 130,
    // Bile is a short denial attack, not a sniper round. At 210 world units it crosses
    // a little over three authored map cells and expires before leaving the encounter.
    standoffRange: 185, shootEvery: 2.35, burst: 2,
    bulletSpeed: 220, bulletRange: 210, bulletDmg: 8,
    atk: { range: 44, windup: 0.5, recover: 0.35, cool: 0.6, clip: 'thrust', reach: 56 },
    desc: 'Keeps a short distance and vomits bile a few steps ahead.',
  },

  // --- swarm ---
  // Small, fragile, and always in a pack. Wobbles instead of tracking cleanly, so a
  // group arrives as a spreading cloud you have to sweep rather than a line to lead.
  vermin: {
    name: 'Vermin', sheet: 'shadow', scale: 0.56,
    r: 8, hp: 6, speed: 176, dmg: 5,
    xp: 1, score: 9, behavior: 'swarm', weight: 42, minTime: 70,
    packMin: 6, packMax: 9,
    atk: { range: 26, windup: 0.16, recover: 0.16, cool: 0.28, clip: 'thrust', reach: 36 },
    desc: 'What is left when a body has been picked over.',
  },

  // --- bruiser ---
  // Slow, enormous damage, and a long visible wind-up before it leaps. The whole point
  // is that it is always avoidable if you're paying attention.
  lurker: {
    name: 'Lurker', sheet: 'shadow', scale: 1.5, filter: 'brightness(0.75) contrast(1.15)',
    r: 26, hp: 165, speed: 30, dmg: 30,
    xp: 8, score: 90, behavior: 'lunge', weight: 22, minTime: 150,
    armor: 3,
    windup: 0.9, lungeSpeed: 600, lungeTime: 0.55, restTime: 1.5, lungeRange: 360,
    atk: { range: 52, windup: 0.6, recover: 0.45, cool: 0.8, clip: 'slash', reach: 72, knock: 340 },
    desc: 'Waits in the dark between the houses. Then it jumps.',
  },

  // --- boss segment ---
  // Torn loose from the Butcher; never rolled by the director.
  thrall: {
    name: 'Thrall', sheet: 'green', scale: 0.85, filter: 'brightness(0.8) hue-rotate(180deg)',
    r: 14, hp: 60, speed: 0, dmg: 12,
    xp: 6, score: 70, behavior: 'orbitParent', weight: 0, minTime: 0,
    orbitDist: 96, orbitRate: 1.4,
    atk: { range: 38, windup: 0.35, recover: 0.3, cool: 0.5, clip: 'slash', reach: 50 },
    desc: 'Dragged along on something that is not quite a leash.',
  },

  // --- elite ---
  horror: {
    name: 'Horror', sheet: 'plague', scale: 2.3, filter: 'saturate(1.4) brightness(1.1)',
    r: 42, hp: 680, speed: 44, dmg: 26,
    xp: 40, score: 600, behavior: 'chase', weight: 0, minTime: 0,
    elite: true,
    // Bile burst instead of a neon radial: same telegraph, same geometry, but it is
    // something a swollen corpse could plausibly do.
    shootEvery: 2.8, radialCount: 12, bulletSpeed: 170, bulletDmg: 14,
    call: 'shambler', callCount: 4, callEvery: 6.5, maxCalls: 3,
    atk: { range: 72, windup: 0.8, recover: 0.55, cool: 1.0, clip: 'slash', reach: 100, knock: 520 },
    desc: 'Several people, once.',
  },

  // --- the night's centrepiece ---
  //
  // The repetition-breaker. Not just a bigger zombie: at half health it tears three
  // Thralls off itself and hides behind them, so the fight has a readable two-phase
  // shape — chip it down, then deal with what came off it before you can hurt it again.
  butcher: {
    name: 'THE BUTCHER', sheet: 'rotting', scale: 2.7, filter: 'contrast(1.2) brightness(0.95)',
    r: 40, hp: 620, speed: 58, dmg: 20,
    xp: 55, score: 900, behavior: 'chase', weight: 0, minTime: 0,
    elite: true, miniboss: true,
    atk: { range: 78, windup: 0.85, recover: 0.6, cool: 0.85, clip: 'slash', reach: 108, knock: 600 },
    // Phase change.
    splitAt: 0.5, segment: 'thrall', segmentCount: 3,
    // Damage taken while its Thralls are still alive. Low enough to make ignoring them
    // a losing play, not so low it feels like a scripted wait.
    shieldedDamageMul: 0.35,
    // Telegraphed ground slam, on a slower cycle than its swings.
    sweepEvery: 6.0, sweepWindup: 1.2, sweepRadius: 170, sweepDmg: 24,
    desc: 'It kept the apron.',
  },
};

// ---------------------------------------------------------------- weapons
//
// Reworked around the animations that actually exist in the art. The player sheet's
// oversized rows are the only frames anywhere in the asset set with a visible weapon in
// hand — a sword, swung overhead and backhand — so the two melee weapons use those, and
// the ranged weapon uses the 13-frame draw-and-release `shoot` block.
//
// A melee starter is deliberate. An auto-aiming ranged-only survivor with a sword sprite
// on the character is incoherent; being *forced* into the horde's reach to kill anything
// is what makes the horde matter.

/**
 * The heavy swing: what the held button does.
 *
 * Auto-attack is untouched, so a player who never holds the button loses nothing and the
 * game is still playable with one thumb. This is the opt-in: slower, wider, and hard
 * enough to shove a crowd off you, on its own cooldown so it can't be spammed in place of
 * the ordinary swing.
 *
 * Ranged weapons get it too — a drawn shot that punches through a line — because a bow
 * player pressing the same button should not be told "not for you".
 */
export const HEAVY = {
  cooldown: 3.4,
  dmgMul: 2.6,
  arcMul: 1.55,        // melee: how much wider the cone is
  reachMul: 1.2,
  knockMul: 2.4,
  // Ranged: the held shot ignores `count` and fires one fat, deep-piercing projectile.
  pierceBonus: 3,
  sizeMul: 1.8,
};

export const WEAPONS = {
  weapon_machete: {
    name: 'Machete', desc: 'Fast arcing swing. You have to be close. That is the deal.',
    cost: 0, melee: true, clip: 'bigslash',
    dmg: 26, rate: 2.0, reach: 66, arc: 1.75, knock: 240,
    // Unused by melee but read unconditionally by the stat block.
    speed: 0, count: 1, spread: 0, size: 0, pierce: 0, range: 0,
  },
  weapon_bow: {
    name: 'Hunting Bow', desc: 'Automatic long-range shots. Hold Heavy to punch through a whole line.',
    cost: 700, melee: false,
    // `thrust`, not `shoot` — the bow draw only exists on player_hero_alt.png's row 4-7
    // block (LPC's "thrust" slot), not on the dedicated 13-frame "shoot" rows, which are
    // body-only on both player sheets. See PLAYER_SHEET_BOW's note in run.js. The clip's
    // own fps is stretched by Run._startAttack to show a deliberate draw and release.
    // The pause between arrows is intentional counterplay: range should buy safety, not
    // erase every enemy before it can cross the screen.
    clip: 'thrust',
    // Range remains its identity, but its safety is balanced by lower damage and no
    // free pierce. Broadheads now has to earn that line-clearing power.
    dmg: 28, rate: 0.78, speed: 720, count: 1, spread: 0.02,
    size: 5, pierce: 0, range: 560, reach: 0, arc: 0, knock: 75,
  },
  weapon_axe: {
    name: 'Fire Axe', desc: 'Slow, enormous, and clears a whole doorway at once.',
    // Real axe art now (player_hero_axe.png via PLAYER_SHEET_AXE in run.js) — `axechop`,
    // not the sword's `bigchop`, which was this weapon swinging a machete slowly.
    cost: 1400, melee: true, clip: 'axechop',
    dmg: 62, rate: 1.05, reach: 78, arc: 2.5, knock: 520,
    speed: 0, count: 1, spread: 0, size: 0, pierce: 0, range: 0,
  },
};

// ------------------------------------------------------- in-run upgrades
//
// Offered three at a time on level-up. `weight` biases the draw; `max` caps stacking so
// no single stat runs away and flattens the build.
//
// The stat keys are unchanged from the original — `count`, `pierce`, `speedMul` and so
// on still mean what they meant. On a melee weapon the projectile stats fold into reach
// and swing arc instead (see Run._recomputeDerived), so no offer is ever dead.
//
// `desc` therefore takes the equipped weapon's melee flag as well as the level: a card
// reading "+1 arrow" in front of a survivor holding a fire axe describes something that
// will not happen. The *draw* is unaffected — the same three upgrades come up at level N
// for everyone on the daily, they're just described in terms of the weapon in hand.

export const UPGRADES = [
  { id: 'power',   name: 'Whetstone',    max: 6, weight: 100, icon: 3,
    desc: (l) => `+22% damage  (${l}/6)`,
    apply: (s) => { s.dmgMul *= 1.22; } },

  { id: 'rapid',   name: (melee) => melee ? 'Adrenaline' : 'Quick Draw', max: 6, weight: 100, icon: 4,
    desc: (l, melee) => `${melee ? '+18% attack speed' : '+8% bow draw speed'}  (${l}/6)`,
    apply: (s, _p, _l, melee) => { s.rateMul *= melee ? 1.18 : 1.08; } },

  { id: 'multi',   name: (melee) => melee ? 'Wide Swing' : 'Split Shot', max: 3, weight: 55, icon: 5,
    desc: (l, melee) => melee
      ? `+18% swing arc, -7% damage  (${l}/3)`
      : `+1 arrow, -22% damage each  (${l}/3)`,
    apply: (s, _p, _l, melee) => {
      s.count += 1; s.spread = Math.max(s.spread, 0.16); s.dmgMul *= melee ? 0.93 : 0.78;
    } },

  { id: 'pierce',  name: (melee) => melee ? 'Follow-Through' : 'Broadheads', max: 3, weight: 60, icon: 6,
    desc: (l, melee) => melee
      ? `+12% swing reach  (${l}/3)`
      : `Arrows punch through +1 body  (${l}/3)`,
    apply: (s) => { s.pierce += 1; } },

  { id: 'velocity',name: (melee) => melee ? 'Long Reach' : 'Fletching', max: 3, weight: 65, icon: 4,
    // speedMul is projectile flight speed and does nothing at all to a swing — only the
    // rangeMul half of this reaches a melee build, so only that half is claimed.
    desc: (l, melee) => melee
      ? `+20% swing reach  (${l}/3)`
      : `+28% arrow speed, +20% range  (${l}/3)`,
    apply: (s) => { s.speedMul *= 1.28; s.rangeMul *= 1.2; } },

  { id: 'swift',   name: 'Marathon',     max: 5, weight: 85, icon: 3,
    desc: (l) => `+11% move speed  (${l}/5)`,
    apply: (s) => { s.moveMul *= 1.11; s.moveSpeed *= 1.11; } },

  { id: 'vitality',name: 'First Aid',    max: 5, weight: 80, icon: 6,
    desc: (l) => `+22 max health, heal 22  (${l}/5)`,
    apply: (s, p) => { s.maxHp += 22; p.hp = Math.min(s.maxHp, p.hp + 22); } },

  { id: 'magnet',  name: 'Scrounger’s Reach', max: 3, weight: 60, icon: 0,
    desc: (l) => `+55% pickup radius  (${l}/3)`,
    apply: (s) => { s.magnet *= 1.55; } },

  { id: 'orbit',   name: 'Barbed Wire',  max: 4, weight: 55, icon: 5,
    desc: (l) => `+1 coil of wire dragging around you  (${l}/4)`,
    apply: (s) => { s.orbitals += 1; } },

  { id: 'crit',    name: 'Weak Points',  max: 4, weight: 60, icon: 3,
    desc: (l) => `+9% critical chance (2.2x damage)  (${l}/4)`,
    apply: (s) => { s.crit += 0.09; } },

  // The reach bonus is not padding. `homing` only ever affects projectiles, so on a
  // melee build this was the one genuinely dead offer in the pool — and it can't simply
  // be filtered out of the draw, because the Daily's promise is that everyone sees the
  // same three cards at level N regardless of what they're carrying. Giving it a second
  // effect that a melee build can use keeps the offer honest without splitting the
  // upgrade stream by weapon.
  { id: 'homing',  name: (melee) => melee ? 'Measured Reach' : 'Bloodhound', max: 2, weight: 45, icon: 0,
    desc: (l, melee) => melee
      ? `+8% swing reach  (${l}/2)`
      : `Arrows curve toward the nearest body; +8% range  (${l}/2)`,
    apply: (s) => { s.homing += 2.6; s.rangeMul *= 1.08; } },

  { id: 'dashmaster', name: 'Sprint Training', max: 2, weight: 45, icon: 4,
    desc: (l) => (l === 1 ? '-28% sprint cooldown' : '+1 sprint charge'),
    apply: (s, p, lvl) => { if (lvl === 1) s.dashCd *= 0.72; else s.dashCharges += 1; } },

  { id: 'thorns',  name: 'Spiked Vest',  max: 2, weight: 40, icon: 6,
    desc: (l) => `Anything that hits you gets shoved off, hard  (${l}/2)`,
    apply: (s) => { s.thorns += 1; } },

  { id: 'regen',   name: 'Field Dressing', max: 3, weight: 50, icon: 6,
    desc: (l) => `Recover 1 health every 2.6s  (${l}/3)`,
    apply: (s) => { s.regen += 1 / 2.6; } },

  { id: 'greed',   name: 'Lucky Find',   max: 3, weight: 55, icon: 5,
    desc: (l) => `+30% scrap dropped  (${l}/3)`,
    apply: (s) => { s.shardMul *= 1.3; } },

  { id: 'bigshot', name: (melee) => melee ? 'Heavy Edge' : 'Heavy Heads', max: 3, weight: 55, icon: 0,
    // sizeMul is arrow hitbox size; a swing has no projectile to widen, so a melee
    // build only ever collects the damage half.
    desc: (l, melee) => melee
      ? `+12% damage  (${l}/3)`
      : `+32% arrow size, +12% damage  (${l}/3)`,
    apply: (s) => { s.sizeMul *= 1.32; s.dmgMul *= 1.12; } },

  { id: 'shield',  name: 'Riot Padding', max: 2, weight: 42, icon: 0,
    desc: (l) => `Padding soaks 1 hit, re-sets in ${l === 1 ? 14 : 9}s`,
    apply: (s, p, lvl) => { s.shieldMax = 1; s.shieldRecharge = lvl === 1 ? 14 : 9; } },

  { id: 'nova',    name: 'Rot Bloom',    max: 2, weight: 38, icon: 5,
    desc: (l) => `The dead burst when they drop, spraying the ones behind  (${l}/2)`,
    apply: (s) => { s.nova += 1; } },
];

// ---------------------------------------------------------------- stockpile
//
// Permanent, scrap-bought. Deliberately modest multipliers: meta progression should
// shorten the ramp, not trivialise the night — otherwise the daily stops being a fair
// comparison between players.

export const SHOP = [
  // Weapons
  // The Hunting Bow was withheld here for a real bow art was found on a second
  // player export (player_hero_alt.png's "thrust" rows) — see the note above
  // WEAPONS.weapon_bow and PLAYER_SHEET_BOW in run.js. save.js's SHELVED_WEAPONS
  // guard, which demoted any save with the bow equipped, is gone too.
  { id: 'weapon_bow', cat: 'Weapons', name: 'Hunting Bow', cost: 700,
    desc: WEAPONS.weapon_bow.desc },
  { id: 'weapon_axe', cat: 'Weapons', name: 'Fire Axe', cost: 1400,
    desc: WEAPONS.weapon_axe.desc },

  // Cosmetics — the lantern you carry, and the light it throws.
  { id: 'trail_toxic', cat: 'Lanterns', name: 'Bile Lantern', cost: 400, desc: 'Sick green light' },
  { id: 'trail_rose',  cat: 'Lanterns', name: 'Signal Flare', cost: 400, desc: 'Hot pink, deeply unsubtle' },
];

/** Story unlocks, shown greyed in the stockpile so each discovery has a visible reward. */
export const STREAK_LOCKED = {
  trail_ember: 'Find the Safehouse',
  trail_prism: 'Recover the radio part',
  trail_void: 'Take the Butcher’s key',
};

// ------------------------------------------------------- derived meta stats

export function metaStats(save) {
  // Permanent stat purchases were removed. Every story attempt now begins from the same
  // combat baseline; only the equipped weapon/lantern and saved story checkpoint vary.
  return { hp: 0, dmg: 1, spd: 1, xp: 1, shard: 1, magnet: 1,
           dashCharges: 0, revive: false };
}

/** XP needed to go from level n to n+1. Superlinear so late levels feel earned. */
export const xpForLevel = (n) => Math.floor(5 + n * 4 + Math.pow(n, 1.72) * 1.6);
