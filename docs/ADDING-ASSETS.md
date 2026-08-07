# Adding assets

How to add art and audio to Nightfall yourself. Every asset type has three things in
common, so start here:

1. **Put the file in `assets/`** (the right subfolder — see each section).
2. **Register it in code** — a filename in `assets/` does nothing until something loads it.
3. **Add it to the offline cache** — `sw.js`, and bump the cache number. Skip this and the
   game still works online, but installed/offline players keep the old version forever.

There is also one rule that is easy to break invisibly, called out where it applies:
**anything that consumes a random number during a run must do so on every spawn, not
conditionally** — see "The determinism trap" at the bottom. Get it wrong and the Daily
Run stops being the same for everyone, with no error to tell you.

After any change: bump `CACHE` in `sw.js` (e.g. `nightfall-v6` → `nightfall-v7`) and add
the new path(s) to the `SHELL` list. And add a line to `CREDITS.md` — the art is licensed,
and attribution is a condition of using it.

---

## A new zombie skin

The quickest, safest asset to add — it's cosmetic, so it can't unbalance anything.

**The file.** Must be a standard LPC sheet: **832 × 3456 px**, the same layout as the
existing `assets/characters/zombie_*.png`. If yours came from the Universal LPC generator
it already is. Drop it in `assets/characters/`, e.g. `zombie_frostbitten.png`.

**Register the sheet** in `js/game/run.js`, in the `SHEETS` map (~line 50):

```js
const SHEETS = {
  green:   new LpcSheet('assets/characters/zombie_green.png'),
  // ...
  frostbitten: new LpcSheet('assets/characters/zombie_frostbitten.png'),
};
```

**Use it** in `js/game/defs.js`. Either give one enemy this sheet:

```js
stalker: { name: 'Stalker', sheet: 'frostbitten', ... }
```

…or add it to a `sheets` array so an enemy picks randomly between skins per spawn (this is
what the Shambler does):

```js
shambler: { ..., sheets: ['green', 'fresh', 'charred', 'frostbitten'], ... }
```

**Check it before trusting it.** New sheets sometimes have blank rows. The safe check is
that its walk/idle/slash/thrust/hurt frames are all filled and that its overall brightness
sits near the others (roughly luminance 60–90) so it doesn't glow at night. If you can't
verify that yourself, say so and I'll scan it.

Finally: add it to `SHELL` in `sw.js`, bump `CACHE`, add a `CREDITS.md` line.

---

## City art: buildings, cars, trees, ground tiles

All of this lives on **one image**: `assets/city/simple-city-32.png`, a grid of **32 × 32**
cells. To change any of it, edit that file and keep the grid alignment.

The code refers to cells by **[column, row]**, zero-indexed, 32px each. Two tables in
`js/game/world.js` hold every reference:

- **`GROUND_TILES`** — the ground the world is painted from (road, crossings, pavement,
  grass, cobble). Each entry is `[col, row]` into the sheet. Order matters: the `G_*`
  constants just below the table are indices into it, so if you insert a row, the constants
  shift. Easier to *replace* a cell's `[col, row]` than to insert.
- **`CITY`** — the sprites (buildings, cars, furniture). Each entry is
  `[sx, sy, width, height]` in **pixels**, because sprites aren't cell-aligned.

**If you only redraw existing art** (repaint a building, clean up the road) and keep it in
the same cells — you're done after editing the PNG. No code change. Just bump the cache,
because the filename didn't change and installs would otherwise serve the old picture.

**If you move art to different cells,** update the `[col, row]` / `[sx, sy, w, h]` numbers
to match.

**Two traps this sheet has bitten us with, both silent:**

- **A cell that looks like pavement but isn't.** The green-planter block reads as pavement
  at a glance but tiles a tuft of grass onto every kerb. Sample a cell's actual pixels
  before trusting it, or ask me to.
- **Removing art without removing the reference.** Delete a bush from the sheet and its old
  cell becomes blank/stray pixels; the code keeps "placing" an invisible object that still
  blocks the ground. If you remove something, remove its entry from `CITY`/`PROP_DEFS` too.

**Scale note.** These cells are 32px but drawn at 2× = 64 world pixels, deliberately, so
they match the character art's density. A 16px sprite (like the chest) is drawn at 3× to
land at a sensible size. If you add a new standalone sprite at a different source
resolution, its draw scale needs to account for that.

**Night tint.** This sheet is daylight art, darkened once at load (`loadCitySheet` in
world.js applies `NIGHT_TINT`). Anything routed through that loader is tinted automatically
— which is why the chest gets its own loader call rather than being drawn raw.

