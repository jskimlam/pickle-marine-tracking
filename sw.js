self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 모든 요청을 캐시 없이 항상 네트워크에서 최신으로 가져옴
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
