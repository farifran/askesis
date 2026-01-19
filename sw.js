/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file sw.js
 * @description Service Worker: Proxy de Rede e Gerenciador de Cache (Offline Engine).
 */

try {
    importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch (e) {
    // Non-blocking failure for optional SDK
}

// CONSTANTS (Version Bump to Force Update)
const CACHE_NAME = 'habit-tracker-v19-sync-final';

// PERF: Static Asset List (Pre-allocated)
const CACHE_FILES = [
    '/',
    '/index.html',
    '/bundle.js',
    '/bundle.css',
    '/manifest.json',
    '/locales/pt.json',
    '/locales/en.json',
    '/locales/es.json',
    '/icons/icon-192.svg',
    '/icons/icon-512.svg',
    '/icons/icon-maskable-512.svg',
    '/icons/badge.svg'
];

// PERF: Hoisted Option Objects (Zero GC per request)
const RELOAD_OPTS = { cache: 'reload' };
const HTML_FALLBACK = '/index.html';
const MATCH_OPTS = { ignoreSearch: true };
const NETWORK_TIMEOUT_MS = 3000; // 3 Seconds max wait for Navigation

// HELPER: Timeout Promise
const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Network Timeout')), ms));

// HELPER: Update App Shell Cache (DRY)
const updateShellCache = (res) => {
    if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(HTML_FALLBACK, copy));
    }
    return res;
};

// --- INSTALL PHASE ---

self.addEventListener('install', (event) => {
    // FORCE UPDATE: Assume control immediately
    self.skipWaiting();
    
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return Promise.all(CACHE_FILES.map(url => 
                fetch(url, RELOAD_OPTS).then(res => {
                    if (!res.ok) throw new Error(`[SW] Failed to cache: ${url} (${res.status})`);
                    return cache.put(url, res);
                })
            ));
        })
    );
});

// --- ACTIVATE PHASE ---

self.addEventListener('activate', (event) => {
    // FORCE UPDATE: Claim clients immediately to serve new files
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            self.registration.navigationPreload ? self.registration.navigationPreload.enable() : Promise.resolve(),
            caches.keys().then(keys => Promise.all(
                keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())
            ))
        ])
    );
});

// --- FETCH PHASE (HOT PATH) ---

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url); 

    // 1. Strict API Bypass
    if (url.pathname.startsWith('/api/')) return;

    // 2. Navigation Strategy (App Shell)
    if (req.mode === 'navigate') {
        event.respondWith(
            (async () => {
                try {
                    const preloadResp = await event.preloadResponse;
                    if (preloadResp) return updateShellCache(preloadResp);

                    const networkResp = await Promise.race([
                        fetch(req),
                        timeout(NETWORK_TIMEOUT_MS)
                    ]);
                    return updateShellCache(networkResp);
                } catch (error) {
                    return caches.match(HTML_FALLBACK, MATCH_OPTS);
                }
            })()
        );
        return;
    }

    // 3. Asset Strategy (Stale-while-Revalidate)
    event.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;

            return fetch(req).then(networkResponse => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }

                const contentType = networkResponse.headers.get('content-type');
                const isAsset = req.destination && ['script', 'style', 'image'].includes(req.destination);
                
                if (isAsset && contentType && contentType.includes('text/html')) {
                    return networkResponse;
                }

                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(req, responseToCache).catch(() => {});
                });

                return networkResponse;
            }).catch(err => {
                return new Response(null, { status: 408, statusText: "Network Failure" });
            });
        })
    );
});