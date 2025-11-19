/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído.
// O que foi feito: A análise e otimização do Service Worker foram finalizadas. O ciclo de vida foi aprimorado para atualizações mais rápidas, adicionando `self.skipWaiting()` e `clients.claim()`. Além disso, todos os manipuladores de eventos (`install`, `activate`, `fetch`) foram refatorados para usar a sintaxe `async/await`, melhorando a legibilidade e a manutenibilidade do código.
// O que falta: Nenhuma análise futura é necessária. O módulo é considerado finalizado e robusto.

// IMPORTANTE: Importa o script do worker do OneSignal. Deve ser a primeira linha.
// Isso unifica nosso worker de cache com a funcionalidade de push do OneSignal.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

// O nome do cache é versionado para garantir que as atualizações do Service Worker
// acionem a limpeza de caches antigos e a criação de novos.
const CACHE_NAME = 'habit-tracker-v1';

// Lista de arquivos essenciais para o funcionamento do App Shell offline.
// CORREÇÃO SPA: Caminhos absolutos (raiz) são usados para garantir que o cache funcione
// em conjunto com a tag <base href="/"> e o registro absoluto do SW, prevenindo ambiguidades.
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
    event.waitUntil((async () => {
        try {
            const cache = await caches.open(CACHE_NAME);
            console.log('Service Worker: Caching App Shell');
            await cache.addAll(CACHE_FILES);
            // Força o novo Service Worker a se tornar ativo imediatamente.
            self.skipWaiting();
        } catch (error) {
            console.error('Service Worker: Failed to cache App Shell', error);
        }
    })());
});

// Evento de ativação: acionado quando o Service Worker é ativado.
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Permite que o Service Worker ativo tome controle imediato das páginas em seu escopo.
        await self.clients.claim();
        
        const cacheNames = await caches.keys();
        await Promise.all(
            cacheNames
                .filter(cacheName => cacheName !== CACHE_NAME)
                .map(cacheName => {
                    console.log('Service Worker: Clearing old cache', cacheName);
                    return caches.delete(cacheName);
                })
        );
    })());
});

// Evento de fetch: acionado para cada requisição feita pela página.
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Ignora o cache para requisições de API, indo direto para a rede.
    // O navegador lida com a requisição se não chamarmos event.respondWith.
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // Para todos os outros assets, usa a estratégia cache-first.
    event.respondWith((async () => {
        try {
            const cachedResponse = await caches.match(event.request);
            if (cachedResponse) {
                return cachedResponse;
            }
            return await fetch(event.request);
        } catch (error) {
            console.error('Service Worker: Error fetching asset', event.request.url, error);
            // Em caso de falha de rede para um asset não cacheado, o navegador
            // lidará com o erro, o que é um comportamento aceitável para assets.
            // Para uma experiência offline completa, poderíamos retornar um asset de fallback aqui.
        }
    })());
});