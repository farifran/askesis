/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

// IMPORTANTE: Importa o script do worker do OneSignal. Deve ser a primeira linha.
// Isso unifica nosso worker de cache com a funcionalidade de push do OneSignal.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

// O nome do cache é versionado para garantir que as atualizações do Service Worker
// acionem a limpeza de caches antigos e a criação de novos.
const CACHE_NAME = 'habit-tracker-v1';

// Lista de arquivos essenciais para o funcionamento do App Shell offline.
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

// Evento de instalação: acionado quando o Service Worker é instalado pela primeira vez.
self.addEventListener('install', (event) => {
    // waitUntil() garante que o Service Worker não será considerado instalado
    // até que o código dentro dele seja executado com sucesso.
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Service Worker: Caching App Shell');
                // Adiciona todos os arquivos essenciais ao cache.
                return cache.addAll(CACHE_FILES);
            })
            .catch(error => {
                console.error('Service Worker: Failed to cache App Shell', error);
            })
    );
});

// Evento de ativação: acionado quando o Service Worker é ativado.
// É um bom lugar para limpar caches antigos de versões anteriores do Service Worker.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    // Se o nome do cache não for o atual, ele é excluído.
                    if (cacheName !== CACHE_NAME) {
                        console.log('Service Worker: Clearing old cache', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// Evento de fetch: acionado para cada requisição feita pela página.
// Isso permite interceptar a requisição e responder com dados do cache.
self.addEventListener('fetch', (event) => {
    // respondWith() intercepta a requisição e nos permite fornecer nossa própria resposta.
    event.respondWith(
        // Tenta encontrar uma resposta para a requisição no cache.
        caches.match(event.request)
            .then((response) => {
                // Se uma resposta for encontrada no cache, a retorna.
                if (response) {
                    return response;
                }
                // Se não for encontrada no cache, faz a requisição à rede.
                return fetch(event.request);
            })
            .catch(error => {
                console.error('Service Worker: Error fetching data', error);
            })
    );
});