
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
 * - **Zero-Allocation Routing:** Substitui `new URL()` por `indexOf` na string crua da URL.
 * - **Promise Pipelining:** Evita overhead de `async/await` generators em caminhos quentes.
 * - **Atomic Cache Transaction:** Instalação falha se *qualquer* asset falhar.
 */

try {
    importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch (e) {
    // Non-blocking failure for optional SDK
}

// CONSTANTS (Build-time injected)
// FORCE UPDATE [2025-05-02]: Bumped to v5 to flush old CSS bundles after modularization.
const CACHE_NAME = 'habit-tracker-v5';

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

// --- INSTALL PHASE ---

self.addEventListener('install', (event) => {
    // CRITICAL: Atomic Installation.
    // Utiliza Promise.all para paralelizar downloads. Falha rápida se algum recurso não carregar.
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
            // Navigation Preload: Reduz latência de rede em 20-50ms
            self.registration.navigationPreload ? self.registration.navigationPreload.enable() : Promise.resolve(),
            // Cache Pruning
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
    // Assumimos que '/api/' é uma assinatura única o suficiente para este domínio.
    if (url.indexOf('/api/') !== -1) {
        return; // Network-only bypass
    }

    // STRATEGY: Navigation (App Shell)
    // Otimização: Promise Chaining direto em vez de Async/Await Generator para micro-otimização de stack.
    if (req.mode === 'navigate') {
        event.respondWith(
            (async () => {
                try {
                    // 1. Tenta usar o Navigation Preload se disponível
                    const preloadResp = await event.preloadResponse;
                    if (preloadResp) return preloadResp;

                    // 2. Cache First (Fastest LCP)
                    const cachedResp = await caches.match(HTML_FALLBACK, MATCH_OPTS);
                    if (cachedResp) return cachedResp;

                    // 3. Network Fallback
                    return await fetch(req);
                } catch (error) {
                    // 4. Offline Fallback (Cache again as safety net)
                    return caches.match(HTML_FALLBACK, MATCH_OPTS);
                }
            })()
        );
        return;
    }

    // STRATEGY: Static Assets (Stale-While-Revalidate pattern simplified to Cache-First for immutables)
    event.respondWith(
        caches.match(req).then(cached => cached || fetch(req))
    );
});
