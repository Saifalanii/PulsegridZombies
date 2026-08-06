// The night simulation: the village, the dead, collision, scoring, drawing.
//
// Everything lives in fixed-capacity pools created once in the constructor. The update
// path allocates nothing — no closures, no temporary vectors, no array literals — so a
// four-minute run never triggers a GC pause.

import { Pool } from '../core/pool.js';
import { Rng } from '../core/rng.js';
import { clamp, TAU, damp, formatTime } from '../core/math.js';
import { Particles, P_SHARD } from '../fx/particles.js';
import { juice } from '../fx/juice.js';
import { audio } from '../core/audio.js';
import { save } from '../core/save.js';
import {
  Palette, HAZARD_RGB, BLOOD_RGB, HEAL_RGB, SHARD_RGB, XP_RGB, rgba, trailColor, TIERS,
} from './palette.js';
import { ENEMIES, WEAPONS, UPGRADES, ELITE_TIMES, MINIBOSS_TIMES, metaStats, xpForLevel } from './defs.js';
import { World, TS } from './world.js';
import {
  LpcSheet, createAnim, resetAnim, updateAnim, updateClipOnly, drawAnim,
  playClip, clipHitReady, dirFromVector, CLIPS,
} from '../fx/sprites.js';

// Loaded once per page (not per run) and shared by every Run instance, including the
// menu's ambient background run — re-decoding ~350KB of spritesheet on every "Play" tap
// would be wasteful and would flash a blank frame while it re-decoded.
//
// Two separate exports of the same character, each carrying a different weapon in a
// different animation slot — found by actually looking at the rendered rows, not
// assumed from either filename:
//
//   player_hero.png     — oversized 128px rows carry the sword swing (see sprites.js's
//                          `bigslash`/`swordcarry`). The standard-geometry rows are
//                          body-only, same as every other sheet.
//   player_hero_alt.png — standard geometry throughout, but rows 4-7 (LPC's "thrust"
//                          slot, all 4 directions, 8 frames each) carry a full bow draw
//                          with an arrow nocked. Nothing else on this sheet shows a
//                          weapon.
//
// A third export, player_hero_axe.png, carries the Fire Axe's swing (sprites.js's
// `axechop`/`axestand`) as a full 4-direction block — same layout as the sword's, just
// in larger 192px cells.
//
// Which sheet gets drawn is decided per-frame in _drawPlayer by which weapon is
// equipped — see PLAYER_SHEET_BOW/PLAYER_SHEET_AXE below and _recomputeDerived.
const PLAYER_SHEET = new LpcSheet('assets/characters/player_hero.png', { big: true });
const PLAYER_SHEET_BOW = new LpcSheet('assets/characters/player_hero_alt.png');
const PLAYER_SHEET_AXE = new LpcSheet('assets/characters/player_hero_axe.png', { big: true });
const SHEETS = {
  green:   new LpcSheet('assets/characters/zombie_green.png'),
  rotting: new LpcSheet('assets/characters/zombie_rotting.png'),
  shadow:  new LpcSheet('assets/characters/zombie_shadow.png'),
  plague:  new LpcSheet('assets/characters/zombie_plague.png'),
};

/** World height of a standard 64px LPC frame. Two village tiles — see world.js. */
const SPRITE_SIZE = 64;

const TIER_DURATION = 55;      // seconds per night phase
// 120 on screen is already past the point of readability; the cap exists so a stalled
// player can't drive the frame time into the floor.
const MAX_ENEMIES = 120;
const MAX_BULLETS = 160;
const MAX_EBULLETS = 220;
const MAX_PICKUPS = 320;
const MAX_CORPSES = 44;
const COMBO_WINDOW = 2.4;

// Enemy attack phases. Separate from `state`, which movement behaviours use.
const A_NONE = 0, A_WINDUP = 1, A_RECOVER = 2;

let UID = 1;

// ------------------------------------------------------------------ factories

const mkEnemy = () => ({
  uid: 0, def: null, key: '', x: 0, y: 0, vx: 0, vy: 0, hp: 1, maxHp: 1, r: 10,
  flash: 0, state: 0, stateT: 0, shootT: 0, callT: 0,
  phase: 0, spawnT: 0, elite: false, dmgScale: 1, speedScale: 1,
  split: false, shielded: false, parentUid: 0, sweepT: 0,
  atkState: A_NONE, atkT: 0, atkCd: 0, groanT: 0,
  // Wall-following state — see the stuck check in _updateEnemies.
  sampleT: 0, lastX: 0, lastY: 0, detourT: 0, detour: 0,
  // Created once per pool slot rather than per spawn — object churn in the hot path is
  // exactly what the pooling exists to avoid.
  anim: createAnim(), _idx: 0,
});

const mkBullet = () => ({
  x: 0, y: 0, vx: 0, vy: 0, life: 0, dmg: 0, pierce: 0, size: 4,
  crit: false, h0: 0, h1: 0, h2: 0, h3: 0, hn: 0, _idx: 0,
  arrow: false,   // drawn as a real arrow (glowArrow) instead of a glow streak
});

const mkEBullet = () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, dmg: 0, r: 5, rot: 0, _idx: 0 });

const mkPickup = () => ({
  x: 0, y: 0, vx: 0, vy: 0, type: 0, value: 0, life: 0, r: 5, born: 0, _idx: 0,
});
const PK_XP = 0, PK_SHARD = 1, PK_HEAL = 2;

/**
 * A body left on the ground.
 *
 * Corpses get their own pool rather than lingering in the enemy pool. A dead thing
 * occupying a live slot would let a busy street starve the director of spawns, and the
 * enemy update path would have to test `dead` on every single iteration of every loop
 * that touches enemies. This way the enemy pool only ever holds things that are trying
 * to kill you.
 */
const mkCorpse = () => ({
  x: 0, y: 0, sheet: null, size: 64, filter: null, life: 0, maxLife: 1,
  anim: createAnim(), _idx: 0,
});

// ------------------------------------------------------------------ Run

export class Run {
  constructor(config) {
    this.cfg = config;
    this.mods = config.mods;

    // Three independent RNG streams, all derived from the one seed. Splitting them is
    // what makes the Daily Run genuinely shared:
    //
    //   rng        director only, consumed strictly on the spawn timer. Nothing the
    //              player does can advance it, so the wave composition, spawn angles
    //              and elite schedule are byte-identical for everyone that day.
    //   rngUpgrade level-up offers. Advanced once per level, so the choices at level N
    //              are the same for every player — builds compete on decisions, not luck.
    //   rngAux     player-driven rolls: crits, drops, bloater spill, horde calls.
    //              Kept off the director stream so a good or bad player can't desync
    //              the wave pattern for themselves.
    //
    // The village generator gets a *fourth* stream of its own (inside World), consumed
    // entirely during construction. That keeps map generation from shifting any of the
    // three above — the same daily seed produces the same village and the same waves.
    //
    // Purely cosmetic randomness (particle jitter, barks) stays on Math.random — it can
    // never affect the outcome, so it must never touch a seeded stream.
    this.rng = config.rng;
    this.rngUpgrade = new Rng(config.seed ^ 0x9e3779b9);
    this.rngAux = new Rng(config.seed ^ 0x85ebca6b);

    const meta = metaStats(save);
    this.meta = meta;

    // Bigger than the original arena: a village needs streets to run down and corners to
    // be cut off in, and 1500 units is barely 47 tiles across.
    const arenaSize = Math.round(2400 * this.mods.arenaScale);
    this.arena = { x: -arenaSize / 2, y: -arenaSize / 2, w: arenaSize, h: arenaSize };
    this.world = new World(this.arena, config.seed);

    this.enemies = new Pool(MAX_ENEMIES, mkEnemy);
    this.bullets = new Pool(MAX_BULLETS, mkBullet);
    this.ebullets = new Pool(MAX_EBULLETS, mkEBullet);
    this.pickups = new Pool(MAX_PICKUPS, mkPickup);
    this.corpses = new Pool(MAX_CORPSES, mkCorpse);
    this.particles = new Particles(900);

    this.palette = new Palette();
    this.palette.setColorblind(save.data.settings.colorblind);

    const weapon = WEAPONS[save.data.equippedWeapon] || WEAPONS.weapon_machete;
    this.weapon = weapon;
    this.trailId = save.data.equippedTrail;

    this.stats = {
      maxHp: Math.round((100 + meta.hp)),
      moveSpeed: 224 * meta.spd * this.mods.playerSpeed,
      moveMul: 1,
      dmgMul: meta.dmg * this.mods.playerDmg,
      rateMul: 1, speedMul: 1, rangeMul: 1, sizeMul: 1,
      count: weapon.count, spread: weapon.spread, pierce: weapon.pierce,
      magnet: 82 * meta.magnet,
      orbitals: 0, crit: 0.03, homing: 0,
      dashCd: 1.55, dashCharges: 1 + meta.dashCharges,
      thorns: 0, regen: 0, shardMul: meta.shard * this.mods.shardMul,
      xpMul: meta.xp * this.mods.xpMul,
      nova: this.mods.forceNova, shieldMax: 0, shieldRecharge: 0,
    };

    // Drop the survivor on a walkable tile — the centre of the map is the village
    // square, but a house or the pond could still have been generated on top of it.
    this.world.nearestOpen(0, 0, 14);
    this.player = {
      x: this.world._ox ?? 0, y: this.world._oy ?? 0, vx: 0, vy: 0,
      hp: Math.round(this.stats.maxHp * this.mods.startHpMul),
      r: 13, aim: -Math.PI / 2, fireCd: 0,
      dashCd: 0, dashLeft: this.stats.dashCharges, dashT: 0, dashDx: 0, dashDy: 0,
      iframes: 0, shield: 0, shieldT: 0, regenAcc: 0,
      level: 1, xp: 0, xpNext: xpForLevel(1),
      alive: true, usedRevive: false, trailAcc: 0, hurtFlash: 0,
      atkT: 0, atkFired: false, stepAcc: 0,
    };
    this.playerAnim = createAnim();

    this.upgradeLevels = Object.create(null);
    this.time = 0;
    this.score = 0;
    this.kills = 0;
    this.runShards = 0;
    this.combo = 0;
    this.comboT = 0;
    this.bestCombo = 0;
    this.tier = 0;
    this.pendingLevelUps = 0;
    this.intensity = 0;
    this.over = false;
    this.orbitAngle = 0;
    this.orbitHitT = 0;
    this._aoeDepth = 0;

    // Director state
    this.spawnT = 0.9;
    this.eliteIdx = 0;
    this.minibossIdx = 0;
    this.eliteAlive = 0;

    // Preallocated depth-sort scratch for the draw pass. Two parallel arrays rather than
    // an array of objects: no allocation, and the sort only moves 32-bit values.
    this._sortIdx = new Int32Array(MAX_ENEMIES + MAX_CORPSES + 2);
    this._sortY = new Float32Array(MAX_ENEMIES + MAX_CORPSES + 2);

    this._seedMotes();
    this._recomputeDerived();
  }

