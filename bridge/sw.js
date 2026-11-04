// Caches the storage bridge page so Roster Tools presets work offline after the first load.
'use strict';
const CACHE = 'rostertools-bridge-v1';
const PAGE = './bridge.html';

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.add(PAGE)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
        .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
        .then(() => self.clients.claim()));
});

// Network first, so updates arrive when online; the cached copy covers offline starts.
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') { return; }
    event.respondWith(fetch(event.request)
        .then((response) => {
            if (response && response.ok) {
                const copy = response.clone();
                caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return response;
        })
        .catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match(PAGE))));
});
