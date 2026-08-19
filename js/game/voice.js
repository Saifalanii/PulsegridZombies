// Voice: short reactive lines from the survivor and from the emergency band.
//
// Text only — no audio dialogue. Lines are picked with a bag shuffle rather than a plain
// random draw, so you see the whole pool before anything repeats. Random selection on a
// 16-line pool produces a visible repeat roughly every fourth line, which is exactly the
// thing that makes reactive barks feel cheap.
//
// Everything is rate-limited and priority-ranked in the UI layer; this module only
// decides *what* gets said.

// ---------------------------------------------------------------- survivor lines
//
// Shared by HOLT across every loadout. Kept under ~10 words, dry rather than informative —
// the HUD already tells you the number, so the line's job is to sound like a person who
// has been awake for far too long.

const PLAYER = {
  hurt: [
    'That got through.',
    'Too close.',
    'Keep moving.',
    'Coat took some of it.',
    'Felt that in my ribs.',
    'Still upright.',
    'Bleeding. Managing.',
    'Not again.',
  ],

  levelUp: [
    'Found something useful.',
    'That will help.',
    'Better prepared.',
    'Add it to the kit.',
    'This changes the odds.',
    'Useful. Keep it.',
    'Ready for the next round.',
    'One more advantage.',
  ],

  nearDeath: [
    'Almost out. Not out.',
    'Need room. Now.',
    'One hit left in me.',
    'Find an opening.',
    'Still standing.',
    'Get to the light.',
  ],

  death: [
    'The city takes this one.',
    'Ran out of room.',
    'Not far enough.',
    'The street closed in.',
    'Log the attempt.',
    'I will remember that turn.',
  ],

  milestone: [
    'We keep showing up.',
    'The city forgets. I did not.',
    'Put this one in the log.',
    'Still here. Still counting.',
    'Another piece survived the reset.',
    'The signal left a trail.',
  ],

  eliteKill: [
    'Big ones fall the same.',
    'Back in the ground.',
    'That one is finished.',
    'The street is clear.',
    'Big target. Down.',
    'Keep moving.',
  ],

  tierShift: [
    'The light is fading.',
    'It is getting late.',
    'The lantern is not reaching as far.',
    'Stay near the open streets.',
    'The dark is closing in.',
  ],
};

// Loadout-specific lines, mixed into Holt's shared pool so changing weapons changes the
// immediate concerns without silently changing the protagonist.
const CORE_FLAVOUR = {
  weapon_machete: {
    hurt: ['Too close.'],
    levelUp: ['The edge is better.'],
    nearDeath: ['Need more reach.'],
    death: ['Could not make room.'],
  },
  weapon_bow: {
    hurt: ['Too close for the bow.'],
    levelUp: ['Straighter. Further.'],
    nearDeath: ['No room to draw.'],
    death: ['The line broke.'],
  },
  weapon_axe: {
    hurt: ['Caught between swings.'],
    levelUp: ['Better balance.'],
    nearDeath: ['Arms are giving out.'],
    death: ['The swing came too late.'],
  },
};

// ---------------------------------------------------------------- radio lines

const RIVAL = {
  // Shown on the nightly brief.
  dailyStart: [
    'You came back remembering. Good.',
    'The streets reset. The locked doors do not.',
    'Find what the city failed to erase.',
    'The emergency band is still open.',
    'Your Safehouse kept what you carried in.',
    'Follow the marked supplies. They were meant for you.',
  ],

  streakBroken: [
    'You missed a night. Back to one.',
    'The old streak is closed.',
    'The log starts again tonight.',
    'A missed night breaks the chain.',
  ],

  milestone: {
    3:  ['Three routes logged. The signal is holding.'],
    7:  ['Seven nights. The city has started to notice.'],
    14: ['Fourteen nights. The axe cache is open.'],
    30: ['Thirty nights. The loop still remembers you.'],
  },

  runGood: [
    'That was your strongest night yet.',
    'The new mark is logged.',
    'You held longer this time.',
    'Return tomorrow. The log will be waiting.',
  ],

  runBad: [
    'The route closed early.',
    'The log is short tonight.',
    'Use the next practice run to learn the streets.',
    'The attempt is recorded.',
  ],

  idle: [
    'The city rolls back when you fall. It always does.',
    'The signal crosses the reset. So do you.',
    'The doors remember their keys.',
  ],

  // Announcing the Butcher. The band is enjoying this.
  miniboss: [
    'Large movement on the street ahead.',
    'It comes apart when hurt. Watch what falls off.',
    'Do not stay inside the slam radius.',
    'The large one is entering the city.',
    'Clear what it sheds before striking again.',
    'This is the part the earlier rounds prepared you for.',
  ],
};

// ---------------------------------------------------------------- bag shuffle

class Bag {
  constructor(items) { this.items = items.slice(); this.queue = []; }
  next() {
    if (!this.items.length) return null;
    if (!this.queue.length) {
      this.queue = this.items.slice();
      // Fisher-Yates on cosmetic text: Math.random is correct here, never a seeded
      // stream — barks must not be able to perturb a Daily Run.
      for (let i = this.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
      }
      // Avoid the seam where a reshuffle repeats the line that just played.
      if (this.queue.length > 1 && this.queue[this.queue.length - 1] === this._last) {
        this.queue.unshift(this.queue.pop());
      }
    }
    this._last = this.queue.pop();
    return this._last;
  }
}

export class Voice {
  constructor() {
    this.bags = new Map();
    this.coreId = 'weapon_machete';
    // Tracks which survivor the player bags were actually built for. This must not be
    // inferred from bags.size — the same Map holds the radio's bags, so any radio line
    // requested first would make the player bags look already-built and they'd never be
    // created at all.
    this._builtCore = null;
  }

  /** Rebuild the player bags for the equipped survivor (shared pool + flavour lines). */
  setCore(coreId) {
    if (this._builtCore === coreId) return;
    this.coreId = coreId;
    this._builtCore = coreId;
    for (const key of Object.keys(PLAYER)) {
      const extra = (CORE_FLAVOUR[coreId] && CORE_FLAVOUR[coreId][key]) || [];
      this.bags.set('p:' + key, new Bag(PLAYER[key].concat(extra)));
    }
  }

  _bag(key, items) {
    let b = this.bags.get(key);
    if (!b) { b = new Bag(items); this.bags.set(key, b); }
    return b;
  }

  /** @param {keyof PLAYER} kind */
  player(kind) {
    this.setCore(this.coreId);
    const b = this.bags.get('p:' + kind);
    return b ? b.next() : null;
  }

  rival(kind) {
    const items = RIVAL[kind];
    if (!items || !Array.isArray(items)) return null;
    return this._bag('r:' + kind, items).next();
  }

  rivalMilestone(days) {
    const lines = RIVAL.milestone[days];
    if (lines) return lines[Math.floor(Math.random() * lines.length)];
    return this.rival('milestone3') || 'Still here, then.';
  }

  /** The band's verdict on a finished night, relative to the player's own history. */
  rivalVerdict(score, prevBest, seconds) {
    if (seconds < 45) return this.rival('runBad');
    if (prevBest > 0 && score >= prevBest) return this.rival('runGood');
    if (prevBest > 0 && score < prevBest * 0.45) return this.rival('runBad');
    return this.rival(score > 0 && seconds > 150 ? 'runGood' : 'runBad');
  }
}

export const voice = new Voice();
export { PLAYER as PLAYER_LINES, RIVAL as RIVAL_LINES };