  _seedMotes() {
    this.particles.clearMotes();
    const a = this.arena;
    for (let i = 0; i < 70; i++) {
      this.particles.mote(a.x + Math.random() * a.w, a.y + Math.random() * a.h, this.palette.mote);
    }
  }

  /**
   * Fold the stat block into the numbers the hot path reads.
   *
   * The projectile stats mean something different on a melee weapon: `speedMul` and
   * `rangeMul` extend reach instead of flight, `count` widens the swing arc instead of
   * adding arrows, and `pierce` deepens it. That's what stops half the upgrade pool from
   * being a dead offer when you're carrying a machete.
   */
  _recomputeDerived() {
    const w = this.weapon, s = this.stats;
    this.fireInterval = 1 / (w.rate * s.rateMul);
    this.bulletDmg = w.dmg * s.dmgMul;
    this.melee = !!w.melee;

    if (this.melee) {
      this.meleeReach = w.reach * s.rangeMul * (1 + s.pierce * 0.12);
      this.meleeArc = Math.min(Math.PI * 1.15, w.arc * (1 + (s.count - 1) * 0.18));
      this.bulletSpeed = 1;      // only used to lead the aim target; harmless at 1
      this.bulletRange = this.meleeReach;
      this.bulletSize = 0;
    } else {
      this.meleeReach = 0;
      this.meleeArc = 0;
      this.bulletSpeed = w.speed * s.speedMul;
      this.bulletRange = w.range * s.rangeMul;
      this.bulletSize = w.size * s.sizeMul;
    }
    // How far away the auto-attack is willing to commit.
    this.engageRange = this.melee ? this.meleeReach * 1.05 : this.bulletRange * 1.25;

    // Carry the weapon between attacks. The 64px walk/idle rows are body-only on every
    // sheet — the weapon only ever appears in a dedicated attack block — so without this
    // a survivor walks empty-handed and the weapon pops into existence for the duration
    // of a swing or a shot.
    //
    // Melee and the bow need different *sheets*, not just different clips: the sword
    // lives in player_hero.png's oversized rows, the bow in player_hero_alt.png's
    // standard "thrust" rows (see the note above PLAYER_SHEET_BOW). `this.bowEquipped`
    // is cached here rather than recomputed in the hot draw path, and `this.weapon ===
    // WEAPONS.weapon_bow` is the one ranged weapon that exists today — if a second
    // ranged weapon is ever added with its own sheet, this identity check needs to
    // become a lookup instead of a single flag. Same reasoning for axeEquipped/the
    // Fire Axe below, checked ahead of the generic `this.melee` branch since the axe
    // is melee too but needs its own sheet, not the sword's.
    this.bowEquipped = this.weapon === WEAPONS.weapon_bow;
    this.axeEquipped = this.weapon === WEAPONS.weapon_axe;
    if (this.playerAnim) {
      if (this.axeEquipped) {
        // Like the bow: no walking-with-axe art exists on this sheet, only the swing's
        // own first frame reused as a stand pose (see sprites.js's `axestand`) — so,
        // same limitation, the axe is visible standing still and vanishes mid-stride.
        // The stand pose is directional, though, so a waiting survivor at least holds
        // the axe facing whatever they're aiming at.
        this.playerAnim.walkClip = null;
        this.playerAnim.idleClip = 'axestand';
      } else if (this.melee && PLAYER_SHEET.big) {
        this.playerAnim.walkClip = 'swordcarry';
        this.playerAnim.idleClip = 'swordstand';
      } else if (this.bowEquipped) {
        // No walking-with-bow art exists, only the standing draw pose — the bow is
        // visible while stationary and vanishes mid-stride, same limitation the sword
        // had before swordcarry, just not yet solved for this weapon.
        this.playerAnim.walkClip = null;
        this.playerAnim.idleClip = 'bowstand';
      } else {
        this.playerAnim.walkClip = null;
        this.playerAnim.idleClip = null;
      }
    }
  }

  // ---------------------------------------------------------------- upgrades

  /** Three distinct, non-maxed upgrades. Uses the run rng so the daily offers match. */
  rollUpgradeChoices(n = 3) {
    const avail = [], weights = [];
    for (const u of UPGRADES) {
      const lvl = this.upgradeLevels[u.id] || 0;
      if (lvl >= u.max) continue;
      avail.push(u);
      // Slight bias toward things already invested in, so builds converge.
      weights.push(u.weight * (lvl > 0 ? 1.25 : 1));
    }
    const out = [];
    for (let i = 0; i < n && avail.length; i++) {
      const pick = this.rngUpgrade.weighted(avail, weights);
      const idx = avail.indexOf(pick);
      avail.splice(idx, 1); weights.splice(idx, 1);
      const lvl = (this.upgradeLevels[pick.id] || 0) + 1;
      out.push({ def: pick, level: lvl, desc: pick.desc(lvl, this.melee) });
    }
    return out;
  }

  applyUpgrade(choice) {
    const lvl = (this.upgradeLevels[choice.def.id] || 0) + 1;
    this.upgradeLevels[choice.def.id] = lvl;
    choice.def.apply(this.stats, this.player, lvl);
    if (choice.def.id === 'shield') { this.player.shield = this.stats.shieldMax; }
    if (choice.def.id === 'dashmaster' && lvl === 2) this.player.dashLeft += 1;
    this.player.hp = Math.min(this.player.hp, this.stats.maxHp);
    this._recomputeDerived();
  }

  // ---------------------------------------------------------------- update

  update(dt, input) {
    if (this.over) {
      // Keep the world alive behind the death screen — the body finishes falling, the
      // blood keeps settling.
      this.particles.update(dt, this.arena);
      this.palette.update(dt);
      updateAnim(this.playerAnim, dt, 0, 0);
      this._updateCorpses(dt);
      return;
    }

    this.time += dt;
    this._updateTier();
    this.palette.update(dt);

    this._updatePlayer(dt, input);
    this._director(dt);
    this._updateEnemies(dt);
    this._updateCorpses(dt);
    this._updateBullets(dt);
    this._updateEBullets(dt);
    this._updatePickups(dt);
    this._updateOrbitals(dt);
    this.particles.update(dt, this.arena);

    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 0;
    }

