# Credits and licences

Nightfall Village uses third-party pixel art. **Attribution is a licence condition, not a
courtesy.** If you fork, redistribute or deploy this project, this file must travel with
it and the in-game credit line must stay visible.

Everything else — all code, every sound (synthesised at runtime with Web Audio), and the
generated icon set — is original to this project.

---

## Character sprites — Liberated Pixel Cup (LPC)

Files:

- `assets/characters/player_hero.png`
- `assets/characters/player_hero_alt.png`
- `assets/characters/zombie_green.png`
- `assets/characters/zombie_rotting.png`
- `assets/characters/zombie_shadow.png`
- `assets/characters/zombie_plague.png`

These were assembled with the **Universal LPC Spritesheet Character Generator**, which
composites layers contributed by many different artists to the Liberated Pixel Cup.

- Generator: <https://sanderfrenken.github.io/Universal-LPC-Spritesheet-Character-Generator/>
- Source repository: <https://github.com/sanderfrenken/Universal-LPC-Spritesheet-Character-Generator>
- Original Liberated Pixel Cup: <https://lpc.opengameart.org/>

**Licence:** LPC art is dual-licensed **CC-BY-SA 3.0** and **GPL 3.0** (individual layers
may additionally be CC-BY 3.0, CC-BY 4.0, CC-BY-SA 4.0 or OGA-BY 3.0 — the generator
reports the exact terms per layer). Distributing these sprites requires crediting the
authors and, under CC-BY-SA, sharing derivative art under the same terms.

- CC-BY-SA 3.0: <https://creativecommons.org/licenses/by-sa/3.0/>
- GPL 3.0: <https://www.gnu.org/licenses/gpl-3.0.html>

### ⚠️ Action required: export the exact per-layer author list

The generator itself states *"You must credit the authors"* and provides a **Credits
(TXT)** download listing every layer used in a given character along with its individual
author and licence. **That file could not be obtained for these six sheets** — they
arrived as bare PNGs, and a spritesheet carries no record of which layers composed it.

Nothing in this repository can reconstruct that list. To make the attribution complete
and legally sufficient:

1. Open the generator linked above.
2. Rebuild each of the six characters (or load the `.json` character definition, if you
   still have the one used to export them).
3. Click **Credits (TXT)** and download the credit file for each.
4. Paste the contents into the placeholder section below, one block per sheet.

Known frequent contributors to LPC layers — listed here as a starting point, **not** as a
substitute for the generated file, because it is neither complete nor per-layer accurate:
Stephen Challener (Redshrike), Johannes Sjölund (wulax), Marcel van de Steeg (MadMarcel),
Manuel Riecke (MrBeast), Thane Brimhall (pennomi), Matthew Krohn (makrohn), Nila122,
Daniel Eddeland (daneeklu), bluecarrot16, Michael Whitlock (bigbeargames), Joe White,
Sander Frenken (castelonia), ElizaWy, JaidynReiman, Benjamin K. Smith (BenCreating),
Evert, and many others.

```
[ PASTE THE GENERATOR'S "Credits (TXT)" OUTPUT HERE — one block per character sheet ]

player_hero.png / player_hero_alt.png:
  ...

zombie_green.png:
  ...

zombie_rotting.png:
  ...

zombie_shadow.png:
  ...

zombie_plague.png:
  ...
```

---

## Village tileset

Files: `assets/tiles/*.png` (75 files — a top-down village set with matched DAY and NIGHT
variants of every tile and prop; this game ships the NIGHT variants).

The set includes a `(THANK YOU).png` card from the artist, which is retained in the
repository unmodified.

**⚠️ The artist's name and the licence terms are not recorded here**, because the files
arrived without a licence file, a readme, or any metadata identifying their origin. Nobody
should assume permission from that absence.

Before this project is redistributed or published, whoever obtained the tileset must:

1. Identify where it came from (itch.io, OpenGameArt, a Humble/asset-store bundle, a
   commission) and who made it.
2. Record the artist's name, a link to the original listing, and the exact licence.
3. Replace this section with that information.

If the licence turns out to require it, add attribution to the in-game credits line in
`index.html` alongside the LPC credit.

---

## In-game credit

A visible credit line appears at the bottom of the main menu (`index.html`, class
`.credits-line`). It must not be removed while the LPC art is in use. When the tileset's
licence is established, extend that line if attribution is required there too.

---

## Original engine

Nightfall Village is a fork of **Pulsegrid**, a neon arena survivor by the same author.
The determinism model (three-stream seeded RNG on a fixed 120Hz step), the pooling
discipline, the service worker strategy and the synthesised audio engine are carried over
from it; the world, the combat model, the enemy roster, the art pipeline and the theme are
not. See `README.md`.
