
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file render.ts
 * @description Orquestrador de Renderização (View Orchestrator / Facade).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo atua como o ponto central de despacho para atualizações visuais.
 * 
 * ARQUITETURA (Facade Pattern):
 * - Centraliza a API de renderização pública, escondendo a complexidade dos sub-módulos (`render/*`).
 * - Implementa estratégias de "Local Dirty Checking" para componentes globais (Header, Title)
 *   que não possuem gerenciamento de estado próprio.
 * 
 * DECISÕES TÉCNICAS:
 * 1. Code Splitting / Lazy Loading: O módulo de citações (`data/quotes.ts`) é carregado sob demanda
 *    apenas quando necessário, reduzindo o tamanho do bundle inicial (Critical Rendering Path).
 * 2. Renderização Condicional: Funções como `_updateHeaderTitle` verificam caches locais antes de tocar no DOM.
 * 3. Atomicidade Visual: `renderApp` garante que a atualização da UI pareça instantânea e coordenada.
 */

// Delega a lógica complexa para módulos especializados em 'render/'.

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

// OTIMIZAÇÃO: Estado local para evitar re-renderização do título sem necessidade (Local Dirty Checking).
let _lastTitleDate: string | null = null;
let _lastTitleLang: string | null = null;

// OTIMIZAÇÃO: Estado local para evitar re-renderização da citação sem necessidade.
let _lastQuoteDate: string | null = null;
let _lastQuoteLang: string | null = null;

// PERFORMANCE: Cache para o módulo de citações carregado dinamicamente.
let stoicQuotesModule: { STOIC_QUOTES: Quote[] } | null = null;


function _updateHeaderTitle() {
    // PERFORMANCE: Bypass se os dados não mudaram. Evita Layout Thrashing no cabeçalho.
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
    
    // OPTIMIZATION: Parse once and reuse for both logic and A11y
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
    // DOM WRITE: Atualiza apenas se necessário (implícito no setTextContent)
    setTextContent(ui.headerTitleDesktop, desktopTitle);
    setTextContent(ui.headerTitleMobile, mobileTitle);
    
    // Acessibilidade: Garante que a data completa esteja sempre disponível para leitores de tela.
    const fullLabel = getDateTimeFormat(state.activeLanguageCode, {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC'
    }).format(date);
    ui.headerTitle.setAttribute('aria-label', fullLabel);

    // Update Cache
    _lastTitleDate = state.selectedDate;
    _lastTitleLang = state.activeLanguageCode;
}

function _renderHeaderIcons() {
    // Lazy render de ícones estáticos para evitar bloquear o FCP (First Contentful Paint)
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
 * [MAIN THREAD] Frame Orchestrator.
 * Esta função é chamada sempre que o estado muda significativamente.
 * Ela coordena a atualização de todos os componentes visuais.
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

// FIX: Added missing updateNotificationUI function.
export function updateNotificationUI() {
    // UX/LOGIC LOCK: Se o botão foi desativado por uma ação pendente, mantemos o estado visual
    // para comunicar que uma reinicialização é necessária.
    const isPendingChange = ui.notificationToggle.disabled && !ui.notificationToggleLabel.classList.contains('disabled');
    if (isPendingChange) {
        // BUGFIX DE TRADUÇÃO: A mensagem de "pendente" precisa ser re-traduzida se o idioma mudar.
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

        let statusTextKey = 'notificationStatusOptedOut'; // Default to disabled by choice
        if (isDenied) {
            statusTextKey = 'notificationStatusDisabled'; // Blocked by browser
        } else if (isPushEnabled) {
            statusTextKey = 'notificationStatusEnabled'; // Enabled and opted-in
        }
        setTextContent(ui.notificationStatusDesc, t(statusTextKey));
    });
}

export function initLanguageFilter() {
    // Precisamos popular o DOM inicial antes de chamar o render
    const langNames = LANGUAGES.map(lang => t(lang.nameKey));
    ui.languageReel.innerHTML = langNames.map(name => `<span class="reel-option">${name}</span>`).join('');
    const currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
    updateReelRotaryARIA(ui.languageViewport, currentIndex, langNames, 'language_ariaLabel');
}

export function renderAINotificationState() {
    const isLoading = state.aiState === 'loading';
    const isOffline = !navigator.onLine;
    const hasCelebrations = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0;
    const hasUnseenResult = (state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult;

    // DOM WRITE: Batch class updates
    ui.aiEvalBtn.classList.toggle('loading', isLoading);
    ui.aiEvalBtn.disabled = isLoading || isOffline;
    ui.aiEvalBtn.classList.toggle('has-notification', hasCelebrations || hasUnseenResult);
}

/**
 * Renderiza uma citação estoica pseudo-aleatória baseada na data.
 * PERFORMANCE: Carrega o banco de dados de citações (pesado) via Code Splitting.
 */
export async function renderStoicQuote() {
    if (_lastQuoteDate === state.selectedDate && _lastQuoteLang === state.activeLanguageCode) {
        return;
    }

    // PERFORMANCE: Lazy Loading Module.
    // O array de citações é grande e texto puro. Não deve bloquear o carregamento inicial.
    if (!stoicQuotesModule) {
        try {
            stoicQuotesModule = await import('./data/quotes');
        } catch (e) {
            console.error("Failed to load stoic quotes module", e);
            return; // Abort if quotes can't be loaded
        }
    }
    const { STOIC_QUOTES } = stoicQuotesModule;

    const date = parseUTCIsoDate(state.selectedDate);
    
    // CRITICAL LOGIC: Deterministic Randomness.
    // Garante que a mesma citação apareça para a mesma data, independente de reloads.
    const startOfYear = new Date(date.getUTCFullYear(), 0, 0);
    const diff = date.getTime() - startOfYear.getTime();
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);
    
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

    // UX: Evita "piscar" se o texto já for o correto e estiver visível.
    if (ui.stoicQuoteDisplay.textContent === fullText && ui.stoicQuoteDisplay.classList.contains('visible')) {
        return;
    }

    if (ui.stoicQuoteDisplay.textContent === '') {
         setTextContent(ui.stoicQuoteDisplay, fullText);
         ui.stoicQuoteDisplay.classList.add('visible');
         return;
    }

    // UX: Fade-out / Fade-in transition
    ui.stoicQuoteDisplay.classList.remove('visible');
    
    setTimeout(() => {
        setTextContent(ui.stoicQuoteDisplay, fullText);
        ui.stoicQuoteDisplay.classList.add('visible');
    }, 150);
}
