const CACHE_NAME = 'aegistrack-v1';
const ASSETS = [
  '/pages/device-registration.html',
  '/css/device-registration.css',
  '/js/device-registration.js',
  '/favicon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Respond with cache first, then network fallback
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(e.request);
    }).catch(() => {
      // Fallback for document request when offline
      if (e.request.mode === 'navigate') {
        return caches.match('/pages/device-registration.html');
      }
    })
  );
});
