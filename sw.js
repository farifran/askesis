// sw.js
// Service worker unificado para OneSignal e funcionalidade offline do PWA.

// 1. Importa o service worker do OneSignal. Isso DEVE ser a primeira coisa no arquivo.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

// 2. Lógica de cache do PWA
const CACHE_NAME = 'habit-tracker-ai-cache-v4'; // Aumenta a versão para garantir a atualização
const URLS_TO_CACHE = [
    '/',
    'bundle.js',
    'bundle.css',
    'manifest.json',
    'icons/icon-192.svg',
    'icons/icon-512.svg',
    'icons/icon-maskable-512.svg',
    'locales/pt.json',
    'locales/en.json',
    'locales/es.json'
];

// Evento de instalação: pré-cache do App Shell
self.addEventListener('install', event => {
    self.skipWaiting(); 
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache and caching app shell');
                return cache.addAll(URLS_TO_CACHE);
            })
    );
});

// Evento de ativação: limpeza de caches antigos
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// Evento de fetch: Estratégia "Network first, then cache"
self.addEventListener('fetch', event => {
    // CRÍTICO: Ignora as requisições do OneSignal para evitar conflitos.
    if (event.request.url.includes('onesignal.com')) {
        return;
    }

    // Estratégia "Network-first": Tenta a rede primeiro, atualiza o cache e, se falhar, usa o cache.
    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                // Se a requisição de rede for bem-sucedida, atualiza o cache.
                // Verifica se a resposta é válida antes de armazenar em cache.
                if (networkResponse && networkResponse.status === 200) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME)
                        .then(cache => {
                            cache.put(event.request, responseToCache);
                        });
                }
                return networkResponse;
            })
            .catch(() => {
                // Se a rede falhar, tenta responder com o que está no cache.
                return caches.match(event.request);
            })
    );
});