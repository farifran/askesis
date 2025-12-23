/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file render.ts
 * @description Orquestrador Central do Motor de Renderização (UI Orchestrator).
 * 
 * [MAIN THREAD]: Este módulo centraliza a coordenação de todas as atualizações do DOM.
 * Foco absoluto em evitar "Layout Thrashing" e manter o frame rate em 60fps.
 * 
 * ARQUITETURA:
 * 1. **Delegation Pattern:** Atua como uma fachada (Facade) que delega a pintura de componentes 
 *    específicos para sub-módulos em `render/`.
 * 2. **Local Memoization:** Implementa caches internos (`_lastTitleDate`, etc.) para evitar 
 *    procedimentos de string matching e escrita no DOM quando os dados de entrada não mudaram.
 * 3. **Asynchronous Asset Loading:** Gerencia o carregamento sob demanda de módulos pesados 
 *    (ex: `quotes.ts`) para manter o bundle inicial (CRP) leve.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: Consome as Dirty Flags para decidir o que renderizar.
 * - `render/ui.ts`: Depende de referências estáticas de alta velocidade para os nós do DOM.
 * - `utils.ts`: Uso extensivo de formatadores localizados e helpers de data.
 * 
 * O "PORQUÊ":
 * Centralizar a orquestração permite que mutações de estado ocorram de forma independente, 
 * enquanto a renderização é controlada para ocorrer de forma atômica, reduzindo ciclos de repintura (re-paints).
 */

import { state, LANGUAGES } from './state';
import { parseUTCIsoDate, toUTCIsoDateString, addDays, getDateTimeFormat, pushToOneSignal, getTodayUTCIso } from './utils';
import { ui } from './render/ui';
import { t } from './i18n';
import { UI_ICONS } from './render/icons';
import type { Quote } from './data/quotes';

// Importa os renderizadores especializados
import { setTextContent, updateReelRotaryARIA } from './render/dom';
import { renderCalendar, renderFullCalendar } from './render/calendar';
import { renderHabits } from './render/habits';
import { renderChart } from './render/chart';

// Re-exporta tudo para manter compatibilidade com listeners.ts e habitActions.ts
export * from './render/dom';
export * from './render/calendar';
export * from './render/habits';
export * from './render/modals';

// --- HELPERS ---

// PERFORMANCE: Memoização local de estado para evitar re-renderização de strings e Layout Thrashing no título.
let _lastTitleDate: string | null = null;
let _lastTitleLang: string | null = null;

// PERFORMANCE: Memoização local para evitar transições de opacidade desnecessárias na citação diária.
let _lastQuoteDate: string | null = null;
let _lastQuoteLang: string | null = null;

// PERFORMANCE: Placeholder para módulo carregado via dynamic import (Code Splitting).
let stoicQuotesModule: { STOIC_QUOTES: Quote[] } | null = null;


/**
 * Atualiza o título do header com lógica de contextualização temporal (Hoje/Ontem/Amanhã).
 * // PERFORMANCE: Implementa guardas de igualdade antes de tocar no DOM.
 */
function _updateHeaderTitle() {
    // PERFORMANCE: Early return se os parâmetros de entrada forem idênticos ao último frame.
    if (_lastTitleDate === state.selectedDate && _lastTitleLang === state.activeLanguageCode) {
        return;
    }

    const todayISO = getTodayUTCIso();
    const yesterdayISO = toUTCIsoDateString(addDays(parseUTCIsoDate(todayISO), -1));
    const tomorrowISO = toUTCIsoDateString(addDays(parseUTCIsoDate(todayISO), 1));

    const specialDateMap: Record<string, string> = {
        [todayISO]: 'headerTitleToday',
        [yesterdayISO]: 'headerTitleYesterday',
        [tomorrowISO]: 'headerTitleTomorrow',
    };

    let desktopTitle: string;
    let mobileTitle: string;
    
    // PERFORMANCE: Parse único da data selecionada para uso em múltiplas formatações.
    const date = parseUTCIsoDate(state.selectedDate);
    
    const specialDateKey = specialDateMap[state.selectedDate];

    if (specialDateKey) {
        const title = t(specialDateKey);
        desktopTitle = title;
        mobileTitle = title;
    } else {
        const day = String(date.getUTCDate()).padStart(2, '0');
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        mobileTitle = `${day}/${month}`;
        
        desktopTitle = getDateTimeFormat(state.activeLanguageCode, {
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC'
        }).format(date);
    }
    setTextContent(ui.headerTitleDesktop, desktopTitle);
    setTextContent(ui.headerTitleMobile, mobileTitle);
    
    // A11Y: Garante que a data completa esteja sempre disponível para leitores de tela sem impactar o layout visual.
    const fullLabel = getDateTimeFormat(state.activeLanguageCode, {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC'
    }).format(date);
    ui.headerTitle.setAttribute('aria-label', fullLabel);

    // Atualização do cache de memoização.
    _lastTitleDate = state.selectedDate;
    _lastTitleLang = state.activeLanguageCode;
}

/**
 * Renderiza ícones estáticos do header.
 * // PERFORMANCE: Implementação "First-Run-Only" via verificação de innerHTML.
 */
function _renderHeaderIcons() {
    if (!ui.manageHabitsBtn.innerHTML) {
        ui.manageHabitsBtn.innerHTML = UI_ICONS.settings;
    }
    const aiDefaultIcon = ui.aiEvalBtn.querySelector('.default-icon');
    if (aiDefaultIcon && !aiDefaultIcon.innerHTML) {
        aiDefaultIcon.innerHTML = UI_ICONS.ai;
    }
}


