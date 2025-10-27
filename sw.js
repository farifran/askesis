// sw.js
// Service worker unificado para OneSignal e funcionalidade offline do PWA.

// 1. Importa o service worker do OneSignal. Isso DEVE ser a primeira coisa no arquivo.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

// 2. Lógica de cache do PWA
const CACHE_NAME = 'habit-tracker-ai-cache-v3'; // Versão incrementada para forçar a atualização do cache e do worker
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
    // Força o novo service worker a se tornar ativo imediatamente,
    // garantindo que as atualizações sejam aplicadas rapidamente.
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
    // Neste evento, nós apenas limpamos caches antigos.
    // A chamada para self.clients.claim() é omitida de propósito.
    // O script do OneSignal (importado acima) já lida com o 'claim',
    // e remover a nossa chamada evita uma condição de corrida que poderia
    // interferir na inicialização do listener de notificações.
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

// Evento de fetch: serve a partir do cache ou da rede
self.addEventListener('fetch', event => {
    // CRÍTICO: Ignora as requisições do OneSignal para evitar conflitos.
    // Deixa o service worker do OneSignal lidar com elas.
    if (event.request.url.includes('onesignal.com')) {
        return;
    }

    // Estratégia "Cache-first, caindo para a rede" para todas as outras requisições.
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Se encontrarmos no cache, retorna a resposta do cache.
                if (response) {
                    return response;
                }

                // Se não, busca na rede.
                return fetch(event.request).then(
                    networkResponse => {
                        // Se a busca na rede for bem-sucedida, clona e armazena no cache para uso futuro.
                        if (networkResponse && networkResponse.status === 200) {
                            const responseToCache = networkResponse.clone();
                            caches.open(CACHE_NAME)
                                .then(cache => {
                                    cache.put(event.request, responseToCache);
                                });
                        }
                        return networkResponse;
                    }
                );
            })
            .catch(error => {
                 console.error('Fetch failed; returning offline page instead.', error);
                 // Opcional: Retornar uma página offline genérica se a busca falhar totalmente.
                 // return caches.match('/offline.html');
            })
    );
});