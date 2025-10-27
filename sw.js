// sw.js

// Importa o script do OneSignal para que as notificações push continuem funcionando.
// Isso é crucial.
importScripts('onesignal-sw.js');

const CACHE_NAME = 'habit-tracker-cache-v1';
const assetsToCache = [
    '/',
    '/index.html',
    '/bundle.js',
    '/bundle.css',
    '/locales/pt.json',
    '/locales/en.json',
    '/locales/es.json',
    '/icons/icon-192.svg',
    '/icons/icon-512.svg',
    '/icons/icon-maskable-512.svg'
];

// Evento de instalação: abre o cache e armazena os assets principais do app.
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache and caching assets');
                return cache.addAll(assetsToCache);
            })
    );
});

// Evento de ativação: limpa caches antigos para garantir que a versão mais recente seja usada.
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

// Evento de fetch: intercepta as requisições de rede.
// Implementa uma estratégia "cache-first": tenta servir do cache primeiro,
// e se não encontrar, busca na rede e atualiza o cache.
self.addEventListener('fetch', event => {
    // Ignora requisições que não são GET e a API de sincronização para evitar problemas.
    if (event.request.method !== 'GET' || event.request.url.includes('/api/sync')) {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Se a resposta estiver no cache, retorna ela.
                if (response) {
                    return response;
                }

                // Se não, busca na rede.
                return fetch(event.request).then(
                    networkResponse => {
                        // Se a busca na rede for bem-sucedida, clona a resposta e a armazena no cache.
                        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                            return networkResponse;
                        }

                        const responseToCache = networkResponse.clone();

                        caches.open(CACHE_NAME)
                            .then(cache => {
                                cache.put(event.request, responseToCache);
                            });

                        return networkResponse;
                    }
                );
            })
    );
});
