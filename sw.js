/**
 * @license
 * SPDX-License-Identifier: MIT
*/

/**
 * @file sw.js
 * @description Service Worker: Proxy de Rede e Gerenciador de Cache (Offline Engine).
 *
 * Implementação zero-deps (sem Workbox). Estratégias:
 *  - /api/*        → rede direta (nunca cacheia dados do usuário)
 *  - navegação     → NetworkFirst com timeout e fallback para o shell cacheado
 *  - demais assets → CacheFirst com preenchimento em runtime
 *
 * CACHE VERSIONING: BUILD_HASH é injetado pelo build.js a partir do content hash
 * do bundle. Cada deploy gera um CACHE_NAME novo; o handler de `activate` apaga
 * todos os caches antigos, eliminando acúmulo de bundles hasheados obsoletos.
 */

// PUSH: entregue pelo worker dedicado da OneSignal (OneSignalSDKWorker.js,
// escopo '/onesignal/', registrado pelo SDK na init). Este SW cuida apenas de
// offline, cache e do notification-click do badge local.

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

// --- BADGE DE PENDÊNCIAS (Android) ---

/**
 * A página pede a notificação de badge por postMessage em vez de chamar
 * showNotification diretamente. Motivo: o pedido acontece no instante em que o
 * app vai para segundo plano, quando o Android congela/mata a página — um
 * `await` na página pode nunca completar. O SW não é congelado junto e o
 * `waitUntil` garante a conclusão do trabalho.
 */
const PENDING_TAG = 'askesis-pending-habits';

function clearPendingBadge() {
    return self.registration.getNotifications({ tag: PENDING_TAG })
        .then(list => list.forEach(n => n.close()));
}

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'SHOW_PENDING_BADGE') {
        event.waitUntil(
            self.registration.showNotification(String(data.title || ''), {
                tag: PENDING_TAG,
                body: String(data.body || ''),
                icon: 'icons/icon-192.svg',
                badge: 'icons/badge.svg',
                silent: true,
                renotify: false,
                data: { url: '/' }
            }).catch(() => {})
        );
    } else if (data.type === 'CLEAR_PENDING_BADGE') {
        event.waitUntil(clearPendingBadge().catch(() => {}));
    }
});

// --- NOTIFICATION CLICK (badge de pendências no Android) ---

/**
 * Toque na notificação de hábitos pendentes: foca uma aba existente do app ou
 * abre uma nova. Restrito à nossa tag para não interferir nos handlers do
 * OneSignal (múltiplos listeners de notificationclick coexistem).
 */
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
