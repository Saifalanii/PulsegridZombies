// DOM UI: screens, HUD, shop, settings, records.
//
// Kept out of the render loop entirely. The HUD only touches the DOM when a value
// actually changes (cached in `this._last`), because layout thrash on a mid-range phone
// is the fastest way to lose the 60fps target.

import { save, MILESTONES } from '../core/save.js';
import { audio } from '../core/audio.js';
import { juice } from '../fx/juice.js';
import { SHOP, WEAPONS, STREAK_LOCKED } from '../game/defs.js';
import { TRAILS } from '../game/palette.js';
import { mutatorFor, msUntilTomorrow, formatCountdown, MUTATORS } from '../game/daily.js';
import { todayKey, dayOffsetKey } from '../core/rng.js';
import { formatTime, clamp } from '../core/math.js';
import { Portrait } from '../fx/face.js';
import { CORES, RIVAL, STAKES, TRAIL_BLURBS, coreFor } from '../game/characters.js';
import { voice } from '../game/voice.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const SCREENS = ['menu', 'brief', 'levelup', 'pause', 'gameover', 'shop', 'settings', 'stats', 'about'];

/** Voice priorities — a louder line interrupts a quieter one, never the reverse. */
const V_PRIORITY = { chatter: 0, hurt: 1, levelUp: 1, tierShift: 1, eliteKill: 2, nearDeath: 3, death: 4, milestone: 4 };

/** Upgrade card glyphs — same geometric language as the enemies. */
const UPGRADE_VISUALS = {
  power: ['damage','blade'], rapid: ['offense','lightning'], multi: ['offense','multi'],
  pierce: ['damage','pierce'], velocity: ['offense','fastArrow'], swift: ['mobility','boot'],
  vitality: ['survival','heartPlus'], magnet: ['utility','magnet'], orbit: ['control','wire'],
  crit: ['damage','target'], homing: ['utility','homing'], dashmaster: ['mobility','dash'],
  thorns: ['defense','spikes'], regen: ['survival','heartPulse'], greed: ['utility','scrap'],
  bigshot: ['damage','heavyArrow'], shield: ['defense','shield'], nova: ['control','burst'],
};

const UPGRADE_ICONS = {
  blade: '<path d="M5 19l4-4m-2 6l-4-4m7-3L19 5l1-2-2 1-9 9 1 1zm5-7l3 3"/>',
  lightning: '<path d="M13 2L5 13h6l-1 9 9-12h-6V2z"/>',
  multi: '<path d="M5 18L18 5m-3 0h3v3M8 20L20 8m-3 12h3v-3M4 14L14 4m-3 0h3v3"/>',
  pierce: '<path d="M3 12h15m-4-4l4 4-4 4M7 8l-3 4 3 4M20 5v14"/>',
  fastArrow: '<path d="M6 12h13m-4-4l4 4-4 4M3 7h5M2 12h2M3 17h5"/>',
  boot: '<path d="M7 3h7v7l5 4c2 2 1 5-2 5H6c-2 0-3-2-2-4l3-4V3zM7 11h7"/>',
  heartPlus: '<path d="M12 21S4 16 4 9a4 4 0 018-2 4 4 0 018 2c0 7-8 12-8 12zM12 9v6M9 12h6"/>',
  magnet: '<path d="M5 4v9a7 7 0 0014 0V4h-5v9a2 2 0 01-4 0V4H5zM5 8h5M14 8h5"/>',
  wire: '<path d="M4 12c0-5 4-8 8-8s8 3 8 8-4 8-8 8-8-3-8-8zm4 0c0-3 2-4 4-4s4 1 4 4-2 4-4 4-4-1-4-4zM3 5l3 2M18 17l3 2"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5"/>',
  homing: '<path d="M3 18c7 0 5-12 13-12h4m-4-3l4 3-4 3"/><circle cx="5" cy="18" r="2"/>',
  dash: '<path d="M3 7l5 5-5 5M10 7l5 5-5 5M17 7l4 5-4 5"/>',
  spikes: '<path d="M7 4l5 3 5-3 2 7-2 9H7l-2-9 2-7zM8 10l-4-3M16 10l4-3M9 16l3-5 3 5"/>',
  heartPulse: '<path d="M12 21S4 16 4 9a4 4 0 018-2 4 4 0 018 2c0 7-8 12-8 12zM5 13h4l2-4 2 7 2-3h4"/>',
  scrap: '<path d="M7 3h10l4 9-9 9-9-9 4-9zM7 3l5 18 5-18M3 12h18"/>',
  heavyArrow: '<path d="M3 12h14m-5-6l7 6-7 6M3 8h6M3 16h6M19 8v8"/>',
  shield: '<path d="M12 2l8 3v6c0 5-3 9-8 11-5-2-8-6-8-11V5l8-3zM8 12l3 3 5-6"/>',
  burst: '<path d="M12 2l2.5 6L20 4l-2 6 5 2-6 2 3 6-6-4-2 6-2-6-6 4 3-6-6-2 5-2-2-6 5.5 4L12 2z"/>',
};

