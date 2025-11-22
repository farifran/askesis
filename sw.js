/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. Estratégia Cache-First implementada para navegação instantânea (0ms latência no boot). Fallback de rede robusto.
// OPTIMIZATION [2025-01-27]: Added ignoreSearch to cache match to support deep linking/UTM parameters offline.
// ROBUSTNESS [2025-01-28]: Wrapped importScripts in try-catch. Core PWA functionality must survive external script failures (e.g., AdBlockers or partial offline state).

try {
    importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch (e) {
    console.warn("Failed to load OneSignal SDK in Service Worker. Push notifications might not work.", e);
}

const CACHE_NAME = 'habit-tracker-v1';

// Arquivos essenciais para o App Shell
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

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        try {
            const cache = await caches.open(CACHE_NAME);
            console.log('Service Worker: Caching App Shell (Network Forced)');
            
            // FORÇA a atualização do cache via rede ('reload') para garantir que a nova versão seja baixada.
            // Isso é crucial para atualizar o App Shell em segundo plano.
            await Promise.all(CACHE_FILES.map(async (url) => {
                try {
                    const request = new Request(url, { cache: 'reload' });
                    const response = await fetch(request);
                    if (!response.ok) throw new Error(`Failed to fetch ${url}`);
                    return cache.put(request, response);
                } catch (err) {
                    console.error(`Failed to cache ${url}:`, err);
                }
            }));

            self.skipWaiting();
        } catch (error) {
            console.error('Service Worker: Install failed', error);
        }
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        await self.clients.claim();
        const cacheNames = await caches.keys();
        await Promise.all(
            cacheNames
                .filter(cacheName => cacheName !== CACHE_NAME)
                .map(cacheName => caches.delete(cacheName))
        );
    })());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Bypass para API (Network Only)
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // ESTRATÉGIA CACHE-FIRST PARA NAVEGAÇÃO (App Shell)
    // Garante carregamento instantâneo servindo o HTML do cache.
    if (event.request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                // 1. Prioridade total ao Cache (ignorando query string para deep links)
                const cachedResponse = await caches.match('/index.html', { ignoreSearch: true });
                if (cachedResponse) {
                    return cachedResponse;
                }
                
                // 2. Fallback de Rede (apenas se o cache estiver vazio/corrompido)
                return await fetch(event.request);
            } catch (error) {
                console.error('Navigation failed:', error);
                // 3. Última tentativa de cache (para resiliência offline extrema)
                return caches.match('/index.html', { ignoreSearch: true });
            }
        })());
        return;
    }

    // Estratégia Cache-First para Assets Estáticos
    event.respondWith((async () => {
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) {
            return cachedResponse;
        }
        try {
            return await fetch(event.request);
        } catch (error) {
            // Opcional: retornar placeholder se necessário
            // console.error('Asset fetch failed', error);
        }
    })());
});