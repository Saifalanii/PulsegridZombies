// Daily Run: one deterministic seeded run per calendar day, shared by everyone.
//
// Determinism contract — everything the director does must come from the run's Rng, in a
// fixed order, and nothing may consume from that stream based on player input. Spawn
// positions, enemy type choices, elite timing and mutator all draw from it; particle
// jitter and cosmetic randomness use Math.random so they can't desync the run.

import { Rng, todayKey } from '../core/rng.js';

export const MUTATORS = [
  {
    id: 'overclock', name: 'RESTLESS',
    desc: 'The dead move 50% faster. All score x2.',
    apply: (m) => { m.enemySpeed *= 1.5; m.scoreMul *= 2; },
  },
  {
    id: 'swarm', name: 'OVERRUN',
    desc: 'Twice as many of them, 35% less meat on each. Scrap x1.5.',
    apply: (m) => { m.waveCount *= 2; m.spawnRate *= 1.7; m.enemyHp *= 0.65; m.shardMul *= 1.5; },
  },
  {
    id: 'brittle', name: 'PICKED CLEAN',
    desc: 'No medical supplies out there. Triple scrap. Score x1.6.',
    apply: (m) => { m.noHealing = true; m.shardMul *= 3; m.scoreMul *= 1.6; },
  },
  {
    id: 'bulwark', name: 'BLOATED',
    desc: 'The dead are 80% tougher but move 25% slower. Score x1.8.',
    apply: (m) => { m.enemyHp *= 1.8; m.enemySpeed *= 0.75; m.scoreMul *= 1.8; },
  },
  {
    id: 'glass', name: 'GLASS CANNON',
    desc: 'You hit twice as hard but start at 40% health. Score x2.2.',
    apply: (m) => { m.playerDmg *= 2; m.startHpMul = 0.4; m.scoreMul *= 2.2; },
  },
  {
    id: 'rush', name: 'RUSH HOUR',
    desc: 'Everything is 30% faster — you included. Score x1.9.',
    apply: (m) => { m.enemySpeed *= 1.3; m.playerSpeed *= 1.3; m.spawnRate *= 1.25; m.scoreMul *= 1.9; },
  },
  {
    id: 'famine', name: 'FAMINE',
    desc: 'Half the experience, but every level gives you two picks. Score x2.',
    apply: (m) => { m.xpMul *= 0.5; m.doubleUpgrade = true; m.scoreMul *= 2; },
  },
  {
    id: 'gauntlet', name: 'BAD NIGHT',
    desc: 'The big ones come twice as often. Scrap x2, score x2.4.',
    apply: (m) => { m.eliteRate *= 2; m.shardMul *= 2; m.scoreMul *= 2.4; },
  },
  {
    id: 'shrouded', name: 'FOGBOUND',
    desc: 'Your lantern reaches 35% less far. Score x1.7.',
    apply: (m) => { m.visibilityMul *= 0.65; m.scoreMul *= 1.7; },
  },
  {
    id: 'volatile', name: 'ROTTEN',
    desc: 'Killed bodies burst into the horde. Enemy hits deal 35% more. Score x1.8.',
    apply: (m) => { m.forceNova = 2; m.enemyDmg *= 1.35; m.scoreMul *= 1.8; },
  },
];

export function defaultModifiers() {
  return {
    enemySpeed: 1, enemyHp: 1, enemyDmg: 1,
    spawnRate: 1, waveCount: 1, eliteRate: 1,
    playerDmg: 1, playerSpeed: 1, startHpMul: 1,
    xpMul: 1, shardMul: 1, scoreMul: 1,
    arenaScale: 1, visibilityMul: 1,
    noHealing: false, doubleUpgrade: false, forceNova: 0,
  };
}

/**
 * Build a run config.
 * Story is the persistent, scrap-banking campaign. Practice remains an unseeded sandbox.
 * `isDaily` is retained as an internal compatibility flag for the run/results economy;
 * it now means "progression run", not a calendar-limited attempt.
 * @param {'story'|'practice'|'daily'} mode
 */
export function makeRunConfig(mode, dateKey = todayKey()) {
  const isStory = mode === 'story' || mode === 'daily';
  const isDaily = isStory;
  // The `nightfall-v1|` prefix namespaces the seed. The generator was rebalanced wholesale
  // for this fork — new roster, new village, new weapons — so it gets its own seed space
  // rather than silently reusing Pulsegrid's and producing a different night from the
  // same string.
  const seedStr = isStory
    ? `first-signal|${Date.now()}|${Math.random()}`
    : `practice|${Date.now()}|${Math.random()}`;
  const rng = Rng.fromString(seedStr);

  const mods = defaultModifiers();
  let mutator = null;
  // Chapter One teaches the authored encounters without a random modifier obscuring
  // them. Rotating conditions can return later as optional post-chapter challenges.

  return { mode: isStory ? 'story' : 'practice', isStory, isDaily,
           dateKey: isStory ? 'chapter-one' : null, seed: rng.seed, rng, mods, mutator };
}

/** Preview the mutator for a date without building a full run (menu display). */
export function mutatorFor(dateKey) {
  const rng = Rng.fromString(`nightfall-v1|${dateKey}`);
  return MUTATORS[Math.floor(rng.next() * MUTATORS.length)];
}

/** ms until local midnight — drives the "next daily in ..." countdown. */
export function msUntilTomorrow() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return next - now;
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
