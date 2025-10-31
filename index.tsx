/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { inject } from '@vercel/analytics';
import './index.css';
import { loadState, state } from './state';
import { ui, initUI } from './ui';
import { renderApp, updateHeaderTitle, initLanguageFilter, renderLanguageFilter, renderAINotificationState, initFrequencyFilter } from './render';
import { setupEventListeners } from './listeners';
import { initI18n } from './i18n';
import { createDefaultHabit } from './habitActions';
import { initSync } from './sync';
import { fetchStateFromCloud, hasSyncKey, initNotifications } from './cloud';
import { updateAppBadge } from './badge';

// --- SERVICE WORKER REGISTRATION ---
const registerServiceWorker = () => {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js')
                .then(registration => {
                    console.log('ServiceWorker registration successful with scope: ', registration.scope);
                })
                .catch(err => {
                    console.log('ServiceWorker registration failed: ', err);
                });
        });
    }
};


// --- INITIALIZATION ---
const init = async () => {
    inject(); // Habilita o Vercel Analytics
    initUI(); // Preenche as referências de elementos da UI agora que o DOM está pronto.
    registerServiceWorker(); // Registra o Service Worker para PWA/offline
    
    // A inicialização do i18n primeiro garante que o texto esteja disponível
    await initI18n(); 

    // Inicializa as notificações APÓS o i18n, para que qualquer texto de prompt esteja traduzido
    initNotifications();

    // A inicialização da sincronização configura a UI e a lógica da chave
    await initSync();

    // Carrega os dados do estado, priorizando a nuvem se a sincronização estiver ativa
    let cloudState;
    if (hasSyncKey()) {
        try {
            cloudState = await fetchStateFromCloud();
        } catch (error) {
            console.error("Initial sync failed on app load:", error);
            // O status de erro já é definido em fetchStateFromCloud.
            // A aplicação continuará com o estado local.
        }
    }
    loadState(cloudState);
    
    // Se for a primeira execução (sem hábitos), cria um padrão.
    if (state.habits.length === 0) {
        createDefaultHabit();
    }
    
    initLanguageFilter();
    initFrequencyFilter();
    renderLanguageFilter();
    renderApp();
    updateHeaderTitle();
    renderAINotificationState(); // Garante que o estado da notificação seja renderizado no carregamento
    
    // Usamos requestAnimationFrame para garantir que o navegador tenha concluído o layout
    // e a pintura antes de tentarmos rolar. Isso é mais confiável do que um setTimeout(0).
    requestAnimationFrame(() => {
        const todayEl = ui.calendarStrip.querySelector<HTMLElement>('.today');
        // A API scrollIntoView é uma maneira moderna e declarativa de posicionar elementos.
        // 'inline: end' rola a faixa de calendário para que o dia de hoje fique alinhado no final da visualização.
        todayEl?.scrollIntoView({ inline: 'end' });
    });
    
    setupEventListeners();
    updateAppBadge(); // Define o emblema inicial do ícone do aplicativo
};

document.addEventListener('DOMContentLoaded', init);