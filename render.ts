
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// Delega a lógica complexa para módulos especializados em 'render/'.

import { state, LANGUAGES } from './state';
import { parseUTCIsoDate, toUTCIsoDateString, addDays, getDateTimeFormat, pushToOneSignal, getTodayUTCIso } from './utils';
import { ui } from './render/ui';
import { t } from './i18n';
import { icons } from './render/icons';
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

// OTIMIZAÇÃO: Estado local para evitar re-renderização do título sem necessidade
let _lastTitleDate: string | null = null;
let _lastTitleLang: string | null = null;

// OTIMIZAÇÃO: Estado local para evitar re-renderização da citação sem necessidade
let _lastQuoteDate: string | null = null;
let _lastQuoteLang: string | null = null;

// PERFORMANCE: Cache para o módulo de citações carregado dinamicamente
let stoicQuotesModule: { STOIC_QUOTES: Quote[] } | null = null;


function _updateHeaderTitle() {
    // Check if update is needed
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
    
    const specialDateKey = specialDateMap[state.selectedDate];

    if (specialDateKey) {
        const title = t(specialDateKey);
        desktopTitle = title;
        mobileTitle = title;
    } else {
        const date = parseUTCIsoDate(state.selectedDate);

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
    
    // Acessibilidade: Garante que a data completa esteja sempre disponível para leitores de tela.
    const fullLabel = getDateTimeFormat(state.activeLanguageCode, {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC'
    }).format(parseUTCIsoDate(state.selectedDate));
    ui.headerTitle.setAttribute('aria-label', fullLabel);

    // Update Cache
    _lastTitleDate = state.selectedDate;
    _lastTitleLang = state.activeLanguageCode;
}

function _renderHeaderIcons() {
    if (!ui.manageHabitsBtn.innerHTML) {
        ui.manageHabitsBtn.innerHTML = icons.settings;
    }
    const aiDefaultIcon = ui.aiEvalBtn.querySelector('.default-icon');
    if (aiDefaultIcon && !aiDefaultIcon.innerHTML) {
        aiDefaultIcon.innerHTML = icons.ai;
    }
}


// --- ORQUESTRAÇÃO GLOBAL ---

// FIX: Added missing renderApp function to orchestrate all UI updates.
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
    pushToOneSignal((OneSignal: any) => {
        const isPushEnabled = OneSignal.User.PushSubscription.optedIn;
        const permission = OneSignal.Notifications.permission;
        
        ui.notificationToggle.checked = isPushEnabled;
        // The toggle should be disabled if permission is denied, as the user can't re-enable via UI.
        ui.notificationToggleLabel.classList.toggle('disabled', permission === 'denied');

        let statusTextKey = 'notificationStatusOptedOut'; // Default to disabled by choice
        if (permission === 'denied') {
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

    ui.aiEvalBtn.classList.toggle('loading', isLoading);
    ui.aiEvalBtn.disabled = isLoading || isOffline;
    ui.aiEvalBtn.classList.toggle('has-notification', hasCelebrations || hasUnseenResult);
}

export async function renderStoicQuote() {
    if (_lastQuoteDate === state.selectedDate && _lastQuoteLang === state.activeLanguageCode) {
        return;
    }

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

    if (ui.stoicQuoteDisplay.textContent === fullText && ui.stoicQuoteDisplay.classList.contains('visible')) {
        return;
    }

    if (ui.stoicQuoteDisplay.textContent === '') {
         setTextContent(ui.stoicQuoteDisplay, fullText);
         ui.stoicQuoteDisplay.classList.add('visible');
         return;
    }

    ui.stoicQuoteDisplay.classList.remove('visible');
    
    setTimeout(() => {
        setTextContent(ui.stoicQuoteDisplay, fullText);
        ui.stoicQuoteDisplay.classList.add('visible');
    }, 150);
}
