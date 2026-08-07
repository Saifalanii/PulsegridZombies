// Procedural audio. Raw Web Audio API — no Tone.js, no sample files.
//
// Judgment call: I dropped Tone.js. It's a great library, but it's ~200KB of CDN
// dependency in a game whose whole point is offline-first PWA installability, and
// everything here is short envelopes on primitive oscillators plus one noise buffer.
// Hand-rolling it keeps the service worker cache tiny and the latency floor low.
//
// Graph:
//   [sfx voices] -> sfxBus -> comp -> master -> destination
//   [ambience]   -> musicBus -> comp -^
//
// There is no sequencer here and no tempo. See the "ambience" section at the bottom
// for why the 16-step grid this file used to run was the wrong instrument entirely.

import { clamp } from './math.js';

const ROOT = 55; // A1 — still the tuning centre for the few pitched UI stingers.

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Vocal formant triples (F1, F2, F3) in Hz, roughly the vowels a slack jaw can make.
 * Everything with a throat in this game is synthesised by exciting a buzzy source and
 * parking three bandpass filters on one of these — that resonance, not the waveform,
 * is what makes a sound read as a body rather than as an oscillator. Two detuned saws
 * with no formants (what groan() used to be) is a synth pad, and always will be.
 */
const VOWELS = [
  [570, 840, 2410],   // aw
  [730, 1090, 2440],  // ah
  [640, 1190, 2390],  // uh
  [440, 1020, 2240],  // oo-ish
  [300, 870, 2240],   // oo
  [490, 1350, 1690],  // er
  [660, 1720, 2410],  // ae
];

const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Shoot-SFX variants, selectable in Settings. See AudioEngine.shoot() for why each of
 * these keeps pitch movement and stays short.
 *
 * `this` is the AudioEngine; `p` is the already-jittered pitch multiplier.
 */
export const SHOOT_STYLE_IDS = ['pulse', 'pluck', 'puff', 'zap', 'tick'];

export const SHOOT_STYLE_LABELS = {
  pulse: 'Bowstring',
  pluck: 'Deep Draw',
  puff:  'Muffled',
  zap:   'Whipcrack',
  tick:  'Dry Snap',
};

const SHOOT_STYLES = {
  /**
   * Default. A short descending sweep with a soft edge — the classic "pew" shape, but
   * an octave up from the original and less than half its length, which is what keeps
   * it out of the buzzy low-mids. The sweep is the whole point: continuous frequency
   * motion is what stops a repeated short sound reading as a relay click.
   */
  pulse(p) {
    this._tone({ type: 'triangle', freq: 1250 * p, toFreq: 540 * p, dur: 0.055, gain: 0.058, attack: 0.001 });
    this._tone({ type: 'sine', freq: 2500 * p, toFreq: 1300 * p, dur: 0.032, gain: 0.020 });
    this._noiseHit({ dur: 0.018, gain: 0.022, freq: 3000, sweepTo: 1600, q: 1.2 });
  },

  /**
   * Warmest option. Sine with a fast pitch drop plus a touch of second harmonic —
   * closer to a kalimba/marimba note than a weapon. Most pleasant over a long run,
   * least "gun". Good if the tick felt mechanical.
   */
  pluck(p) {
    this._tone({ type: 'sine', freq: 880 * p, toFreq: 430 * p, dur: 0.085, gain: 0.062, attack: 0.002 });
    this._tone({ type: 'sine', freq: 1760 * p, toFreq: 900 * p, dur: 0.045, gain: 0.020 });
  },

  /**
   * Suppressed. Almost entirely filtered noise with a fast decay and only a whisper of
   * tone — reads as a silenced weapon. The quietest and least intrusive option; pick
   * this if the firing sound should essentially disappear under the music.
   */
  puff(p) {
    this._noiseHit({ dur: 0.055, gain: 0.055, freq: 1500 * p, sweepTo: 420 * p, q: 0.8, type: 'lowpass' });
    this._tone({ type: 'sine', freq: 620 * p, toFreq: 380 * p, dur: 0.035, gain: 0.018 });
  },

  /**
   * Brightest and most arcade. Sawtooth sweeping fast and high — closest to a classic
   * vector-shooter laser. More present in the mix than the others by design; the one
   * to pick if the others feel too polite.
   */
  zap(p) {
    this._tone({ type: 'sawtooth', freq: 1900 * p, toFreq: 780 * p, dur: 0.045, gain: 0.042, attack: 0.001 });
    this._tone({ type: 'square', freq: 3200 * p, toFreq: 1500 * p, dur: 0.022, gain: 0.014 });
  },

  /**
   * The hit-marker tick. Kept because it is genuinely the most unobtrusive, but it is
   * the one that reads as a car indicator: a narrow band with almost no frequency
   * motion. Retained as an option rather than a default.
   */
  tick(p) {
    this._noiseHit({ dur: 0.026, gain: 0.05, freq: 3600 * p, sweepTo: 2300 * p, q: 2.4, type: 'bandpass' });
    this._tone({ type: 'sine', freq: 2200 * p, toFreq: 1600 * p, dur: 0.038, gain: 0.038, attack: 0.001 });
  },
};

/**
 * Composed music tracks, streamed from disk and looped.
 *
 * These are the first sounds in the game that aren't synthesised at runtime. They ride a
 * bus of their own rather than `musicBus`, for a reason that is easy to trip over:
 * musicBus is held at gain 0 until `startMusic()` fades it up for a run, so anything
 * routed through it is inaudible on the menu, and `stopMusic()` would drag a track down
 * with the ambience. They also skip the shared reverb send — that convolver exists to put
 * the *effects* in one room, and running a finished mix through it only smears it.
 */
const TRACKS = {
  menu: 'assets/audio/menu-theme.wav',
  run: 'assets/audio/run-theme.ogg',
};

/** Seconds of tail folded back over the head of a loop. See loopSeam below. */
const LOOP_XFADE = 0.02;

/**
 * Recorded one-shots. Everything else in this file is synthesised; these are not.
 *
 * Only the *player's* melee swing uses them. `swing()` is also what a zombie's wind-up
 * plays, and routing that through here would arm every shambler on the street with a
 * sword — hence a separate call rather than a replacement.
 */
const SAMPLES = {
  sword_a: 'assets/audio/sword-1a.wav',
  sword_b: 'assets/audio/sword-1b.wav',
};

/**
 * Make a buffer loop without a click.
 *
 * An AudioBufferSourceNode with `loop = true` jumps from the last sample straight to the
 * first, and if those two don't line up the discontinuity is a click every time round.
 * The menu track ends mid-waveform at about a third of its peak amplitude, which is
 * audible. Folding the last few milliseconds back over the first few with an equal-power
 * crossfade removes it, at the cost of shortening the loop by LOOP_XFADE — 20ms out of
 * twenty seconds, which no one can hear.
 */
