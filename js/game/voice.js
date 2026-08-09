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
// Shared across all three survivors. Kept under ~10 words, dry rather than informative —
// the HUD already tells you the number, so the line's job is to sound like a person who
// has been awake for far too long.

const PLAYER = {
  hurt: [
    'Teeth. Great.',
    'That one got through.',
    'Fine. That was fine.',
    'It had hands. It had hands.',
    'Rude.',
    'Okay. Okay. Moving.',
    'Bleeding. Managing.',
    'Coat took most of that.',
    'I felt that in my ribs.',
    'Still upright. Barely counts.',
    'That is going to scar.',
    'Hey — I was using that arm.',
    'Tell me that was the last one.',
    'Do that again and see.',
    'I have decided to allow that.',
    'Worth it. Probably.',
    'Bold, for something dead.',
    'Cold hands. Very cold hands.',
  ],

  levelUp: [
    'Found something useful.',
    'That will do. That will do nicely.',
    'Better. Considerably better.',
    'I am becoming a problem.',
    'Getting dangerous out here.',
    'The street is not going to like this.',
    'Yes. Give me that.',
    'Sharper. Meaner. Same coat.',
    'Now we are talking.',
    'This changes the arithmetic.',
    'Something clicked. Loudly.',
    'Add it to the pile.',
    'Somebody left this behind. Thanks.',
    'One more and I am unbearable.',
    'Compounding nicely.',
    'Scavenging pays, apparently.',
  ],

  nearDeath: [
    'This is fine. This is fine.',
    'Running on spite now.',
    'Do not look at the health bar.',
    'One more and I am a rumour.',
    'Held together by opinion.',
    'Still counts as alive.',
    'I have been worse. Recently.',
    'Nobody panic. I am panicking.',
    'Structurally: a suggestion.',
    'Almost out. Not out.',
    'Beautiful night for it.',
    'If I go, burn the house.',
    'Any moment now would be great.',
    'Down to vibes and momentum.',
    'This is the fun part, apparently.',
    'Do not tell the band.',
  ],

  death: [
    'Well. That happened.',
    'Again, then.',
    'I regret several things.',
    'The village takes this one.',
    'Put that on the church door.',
    'Unlucky. Mostly.',
    'I was doing so well.',
    'Tell them I went out swinging.',
    'That was survivable. In theory.',
    'Reset the count. Leave that part out.',
    'Worth every second.',
    'On record: unfair.',
    'Back outside. Obviously.',
    'Do not laugh. Band, do not.',
    'Ran out of street.',
    'A learning experience. Allegedly.',
  ],

  milestone: [
    'We keep showing up.',
    'That is a streak. A real one.',
    'Somebody noticed. Good.',
    'Consistency. Who knew.',
    'Adding this to my personality.',
    'Say it louder, band.',
    'Every single night. On purpose.',
    'This is the whole point.',
    'Turns out I am reliable.',
    'Streak intact. Ego intact.',
    'The village forgets. I did not.',
    'Put this one in the log.',
    'Nights stacked like firewood.',
    'Nobody handed me this.',
    'Still here. Still counting.',
    'That is discipline, technically.',
  ],

  eliteKill: [
    'Big ones fall the same.',
    'Sat down. Stayed down.',
    'That was the loud one, right?',
    'Whatever that was: retired.',
    'Loud, then quiet. Love it.',
    'Next.',
    'Send another.',
    'Back in the ground.',
  ],

  tierShift: [
    'Darker. Great. Love that.',
    'Something changed. Not for us.',
    'It is getting late.',
    'The lantern is not reaching as far.',
    'It gets worse from here.',
    'Nice village. Terrible neighbours.',
  ],
};

// Per-survivor signature lines, mixed into the shared pool so each one still sounds like
// themselves without needing three full sets.
const CORE_FLAVOUR = {
  weapon_machete: {
    hurt: ['Too close. That is on me.'],
    levelUp: ['Sharper. Everything sharper.'],
    nearDeath: ['Still in reach of it. Bad sign.'],
    death: ['I had a whole plan.'],
  },
  weapon_bow: {
    hurt: ['It got inside my range. Careless.'],
    levelUp: ['Straighter. Further. Good.'],
    nearDeath: ['Out of range and out of room.'],
    death: ['I only needed one more.'],
  },
  weapon_axe: {
    hurt: ['Mid-swing. Of course it was mid-swing.'],
    levelUp: ['Heavier. Excellent.'],
    nearDeath: ['Arms are going. Axe is not.'],
    death: ['Took a few with me.'],
  },
};

// ---------------------------------------------------------------- radio lines

const RIVAL = {
  // Shown on the nightly brief.
  dailyStart: [
    'Back again. How reliable of you.',
    "Tonight's conditions are particularly unkind.",
    'Everyone gets the same night. Only you get excuses.',
    'Try to last longer than the broadcast.',
    'I have already logged how this ends.',
    'Do enjoy. It gets worse around the middle.',
    'Same village, same dead, different excuses.',
    'Advisory: do not go out. Nobody listens.',
    'Difficulty is set to "your fault".',
  ],

  streakBroken: [
    'You missed a night. Back to one.',
    'A whole streak, undone by a Tuesday.',
    'I did not even have to do anything.',
    'Gone. All of it. Sleep well?',
    'The village forgets. I do not.',
    'You had momentum. Had.',
    'Zero is such a clean number.',
    'Come back when you mean it.',
  ],

  milestone: {
    3:  ['Three nights. Fine. That is something.'],
    7:  ['A week. I am adjusting my estimate of you.'],
    14: ['Fourteen. You are becoming a fixture.'],
    30: ['Thirty nights. I concede nothing, but... thirty.'],
  },

  runGood: [
    'That was almost impressive.',
    'Better. Do it again tomorrow.',
    'I felt something. Probably static.',
    'You beat last night. Last night was weak.',
    'Logged. Grudgingly.',
  ],

  runBad: [
    'The street barely woke up for that.',
    'I have seen fence posts last longer.',
    'Shorter than my attention span.',
    'That was a warm-up, surely.',
    'Try sprinting. It exists.',
  ],

  idle: [
    'The village refills at midnight. It always does.',
    'One night a day. That is the arrangement.',
    'I keep the log. You keep the excuses.',
  ],

  // Announcing the Butcher. The band is enjoying this.
  miniboss: [
    'Ah. I was wondering when that would wake up.',
    'That one used to have a name. Do try.',
    'It comes apart when hurt. That is the fun part.',
    'Mind what falls off it. Or do not. Your night.',
    'I would step back, if I were capable of caring.',
    'Finally, something worth logging.',
    'It has been waiting all night for you.',
    'Try to make this last more than nine seconds.',
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
