/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import './index.css';
import { loadState, state } from './state';
import { ui, initUI } from './ui';
import { renderFilters, renderApp, updateHeaderTitle, initFilters, initLanguageFilter, renderLanguageFilter, renderAINotificationState, openModal, initFrequencyFilter, initHabitTimeFilter } from './render';
import { setupEventListeners } from './listeners';
import { initI18n } from './i18n';
import { createDefaultHabit } from './habitActions';

// --- INITIALIZATION ---
const init = async () => {
    initUI(); // Preenche as referências de elementos da UI agora que o DOM está pronto.
    loadState();
    await initI18n(); // Detecta o idioma, CARREGA o JSON e atualiza o texto estático inicial
    
    // Se for a primeira execução (sem hábitos), cria um padrão.
    // Isso é executado após a inicialização do i18n para que as traduções estejam disponíveis.
    if (state.habits.length === 0) {
        createDefaultHabit();
    }
    
    initFilters();
    initLanguageFilter();
    initFrequencyFilter();
    initHabitTimeFilter();
    renderFilters();
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