// sw.js

// REATORAÇÃO: Importa o script do OneSignal diretamente do CDN.
// Isso simplifica a configuração, remove um arquivo local desnecessário (`onesignal-sw.js`)
// e garante que sempre usamos a versão mais recente do worker do OneSignal.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

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
    const url = new URL(event.request.url);

    // Ignora requisições que não são GET, a API de sincronização, e requisições para o OneSignal.
    // Isso garante que a lógica de cache não interfira com a comunicação do OneSignal.
    if (event.request.method !== 'GET' || url.pathname.includes('/api/sync') || url.hostname.endsWith('onesignal.com')) {
        return; // Deixa o navegador/outros listeners (do OneSignal) lidarem com a requisição.
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