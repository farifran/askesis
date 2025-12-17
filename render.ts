
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// Delega a lógica complexa para módulos especializados em 'render/'.

import { state, LANGUAGES } from './state';
import { parseUTCIsoDate, toUTCIsoDateString, addDays, getDateTimeFormat, pushToOneSignal, getTodayUTCIso } from './utils';
import { ui } from './render/ui';
import { t } from './i18n';
import { STOIC_QUOTES } from './data/quotes';
import { icons } from './render/icons';

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

export function renderStoicQuote() {
    const date = parseUTCIsoDate(state.selectedDate);
    const startOfYear = new Date(date.getUTCFullYear(), 0, 0);
    const diff = date.getTime() - startOfYear.getTime();
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);
    
    // UX IMPROVEMENT: Pseudo-Random Shuffle baseado na data
    const seed = date.getFullYear() * 1000 + dayOfYear;
    const rnd = Math.abs(Math.sin(seed)); 
    const quoteIndex = Math.floor(rnd * STOIC_QUOTES.length);
    
    const quote = STOIC_QUOTES[quoteIndex];
    
    const lang = state.activeLanguageCode as keyof Omit<typeof quote, 'author'>;
    const quoteText = quote[lang];
    const authorName = t(quote.author);
    
    const fullText = `"${quoteText}" — ${authorName}`;

    // Evita o "blink" da citação se o texto não mudou
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
    }, 100);
}

export function updateHeaderTitle() {
    if (!state.uiDirtyState.calendarVisuals) {
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
}

export function updateNotificationUI() {
    pushToOneSignal((OneSignal: any) => {
        const permission = OneSignal.Notifications.permission;
        const isPushEnabled = OneSignal.User.PushSubscription.optedIn;

        if (permission === "denied") {
            ui.notificationToggle.checked = false;
            ui.notificationToggle.disabled = true;
            // CLEANUP [2025-03-04]: Removed manual style.cursor manipulation. Handled by CSS.
            setTextContent(ui.notificationStatusDesc, t('notificationStatusDisabled'));
        } else {
            ui.notificationToggle.disabled = false;
            // CLEANUP [2025-03-04]: Removed manual style.cursor manipulation. Handled by CSS.

            ui.notificationToggle.checked = isPushEnabled;

            if (isPushEnabled) {
                setTextContent(ui.notificationStatusDesc, t('notificationStatusEnabled'));
            } else {
                setTextContent(ui.notificationStatusDesc, t('modalManageNotificationsStaticDesc'));
            }
        }
    });
}

// CENTRAL ORCHESTRATION FUNCTION
export function renderApp() {
    _renderHeaderIcons();
    updateHeaderTitle();
    renderStoicQuote();
    renderCalendar();
    renderHabits();
    renderChart();
    renderAINotificationState();
}
