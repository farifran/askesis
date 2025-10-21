/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import './index.css';
import { loadState, state } from './state';
import { ui, initUI } from './ui';
import { renderApp, updateHeaderTitle, initLanguageFilter, renderLanguageFilter, renderAINotificationState, openModal, initFrequencyFilter, initHabitTimeFilter } from './render';
import { setupEventListeners } from './listeners';
import { initI18n } from './i18n';
import { createDefaultHabit } from './habitActions';
import { initSync } from './sync';
import { fetchStateFromCloud, hasSyncKey } from './cloud';

// --- INITIALIZATION ---
const init = async () => {
    initUI(); // Preenche as referências de elementos da UI agora que o DOM está pronto.
    
    // A inicialização do i18n primeiro garante que o texto esteja disponível
    await initI18n(); 

    // A inicialização da sincronização configura a UI e a lógica da chave
    await initSync();

    // Carrega os dados do estado, priorizando a nuvem se a sincronização estiver ativa
    const cloudState = hasSyncKey() ? await fetchStateFromCloud() : undefined;
    loadState(cloudState);
    
    // Se for a primeira execução (sem hábitos), cria um padrão.
    if (state.habits.length === 0) {
        createDefaultHabit();
    }
    
    initLanguageFilter();
    initFrequencyFilter();
    initHabitTimeFilter();
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
};

document.addEventListener('DOMContentLoaded', init);