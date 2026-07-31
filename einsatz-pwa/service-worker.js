const CACHE_NAME = 'kataster-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL).catch((err) => console.warn('Konnte nicht alle Dateien cachen:', err))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Kartenkacheln und Punkt-Daten: erst Cache zeigen, im Hintergrund aktualisieren
  if (url.pathname.startsWith('/tiles/') || url.pathname.startsWith('/api/points') || url.pathname.startsWith('/api/categories')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        const network = fetch(event.request)
          .then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Anmeldung und schreibende Aufrufe: nie aus dem Cache beantworten
  if (event.request.method !== 'GET') return;

  // App-Hülle: Cache zuerst, Netzwerk als Rückfallebene
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
