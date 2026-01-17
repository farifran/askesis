
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file index.tsx
 * @description Bootstrapper e Orquestrador de Ciclo de Vida da Aplicação.
 * 
 * [MAIN THREAD CONTEXT]:
 * Este é o ponto de entrada (Entry Point). Ele roda na thread principal e bloqueia o
 * "First Contentful Paint" (FCP) lógico da aplicação (hidratação de dados).
 * 
 * ARQUITETURA (Race-to-Idle):
 * - Prioridade Absoluta: Carregar dados, resolver conflitos de versão e pintar a UI o mais rápido possível.
 * - Lazy Loading: Serviços não críticos (Analytics, Workers) são inicializados apenas após a UI estar interativa.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `services/persistence.ts`: Camada de IO assíncrono (IndexedDB) para inicialização escalável.
 * - `services/cloud.ts`: Camada de IO assíncrono para consistência de dados.
 * - `services/dataMerge.ts`: Algoritmo de resolução de conflitos (CRDT-lite).
 * 
 * DECISÕES TÉCNICAS:
 * 1. Inicialização Bifurcada: Tenta carregar do disco (rápido) e da nuvem (lento) em paralelo, 
 *    aplicando uma estratégia de "Smart Merge" se ambos existirem.
 * 2. Analytics Condicional: Injeção de scripts de rastreamento apenas em produção para não poluir
 *    o console de desenvolvimento nem afetar métricas de performance locais.
 */

// CSS MODULARIZATION [2025-05-02]:
// Styles split by domain for maintainability. ESBuild bundles these into a single bundle.css.
import './css/variables.css';
import './css/base.css';
import './css/layout.css';
import './css/header.css';
import './css/components.css';
import './css/calendar.css';
import './css/habits.css';
import './css/charts.css';
import './css/forms.css';
import './css/modals.css';

import { state, AppState } from './state';
import { loadState, persistStateLocally, registerSyncHandler } from './services/persistence';
import { renderApp, initI18n } from './render';
import { setupEventListeners } from './listeners';
// I18N moved to render.ts to fix circular dependency
import { createDefaultHabit, handleDayTransition, performArchivalCheck } from './habitActions';
import { initSync } from './listeners/sync';
import { fetchStateFromCloud, syncStateWithCloud } from './services/cloud';
import { hasLocalSyncKey, initAuth } from './services/api';
import { updateAppBadge } from './services/badge';
import { mergeStates } from './services/dataMerge';
import { setupMidnightLoop } from './utils';

// TYPE SAFETY: Extensão global para APIs de navegador e Watchdog
declare global {
    interface Window {
        bootWatchdog?: number;
        showFatalError?: (msg: string, isWatchdog?: boolean) => void;
        // Polyfill type definition for requestIdleCallback in strict environments
        requestIdleCallback: (
            callback: (deadline: IdleDeadline) => void,
            options?: { timeout?: number }
        ) => number;
        cancelIdleCallback: (handle: number) => void;
        // SNIPER OPTIMIZATION: Scheduler API Type Definition
        scheduler?: {
            postTask(callback: () => any, options?: { priority?: 'user-blocking' | 'user-visible' | 'background', delay?: number }): Promise<any>;
        };
        // CSS Typed OM Polyfill Types
        CSS: any;
        CSSTranslate: any;
    }
    
    interface IdleDeadline {
        timeRemaining: () => number;
        readonly didTimeout: boolean;
    }

    // SNIPER OPTIMIZATION: CSS Typed OM Interfaces
    interface Element {
        attributeStyleMap?: StylePropertyMap;
    }
    interface StylePropertyMap {
        set(property: string, value: any): void;
        clear(): void;
    }
    // Augment CSS interface to support CSS.px
    interface CSS {
        px(value: number): any;
    }
}

// --- SERVICE WORKER REGISTRATION ---
// PWA CORE: Garante capacidade Offline-First.
const registerServiceWorker = () => {
    // PERFORMANCE: Verifica suporte antes de tentar registrar para evitar erros em ambientes antigos.
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
        const doRegister = async () => {
            try {
                // Caminho relativo ./sw.js para maior compatibilidade
                const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
                console.log('ServiceWorker registration successful with scope: ', registration.scope);
            } catch (err) {
                console.error('ServiceWorker registration failed: ', err);
            }
        };

        // PERFORMANCE: Atrasa o registro até o load completo para não competir por banda/CPU durante a hidratação inicial.
        if (document.readyState === 'complete') {
            doRegister();
        } else {
            window.addEventListener('load', doRegister);
        }
    } else if (window.location.protocol === 'file:') {
        console.warn('Service Worker não suportado no protocolo file://. Por favor, use um servidor local (npm run dev).');
    }
};


