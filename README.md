# Nightfall Village

A top-down zombie-survival roguelite as an installable PWA. Canvas 2D, vanilla ES modules,
**no build step and no dependencies**. Music and player swings use recorded assets; the
remaining effects and village ambience are generated with Web Audio. See [Credits](#credits)
for the art.

Holt is trapped in a village that rolls back to dusk whenever he falls. The Band opens one
fixed route each calendar night; Practice reshuffles the horde and rewards but does not bank
scrap or extend the streak.

## Running it

```bash
node serve.mjs
```

Then open `http://localhost:8080`. The script prints your LAN address too, which is how
you actually test the touch controls on a phone.

ES modules and service workers both need a real HTTP origin, so `file://` won't work.
Install prompts need `localhost` or HTTPS.

To regenerate the icon set (a pure-JS PNG encoder — SDF rendering plus Node's `zlib`):

```bash
node tools/make-icons.mjs
```

## Layout

```
index.html              shell; all menus/HUD are DOM, the village is canvas
manifest.webmanifest    standalone, maskable icons, tonight/practice shortcuts
sw.js                   offline shell cache (network-first on localhost — see below)
serve.mjs               zero-dependency static server
tools/make-icons.mjs    generates icons/*.png from signed distance fields
CREDITS.md              third-party art attribution — read this before redistributing
assets/
  characters/           survivor loadout sheets and zombie variants
  city/                 source city sheet and supply chest
  maps/                 authored village map, collision data and map tiles
  audio/                music plus recorded machete swings
js/
  main.js               boot, fixed-timestep loop, state machine
  core/   math rng pool audio save input
  fx/     particles juice render sprites face
  game/   palette defs daily run world characters voice
  ui/     screens
```


### Tonight is deterministic

The simulation runs at a fixed 120Hz step, and randomness is split so player-driven drops
cannot reshuffle the director:

| stream | drives | advanced by |
| --- | --- | --- |
| `rng` | wave composition, spawn angles, elite schedule | the spawn timer only |
| `rngUpgrade` | level-up offers | one draw per level |
| `rngAux` | crits, drops, bloater spill, horde calls | player actions |

The director's stream is never touched by anything the player does — including a full
enemy pool, which drops the spawn but still consumes its draws. Two players on the same
date get byte-identical waves, the same three upgrades at level *N*, and the same village,
and differ only in how well they play. Cosmetic randomness (particle jitter, barks) uses
`Math.random` so it can't perturb a run.

The authored village is fixed. If its map file cannot load, the procedural fallback uses a
separate seed so fallback construction still cannot reshuffle the horde.

One upgrade needed adjusting for this contract. `Bloodhound` only affects projectiles, so
on a melee build it was a dead card — but it can't be filtered out of the draw, because
the promise is that everyone sees the same three cards at level *N* regardless of what
they're carrying. It gained a reach bonus instead, so it's live for both.

### The village is real geometry, not a backdrop

`js/game/world.js` loads the authored town map and rasterises its collision layer into one
flat `Uint8Array` at tile resolution. Collision is then four array reads per entity per
axis, independent of how many props exist, and allocates nothing.

Movement is axis-separated so entities slide along walls rather than sticking, which
matters enormously when a dozen shamblers are funnelling down a lane between two houses.
Arrows and bile stop on walls too, so buildings are cover for both sides.

Drawing is viewport-culled, and props and characters are merged into one depth-sorted
pass (insertion sort over two preallocated typed arrays). A foreground prop fades when it
covers Holt, preserving depth without hiding the player under a roof or tree.

**Scale.** The tileset is 16px art with a much chunkier pixel density than the 64px LPC
frames. Tiles are drawn at 2× (16 source px → 32 world px) and characters at a 64px world
height, which puts a character at two tiles tall and a house at seven — the proportion the
tileset is drawn for. `imageSmoothingEnabled = false` throughout. Tiles are blitted one
world unit larger than their footprint: the world-to-screen scale is fractional, so
consecutive tiles otherwise round to rects that leave a sub-pixel gap, and against a dark
backdrop that gap reads as a lit grid drawn over the ground.

### Combat is melee, and the wind-up is the game

Nothing in the roster deals contact damage. An enemy that reaches you **stops, plays a
visible wind-up, and applies damage on the contact frame of its attack animation** — the
clip is stretched so the tell and the hit are the same event. A wind-up you can read and
dash out of is the entire difference between "shapes bumping into you" and "being swarmed".
A hard enough hit during the wind-up cancels it, which is the closest this game gets to a
parry.

The dead die with LPC's `hurt` animation — six frames of collapsing into a prone body —
and then lie there for a few seconds before fading. Corpses live in their own pool, not
the enemy pool: a dead thing occupying a live slot would let a busy street starve the
director of spawns, and every loop that touches enemies would have to test `dead`.

The survivor's weapons were rebuilt around the animations that actually exist in the art:

| weapon | | |
| --- | --- | --- |
| **Machete** | melee, fast, narrow arc | free |
| **Hunting Bow** | ranged, pierces, slow draw | 700 scrap |
| **Fire Axe** | melee, slow, wide arc, huge | 1400 scrap |

A melee starter is deliberate. An auto-aiming ranged-only survivor with a sword sprite on
the character is incoherent; being *forced* into the horde's reach is what makes the horde
matter. Projectile upgrades fold into reach and swing arc on a melee weapon, so no offer
is ever dead.

### Silhouette is still the primary threat read

Thirteen enemy types are drawn from four zombie sheets, so colour cannot carry the
distinction. Scale and motion do:

- **scale** — a Brute is 1.65× a Shambler and a Crawler is 0.6×. Size reads instantly, at
  any distance, before you can resolve a pixel.
- **motion** — a Shambler lurches straight in, a Stalker weaves, a Runner freezes then
  sprints, a Lurker stops dead and telegraphs a leap, a Screamer refuses to close and
  calls more of them, the Butcher tears three Thralls off itself at half health.
- **sheet and tint** — green (fresh), rotting (old), shadow (dark, fast), plague (swollen),
  with an occasional `ctx.filter` hue shift, used only where the type *also* differs in
  scale or behaviour so it is never the sole cue.

Behaviours that no longer made sense were redesigned rather than reskinned. The old
Orbiter was a circling turret; the Screamer keeps the circling and replaces the projectiles
with summoning, because a zombie that shoots is a sci-fi turret wearing a corpse. The
Spitter kept a projectile because vomiting bile is something a corpse can plausibly do.

### Rendering: bright-pass bloom and a lantern

The original pipeline was a fake-HDR bloom rig for glowing vector shapes on a near-black
void: downsample the scene, blur it, add it back at 0.52 alpha. That worked because
everything except the emissive shapes was already near zero — the earlier note about 0.78
lifting the far corners from ~(12,7,5) to ~(106,50,42) is that same effect getting away
from itself.

Against a lit ground plane *everything* is mid-grey, so a flat full-frame bloom lifts the
grass, the houses and the survivor's face equally and the pixel art turns to fog. So bloom
is now gated by a real bright pass: the downsampled scene is `multiply`-blended by itself
twice, cubing every channel. A grass tile at 0.45 falls to 0.09; a spark at 0.98 stays at
0.94. Because the source is genuinely sparse, the composite alpha went *up* rather than
down — sparks, bile, scrap and the lantern bloom harder than they ever did, and the art
underneath is untouched. Cost is two extra quarter-res blits.

What the full-frame bloom used to be doing badly — giving the picture a mood — is now a
**darkness pass**: a pre-rendered soft mask blitted over the survivor with the rest of the
frame flooded flat, then one uniform moonlight tint. Opacity and radius come from the night
phase, so DUSK is a blue haze at 270 units of reach and THE LONG DARK is a 200-unit
keyhole. It costs one drawImage and five fillRects, with no per-frame gradient allocation.

Two things learned building it, both encoded in the code:

- The mask and the flood **must be the same colour**. Filling the surround with the phase's
  night tint while drawing the mask in black draws a literal visible rectangle around the
  player at high opacity. Both are black; the hue is a separate flat pass, which cannot
  seam because it has no edges.
- The mask's centre is not fully transparent (0.16). A hard zero makes the lit disc read
  as a hole cut in the night rather than as light falling on a village.

The parallax grid, the neon arena brackets and the procedural eye overlay on enemies are
gone. `js/fx/face.js` survives because the UI still draws character portraits with it.

### Performance

Everything hot lives in fixed-capacity pools; the update path allocates nothing. Measured
worst case — 120 enemies, ~430 particles, 15 corpses, ~190 props, 1350×595 — is **~2.9ms**
per frame for the full world draw plus post chain, down from ~5.5ms for the original's
entity pass. The tile plane is the reason it isn't worse: viewport culling bounds it by
screen area rather than village area, so it's ~600 `drawImage` calls of a 16px source
regardless of map size.

**Caveat, unchanged from before: measured in a non-compositing headless browser pane, so
these are software-raster figures and not a substitute for testing on a real mid-range
phone.** Quality auto-drops after sampling the first ~140 frames.

### The service worker now carries real assets

`sw.js` is network-first on `localhost` and cache-first everywhere else. Cache-first in
development happily serves the module you edited thirty seconds ago, and you end up
debugging a file the page isn't running.

`SHELL` uses `addAll`, which is atomic — one bad path fails the whole install. It contains
the authored map, every playable character/enemy sheet, the city art, UI shell and combat
swings. The larger music files enter the runtime cache after first playback so a flaky
connection cannot make the entire offline install fail.

### Sprite geometry, verified not assumed

Every row offset in `js/fx/sprites.js` was determined by decoding the alpha channel of the
actual PNGs and scanning per-row occupancy. Two geometries are in play:

- **Standard sheets** (`zombie_*.png`, `player_hero_alt.png`) — 832×3456, 13 columns of
  64×64 frames, 54 rows.
- **`player_hero.png`** — 1152×4480. The top 3456px are the same 54 rows in a wider canvas
  (18 columns; only the first 13 carry art). The bottom 1024px are 8 rows of **128×128
  oversized** frames holding the big sword swings — the only frames in the entire asset set
  where a weapon is visible in the character's hands. That is why the player uses this
  sheet and not the tidier alt one.

Blocks: spellcast 0–3 (7), thrust 4–7 (8), walk 8–11 (9), slash 12–15 (6), shoot 16–19
(13), **hurt row 20 (6, non-directional)**, climb 21, idle 22–25 (2), jump 26–29, sit
30–33, emote 34–37, run 38–41, combat idle 42–45. Oversized slash at y=3456 (4×9),
oversized backslash at y=3968 (4×6). Direction order is up, left, down, right.

LPC has no separate death animation: the hurt row *is* the death, collapsing to a prone
body. A `flinch` clip reads only its first three frames, because otherwise every scratch
looks fatal.

### Streaks are honest

Miss a night and it resets to 1. No grace period, no freeze, no "streak repair". Replaying
the same day doesn't double-count, and milestones pay out once.

## Judgment calls

- **No Tone.js.** ~200KB of CDN dependency in an offline-first PWA, when every sound here
  is a short envelope on primitive oscillators plus two noise buffers. Raw Web Audio.
- **Sprint and heavy share one touch zone.** Attacking is automatic and auto-aimed at the
  nearest threat (elites weighted closer). Tap the action side to sprint; hold it to commit
  a heavy attack. Keyboard players use Space and E. A visible readiness control and hold
  ring make the two actions explicit.
- **The village is bounded** (2400×2400, tighter under FOGBOUND) rather than infinite, so
  the camera can frame the fight and there's no running away forever. Outside the tile map
  is flooded with night, which reads as woods too dark to walk into rather than as the edge
  of the map.
- **Night phases every 55s**, six of them, each darker and with less lantern reach than the
  last.
- **A lantern pool on the ground under the survivor.** Not decoration: in a crowd you are
  depth-sorted among a dozen bodies of your own size in your own palette, and testing found
  you genuinely lose track of yourself. A warm pool of light says "you are here" without a
  marker that would look like UI pasted into the world.
- **Attack tells are flattened onto the ground.** They started as upright rings at 1.35×
  reach; with thirty bodies converging, thirty overlapping circles swept across each other
  and the screen became unreadable, which defeats the entire purpose of a tell.
- **Meta bonuses are modest** (~6% per tier). Progression should shorten the ramp, not
  trivialise it, or the nightly run stops being a fair comparison between players.
- **Barks are bag-shuffled**, not randomly drawn — random selection on a 16-line pool
  repeats visibly about every fourth line, which is what makes reactive barks feel cheap.
- **Audio is wet, low and unresolved.** Impacts are lowpassed noise with a fast decay and
  no tonal component, because any sustained pitch turns meat into machinery. Groans and
  screams end on a downward sweep and never settle.
- **Anything with a throat is built from formants, not waveforms.** A buzzy, pitch-unstable
  source plus breath noise goes through three bandpass filters parked on vowel formants
  (F1/F2/F3), morphing from one vowel toward another across the sound — a mouth changing
  shape. Detuned sawtooth pairs beat convincingly and still read as a synth pad, because
  nothing in them has a resonant cavity. Every parameter is re-rolled per call, so a dozen
  overlapping groans stack into a crowd instead of into a chord.
- **Music stays beneath the street.** Menu and run themes are recorded tracks. A generated
  wind bed, drifting drone and sparse distant events sit around them; intensity changes
  density and pressure rather than turning the night into a dance track.
- **A fresh save key.** `pulsegrid.zombies.save.v1`. The weapon ids, unlock ids and the
  meaning of half the numbers changed; migrating a Pulsegrid save would hand the survivor a
  weapon that no longer exists. The daily seed namespace changed to `nightfall-v1|` for the
  same reason.

## Cast

| survivor | loadout | temperament |
| --- | --- | --- |
| **HOLT** | Machete | Fast and close; makes room. |
| **HOLT** | Hunting Bow | Slow draw; lines the street up. |
| **HOLT** | Fire Axe | Slow, wide, and built for doorways. |

**THE BAND**, a voice on the emergency channel, shows up on the nightly brief and the
results screen, sets the nightly conditions and keeps the count.

## Credits

The character sprites are **Liberated Pixel Cup** art, assembled with the Universal LPC
Spritesheet Character Generator, dual-licensed CC-BY-SA 3.0 / GPL 3.0. **Crediting the
authors is a licence condition.** The village tileset's origin is currently unrecorded.

**Read `CREDITS.md` before redistributing this project** — it explains exactly what still
needs to be filled in and how to get it.

## Not done

- No backend, so the leaderboard is local-only. A shared nightly board is the obvious v2.
- Not yet profiled on real mid-range hardware (see the performance caveat above).
- The tileset's `BRIDGE` and `STAIRS` props are unused: they need water-crossing and
  elevation logic the world doesn't have.
- The internal save field for scrap is still named `shards`, and the trail/lantern ids are
  still `trail_*`. Only the displayed vocabulary changed; renaming the persisted keys would
  have needed a migration for no player-visible benefit.
- Voice lines are English-only and not externalised for translation.
