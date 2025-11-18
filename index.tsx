/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído (Revisão Final).
// O que foi feito: A análise do ponto de entrada foi finalizada. Primeiramente, a função de registro do Service Worker foi modernizada para `async/await`. Em seguida, a orquestração de inicialização foi refatorada para obter o elemento do loader inicial apenas uma vez, passando-o como parâmetro para as funções `init` e `finalizeInit`. Isso elimina chamadas repetidas ao DOM, melhora a clareza e segue o princípio DRY.
// O que falta: Nenhuma análise futura é necessária. O arquivo está totalmente otimizado.
import { inject } from '@vercel/analytics';
import './index.css';
import { loadState, saveState, state } from './state';
import { ui, initUI } from './ui';
import { renderApp } from './render';
import { setupEventListeners } from './listeners';
import { initI18n } from './i18n';
import { createDefaultHabit } from './habitActions';
import { initSync } from './sync';
import { fetchStateFromCloud, hasSyncKey, setupNotificationListeners } from './cloud';
import { updateAppBadge } from './badge';

// --- SERVICE WORKER REGISTRATION ---
/**
 * REATORAÇÃO DE ROBUSTEZ: Registra o Service Worker. A lógica foi aprimorada para
 * lidar com o caso em que o evento 'load' da janela já ocorreu, verificando
 * `document.readyState`. Também utiliza `console.error` para falhas.
 */
const registerServiceWorker = () => {
    if ('serviceWorker' in navigator) {
        // REATORAÇÃO DE ESTILO DE CÓDIGO: A função interna 'doRegister' foi
        // convertida para async/await para alinhar-se ao estilo de código moderno
        // usado no restante da aplicação, melhorando a legibilidade e a consistência.
        const doRegister = async () => {
            try {
                // CORREÇÃO DE ROBUSTEZ: A lógica anterior de construção de caminho dinâmico era
                // propensa a erros de "origem de script não correspondente" em certos ambientes de
                // hospedagem. Ao registrar '/sw.js', assumimos que o service worker está na raiz
                // do diretório servido (conforme configurado em build.js). O navegador definirá
                // o escopo padrão como '/', que é o escopo máximo e correto para a aplicação.
                // Esta abordagem é mais simples e resiliente.
                const registration = await navigator.serviceWorker.register('/sw.js');
                console.log('ServiceWorker registration successful with scope: ', registration.scope);
            } catch (err) {
                console.error('ServiceWorker registration failed: ', err);
            }
        };

        if (document.readyState === 'complete') {
            doRegister();
        } else {
            window.addEventListener('load', doRegister);
        }
    }
};


// --- PRIVATE HELPERS (INIT ORCHESTRATION) ---

/**
 * REATORAÇÃO DE MODULARIDADE: Lida com o carregamento de traduções e a inicialização da UI.
 */
async function setupBase() {
    // CORREÇÃO DE INICIALIZAÇÃO: `initUI()` deve ser chamado ANTES de `initI18n()`
    // para garantir que o objeto `ui` seja populado com referências do DOM antes que as
    // funções de internacionalização e renderização tentem usá-lo.
    initUI(); // Mapeia os elementos do DOM
    await initI18n(); // Carrega as traduções
}

/**
 * REATORAÇÃO DE MODULARIDADE: Carrega o estado da aplicação, seja da nuvem ou localmente.
 */
async function loadInitialState() {
    let cloudState;
    if (hasSyncKey()) {
        try {
            cloudState = await fetchStateFromCloud();
        } catch (e) {
            console.error("Failed to fetch from cloud on startup, using local state.", e);
        }
    }
    loadState(cloudState);
}

/**
 * REATORAÇÃO DE MODULARIDADE: Lida com a inicialização de primeira vez.
 */
function handleFirstTimeUser() {
    if (state.habits.length === 0) {
        createDefaultHabit();
        saveState();
    }
}

/**
 * REATORAÇÃO DE MODULARIDADE: Configura todos os listeners de eventos.
 */
function setupAppListeners() {
    setupEventListeners();
    setupNotificationListeners();
    initSync();
}

/**
 * REATORAÇÃO DE MODULARIDADE: Esconde o loader inicial e injeta analytics.
 * REATORAÇÃO DE DRY: O elemento do loader é recebido como parâmetro para evitar
 * uma consulta repetida ao DOM.
 */
function finalizeInit(loader: HTMLElement | null) {
    if (loader) {
        loader.classList.add('hidden');
        loader.addEventListener('transitionend', () => loader.remove());
    }
    inject(); // Vercel Analytics
}

// --- MAIN INITIALIZATION ---
/**
 * REATORAÇÃO DE MODULARIDADE: Orquestra a sequência de inicialização da aplicação.
 * A função foi dividida em múltiplos helpers privados para clareza e manutenibilidade.
 * REATORAÇÃO DE DRY: Recebe a referência ao elemento do loader para passá-la adiante.
 */
async function init(loader: HTMLElement | null) {
    await setupBase();
    await loadInitialState();
    handleFirstTimeUser();
    renderApp();
    setupAppListeners();
    updateAppBadge(); // Define o emblema inicial
    finalizeInit(loader);
}

// Inicia a aplicação.
registerServiceWorker();

// REATORAÇÃO DE DRY: O elemento do loader é obtido apenas uma vez e reutilizado
// tanto na inicialização bem-sucedida quanto no tratamento de erros.
const initialLoader = document.getElementById('initial-loader');
init(initialLoader).catch(err => {
    console.error("Failed to initialize application:", err);
    // Exibe uma mensagem de erro para o usuário
    if(initialLoader) {
        initialLoader.innerHTML = '<h2>Falha ao carregar a aplicação. Por favor, tente novamente.</h2>'
    }
});