// --- PRIVATE HELPERS (INIT ORCHESTRATION) ---

/**
 * CRITICAL LOGIC: State Reconciliation / Smart Merge.
 * Esta função decide a "Verdade" dos dados do usuário.
 * 1. Tenta carga Local (Async IDB).
 * 2. Se houver chave, tentar carga Nuvem (Assíncrona) COM TIMEOUT RÍGIDO.
 * 3. Se houver conflito (ambos existem), executa Merge baseado em timestamps (`lastModified`).
 * DO NOT REFACTOR: Alterar a ordem ou a lógica de comparação pode causar perda de dados (Data Loss).
 */
async function loadInitialState() {
    // IDB é assíncrono, mas precisamos aguardar para garantir estado consistente antes de renderizar
    
    // A função loadState do persistence.ts já lida internamente com:
    // 1. Tentar ler do IDB
    // 2. Se falhar/vazio, tentar ler do LocalStorage (Migração)
    // 3. Hidratar o objeto 'state' global
    
    // Simula a leitura para obter o objeto e comparar datas.
    // Usamos o retorno de loadState para ter acesso ao objeto AppState completo (com version e lastModified),
    // que não estão disponíveis no singleton global `state`.
    const localState = await loadState(); 
    
    if (hasLocalSyncKey()) {
        try {
            // BLINDAGEM CONTRA LIE-FI (Low Quality Network):
            // O Watchdog do index.html mata o app em 8s. A API tem timeout de 15s.
            // Se a rede estiver lenta, o app morre antes de carregar, mesmo tendo dados locais.
            // Forçamos um timeout de 3s no boot para garantir que o usuário acesse os dados locais
            // se a nuvem demorar. A sincronização ocorrerá em background depois.
            const CLOUD_BOOT_TIMEOUT_MS = 3000;
            
            const cloudState = await Promise.race([
                fetchStateFromCloud(),
                new Promise<undefined>(resolve => setTimeout(() => {
                    console.warn(`Startup: Cloud sync timed out (> ${CLOUD_BOOT_TIMEOUT_MS}ms). Proceeding with local state.`);
                    resolve(undefined);
                }, CLOUD_BOOT_TIMEOUT_MS))
            ]);

            if (cloudState && localState) {
                console.log("Startup: Both local and cloud state exist. Performing Smart Merge.");
                let stateToLoad: AppState;
                
                // A base para a fusão é o estado mais recente.
                if (localState.lastModified > cloudState.lastModified) {
                    stateToLoad = mergeStates(cloudState, localState);
                    // Como a fusão resultou em um estado mais novo que o da nuvem, sincronizamos de volta.
                    // 'true' force immediate sync.
                    syncStateWithCloud(stateToLoad, true);
                } else {
                    stateToLoad = mergeStates(localState, cloudState);
                }
                
                // Re-hidrata e persiste o estado fundido
                // Importante: persistStateLocally agora é async (IDB)
                await persistStateLocally(stateToLoad);
                await loadState(stateToLoad); // Re-hidrata global com o merged
                
            } else if (cloudState) {
                // Apenas o estado da nuvem existe, ou o local é nulo (Novo dispositivo).
                console.log("Startup: Using cloud state as the source of truth.");
                await persistStateLocally(cloudState);
                await loadState(cloudState);
            } else if (localState) {
                // Apenas o estado local existe (ex: primeira sincronização após criar chave).
                // Se o cloudState foi undefined por timeout, caímos aqui e usamos o localState.
                // Isso é o comportamento "Offline First" correto.
                if (!cloudState) { 
                    console.log("Startup: Cloud unavailable or timed out. Using local state."); 
                } else {
                    console.log("Startup: No cloud data found, pushing local state to cloud.");
                    syncStateWithCloud(localState as AppState, true);
                }
            }
            
        } catch (e) {
            console.error("Startup: Failed to process cloud state, falling back to local.", e);
            // Em caso de erro de rede, o estado local (já carregado pelo primeiro loadState) permanece.
        }
    }
}

function handleFirstTimeUser() {
    // UX: Se não houver dados, cria um hábito de exemplo para evitar o "Blank Slate Trauma".
    if (state.habits.length === 0) {
        createDefaultHabit();
    }
}

function setupAppListeners() {
    // WIRE UP SYNC: Connect state changes to cloud sync
    // Registra o handler para que saveState() dispare syncStateWithCloud() automaticamente.
    registerSyncHandler(syncStateWithCloud);
    
    setupEventListeners();
    initSync();
    
    // BUGFIX: Garante que o emblema da PWA (App Badge) seja atualizado em tempo real.
    document.addEventListener('habitsChanged', updateAppBadge);

    // MIDNIGHT HANDLER: Garante que a UI atualize na virada do dia.
    setupMidnightLoop();
    document.addEventListener('dayChanged', handleDayTransition);
}

