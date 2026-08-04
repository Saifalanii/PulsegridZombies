// Service worker: cache-first for the app shell, so Nightfall Village is fully playable
// offline the moment it's been opened once. All the sound is still synthesised at
// runtime; the art is not, so the shell now has to carry real image assets.
//
// Bump CACHE when shipping: the old cache is deleted on activate.

const CACHE = 'nightfall-v1';

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
  // The five character sheets actually loaded by js/game/run.js. `player_hero_alt.png`
  // is deliberately absent: it's the standard-geometry fallback for the same character
  // and nothing references it, so caching it would cost ~360KB of a first-run download
  // for a file the game never asks for.
  './assets/characters/player_hero.png',
  './assets/characters/zombie_green.png',
  './assets/characters/zombie_rotting.png',
  './assets/characters/zombie_shadow.png',
  './assets/characters/zombie_plague.png',

  // --- tiles ---
  //
  // 35 of the 75 files in assets/tiles, not all of them. Two exclusions, both deliberate:
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
  './assets/tiles/GRASS TILE - NIGHT.png',
  './assets/tiles/GRASS DETAIL 1 - NIGHT.png',
  './assets/tiles/GRASS DETAIL 2 - NIGHT.png',
  './assets/tiles/GRASS DETAIL 3 - NIGHT.png',
  './assets/tiles/GRASS DETAIL 4 - NIGHT.png',
  './assets/tiles/GRASS DETAIL 5 - NIGHT.png',
  './assets/tiles/GRASS DETAIL 6 - NIGHT.png',
  './assets/tiles/GROUND TILE - NIGHT.png',
  './assets/tiles/GROUND DETAIL 1 - NIGHT.png',
  './assets/tiles/GROUND DETAIL 2 - NIGHT.png',
  './assets/tiles/GROUND DETAIL 3 - NIGHT.png',
  './assets/tiles/GROUND DETAIL 4 - NIGHT.png',
  './assets/tiles/GROUND DETAIL 5 - NIGHT.png',
  './assets/tiles/WATER TILE - NIGHT.png',
  './assets/tiles/WATER DETAIL 1 - NIGHT.png',
  './assets/tiles/WATER DETAIL 2 - NIGHT.png',
  './assets/tiles/WATER DETAIL 3 - NIGHT.png',
  './assets/tiles/WATER DETAIL 4 - NIGHT.png',
  './assets/tiles/WATER DETAIL 5 - NIGHT.png',
  './assets/tiles/TERRAIN SET 1 - NIGHT.png',
  './assets/tiles/TERRAIN SET 2 - NIGHT.png',
  './assets/tiles/TERRAIN SET 3 - NIGHT.png',
  './assets/tiles/TERRAIN SET 4 - NIGHT.png',
  './assets/tiles/TERRAIN SET 5 - NIGHT.png',
  './assets/tiles/TERRAIN SET 3 CURVES - NIGHT.png',
  './assets/tiles/TERRAIN SET 4 CURVES - NIGHT.png',
  './assets/tiles/HOUSE 1 - NIGHT.png',
  './assets/tiles/HOUSE 2 - NIGHT.png',
  './assets/tiles/CHURCH - NIGHT.png',
  './assets/tiles/TREE 1 - NIGHT.png',
  './assets/tiles/TREE 2 - NIGHT.png',
  './assets/tiles/TREE 3 - NIGHT.png',
  './assets/tiles/FENCE 1 - NIGHT.png',
  './assets/tiles/FENCE 2 - NIGHT.png',
  './assets/tiles/PIT - NIGHT.png',
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
