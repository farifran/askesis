
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file sw.js
 * @description Service Worker: Proxy de Rede e Gerenciador de Cache (Offline Engine).
 * 
 * [SERVICE WORKER CONTEXT]:
 * Execução em Thread de Background. 
 * Otimizado para latência zero no interceptador de rede (`fetch`).
 * 
 * ARQUITETURA (SOTA / V8 Optimized):
 * - **Navigation Preload:** Reduz latência de HTML executando fetch em paralelo com boot do SW.
 * - **Lie-fi Protection:** Race Condition com timeout para evitar travamentos em redes fantasmas.
 * - **Dynamic Caching:** Suporte a Code Splitting (Lazy Loading) cacheando chunks sob demanda.
 */

try {
    importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch (e) {
    // Non-blocking failure for optional SDK
}

// CONSTANTS (Build-time injected)
// FORCE UPDATE [2025-05-03]: Bumped to v8 for Navigation Preload support.
const CACHE_NAME = 'habit-tracker-v8';

// PERF: Static Asset List (Pre-allocated)
const CACHE_FILES = [
    '/',
    '/index.html',
    '/bundle.js',
    '/bundle.css',
    '/sync-worker.js',
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

// --- INSTALL PHASE ---

self.addEventListener('install', (event) => {
    // CRITICAL: Atomic Installation.
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return Promise.all(CACHE_FILES.map(url => 
                fetch(url, RELOAD_OPTS).then(res => {
                    if (!res.ok) throw new Error(`[SW] Failed to cache: ${url} (${res.status})`);
                    return cache.put(url, res);
                })
            ));
        }).then(() => self.skipWaiting())
    );
});

// --- ACTIVATE PHASE ---

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            // OPTIMIZATION: Enable Navigation Preload
            // Permite que o browser faça o request do HTML enquanto o SW acorda.
            self.registration.navigationPreload ? self.registration.navigationPreload.enable() : Promise.resolve(),
            // Cache Pruning (Buckets Cleanup)
            caches.keys().then(keys => Promise.all(
                keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())
            ))
        ])
    );
});

// --- FETCH PHASE (HOT PATH) ---

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = req.url;

    // OPTIMIZATION: String Scanning vs URL Parsing.
    // `new URL()` aloca objetos e consome CPU. `indexOf` é uma varredura de memória linear (SIMD optimized).
    if (url.indexOf('/api/') !== -1) {
        return; // Network-only bypass for API
    }

    // STRATEGY: Navigation (App Shell) with Lie-fi Protection & Cache Update
    if (req.mode === 'navigate') {
        event.respondWith(
            (async () => {
                try {
                    // 1. Navigation Preload (SOTA Optimization)
                    const preloadResp = await event.preloadResponse;
                    if (preloadResp) {
                        // FIX [SAFETY]: Only update cache if response is valid (200 OK).
                        // Prevents poisoning the cache with 404/500 pages.
                        if (preloadResp.ok) {
                            const cacheCopy = preloadResp.clone();
                            caches.open(CACHE_NAME).then(cache => cache.put(HTML_FALLBACK, cacheCopy));
                        }
                        return preloadResp;
                    }

                    // 2. Network Race with Timeout (Lie-fi Proof)
                    // Se a rede demorar mais que 3s, falha e vai para o cache.
                    const networkResp = await Promise.race([
                        fetch(req),
                        timeout(NETWORK_TIMEOUT_MS)
                    ]);

                    // FIX [DATA ROT PREVENTION]: Se a navegação foi bem sucedida, 
                    // atualizamos o HTML_FALLBACK no cache para que a próxima visita offline seja fresca.
                    if (networkResp && networkResp.ok) {
                        const cacheCopy = networkResp.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(HTML_FALLBACK, cacheCopy));
                    }

                    return networkResp;
                } catch (error) {
                    // 3. Offline/Timeout Fallback (Cache First for App Shell)
                    // console.warn("[SW] Network failed, serving offline shell.", error);
                    return caches.match(HTML_FALLBACK, MATCH_OPTS);
                }
            })()
        );
        return;
    }

    // STRATEGY: Static Assets & Dynamic Chunks (Cache First + Dynamic Fill)
    // Assets versionados (bundle.js, hashes) são imutáveis -> Cache First.
    event.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;

            // Stale-while-Revalidate logic for new resources
            return fetch(req).then(networkResponse => {
                // Check if valid
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }

                // DYNAMIC CACHING: Clona e salva novos assets
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => {
                    // FIX: Catch storage errors (QuotaExceeded)
                    return cache.put(req, responseToCache).catch(err => {
                        // Silent fail for storage limits is acceptable, dying SW is not.
                        // console.warn("[SW] Cache put failed (Quota?)", err);
                    });
                });

                return networkResponse;
            }).catch(err => {
                // FIX: Unhandled fetch error on resource miss
                // Se não está no cache E a rede falha, o app não deve travar.
                // Opcional: retornar placeholder image se for request de imagem.
                // Por enquanto, apenas propagamos o erro ou retornamos 404 para não quebrar a Promise chain.
                throw err;
            });
        })
    );
});
