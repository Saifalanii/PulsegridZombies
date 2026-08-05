// Service worker: cache-first for the app shell, so Nightfall Village is fully playable
// offline the moment it's been opened once. All the sound is still synthesised at
// runtime; the art is not, so the shell now has to carry real image assets.
//
// Bump CACHE when shipping: the old cache is deleted on activate.

// v2: the shell gained player_hero_alt.png and player_hero_axe.png. Without the bump an
// existing install keeps its v1 cache, never re-runs addAll, and the first offline launch
// after the update draws a survivor holding nothing.
const CACHE = 'nightfall-v2';

// On localhost the cache-first strategy below happily serves the module you edited
// thirty seconds ago, and you debug a file the page isn't running. Development gets
// network-first (cache only as an offline fallback); production keeps cache-first,
// which is the whole point of an offline game.
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/core/math.js',
  './js/core/rng.js',
  './js/core/pool.js',
  './js/core/audio.js',
  './js/core/save.js',
  './js/core/input.js',
  './js/fx/particles.js',
  './js/fx/juice.js',
  './js/fx/render.js',
  './js/fx/face.js',
  './js/fx/sprites.js',
  './js/game/palette.js',
  './js/game/defs.js',
  './js/game/daily.js',
  './js/game/run.js',
  './js/game/world.js',
  './js/game/characters.js',
  './js/game/voice.js',
  './js/ui/screens.js',
  './icons/favicon-64.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',

  // --- art ---
  //
  // Every character sheet actually loaded: the sword sheet, the bow sheet (also doubles
  // as the menu-portrait head crop — see PORTRAIT_SHEET in sprites.js), the axe sheet,
  // and the four zombie variants. This list previously claimed player_hero_alt.png was
  // unused and skipped it — that stopped being true once the bow and the portraits
  // started reading from it, and the list just hadn't been updated to say so.
  './assets/characters/player_hero.png',
  './assets/characters/player_hero_alt.png',
  './assets/characters/player_hero_axe.png',
  './assets/characters/zombie_green.png',
  './assets/characters/zombie_rotting.png',
  './assets/characters/zombie_shadow.png',
  './assets/characters/zombie_plague.png',

  // --- tiles ---
  //
  // A subset of assets/tiles, not all 75 files. Two exclusions, both deliberate:
  //
  //  - every DAY variant. This game only ever happens after dark, so the DAY sheets are
  //    dead weight in an offline shell.
  //  - the NIGHT props the village generator never places (BRIDGE, STAIRS), which would
  //    need water-crossing logic the world doesn't have.
  //
  // The list has to stay in step with TILE_DEFS / DECAL_DEFS / PROP_DEFS in
  // js/game/world.js — that module exports `shellAssets()`, which returns exactly this
  // list, so a mismatch can be caught by comparing the two rather than by discovering
  // offline play is broken. addAll is atomic: one wrong path fails the whole install.
  // Procedurally generated street set (tools/make-street-tiles.mjs) — see world.js's
  // TILE_DEFS/DECAL_DEFS/PROP_DEFS, which this list must stay in step with. The old
  // TERRAIN SET entries are gone too: DECAL_DEFS is empty (see the comment on it in
  // world.js), so those files were being cached for a code path that no longer reads
  // them — dead weight in an atomic install list, not just an unused file.
  './assets/tiles/ASPHALT TILE - NIGHT.png',
  './assets/tiles/ASPHALT DETAIL 1 - NIGHT.png',
  './assets/tiles/ASPHALT DETAIL 2 - NIGHT.png',
  './assets/tiles/ASPHALT DETAIL 3 - NIGHT.png',
  './assets/tiles/ASPHALT DETAIL 4 - NIGHT.png',
  './assets/tiles/CONCRETE TILE - NIGHT.png',
  './assets/tiles/CONCRETE DETAIL 1 - NIGHT.png',
  './assets/tiles/CONCRETE DETAIL 2 - NIGHT.png',
  './assets/tiles/CONCRETE DETAIL 3 - NIGHT.png',
  './assets/tiles/PUDDLE TILE - NIGHT.png',
  './assets/tiles/PUDDLE DETAIL 1 - NIGHT.png',
  './assets/tiles/PUDDLE DETAIL 2 - NIGHT.png',
  // The buildings and trees moved to the city sheet below; the generated TENEMENT/
  // FACTORY/TREE files are still produced by tools/make-street-tiles.mjs but nothing
  // loads them any more, so caching them would be a pure download cost.
  './assets/city/simple-city-32.png',
  './assets/tiles/CHAINLINK A - NIGHT.png',
  './assets/tiles/CHAINLINK B - NIGHT.png',
  './assets/tiles/STORM DRAIN - NIGHT.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is atomic — one 404 rejects the whole install, which is what we want:
      // a half-cached shell that boots into a module error is worse than no cache.
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (DEV) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // Navigations: serve the shell so deep links and the manifest shortcuts work offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((hit) => hit || fetch(req).catch(() => caches.match('./')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // Stale-while-revalidate: play instantly from cache, quietly pick up updates.
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
