const CACHE_NAME = 'convoyos-offline-v0.0.1';
const OFFLINE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './css/variables.css',
    './css/reset.css',
    './css/main.css',
    './js/qr.js',
    './js/storage.js',
    './js/dragdrop.js',
    './js/discovery.js',
    './js/transfer.js',
    './js/app.js',
    './assets/favicon.svg',
    './assets/favicon.png',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './assets/fonts/inter-v20-latin-regular.woff2',
    './assets/fonts/inter-v20-latin-500.woff2',
    './assets/fonts/inter-v20-latin-600.woff2',
    './assets/fonts/jetbrains-mono-v24-latin-regular.woff2',
    './assets/fonts/jetbrains-mono-v24-latin-500.woff2',
    './assets/fonts/jetbrains-mono-v24-latin-700.woff2'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) return caches.delete(key);
                })
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        caches.match(event.request).then((cached) => {
            return (
                cached ||
                fetch(event.request).catch(() => caches.match('./index.html'))
            );
        })
    );
});