    this._updateIntensity(dt);
  }

  _updateTier() {
    const t = Math.min(TIERS.length - 1, Math.floor(this.time / TIER_DURATION));
    if (t !== this.tier) {
      this.tier = t;
      this.palette.goToTier(t);
      this._seedMotes();
      audio.tierShift();
      juice.tierShift();
      this.onTierChange?.(TIERS[t]);
    }
  }

  /** Danger heuristic -> music intensity + HUD tension. */
  _updateIntensity(dt) {
    const p = this.player;
    let near = 0;
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      const dx = e.x - p.x, dy = e.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 340 * 340) near += e.elite ? 5 : 1;
    }
    const hpFactor = 1 - p.hp / this.stats.maxHp;
    const target = clamp(
      this.time / 300 * 0.45 + near / 26 * 0.35 + hpFactor * 0.25 + (this.eliteAlive ? 0.2 : 0),
      0, 1
    );
    this.intensity = damp(this.intensity, target, 1.4, dt);
    audio.setIntensity(this.intensity);
  }

  // ---------------------------------------------------------------- player

  _updatePlayer(dt, input) {
    const p = this.player, s = this.stats;
    if (!p.alive) return;

    p.iframes = Math.max(0, p.iframes - dt);
    p.hurtFlash = Math.max(0, p.hurtFlash - dt * 4);
    p.dashCd = Math.max(0, p.dashCd - dt);

    if (p.dashCd === 0 && p.dashLeft < s.dashCharges) {
      p.dashLeft++;
      if (p.dashLeft < s.dashCharges) p.dashCd = s.dashCd;
    }

    // --- sprint (was "dash") ---
    if (input.consumeDash() && p.dashLeft > 0 && p.dashT <= 0) {
      let dx = input.moveX, dy = input.moveY;
      if (dx === 0 && dy === 0) { dx = Math.cos(p.aim); dy = Math.sin(p.aim); }
      const len = Math.hypot(dx, dy) || 1;
      p.dashDx = dx / len; p.dashDy = dy / len;
      p.dashT = 0.19;
      p.iframes = Math.max(p.iframes, 0.30);
      p.dashLeft--;
      if (p.dashCd === 0) p.dashCd = s.dashCd;
      audio.dash();
      juice.dash();
      const trail = trailColor(this.trailId, this.time);
      this.particles.burst(p.x, p.y, 10, 200, trail,
        { life: 0.3, size: 2.6, dir: Math.atan2(-p.dashDy, -p.dashDx), spread: 1.5 });

      // The LPC `jump` block (a tuck-and-roll, not a leap — there's no dash pose to
      // draw from) reads as a dive. playClip locks the anim for its own duration
      // rather than dashT, so a short last-charge dash doesn't truncate the roll.
      playClip(this.playerAnim, 'jump', 0, dirFromVector(p.dashDx, p.dashDy));
    }

    if (p.dashT > 0) {
      p.dashT -= dt;
      const dashSpeed = s.moveSpeed * 3.4;
      p.vx = p.dashDx * dashSpeed;
      p.vy = p.dashDy * dashSpeed;
    } else {
      const tvx = input.moveX * s.moveSpeed;
      const tvy = input.moveY * s.moveSpeed;
      p.vx = damp(p.vx, tvx, 16, dt);
      p.vy = damp(p.vy, tvy, 16, dt);
    }

    // Movement is resolved against the village collision bitmap, so houses, fences,
    // trees and the pond are real walls rather than decoration.
    this.world.moveResolved(p, p.r, p.x + p.vx * dt, p.y + p.vy * dt);

    const speed = Math.hypot(p.vx, p.vy);

    // --- footfalls: dust, and a step sound on a distance interval ---
    p.stepAcc += speed * dt;
    if (p.stepAcc > 46) {
      p.stepAcc -= 46;
      audio.footstep();
      this.particles.trail(p.x, p.y + 10, this.palette.bgGrid, 3.2, 0.3);
    }

    // --- aim ---
    const target = this._findAimTarget();
    let desiredAim = p.aim;
    if (input.manualAim && input.aimMag > 0.1) {
      desiredAim = Math.atan2(input.aimY, input.aimX);
    } else if (target) {
      if (this.melee) {
        desiredAim = Math.atan2(target.y - p.y, target.x - p.x);
      } else {
        // Lead the target so fast movers don't require the player to compensate.
        const tof = Math.hypot(target.x - p.x, target.y - p.y) / this.bulletSpeed;
        desiredAim = Math.atan2(target.y + target.vy * tof - p.y, target.x + target.vx * tof - p.x);
      }
    } else if (speed > 20) {
      desiredAim = Math.atan2(p.vy, p.vx);
    }
    let d = ((desiredAim - p.aim + Math.PI * 3) % TAU) - Math.PI;
    p.aim += d * Math.min(1, dt * 22);

    // --- attack ---
    //
    // The swing/shot is an animation with a contact frame, not an instantaneous event.
    // Pulling the trigger starts the clip; the damage lands when the clip reaches its
    // `hit` fraction. That is what makes the weapon feel like it has weight, and it's
    // the same contract the zombies' attacks run on.
    p.fireCd -= dt;
    const wantsFire = !!target;   // always automatic — no semi-auto/manual-fire mode
    if (p.fireCd <= 0 && wantsFire && p.atkT <= 0) {
      this._startAttack();
    }

    if (p.atkT > 0) {
      p.atkT -= dt;
      if (!p.atkFired && clipHitReady(this.playerAnim)) {
        p.atkFired = true;
        if (this.melee) this._meleeSwing(); else this._fire();
      }
    }

    updateAnim(this.playerAnim, dt, p.vx, p.vy);
    if (!this.playerAnim.locked && p.atkT <= 0) {
      // Face the way you're aiming while stationary, so the survivor doesn't stand with
      // their back to the thing that's about to eat them.
      if (speed <= 8 && target) this.playerAnim.dir = dirFromVector(Math.cos(p.aim), Math.sin(p.aim));
    }

    // --- padding / recovery ---
    if (s.shieldMax > 0 && p.shield < s.shieldMax) {
      p.shieldT -= dt;
      if (p.shieldT <= 0) {
        p.shield = s.shieldMax;
        this.particles.ring(p.x, p.y, 16, 46, 0.5, this.palette.accent, 3);
        audio.pickup();
      }
    }
    if (s.regen > 0 && p.hp < s.maxHp) {
      p.regenAcc += s.regen * dt;
      while (p.regenAcc >= 1) {
        p.regenAcc -= 1;
        p.hp = Math.min(s.maxHp, p.hp + 1);
      }
    }
  }

  _startAttack() {
    const p = this.player;
    // Clip duration is capped so a heavily upgraded attack rate doesn't outrun the
    // animation into a blur, and so a slow weapon's swing doesn't crawl.
    const dur = clamp(this.fireInterval * 0.8, 0.24, 0.6);
    playClip(this.playerAnim, this.weapon.clip, dur,
             dirFromVector(Math.cos(p.aim), Math.sin(p.aim)));
    p.atkT = dur;
    p.atkFired = false;
    p.fireCd = this.fireInterval;
    // Recorded swing for the player only — audio.swing() is also the zombies' wind-up.
    if (this.melee) audio.swordSwing(); else audio.shoot(1);
  }

  /** Nearest enemy inside engagement range; elites get a distance discount. */
  _findAimTarget() {
    const p = this.player;
    let best = null, bestD = Infinity;
    const maxD = this.engageRange + 24;
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      if (e.spawnT > 0) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (e.elite) d2 *= 0.45;
      if (d2 < bestD && d2 < (maxD + e.r) * (maxD + e.r)) { bestD = d2; best = e; }
    }
    return best;
  }

  /**
   * Melee contact. A cone, not a point: every body inside `meleeArc` of the aim
   * direction and within reach takes the hit at once, which is what makes a swing feel
   * like a swing and gives crowd control a reason to exist.
   */
  _meleeSwing() {
    const p = this.player, s = this.stats;
    const reach = this.meleeReach;
    const half = this.meleeArc / 2;
    const ca = Math.cos(p.aim), sa = Math.sin(p.aim);
    const crit = this.rngAux.next() < s.crit;
    const dmg = this.bulletDmg * (crit ? 2.2 : 1);
    let hits = 0;

    for (let i = this.enemies.active - 1; i >= 0; i--) {
      if (i >= this.enemies.active) { i = this.enemies.active; continue; }
      const e = this.enemies.items[i];
      if (!e || e.spawnT > 0) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist > reach + e.r) continue;
      // Dot product against the aim vector, converted to an angle. Cheaper than atan2
      // per enemy and exactly as accurate for a threshold test.
      if ((dx / dist) * ca + (dy / dist) * sa < Math.cos(half)) continue;

      hits++;
      const knock = this.weapon.knock;
      e.vx += (dx / dist) * knock;
      e.vy += (dy / dist) * knock;
      this._spray(e.x, e.y, dx / dist, dy / dist, crit ? 16 : 9);
      this._hurtEnemy(e, i, dmg, crit);
    }

    // The arc itself, drawn as a short-lived sweep of blood-flecked motes so a miss
    // still reads as a swing rather than nothing happening.
    for (let k = 0; k < 7; k++) {
      const a = p.aim - half + (k / 6) * this.meleeArc;
      this.particles.spark(p.x + ca * 8, p.y + sa * 8,
        Math.cos(a) * reach * 2.4, Math.sin(a) * reach * 2.4,
        0.14, 2.4, hits ? BLOOD_RGB : this.palette.primaryDim);
    }
    if (hits) { audio.hit(); juice.addShake(1.6); }
    juice.addShake(0.5);
  }

  _fire() {
    const p = this.player, s = this.stats;
    const n = s.count;
    const spread = s.spread;
    for (let i = 0; i < n; i++) {
      const b = this.bullets.spawn();
      if (!b) break;
      const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * spread * 2;
      const a = p.aim + off + (this.rngAux.next() - 0.5) * 0.02;
      const crit = this.rngAux.next() < s.crit;
      b.x = p.x + Math.cos(a) * (p.r + 6);
      b.y = p.y + Math.sin(a) * (p.r + 6);
      b.vx = Math.cos(a) * this.bulletSpeed;
      b.vy = Math.sin(a) * this.bulletSpeed;
      b.life = this.bulletRange / this.bulletSpeed;
      b.dmg = this.bulletDmg * (crit ? 2.2 : 1);
      b.crit = crit;
      b.pierce = s.pierce;
      b.size = this.bulletSize * (crit ? 1.25 : 1);
      b.hn = 0;
      b.arrow = this.bowEquipped;
    }
    audio.bowRelease();
    juice.addShake(0.3);
  }

  damagePlayer(amount, sourceX, sourceY) {
    const p = this.player;
    if (!p.alive || p.iframes > 0) return;

    if (p.shield > 0) {
      p.shield--;
      p.shieldT = this.stats.shieldRecharge;
      p.iframes = 0.55;
      this.particles.ring(p.x, p.y, 18, 78, 0.42, this.palette.accent, 4);
      audio.pickup();
      juice.addShake(5); juice.addChroma(0.3);
      return;
    }

    p.hp -= amount;
    p.iframes = 0.85;
    p.hurtFlash = 1;
    audio.playerHurt();
    juice.playerHurt();
    this.particles.burst(p.x, p.y - 12, 18, 190, BLOOD_RGB, { life: 0.55, size: 3.2 });
    this.particles.text(p.x, p.y - 42, `-${Math.round(amount)}`, BLOOD_RGB, 0.8, 18);

    if (this.stats.thorns > 0) this._shockwave(p.x, p.y, 170 * this.stats.thorns, 26 * this.stats.thorns);
    this.onHurt?.();

    // Getting hit breaks your combo. Aggression should carry risk.
    this.combo = 0; this.comboT = 0;

    if (p.hp <= 0) {
      if (this.meta.revive && !p.usedRevive) {
        p.usedRevive = true;
        p.hp = Math.round(this.stats.maxHp * 0.45);
        p.iframes = 2.2;
        this._shockwave(p.x, p.y, 340, 90);
        audio.levelUp();
        juice.bigKill();
        this.onRevive?.();
      } else {
        p.hp = 0;
        p.alive = false;
        this.over = true;
        // The survivor's own collapse, using the same six frames the dead use. There is
        // no separate death animation in LPC and there does not need to be.
        playClip(this.playerAnim, 'hurt', 1.0);
        this.particles.burst(p.x, p.y - 10, 40, 260, BLOOD_RGB, { life: 1.3, size: 4 });
        juice.bigKill();
        audio.gameOver();
        this.onGameOver?.();
      }
    } else {
      // A flinch, not a collapse — the first three frames of the hurt row only.
      if (!this.playerAnim.locked || this.playerAnim.clip !== 'hurt') {
        playClip(this.playerAnim, 'flinch', 0.26);
        p.atkT = 0;
      }
    }
  }

  _shockwave(x, y, radius, dmg) {
    this.particles.ring(x, y, 10, radius, 0.5, this.palette.accent, 6);
    this._areaDamage(x, y, radius, dmg, 0, 340);
    juice.addShake(6);
  }

  /**
   * Damage every enemy in a radius.
   *
   * Two hazards this has to handle. First, killing inside the loop calls releaseAt,
   * which swap-removes and reorders the pool underneath us — so the index is re-clamped
   * every iteration. Second, a kill can trigger Rot Bloom, which calls back into here;
   * without `_aoeDepth` that recurses until the stack blows (guaranteed, not theoretical,
   * once the VOLATILE mutator forces blooms on). Two levels of chain reaction is plenty
   * of spectacle; beyond that it just stops.
   */
  _areaDamage(x, y, radius, dmg, excludeUid = 0, knockback = 0) {
    if (this._aoeDepth >= 2) return;
    this._aoeDepth = (this._aoeDepth || 0) + 1;
    const r2 = radius * radius;
    for (let i = this.enemies.active - 1; i >= 0; i--) {
      if (i >= this.enemies.active) { i = this.enemies.active; continue; }
      const e = this.enemies.items[i];
      if (!e || e.uid === excludeUid || e.spawnT > 0) continue;
      const dx = e.x - x, dy = e.y - y;
      if (dx * dx + dy * dy >= r2) continue;
      if (knockback) {
        const l = Math.hypot(dx, dy) || 1;
        const push = knockback / (1 + l / 90);
        e.vx += (dx / l) * push; e.vy += (dy / l) * push;
      }
      this._hurtEnemy(e, i, dmg, false);
    }
    this._aoeDepth--;
  }

  // ---------------------------------------------------------------- director

  _director(dt) {
    const m = this.mods;

    // Spawn cadence ramps from ~1.3s down to ~0.26s over five minutes.
    const t = this.time;
    const base = Math.max(0.26, 1.35 - t * 0.0036);
    const interval = base / m.spawnRate;

    this.spawnT -= dt;
    // Deliberately NOT gated on enemy count. The pool cap is enforced inside
    // _spawnEnemy, which still consumes its RNG draws when it drops a spawn, so a
    // saturated village costs you the body without shifting the shared wave pattern.
    if (this.spawnT <= 0) {
      this.spawnT = interval * (0.82 + this.rng.next() * 0.36);
      const groupSize = 1 + Math.floor(t / 70) + (this.rng.next() < 0.22 ? 2 : 0);
      const type = this._pickEnemyType();
      const def = ENEMIES[type];
      const n = def.packMin
        ? def.packMin + Math.floor(this.rng.next() * (def.packMax - def.packMin + 1))
        : groupSize;
      for (let i = 0; i < n; i++) this._spawnEnemy(type, i, n, null, null, this.rng);
    }

    while (this.minibossIdx < MINIBOSS_TIMES.length &&
           t >= MINIBOSS_TIMES[this.minibossIdx] / m.eliteRate) {
      this.minibossIdx++;
      this._spawnMiniboss();
    }

    while (this.eliteIdx < ELITE_TIMES.length && t >= ELITE_TIMES[this.eliteIdx] / m.eliteRate) {
      this.eliteIdx++;
      this._spawnElite();
    }
  }

  _pickEnemyType() {
    const keys = [], weights = [];
    for (const k in ENEMIES) {
      const d = ENEMIES[k];
      if (d.weight <= 0 || this.time < d.minTime) continue;
      keys.push(k);
      // Late-night bias toward the heavier archetypes.
      const ramp = d.minTime > 0 ? 1 + Math.min(1.6, (this.time - d.minTime) / 120) : 1;
      weights.push(d.weight * ramp);
    }
    return this.rng.weighted(keys, weights);
  }

  /** Spawn just outside the visible viewport, inside the arena, on walkable ground. */
  _spawnPos(index, total, rng, spreadRad = 0.55) {
    const p = this.player;
    const a = this.arena;
    const baseAngle = rng.angle();
    const ang = total > 1 ? baseAngle + (index / total - 0.5) * spreadRad : baseAngle;
    const dist = 520 + rng.next() * 140;
    let x = p.x + Math.cos(ang) * dist;
    let y = p.y + Math.sin(ang) * dist;
    x = clamp(x, a.x + TS * 2, a.x + a.w - TS * 2);
    y = clamp(y, a.y + TS * 2, a.y + a.h - TS * 2);
    // Nudge out of walls. Consumes no randomness, so it can't desync the daily.
    if (!this.world.nearestOpen(x, y, 14)) { x = this.world._ox; y = this.world._oy; }
    return { x, y };
  }

  /** @param {Rng} rng director spawns pass the wave stream; everything else rngAux. */
  _spawnEnemy(typeKey, index = 0, total = 1, atX = null, atY = null, rng = this.rngAux) {
    const def = ENEMIES[typeKey];

    // Every random draw happens up front, unconditionally — before the pool check.
    //
    // This ordering is load-bearing for the Daily Run. If a full pool could skip these
    // draws, a player who kills slowly would advance the director's stream differently
    // from a player who kills fast, and the two would stop sharing a night. Dropping the
    // body when the pool is full is fine; letting that drop change the stream is not.
    const pos = atX != null ? { x: atX, y: atY } : this._spawnPos(index, total, rng);
    const shootT = def.shootEvery ? def.shootEvery * (0.5 + rng.next() * 0.7) : 0;
    const phase = rng.angle();
    const groan = rng.next();

    const e = this.enemies.spawn();
    if (!e) return null;

    const tMin = this.time / 60;
    const hpScale = (1 + tMin * 0.36) * this.mods.enemyHp;
    const spdScale = (1 + tMin * 0.045) * this.mods.enemySpeed;

    e.uid = UID++;
    e.def = def;
    e.key = typeKey;
    e.x = pos.x; e.y = pos.y;
    e.vx = e.vy = 0;
    e.maxHp = e.hp = def.hp * hpScale;
    e.r = def.r;
    e.flash = 0;

    resetAnim(e.anim);
    e.state = 0; e.stateT = 0;
    e.atkState = A_NONE; e.atkT = 0; e.atkCd = 0.35 + groan * 0.4;
    e.groanT = 2 + groan * 8;
    e.shootT = shootT;
    e.callT = def.callEvery || 0;
    e.phase = phase;
    e.spawnT = 0.42;                 // rise-from-the-ground window, immune, no collision
    e.elite = !!def.elite;
    e.dmgScale = (1 + tMin * 0.14) * this.mods.enemyDmg;
    e.speedScale = spdScale;
    e.split = false;
    e.shielded = false;
    e.parentUid = 0;
    e.sampleT = 0; e.lastX = e.x; e.lastY = e.y; e.detourT = 0; e.detour = 0;
    e.sweepT = def.sweepEvery || 0;

    // Something claws its way up out of the dirt.
    this.particles.burst(e.x, e.y + 6, 6, 70, this.palette.bgGrid, { life: 0.45, size: 2.6 });
    return e;
  }

  /**
   * Guarantee a pool slot for a scheduled event by evicting the most distant ordinary
   * body. Without this a saturated pool silently swallows the spawn — survivable for a
   * shambler, completely wrong for the Butcher, the one thing in the night that's
   * supposed to be an event. Evicts by distance so nothing vanishes on screen, skips
   * elites, and consumes no RNG, so it cannot desync the shared daily.
   */
  _makeRoomForEvent() {
    if (this.enemies.active < MAX_ENEMIES) return true;
    const p = this.player;
    let worstIdx = -1, worstD = -1;
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      if (e.elite || e.parentUid) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      const d = dx * dx + dy * dy;
      if (d > worstD) { worstD = d; worstIdx = i; }
    }
    if (worstIdx < 0) return false;
    this.enemies.releaseAt(worstIdx);
    return true;
  }

  _spawnMiniboss() {
    const def = ENEMIES.butcher;
    this._makeRoomForEvent();
    const e = this._spawnEnemy('butcher', 0, 1, null, null, this.rng);
    if (!e) return;
    const tMin = this.time / 60;
    e.maxHp = e.hp = def.hp * (1 + tMin * 0.42) * this.mods.enemyHp;
    e.spawnT = 1.6;                    // long telegraph — this is meant to be an event
    this.eliteAlive++;
    this.particles.ring(e.x, e.y, 40, 420, 1.4, BLOOD_RGB, 8);
    juice.addShake(12);
    juice.addFlash(0.10);
    audio.bigDeath();
    this.onMinibossSpawn?.(def);
  }

  _spawnElite() {
    this._makeRoomForEvent();
    const e = this._spawnEnemy('horror', 0, 1, null, null, this.rng);
    if (!e) return;
    const tMin = this.time / 60;
    e.maxHp = e.hp = ENEMIES.horror.hp * (1 + tMin * 0.55) * this.mods.enemyHp;
    e.spawnT = 1.1;
    this.eliteAlive++;
    audio.tierShift();
    juice.addShake(9);
    this.particles.ring(e.x, e.y, 30, 300, 1.0, BLOOD_RGB, 6);
    this.onEliteSpawn?.();
  }

  // ---------------------------------------------------------------- the dead

  _updateEnemies(dt) {
    const p = this.player;
    const pool = this.enemies;

    for (let i = pool.active - 1; i >= 0; i--) {
      // An attack below can trigger Spiked Vest, whose shockwave may kill several bodies
      // in one call — re-clamp before touching items[i].
      if (i >= pool.active) { i = pool.active; continue; }
      const e = pool.items[i];
      const def = e.def;

      if (e.spawnT > 0) { e.spawnT -= dt; continue; }

      e.flash = Math.max(0, e.flash - dt * 6);

      // Ambient groaning, on a per-individual timer. Cosmetic, so Math.random.
      e.groanT -= dt;
      if (e.groanT <= 0) {
        e.groanT = 4 + Math.random() * 9;
        const dx0 = e.x - p.x, dy0 = e.y - p.y;
        if (dx0 * dx0 + dy0 * dy0 < 480 * 480) audio.groan(e.elite ? 0.55 : 1);
      }

      const dx = p.x - e.x, dy = p.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      let nx = dx / d, ny = dy / d;
      const speed = def.speed * e.speedScale;

      // ---------------------------------------------------------- melee
      //
      // The core of the combat rework. A body that reaches you stops, winds up where you
      // can see it, and only then swings. It never damages you by touching you.
      if (e.atkState !== A_NONE) {
        e.atkT -= dt;
        // Braced mid-swing: velocity bleeds off fast so the attack has a planted look
        // and a dodged swing genuinely misses.
        e.vx = damp(e.vx, 0, 10, dt);
        e.vy = damp(e.vy, 0, 10, dt);
        if (e.atkState === A_WINDUP && e.atkT <= 0) {
          e.atkState = A_RECOVER;
          e.atkT = def.atk.recover;
          this._enemyStrike(e, def, p);
        } else if (e.atkState === A_RECOVER && e.atkT <= 0) {
          e.atkState = A_NONE;
          e.atkCd = def.atk.cool;
        }
        e.x += e.vx * dt; e.y += e.vy * dt;
        updateAnim(e.anim, dt, 0, 0);
        continue;
      }

      e.atkCd = Math.max(0, e.atkCd - dt);
      if (def.atk && p.alive && e.atkCd <= 0 && d < def.atk.range + e.r + p.r) {
        e.atkState = A_WINDUP;
        e.atkT = def.atk.windup;
        // The clip is stretched over windup+recover so the contact frame lands exactly
        // on the frame the damage is applied — the tell and the hit are the same event.
        playClip(e.anim, def.atk.clip, def.atk.windup + def.atk.recover,
                 dirFromVector(nx, ny));
        audio.swing(0.8);
        continue;
      }

      // ---------------------------------------------------------- wall following
      //
      // The dead have no pathfinder, and they don't need one — but they do need to not
      // stand pressed against a tree for the rest of the night. Every behaviour below
      // steers along (nx, ny), straight at the survivor; when that vector points into a
      // wall the body grinds there forever, because nothing about "walk at the player"
      // ever stops being true.
      //
      // Detecting that is less obvious than it looks. A blocked body is not stationary:
      // moveResolved *reverses* the blocked component (`vx *= -0.15`) while the behaviour
      // damps it straight back, so the thing jitters against the trunk — moving every
      // single frame, going nowhere. A per-frame "did it move?" test sees healthy motion
      // and never fires. Net displacement over a window is what actually distinguishes
      // walking from grinding, which is what the sampler below measures.
      //
      // This deliberately runs *after* the attack block above: a zombie mid-swing should
      // face the thing it's swinging at, not the direction it was detouring.
      if (e.detourT > 0) {
        if (e.detour === 0) {
          // Probe both perpendiculars and commit to whichever is clear. If both are (or
          // neither is), fall back to a per-body constant so a crowd meeting the same
          // wall splits around it instead of every one of them picking the same way.
          const ahead = e.r * 2.4 + 20;
          const lx = -ny, ly = nx;
          const lOpen = !this.world.blocked(e.x + lx * ahead, e.y + ly * ahead, e.r * 0.8);
          const rOpen = !this.world.blocked(e.x - lx * ahead, e.y - ly * ahead, e.r * 0.8);
          e.detour = lOpen && !rOpen ? 1 : rOpen && !lOpen ? -1 : (e.uid & 1 ? 1 : -1);
        }
        // ~66 degrees off the direct line: enough to clear a corner, shallow enough that
        // the body is still visibly coming for you rather than wandering off.
        const a = 1.15 * e.detour;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rx = nx * ca - ny * sa, ry = nx * sa + ny * ca;
        nx = rx; ny = ry;
      }

      switch (def.behavior) {
        case 'chase':
          e.vx = damp(e.vx, nx * speed, 4, dt);
          e.vy = damp(e.vy, ny * speed, 4, dt);
          break;

        case 'weave': {
          // Perpendicular sine offset — hard to lead, easy to read.
          e.phase += dt * 3.4;
          const px = -ny, py = nx;
          const w = Math.sin(e.phase) * speed * 0.85;
          e.vx = damp(e.vx, nx * speed + px * w, 5, dt);
          e.vy = damp(e.vy, ny * speed + py * w, 5, dt);
          break;
        }

        case 'charge': {
          e.stateT -= dt;
          if (e.state === 0) {              // stalk
            e.vx = damp(e.vx, nx * speed, 3, dt);
            e.vy = damp(e.vy, ny * speed, 3, dt);
            if (d < 320) { e.state = 1; e.stateT = def.windup; }
          } else if (e.state === 1) {       // freeze — the tell
            e.vx = damp(e.vx, 0, 8, dt);
            e.vy = damp(e.vy, 0, 8, dt);
            if (e.stateT <= 0) {
              e.state = 2; e.stateT = def.chargeTime;
              e.vx = nx * def.chargeSpeed * this.mods.enemySpeed;
              e.vy = ny * def.chargeSpeed * this.mods.enemySpeed;
            }
          } else if (e.state === 2) {       // committed sprint — no steering
            if (e.stateT <= 0) { e.state = 3; e.stateT = def.restTime; }
          } else {                          // winded
            e.vx = damp(e.vx, 0, 5, dt);
            e.vy = damp(e.vy, 0, 5, dt);
            if (e.stateT <= 0) e.state = 0;
          }
          break;
        }

        case 'circle': {
          // Screamer. Keeps its distance and calls the street awake — no projectiles,
          // because a zombie that shoots is a sci-fi turret wearing a corpse.
          const want = def.circleRadius;
          const radial = (d - want) * 1.6;
          const px = -ny, py = nx;
          e.vx = damp(e.vx, nx * clamp(radial, -speed, speed) + px * speed, 4, dt);
          e.vy = damp(e.vy, ny * clamp(radial, -speed, speed) + py * speed, 4, dt);
          this._call(e, dt, def);
          break;
        }

        case 'standoff': {
          const want = def.standoffRange;
          const err = d - want;
          const move = clamp(err * 1.2, -speed, speed);
          e.vx = damp(e.vx, nx * move, 3, dt);
          e.vy = damp(e.vy, ny * move, 3, dt);
          this._enemySpit(e, dt, def, nx, ny, def.burst || 1);
          break;
        }

        case 'swarm': {
          // Heads for you with a wandering perpendicular wobble whose phase and rate
          // differ per individual, so a pack arrives as a spreading cloud rather than a
          // stacked column, and can't be led like one target.
          e.phase += dt * (5.5 + (e.uid % 7) * 0.6);
          const px = -ny, py = nx;
          const wob = Math.sin(e.phase) * speed * 0.75;
          e.vx = damp(e.vx, nx * speed + px * wob, 7, dt);
          e.vy = damp(e.vy, ny * speed + py * wob, 7, dt);
          break;
        }

        case 'lunge': {
          // Deliberately generous tells: a long wind-up where it stops dead, then a
          // committed leap it cannot steer out of. Always dodgeable.
          e.stateT -= dt;
          if (e.state === 0) {
            e.vx = damp(e.vx, nx * speed, 2.5, dt);
            e.vy = damp(e.vy, ny * speed, 2.5, dt);
            if (d < def.lungeRange) { e.state = 1; e.stateT = def.windup; }
          } else if (e.state === 1) {
            e.vx = damp(e.vx, 0, 9, dt);
            e.vy = damp(e.vy, 0, 9, dt);
            if (e.stateT <= 0) {
              e.state = 2; e.stateT = def.lungeTime;
              e.vx = nx * def.lungeSpeed * this.mods.enemySpeed;
              e.vy = ny * def.lungeSpeed * this.mods.enemySpeed;
              audio.groan(0.7);
              juice.addShake(2.5);
            }
          } else if (e.state === 2) {
            if (e.stateT <= 0) { e.state = 3; e.stateT = def.restTime; }
          } else {
            e.vx = damp(e.vx, 0, 4, dt);
            e.vy = damp(e.vy, 0, 4, dt);
            if (e.stateT <= 0) e.state = 0;
          }
          break;
        }

        case 'orbitParent': {
          // Thralls ride a circle around the Butcher. If the parent is somehow gone
          // (killed by a bloom in the same frame) they tear loose and charge instead of
          // freezing in place around nothing.
          const par = this._findByUid(e.parentUid);
          if (!par) {
            e.def = ENEMIES.crawler;
            e.key = 'crawler';
            e.parentUid = 0;
            break;
          }
          e.phase += dt * def.orbitRate;
          const tx = par.x + Math.cos(e.phase) * def.orbitDist;
          const ty = par.y + Math.sin(e.phase) * def.orbitDist;
          e.vx = (tx - e.x) * 9;
          e.vy = (ty - e.y) * 9;
          break;
        }
      }

      if (def.miniboss) this._butcherBehavior(e, dt, def);
      else if (e.elite) this._horrorBehavior(e, dt, def, nx, ny);

      // Thralls are positioned, not steered — they pass through walls with their parent
      // rather than snagging on a fence and stretching the tether across the street.
      if (def.behavior === 'orbitParent' || e.state === 2) {
        e.x += e.vx * dt; e.y += e.vy * dt;
        const a = this.arena;
        e.x = clamp(e.x, a.x + e.r, a.x + a.w - e.r);
        e.y = clamp(e.y, a.y + e.r, a.y + a.h - e.r);
      } else {
        this.world.moveResolved(e, e.r * 0.8, e.x + e.vx * dt, e.y + e.vy * dt);

        // Net displacement over a window, against how far this body could have walked in
        // that time. Under 30% means it is grinding on something rather than travelling.
        //
        // Bodies that are *supposed* to be standing still are excluded: a Runner freezing
        // before its charge and a Lurker winding up its leap both cover no ground on
        // purpose, and flagging those would send them sidling off mid-telegraph.
        const restingByDesign =
          (def.behavior === 'charge' || def.behavior === 'lunge') && e.state !== 0;
        if (!restingByDesign) {
          e.sampleT += dt;
          if (e.sampleT >= 0.45) {
            const net = Math.hypot(e.x - e.lastX, e.y - e.lastY);
            if (net < speed * e.sampleT * 0.3) {
              e.detourT = 1.1;          // refreshed every window it stays stuck
            }
            e.lastX = e.x; e.lastY = e.y; e.sampleT = 0;
          }
        }
        if (e.detourT > 0) {
          e.detourT -= dt;
          if (e.detourT <= 0) e.detour = 0;   // re-probe next time rather than reuse a stale side
        }
      }
      updateAnim(e.anim, dt, e.vx, e.vy);

      // Separation against a short window of neighbours. Not a true O(n^2) pass — 14
      // comparisons is enough to keep a crowd from collapsing into one body, and the
      // pool's swap-remove churn shuffles who compares against whom over time.
      for (let j = i - 1; j >= 0 && j > i - 15; j--) {
        const o = pool.items[j];
        const ox = e.x - o.x, oy = e.y - o.y;
        const rr = (e.r + o.r) * 1.2;
        const od2 = ox * ox + oy * oy;
        if (od2 > 0.01 && od2 < rr * rr) {
          const od = Math.sqrt(od2);
          const push = (rr - od) / od * 70;
          e.vx += ox * push * dt * 6; e.vy += oy * push * dt * 6;
          o.vx -= ox * push * dt * 6; o.vy -= oy * push * dt * 6;
        }
      }
    }
  }

  /**
   * The contact frame of an enemy swing. Re-checks range at the moment of impact rather
   * than at the moment the swing started — that re-check is precisely what makes the
   * wind-up a real decision point instead of decoration.
   */
  _enemyStrike(e, def, p) {
    const dx = p.x - e.x, dy = p.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    const reach = def.atk.reach + p.r;
    if (d <= reach && p.alive) {
      this.damagePlayer(def.dmg * e.dmgScale, e.x, e.y);
      if (def.atk.knock) {
        p.vx += (dx / d) * def.atk.knock;
        p.vy += (dy / d) * def.atk.knock;
      }
      audio.gore();
    } else {
      // Whiff: a puff of dirt where the swing landed, so a successful dodge is legible.
      this.particles.burst(e.x + (dx / d) * reach * 0.7, e.y + (dy / d) * reach * 0.7,
                           4, 90, this.palette.bgGrid, { life: 0.28, size: 2.4 });
    }
  }

  /** Screamer / Horror: pull more of them out of the dark. */
  _call(e, dt, def) {
    e.callT -= dt;
    if (e.callT > 0) return;
    e.callT = def.callEvery;
    audio.scream();
    juice.addShake(2);
    this.particles.ring(e.x, e.y - 20, 12, 210, 0.7, this.palette.enemyBright, 4);
    for (let k = 0; k < def.callCount; k++) {
      const a = this.rngAux.angle();
      this._spawnEnemy(def.call, 0, 1, e.x + Math.cos(a) * 90, e.y + Math.sin(a) * 90);
    }
  }

  _horrorBehavior(e, dt, def, nx, ny) {
    e.shootT -= dt;
    if (e.shootT <= 0) {
      e.shootT = def.shootEvery;
      const base = Math.atan2(ny, nx) + this.rngAux.float(0, 0.5);
      for (let k = 0; k < def.radialCount; k++) {
        const a = base + (k / def.radialCount) * TAU;
        this._spawnEBullet(e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r,
                           Math.cos(a) * def.bulletSpeed, Math.sin(a) * def.bulletSpeed,
                           def.bulletDmg * e.dmgScale);
      }
      this.particles.ring(e.x, e.y, e.r, e.r * 3.4, 0.5, HAZARD_RGB, 4);
      juice.addShake(3.5);
    }
    this._call(e, dt, def);
  }

  /** Linear scan by uid. Only ever called for the handful of Thralls on screen. */
  _findByUid(uid) {
    if (!uid) return null;
    for (let i = 0; i < this.enemies.active; i++) {
      if (this.enemies.items[i].uid === uid) return this.enemies.items[i];
    }
    return null;
  }

  /**
   * The Butcher. Two phases:
   *   1. It walks you down and swings, with a telegraphed ground slam on a slow cycle.
   *   2. At splitAt health it tears three Thralls off itself and armours up until
   *      they're dead. Ignoring them is a losing play.
   */
  _butcherBehavior(e, dt, def) {
    if (!e.split && e.hp <= e.maxHp * def.splitAt) {
      e.split = true;
      e.shielded = true;
      const orbit = ENEMIES[def.segment].orbitDist;
      for (let k = 0; k < def.segmentCount; k++) {
        const a = (k / def.segmentCount) * TAU;
        this._makeRoomForEvent();
        const seg = this._spawnEnemy(def.segment, 0, 1,
          e.x + Math.cos(a) * orbit, e.y + Math.sin(a) * orbit, this.rngAux);
        if (seg) { seg.parentUid = e.uid; seg.phase = a; seg.spawnT = 0.3; }
      }
      this.particles.burst(e.x, e.y, 40, 330, BLOOD_RGB, { life: 0.8, size: 4 });
      audio.bigDeath();
      juice.bigKill();
      this.onMinibossSplit?.(def);
    }

    if (e.shielded) {
      let alive = false;
      for (let i = 0; i < this.enemies.active; i++) {
        if (this.enemies.items[i].parentUid === e.uid) { alive = true; break; }
      }
      if (!alive) {
        e.shielded = false;
        this.particles.ring(e.x, e.y, e.r * 3, e.r, 0.5, this.palette.accent, 5);
        audio.levelUp();
      }
    }

    // --- telegraphed ground slam ---
    e.sweepT -= dt;
    if (e.sweepT <= 0 && e.state !== 9) {
      e.state = 9;
      e.stateT = def.sweepWindup;
    }
    if (e.state === 9) {
      e.stateT -= dt;
      e.vx = damp(e.vx, 0, 7, dt);
      e.vy = damp(e.vy, 0, 7, dt);
      if (e.stateT <= 0) {
        e.state = 0;
        e.sweepT = def.sweepEvery;
        const p = this.player;
        const dx = p.x - e.x, dy = p.y - e.y;
        if (dx * dx + dy * dy < def.sweepRadius * def.sweepRadius) {
          this.damagePlayer(def.sweepDmg * e.dmgScale, e.x, e.y);
        }
        this.particles.ring(e.x, e.y, e.r, def.sweepRadius, 0.55, this.palette.bgGrid, 8);
        this.particles.burst(e.x, e.y, 30, 320, this.palette.bgGrid, { life: 0.7, size: 4 });
        audio.bigDeath();
        juice.addShake(11);
      }
    }
  }

  _enemySpit(e, dt, def, nx, ny, burst) {
    e.shootT -= dt;
    if (e.shootT > 0) return;
    e.shootT = def.shootEvery;
    const base = Math.atan2(ny, nx);
    for (let k = 0; k < burst; k++) {
      const a = base + (burst > 1 ? (k / (burst - 1) - 0.5) * 0.34 : 0);
      this._spawnEBullet(e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r,
                         Math.cos(a) * def.bulletSpeed, Math.sin(a) * def.bulletSpeed,
                         def.bulletDmg * e.dmgScale);
    }
    audio.spit();
  }

  _spawnEBullet(x, y, vx, vy, dmg) {
    const b = this.ebullets.spawn();
    if (!b) return;
    b.x = x; b.y = y; b.vx = vx; b.vy = vy;
    b.life = 5; b.dmg = dmg; b.r = 6; b.rot = Math.atan2(vy, vx);
  }

  /** Directional blood. Cosmetic, so Math.random throughout. */
  _spray(x, y, nx, ny, n) {
    const dir = Math.atan2(ny, nx);
    this.particles.burst(x, y - 8, n, 210, BLOOD_RGB,
                         { life: 0.5, size: 3, dir, spread: 1.5, drag: 0.86 });
  }

  _hurtEnemy(e, index, dmg, isCrit) {
    const def = e.def;
    let effective = def.armor ? Math.max(dmg * 0.25, dmg - def.armor) : dmg;
    if (e.shielded) {
      effective *= def.shieldedDamageMul ?? 0.15;
      if (Math.random() < 0.4) {
        this.particles.spark(e.x, e.y, (Math.random() - 0.5) * 180, (Math.random() - 0.5) * 180,
                             0.25, 2.5, this.palette.accent);
      }
    }
    e.hp -= effective;
    e.flash = 1;

    if (e.hp <= 0) {
      this._killEnemy(e, index, isCrit);
      return true;
    }
    // A hit that doesn't kill still interrupts a wind-up, so a well-timed swing can
    // cancel an incoming one. That is the closest this game gets to a parry.
    if (e.atkState === A_WINDUP && effective > e.maxHp * 0.12) {
      e.atkState = A_NONE;
      e.atkCd = def.atk ? def.atk.cool * 0.6 : 0.3;
    }
    audio.hit();
    juice.smallHit();
    return false;
  }

  _killEnemy(e, index, isCrit) {
    const def = e.def;
    const sizeScale = e.elite ? 2.4 : clamp(e.r / 14, 0.6, 1.6);

    this.combo = Math.min(50, this.combo + 1);
    this.comboT = COMBO_WINDOW;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const comboMul = 1 + Math.min(4, this.combo * 0.08);

    const gained = Math.round(def.score * comboMul * this.mods.scoreMul);
    this.score += gained;
    this.kills++;

    // Gore, not neon. A body coming apart, and a stain that stays a moment.
    this.particles.burst(e.x, e.y - 10, e.elite ? 60 : 16, e.elite ? 380 : 230, BLOOD_RGB,
                         { life: e.elite ? 1.1 : 0.65, size: e.elite ? 5 : 3.4, drag: 0.85 });
    this.particles.burst(e.x, e.y, e.elite ? 20 : 5, e.elite ? 220 : 130, this.palette.enemyDim,
                         { life: 0.8, size: 3, kind: P_SHARD });

    if (e.elite) {
      audio.bigDeath();
      juice.bigKill();
      this.eliteAlive = Math.max(0, this.eliteAlive - 1);
      this.onEliteKilled?.();
    } else {
      audio.enemyDeath(sizeScale);
      juice.kill(sizeScale);
    }
    if (isCrit) this.particles.text(e.x, e.y - e.r - 24, 'CRIT', SHARD_RGB, 0.6, 14);

    // The body itself: collapses through the six hurt frames and then lies there.
    this._spawnCorpse(e);

    // Drops. Salvage always; scrap and supplies on a roll (supplies suppressed by
    // BRITTLE).
    const xpVal = Math.max(1, Math.round(def.xp * this.stats.xpMul));
    const motes = e.elite ? 12 : Math.min(4, 1 + Math.floor(def.xp / 2));
    for (let k = 0; k < motes; k++) {
      this._spawnPickup(e.x, e.y, PK_XP, Math.max(1, Math.round(xpVal / motes)));
    }
    const shardRoll = this.rngAux.next();
    const shardChance = e.elite ? 1 : 0.11 + Math.min(0.1, this.time / 3000);
    if (shardRoll < shardChance) {
      const n = e.elite ? 8 : 1;
      for (let k = 0; k < n; k++) {
        this._spawnPickup(e.x, e.y, PK_SHARD, Math.max(1, Math.round((e.elite ? 6 : 3) * this.stats.shardMul)));
      }
    }
    if (!this.mods.noHealing && !e.elite && this.rngAux.next() < 0.022 && this.player.hp < this.stats.maxHp * 0.75) {
      this._spawnPickup(e.x, e.y, PK_HEAL, 16);
    } else if (!this.mods.noHealing && e.elite) {
      this._spawnPickup(e.x, e.y, PK_HEAL, 34);
    }

    // Bloaters spill what's inside them.
    if (def.splitInto) {
      for (let k = 0; k < def.splitCount; k++) {
        const a = (k / def.splitCount) * TAU + this.rngAux.angle();
        const c = this._spawnEnemy(def.splitInto, 0, 1, e.x + Math.cos(a) * 22, e.y + Math.sin(a) * 22);
        if (c) { c.spawnT = 0.16; c.vx = Math.cos(a) * 200; c.vy = Math.sin(a) * 200; }
      }
    }

    if (this.stats.nova > 0) {
      this._novaAt(e.x, e.y, 88 + this.stats.nova * 34, this.bulletDmg * (0.8 + this.stats.nova * 0.5), e.uid);
    }

    this.enemies.releaseAt(index);
    this.onKill?.(gained, this.combo);
  }

  _novaAt(x, y, radius, dmg, excludeUid) {
    this.particles.ring(x, y, 6, radius, 0.34, BLOOD_RGB, 4);
    this._areaDamage(x, y, radius, dmg, excludeUid, 0);
  }

  // ---------------------------------------------------------------- corpses

  _spawnCorpse(e) {
    const c = this.corpses.spawnOrRecycle ? this.corpses.spawnOrRecycle() : this.corpses.spawn();
    if (!c) return;
    c.x = e.x; c.y = e.y;
    c.sheet = SHEETS[e.def.sheet] || SHEETS.green;
    c.size = SPRITE_SIZE * (e.def.scale || 1);
    c.filter = e.def.filter || null;
    c.maxLife = c.life = e.elite ? 6.5 : 3.4;
    resetAnim(c.anim);
    // Faced whichever way it was facing when it dropped, even though the hurt row is a
    // single non-directional strip — the anim keeps `dir` for consistency and drawAnim
    // ignores it for dirs=1 clips.
    c.anim.dir = e.anim.dir;
    playClip(c.anim, 'hurt', 0.62);
  }

  _updateCorpses(dt) {
    const pool = this.corpses;
    for (let i = pool.active - 1; i >= 0; i--) {
      const c = pool.items[i];
      c.life -= dt;
      if (c.life <= 0) { pool.releaseAt(i); continue; }
      updateClipOnly(c.anim, dt);
    }
  }

  // ---------------------------------------------------------------- bullets

  _updateBullets(dt) {
    const pool = this.bullets;
    const s = this.stats;

    for (let i = pool.active - 1; i >= 0; i--) {
      const b = pool.items[i];
      b.life -= dt;
      if (b.life <= 0) { pool.releaseAt(i); continue; }

      if (s.homing > 0) {
        const t = this._nearestEnemyTo(b.x, b.y, 300);
        if (t) {
          const want = Math.atan2(t.y - b.y, t.x - b.x);
          const cur = Math.atan2(b.vy, b.vx);
          let d = ((want - cur + Math.PI * 3) % TAU) - Math.PI;
          const na = cur + clamp(d, -s.homing * dt, s.homing * dt);
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp;
        }
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // Arrows stick in walls. Buildings are cover for both sides, which is the whole
      // reason it was worth making them solid.
      if (this.world.solidAt(b.x, b.y)) {
        this.particles.burst(b.x, b.y, 3, 60, this.palette.bgGrid, { life: 0.2, size: 1.8 });
        pool.releaseAt(i);
        continue;
      }

      let consumed = false;
      for (let j = this.enemies.active - 1; j >= 0; j--) {
        if (j >= this.enemies.active) { j = this.enemies.active; continue; }
        const e = this.enemies.items[j];
        if (e.spawnT > 0) continue;
        if (b.hn > 0 && (b.h0 === e.uid || b.h1 === e.uid || b.h2 === e.uid || b.h3 === e.uid)) continue;
        const dx = e.x - b.x, dy = e.y - b.y;
        const rr = e.r + b.size;
        if (dx * dx + dy * dy > rr * rr) continue;

        const l = Math.hypot(b.vx, b.vy) || 1;
        this._spray(b.x, b.y, b.vx / l, b.vy / l, b.crit ? 12 : 6);
        const died = this._hurtEnemy(e, j, b.dmg, b.crit);
        if (!died) {
          e.vx += (b.vx / l) * this.weapon.knock * 0.4;
          e.vy += (b.vy / l) * this.weapon.knock * 0.4;
        }

        if (b.pierce > 0) {
          b.pierce--;
          const slot = b.hn++ & 3;
          if (slot === 0) b.h0 = e.uid; else if (slot === 1) b.h1 = e.uid;
          else if (slot === 2) b.h2 = e.uid; else b.h3 = e.uid;
        } else {
          pool.releaseAt(i);
          consumed = true;
        }
        break;
      }
      if (consumed) continue;
    }
  }

  _nearestEnemyTo(x, y, maxDist) {
    let best = null, bd = maxDist * maxDist;
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      if (e.spawnT > 0) continue;
      const dx = e.x - x, dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = e; }
    }
    return best;
  }

  _updateEBullets(dt) {
    const pool = this.ebullets;
    const p = this.player;
    for (let i = pool.active - 1; i >= 0; i--) {
      const b = pool.items[i];
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.life <= 0 || this.world.solidAt(b.x, b.y)) {
        this.particles.burst(b.x, b.y, 4, 70, HAZARD_RGB, { life: 0.35, size: 2.4 });
        pool.releaseAt(i); continue;
      }
      if (!p.alive) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      const rr = p.r + b.r;
      if (dx * dx + dy * dy < rr * rr) {
        this.damagePlayer(b.dmg, b.x, b.y);
        this.particles.burst(b.x, b.y, 8, 180, HAZARD_RGB, { life: 0.4, size: 2.6 });
        pool.releaseAt(i);
      }
    }
  }

  // ---------------------------------------------------------------- pickups

  _spawnPickup(x, y, type, value) {
    const pk = this.pickups.spawn();
    if (!pk) return;
    const a = this.rngAux.angle();
    const s = 50 + this.rngAux.next() * 110;
    pk.x = x; pk.y = y;
    pk.vx = Math.cos(a) * s; pk.vy = Math.sin(a) * s;
    pk.type = type; pk.value = value;
    pk.life = type === PK_XP ? 22 : 40;
    pk.r = type === PK_XP ? 4.5 : 7;
    pk.born = this.time;
  }

  _updatePickups(dt) {
    const pool = this.pickups;
    const p = this.player;
    const magnet = this.stats.magnet;
    const magnet2 = magnet * magnet;

    for (let i = pool.active - 1; i >= 0; i--) {
      const pk = pool.items[i];
      pk.life -= dt;
      if (pk.life <= 0) { pool.releaseAt(i); continue; }

      const dx = p.x - pk.x, dy = p.y - pk.y;
      const d2 = dx * dx + dy * dy;

      if (d2 < magnet2 && p.alive) {
        const d = Math.sqrt(d2) || 1;
        const pull = 340 * (1 - d / magnet) + 220;
        pk.vx += (dx / d) * pull * dt * 6;
        pk.vy += (dy / d) * pull * dt * 6;
      } else {
        pk.vx *= Math.pow(0.9, dt * 60);
        pk.vy *= Math.pow(0.9, dt * 60);
      }

      pk.x += pk.vx * dt;
      pk.y += pk.vy * dt;

      const rr = p.r + pk.r + 8;
      if (d2 < rr * rr && p.alive) {
        this._collect(pk);
        pool.releaseAt(i);
      }
    }
  }

  _collect(pk) {
    const p = this.player;
    if (pk.type === PK_XP) {
      p.xp += pk.value;
      audio.pickup();
      while (p.xp >= p.xpNext) {
        p.xp -= p.xpNext;
        p.level++;
        p.xpNext = xpForLevel(p.level);
        this.pendingLevelUps += this.mods.doubleUpgrade ? 2 : 1;
        this.particles.ring(p.x, p.y, 16, 180, 0.7, this.palette.accent, 5);
        audio.levelUp();
        juice.levelUp();
        this.onLevelUp?.();
      }
    } else if (pk.type === PK_SHARD) {
      this.runShards += pk.value;
      this.score += pk.value * 2;
      audio.shard();
      this.particles.text(pk.x, pk.y - 12, `+${pk.value}`, SHARD_RGB, 0.6, 13);
    } else {
      p.hp = Math.min(this.stats.maxHp, p.hp + pk.value);
      audio.pickup();
      this.particles.text(p.x, p.y - 42, `+${pk.value}`, HEAL_RGB, 0.8, 16);
      juice.vibrate(14);
    }
  }

  // ---------------------------------------------------------------- barbed wire

  _updateOrbitals(dt) {
    const n = this.stats.orbitals;
    if (n <= 0) return;
    const p = this.player;
    this.orbitAngle += dt * 2.3;
    this.orbitHitT -= dt;
    const radius = 58 + n * 4;

    if (this.orbitHitT <= 0) {
      const dmg = this.bulletDmg * 0.5;
      for (let k = 0; k < n; k++) {
        const a = this.orbitAngle + (k / n) * TAU;
        const ox = p.x + Math.cos(a) * radius;
        const oy = p.y + Math.sin(a) * radius;
        for (let i = this.enemies.active - 1; i >= 0; i--) {
          if (i >= this.enemies.active) { i = this.enemies.active; continue; }
          const e = this.enemies.items[i];
          if (e.spawnT > 0) continue;
          const dx = e.x - ox, dy = e.y - oy;
          const rr = e.r + 9;
          if (dx * dx + dy * dy < rr * rr) {
            this._spray(e.x, e.y, dx / (rr || 1), dy / (rr || 1), 3);
            this._hurtEnemy(e, i, dmg, false);
            this.orbitHitT = 0.28;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- drawing

  /**
   * Draw order, and why it is what it is.
   *
   * 1. The ground plane, viewport-culled, nearest-neighbour.
   * 2. Everything that stands on it — props, bodies, corpses, the survivor — merged
   *    into one list and drawn back-to-front by base Y. Without this a survivor standing
   *    behind a house is drawn on top of its roof and the whole village reads as a flat
   *    painted backdrop rather than a place with depth.
   * 3. Only then the genuinely emissive things — arrows, bile, salvage, sparks — in
   *    additive blending. Everything else is source-over, because pixel art run through
   *    `lighter` just washes out into a pale smear.
   */
  draw(r) {
    const ctx = r.ctx;

    // The lantern the darkness pass punches out of the night, and how far it reaches —
    // both driven by the night phase, so the world closes in as the night wears on.
    r.setLight(this.player.x, this.player.y, this.palette.lightR);

    this.world.drawGround(r);
    r.drawEdges(this.palette, this.arena);

    // Lantern spill on the ground, under everything that stands on it.
    //
    // This is not decoration. In a crowd the survivor is depth-sorted in among a dozen
    // bodies of the same size wearing the same palette, and testing found them genuinely
    // hard to locate — you lose track of yourself, which is the one thing a game must
    // never let happen. A warm pool of light on the dirt reads as "you are here" without
    // adding a marker that would look like a UI element pasted into the world.
    if (this.player.alive) {
      const trail = trailColor(this.trailId, this.time);
      ctx.globalCompositeOperation = 'lighter';
      r.glowOrb(this.player.x, this.player.y + 8, 78, trail, 0.16);
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.imageSmoothingEnabled = false;
    this._drawSorted(r);
    ctx.imageSmoothingEnabled = true;

    ctx.globalCompositeOperation = 'lighter';
    this._drawPickups(r);
    this._drawEBullets(r);
    this._drawBullets(r);
    this._drawOrbitals(r);
    ctx.globalCompositeOperation = 'source-over';

    r.drawParticles(this.particles);
    this._drawTells(r);
  }

  /**
   * The depth-sorted character/prop pass.
   *
   * Insertion sort over two preallocated typed arrays. Nothing is allocated, and at the
   * ~150 items a busy frame produces, insertion sort on a near-sorted list (frame-to-
   * frame coherence is high — bodies move a few pixels a frame) beats anything cleverer.
   */
  _drawSorted(r) {
    const ctx = r.ctx;
    const idx = this._sortIdx, ys = this._sortY;
    let n = 0;

    // Encoding: >= 0 enemy index, -1000-k corpse k, -1 the player. Packing three kinds
    // into one integer array avoids a parallel "kind" array and any object churn.
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      if (!r.inView(e.x, e.y, 90)) continue;
      idx[n] = i; ys[n] = e.y; n++;
    }
    for (let i = 0; i < this.corpses.active; i++) {
      const c = this.corpses.items[i];
      if (!r.inView(c.x, c.y, 90)) continue;
      idx[n] = -1000 - i; ys[n] = c.y - 1; n++;   // corpses sit under the living
    }
    if (this._playerVisible()) { idx[n] = -1; ys[n] = this.player.y; n++; }

    for (let i = 1; i < n; i++) {
      const ki = idx[i], ky = ys[i];
      let j = i - 1;
      while (j >= 0 && ys[j] > ky) { ys[j + 1] = ys[j]; idx[j + 1] = idx[j]; j--; }
      ys[j + 1] = ky; idx[j + 1] = ki;
    }

    const pn = this.world.cullProps(r);
    let pi = 0;
    // Everything drawn after the survivor is, by definition of the sort, in front of
    // them. See _drawPropFading.
    let behindPlayer = true;

    for (let i = 0; i < n; i++) {
      const y = ys[i];
      while (pi < pn && this.world.propBaseY(this.world._visProps[pi]) <= y) {
        this._drawPropFading(ctx, this.world._visProps[pi], behindPlayer); pi++;
      }
      const k = idx[i];
      if (k === -1) { this._drawPlayer(r); behindPlayer = false; }
      else if (k <= -1000) this._drawCorpse(r, this.corpses.items[-1000 - k]);
      else this._drawEnemy(r, this.enemies.items[k]);
    }
    while (pi < pn) { this._drawPropFading(ctx, this.world._visProps[pi], behindPlayer); pi++; }
  }

  /**
   * Draw a prop, fading it if it is standing between the camera and the survivor.
   *
   * Depth sorting is correct and also, on its own, hostile: walk one step up behind a
   * tenement and the sort does exactly what it should — draws the building over you — and
   * you are simply gone. In a game where losing track of yourself in a crowd is already
   * the main readability problem (see the note on _playerVisible), a wall that swallows
   * you whole is worse than a wall drawn slightly wrong.
   *
   * So anything painted after the survivor that covers where they're standing drops to
   * 45%. The prop still occludes — you can tell you're behind it — but you can see
   * yourself, and more importantly you can see the thing swinging at you.
   *
   * Tested against the chest rather than the feet: the feet are the sort key and sit at
   * the very bottom edge of the sprite, so a foot-level test flickers on and off as you
   * walk along a building's base line.
   */
  _drawPropFading(ctx, i, behindPlayer) {
    const p = this.player;
    const fade = !behindPlayer && p.alive && this.world.propCovers(i, p.x, p.y - 22);
    this.world.drawPropAt(ctx, i, fade ? 0.45 : 1);
  }

  _drawEnemy(r, e) {
    const ctx = r.ctx;
    const def = e.def;
    const size = SPRITE_SIZE * (def.scale || 1);

    if (e.spawnT > 0) {
      // Rising: the sprite fades up out of the dirt rather than popping in, so nothing
      // ever appears on top of you unseen.
      const t = 1 - e.spawnT / (e.elite ? 1.6 : 0.42);
      this._shadow(ctx, e.x, e.y, e.r * 1.5 * t);
      drawAnim(ctx, SHEETS[def.sheet] || SHEETS.green, e.anim, e.x, e.y, size,
               0.15 + t * 0.85, def.filter);
      return;
    }

    this._shadow(ctx, e.x, e.y, e.r * 1.5);
    drawAnim(ctx, SHEETS[def.sheet] || SHEETS.green, e.anim, e.x, e.y, size, 1, def.filter);

    // Hit flash: the same frame re-blitted additively. One extra drawImage, no offscreen
    // buffer and no tinted sheet variants in memory.
    if (e.flash > 0.02) {
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      drawAnim(ctx, SHEETS[def.sheet] || SHEETS.green, e.anim, e.x, e.y, size, e.flash * 0.85);
      ctx.globalCompositeOperation = prev;
    }

    // Health arc for anything meaningfully tanky.
    const hpFrac = clamp(e.hp / e.maxHp, 0, 1);
    if (e.maxHp > 45 && hpFrac < 0.999) {
      const w = e.r * 2.2;
      const y = e.y - size * 0.86 - 6;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(e.x - w / 2, y, w, 4);
      ctx.fillStyle = rgba(e.elite ? BLOOD_RGB : this.palette.enemyBright, 1);
      ctx.fillRect(e.x - w / 2, y, w * hpFrac, 4);
      ctx.globalAlpha = 1;
    }
  }

  _drawCorpse(r, c) {
    const ctx = r.ctx;
    // Fade out over the last second so bodies leave rather than blink away.
    const a = Math.min(1, c.life);
    this._shadow(ctx, c.x, c.y, 16 * (c.size / SPRITE_SIZE), 0.4 * a);
    drawAnim(ctx, c.sheet, c.anim, c.x, c.y, c.size, a, c.filter);
  }

  /** A soft contact shadow. Cheap, and it's what stops sprites from looking pasted on. */
  _shadow(ctx, x, y, rad, alpha = 0.5) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(x, y + 6, rad, rad * 0.42, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** Shared by the body pass and the sort, so they agree about blinking. */
  /**
   * The survivor is *always* in the draw list while alive.
   *
   * This used to hard-toggle the sprite off every other 18Hz tick during i-frames — the
   * standard arcade invulnerability blink. It does not survive the move to a swarm game:
   * in a crowd you are hit often enough that i-frames are near-continuous, so the blink
   * stops being an occasional flourish and becomes the player strobing nine times a
   * second, more or less permanently. Reported, correctly, as "the screen is flickering
   * and the player was gone."
   *
   * Invulnerability is now shown by _drawPlayer as a smooth translucency dip instead —
   * same information, no frame where you cannot find yourself. See the note there.
   */
  _playerVisible() {
    const p = this.player;
    if (!p.alive) return this.playerAnim.clip === 'hurt';   // the collapse still draws
    return true;
  }

  _drawPlayer(r) {
    const ctx = r.ctx;
    const p = this.player;
    this._shadow(ctx, p.x, p.y, 15);

    // Invulnerability reads as a translucency shimmer rather than a blink. A continuous
    // sine between 0.5 and 0.92 at ~5Hz is legible as "you are briefly untouchable"
    // while never dropping the sprite, so the eye keeps its lock on you in a crowd.
    // Dashing stays fully opaque — the dash is already loud enough to read on its own.
    let alpha = 1;
    if (p.alive && p.iframes > 0 && p.dashT <= 0) {
      alpha = 0.71 + Math.sin(p.iframes * 31.4) * 0.21;
    }

    // See the note above PLAYER_SHEET_BOW: the sword lives only on PLAYER_SHEET's
    // oversized rows, the bow only on PLAYER_SHEET_BOW's standard "thrust" rows, the axe
    // only on PLAYER_SHEET_AXE's own oversized region. Picked here rather than stored,
    // because the dash's `jump` clip and the hurt/flinch rows are body-only content
    // present on every sheet, so switching sheets mid-dash or mid-flinch doesn't skip or
    // duplicate a frame — it's the same row either way.
    const sheet = this.axeEquipped ? PLAYER_SHEET_AXE : this.bowEquipped ? PLAYER_SHEET_BOW : PLAYER_SHEET;
    drawAnim(ctx, sheet, this.playerAnim, p.x, p.y, SPRITE_SIZE, alpha,
             p.hurtFlash > 0.1 ? 'brightness(1.6) saturate(0.4)' : null);
  }

  /**
   * Wind-up tells, drawn after the depth pass so nothing occludes them. These are the
   * only genuinely "UI" marks left in the world, and every one of them answers the same
   * question: is that thing about to hit me, and from where.
   */
  _drawTells(r) {
    const ctx = r.ctx;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      const def = e.def;
      if (e.spawnT > 0) continue;
      if (!r.inView(e.x, e.y, 120)) continue;

      // The universal melee tell: a patch of ground that closes as the swing lands.
      //
      // This was a full upright ring at 1.35x reach. With thirty bodies converging that
      // produced thirty overlapping circles sweeping across each other and the screen
      // became unreadable — which defeats the entire purpose of having a tell. Flattened
      // onto the ground plane and shrunk to hug the body, it reads as the footprint the
      // swing will cover, and a crowd of them stays legible because they don't overlap
      // anything except the dirt.
      if (e.atkState === A_WINDUP && def.atk) {
        const t = 1 - e.atkT / def.atk.windup;
        const rx = def.atk.reach * (1.0 - t * 0.22);
        ctx.globalAlpha = 0.30 + t * 0.45;
        ctx.lineWidth = 1.6 + t * 2.2;
        ctx.strokeStyle = rgba(BLOOD_RGB, 0.95);
        ctx.beginPath();
        ctx.ellipse(e.x, e.y + 8, rx, rx * 0.42, 0, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Runner: about to sprint.
      if (def.behavior === 'charge' && e.state === 1) {
        const t = 1 - e.stateT / def.windup;
        r.glowCircle(e.x, e.y, e.r + 6 + t * 16, HAZARD_RGB, 1.5, 0.8, 0);
      }

      // Lurker leap: a ring plus a line showing exactly where it will land. The line is
      // the important half — a ring alone says "something", a line says "not here".
      if (def.behavior === 'lunge' && e.state === 1) {
        const t = 1 - e.stateT / def.windup;
        r.glowCircle(e.x, e.y, e.r + 26 - t * 20, BLOOD_RGB, 2 + t * 2, 1, 0);
        const dx = this.player.x - e.x, dy = this.player.y - e.y;
        const l = Math.hypot(dx, dy) || 1;
        ctx.globalAlpha = 0.28 + t * 0.42;
        r.glowStreak(e.x + (dx / l) * (e.r + 8 + t * 200), e.y + (dy / l) * (e.r + 8 + t * 200),
                     dx, dy, 40 + t * 170, 3, BLOOD_RGB, 1);
        ctx.globalAlpha = 1;
      }

      // Butcher ground slam: an expanding ring so you can read both that it's coming and
      // exactly how much room you need.
      if (e.state === 9 && def.sweepWindup) {
        const t = 1 - e.stateT / def.sweepWindup;
        ctx.globalAlpha = 0.35 + t * 0.5;
        r.glowCircle(e.x, e.y, def.sweepRadius * (0.35 + t * 0.65), BLOOD_RGB, 2 + t * 4, 1, 0);
        ctx.globalAlpha = 1;
      }

      if (e.shielded) {
        const pulse = 1 + Math.sin(this.time * 6) * 0.06;
        r.glowCircle(e.x, e.y, (e.r + 18) * pulse, this.palette.accent, 2, 0.8, 0);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  _drawBullets(r) {
    for (let i = 0; i < this.bullets.active; i++) {
      const b = this.bullets.items[i];
      const rgb = b.crit ? SHARD_RGB : this.palette.primary;
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const len = Math.min(30, sp * 0.03);
      if (b.arrow) r.glowArrow(b.x, b.y, b.vx, b.vy, len, b.size * 1.3, rgb, 1);
      else r.glowStreak(b.x, b.y, b.vx, b.vy, len, b.size * 1.3, rgb, 1);
    }
  }

  _drawEBullets(r) {
    // Bile. Sick green, and — more importantly — a *streak*, not an orb.
    //
    // Colour alone was not carrying this. Salvage, experience and bile were all drawn as
    // the same soft glowing ball and only the hue told them apart, so in a crowd, at
    // speed, through a darkness pass, incoming damage looked exactly like something worth
    // running toward. Shape is the read that survives all three: a thing with a tail is
    // travelling and a round thing is sitting still, which is true of every projectile
    // and every pickup in the game without the player being told.
    for (let i = 0; i < this.ebullets.active; i++) {
      const b = this.ebullets.items[i];
      const sp = Math.hypot(b.vx, b.vy) || 1;
      r.glowStreak(b.x, b.y, b.vx, b.vy, Math.min(30, sp * 0.06), b.r * 1.25, HAZARD_RGB, 0.85);
      // A tight hot head, so it still reads as a glob rather than a laser.
      r.glowOrb(b.x, b.y, b.r * 1.15, HAZARD_RGB, 0.95);
    }
  }

  _drawOrbitals(r) {
    const n = this.stats.orbitals;
    if (n <= 0) return;
    const p = this.player;
    const radius = 58 + n * 4;
    for (let k = 0; k < n; k++) {
      const a = this.orbitAngle + (k / n) * TAU;
      const ox = p.x + Math.cos(a) * radius, oy = p.y + Math.sin(a) * radius;
      r.glowOrb(ox, oy, 11, this.palette.primaryDim, 0.5);
    }
  }

  _drawPickups(r) {
    const ctx = r.ctx;
    for (let i = 0; i < this.pickups.active; i++) {
      const pk = this.pickups.items[i];
      // Blink out over the last 2 seconds so expiry is never a surprise.
      if (pk.life < 2 && Math.floor(pk.life * 8) % 2 === 0) continue;
      const bob = Math.sin((this.time - pk.born) * 5 + pk.x * 0.05) * 0.16 + 1;

      if (pk.type === PK_XP) {
        r.glowOrb(pk.x, pk.y, pk.r * 2.4 * bob, XP_RGB, 0.8);
      } else if (pk.type === PK_SHARD) {
        r.glowOrb(pk.x, pk.y, pk.r * 2.8 * bob, SHARD_RGB, 0.9);
      } else {
        const s = pk.r * bob;
        ctx.lineWidth = 3;
        ctx.strokeStyle = rgba(HEAL_RGB, 0.95);
        ctx.beginPath();
        ctx.moveTo(pk.x - s, pk.y); ctx.lineTo(pk.x + s, pk.y);
        ctx.moveTo(pk.x, pk.y - s); ctx.lineTo(pk.x, pk.y + s);
        ctx.stroke();
        r.glowOrb(pk.x, pk.y, s * 2.4, HEAL_RGB, 0.7);
      }
    }
  }

  // ---------------------------------------------------------------- results

  results() {
    return {
      isDaily: this.cfg.isDaily,
      date: this.cfg.dateKey,
      mutator: this.cfg.mutator,
      score: this.score,
      time: this.time,
      timeStr: formatTime(this.time),
      kills: this.kills,
      level: this.player.level,
      shards: Math.round(this.runShards),
      bestCombo: this.bestCombo,
      tier: this.tier,
      tierName: TIERS[this.tier].name,
    };
  }
}
