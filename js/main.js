// Bootstrap, fixed-timestep loop, state machine.
//
// Simulation runs at a fixed 120 steps/sec with an accumulator, rendering once per rAF.
// A fixed step is what makes the Daily Run reproducible: floating-point integration with
// a variable dt would diverge between a 60Hz and a 120Hz phone within seconds, and two
// players would get different runs from the same seed.

import { save } from './core/save.js';
import { audio } from './core/audio.js';
import { Input } from './core/input.js';
import { Renderer } from './fx/render.js';
import { juice } from './fx/juice.js';
import { Run } from './game/run.js';
import { makeRunConfig } from './game/daily.js';
import { UI } from './ui/screens.js';
import { todayKey } from './core/rng.js';
import { voice } from './game/voice.js';
import { coreFor, RIVAL } from './game/characters.js';

const STEP = 1 / 120;
const MAX_FRAME = 0.25;   // never simulate more than a quarter second after a tab stall

const S_MENU = 'menu', S_PLAYING = 'playing', S_LEVELUP = 'levelup',
      S_PAUSED = 'paused', S_OVER = 'over';

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.renderer = new Renderer(this.canvas);
    // Firing is always automatic — auto-aim at the nearest threat, no manual-aim mode.
    // That was previously an option (right side became a second stick when auto-fire
    // was off); the setting is gone, so this is unconditionally the touch-and-dash
    // scheme input.js's own header comment describes as the baseline.
    this.input = new Input(this.canvas, {
      leftHanded: save.data.settings.leftHanded,
      manualAim: false,
    });
    this.ui = new UI(this);

    this.run = null;
    this.state = S_MENU;
    this.lastMode = 'daily';
    this.pendingConfig = null;
    this.acc = 0;
    this.lastT = 0;
    this.fpsSamples = [];
    this.autoQualityChecked = false;
    this.deferredInstall = null;

    // The hand-authored map. Fetched once; every Run built after it lands uses it in
    // place of the procedural generator. Until it lands (a couple of KB, effectively the
    // first frame) runs fall back to generation, which only matters for the menu's own
    // ambient background if the player taps Play in that first instant.
    this.mapData = null;
    this.mapReady = this._loadMap();
    this._beginningRun = false;

    this._applySettings();
    this._bindLifecycle();
    this._bindInstall();

    // Menu background: a live village nobody is defending, purely so the title screen
    // isn't static — the dead wander, the lantern drifts, nothing is at stake.
    this._startAmbient();

    // First launch gets the framing before the menu — it's one screen, once, and it's
    // the only place the daily loop is given a reason.
    if (!save.data.seenTutorial) this.ui.showAbout();
    else this.ui.show('menu');
    this.ui.setHudVisible(false);

    this.lastT = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  // ------------------------------------------------------------ setup

  _applySettings() {
    const s = save.data.settings;
    audio.muted = s.muted;
    audio.sfxVol = s.sfxVolume;
    audio.musicVol = s.musicVolume;
    juice.shakeScale = s.screenShake;
    juice.haptics = s.haptics;
    this.setQuality(s.quality);
  }

  setQuality(q) {
    this.qualityMode = q;
    const effective = q === 'auto' ? (this._autoQuality || 'high') : q;
    this.renderer.setQuality(effective);
    if (this.run) this.run.particles.setBudget(effective === 'high' ? 1 : 0.55);
    if (this.ambient) this.ambient.particles.setBudget(effective === 'high' ? 1 : 0.55);
  }

  setColorblind(v) {
    if (this.run) this.run.palette.setColorblind(v);
    if (this.ambient) this.ambient.palette.setColorblind(v);
  }

  _bindLifecycle() {
    window.addEventListener('resize', () => this.renderer.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.renderer.resize(), 220));

    // Auto-pause when the app is backgrounded. Nothing is more annoying than dying to
    // a phone call.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.state === S_PLAYING) this.pause();
        audio.stopMusic(0.3);
      }
    });

    // Audio unlock on the first real gesture, anywhere.
    //
    // Bound to document.body rather than window: iOS standalone PWAs (installed to the
    // home screen) have been observed to not reliably count a window-level listener as
    // a valid "user gesture" for unlocking AudioContext, even though the identical
    // listener works fine in a normal Safari tab. Binding to a concrete element in the
    // document is the safer target for both contexts.
    const unlock = async () => {
      const ok = await audio.unlock();
      if (ok) {
        requestAnimationFrame(() => {
          audio.setMuted(save.data.settings.muted);
          audio.setSfxVolume(save.data.settings.sfxVolume);
          audio.setMusicVolume(save.data.settings.musicVolume);
        });
        document.body.removeEventListener('pointerdown', unlock);
        document.body.removeEventListener('touchend', unlock);
        document.body.removeEventListener('click', unlock);
        window.removeEventListener('keydown', unlock);
      } else if (audio.failedUnlockAttempts >= 2 && !save.data.settings.muted) {
        // A silent retry loop with no feedback is indistinguishable from "broken" to
        // the player — this is the visible fallback the PWA-fixes brief asked for.
        // Listeners stay attached: the very next tap anywhere still retries unlock()
        // for free, this is purely about telling the player something is actually
        // happening instead of leaving them guessing.
        this.ui.toast('Sound is blocked — tap anywhere to enable it.', 3200);
      }
    };
    document.body.addEventListener('pointerdown', unlock, { passive: true });
    document.body.addEventListener('touchend', unlock, { passive: true });
    document.body.addEventListener('click', unlock);
    window.addEventListener('keydown', unlock); // no element to bind to; window is fine here

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.state === S_PLAYING) this.pause();
        else if (this.state === S_PAUSED) this.resume();
      }
      if (e.code === 'KeyP' && this.state === S_PLAYING) this.pause();
      // Number keys pick upgrades — makes desktop testing far faster.
      if (this.state === S_LEVELUP && /^Digit[123]$/.test(e.code)) {
        const cards = document.querySelectorAll('#upgrade-cards .up-card');
        cards[+e.code.slice(5) - 1]?.click();
      }
    });

    window.addEventListener('beforeunload', () => save.saveNow());
  }

  _bindInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstall = e;
      this.ui.showInstallButton(true);
    });
    window.addEventListener('appinstalled', () => {
      this.deferredInstall = null;
      this.ui.showInstallButton(false);
      this.ui.toast('Installed. See you after dark.');
    });
  }

  async promptInstall() {
    if (!this.deferredInstall) {
      this.ui.toast('Use your browser menu → Add to Home Screen.');
      return;
    }
    this.deferredInstall.prompt();
    await this.deferredInstall.userChoice;
    this.deferredInstall = null;
    this.ui.showInstallButton(false);
  }

  // ------------------------------------------------------------ ambient

  /** A live but unplayed arena behind the menus. Enemies spawn, drift, and die to nothing. */
  /** Load the authored map, then rebuild the menu background on it once it arrives. */
  async _loadMap() {
    try {
      const res = await fetch('assets/maps/town.json');
      if (res.ok) { this.mapData = await res.json(); this._startAmbient(); }
    } catch { /* stay procedural */ }
  }

  _startAmbient() {
    const cfg = makeRunConfig('practice');
    cfg.mapData = this.mapData;
    this.ambient = new Run(cfg);
    // Prime reachability while the decorative survivor is still alive; spawn placement
    // keeps using this field after we disable combat for the menu background.
    this.ambient.world.computeFlow(this.ambient.player.x, this.ambient.player.y);
    this.ambient.player.alive = false;   // no shooting, no collision damage
    this.ambient.stats.magnet = 0;
    this.renderer.snapCamera(0, 0);
  }

  // ------------------------------------------------------------ flow

  openBrief(mode) {
    // Guard here as well as in the UI: the menu button is disabled once the daily is
    // spent, but "RUN AGAIN" on the results screen and the manifest's ?mode=daily
    // shortcut both route through here too, and neither consults the button's state.
    if (mode === 'daily' && save.dailyLocked()) {
      this.ui.toast('Tonight’s run is spent. Practice is unlimited.');
      this.ui.show('menu');
      return;
    }
    this.lastMode = mode;
    this.pendingConfig = makeRunConfig(mode, todayKey());
    this.ui.showBrief(this.pendingConfig);
  }

  async beginRun() {
    if (this._beginningRun) return;
    this._beginningRun = true;
    // A Daily must never depend on whether the player tapped faster than town.json
    // arrived. _loadMap catches failures, so this always settles and the procedural
    // fallback remains available when the authored map genuinely cannot load.
    await this.mapReady;
    this._beginningRun = false;
    const cfg = this.pendingConfig || makeRunConfig(this.lastMode, todayKey());
    this.pendingConfig = null;
    cfg.mapData = this.mapData;

    // Spend the daily attempt now, at the point of no return. Doing this at run *end*
    // would mean a force-quit mid-run costs nothing and the seed can be re-rolled.
    if (cfg.isDaily) save.markDailyAttempted(cfg.dateKey);

    this.run = new Run(cfg);
    this.run.particles.setBudget(this.renderer.quality === 'high' ? 1 : 0.55);

    const core = coreFor(save.data.equippedWeapon);
    voice.setCore(core.id);
    const say = (kind) => this.ui.say(core.name, voice.player(kind), kind);

    this.run.onLevelUp = () => { this._queueLevelUp(); say('levelUp'); };
    this.run.onGameOver = () => this._endRun();
    this.run.onTierChange = (tier) => { this.ui.banner(tier.name); say('tierShift'); };
    this.run.onWaveClear = (wave, seconds) => {
      audio.waveClear();
      this.ui.banner(`ROUND ${wave} CLEAR — ${seconds}s`);
    };
    this.run.onWaveStart = (wave) => {
      this.ui.banner(`ROUND ${wave}`);
      audio.waveStart();
    };
    this.run.onEliteSpawn = () => this.ui.banner('SOMETHING BIG');
    this.run.onEliteKilled = () => say('eliteKill');
    this.run.onMinibossSpawn = (def) => {
      // The rival announces minibosses — reuses the existing voice channel, and gives
      // the event a named author instead of an anonymous banner.
      this.ui.banner(def.name);
      setTimeout(() => this.ui.say(RIVAL.name, voice.rival('miniboss'), 'eliteKill', true), 900);
    };
    this.run.onThreatReveal = (_key, def) => {
      audio.threatReveal();
      this.ui.toast(`NEW THREAT — ${def.name.toUpperCase()}: ${def.desc}`, 3200);
    };
    this.run.onMinibossSplit = () => {
      this.ui.banner('IT CAME APART');
      say('eliteKill');
    };
    this.run.onRevive = () => { this.ui.banner('ADRENALINE SHOT'); say('nearDeath'); };
    this.run.onDropLanded = () => { audio.supplyDrop(); this.ui.banner('SUPPLY DROP'); };
    this.run.onDropTaken = () => this.ui.banner('SUPPLIES SECURED');
    this.run.onDropLost = () => { audio.supplyLost(); this.ui.banner('SUPPLIES LOST'); };
    this.run.onHurt = () => {
      // Below a quarter health the survivor stops reacting to the individual hit and
      // starts calling out the immediate danger — same trigger, higher-priority line.
      say(this.run.player.hp / this.run.stats.maxHp <= 0.25 ? 'nearDeath' : 'hurt');
    };
    this._say = say;

    this.renderer.snapCamera(this.run.player.x, this.run.player.y);
    juice.reset();
    this.input.reset();
    this.ui.resetHudCache();
    this.ui.hideAll();
    this.ui.hideVoice();
    this.ui.setHudVisible(true);
    this.state = S_PLAYING;
    this.acc = 0;

    // Just unlock — _syncTrack starts the composed theme plus the lightweight sparse
    // village events. The continuous wind/drone graph stays off on phones.
    audio.unlock();
    audio.waveStart();
    this.ui.banner(cfg.isDaily ? (cfg.mutator?.name || 'TONIGHT') : 'PRACTICE NIGHT');
  }

  _queueLevelUp() {
    // Deferred: the death of the enemy that dropped the last mote should finish
    // resolving before the game freezes for a menu.
    if (this.state === S_PLAYING) this._pendingLevelUpCheck = true;
  }

  _openLevelUp() {
    const run = this.run;
    if (run.pendingLevelUps <= 0) return;
    const choices = run.rollUpgradeChoices(3);
    if (!choices.length) {
      run.pendingLevelUps = 0;
      run.pendingPickSources.length = 0;
      return;
    }
    // The menu may open while the player's thumb is still moving. Mobile standalone
    // PWAs do not always deliver that pointer's eventual release back to the canvas
    // once the overlay has taken over, so explicitly end the gesture at the boundary.
    this.input.reset();
    this.state = S_LEVELUP;
    this.ui.setHudVisible(false);
    const pickLabel = run.pendingPickSources[0]?.label || `LEVEL ${run.player.level}`;
    this.ui.showUpgrades(choices, pickLabel, (choice) => {
      run.applyUpgrade(choice);
      run.pendingLevelUps--;
      run.pendingPickSources.shift();
      this.ui.hideAll();
      if (run.pendingLevelUps > 0) {
        // FAMINE hands out two per level; chain the menus.
        setTimeout(() => this._openLevelUp(), 60);
      } else {
        this.state = S_PLAYING;
        this.ui.setHudVisible(true);
      }
    });
  }

  pause() {
    if (this.state !== S_PLAYING) return;
    this.input.reset();
    this.state = S_PAUSED;
    this.ui.setHudVisible(false);
    this.ui.showPause(this.run);
    audio.setIntensity(0.1);
  }

  resume() {
    if (this.state !== S_PAUSED) return;
    this.input.reset();
    this.ui.hideAll();
    this.ui.setHudVisible(true);
    this.state = S_PLAYING;
    this.acc = 0;
    this.lastT = performance.now();
  }

  abandon() {
    if (!this.run) return;
    audio.retreat();
    this._endRun(true);
  }

  _endRun(abandoned = false) {
    if (this.state === S_OVER) return;
    const run = this.run;
    this.state = S_OVER;
    run.over = true;
    audio.stopMusic(1.4);

    const res = run.results();
    let streakResult = null;

    // Snapshot the records BEFORE recordRun folds this run into them. Otherwise the
    // results screen compares the run against itself and every new best reads
    // "+0 over your best" / "yesterday: —".
    // (Yesterday's entry needs no snapshot — recordRun only ever touches today's.)
    const priorBest = res.isDaily ? save.data.bestDailyScore : save.data.bestPracticeScore;
    const priorToday = res.isDaily ? save.dailyScore(res.date) : null;

    if (res.isDaily && !abandoned) {
      streakResult = save.commitDaily(res.date);
      if (streakResult.milestone) {
        setTimeout(() => audio.milestone(), 700);
      }
    }
    save.recordRun({
      isDaily: res.isDaily,
      abandoned,
      date: res.date,
      score: res.score, wave: res.wave, time: res.time,
      // Practice is for learning and score-chasing, not an unlimited scrap faucet that
      // makes the one shared night depend on how long somebody was willing to grind.
      kills: res.kills, shards: res.isDaily ? res.shards : 0,
    });

    // Let the death explosion breathe before the results screen slides in.
    setTimeout(() => {
      this.ui.setHudVisible(false);
      this.ui.hideVoice();
      this.ui.showGameOver(res, streakResult, { priorBest, priorToday, abandoned });
      if (!abandoned && res.score > 0) audio.runComplete(res.score > priorBest);
    }, abandoned ? 120 : 1100);
  }

  // ------------------------------------------------------------ loop

  _frame(now) {
    requestAnimationFrame((t) => this._frame(t));

    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (!(dt > 0)) return;
    if (dt > MAX_FRAME) dt = MAX_FRAME;

    this._trackFps(dt);

    audio.update(dt);
    this._syncTrack();
    const simDt = juice.update(dt);

    const active = this.state === S_PLAYING ? this.run
                 : (this.state === S_PAUSED || this.state === S_LEVELUP || this.state === S_OVER) ? this.run
                 : this.ambient;

    if (this.state === S_PLAYING && this.run) {
      this.input.update();
      this.acc += simDt;
      let steps = 0;
      while (this.acc >= STEP && steps < 8) {
        this.run.update(STEP, this.input);
        this.acc -= STEP;
        steps++;
        if (this.run.over) break;
      }
      // If we blew the step budget (very slow device), drop the backlog rather than
      // spiralling — better to lose a little time than to stutter forever.
      if (steps >= 8) this.acc = 0;

      this.ui.updateHud(this.run);

      if (this._pendingLevelUpCheck && this.run.pendingLevelUps > 0 && !this.run.over &&
          this.run.waveState === 'intermission') {
        this._pendingLevelUpCheck = false;
        this._openLevelUp();
      }
    } else if (this.state === S_OVER && this.run) {
      this.run.update(simDt, this.input);
    } else if (active === this.ambient) {
      this.input.update();
      this._updateAmbient(simDt);
    }

    this.ui.updatePortraits(dt);
    this._render(active, dt);
  }

  /**
   * Keep the looping track in step with what screen we're on.
   *
   * Driven from the frame loop rather than from each transition on purpose: menus are
   * entered from a dozen places (back buttons, the results screen, abandoning a run, the
   * manifest shortcut) and wiring a call into every one of them is how you end up with
   * the menu theme still playing under a run. audio.playTrack() is idempotent for the
   * track already playing, so calling it every frame costs a string compare.
   *
   * The results screen deliberately gets silence: the run's ambience is fading out under
   * it, and dropping a menu loop on top of that steps on the ending.
   */
  _syncTrack() {
    if (!audio.ready) return;
    const s = this.state;
    const want = s === S_MENU ? 'menu'
               : (s === S_PLAYING || s === S_LEVELUP || s === S_PAUSED) ? 'run'
               : null;
    // Decode the run track while the menu is up, not when the player taps GO OUT.
    audio.warmTracks();
    if (want === this._track) return;
    this._track = want;
    if (want) audio.playTrack(want); else audio.stopTrack();
    if (want === 'run') audio.startMusic(true);
    else audio.stopMusic(0.8);
  }

  _updateAmbient(dt) {
    const a = this.ambient;
    // Drive the "player" on a slow lissajous so the camera drifts and the arena breathes.
    const t = performance.now() / 1000;
    a.player.x = Math.cos(t * 0.17) * 340;
    a.player.y = Math.sin(t * 0.23) * 300;
    a.update(dt, { moveX: 0, moveY: 0, moveMag: 0, aimMag: 0, firing: false,
                   manualAim: false, consumeDash: () => false });
    // Cull anything that crowds the camera, so the menu never looks besieged.
    for (let i = a.enemies.active - 1; i >= 0; i--) {
      const e = a.enemies.items[i];
      const dx = e.x - a.player.x, dy = e.y - a.player.y;
      if (dx * dx + dy * dy < 210 * 210) a.enemies.releaseAt(i);
    }
    a.time = Math.min(a.time, 40);   // hold the ambient arena at an easy difficulty
  }

  _render(active, dt) {
    if (!active) return;
    const r = this.renderer;
    r.syncSize();
    const pal = active.palette;

    r.updateCamera(active.player.x, active.player.y, active.arena, dt, {
      x: active.player.vx * 0.09, y: active.player.vy * 0.09,
    }, this.state === S_PLAYING ? (active.intensity || 0) : 0);

    r.begin(pal, juice);
    active.draw(r);
    r.end(pal, juice);

    // Drawn after end() on purpose — see Run.drawFaceOverlay(). The bloom pass in
    // end() blurs the whole scene and adds it back, which is what was washing the
    // eyes out: the dark sockets have no defense against a full-frame glow blur
    // added on top of them. Outside the bloom bracket, they stay crisp.
    active.drawFaceOverlay?.(r);

    // Speech bubble tracks the player every frame it's visible — see positionVoiceNear
    // for why this can't just be set once in ui.say() and left alone.
    if (this.ui.voiceVisible()) {
      const pos = r.worldToScreen(active.player.x, active.player.y, juice);
      this.ui.positionVoiceNear(pos.x, pos.y);
    }

    if (this.state === S_PLAYING) {
      r.drawStick(this.input.stickVisual(), pal);
      r.drawAction(this.input.actionVisual(), pal);
    }

    // Keep the CSS palette in step with the arena.
    this.ui.setHue(pal.hue, pal.colorblind ? pal.hue : pal.hue + 20);
  }

  /**
   * Watch the frame time *during play* and drop quality if we can't hold the display's
   * own refresh rate.
   *
   * The previous version measured the first 140 frames of the session and then set a flag
   * that stopped it looking ever again. Those 140 frames are the main menu — one ambient
   * world, no crowd, no post-processing load worth the name — so on any device where the
   * menu is smooth it concluded "high is fine" and never revisited that during an actual
   * run. A phone that dropped frames the moment a hundred bodies arrived had no way to
   * tell anyone.
   *
   * It also compared against a fixed 48fps. On a 120Hz screen the budget is 8.3ms, not
   * 16.7ms, and a frame that comfortably beat 48 could still be missing every single
   * vsync — which is the specific thing that feels like permanent low-grade stutter
   * rather than like a slow game. The target is now derived from the fastest frame we
   * have actually observed, which is the only honest read on what this display wants.
   */
  _trackFps(dt) {
    if (this.qualityMode !== 'auto' || this._autoQuality === 'low') return;
    // Only judge frames where we were actually rendering a run.
    if (this.state !== S_PLAYING) return;
    // Ignore absurd values: a tab stall or a level-up menu is not a slow frame.
    if (dt > 0.2 || dt <= 0) return;

    this._fastestFrame = Math.min(this._fastestFrame ?? dt, dt);
    this.fpsSamples.push(dt);
    if (this.fpsSamples.length < 180) return;      // ~1.5-3s of play depending on refresh

    const sorted = this.fpsSamples.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.fpsSamples.length = 0;

    // The display's period, inferred rather than assumed. Snapped to the nearest common
    // refresh so a jittery sample doesn't invent a 93Hz screen.
    const hz = 1 / this._fastestFrame;
    const target = hz > 90 ? 1 / 120 : hz > 70 ? 1 / 90 : 1 / 60;
    // Missing by a third of a frame, consistently, is where judder starts to read.
    if (median > target * 1.34) {
      this._autoQuality = 'low';
      this.setQuality('auto');
      console.info(`[nightfall] auto quality -> low (median ${(1 / median).toFixed(0)}fps, `
                 + `display ~${Math.round(1 / target)}Hz)`);
    }
  }
}

// ------------------------------------------------------------------ boot

function boot() {
  window.game = new Game();

  // Installed-app shortcuts land on the requested briefing instead of the generic menu.
  const shortcutMode = new URLSearchParams(location.search).get('mode');
  if (shortcutMode === 'daily' || shortcutMode === 'practice') {
    requestAnimationFrame(() => window.game.openBrief(shortcutMode));
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[nightfall] sw failed', e));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