function loopSeam(ctx, buf) {
  const fade = Math.min(Math.floor(ctx.sampleRate * LOOP_XFADE), buf.length >> 2);
  if (fade < 8) return buf;
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length - fade, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, out.length));
    for (let i = 0; i < fade; i++) {
      // Equal power, so the sum holds a constant level through the join instead of
      // dipping the way a linear crossfade would.
      const t = i / fade;
      dst[i] = src[i] * Math.sin(t * Math.PI / 2) + src[buf.length - fade + i] * Math.cos(t * Math.PI / 2);
    }
  }
  return out;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.unlocked = false;
    this.masterVol = 0.9;
    this.sfxVol = 0.85;
    this.musicVol = 0.55;
    this.muted = false;
    this._noise = null;
    this._windNoise = null;
    this._intensity = 0;      // 0..1, drives ambience density and pressure
    this._targetIntensity = 0;
    this._playing = false;
    this._lastSfxAt = new Map(); // crude per-sound rate limit
    this.shootStyle = 'pulse';   // see SHOOT_STYLES; overridden from settings on boot
    this._amb = null;            // sustained ambience nodes, see _startAmbience()
    this._ambNodes = null;       // everything that needs stop()ing
    this._nextEventTime = 0;     // wall-clock (audio clock) of the next sparse event
    this._nextGustTime = 0;
    this._nextDriftTime = 0;
    this._lastEvent = '';
    this._stepFoot = 0;
    this._sampleBufs = new Map();  // name -> decoded AudioBuffer, see SAMPLES
    this._swingFlip = 0;           // alternates the two sword takes
    // -Infinity, not 0: ctx.currentTime starts near zero, so a 0 default makes the
    // limiter in swordSwing() treat the first swing of the context as a duplicate of a
    // swing that never happened, and eat it.
    this._lastSwingAt = -Infinity;
    this._trackBufs = new Map();   // name -> decoded, seam-fixed AudioBuffer
    this._trackSrc = null;         // the playing source, if any
    this._trackName = null;        // what _trackSrc is playing
    this._trackWanted = null;      // what we've been asked to play; guards async decodes
  }

  /** Safe to call repeatedly; only the first user gesture actually resumes. */
  async unlock() {
    // Must be the very first thing this function does — the whole point is to run
    // synchronously inside the same user-gesture call stack that invoked unlock().
    // iOS Safari standalone PWAs have been reported to trust a real <audio>/<video>
    // element's .play() as unlock evidence more reliably than AudioContext.resume()
    // alone; playing this silent clip costs nothing and gives resume() a second,
    // independent path to actually taking effect instead of just one.
    this._playSilentUnlockClip();

    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* user gesture required; try again later */ }
    }
    this.unlocked = this.ctx.state === 'running';
    this.ready = this.unlocked;

    // iOS Safari quirk: resume() can resolve as "running" before the render thread
    // has actually started producing audio. Gain automation scheduled in the same
    // tick can get silently dropped. A one-sample inaudible blip forces the graph
    // to genuinely start, so volume settings applied right after this actually
    // take effect — instead of needing a manual mute/unmute to "wake" it.
    if (this.unlocked) { this._primeOutput(); this._preloadSamples(); }

    this._unlockAttempts = (this._unlockAttempts || 0) + (this.unlocked ? 0 : 1);
    return this.unlocked;
  }

  /**
   * Number of unlock() calls so far that did NOT end in a running AudioContext.
   * main.js uses this to decide when to stop silently retrying and show a manual
   * "tap to enable sound" prompt instead — the fallback the original brief asked for
   * and which a purely silent retry loop never surfaces to the player.
   */
  get failedUnlockAttempts() { return this._unlockAttempts || 0; }

  /** Builds (once) and plays a silent WAV via a real HTMLAudioElement. See unlock(). */
  _playSilentUnlockClip() {
    if (!this._silentEl) {
      // 80 samples of 8-bit unsigned PCM silence (0x80) at 8kHz mono — the smallest
      // WAV that's still unambiguously valid, built at runtime so there's no
      // hand-typed base64 blob to get subtly wrong.
      const samples = 80;
      const buf = new ArrayBuffer(44 + samples);
      const v = new DataView(buf);
      const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + samples, true); str(8, 'WAVE');
      str(12, 'fmt '); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
      v.setUint16(32, 1, true); v.setUint16(34, 8, true);
      str(36, 'data'); v.setUint32(40, samples, true);
      for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      this._silentEl = new Audio(url);
      this._silentEl.loop = false;
      this._silentEl.volume = 0;
      this._silentEl.setAttribute('playsinline', '');
    }
    try {
      this._silentEl.currentTime = 0;
      this._silentEl.play().catch(() => {});
    } catch { /* best-effort; AudioContext path below is the real unlock */ }
  }

  _primeOutput() {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.02);
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.masterVol;

    // Gentle limiter so stacked explosions don't clip on phone speakers.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVol;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0; // faded in when music starts

    // Shared reverb-ish send: a short synthesized impulse keeps everything in one room.
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._makeImpulse(1.8, 2.4);
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.22;

    // Composed tracks — straight to the limiter, no reverb send. See TRACKS.
    this.trackBus = ctx.createGain();
    this.trackBus.gain.value = 0;
    this.trackBus.connect(this.comp);

    this.sfxBus.connect(this.comp);
    this.musicBus.connect(this.comp);
    this.sfxBus.connect(this.verb);
    this.musicBus.connect(this.verb);
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);

    this._noise = this._makeNoise(2.0);
    // A longer buffer for the wind bed. The 2s one loops audibly once you lowpass it
    // hard enough to sound like air — the period becomes a texture you can count.
    this._windNoise = this._makeNoise(7.0);
  }

  _makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.masterVol, this.ctx.currentTime, 0.02);
  }
  setSfxVolume(v) { this.sfxVol = v; if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setMusicVolume(v) {
    this.musicVol = v;
    if (this.musicBus && this._playing) this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
    if (this.trackBus && this._trackSrc) this.trackBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  // ---------------------------------------------------------------- samples

  /**
   * Decode the recorded one-shots up front.
   *
   * Called on unlock rather than on first use: these are combat sounds, and a lazily
   * decoded sample means the very first swing of a run is silent — the one swing where
   * the player is deciding whether the weapon feels like it connects.
   */
  async _preloadSamples() {
    for (const [name, url] of Object.entries(SAMPLES)) {
      if (this._sampleBufs.has(name)) continue;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this._sampleBufs.set(name, await this.ctx.decodeAudioData(await res.arrayBuffer()));
      } catch (e) {
        console.warn('[audio] could not load sample', name, e);
      }
    }
  }

  /** One-shot a decoded sample on the SFX bus. */
  _playSample(name, { gain = 1, rate = 1 } = {}) {
    const buf = this._sampleBufs.get(name);
    if (!this.ready || !buf) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(this.sfxBus);
    src.start();
    return true;
  }

  /**
   * The player's melee swing.
   *
   * Alternates the two takes and nudges the playback rate a little each time. Two
   * recorded swings played straight become obviously two recorded swings within about
   * fifteen seconds of a machete build, which attacks roughly twice a second.
   *
   * Falls back to the synthesised swing if the samples haven't decoded — losing the
   * weapon's sound entirely is far worse than a swing that sounds like the old one.
   */
  swordSwing(p = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    // Overlapping copies of the same transient stack into a click rather than reading as
    // faster attacks, so a very high attack rate drops the extras.
    if (now - this._lastSwingAt < 0.05) return;
    this._lastSwingAt = now;
    const name = (this._swingFlip++ & 1) ? 'sword_b' : 'sword_a';
    const rate = 0.94 + Math.random() * 0.12;
    if (!this._playSample(name, { gain: 0.5 * p, rate })) this.swing(p);
  }

  // ---------------------------------------------------------------- tracks

  /**
   * Loop a composed track, crossfading from whatever is already playing.
   *
   * Safe to call every frame with the same name — a repeat call for the track already
   * playing does nothing. Decoding is async and the player can leave the menu while it
   * runs, so `_trackWanted` is re-checked on the far side of the await; without that,
   * tapping Play during the decode starts the menu music underneath the run.
   */
  async playTrack(name, fade = 1.2) {
    if (!this.ready || !TRACKS[name]) return;
    if (this._trackName === name) return;
    this._trackWanted = name;

    const buf = await this._loadTrack(name);
    if (!buf) return;
    // The world may have moved on while that was in flight.
    if (this._trackWanted !== name || !this.ready) return;

    this._stopTrackSource(0.35);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.trackBus);
    const t = this.ctx.currentTime;
    this.trackBus.gain.cancelScheduledValues(t);
    this.trackBus.gain.setValueAtTime(Math.max(0.0001, this.trackBus.gain.value), t);
    this.trackBus.gain.linearRampToValueAtTime(this.musicVol, t + fade);
    src.start();
    this._trackSrc = src;
    this._trackName = name;
  }

  /**
   * Fetch, decode and seam-fix a track, once. Returns null if it can't be had.
   *
   * Decoding is the expensive part and it is not cheap: decodeAudioData expands the run
   * track's two minutes twenty into roughly 53MB of float samples, on the main thread.
   * Left to happen lazily on the first playTrack('run') call, that lands precisely as the
   * player taps GO OUT — a stutter at the exact moment the game starts asking them to
   * dodge. warmTracks() below moves it into the menu, where nothing is happening.
   */
  async _loadTrack(name) {
    if (this._trackBufs.has(name)) return this._trackBufs.get(name);
    if (this._trackLoads?.has(name)) return this._trackLoads.get(name);
    if (!this._trackLoads) this._trackLoads = new Map();
    const job = (async () => {
      try {
        const res = await fetch(TRACKS[name]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await this.ctx.decodeAudioData(await res.arrayBuffer());
        const buf = loopSeam(this.ctx, raw);
        this._trackBufs.set(name, buf);
        return buf;
      } catch (e) {
        console.warn('[audio] could not load track', name, e);
        return null;
      } finally {
        this._trackLoads.delete(name);
      }
    })();
    this._trackLoads.set(name, job);
    return job;
  }

  /**
   * Decode the run track ahead of time, while the menu is up.
   *
   * Deliberately sequential and deliberately after a delay: the menu track is wanted
   * immediately and the run track is not, and kicking off a 53MB decode alongside the one
   * the player is waiting to hear just moves the stutter onto the menu instead.
   */
  warmTracks() {
    if (!this.ready || this._warmed) return;
    this._warmed = true;
    setTimeout(() => { this._loadTrack('run'); }, 1500);
  }

  stopTrack(fade = 1.0) {
    this._trackWanted = null;
    this._stopTrackSource(fade);
  }

  _stopTrackSource(fade) {
    if (!this._trackSrc) return;
    const src = this._trackSrc;
    const t = this.ctx.currentTime;
    this.trackBus.gain.cancelScheduledValues(t);
    this.trackBus.gain.setValueAtTime(Math.max(0.0001, this.trackBus.gain.value), t);
    this.trackBus.gain.linearRampToValueAtTime(0.0001, t + fade);
    try { src.stop(t + fade + 0.05); } catch { /* already stopped */ }
    this._trackSrc = null;
    this._trackName = null;
  }

  // ---------------------------------------------------------------- voices

  /** One enveloped oscillator. All SFX below are combinations of this + _noiseHit. */
  _tone({ type = 'sine', freq = 440, toFreq = null, dur = 0.2, gain = 0.3, attack = 0.004,
          delay = 0, bus = null, detune = 0, curve = 'exp' }) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(Math.max(20, freq), t0);
    if (toFreq != null) {
      const target = Math.max(20, toFreq);
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(target, t0 + dur);
      else osc.frequency.linearRampToValueAtTime(target, t0 + dur);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(bus || this.sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /**
   * Filtered noise burst — the "air" in every impact, and the raw material for most of
   * the ambience too.
   *
   * `attack` > 0 turns the burst into a swell, which is what separates a distant
   * collapse from a hit. The source now always loops: the buffer is 2s and the random
   * start offset eats up to 1s of it, so anything longer than ~1s (gameOver's 1.6s
   * tail, every ambient bed) used to run off the end of the buffer into silence.
   */
  _noiseHit({ dur = 0.12, gain = 0.25, freq = 1200, q = 1.2, type = 'bandpass',
              sweepTo = null, delay = 0, bus = null, attack = 0, rate = null,
              sweepCurve = 'exp' }) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    src.playbackRate.value = rate != null ? rate : 0.8 + Math.random() * 0.4;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t0);
    filt.Q.value = q;
    if (sweepTo != null) {
      const to = Math.max(30, sweepTo);
      if (sweepCurve === 'lin') filt.frequency.linearRampToValueAtTime(to, t0 + dur);
      else filt.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    }
    const g = ctx.createGain();
    if (attack > 0) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + Math.min(attack, dur * 0.9));
    } else {
      g.gain.setValueAtTime(gain, t0);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt); filt.connect(g); g.connect(bus || this.sfxBus);
    src.start(t0, Math.random() * 1.0);
    src.stop(t0 + dur + 0.02);
  }

  /**
   * The throat. Excites a buzzy, unstable glottal source (plus breath noise) and passes
   * the lot through three bandpass filters parked on formant frequencies, which morph
   * from one vowel toward another over the length of the sound — a mouth changing shape.
   *
   * Everything is randomised per call: which vowel it starts and ends on, ±12% on each
   * formant, the pitch drift path, the amplitude wobble rate. Two groans are never the
   * same sound, which is the entire difference between a horde and a chord.
   *
   * `far` (0..1) is distance: it rolls off the highs and cuts level, because the reason
   * a far-off noise sounds far off is that the air ate the top of it.
   */
  _formantVoice({
    f0 = 92, toF0 = null, dur = 0.8, gain = 0.06, attack = 0.12,
    breath = 0.5, rasp = 0, sub = 0, wobble = null, wobbleDepth = 0.4,
    vowel = null, toVowel = null, q = 8, drift = 0.06,
    far = 0, delay = 0, bus = null,
  } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const t1 = t0 + dur;
    const end = toF0 != null ? toF0 : f0 * 0.72;

    // ---- source: two near-unison saws beating (vocal fry / a throat that is wrong)
    const srcSum = ctx.createGain();
    srcSum.gain.value = 1;
    // Everything below is fire-and-forget: each node stops itself at t1 and is collected
    // by the graph, so nothing here needs holding on to.
    const mkOsc = (type, mult, level) => {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = type;
      og.gain.value = level;
      // Pitch is never steady: a handful of linear ramps between f0 and the end
      // pitch, each nudged, so the contour sags and catches instead of gliding.
      o.frequency.setValueAtTime(Math.max(20, f0 * mult), t0);
      const steps = 4;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        const base = f0 + (end - f0) * k;
        const j = base * (1 + (Math.random() * 2 - 1) * drift);
        o.frequency.linearRampToValueAtTime(Math.max(20, j * mult), t0 + dur * k);
      }
      o.connect(og); og.connect(srcSum);
      o.start(t0); o.stop(t1 + 0.06);
    };
    mkOsc('sawtooth', 1, 0.5);
    mkOsc('sawtooth', 1 + rand(0.004, 0.016), 0.42);
    if (rasp > 0) mkOsc('square', 0.5, 0.28 * rasp);       // subharmonic growl
    if (sub > 0) mkOsc('sine', 0.5, 0.5 * sub);            // chest, below the formants

    // ---- breath, shaped by the same formants (a whisper is formants without pitch)
    if (breath > 0) {
      const n = ctx.createBufferSource();
      n.buffer = this._noise;
      n.loop = true;
      n.playbackRate.value = rand(0.7, 1.3);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 240;
      const ng = ctx.createGain();
      ng.gain.value = 0.5 * breath;
      n.connect(hp); hp.connect(ng); ng.connect(srcSum);
      n.start(t0, Math.random()); n.stop(t1 + 0.06);
    }

    // ---- formants
    const mix = ctx.createGain();
    mix.gain.value = 1;
    const a = vowel || pick(VOWELS);
    const b = toVowel || pick(VOWELS);
    const levels = [1.0, 0.5, 0.22];
    for (let i = 0; i < 3; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = q * (i === 0 ? 1 : 0.8);
      bp.frequency.setValueAtTime(a[i] * rand(0.88, 1.12), t0);
      bp.frequency.linearRampToValueAtTime(Math.max(80, b[i] * rand(0.88, 1.12)), t1);
      const bg = ctx.createGain();
      bg.gain.value = levels[i];
      srcSum.connect(bp); bp.connect(bg); bg.connect(mix);
    }
    // A little unfiltered low end so it has a chest and not just a mouth.
    const chest = ctx.createBiquadFilter();
    chest.type = 'lowpass';
    chest.frequency.value = 320;
    const chestG = ctx.createGain();
    chestG.gain.value = 0.5;
    srcSum.connect(chest); chest.connect(chestG); chestG.connect(mix);

    // ---- distance
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 4200 - far * 3200;
    air.Q.value = 0.7;

    // ---- envelope, plus an irregular tremor riding on top of it
    const amp = ctx.createGain();
    const peak = gain * (1 - far * 0.55);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(peak, t0 + Math.min(attack, dur * 0.6));
    amp.gain.linearRampToValueAtTime(peak * rand(0.55, 0.95), t0 + dur * 0.7);
    amp.gain.linearRampToValueAtTime(0, t1);

    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(wobble != null ? wobble : rand(3.5, 8.5), t0);
    lfo.frequency.linearRampToValueAtTime(rand(2.5, 7), t1);
    lfoG.gain.value = peak * wobbleDepth;
    lfo.connect(lfoG); lfoG.connect(amp.gain);   // sums with the scheduled envelope
    lfo.start(t0); lfo.stop(t1 + 0.06);

    mix.connect(air); air.connect(amp); amp.connect(bus || this.sfxBus);
  }

  /** Cheap voice-stealing guard: identical sounds inside `ms` collapse into one. */
  _throttle(key, ms) {
    const now = performance.now();
    const last = this._lastSfxAt.get(key) || 0;
    if (now - last < ms) return true;
    this._lastSfxAt.set(key, now);
    return false;
  }

  // ---------------------------------------------------------------- SFX

  /**
   * Fires on every shot, several times a second, for minutes — so whichever variant is
   * selected has to survive heavy repetition without becoming fatiguing.
   *
   * Two failure modes learned the hard way, both encoded in the variants below:
   *
   *  - Too long and too low. The original swept a triangle 760 -> 300Hz over 85ms:
   *    descending into the low-mids (where "grating" lives) and long enough that
   *    consecutive shots fused into a continuous tone.
   *  - Too short and too narrow-band. The first fix over-corrected into a bandpassed
   *    noise tick with no pitch movement, which is precisely the recipe for a car
   *    indicator relay. A click with *no frequency motion* reads as a mechanism, not
   *    as a weapon.
   *
   * So every variant here has some pitch movement, stays under ~90ms, and peaks well
   * below hit() (0.10) and enemyDeath() (0.16) so impacts still outrank firing.
   */
  shoot(pitch = 1) {
    if (this._throttle('shoot', 34)) return;
    // Per-shot pitch jitter. Without it, a fixed frequency repeating at a steady fire
    // rate fuses into one droning pitch — the machine-gun-drill effect.
    const p = pitch * (0.94 + Math.random() * 0.12);
    (SHOOT_STYLES[this.shootStyle] || SHOOT_STYLES.pulse).call(this, p);
  }

  // -------------------------------------------------------- horror palette
  //
  // The old palette was sci-fi: square-wave zaps, bright sawtooth sweeps, ringing
  // metallic impacts. All of it has been pulled down in frequency and roughened.
  // The rules this set follows:
  //
  //  - Impacts are *wet*. A lowpassed noise burst with a fast decay and no tonal
  //    component reads as meat; add any sustained pitch and it becomes a machine.
  //  - Voices are formants, not waveforms. See _formantVoice(). The old detuned-saw
  //    pair beat convincingly against itself and still read as a synth pad, because
  //    nothing in it had a resonant cavity. Two bandpasses fix what no amount of
  //    detuning could.
  //  - Nothing resolves. Groans and screams end on a downward sweep, never a settled
  //    pitch, so the soundscape never feels finished.

  /** Blade meeting a body. Wet, short, no ring. */
  hit() {
    if (this._throttle('hit', 26)) return;
    this._noiseHit({ dur: 0.085, gain: 0.13, freq: 900 * rand(0.85, 1.2), sweepTo: 160, q: 0.6, type: 'lowpass' });
    this._noiseHit({ dur: 0.03, gain: 0.05, freq: 2600, sweepTo: 900, q: 1.4 });
    // Sub thump so the blow has weight without a pitch you can hum.
    this._tone({ type: 'sine', freq: 92, toFreq: 38, dur: 0.07, gain: 0.06, attack: 0.001 });
  }

  /**
   * The swing itself: air, and nothing else.
   * Two overlapping bands sweeping at different rates — a single band sweeping once is
   * a slide whistle, and you hear the filter rather than the blade.
   */
  swing(scale = 1) {
    if (this._throttle('swing', 40)) return;
    const d = 0.13 * scale;
    this._noiseHit({ dur: d, gain: 0.07, freq: 420 * rand(0.9, 1.15), sweepTo: 2400, q: 1.1,
                     type: 'bandpass', attack: d * 0.45 });
    this._noiseHit({ dur: d * 0.8, gain: 0.03, freq: 1500, sweepTo: 600, q: 0.7,
                     type: 'bandpass', delay: d * 0.35 });
  }

  /** Bowstring release. */
  bowRelease() {
    if (this._throttle('bow', 60)) return;
    // String twang + snap — the bow itself.
    this._tone({ type: 'triangle', freq: 210, toFreq: 95, dur: 0.09, gain: 0.08, attack: 0.001 });
    this._noiseHit({ dur: 0.05, gain: 0.06, freq: 1700, sweepTo: 700, q: 1.6 });
    // The swoosh — the arrow itself, leaving. A resonant bandpass sweeping quickly
    // through the shaft's range gives the "cutting air" character a plain lowpass/
    // highpass sweep doesn't; a slight delay separates it from the twang so the two
    // don't fuse into one transient, and it decays a beat longer to trail off after
    // the string sound has already stopped.
    this._noiseHit({ dur: 0.16, gain: 0.05, freq: 500, sweepTo: 3400, q: 2.6,
                      type: 'bandpass', delay: 0.012, attack: 0.004 });
  }

  /**
   * A boot on wet dirt. Deliberately tiny — it is texture, not an event.
   * Dirt is a soft low thud *plus* grit: two or three sub-10ms high crackles scattered
   * across the first 40ms. Without the grit it's a kick drum; the grit is the ground.
   * Alternating feet get slightly different weight so a walk cycle doesn't tick.
   */
  footstep() {
    if (this._throttle('step', 90)) return;
    const foot = (this._stepFoot ^= 1);
    const w = foot ? 1 : 0.86;
    this._noiseHit({
      dur: 0.05 * rand(0.85, 1.2), gain: 0.026 * w, freq: rand(200, 400), sweepTo: 85,
      q: 0.8, type: 'lowpass',
    });
    const grains = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < grains; i++) {
      this._noiseHit({
        dur: 0.008, gain: 0.012 * w * rand(0.5, 1), freq: rand(2200, 5200), q: 1.4,
        delay: Math.random() * 0.035,
      });
    }
  }

  /**
   * Something out there, aware of you.
   *
   * A throat, not a pad: buzzy source through drifting formants (see _formantVoice).
   * Every parameter is re-rolled per call — vowel pair, formant offsets, wobble rate,
   * pitch contour — because a dozen of these overlapping is the game's main texture and
   * identical copies stack into a chord instead of into a crowd.
   *
   * `scale` keeps its original contract: < 1 (what run.js passes for elites and for a
   * Lurker's lunge) is tighter and higher, a sound with intent behind it.
   */
  groan(scale = 1) {
    if (this._throttle('groan', 180)) return;
    const f = rand(62, 104) / scale;
    this._formantVoice({
      f0: f * rand(1.05, 1.3),
      toF0: f * rand(0.6, 0.8),         // never settles
      dur: rand(0.7, 1.15) * scale,
      gain: 0.052 * rand(0.8, 1.15),
      attack: rand(0.09, 0.22) * scale,
      breath: rand(0.35, 0.8),
      rasp: Math.random() < 0.45 ? rand(0.3, 0.9) : 0,
      sub: rand(0.2, 0.6),
      q: rand(6, 11),
      wobbleDepth: rand(0.25, 0.55),
      far: rand(0, 0.35),
    });
  }

  /**
   * The Screamer calling the street awake. This one is allowed to be unpleasant.
   * Same throat, pushed until it distorts: pitch climbing rather than falling, formants
   * dragged high and open, a subharmonic growl underneath and a rasp of noise on top.
   * Lightly throttled — two Screamers firing in one frame is mud, not two screams.
   */
  scream() {
    if (this._throttle('scream', 140)) return;
    const f = rand(150, 210);
    this._formantVoice({
      f0: f,
      toF0: f * rand(2.0, 2.9),          // climbs and is cut off, never lands
      dur: rand(0.55, 0.75),
      gain: 0.115,
      attack: 0.035,
      breath: 0.85,
      rasp: rand(0.5, 1),
      sub: 0.3,
      q: rand(9, 14),
      vowel: [rand(680, 820), rand(1500, 1800), rand(2500, 2900)],
      toVowel: [rand(760, 900), rand(1750, 2100), rand(2700, 3100)],
      wobble: rand(9, 15),               // a shriek is a fast tremor, not a slow one
      wobbleDepth: 0.5,
      drift: 0.1,
    });
    // The air being torn, riding above the voice.
    this._noiseHit({ dur: 0.55, gain: 0.055, freq: 1600, sweepTo: 4200, q: 1.4, attack: 0.06 });
    this._noiseHit({ dur: 0.3, gain: 0.03, freq: 300, sweepTo: 900, q: 0.6, type: 'lowpass' });
  }

  /**
   * Bile leaving a body. A guttural hawk (short, closed, low formants) and then the
   * liquid actually leaving — a wet lowpassed burst with a fast resonant collapse.
   */
  spit() {
    if (this._throttle('spit', 90)) return;
    this._formantVoice({
      f0: rand(95, 140), toF0: rand(60, 85), dur: 0.13, gain: 0.06, attack: 0.012,
      breath: 0.9, rasp: 0.8, q: 5,
      vowel: [rand(380, 520), rand(950, 1250), 2300],
      toVowel: [rand(280, 360), rand(800, 1000), 2200],
      wobble: 22, wobbleDepth: 0.6,
    });
    this._noiseHit({ dur: 0.17, gain: 0.075, freq: 800, sweepTo: 200, q: 1.6, type: 'lowpass', delay: 0.05 });
    this._noiseHit({ dur: 0.09, gain: 0.035, freq: rand(1600, 2400), sweepTo: 500, q: 2.2, delay: 0.06 });
  }

  /**
   * A hand connecting with the survivor. Wet and low: a body-cavity thump under a
   * resonant squelch that collapses downward, plus a short spatter of fine debris.
   */
  gore() {
    if (this._throttle('gore', 60)) return;
    this._noiseHit({ dur: 0.14, gain: 0.15, freq: rand(520, 720), sweepTo: 80, q: 1.5, type: 'lowpass' });
    this._noiseHit({ dur: 0.07, gain: 0.05, freq: rand(1100, 1900), sweepTo: 300, q: 2.6 });
    this._tone({ type: 'sine', freq: 78, toFreq: 30, dur: 0.16, gain: 0.09, attack: 0.002 });
    for (let i = 0; i < 3; i++) {
      this._noiseHit({ dur: 0.012, gain: 0.018 * rand(0.4, 1), freq: rand(900, 2600), q: 1.2,
                       delay: 0.03 + Math.random() * 0.07, type: 'lowpass' });
    }
  }

  /** A wet burst and the last breath leaving through it. */
  enemyDeath(sizeScale = 1) {
    if (this._throttle('death', 28)) return;
    this._noiseHit({ dur: 0.26 * sizeScale, gain: 0.15, freq: rand(700, 1000), sweepTo: 110,
                     q: 0.55, type: 'lowpass' });
    this._formantVoice({
      f0: rand(105, 155) / sizeScale, toF0: rand(45, 62) / sizeScale,
      dur: 0.3 * sizeScale, gain: 0.075, attack: 0.012,
      breath: 0.7, rasp: 0.5, sub: 0.4, q: 5, drift: 0.1,
      wobble: rand(6, 12), wobbleDepth: 0.5,
    });
  }

  /** Something large stops being upright. */
  bigDeath() {
    this._noiseHit({ dur: 1.0, gain: 0.30, freq: 620, sweepTo: 42, q: 0.45, type: 'lowpass' });
    this._formantVoice({
      f0: rand(80, 105), toF0: rand(26, 36), dur: 0.95, gain: 0.19, attack: 0.015,
      breath: 0.6, rasp: 1, sub: 0.9, q: 4.5, drift: 0.09,
      wobble: rand(3.5, 6), wobbleDepth: 0.45,
    });
    this._noiseHit({ dur: 0.18, gain: 0.16, freq: 2600, sweepTo: 500, q: 0.9 });
    this._noiseHit({ dur: 1.5, gain: 0.10, freq: 180, sweepTo: 40, q: 0.5, type: 'lowpass', attack: 0.12 });
  }

  playerHurt() {
    // Impact first, then a body reacting to it — the voice lags the noise burst by
    // 40ms, which is roughly how long it takes a person to make a sound about being hit.
    this._noiseHit({ dur: 0.2, gain: 0.24, freq: 560, sweepTo: 80, q: 0.6, type: 'lowpass' });
    this._formantVoice({
      f0: rand(140, 175), toF0: rand(70, 95), dur: 0.3, gain: 0.15, attack: 0.02, delay: 0.04,
      breath: 0.55, rasp: 0.35, sub: 0.5, q: 6,
      vowel: [rand(620, 760), rand(1050, 1300), 2400],
      wobble: rand(7, 11), wobbleDepth: 0.3,
    });
    this._tone({ type: 'sine', freq: 74, toFreq: 40, dur: 0.42, gain: 0.10, delay: 0.03 });
  }

  pickup() {
    if (this._throttle('pickup', 32)) return;
    this._tone({ type: 'sine', freq: 900, toFreq: 1500, dur: 0.075, gain: 0.055, attack: 0.002 });
  }

  shard() {
    if (this._throttle('shard', 40)) return;
    this._tone({ type: 'triangle', freq: 1320, toFreq: 1980, dur: 0.11, gain: 0.07 });
    this._tone({ type: 'sine', freq: 2640, dur: 0.07, gain: 0.03, delay: 0.02 });
  }

  levelUp() {
    // Rising arpeggio on the run's own scale — reads as "you got stronger", not a jingle.
    const base = midiToFreq(ROOT + 24);
    [0, 3, 7, 12].forEach((semi, i) => {
      this._tone({ type: 'triangle', freq: base * Math.pow(2, semi / 12), dur: 0.32,
                   gain: 0.13, delay: i * 0.055, attack: 0.006 });
      this._tone({ type: 'sine', freq: base * 2 * Math.pow(2, semi / 12), dur: 0.24,
                   gain: 0.05, delay: i * 0.055 });
    });
    this._noiseHit({ dur: 0.4, gain: 0.07, freq: 4200, sweepTo: 1200, q: 0.7 });
  }

  /** A hard breath and three fast footfalls. */
  dash() {
    if (this._throttle('dash', 90)) return;
    // Whispered vowels: the breath is bandpassed twice, in the F1/F2 region, which is
    // the difference between a person exhaling and a hi-hat.
    this._noiseHit({ dur: 0.22, gain: 0.09, freq: rand(560, 780), sweepTo: 2000, q: 1.6, type: 'bandpass' });
    this._noiseHit({ dur: 0.18, gain: 0.04, freq: rand(1300, 1700), sweepTo: 900, q: 2.2, delay: 0.03 });
    for (let i = 0; i < 3; i++) {
      this._noiseHit({ dur: 0.045, gain: 0.05 * rand(0.8, 1.15), freq: rand(190, 280), sweepTo: 80,
                       q: 0.8, type: 'lowpass', delay: i * 0.055 });
      this._noiseHit({ dur: 0.008, gain: 0.014, freq: rand(2400, 4800), q: 1.4, delay: i * 0.055 + 0.004 });
    }
  }

  uiClick() {
    this._tone({ type: 'square', freq: 620, toFreq: 880, dur: 0.045, gain: 0.05 });
  }

  uiBack() {
    this._tone({ type: 'square', freq: 520, toFreq: 300, dur: 0.06, gain: 0.05 });
  }

  /**
   * The night phase deepening. A swell that goes *down*, not up: two pitches a tritone
   * apart sinking and beating against each other, under a long wash of air. The old
   * version rose to a consonant fifth, which announced the darkness like a level-up.
   */
  tierShift() {
    const base = midiToFreq(ROOT + 12) * rand(0.97, 1.03);
    this._tone({ type: 'sawtooth', freq: base, toFreq: base * 0.62, dur: 2.2, gain: 0.09,
                 attack: 0.9, curve: 'lin' });
    this._tone({ type: 'triangle', freq: base * 1.414, toFreq: base * 0.9, dur: 2.0, gain: 0.05,
                 attack: 1.0, curve: 'lin', detune: rand(-30, 30) });
    this._tone({ type: 'sine', freq: base * 0.25, toFreq: base * 0.2, dur: 2.6, gain: 0.10, attack: 0.8 });
    this._noiseHit({ dur: 2.4, gain: 0.075, freq: 3000, sweepTo: 160, q: 0.6, type: 'lowpass', attack: 0.5 });
  }

  runComplete(isNewBest) {
    const base = midiToFreq(ROOT + 24);
    const notes = isNewBest ? [0, 4, 7, 12, 16] : [0, 3, 7, 10];
    notes.forEach((semi, i) => {
      this._tone({ type: 'triangle', freq: base * Math.pow(2, semi / 12), dur: 0.9,
                   gain: 0.12, delay: i * 0.13, attack: 0.02 });
    });
    this._tone({ type: 'sine', freq: base * 0.25, dur: 2.2, gain: 0.10, attack: 0.3 });
  }

  gameOver() {
    this._tone({ type: 'sawtooth', freq: 220, toFreq: 40, dur: 1.8, gain: 0.20, attack: 0.02 });
    this._tone({ type: 'sine', freq: 110, toFreq: 32, dur: 2.4, gain: 0.14, attack: 0.05 });
    this._noiseHit({ dur: 1.6, gain: 0.12, freq: 600, sweepTo: 60, q: 0.5, type: 'lowpass' });
  }

  milestone() {
    const base = midiToFreq(ROOT + 26);
    [0, 5, 9, 14, 17, 21].forEach((s, i) => {
      this._tone({ type: 'triangle', freq: base * Math.pow(2, s / 12), dur: 0.7, gain: 0.11, delay: i * 0.08 });
    });
  }

  // ---------------------------------------------------------------- ambience
  //
  // This used to be a 16-step sequencer: chord progression, rotating bass patterns, a
  // kick on every quarter, hats, and a sub "heartbeat" on the downbeat, all riding a
  // tempo that climbed with intensity. That is dance-music architecture, inherited from
  // the neon shooter this was forked from, and no amount of retuning fixes it — a
  // steady pulse grid is the opposite of what a dark village needs. Rhythm creates
  // momentum and confidence. This game wants dread, and silence you strain to hear
  // through. So there is no tempo here, no grid, no bar, and no drums at any intensity.
  //
  // What replaced it:
  //
  //   SUSTAINED   a wind bed (three layers of filtered noise, modulated by slow LFOs
  //               and by randomised gusts) and a low drone that drifts microtonally
  //               and never arrives anywhere.
  //   SPARSE      single events — a dog three streets over, timber giving, a crow, a
  //               far-off collapse, a groan you can't place — fired on a randomised
  //               timer. The gaps are the composition. At rest they average ~11s apart.
  //
  // setIntensity(I) is expressed entirely as *density and pressure*:
  //   - the mean gap between events falls from ~11s to ~3.5s
  //   - the wind's lowpass opens and its level rises (the air gets loud)
  //   - a sub-bass rumble layer swells in on I², felt more than heard
  //   - a tritone above the drone fades in and beats against it — dissonance, not notes
  //   - the event table reweights toward bodies, dragging, and structural collapse
  // Nothing new starts *pulsing*. The air thickens; a track never drops.

  startMusic() {
    if (!this.ready || this._playing) return;
    this._playing = true;
    const t = this.ctx.currentTime;
    this._lastEvent = '';
    this._nextEventTime = t + rand(3, 7);
    this._nextGustTime = t + rand(2, 6);
    this._nextDriftTime = t + rand(4, 9);
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setValueAtTime(0.0001, t);
    // Slower than the old 1.6s fade: ambience should arrive without an entrance.
    this.musicBus.gain.exponentialRampToValueAtTime(Math.max(0.0002, this.musicVol), t + 4.0);
    this._startAmbience();
  }

  stopMusic(fade = 1.2) {
    if (!this._playing) return;
    this._playing = false;
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setValueAtTime(Math.max(0.0002, this.musicBus.gain.value), t);
    this.musicBus.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    if (this._ambNodes) {
      this._ambNodes.forEach((n) => { try { n.stop(t + fade + 0.1); } catch { /* already stopped */ } });
      this._ambNodes = null;
    }
    this._amb = null;
  }

  /** The permanently-running part: wind, and a drone that will not settle. */
  _startAmbience() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const bus = this.musicBus;
    const nodes = [];
    const A = {};

    const noiseSrc = (rate) => {
      const s = ctx.createBufferSource();
      s.buffer = this._windNoise;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(t, Math.random() * 6);
      nodes.push(s);
      return s;
    };
    const lfo = (hz, depth, param) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = hz;
      g.gain.value = depth;
      o.connect(g); g.connect(param);
      o.start(t + Math.random() * 4);   // stagger phase so the layers never line up
      nodes.push(o);
    };

    // ---- air: the broad bed. Wide, dull, always there.
    const src1 = noiseSrc(0.9);
    A.airFilt = ctx.createBiquadFilter();
    A.airFilt.type = 'lowpass';
    A.airFilt.frequency.value = 220;
    A.airFilt.Q.value = 0.5;
    // Level, filter and drift are driven entirely from update(); these start at zero and
    // are walked up by setTargetAtTime, so no scheduled ramp is ever left half-finished
    // underneath a per-frame automation event.
    A.airGain = ctx.createGain();
    A.airGain.gain.value = 0.0001;
    src1.connect(A.airFilt); A.airFilt.connect(A.airGain); A.airGain.connect(bus);
    // Two incommensurable periods (23s and 14s) so the bed never repeats a shape.
    lfo(0.043, 70, A.airFilt.frequency);
    lfo(0.071, 0.014, A.airGain.gain);

    // ---- gusts: a narrow band that rises and falls on a random timer (see update()).
    const src2 = noiseSrc(1.15);
    A.gustFilt = ctx.createBiquadFilter();
    A.gustFilt.type = 'bandpass';
    A.gustFilt.frequency.value = 520;
    A.gustFilt.Q.value = 2.4;
    A.gustGain = ctx.createGain();
    A.gustGain.gain.value = 0.0001;
    src2.connect(A.gustFilt); A.gustFilt.connect(A.gustGain); A.gustGain.connect(bus);
    lfo(0.031, 130, A.gustFilt.frequency);

    // ---- rumble: sub-bass pressure, silent at rest, swells on I².
    const rumFilt = ctx.createBiquadFilter();
    rumFilt.type = 'lowpass';
    rumFilt.frequency.value = 85;
    rumFilt.Q.value = 0.8;
    A.rumbleGain = ctx.createGain();
    A.rumbleGain.gain.value = 0.0001;
    src1.connect(rumFilt); rumFilt.connect(A.rumbleGain); A.rumbleGain.connect(bus);

    // ---- drone: two triangles a few cents apart, plus a sub, plus (at intensity) a
    //      tritone. No progression: it is one unresolved sonority for the whole run.
    A.droneFilt = ctx.createBiquadFilter();
    A.droneFilt.type = 'lowpass';
    A.droneFilt.frequency.value = 300;
    A.droneFilt.Q.value = 0.9;
    A.droneGain = ctx.createGain();
    A.droneGain.gain.value = 0.0001;
    A.droneFilt.connect(A.droneGain); A.droneGain.connect(bus);

    A.drifters = [];
    const drone = (freq, type, detune, dest) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(dest);
      o.start(t);
      nodes.push(o);
      A.drifters.push(o);
      return o;
    };
    drone(midiToFreq(ROOT + 12), 'triangle', -9, A.droneFilt);
    drone(midiToFreq(ROOT + 12), 'triangle', 11, A.droneFilt);

    A.subGain = ctx.createGain();
    A.subGain.gain.value = 0.0001;
    A.subGain.connect(bus);
    drone(midiToFreq(ROOT), 'sine', 0, A.subGain);

    A.dissGain = ctx.createGain();
    A.dissGain.gain.value = 0.0001;
    A.dissGain.connect(bus);
    const dissFilt = ctx.createBiquadFilter();
    dissFilt.type = 'lowpass';
    dissFilt.frequency.value = 700;
    dissFilt.connect(A.dissGain);
    drone(midiToFreq(ROOT + 12) * 1.4142, 'triangle', 0, dissFilt); // tritone, never resolves

    this._amb = A;
    this._ambNodes = nodes;
  }

  setIntensity(v) { this._targetIntensity = clamp(v, 0, 1); }

  /** Called once per frame from the game loop. */
  update(dt) {
    if (!this.ready) return;
    // Slower than the sequencer's 0.8: ambience should never be caught reacting.
    this._intensity += (this._targetIntensity - this._intensity) * Math.min(1, dt * 0.45);
    if (!this._playing) return;

    const I = this._intensity;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const A = this._amb;

    if (A) {
      A.airFilt.frequency.setTargetAtTime(210 + I * 520, t, 1.5);
      A.airGain.gain.setTargetAtTime(0.055 + I * 0.045, t, 2.0);
      A.rumbleGain.gain.setTargetAtTime(0.0001 + I * I * 0.085, t, 2.5);
      A.droneFilt.frequency.setTargetAtTime(300 + I * 460, t, 2.0);
      A.droneGain.gain.setTargetAtTime(0.020 + I * 0.026, t, 2.0);
      A.subGain.gain.setTargetAtTime(0.030 + I * I * 0.045, t, 2.5);
      A.dissGain.gain.setTargetAtTime(0.0001 + I * I * 0.020, t, 3.5);

      // Gusts. Irregular by construction: random level, random rise time, random gap.
      if (t >= this._nextGustTime) {
        const peak = rand(0.006, 0.020) * (1 + I);
        A.gustGain.gain.setTargetAtTime(peak, t, rand(0.8, 2.4));
        A.gustGain.gain.setTargetAtTime(0.0001, t + rand(2.5, 6), rand(1.5, 3.5));
        A.gustFilt.frequency.setTargetAtTime(rand(320, 1500), t, 2.0);
        this._nextGustTime = t + rand(7, 22);
      }

      // Microtonal drift. The drone is always slightly out of tune with itself and the
      // amount keeps changing, so it beats at a rate you can't lock onto.
      if (t >= this._nextDriftTime) {
        for (const o of A.drifters) o.detune.setTargetAtTime(rand(-38, 38) * (1 + I), t, 6);
        this._nextDriftTime = t + rand(7, 16);
      }
    }

    // Sparse events. Gaps are wide and unequal; at rest most of this is silence.
    if (t >= this._nextEventTime) {
      this._ambientEvent(I);
      const mean = 10.5 - I * 7;
      this._nextEventTime = t + mean * rand(0.4, 1.55);
    }
  }

  /**
   * One arrhythmic event, weighted by intensity. `[name, weightAt0, weightAt1]` — low
   * intensity is a village at night (animals, timber, wind); high intensity is bodies,
   * dragging, and things falling over. The same event never fires twice in a row.
   */
  _ambientEvent(I) {
    const TABLE = [
      ['whistle',  1.4, 0.7],
      ['creak',    1.3, 0.8],
      ['dog',      1.2, 0.5],
      ['crow',     0.9, 0.3],
      ['clatter',  0.9, 0.7],
      ['bell',     0.35, 0.1],
      ['collapse', 0.35, 1.1],
      ['groan',    0.4, 2.2],
      ['drag',     0.2, 1.6],
      ['pressure', 0.0, 1.8],
    ];
    let total = 0;
    for (const e of TABLE) {
      e[3] = (e[0] === this._lastEvent ? 0 : 1) * Math.max(0, e[1] + (e[2] - e[1]) * I);
      total += e[3];
    }
    if (total <= 0) return;
    let r = Math.random() * total;
    let name = TABLE[0][0];
    for (const e of TABLE) { r -= e[3]; if (r <= 0) { name = e[0]; break; } }
    this._lastEvent = name;

    const bus = this.musicBus;
    switch (name) {
      // Wind finding a gap between two houses: a narrow band that swells and dies.
      case 'whistle': {
        const d = rand(2.2, 5.0);
        const f = rand(420, 1400);
        this._noiseHit({ dur: d, gain: rand(0.02, 0.045), freq: f, sweepTo: f * rand(1.3, 2.2),
                         q: rand(4, 9), attack: d * 0.45, bus, sweepCurve: 'lin' });
        break;
      }

      // Timber giving under its own weight. A creak is stick-slip, so it is a run of
      // tiny grains at a slowly rising resonance, not one smooth swept tone.
      case 'creak': {
        const d = rand(0.7, 1.8);
        const f0 = rand(240, 620);
        const grains = 7 + ((Math.random() * 9) | 0);
        for (let i = 0; i < grains; i++) {
          const k = i / grains;
          this._noiseHit({
            dur: rand(0.02, 0.07), gain: rand(0.008, 0.028) * (1 - k * 0.4),
            freq: f0 * (1 + k * rand(0.3, 0.9)), q: rand(12, 26),
            delay: d * k + rand(0, d / grains), bus,
          });
        }
        this._noiseHit({ dur: d * 0.6, gain: 0.012, freq: 140, sweepTo: 70, q: 0.6,
                         type: 'lowpass', delay: d * 0.5, bus });
        break;
      }

      // A dog, streets away, that has noticed something. Two to five barks, uneven.
      case 'dog': {
        const n = 2 + ((Math.random() * 4) | 0);
        const far = rand(0.55, 0.85);
        let d = 0;
        for (let i = 0; i < n; i++) {
          this._formantVoice({
            f0: rand(230, 330), toF0: rand(140, 210), dur: rand(0.08, 0.15),
            gain: rand(0.05, 0.085), attack: 0.006, breath: 0.4, rasp: 0.6, q: 6,
            vowel: [rand(500, 750), rand(1100, 1500), 2500],
            toVowel: [rand(350, 500), rand(900, 1200), 2300],
            wobble: 18, wobbleDepth: 0.3, far, delay: d, bus,
          });
          d += rand(0.16, 0.42);
        }
        break;
      }

      // A crow, close enough to be startling. Harsh, high formants, hard tremor.
      case 'crow': {
        const n = 1 + ((Math.random() * 3) | 0);
        let d = 0;
        for (let i = 0; i < n; i++) {
          this._formantVoice({
            f0: rand(340, 470), toF0: rand(220, 300), dur: rand(0.14, 0.26),
            gain: rand(0.03, 0.05), attack: 0.01, breath: 0.7, rasp: 1, q: rand(10, 16),
            vowel: [rand(700, 900), rand(1700, 2100), rand(2700, 3100)],
            wobble: rand(24, 42), wobbleDepth: 0.65, far: rand(0.2, 0.5), delay: d, bus,
          });
          d += rand(0.28, 0.6);
        }
        break;
      }

      // Something small and metal falling over somewhere. Pure texture.
      case 'clatter': {
        const n = 3 + ((Math.random() * 5) | 0);
        let d = 0;
        for (let i = 0; i < n; i++) {
          this._noiseHit({ dur: rand(0.02, 0.06), gain: rand(0.01, 0.03), freq: rand(700, 2600),
                           q: rand(3, 10), delay: d, bus });
          d += rand(0.04, 0.19);   // decelerating, uneven — a thing settling
        }
        break;
      }

      // A bell somewhere, struck by nothing in particular. Inharmonic partials only:
      // a real bell has no triad in it, and this one is not calling anyone to anything.
      case 'bell': {
        const f = rand(150, 260);
        [1, 2.04, 2.97, 4.16, 5.43].forEach((r, i) => {
          this._tone({ type: 'sine', freq: f * r, dur: rand(2.5, 4.5) / (1 + i * 0.4),
                       gain: 0.030 / (1 + i * 1.5), attack: 0.006, bus });
        });
        this._noiseHit({ dur: 0.5, gain: 0.012, freq: 2500, sweepTo: 600, q: 1.5, bus });
        break;
      }

      // A structure, or part of one, coming down a long way off. Mostly sub-bass; the
      // debris is only there to tell you it was made of something.
      case 'collapse': {
        this._noiseHit({ dur: rand(1.6, 2.8), gain: rand(0.05, 0.10), freq: 260, sweepTo: 45,
                         q: 0.5, type: 'lowpass', attack: rand(0.1, 0.4), bus });
        this._tone({ type: 'sine', freq: rand(48, 70), toFreq: 26, dur: 1.4, gain: 0.06,
                     attack: 0.15, bus });
        const n = 4 + ((Math.random() * 6) | 0);
        for (let i = 0; i < n; i++) {
          this._noiseHit({ dur: rand(0.02, 0.08), gain: rand(0.004, 0.014), freq: rand(400, 1800),
                           q: rand(2, 6), delay: rand(0.1, 1.2), bus });
        }
        break;
      }

      // A body, out in the dark, that you cannot see and cannot locate.
      case 'groan': {
        const far = rand(0.4, 0.85);
        const f = rand(55, 95);
        this._formantVoice({
          f0: f * rand(1.05, 1.35), toF0: f * rand(0.55, 0.8), dur: rand(1.1, 2.4),
          gain: rand(0.06, 0.10), attack: rand(0.2, 0.6),
          breath: rand(0.4, 0.9), rasp: rand(0, 0.9), sub: rand(0.3, 0.8),
          q: rand(6, 12), wobbleDepth: rand(0.3, 0.6), drift: 0.09, far, bus,
        });
        break;
      }

      // Something heavy being pulled through dirt. Overlapping low grains with an
      // uneven push-pause-push shape.
      case 'drag': {
        const d = rand(1.2, 2.6);
        const n = 10 + ((Math.random() * 10) | 0);
        for (let i = 0; i < n; i++) {
          const k = i / n;
          const swell = Math.sin(k * Math.PI) * rand(0.6, 1.1);
          this._noiseHit({ dur: rand(0.12, 0.3), gain: 0.016 * swell, freq: rand(160, 420),
                           sweepTo: rand(70, 140), q: 0.9, type: 'lowpass',
                           delay: d * k + rand(0, 0.08), bus });
        }
        this._noiseHit({ dur: d, gain: 0.010, freq: 900, sweepTo: 400, q: 1.2, attack: d * 0.4, bus });
        break;
      }

      // High intensity only: the air thickening. Two pitches a semitone-ish apart
      // swelling up out of nothing and sinking back, beating the whole way. It is the
      // closest this score gets to a "cue", and it still has no pulse and no key.
      case 'pressure': {
        const d = rand(3.5, 6.0);
        const f = midiToFreq(ROOT + 12) * rand(0.94, 1.06);
        this._tone({ type: 'triangle', freq: f, toFreq: f * rand(0.8, 0.92), dur: d,
                     gain: 0.030, attack: d * 0.45, curve: 'lin', bus, detune: rand(-20, 20) });
        this._tone({ type: 'triangle', freq: f * rand(1.055, 1.075), toFreq: f * 0.9, dur: d * 0.9,
                     gain: 0.024, attack: d * 0.4, curve: 'lin', bus });
        this._tone({ type: 'sine', freq: f * 0.25, dur: d, gain: 0.05, attack: d * 0.5, bus });
        this._noiseHit({ dur: d, gain: 0.022, freq: 3000, sweepTo: 200, q: 0.6, type: 'lowpass',
                         attack: d * 0.5, bus });
        break;
      }
    }
  }
}

export const audio = new AudioEngine();