// --- ORQUESTRAÇÃO GLOBAL ---

/**
 * Ponto de entrada mestre para o ciclo de renderização.
 * // PERFORMANCE: Chama renderizadores especializados que implementam suas próprias Dirty Flags.
 * // DO NOT REFACTOR: A ordem de execução garante que o layout flua do topo (Calendar) para o fundo (Chart).
 */
export function renderApp() {
    _renderHeaderIcons();
    _updateHeaderTitle();
    renderStoicQuote();
    renderCalendar();
    renderHabits();
    renderAINotificationState();
    renderChart();
}

/**
 * Sincroniza o estado de notificações com o OneSignal.
 * // DO NOT REFACTOR: Lida com estados assíncronos e permissões de hardware.
 */
export function updateNotificationUI() {
    // [TRAVA LÓGICA]: Se o botão foi desativado por uma ação pendente de reinicialização, 
    // não permite que o polling de status sobrescreva o aviso ao usuário.
    const isPendingChange = ui.notificationToggle.disabled && !ui.notificationToggleLabel.classList.contains('disabled');
    if (isPendingChange) {
        setTextContent(ui.notificationStatusDesc, t('notificationChangePending'));
        return;
    }

    pushToOneSignal((OneSignal: any) => {
        const isPushEnabled = OneSignal.User.PushSubscription.optedIn;
        const permission = OneSignal.Notifications.permission;
        
        ui.notificationToggle.checked = isPushEnabled;
        
        const isDenied = permission === 'denied';
        ui.notificationToggle.disabled = isDenied;
        ui.notificationToggleLabel.classList.toggle('disabled', isDenied);

        let statusTextKey = 'notificationStatusOptedOut'; 
        if (isDenied) {
            statusTextKey = 'notificationStatusDisabled'; 
        } else if (isPushEnabled) {
            statusTextKey = 'notificationStatusEnabled'; 
        }
        setTextContent(ui.notificationStatusDesc, t(statusTextKey));
    });
}

/**
 * Inicializa o componente visual de troca de idiomas.
 */
export function initLanguageFilter() {
    // PERFORMANCE: Popula o DOM uma única vez para o componente de reel rotary.
    const langNames = LANGUAGES.map(lang => t(lang.nameKey));
    ui.languageReel.innerHTML = langNames.map(name => `<span class="reel-option">${name}</span>`).join('');
    const currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
    updateReelRotaryARIA(ui.languageViewport, currentIndex, langNames, 'language_ariaLabel');
}

/**
 * Gerencia o estado visual do botão de IA (Loading, Notificações, Offline).
 */
export function renderAINotificationState() {
    const isLoading = state.aiState === 'loading';
    const isOffline = !navigator.onLine;
    const hasCelebrations = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0;
    const hasUnseenResult = (state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult;

    ui.aiEvalBtn.classList.toggle('loading', isLoading);
    ui.aiEvalBtn.disabled = isLoading || isOffline;
    ui.aiEvalBtn.classList.toggle('has-notification', hasCelebrations || hasUnseenResult);
}

/**
 * Renderiza a citação estoica do dia com lógica de cross-fade.
 * // PERFORMANCE: Usa importação dinâmica para não pesar o carregamento inicial.
 * // PERFORMANCE: Lógica determinística de seleção baseada no dia do ano (Seed-based).
 */
export async function renderStoicQuote() {
    // PERFORMANCE: Early return via memoização local.
    if (_lastQuoteDate === state.selectedDate && _lastQuoteLang === state.activeLanguageCode) {
        return;
    }

    if (!stoicQuotesModule) {
        try {
            // [RACE-TO-IDLE]: O módulo de citações é carregado apenas quando necessário.
            stoicQuotesModule = await import('./data/quotes');
        } catch (e) {
            console.error("Failed to load stoic quotes module", e);
            return;
        }
    }
    const { STOIC_QUOTES } = stoicQuotesModule;

    const date = parseUTCIsoDate(state.selectedDate);
    const startOfYear = new Date(date.getUTCFullYear(), 0, 0);
    const diff = date.getTime() - startOfYear.getTime();
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);
    
    // PERFORMANCE: Cálculo determinístico do índice evita chamadas custosas ao gerador de números aleatórios.
    const seed = date.getFullYear() * 1000 + dayOfYear;
    const rnd = Math.abs(Math.sin(seed)); 
    const quoteIndex = Math.floor(rnd * STOIC_QUOTES.length);
    
    const quote = STOIC_QUOTES[quoteIndex];
    
    const lang = state.activeLanguageCode as keyof Omit<typeof quote, 'author'|'tags'>;
    const quoteText = quote[lang];
    const authorName = t(quote.author);
    
    const fullText = `"${quoteText}" — ${authorName}`;

    _lastQuoteDate = state.selectedDate;
    _lastQuoteLang = state.activeLanguageCode;

    if (ui.stoicQuoteDisplay.textContent === fullText && ui.stoicQuoteDisplay.classList.contains('visible')) {
        return;
    }

    // Caso especial: Primeira renderização.
    if (ui.stoicQuoteDisplay.textContent === '') {
         setTextContent(ui.stoicQuoteDisplay, fullText);
         ui.stoicQuoteDisplay.classList.add('visible');
         return;
    }

    // PERFORMANCE: Transição controlada via CSS e setTimeout para evitar Layout Thrashing simultâneo.
    ui.stoicQuoteDisplay.classList.remove('visible');
    
    setTimeout(() => {
        setTextContent(ui.stoicQuoteDisplay, fullText);
        ui.stoicQuoteDisplay.classList.add('visible');
    }, 150);
}
