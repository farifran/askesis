/**
 * @license
 * SPDX-License-Identifier: MIT
*/

/**
 * @file sw.js
 * @description Service Worker único do Askesis: offline/cache + push OneSignal.
 *
 * Implementação zero-deps (sem Workbox). Estratégias:
 *  - /api/*        → rede direta (nunca cacheia dados do usuário)
 *  - navegação     → NetworkFirst com timeout e fallback para o shell cacheado
 *  - demais assets → CacheFirst com preenchimento em runtime
 *  - push          → OneSignal (importScripts abaixo)
 *
 * CACHE VERSIONING: BUILD_HASH é injetado pelo build.js a partir do content hash
 * do bundle. Cada deploy gera um CACHE_NAME novo; o handler de `activate` apaga
 * todos os caches antigos, eliminando acúmulo de bundles hasheados obsoletos.
 *
 * PUSH / CHROME: um único SW no escopo `/`. Dois workers (sw.js + OneSignalSDKWorker
 * em escopos diferentes ou competindo por `/`) quebram a subscription FCM no
 * Chromium — o app re-registrava sw.js no boot e invalidava o worker de push.
 * Safari/APNs tolerava; Chrome Android não. Ver OneSignal "Combining multiple
 * service workers".
 */

// OneSignal push handlers (push / notificationclick / notificationclose).
// Deve permanecer no topo do arquivo (importScripts síncrono).
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

const HTML_FALLBACK = '/index.html';
const NETWORK_TIMEOUT_MS = 3000;

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Network Timeout')), ms));

// Substituído pelo build de produção com o content hash do bundle.
const BUILD_HASH = '__BUILD_HASH__';
const CACHE_NAME = 'askesis-' + BUILD_HASH;
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
    '/icons/badge.svg',
    // Chunks de code-splitting injetados pelo build de produção (vazio em dev).
    ...[/*__EXTRA_PRECACHE__*/]
];

const RELOAD_OPTS = { cache: 'reload' };
const MATCH_OPTS = { ignoreSearch: true };

const updateShellCache = (res) => {
    if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(HTML_FALLBACK, copy));
    }
    return res;
};

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return Promise.all(CACHE_FILES.map(url =>
                fetch(url, RELOAD_OPTS).then(res => {
                    if (!res.ok) throw new Error(`[SW] Failed to cache: ${url}`);
                    return cache.put(url, res);
                })
            ));
        })
    );
});

self.addEventListener('activate', (event) => {
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

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) return;

    if (req.mode === 'navigate') {
        event.respondWith(
            (async () => {
                try {
                    const preloadResp = await event.preloadResponse;
                    if (preloadResp) return updateShellCache(preloadResp);
                    const networkResp = await Promise.race([fetch(req), timeout(NETWORK_TIMEOUT_MS)]);
                    return updateShellCache(networkResp);
                } catch (error) {
                    return caches.match(HTML_FALLBACK, MATCH_OPTS);
                }
            })()
        );
        return;
    }

    event.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;
            return fetch(req).then(networkResponse => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') return networkResponse;
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(req, responseToCache));
                return networkResponse;
            }).catch(() => new Response(null, { status: 408 }));
        })
    );
});

// --- NOTIFICATION CLICK (badge local de pendências no Android) ---
// Restrito à tag do app: o OneSignal registra o próprio notificationclick no
// mesmo SW; listeners coexistem e cada um ignora o que não é seu.
self.addEventListener('notificationclick', (event) => {
    if (event.notification.tag !== 'askesis-pending-habits') return;
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            const existing = clients.find(c => 'focus' in c);
            if (existing) return existing.focus();
            return self.clients.openWindow('/');
        })
    );
});

// --- BACKGROUND SYNC ---

/**
 * BACKGROUND SYNC EVENT:
 * Disparado pelo navegador quando a conectividade é restabelecida para tags registradas.
 */
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-cloud-pending') {
        console.log('[SW] Conectividade recuperada. Solicitando sincronização às abas ativas...');
        event.waitUntil(
            self.clients.matchAll({ type: 'window' }).then(clients => {
                // Notifica todas as abas abertas para que tentem sincronizar agora
                clients.forEach(client => {
                    client.postMessage({ type: 'REQUEST_SYNC' });
                });
            })
        );
    }
});
