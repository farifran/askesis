
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// Delega a lógica complexa para módulos especializados em 'render/'.

import { state, LANGUAGES } from './state';
import { runIdle, parseUTCIsoDate, toUTCIsoDateString, addDays, getDateTimeFormat, pushToOneSignal, getTodayUTCIso } from './utils';
import { ui } from './render/ui';
import { t } from './i18n';
import { STOIC_QUOTES } from './data/quotes';

// Importa os renderizadores especializados
import { setTextContent, updateReelRotaryARIA } from './render/dom';
import { renderCalendar, renderFullCalendar } from './render/calendar';
import { renderHabits } from './render/habits';
import { renderChart } from './render/chart';
// IMPORTANTE: Importação explícita necessária para uso interno neste arquivo
import { renderLanguageFilter } from './render/modals';

// Re-exporta tudo para manter compatibilidade com listeners.ts e habitActions.ts
export * from './render/dom';
export * from './render/calendar';
export * from './render/habits';
export * from './render/modals';
// Exporta renderFullCalendar explicitamente pois é usado no index/listeners
export { renderFullCalendar };

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
            ui.notificationToggleLabel.style.cursor = 'not-allowed';
            setTextContent(ui.notificationStatusDesc, t('notificationStatusDisabled'));
        } else {
            ui.notificationToggle.disabled = false;
            ui.notificationToggleLabel.style.cursor = 'pointer';

            ui.notificationToggle.checked = isPushEnabled;

            if (isPushEnabled) {
                setTextContent(ui.notificationStatusDesc, t('notificationStatusEnabled'));
            } else {
                setTextContent(ui.notificationStatusDesc, t('modalManageNotificationsStaticDesc'));
            }
        }
    });
}