---

## Music and sound

In `assets/audio/`. Registered in `js/core/audio.js`.

**Music** (loops, streamed) — the `TRACKS` map (~line 121):

```js
const TRACKS = {
  menu: 'assets/audio/menu-theme.wav',
  run:  'assets/audio/run-theme.ogg',
};
```

`.ogg` is strongly preferred over `.wav` for music — same sound, ~90% smaller download.
(It does *not* reduce memory or fix lag; decoded audio is the same size either way. It's
purely a download-size win.) Which track plays is chosen by game state in `js/main.js`
(`_syncTrack`).

**Sound effects** (short, one-shot) — the `SAMPLES` map (~line 136), then played via a
small wrapper method. The sword swing is the model to copy: two takes in `SAMPLES`, a
`swordSwing()` method that alternates them with slight pitch variance so repeats don't
sound mechanical. Everything else in the game is synthesised in code, not sampled — so a
recorded SFX is the exception, and it's worth keeping them short.

Music is deliberately **not** in the `sw.js` shell (it's 6MB; an atomic install failing on
it would cost the whole offline cache). Small SFX (under a few hundred KB) *are* in the
shell — a silent weapon offline is a broken weapon.

---

## Making a map (Sprite Fusion)

The world is loaded from `assets/maps/town.json` — a map drawn in
[Sprite Fusion](https://www.spritefusion.com/) and exported. To change the map or make a
new one, you don't touch code.

**To replace the map:**

1. In Sprite Fusion, build your map. Keep the tile size at **32px** — the game draws it at
   2×, so 32px is correct; 64px comes out doubled.
2. Export → you get a `map.json` and the tileset PNG.
3. Drop them in `assets/maps/`, named `town.json` and `town-tiles.png` (overwrite the
   existing ones). That's it — reload and it's the new map.
4. Bump `CACHE` in `sw.js` so installed players get the new map instead of the cached one.

**To paint collision** (what blocks the player and the dead):

1. In Sprite Fusion, add a **new layer** and turn on its **collider** toggle.
2. On that layer, paint a tile onto every cell that should be a wall — buildings, hedges,
   posts, fences, anything solid. The tile you use doesn't matter; a collider layer is
   never drawn, only felt.
3. Export and drop in as above.

When a map has a collider layer, the game obeys it **exactly** — nothing is guessed. When
a map has *no* collider layer (like the first export did), the game falls back to a rule of
thumb: hard surfaces (road, pavement, cobble) are walkable, everything else — grass,
foliage, buildings — is solid. Painting collision yourself is always better; the fallback
is just so an unpainted map is still playable.

**Layers stack.** Any non-collider layer is drawn, bottom to top in the order Sprite Fusion
lists them — so a ground layer plus a props/decoration layer both render.

**Known limit:** authored maps are flat — no walk-behind. Your buildings are part of the
tile layer, so you don't pass behind a roof the way you do with the procedural props.
Adding that means tagging which tiles are "tall"; ask if you want it.

---

## The determinism trap

The Daily Run works because the same date produces the same night for everyone. That holds
only if world generation and the wave director pull from the seeded random streams in the
**same order every time**, regardless of what the player does.

The rule when you add anything that rolls a random number during a run: **make the draw
unconditional.** The pattern in `_spawnEnemy` (run.js) is the reference — position, groan
timer and skin are all rolled up front, every spawn, even for enemies that only have one
skin. If a draw only happens *sometimes* (a full enemy pool skipping it, a variant only
some enemies have), two players' streams drift apart and the shared night quietly breaks.

Rewards the player *chooses* to collect (supply-drop upgrades) deliberately draw from a
**different** stream (`rngAux`) than the shared one (`rngUpgrade`), for the same reason:
one player's choice must not shift another player's level-up cards.

If you're adding something that spawns, drops, or offers a choice and you're not sure which
stream it belongs on, ask — this is the one class of bug that ships looking fine and only
shows up when two people compare runs.

---

## Checklist

- [ ] File in the right `assets/` subfolder
- [ ] Registered in code (`SHEETS` / `GROUND_TILES` / `CITY` / `TRACKS` / `SAMPLES`)
- [ ] Old references removed if you deleted art
- [ ] Added to `SHELL` in `sw.js` (skip only for the big music files)
- [ ] `CACHE` bumped in `sw.js`
- [ ] Line added to `CREDITS.md`
- [ ] If it rolls RNG during a run: the draw is unconditional