function upgradeIconSvg(id) {
  const [, icon] = UPGRADE_VISUALS[id] || ['utility', 'target'];
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UPGRADE_ICONS[icon]}</svg>`;
}

export class UI {
  constructor(game) {
    this.game = game;
    this.current = null;
    this._last = {};
    this._countdownTimer = 0;
    this._toastTimer = 0;
    this.hud = $('hud');

    // Voice ticker state.
    this._voiceUntil = 0;
    this._voicePriority = -1;
    this._voiceCooldown = 0;

    // Portraits are created lazily and only ticked while their screen is visible.
    this.portraits = {};

    this._bind();
  }

  // ------------------------------------------------------------ voice

  /**
   * Show a line in the in-run ticker.
   * @param {string} who speaker label
   * @param {string} line
   * @param {string} kind priority bucket, see V_PRIORITY
   * @param {boolean} isRival tints the chip
   */
  say(who, line, kind = 'chatter', isRival = false) {
    if (!line) return;
    const now = performance.now();
    const pri = V_PRIORITY[kind] ?? 0;

    // A quieter line can't stomp a louder one that's still on screen, and ordinary
    // chatter is rate-limited so a busy fight doesn't turn into a wall of text.
    if (now < this._voiceUntil && pri < this._voicePriority) return;
    if (pri <= 1 && now < this._voiceCooldown) return;

    const box = $('voice');
    $('voice-who').textContent = who;
    $('voice-line').textContent = line;
    box.classList.toggle('rival', isRival);
    box.classList.add('show');

    const dur = 1500 + Math.min(2200, line.length * 46);
    this._voiceUntil = now + dur;
    this._voicePriority = pri;
    this._voiceCooldown = now + (pri <= 1 ? 4200 : 1200);
    clearTimeout(this._voiceTimer);
    this._voiceTimer = setTimeout(() => {
      box.classList.remove('show');
      this._voicePriority = -1;
    }, dur);
  }

  /** Cheap enough to poll every frame; avoids a style write when there's nothing shown. */
  voiceVisible() { return this._voicePriority >= 0; }

  hideVoice() {
    clearTimeout(this._voiceTimer);
    $('voice').classList.remove('show');
    this._voiceUntil = 0;
    this._voicePriority = -1;
  }

  /**
   * Re-anchors the speech bubble to the player's current on-screen position. Called
   * once per frame from the main loop while a run is active — the player moves
   * constantly, so this can't be set once in say() and left alone, or the bubble
   * would drift away from the character within a second.
   *
   * Clamped inward from the true edges (roughly half the bubble's own max-width/height)
   * so it can't render partway off-screen when the player is near the arena boundary —
   * the same class of bug as the countdown-clipping fix elsewhere, avoided up front
   * instead of relying on the browser to do something sensible with an off-screen box.
   *
   * @param {number} sx screen-space (css px) x
   * @param {number} sy screen-space (css px) y
   */
  positionVoiceNear(sx, sy) {
    const marginX = 178;   // ~half of .voice's max-width (340px) plus a little air
    const marginTop = 90;  // bubble height + tail + HUD score/time row it must clear
    const marginBottom = 70;
    const x = clamp(sx, marginX, Math.max(marginX, window.innerWidth - marginX));
    const y = clamp(sy, marginTop, Math.max(marginTop, window.innerHeight - marginBottom));
    const box = $('voice');
    box.style.left = x + 'px';
    box.style.top = y + 'px';
  }

  // ------------------------------------------------------------ portraits

  /** @returns {Portrait|null} */
  portrait(canvasId, def) {
    let p = this.portraits[canvasId];
    const el = $(canvasId);
    if (!el) return null;
    if (!p || p.canvas !== el) {
      p = new Portrait(el, def);
      this.portraits[canvasId] = p;
    } else {
      p.def = def;
    }
    return p;
  }

  /** Called from the main loop; only the visible screen's portraits cost anything. */
  updatePortraits(dt) {
    const screen = this.current;
    const ids = screen === 'brief' ? ['brief-rival-face']
              : screen === 'gameover' ? ['go-core-face', 'go-rival-face']
              : screen === 'about' ? ['about-core-face', 'about-rival-face']
              : null;
    if (!ids) return;
    for (const id of ids) {
      const p = this.portraits[id];
      if (p) { p.update(dt); p.draw(); }
    }
  }

  // ------------------------------------------------------------ navigation

  show(name) {
    for (const s of SCREENS) {
      const node = $(s);
      if (s === name) {
        node.classList.remove('hidden', 'leaving');
        // Force a reflow so the entry animation replays on repeat visits.
        void node.offsetWidth;
      } else if (!node.classList.contains('hidden')) {
        node.classList.add('hidden');
      }
    }
    this.current = name || null;
    if (name === 'menu') this.refreshMenu();
    if (name === 'shop') this.buildShop();
    if (name === 'settings') this.buildSettings();
    if (name === 'stats') this.buildRecords();
  }

  hideAll() { this.show(null); }

  setHudVisible(v) {
    this.hud.classList.toggle('hidden', !v);
    this.hud.setAttribute('aria-hidden', String(!v));
  }

  /** Cross-fade the whole interface to the current biome hue. */
  setHue(hue, accentHue) {
    document.documentElement.style.setProperty('--hue', hue.toFixed(1));
    document.documentElement.style.setProperty('--accent-hue', accentHue.toFixed(1));
  }

  toast(msg, ms = 2400) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('combat', !$('hud').classList.contains('hidden'));
    t.classList.remove('hidden');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.classList.add('hidden'), 300);
    }, ms);
  }

  banner(text) {
    const b = $('hud-banner');
    b.textContent = text;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  // ------------------------------------------------------------ bindings

  _bind() {
    const g = this.game;
    const click = (id, fn) => {
      const node = $(id);
      if (!node) return;
      node.addEventListener('click', (e) => {
        e.preventDefault();
        audio.uiClick();
        juice.vibrate(8);
        fn(e);
      });
    };

    click('btn-daily', () => g.openBrief('daily'));
    click('btn-practice', () => g.openBrief('practice'));
    click('btn-begin', () => g.beginRun());
    click('btn-brief-back', () => { audio.uiBack(); this.show('menu'); });

    click('btn-pause', () => g.pause());
    click('btn-resume', () => g.resume());
    click('btn-quit', () => {
      const btn = $('btn-quit');
      if (g.run?.cfg?.isDaily && !this._quitArmed) {
        this._quitArmed = true;
        btn.textContent = 'TAP AGAIN — END TONIGHT';
        $('pause-quit-note').textContent = 'Tonight’s one attempt will be spent.';
        clearTimeout(this._quitTimer);
        this._quitTimer = setTimeout(() => {
          this._quitArmed = false;
          if (btn) btn.textContent = 'ABANDON TONIGHT';
          const note = $('pause-quit-note');
          if (note) note.textContent = 'Ending now spends tonight’s attempt. Collected scrap is still banked.';
        }, 3500);
        return;
      }
      this._quitArmed = false;
      g.abandon();
    });
    click('btn-pause-settings', () => { this._settingsReturn = 'pause'; this.show('settings'); });

    // After a Daily, "again" can only mean Practice — the attempt is spent. Falling
    // through to openBrief('daily') would just bounce off its guard with a toast,
    // which reads as a broken button rather than a deliberate rule.
    click('btn-again', () => g.openBrief(g.lastMode === 'daily' && save.dailyLocked() ? 'practice' : g.lastMode));
    click('btn-menu', () => this.show('menu'));
    click('btn-go-shop', () => { this._shopReturn = 'gameover'; this.show('shop'); });

    click('btn-shop', () => { this._shopReturn = 'menu'; this.show('shop'); });
    click('btn-shop-back', () => { audio.uiBack(); this.show(this._shopReturn || 'menu'); });
    click('btn-settings', () => { this._settingsReturn = 'menu'; this.show('settings'); });
    click('btn-settings-back', () => { audio.uiBack(); this.show(this._settingsReturn || 'menu'); });
    click('btn-stats', () => this.show('stats'));
    click('btn-stats-back', () => { audio.uiBack(); this.show('menu'); });
    click('btn-about', () => this.showAbout());
    click('btn-about-ok', () => {
      save.data.seenTutorial = true;
      save.saveNow();
      this.show('menu');
    });
    click('btn-install', () => g.promptInstall());

    click('btn-reset', () => {
      if (this._resetArmed) {
        save.reset();
        this.toast('Progress erased.');
        this._resetArmed = false;
        this.buildSettings();
        this.show('menu');
      } else {
        this._resetArmed = true;
        $('btn-reset').textContent = 'TAP AGAIN TO CONFIRM';
        setTimeout(() => {
          this._resetArmed = false;
          const b = $('btn-reset');
          if (b) b.textContent = 'ERASE ALL PROGRESS';
        }, 4000);
      }
    });
  }

  // ------------------------------------------------------------ menu

  refreshMenu() {
    const today = todayKey();
    const mut = mutatorFor(today);
    $('daily-date').textContent = today;
    $('daily-mutator').textContent = mut.name;
    $('daily-mutator-desc').textContent = mut.desc;
    $('menu-shards').textContent = save.data.shards.toLocaleString();

    // --- daily lock ---
    // Three states, not two: unplayed, played-and-finished (we have a score to show),
    // and spent-without-a-score (started then quit, or force-quit mid-run). The last
    // one still consumes the attempt, so it needs its own copy rather than falling
    // through to "—" and looking like a bug.
    const todayRun = save.dailyScore(today);
    const locked = save.dailyLocked(today);
    const btn = $('btn-daily');
    const label = $('daily-best-label');

    $('daily-best').textContent = todayRun ? todayRun.score.toLocaleString() : (locked ? 'NO SCORE' : '—');
    if (label) label.textContent = locked ? "TONIGHT'S RESULT" : 'YOUR BEST TONIGHT';

    btn.disabled = locked;
    btn.classList.toggle('done', locked);
    btn.textContent = locked ? 'TONIGHT IS SPENT' : 'GO OUT TONIGHT';

    if (!locked) {
      $('daily-note').textContent = 'Tonight’s route is fixed. Your Stockpile applies. One attempt.';
    } else if (todayRun) {
      $('daily-note').textContent =
        `Held out ${formatTime(todayRun.time)} · ${todayRun.kills} put down. The next night unlocks in the countdown above.`;
    } else {
      $('daily-note').textContent =
        'Attempt used. Practice nights are unlimited — the real one returns tomorrow.';
    }

    // Streak block.
    const st = save.streakStatus(today);
    const flame = $('streak-flame');
    $('streak-count').textContent = st.streak;
    flame.classList.toggle('cold', st.streak === 0);
    const sub = $('streak-sub');
    sub.className = 'streak-sub';
    if (locked && !todayRun) {
      sub.textContent = st.streak > 0
        ? `Tonight ended without a result. The ${st.streak}-night streak cannot be extended.`
        : 'Tonight ended without a result. No streak was started.';
      sub.classList.add('bad');
    } else if (st.playedToday) {
      sub.textContent = `Locked in for today. Come back tomorrow to reach ${st.streak + 1}.`;
    } else if (st.atRisk) {
      sub.textContent = `Play today or the ${st.streak}-day streak ends.`;
      sub.classList.add('warn');
    } else if (st.broken) {
      const lost = save.data.streak;
      sub.textContent = `You missed a day. The ${lost}-day streak is gone.`;
      sub.classList.add('bad');
    } else if (st.streak === 0) {
      sub.textContent = 'Go out tonight to begin.';
    }

    // Milestones.
    const ms = $('milestones');
    ms.innerHTML = '';
    const nextM = MILESTONES.find((m) => m.days > st.streak);
    for (const m of MILESTONES) {
      const done = save.data.claimedMilestones.includes(m.days);
      const node = el('div', 'milestone' + (done ? ' done' : (nextM && nextM.days === m.days ? ' next' : '')));
      node.innerHTML = `<span class="d">${m.days}</span>${done ? 'CLAIMED' : `▣${m.shards}`}`;
      node.title = `${m.label} — ${m.shards} scrap${m.unlockName ? ' + ' + m.unlockName : ''}`;
      ms.appendChild(node);
    }

    this._startCountdown();
  }

  _startCountdown() {
    clearInterval(this._countdownTimer);
    const tick = () => {
      const node = $('daily-countdown');
      if (!node) return;
      node.textContent = formatCountdown(msUntilTomorrow());
    };
    tick();
    this._countdownTimer = setInterval(tick, 1000);
  }

  showInstallButton(show) {
    $('btn-install').classList.toggle('hidden', !show);
  }

  // ------------------------------------------------------------ brief

  showBrief(cfg) {
    $('brief-mode').textContent = cfg.isDaily ? 'TONIGHT' : 'PRACTICE NIGHT';
    $('brief-date').textContent = cfg.isDaily
      ? `${cfg.dateKey}  •  ONE FIXED ROUTE`
      : 'The horde and rewards shift each run. Does not count toward your streak.';

    if (cfg.mutator) {
      $('brief-mutator').textContent = cfg.mutator.name;
      $('brief-mutator-desc').textContent = cfg.mutator.desc;
    } else {
      $('brief-mutator').textContent = 'REHEARSAL';
      $('brief-mutator-desc').textContent = 'Learn the streets and chase a score. Scrap does not cross back from Practice.';
    }

    const core = coreFor(save.data.equippedWeapon);
    const weapon = WEAPONS[save.data.equippedWeapon] || WEAPONS.weapon_machete;
    const trail = TRAILS[save.data.equippedTrail] || TRAILS.trail_cyan;
    $('brief-loadout').innerHTML =
      `<div>SURVIVOR<b>${core.name}</b></div>` +
      `<div>WEAPON<b>${weapon.name}</b></div>` +
      `<div>LANTERN<b>${trail.name}</b></div>`;

    const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    if (touch) {
      const moveSide = save.data.settings.leftHanded ? 'RIGHT' : 'LEFT';
      const actionSide = save.data.settings.leftHanded ? 'LEFT' : 'RIGHT';
      $('brief-controls').innerHTML =
        `<div><b>${moveSide} SIDE</b> drag to move</div>` +
        `<div><b>${actionSide} SIDE</b> tap to sprint · hold for heavy</div>` +
        `<div><b>AUTO-ATTACK</b> targets the nearest threat</div>`;
    } else {
      $('brief-controls').innerHTML =
        `<div><b>WASD / ARROWS</b> move</div>` +
        `<div><b>SPACE</b> sprint · <b>E</b> heavy attack</div>` +
        `<div><b>MOUSE</b> aims · attacks fire automatically</div>`;
    }
    $('btn-begin').textContent = cfg.isDaily ? 'START TONIGHT' : 'START PRACTICE';

    // The radio only shows up for the real night — that's the one it keeps a log of.
    const rivalBlock = $('brief-rival');
    if (cfg.isDaily) {
      rivalBlock.classList.remove('hidden');
      $('brief-rival-line').textContent = voice.rival('dailyStart');
      this.portrait('brief-rival-face', RIVAL)?.resize();
    } else {
      rivalBlock.classList.add('hidden');
    }

    this.show('brief');
  }

  showAbout() {
    const core = coreFor(save.data.equippedWeapon);
    $('about-core-name').textContent = core.name;
    $('about-core-role').textContent = core.role;
    $('about-line').textContent = STAKES.line;
    $('about-line2').textContent = STAKES.line2.replace('{name}', core.name);
    $('about-signoff').textContent = STAKES.signoff;
    this.show('about');
    this.portrait('about-core-face', core)?.resize();
    this.portrait('about-rival-face', RIVAL)?.resize();
  }

  // ------------------------------------------------------------ HUD

  updateHud(run) {
    const L = this._last;
    const p = run.player, s = run.stats;

    const score = Math.round(run.score);
    if (score !== L.score) {
      const node = $('hud-score');
      node.textContent = score.toLocaleString();
      if (score > (L.score || 0)) {
        node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump');
      }
      L.score = score;
    }

    const combo = run.combo;
    if (combo !== L.combo) {
      const node = $('hud-combo');
      if (combo >= 3) {
        node.textContent = `x${(1 + Math.min(4, combo * 0.08)).toFixed(2)}  ${combo} CHAIN`;
        node.classList.add('on');
        node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump');
      } else {
        node.classList.remove('on');
      }
      L.combo = combo;
    }

    const t = Math.floor(run.time);
    if (t !== L.time) { $('hud-time').textContent = formatTime(run.time); L.time = t; }

    const waveSeconds = run.waveState === 'intermission' ? Math.ceil(run.waveBreakT) : -1;
    let countedAlive = 0;
    for (let i = 0; i < run.enemies.active; i++) {
      if (run.enemies.items[i].countsForRound) countedAlive++;
    }
    const extraAlive = run.enemies.active - countedAlive;
    const left = run.waveRemaining + countedAlive;
    const waveKey = `${run.wave}:${run.waveState}:${left}:${extraAlive}:${waveSeconds}`;
    if (waveKey !== L.wave) {
      const alive = run.enemies.active;
      $('hud-wave').textContent = run.waveState === 'intermission'
        ? `ROUND ${run.wave} CLEAR · ${waveSeconds}s`
        : left > 0
          ? `ROUND ${run.wave} · ${left} LEFT${extraAlive ? ` · +${extraAlive} EXTRA` : ''}`
          : `ROUND ${run.wave} · CLEAR ${extraAlive} EXTRA`;
      $('hud-wave').classList.toggle('break', run.waveState === 'intermission');
      $('hud-wave').classList.toggle('hunt', run.waveState === 'combat' && run.waveRemaining <= 0 && alive <= 5);
      L.wave = waveKey;
    }

    const actionKey = `${p.dashLeft}:${Math.ceil(p.dashCd * 10)}`;
    if (actionKey !== L.action) {
      const node = $('hud-action');
      if (p.dashLeft > 0) {
        node.textContent = `SPRINT READY · ${p.dashLeft}`;
        node.classList.add('ready');
      } else {
        node.textContent = `SPRINT ${(p.dashCd || 0).toFixed(1)}s`;
        node.classList.remove('ready');
      }
      L.action = actionKey;
    }

    if (run.tier !== L.tier) { $('hud-tier').textContent = run.palette.tierName; L.tier = run.tier; }

    const sh = Math.round(run.runShards);
    if (sh !== L.shards) { $('hud-shard-n').textContent = sh; L.shards = sh; }

    const hpPct = Math.max(0, p.hp / s.maxHp);
    const hpKey = Math.round(hpPct * 100);
    if (hpKey !== L.hp) {
      const fill = $('hp-fill');
      fill.style.width = (hpPct * 100).toFixed(1) + '%';
      fill.classList.toggle('low', hpPct <= 0.3);
      $('hp-text').textContent = `${Math.max(0, Math.ceil(p.hp))} / ${Math.round(s.maxHp)}`;
      L.hp = hpKey;
    }

    const xpPct = p.xp / p.xpNext;
    const xpKey = Math.round(xpPct * 100);
    if (xpKey !== L.xp) { $('xp-fill').style.width = (xpPct * 100).toFixed(1) + '%'; L.xp = xpKey; }
    if (p.level !== L.level) { $('hud-level').textContent = `LV ${p.level}`; L.level = p.level; }
  }

  resetHudCache() { this._last = {}; }

  // ------------------------------------------------------------ level up

  showUpgrades(choices, label, onPick) {
    $('lvl-title').textContent = `${label} — TAKE ONE`;
    const wrap = $('upgrade-cards');
    wrap.innerHTML = '';
    choices.forEach((c) => {
      const [category] = UPGRADE_VISUALS[c.def.id] || ['utility'];
      const card = el('button', `up-card cat-${category}`);
      card.type = 'button';
      const cleanDesc = c.desc.replace(/\s*\(\d+\/\d+\)\s*$/, '');
      const pips = Array.from({ length: c.def.max }, (_, i) =>
        `<span class="${i < c.level ? 'on' : ''}"></span>`).join('');
      card.innerHTML =
        `<div class="up-icon">${upgradeIconSvg(c.def.id)}</div>` +
        `<div class="up-body">` +
        `<div class="up-head"><div class="up-name">${c.name}</div><div class="up-cat">${category}</div></div>` +
        `<div class="up-desc">${cleanDesc}</div>` +
        `<div class="up-foot"><div class="up-pips" aria-label="Level ${c.level} of ${c.def.max}">${pips}</div>` +
        (c.level === 1 ? '<div class="up-new">NEW</div>' : '') + `</div>` +
        `</div>`;
      card.addEventListener('click', (e) => {
        e.preventDefault();
        audio.upgradeSelect();
        juice.vibrate(12);
        onPick(c);
      });
      wrap.appendChild(card);
    });
    this.show('levelup');
    requestAnimationFrame(() => wrap.querySelector('.up-card')?.focus());
  }

  // ------------------------------------------------------------ pause

  showPause(run) {
    $('pause-stats').innerHTML =
      row('SCORE', Math.round(run.score).toLocaleString()) +
      row('TIME', formatTime(run.time)) +
      row('KILLS', run.kills) +
      row('SCRAP', '▣ ' + Math.round(run.runShards));
    this._quitArmed = false;
    clearTimeout(this._quitTimer);
    $('btn-quit').textContent = run.cfg.isDaily ? 'ABANDON TONIGHT' : 'END PRACTICE';
    $('pause-quit-note').textContent = run.cfg.isDaily
      ? 'Ending now spends tonight’s attempt. Collected scrap is still banked.'
      : 'Practice scores and scrap are not saved when you end early.';
    this.show('pause');
    requestAnimationFrame(() => $('btn-resume')?.focus());
    function row(k, v) { return `<div><span class="k">${k}</span><span class="v">${v}</span></div>`; }
  }

  // ------------------------------------------------------------ game over

  /**
   * @param {object} snapshot records captured before this run was written to the save,
   *   so the comparisons aren't measured against a best that already includes this run.
   */
  showGameOver(res, streakResult, snapshot = {}) {
    const abandoned = !!snapshot.abandoned;
    $('go-mode').textContent = res.isDaily ? `TONIGHT — ${res.date}` : 'PRACTICE NIGHT';
    $('go-score').textContent = res.score.toLocaleString();

    // Label the retry button for what it will actually do (see its click handler).
    $('btn-again').textContent =
      (res.isDaily && save.dailyLocked()) ? 'PRACTICE NIGHT' : 'GO OUT AGAIN';

    const prevBest = snapshot.priorBest ?? (res.isDaily ? save.data.bestDailyScore : save.data.bestPracticeScore);
    const isBest = !abandoned && res.score > 0 && res.score >= prevBest;
    $('go-title').textContent = abandoned
      ? (res.isDaily ? 'NIGHT ABANDONED' : 'PRACTICE ENDED')
      : isBest ? 'NEW PERSONAL BEST' : 'RUN ENDED';

    const delta = $('go-delta');
    delta.className = 'score-delta';
    if (abandoned) {
      delta.textContent = 'NO SCORE RECORDED';
    } else if (isBest && prevBest > 0) {
      delta.textContent = `+${(res.score - prevBest).toLocaleString()} OVER YOUR BEST`;
      delta.classList.add('best');
    } else if (prevBest > 0) {
      const d = prevBest - res.score;
      delta.textContent = `${d.toLocaleString()} SHORT OF YOUR BEST (${prevBest.toLocaleString()})`;
      delta.classList.add('down');
    } else {
      delta.textContent = 'FIRST RECORD SET';
      delta.classList.add('up');
    }

    $('go-stats').innerHTML =
      cell('SURVIVED', res.timeStr) +
      cell('KILLS', res.kills.toLocaleString()) +
      cell('ROUND', res.wave) +
      cell('LEVEL', res.level) +
      cell('BEST CHAIN', 'x' + res.bestCombo) +
      cell('HOW LATE', res.tierName) +
      cell('CONDITIONS', res.mutator ? res.mutator.name : 'ORDINARY');

    // Comparisons: personal best, yesterday's daily, today's earlier attempt.
    const cmp = $('go-compare');
    cmp.innerHTML = '';
    const yesterday = save.dailyScore(dayOffsetKey(-1));

    if (!abandoned) cmp.appendChild(cmpRow('Personal best', prevBest || 0, res.score));
    if (!abandoned && res.isDaily) {
      cmp.appendChild(cmpRow('Last night', yesterday ? yesterday.score : null, res.score));
      const bestToday = snapshot.priorToday;
      if (bestToday && bestToday.score !== res.score) {
        cmp.appendChild(cmpRow('Your best tonight', bestToday.score, res.score));
      }
    }
    if (!abandoned) {
      cmp.appendChild(cmpRow('Longest held', save.data.bestTime ? formatTime(save.data.bestTime) : null, null, res.timeStr));
    }

    $('go-shards').textContent = res.shards.toLocaleString();
    $('go-shard-label').textContent = res.isDaily ? 'SCRAP BANKED' : 'PRACTICE ONLY — NOT BANKED';

    // Streak.
    const sNode = $('go-streak');
    sNode.className = 'streak-result';
    if (!res.isDaily) {
      sNode.innerHTML = abandoned
        ? `<span class="note">Ended Practice saves no score or scrap. Streak progress comes from Tonight.</span>`
        : `<span class="note">Practice saves your best score only. Scrap and streak progress come from Tonight.</span>`;
    } else if (abandoned) {
      sNode.classList.add('lost');
      sNode.innerHTML = `<span class="big">ATTEMPT SPENT</span>` +
        `<span class="note">Your streak was not extended. Tonight returns at midnight.</span>`;
    } else if (streakResult?.milestone) {
      sNode.classList.add('gain');
      const m = streakResult.milestone;
      sNode.innerHTML = `<span class="big">${streakResult.streak}-NIGHT STREAK</span>` +
        `${m.label} reached — <b>▣${m.shards + (m.duplicateBonus || 0)}</b> bonus scrap` +
        (m.duplicateBonus ? `<span class="note">Includes ▣${m.duplicateBonus} because the Fire Axe was already owned.</span>` : '') +
        (m.unlockName && !m.duplicateBonus ? `<span class="note">Unlocked: ${m.unlockName}</span>` : '');
    } else if (streakResult?.extended) {
      sNode.classList.add('gain');
      const next = MILESTONES.find((m) => m.days > streakResult.streak);
      sNode.innerHTML = `<span class="big">${streakResult.streak}-NIGHT STREAK</span>` +
        (next ? `<span class="note">${next.days - streakResult.streak} more night${next.days - streakResult.streak > 1 ? 's' : ''} to ▣${next.shards}</span>` : '');
    } else if (streakResult?.reset) {
      sNode.classList.add('lost');
      sNode.innerHTML = `<span class="big">STREAK RESET</span>You missed a night, so it’s back to 1.` +
        `<span class="note">Streaks only survive if you go out every night.</span>`;
    } else if (streakResult) {
      sNode.innerHTML = `<span class="big">${save.data.streak}-NIGHT STREAK</span>` +
        `<span class="note">Night one is logged. Come back tomorrow to extend it.</span>`;
    }

    // --- characters ---
    const core = coreFor(save.data.equippedWeapon);
    $('go-core-who').textContent = core.name;
    // A milestone outranks dying: the run ended, but the streak is the story.
    $('go-core-line').textContent = abandoned
      ? 'Back inside. Still breathing.'
      : voice.player(streakResult?.milestone ? 'milestone' : 'death');
    this.portrait('go-core-face', core)?.resize();

    const rivalBlock = $('go-rival');
    if (res.isDaily && !abandoned) {
      rivalBlock.classList.remove('hidden');
      // The rival's line responds to the streak first, then to the run itself.
      let line;
      if (streakResult?.milestone) line = voice.rivalMilestone(streakResult.milestone.days);
      else if (streakResult?.reset) line = voice.rival('streakBroken');
      else line = voice.rivalVerdict(res.score, prevBest, res.time);
      $('go-rival-line').textContent = line;
      this.portrait('go-rival-face', RIVAL)?.resize();
    } else {
      rivalBlock.classList.add('hidden');
    }

    this.show('gameover');

    function cell(k, v) { return `<div><span class="k">${k}</span><span class="v">${v}</span></div>`; }
    function cmpRow(label, prev, now, nowStr) {
      const n = el('div', 'compare-row');
      if (prev == null) {
        n.innerHTML = `<span class="k">${label}</span><span class="v">—</span>`;
        return n;
      }
      if (nowStr != null) {
        n.innerHTML = `<span class="k">${label}</span><span class="v">${prev}</span>`;
        return n;
      }
      const win = now >= prev;
      n.className = 'compare-row ' + (win ? 'win' : 'lose');
      const diff = now - prev;
      n.innerHTML = `<span class="k">${label}</span><span class="v">${prev.toLocaleString()} ` +
        `<small>(${diff >= 0 ? '+' : ''}${diff.toLocaleString()})</small></span>`;
      return n;
    }
  }

  // ------------------------------------------------------------ shop

  buildShop() {
    $('shop-shards').textContent = save.data.shards.toLocaleString();
    const list = $('shop-list');
    list.innerHTML = '';

    const groups = {};
    for (const item of SHOP) (groups[item.cat] ||= []).push(item);

    // Streak-locked lanterns appear alongside purchasable ones so the reward is visible.
    for (const id in STREAK_LOCKED) {
      (groups.Lanterns ||= []).push({ id, cat: 'Lanterns', name: TRAILS[id].name,
                                     cost: null, streakReq: STREAK_LOCKED[id], desc: 'Streak reward' });
    }
    // The standard lantern is always owned; list it so the equip toggle makes sense.
    groups.Lanterns.unshift({ id: 'trail_cyan', cat: 'Lanterns', name: TRAILS.trail_cyan.name, cost: 0, desc: 'Standard issue' });
    groups.Weapons.unshift({ id: 'weapon_machete', cat: 'Weapons', name: WEAPONS.weapon_machete.name, cost: 0 });

    // A weapon changes HOLT's loadout, not the protagonist. Show the equipment itself;
    // repeating the same portrait under three different names made the stockpile look
    // like it was selling characters that do not exist in the game art.
    for (const item of groups.Weapons) {
      const loadout = CORES[item.id];
      const weapon = WEAPONS[item.id];
      if (!loadout || !weapon) continue;
      item.name = weapon.name;
      item.desc = `<em>${loadout.blurb}</em><br>${weapon.desc}`;
    }
    for (const item of groups.Lanterns) {
      if (TRAIL_BLURBS[item.id]) item.desc = TRAIL_BLURBS[item.id];
    }

    for (const cat of ['Weapons', 'Supplies', 'Lanterns']) {
      const items = groups[cat];
      if (!items) continue;
      const group = el('div', 'shop-group');
      group.appendChild(el('h3', null, cat.toUpperCase()));
      for (const item of items) group.appendChild(this._shopItem(item));
      list.appendChild(group);
    }
  }

  _shopItem(item) {
    const owned = save.has(item.id);
    const isWeapon = item.id.startsWith('weapon_');
    const isTrail = item.id.startsWith('trail_');
    const equipped = (isWeapon && save.data.equippedWeapon === item.id) ||
                     (isTrail && save.data.equippedTrail === item.id);
    const reqMet = !item.req || save.has(item.req);
    const streakLocked = item.streakReq && !owned;

    const node = el('div', 'shop-item' + (equipped ? ' equipped' : owned ? ' owned' : '') +
                            (!reqMet || streakLocked ? ' locked' : ''));

    if (isTrail) {
      const t = TRAILS[item.id];
      const dot = el('div', 'trail-dot');
      dot.style.background = `rgb(${t.rgb.join(',')})`;
      dot.style.boxShadow = `0 0 12px rgb(${t.rgb.join(',')})`;
      node.appendChild(dot);
    }

    if (item.core) {
      // A live portrait beats a swatch: you can see who you're buying.
      const c = el('canvas', 'portrait');
      c.id = 'shop-face-' + item.id;
      c.width = c.height = 72;
      node.appendChild(c);
      const p = new Portrait(c, item.core);
      p.resize();
      p.update(Math.random() * 3);
      p.draw();
    }

    const info = el('div', 'shop-info');
    info.innerHTML = `<div class="shop-name">${item.name}</div>` +
                     (item.core ? `<div class="core-line"><span class="core-tag">${item.core.role.toUpperCase()}</span></div>` : '') +
                     `<div class="shop-desc">${item.desc}</div>`;
    node.appendChild(info);

    let action;
    if (streakLocked) {
      action = el('div', 'shop-action locked-tag', item.streakReq.toUpperCase());
    } else if (equipped) {
      action = el('div', 'shop-action equipped-tag', 'EQUIPPED');
    } else if (owned) {
      if (isWeapon || isTrail) {
        action = el('button', 'shop-action', 'EQUIP');
        action.addEventListener('click', () => {
          if (isWeapon) save.data.equippedWeapon = item.id;
          else save.data.equippedTrail = item.id;
          save.saveNow();
          audio.uiClick(); juice.vibrate(10);
          this.buildShop();
        });
      } else {
        action = el('div', 'shop-action equipped-tag', 'OWNED');
      }
    } else if (!reqMet) {
      const prev = SHOP.find((s) => s.id === item.req);
      action = el('div', 'shop-action locked-tag', `NEEDS ${prev ? prev.name.toUpperCase() : '—'}`);
    } else {
      const afford = save.data.shards >= item.cost;
      action = el('button', 'shop-action buy' + (afford ? '' : ' cant'), `▣ ${item.cost.toLocaleString()}`);
      action.addEventListener('click', () => {
        if (!save.spendShards(item.cost)) { this.toast('Not enough scrap.'); audio.uiBack(); return; }
        save.unlock(item.id);
        if (item.id.startsWith('weapon_')) save.data.equippedWeapon = item.id;
        if (item.id.startsWith('trail_')) save.data.equippedTrail = item.id;
        save.saveNow();
        audio.milestone();
        juice.vibrate([0, 20, 40, 20]);
        this.toast(`${item.name} unlocked.`);
        this.buildShop();
      });
    }
    node.appendChild(action);
    return node;
  }

  // ------------------------------------------------------------ settings

  buildSettings() {
    const list = $('settings-list');
    list.innerHTML = '';
    const s = save.data.settings;
    const g = this.game;

    const addToggle = (label, sub, key, onChange) => {
      const row = el('div', 'setting');
      row.innerHTML = `<div><div class="setting-label">${label}</div><div class="setting-sub">${sub}</div></div>`;
      const sw = el('div', 'switch' + (s[key] ? ' on' : ''));
      sw.setAttribute('role', 'switch');
      sw.setAttribute('tabindex', '0');
      sw.setAttribute('aria-checked', String(!!s[key]));
      sw.setAttribute('aria-label', label);
      const flip = () => {
        s[key] = !s[key];
        sw.classList.toggle('on', s[key]);
        sw.setAttribute('aria-checked', String(s[key]));
        save.save();
        audio.uiClick();
        juice.vibrate(8);
        onChange?.(s[key]);
      };
      sw.addEventListener('click', flip);
      sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
      const ctl = el('div', 'setting-ctl'); ctl.appendChild(sw);
      row.appendChild(ctl);
      list.appendChild(row);
    };

    const addSlider = (label, sub, key, min, max, step, onChange) => {
      const row = el('div', 'setting');
      row.innerHTML = `<div><div class="setting-label">${label}</div><div class="setting-sub">${sub}</div></div>`;
      const input = el('input');
      input.type = 'range'; input.min = min; input.max = max; input.step = step;
      input.value = s[key];
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => {
        s[key] = parseFloat(input.value);
        save.save();
        onChange?.(s[key]);
      });
      const ctl = el('div', 'setting-ctl'); ctl.appendChild(input);
      row.appendChild(ctl);
      list.appendChild(row);
    };

    /**
     * @param {boolean} wide stacks the control under the label instead of beside it.
     *   Needed once an option set gets past ~3 items: inline, five buttons plus a label
     *   overflow a 375px-wide phone.
     */
    const addSeg = (label, sub, key, options, onChange, wide = false) => {
      const row = el('div', 'setting' + (wide ? ' stacked' : ''));
      row.innerHTML = `<div><div class="setting-label">${label}</div><div class="setting-sub">${sub}</div></div>`;
      const seg = el('div', 'seg' + (wide ? ' wrap' : ''));
      options.forEach(([val, text]) => {
        const b = el('button', s[key] === val ? 'on' : '', text);
        b.addEventListener('click', () => {
          s[key] = val;
          save.save();
          audio.uiClick();
          [...seg.children].forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
          onChange?.(val);
        });
        seg.appendChild(b);
      });
      const ctl = el('div', 'setting-ctl'); ctl.appendChild(seg);
      row.appendChild(ctl);
      list.appendChild(row);
    };

    addToggle('Mute all audio', 'Silences music and effects.', 'muted', (v) => audio.setMuted(v));
    addSlider('Music volume', 'Run theme and sparse village ambience.', 'musicVolume', 0, 1, 0.05, (v) => audio.setMusicVolume(v));
    addSlider('Effects volume', 'Weapons, impacts, pickups.', 'sfxVolume', 0, 1, 0.05, (v) => audio.setSfxVolume(v));
    addSlider('Screen shake', 'Set to zero if motion bothers you.', 'screenShake', 0, 1.5, 0.1, (v) => { juice.shakeScale = v; });
    addToggle('Haptics', 'Vibration on impacts, where supported.', 'haptics', (v) => { juice.haptics = v; });
    addToggle('Colourblind palette', 'Blue/orange only. Shapes still carry threat information.', 'colorblind', (v) => g.setColorblind(v));
    addToggle('Left-handed', 'Puts the movement stick on the right.', 'leftHanded', (v) => g.input.setOptions({ leftHanded: v }));
    addSeg('Quality', 'Lower this if the frame rate dips.', 'quality',
           [['auto', 'AUTO'], ['high', 'HIGH'], ['low', 'LOW']], (v) => g.setQuality(v));

    const b = $('btn-reset');
    if (b) b.textContent = 'ERASE ALL PROGRESS';
    this._resetArmed = false;
  }

  // ------------------------------------------------------------ records

  buildRecords() {
    const d = save.data;
    const score = (value) => value > 0 ? value.toLocaleString() : '—';
    $('records-grid').innerHTML =
      cell('BEST NIGHT', score(d.bestDailyScore)) +
      cell('BEST PRACTICE', score(d.bestPracticeScore)) +
      cell('LONGEST HELD', d.bestTime > 0 ? formatTime(d.bestTime) : '—') +
      cell('CURRENT STREAK', d.streak) +
      cell('BEST STREAK', d.bestStreak) +
      cell('RUNS PLAYED', d.totalRuns.toLocaleString()) +
      cell('TOTAL PUT DOWN', d.totalKills.toLocaleString()) +
      cell('SCRAP EARNED', '▣ ' + d.totalShardsEarned.toLocaleString());

    const hist = $('daily-history');
    hist.innerHTML = '';
    const keys = Object.keys(d.dailyScores).sort().reverse().slice(0, 30);
    if (!keys.length) {
      hist.appendChild(el('div', 'empty', 'No nights recorded yet.'));
      return;
    }
    for (const k of keys) {
      const r = d.dailyScores[k];
      const mut = mutatorFor(k);
      const row = el('div', 'hist-row');
      row.innerHTML =
        `<div><div class="hist-date">${k}</div><div class="hist-mut">${mut.name}</div></div>` +
        `<div style="text-align:right"><div class="hist-score">${r.score.toLocaleString()}</div>` +
        `<div class="hist-date">${formatTime(r.time)} · ${r.kills} kills</div></div>`;
      hist.appendChild(row);
    }
    function cell(k, v) { return `<div><span class="k">${k}</span><span class="v">${v}</span></div>`; }
  }
}

export { MUTATORS };