function updateUIText() {
    const appNameHtml = t('appName');
    
    // Strip HTML for the document title
    const tempEl = document.createElement('div');
    tempEl.innerHTML = appNameHtml;
    document.title = tempEl.textContent || 'Askesis';

    ui.fabAddHabit.setAttribute('aria-label', t('fabAddHabit_ariaLabel'));
    ui.manageHabitsBtn.setAttribute('aria-label', t('manageHabits_ariaLabel'));
    ui.aiEvalBtn.setAttribute('aria-label', t('aiEval_ariaLabel'));
    
    ui.exploreModal.querySelector('h2')!.textContent = t('modalExploreTitle');
    ui.createCustomHabitBtn.textContent = t('modalExploreCreateCustom');
    ui.exploreModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');

    ui.manageModalTitle.textContent = t('modalManageTitle');
    ui.habitListTitle.textContent = t('modalManageHabitsSubtitle');
    
    // Elementos que não estão no objeto 'ui' precisam ser buscados
    const labelLanguage = document.getElementById('label-language');
    if (labelLanguage) labelLanguage.textContent = t('modalManageLanguage');

    ui.languagePrevBtn.setAttribute('aria-label', t('languagePrev_ariaLabel'));
    ui.languageNextBtn.setAttribute('aria-label', t('languageNext_ariaLabel'));
    
    const labelSync = document.getElementById('label-sync');
    if (labelSync) labelSync.textContent = t('syncLabel');

    const labelNotifications = document.getElementById('label-notifications');
    if (labelNotifications) labelNotifications.textContent = t('modalManageNotifications');

    ui.notificationStatusDesc.textContent = t('modalManageNotificationsStaticDesc');
    
    const labelReset = document.getElementById('label-reset');
    if (labelReset) labelReset.textContent = t('modalManageReset');

    ui.resetAppBtn.textContent = t('modalManageResetButton');
    ui.manageModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
    const syncInactiveDesc = document.getElementById('sync-inactive-desc');
    if (syncInactiveDesc) syncInactiveDesc.textContent = t('syncInactiveDesc');

    ui.enableSyncBtn.textContent = t('syncEnable');
    ui.enterKeyViewBtn.textContent = t('syncEnterKey');
    
    const labelEnterKey = document.getElementById('label-enter-key');
    if (labelEnterKey) labelEnterKey.textContent = t('syncLabelEnterKey');

    ui.cancelEnterKeyBtn.textContent = t('cancelButton');
    ui.submitKeyBtn.textContent = t('syncSubmitKey');
    
    const syncWarningText = document.getElementById('sync-warning-text');
    if (syncWarningText) syncWarningText.innerHTML = t('syncWarning');

    ui.keySavedBtn.textContent = t('syncKeySaved');
    
    const syncActiveDesc = document.getElementById('sync-active-desc');
    if (syncActiveDesc) syncActiveDesc.textContent = t('syncActiveDesc');

    ui.viewKeyBtn.textContent = t('syncViewKey');
    ui.disableSyncBtn.textContent = t('syncDisable');
    
    ui.aiModal.querySelector('h2')!.textContent = t('modalAITitle');
    ui.aiModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
    // UPDATE [2025-02-23]: Corrected selectors for new analysis buttons
    ui.aiOptionsModal.querySelector('h2')!.textContent = t('modalAIOptionsTitle');
    
    const monthlyBtn = ui.aiOptionsModal.querySelector<HTMLElement>('[data-analysis-type="monthly"]');
    if (monthlyBtn) {
        monthlyBtn.querySelector('.ai-option-title')!.textContent = t('aiOptionMonthlyTitle');
        monthlyBtn.querySelector('.ai-option-desc')!.textContent = t('aiOptionMonthlyDesc');
    }

    const quarterlyBtn = ui.aiOptionsModal.querySelector<HTMLElement>('[data-analysis-type="quarterly"]');
    if (quarterlyBtn) {
        quarterlyBtn.querySelector('.ai-option-title')!.textContent = t('aiOptionQuarterlyTitle');
        quarterlyBtn.querySelector('.ai-option-desc')!.textContent = t('aiOptionQuarterlyDesc');
    }

    const historicalBtn = ui.aiOptionsModal.querySelector<HTMLElement>('[data-analysis-type="historical"]');
    if (historicalBtn) {
        historicalBtn.querySelector('.ai-option-title')!.textContent = t('aiOptionHistoricalTitle');
        historicalBtn.querySelector('.ai-option-desc')!.textContent = t('aiOptionHistoricalDesc');
    }

    ui.confirmModal.querySelector('h2')!.textContent = t('modalConfirmTitle');
    ui.confirmModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
    ui.confirmModalEditBtn.textContent = t('editButton');
    ui.confirmModalConfirmBtn.textContent = t('confirmButton');

    ui.notesModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
    ui.saveNoteBtn.textContent = t('modalNotesSaveButton');
    ui.notesTextarea.placeholder = t('modalNotesTextareaPlaceholder');

    const iconPickerTitle = document.getElementById('icon-picker-modal-title');
    if (iconPickerTitle) iconPickerTitle.textContent = t('modalIconPickerTitle');
    
    ui.iconPickerModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');

    const colorPickerTitle = document.getElementById('color-picker-modal-title');
    if (colorPickerTitle) colorPickerTitle.textContent = t('modalColorPickerTitle');
    
    ui.colorPickerModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');

    const editModalActions = ui.editHabitModal.querySelector('.modal-actions');
    if (editModalActions) {
        editModalActions.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
        editModalActions.querySelector('#edit-habit-save-btn')!.textContent = t('modalEditSaveButton');
    }
    
    if (ui.undoToast.firstElementChild) {
        ui.undoToast.firstElementChild.textContent = t('undoToastText');
    }
    ui.undoBtn.textContent = t('undoButton');
}

export async function setLanguage(langCode: 'pt' | 'en' | 'es') {
    // A função real está em i18n.ts, mas o render é chamado lá.
    // Este placeholder é mantido caso seja necessário lógica específica de UI na troca de idioma no futuro.
}

/**
 * RENDERIZAÇÃO PROGRESSIVA: Orquestrador Principal.
 * Coordena os renderizadores especializados.
 */
export function renderApp() {
    // Fase 1: Renderização Crítica (Interatividade Imediata)
    renderHabits();
    renderCalendar();
    updateHeaderTitle();

    // Fase 2 & 3: Renderização Não Crítica (Diferida)
    runIdle(async () => {
        renderAINotificationState();
        renderStoicQuote();
        // ROBUSTEZ PWA [2025-02-28]: Importação estática garantida.
        // Evita chunks dinâmicos não cacheados no modo offline.
        renderChart();
    });
}
