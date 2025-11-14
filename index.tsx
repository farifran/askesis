/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 0% concluído. Todos os arquivos precisam ser revisados. Quando um arquivo atingir 100%, não será mais necessário revisá-lo.
import { inject } from '@vercel/analytics';
import './index.css';
import { loadState, saveState, state } from './state';
import { ui, initUI } from './ui';
import { renderApp, renderLanguageFilter } from './render';
import { setupEventListeners } from './listeners';
import { initI18n } from './i18n';
import { createDefaultHabit } from './habitActions';
import { initSync } from './sync';
import { fetchStateFromCloud, hasSyncKey, setupNotificationListeners } from './cloud';
import { updateAppBadge } from './api/badge';

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
    // [ETAPA 0 - SETUP IMEDIATO]: Funções que não dependem de estado ou traduções.
    inject(); // Habilita o Vercel Analytics.
    initUI(); // Preenche as referências de elementos da UI agora que o DOM está pronto.
    registerServiceWorker(); // Inicia o registro do Service Worker em segundo plano.
    
    // [ETAPA 1 - TRADUÇÕES E UI INICIAL]: Essencial para que todo o texto subsequente seja traduzido.
    // A inicialização do i18n primeiro garante que o texto esteja disponível
    // e também lida com a renderização inicial da UI.
    await initI18n(); 

    // [ETAPA 2 - CONFIGURAÇÕES DEPENDENTES DE I18N]: Funções que podem precisar de texto traduzido para prompts.
    setupNotificationListeners();

    // [ETAPA 3 - LÓGICA DE DADOS (PRÉ-CARREGAMENTO)]: Configura a UI de sincronização antes de carregar os dados.
    await initSync();

    // [ETAPA 4 - CARREGAMENTO DO ESTADO]: Carrega os dados do estado, priorizando a nuvem se a sincronização estiver ativa.
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
    
    // [ETAPA 5 - ESTADO PADRÃO]: Garante que a aplicação tenha conteúdo na primeira execução.
    if (state.habits.length === 0) {
        createDefaultHabit();
        // BUGFIX [2024-10-25]: Garante que o hábito padrão seja persistido imediatamente
        // no primeiro carregamento. Isso previne que o estado seja perdido se o usuário
        // fechar a aplicação antes de realizar qualquer outra ação que acione o salvamento.
        saveState();
    }
    
    // [ETAPA 6 - RENDERIZAÇÃO PRINCIPAL]: Renderiza a aplicação completa com o estado final carregado.
    renderApp();
    
    // OTIMIZAÇÃO DE UX [2024-11-10]: Oculta suavemente o indicador de carregamento inicial.
    const loader = document.getElementById('initial-loader');
    if (loader) {
        loader.classList.add('hidden');
        // Remove o elemento do DOM após a transição para manter a estrutura limpa.
        loader.addEventListener('transitionend', () => loader.remove(), { once: true });
    }

    // [ETAPA 7 - AJUSTES DE UI PÓS-RENDERIZAÇÃO]: Ações que dependem do layout final do DOM.
    // Usamos requestAnimationFrame para garantir que o navegador tenha concluído o layout
    // e a pintura antes de tentarmos rolar. Isso é mais confiável do que um setTimeout(0).
    requestAnimationFrame(() => {
        const todayEl = ui.calendarStrip.querySelector<HTMLElement>('.today');
        // A API scrollIntoView é uma maneira moderna e declarativa de posicionar elementos.
        // 'inline: end' rola a faixa de calendário para que o dia de hoje fique alinhado no final da visualização.
        // UX POLISH [2024-10-21]: Adicionada a opção 'behavior: smooth' para criar uma animação de rolagem suave no carregamento, melhorando a experiência inicial do usuário.
        todayEl?.scrollIntoView({ inline: 'end', behavior: 'smooth' });
    });
    
    // [ETAPA 8 - LISTENERS E FINALIZAÇÃO]: Anexa todos os manipuladores de eventos e atualizações finais.
    setupEventListeners();
    updateAppBadge(); // Define o emblema inicial do ícone do aplicativo
};

document.addEventListener('DOMContentLoaded', init);