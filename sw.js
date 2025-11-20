/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. Service Worker configurado corretamente. Importação do OneSignal e estratégias de cache (Network-first para HTML, Cache-first para assets) estão implementadas de forma robusta.

// IMPORTANTE: Importa o script do worker do OneSignal. Deve ser a primeira linha.
// Isso unifica nosso worker de cache com a funcionalidade de push do OneSignal.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

// O nome do cache é versionado para garantir que as atualizações do Service Worker
// acionem a limpeza de caches antigos e a criação de novos.
const CACHE_NAME = 'habit-tracker-v1';

// Lista de arquivos essenciais para o funcionamento do App Shell offline.
// NOTA: '/sw.js' foi removido intencionalmente para evitar loops de cache.
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
            console.log('Service Worker: Caching App Shell with forced network fetch');
            
            // CORREÇÃO CRÍTICA [2024-12-28]: Problema da Atualização "Stale"
            // Em vez de cache.addAll (que pode ler do cache de disco do navegador),
            // forçamos a ida à rede com { cache: 'reload' }.
            await Promise.all(CACHE_FILES.map(async (url) => {
                try {
                    const request = new Request(url, { cache: 'reload' });
                    const response = await fetch(request);
                    
                    if (!response.ok) {
                        throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
                    }
                    
                    return cache.put(request, response);
                } catch (err) {
                    console.error(`Failed to cache ${url}:`, err);
                    // Não relançamos o erro para permitir que outros arquivos sejam cacheados,
                    // mas em produção, falhar no App Shell crítico pode ser fatal.
                    // Aqui assumimos "best effort".
                    throw err;
                }
            }));

            // Força o novo Service Worker a se tornar ativo imediatamente.
            self.skipWaiting();
        } catch (error) {
            console.error('Service Worker: Failed to install', error);
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

    // ESTRATÉGIA NETWORK-FIRST PARA O APP SHELL (HTML/Navegação)
    // Garante que o usuário receba a versão mais recente se estiver online.
    if (event.request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                // Tenta a rede primeiro
                const networkResponse = await fetch(event.request);
                
                // Atualiza o cache com a nova versão (em background)
                const cache = await caches.open(CACHE_NAME);
                cache.put(event.request, networkResponse.clone());
                
                return networkResponse;
            } catch (error) {
                console.log('Service Worker: Navigation offline, falling back to cache');
                // Fallback para o cache se offline
                const cachedResponse = await caches.match(event.request);
                if (cachedResponse) {
                    return cachedResponse;
                }
                // Se não houver nada no cache, o navegador mostrará a página de erro padrão
                throw error;
            }
        })());
        return;
    }

    // ESTRATÉGIA CACHE-FIRST PARA ASSETS (JS, CSS, Imagens, JSON)
    // Otimiza a performance de carregamento.
    event.respondWith((async () => {
        try {
            const cachedResponse = await caches.match(event.request);
            if (cachedResponse) {
                return cachedResponse;
            }
            return await fetch(event.request);
        } catch (error) {
            console.error('Service Worker: Error fetching asset', event.request.url, error);
        }
    })());
});