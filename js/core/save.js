// Persistent save. localStorage, not IndexedDB: the whole payload is a couple of KB of
// scalars, and synchronous reads mean no async dance on boot.

import { todayKey, daysBetween } from './rng.js';

// Deliberately a different key from the original game's. This fork changed the weapon
// ids, the unlock ids and the meaning of half the numbers; migrating a Pulsegrid save
// into it would hand the survivor a weapon that no longer exists.
const KEY = 'pulsegrid.zombies.save.v1';

const DEFAULTS = {
  version: 1,
  shards: 0,
  totalShardsEarned: 0,

  // Streak
  streak: 0,
  bestStreak: 0,
  lastDailyDate: null,     // YYYY-MM-DD of the last completed daily
  claimedMilestones: [],   // e.g. [3, 7]

  // YYYY-MM-DD of the day whose Daily Run has been *started*. One attempt per calendar
  // day, and it's spent the moment the run actually begins — see markDailyAttempted.
  dailyAttemptedDate: null,

  // Daily history: { 'YYYY-MM-DD': { score, wave, time, kills } }
  dailyScores: {},
  bestDailyScore: 0,
  bestPracticeScore: 0,
  bestTime: 0,
  totalRuns: 0,
  totalKills: 0,

  // Meta unlocks
  unlocked: ['weapon_machete', 'trail_cyan'],
  equippedWeapon: 'weapon_machete',
  equippedTrail: 'trail_cyan',

  settings: {
    muted: false,
    sfxVolume: 0.85,
    musicVolume: 0.55,
    haptics: true,
    screenShake: 1,
    colorblind: false,
    quality: 'auto',       // auto | high | low
    leftHanded: false,
    // autoFire removed — firing is unconditionally automatic now, no manual-fire /
    // manual-aim mode. A save written before this change may still carry an old
    // `autoFire: false`; deepMerge in load() means that stale key just sits unread
    // in this object from now on, harmlessly, since nothing checks it any more.
    shootSound: 'pulse',   // see SHOOT_STYLES in core/audio.js
  },

  seenTutorial: false,
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  // A shallow spread leaves every nested default (`settings`, `unlocked`, `dailyScores`,
  // `claimedMilestones`) pointing at DEFAULTS itself. Any key the stored save happens not
  // to carry — an older version, a partial write — would then be *the* DEFAULTS object,
  // so unlock() would push into DEFAULTS.unlocked and reset() would clone a save that had
  // been quietly polluted all session. Detach them up front.
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (Array.isArray(v)) out[k] = v.slice();
    else if (v && typeof v === 'object') out[k] = structuredClone(v);
  }
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const bv = base[k], pv = patch[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && pv && typeof pv === 'object' && !Array.isArray(pv)) {
      out[k] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

/**
 * Weapons that are implemented but withheld from the stockpile for missing art.
 *
 * Held here as a literal rather than imported from defs.js: save.js sits below the game
 * layer and pulling defs in for one string would invert that. It is duplicated in the
 * comment on the SHOP entry, and both name each other.
 *
 * A save from before a weapon was shelved can still have it equipped, which would field
 * an invisible one. Demote to the starting weapon instead — the purchase itself is left
 * in `owned`, so unshelving restores it without costing the player the scrap again.
 *
 * Empty for now — the bow was the only entry, restored once player_hero_alt.png's
 * "thrust" rows turned out to carry a real bow draw. Left in place rather than removed:
 * it's cheap infrastructure for the next time art lags behind an implemented weapon.
 */
const SHELVED_WEAPONS = [];

function sanitizeLoadout(data) {
  if (SHELVED_WEAPONS.includes(data.equippedWeapon)) {
    data.equippedWeapon = DEFAULTS.equippedWeapon;
  }
}

class SaveStore {
  constructor() {
    this.data = this.load();
    this._writeTimer = 0;
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const parsed = JSON.parse(raw);
      // Merge over defaults so new fields added in later versions appear on old saves.
      const data = deepMerge(DEFAULTS, parsed);
      sanitizeLoadout(data);
      return data;
    } catch (e) {
      console.warn('[nightfall] save unreadable, starting fresh', e);
      return structuredClone(DEFAULTS);
    }
  }

  /** Debounced — called from settings toggles that can fire rapidly (sliders). */
  save() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('[nightfall] save failed (private mode / quota?)', e);
    }
  }

  reset() {
    this.data = structuredClone(DEFAULTS);
    this.saveNow();
  }

  // ------------------------------------------------------------ scrap

  // No addShards(): scrap only ever arrives through recordRun (banked at the end of a run)
  // or commitDaily (a streak milestone), and both write the two counters together and
  // saveNow() rather than debouncing. A general "add some scrap" helper existed and was
  // called by nothing.

  spendShards(n) {
    if (this.data.shards < n) return false;
    this.data.shards -= n;
    this.save();
    return true;
  }

  has(id) { return this.data.unlocked.includes(id); }

  unlock(id) {
    if (!this.has(id)) {
      this.data.unlocked.push(id);
      this.save();
    }
  }

  // ------------------------------------------------------------ daily lock

  /**
   * Has today's Daily Run already been spent?
   *
   * Deliberately keyed off `dailyAttemptedDate` rather than `dailyScores` or
   * `lastDailyDate`: those are only written when a run *finishes*, so checking them
   * would let a player force-quit at 0:30, relaunch, and get a fresh attempt at the
   * same seed. The whole point of a shared daily is that everyone gets one go.
   */
  dailyLocked(today = todayKey()) {
    return this.data.dailyAttemptedDate === today;
  }

  /**
   * Spend today's attempt. Called the instant the run actually starts — not when it
   * ends — and written with saveNow() rather than the debounced save() so that killing
   * the app mid-run (or a crash, or a phone call) can't roll the attempt back. Backing
   * out of the pre-run brief never reaches here, which is the intended escape hatch.
   */
  markDailyAttempted(today = todayKey()) {
    if (this.data.dailyAttemptedDate === today) return false;
    this.data.dailyAttemptedDate = today;
    this.saveNow();
    return true;
  }

  // ------------------------------------------------------------ streak

  /**
   * Streak state without mutating anything — for showing "play today to keep your streak".
   * @returns {{ streak: number, playedToday: boolean, atRisk: boolean, broken: boolean }}
   */
  streakStatus(today = todayKey()) {
    const last = this.data.lastDailyDate;
    if (!last) return { streak: 0, playedToday: false, atRisk: false, broken: false };
    const gap = daysBetween(last, today);
    return {
      streak: gap <= 1 ? this.data.streak : 0,
      playedToday: gap === 0,
      atRisk: gap === 1,          // played yesterday, today still open
      broken: gap > 1 && this.data.streak > 0,
    };
  }

  /**
   * Commit a completed daily run. Missing a day resets to 1 — no grace period, no
   * streak freeze. The brief asked for that to be honest, and a streak you can't
   * actually lose isn't a streak.
   * @returns {{ streak: number, extended: boolean, reset: boolean, milestone: number|null }}
   */
  commitDaily(today = todayKey()) {
    const last = this.data.lastDailyDate;
    let extended = false, reset = false;

    if (last === today) {
      // Replaying today's daily doesn't double-count.
      return { streak: this.data.streak, extended: false, reset: false, milestone: null };
    }
    if (last && daysBetween(last, today) === 1) {
      this.data.streak += 1;
      extended = true;
    } else {
      reset = last != null && this.data.streak > 1;
      this.data.streak = 1;
    }
    this.data.lastDailyDate = today;
    this.data.bestStreak = Math.max(this.data.bestStreak, this.data.streak);

    const milestone = MILESTONES.find(
      (m) => m.days === this.data.streak && !this.data.claimedMilestones.includes(m.days)
    );
    let awardedMilestone = milestone || null;
    if (milestone) {
      this.data.claimedMilestones.push(milestone.days);
      // The 14-night reward is also sold in the Stockpile. A player who bought Briar
      // early should not reach the milestone and receive literally nothing in that slot.
      const duplicateBonus = milestone.unlock && this.has(milestone.unlock)
        ? (milestone.duplicateShards || 0)
        : 0;
      const scrapAward = milestone.shards + duplicateBonus;
      this.data.shards += scrapAward;
      this.data.totalShardsEarned += scrapAward;
      if (milestone.unlock) this.unlock(milestone.unlock);
      if (duplicateBonus) awardedMilestone = { ...milestone, duplicateBonus };
    }

    this.saveNow();
    return { streak: this.data.streak, extended, reset, milestone: awardedMilestone };
  }

  recordRun({ isDaily, abandoned = false, date, score, wave, time, kills, shards }) {
    const d = this.data;
    d.totalRuns++;
    d.totalKills += kills;
    d.bestTime = Math.max(d.bestTime, time);
    if (!abandoned && isDaily) {
      const prev = d.dailyScores[date];
      if (!prev || score > prev.score) d.dailyScores[date] = { score, wave, time, kills };
      d.bestDailyScore = Math.max(d.bestDailyScore, score);
      // Keep history bounded; 60 days is plenty for the compare-to-yesterday screen.
      const keys = Object.keys(d.dailyScores).sort();
      while (keys.length > 60) delete d.dailyScores[keys.shift()];
    } else if (!abandoned) {
      d.bestPracticeScore = Math.max(d.bestPracticeScore, score);
    }
    d.shards += shards;
    d.totalShardsEarned += shards;
    this.saveNow();
  }

  dailyScore(dateKey) { return this.data.dailyScores[dateKey] || null; }
}

export const MILESTONES = [
  { days: 3,  shards: 150,  label: '3-night streak',  unlock: 'trail_ember', unlockName: 'Ember Lantern' },
  { days: 7,  shards: 400,  label: '7-night streak',  unlock: 'trail_prism', unlockName: 'Broken Prism' },
  { days: 14, shards: 900,  label: '14-night streak', unlock: 'weapon_axe',  unlockName: 'Fire Axe (free)', duplicateShards: 700 },
  { days: 30, shards: 2500, label: '30-night streak', unlock: 'trail_void',  unlockName: 'Cold Fire' },
];

export const save = new SaveStore();
