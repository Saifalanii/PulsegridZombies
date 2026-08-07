// Service worker: cache-first for the app shell, so Nightfall Village is fully playable
// offline the moment it's been opened once. All the sound is still synthesised at
// runtime; the art is not, so the shell now has to carry real image assets.
//
// Bump CACHE when shipping: the old cache is deleted on activate.

// v2: the shell gained player_hero_alt.png and player_hero_axe.png. Without the bump an
// existing install keeps its v1 cache, never re-runs addAll, and the first offline launch
// after the update draws a survivor holding nothing.
//
// v3: the city sheet gained the sword swings and was itself redrawn twice. That last part
// is the one that actually needs the bump — the *filename* did not change, so a cache-
// first install would keep serving the superseded sheet indefinitely, and the new road
// markings would never appear no matter how many times the player reloaded.
//
// v4: the dead-code sweep dropped fifteen assets/tiles entries the game no longer loads.
// Shrinking the list still needs the bump — an existing v3 install keeps its old cache
// object, so those files would sit in storage forever with nothing to evict them.
//
// v5: two more zombie sheets for the early crowd.
//
// v6: city sheet redrawn again (clean roads, two new shopfronts), plus the drop chest.
// The sheet's filename does not change, so without this bump a cache-first install keeps
// serving the old roads forever.
// v7: the world is now loaded from an authored map (assets/maps/), not generated.
// v8: updated map with hand-painted collision layers.
// v9: buildings solid whether painted or not (collision = painted UNION structure tiles).
const CACHE = 'nightfall-v9';

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
  './assets/characters/zombie_fresh.png',
  './assets/characters/zombie_charred.png',

  // --- world art ---
  //
  // One file. The ground, the buildings, the wrecks, the trees and the street furniture
  // are all rects on this sheet — see CITY and GROUND_TILES in js/game/world.js, whose
  // `shellAssets()` now returns exactly this single entry.
  //
  // Every `assets/tiles/*` line that used to sit here is gone. Those were the generated
  // street set, and nothing has loaded one since the ground became the city sheet plus a
  // flat tarmac fill: fifteen files fetched on install, on an atomic addAll, for a code
  // path with no readers. tools/make-street-tiles.mjs still emits them.
  './assets/city/simple-city-32.png',
  './assets/city/chest.png',
  // The authored map and its tileset — the world is loaded from these now.
  './assets/maps/town-tiles.png',
  './assets/maps/town.json',

  // The sword swings are small (170KB each) and they are combat feedback, so they do
  // belong in the atomic install — a silent weapon offline is a broken weapon.
  './assets/audio/sword-1a.wav',
  './assets/audio/sword-1b.wav',

  // --- music ---
  //
  // Deliberately NOT in this list, despite being real assets the game loads:
  // assets/audio/menu-theme.wav and assets/audio/run-theme.ogg are 6MB together, nearly
  // triple the rest of the shell. addAll is atomic, so folding them in means a flaky
  // mobile connection fails the *entire* install and the game gets no offline cache at
  // all — trading a working offline game for background music is the wrong way round.
  // They are picked up by the runtime cache in the fetch handler below the first time
  // they play, so offline works from the second launch onward.
  //
  // If they are ever encoded down (the .wav in particular is uncompressed 48kHz stereo
  // and would lose ~90% of its size as .ogg), move them up into this list.
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