function finalizeInit(loader: HTMLElement | null) {
    // ROBUSTNESS: Desarma o Watchdog Timer assim que a inicialização é bem-sucedida.
    // Isso previne que a mensagem de erro apareça após o app já estar carregado.
    if (typeof window.bootWatchdog !== 'undefined') {
        clearTimeout(window.bootWatchdog);
        window.bootWatchdog = undefined; // Libera referência
    }

    if (loader) {
        // UX: Transição suave (Fade-out) para evitar "Pop-in" agressivo do conteúdo.
        loader.classList.add('hidden');
        loader.addEventListener('transitionend', () => {
            // Remove o spinner
            loader.remove();
            
            // CLEANUP [2025-05-02]: Remove também o container pai para evitar DOM morto.
            // O getElementById é seguro mesmo se o elemento já tiver sido removido por outro processo.
            const container = document.getElementById('initial-loader-container');
            if (container && container.childNodes.length === 0) {
                container.remove();
            }
        });
    }
    
    // SNIPER OPTIMIZATION [2025-05-02]: Scheduler API Integration.
    // Use window.scheduler.postTask if available to prioritize non-critical background tasks.
    // This allows the main thread to remain responsive to user input immediately after boot.
    const runBackgroundTasks = () => {
        // DATA HYGIENE: Trigger archival process after boot (Low Priority).
        performArchivalCheck();
        
        // ANALYTICS: Injeção tardia.
        if (process.env.NODE_ENV === 'production') {
            import('./services/analytics').then(({ initAnalytics }) => {
                initAnalytics();
            }).catch(err => {
                console.warn('Analytics skipped:', err);
            });
        }
    };

    if (window.scheduler && window.scheduler.postTask) {
        window.scheduler.postTask(runBackgroundTasks, { priority: 'background' });
    } else if ('requestIdleCallback' in window) {
        requestIdleCallback(runBackgroundTasks);
    } else {
        setTimeout(runBackgroundTasks, 1000);
    }
}

// --- MAIN INITIALIZATION ---
async function init(loader: HTMLElement | null) {
    initAuth(); // Inicializa a autenticação (lê a chave de sincronização)
    
    // PERFORMANCE [2025-04-14]: Parallel Bootstrapping (SOPA).
    // Executa o download de traduções (Network) e o carregamento do banco de dados (Disk IO)
    // simultaneamente. Isso reduz o tempo total de boot pela duração da tarefa mais lenta,
    // em vez da soma de ambas.
    await Promise.all([
        initI18n(),        // Async Fetch
        loadInitialState() // Async IndexedDB Read (+ Optional Cloud Fetch with Timeout)
    ]);

    handleFirstTimeUser(); // Onboarding logic
    renderApp(); // First Paint (DOM Hydration)
    setupAppListeners(); // Event Binding
    updateAppBadge(); // Define o emblema inicial
    finalizeInit(loader); // Cleanup & Analytics & Archival
}

registerServiceWorker();

const startApp = () => {
    // OTIMIZAÇÃO: Busca o loader por ID (O(1)) para passar para a função de init.
    // UPDATE [2025-05-02]: Passa o elemento interno (.initial-loader) que possui a transição CSS.
    // O cleanup do pai será feito no callback de transitionend.
    const initialLoader = document.getElementById('initial-loader');
    init(initialLoader).catch(err => {
        console.error("Failed to initialize application:", err);
        // UX: Fallback visual em caso de erro crítico no boot.
        // OTIMIZAÇÃO: Reutiliza a função global de erro se disponível para usar o DOM pré-alocado.
        if (window.showFatalError) {
            window.showFatalError("Ocorreu um erro interno na inicialização.");
        } else if(initialLoader) {
            // Fallback manual se o script global falhou
            const svg = initialLoader.querySelector('svg');
            if(svg) svg.style.animation = 'none';
            initialLoader.innerHTML = '<div style="color:#ff6b6b;padding:2rem;text-align:center;"><h3>Falha Crítica</h3><button onclick="location.reload()">Tentar Novamente</button></div>';
        }
    });
};

// FIX [2025-03-04]: Ensure DOM is fully loaded before initialization.
// This prevents "element not found" errors if the script runs before the HTML parser finishes.
// PERFORMANCE: Se já estiver carregado, inicia imediatamente (Fast Path).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
} else {
    startApp();
}
