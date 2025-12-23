
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file sw.js
 * @description Orquestrador de Persistência em Cache e Estratégia Offline-First.
 * 
 * [WORKER CONTEXT]: Sem acesso ao DOM. Execução em thread isolada.
 * Este módulo gerencia o ciclo de vida da aplicação fora do ciclo de vida da aba do navegador.
 * 
 * ARQUITETURA DE RESILIÊNCIA:
 * 1. **App Shell Caching:** Garante que os recursos mínimos para renderizar a UI (CRP) 
 *    estejam disponíveis instantaneamente, independentemente da latência da rede.
 * 2. **Atomic Installation:** O Service Worker falha propositalmente em instalar se UM único 
 *    recurso crítico falhar, prevenindo estados de cache parciais ou corrompidos.
 * 3. **Navigation Pre-caching:** Redireciona requisições de navegação para o App Shell, 
 *    permitindo Deep Linking em modo offline.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - OneSignal SDK: Orquestração de Push notifications.
 * - `index.html`: Base para o App Shell.
 * - `sync-worker.js`: Engine de sincronização off-thread.
 * 
 * O "PORQUÊ":
 * O uso de Service Workers é o que transforma o site em um PWA. A estratégia "Cache-First" 
 * aqui implementada foca em TTI (Time To Interactive) de 0ms para usuários recorrentes.
 */

try {
    // [WORKER CONTEXT]: Importação de scripts externos permitida apenas via importScripts.
    importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch (e) {
    console.warn("Failed to load OneSignal SDK in Service Worker. Push notifications might not work.", e);
}

// DO NOT REFACTOR: O nome do cache é injetado/alterado via Regex no build.js para Cache Busting automático.
const CACHE_NAME = 'habit-tracker-v2';

// ARQUITETURA: Lista exaustiva dos recursos necessários para o First Contentful Paint (FCP) em modo Offline.
const CACHE_FILES = [
    '/',
    '/index.html',
    '/bundle.js',
    '/bundle.css',
    '/sync-worker.js', // WORKER [2025-02-28]: Adicionado ao cache para suporte offline
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
            
            // PERFORMANCE: Paralelismo massivo via Promise.all para saturar a banda disponível e reduzir tempo de 'installing'.
            // DO NOT REFACTOR: O uso de { cache: 'reload' } é vital para ignorar caches HTTP intermediários e garantir integridade.
            await Promise.all(CACHE_FILES.map(async (url) => {
                try {
                    const request = new Request(url, { cache: 'reload' });
                    const response = await fetch(request);
                    if (!response.ok) throw new Error(`Status ${response.status}`);
                    return cache.put(request, response);
                } catch (err) {
                    // [TODO: REVIEW] Se um arquivo secundário (ícone) falhar, devemos mesmo abortar toda a instalação?
                    console.error(`Failed to cache ${url}:`, err);
                    throw err; 
                }
            }));

            // DO NOT REFACTOR: skipWaiting() força o novo SW a assumir o controle sem esperar as abas antigas fecharem.
            // Essencial para atualizações críticas de esquema de dados.
            self.skipWaiting();
        } catch (error) {
            console.error('Service Worker: Install failed. Application may be unstable offline.', error);
            // TRAVA LÓGICA: Lança erro para abortar instalação. Garante que versões "zumbis" ou incompletas não sejam ativadas.
            throw error;
        }
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // PERFORMANCE: Garante que o Service Worker controle a página imediatamente após a ativação, sem recarregar.
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

    // [TRAVA LÓGICA]: Requisições de API nunca devem ser cacheadas pelo Service Worker para evitar inconsistência de sincronização.
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // ESTRATÉGIA CACHE-FIRST PARA NAVEGAÇÃO (App Shell Pattern)
    // DO NOT REFACTOR: Redirecionar 'navigate' para index.html permite que o roteamento ocorra no client-side (JS).
    if (event.request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                // PERFORMANCE: Prioridade total ao Cache para carregamento instantâneo.
                const cachedResponse = await caches.match('/index.html', { ignoreSearch: true });
                if (cachedResponse) {
                    return cachedResponse;
                }
                
                // Fallback de Rede se o cache falhar (raro).
                return await fetch(event.request);
            } catch (error) {
                console.error('Navigation failed:', error);
                // Resiliência extrema: Tenta retornar o index.html a qualquer custo.
                return caches.match('/index.html', { ignoreSearch: true });
            }
        })());
        return;
    }

    // ESTRATÉGIA CACHE-FIRST PARA ASSETS ESTÁTICOS
    event.respondWith((async () => {
        // PERFORMANCE: Reduz latência eliminando round-trip de rede para imagens, estilos e scripts.
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) {
            return cachedResponse;
        }
        try {
            return await fetch(event.request);
        } catch (error) {
            // [TODO: REVIEW] Considerar retornar um SVG placeholder padrão para ícones de hábitos não encontrados.
        }
    })());
});
