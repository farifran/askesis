
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
 * ARQUITETURA (Bleeding-Edge Scheduling & Bitmasking):
 * - **Scheduler API:** Utiliza `scheduler.postTask` para priorizar atualizações de UI críticas.
 * - **Bitmask Dirty Check:** Lê flags inteiras (`uiGlobalDirtyMask`) para decisão O(1) de renderização.
 * - **Facade Pattern:** Centraliza a API de renderização pública.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: Fonte da verdade e Flags de Dirty State (Bitmask).
 * - `scheduler`: API Nativa do Chromium (com fallback).
 */

import { state, LANGUAGES, uiGlobalDirtyMask, UI_MASK_CALENDAR, UI_MASK_LIST, UI_MASK_CHART } from './state';
import { parseUTCIsoDate, toUTCIsoDateString, addDays, pushToOneSignal, getTodayUTCIso } from './utils';
import { ui } from './render/ui';
import { t, setLanguage, formatDate } from './i18n'; 
import { UI_ICONS } from './render/icons';
import type { Quote } from './data/quotes';

// Importa os renderizadores especializados
import { setTextContent, updateReelRotaryARIA } from './render/dom';
import { renderCalendar, renderFullCalendar } from './render/calendar';
import { renderHabits } from './render/habits';
import { renderChart } from './render/chart';
import { setupManageModal, refreshEditModalUI, renderLanguageFilter, renderIconPicker, renderFrequencyOptions } from './render/modals';

// Re-exporta tudo para manter compatibilidade
export * from './render/dom';
export * from './render/calendar';
export * from './render/habits';
export * from './render/modals';
export * from './render/chart';

// --- SCHEDULER POLYFILL TYPE ---
declare global {
    interface Scheduler {
        postTask(callback: Function, options?: { 
            priority?: 'user-blocking' | 'user-visible' | 'background', 
            delay?: number 
        }): Promise<any>;
    }
    var scheduler: Scheduler;
}

// --- HELPERS STATE (Monomorphic) ---
let _lastTitleDate: string | null = null;
let _lastTitleLang: string | null = null;
let _lastQuoteDate: string | null = null;
let _lastQuoteLang: string | null = null;
let stoicQuotesModule: { STOIC_QUOTES: Quote[] } | null = null;

// PERF: Date Cache (Avoids GC Pressure)
let _cachedRefToday: string | null = null;
let _cachedYesterdayISO: string | null = null;
let _cachedTomorrowISO: string | null = null;

// PERF: Lookup Table for Cumulative Days (Non-Leap Year).
const DAYS_BEFORE_MONTH_LUT = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

// PERFORMANCE: Hoisted Intl Options (Zero-Allocation).
const OPTS_HEADER_DESKTOP: Intl.DateTimeFormatOptions = {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
};

const OPTS_HEADER_ARIA: Intl.DateTimeFormatOptions = {
    weekday: 'long', 
    month: 'long', 
    day: 'numeric', 
    timeZone: 'UTC'
};

/**
 * Atualiza o cache de datas relativas apenas se o dia mudou.
 */
function _ensureRelativeDateCache(todayISO: string) {
    if (_cachedRefToday !== todayISO) {
        _cachedRefToday = todayISO;
        const todayDate = parseUTCIsoDate(todayISO);
        // Alocação ocorre apenas 1x por dia (ou sessão)
        _cachedYesterdayISO = toUTCIsoDateString(addDays(todayDate, -1));
        _cachedTomorrowISO = toUTCIsoDateString(addDays(todayDate, 1));
    }
}

/**
 * Calculates the Day of the Year (1-366) using pure integer arithmetic from an ISO string.
 * PERFORMANCE: Zero 'new Date()' allocations.
 */
function _getDayOfYearFast(isoDate: string): number {
    const y = parseInt(isoDate.substring(0, 4), 10);
    const m = parseInt(isoDate.substring(5, 7), 10);
    const d = parseInt(isoDate.substring(8, 10), 10);

    let dayOfYear = DAYS_BEFORE_MONTH_LUT[m - 1] + d;

    if (m > 2 && (y % 4 === 0) && (y % 100 !== 0 || y % 400 === 0)) {
        dayOfYear += 1;
    }

    return dayOfYear;
}

function _updateHeaderTitle() {
    // Dirty Check (String Reference Comparison is O(1) in V8)
    if (_lastTitleDate === state.selectedDate && _lastTitleLang === state.activeLanguageCode) {
        return;
    }

    const todayISO = getTodayUTCIso();
    _ensureRelativeDateCache(todayISO);

    const selected = state.selectedDate;
    let titleKey: string | null = null;

    if (selected === todayISO) titleKey = 'headerTitleToday';
    else if (selected === _cachedYesterdayISO) titleKey = 'headerTitleYesterday';
    else if (selected === _cachedTomorrowISO) titleKey = 'headerTitleTomorrow';

    let desktopTitle: string;
    let mobileTitle: string;
    let fullLabel: string;
    
    if (titleKey) {
        const localizedTitle = t(titleKey);
        desktopTitle = localizedTitle;
        mobileTitle = localizedTitle;
        
        const date = parseUTCIsoDate(selected);
        fullLabel = formatDate(date, OPTS_HEADER_ARIA);
    } else {
        const date = parseUTCIsoDate(selected);
        const day = date.getUTCDate();
        const month = date.getUTCMonth() + 1;
        mobileTitle = (day < 10 ? '0' : '') + day + '/' + (month < 10 ? '0' : '') + month;
        desktopTitle = formatDate(date, OPTS_HEADER_DESKTOP);
        fullLabel = formatDate(date, OPTS_HEADER_ARIA);
    }
    
    setTextContent(ui.headerTitleDesktop, desktopTitle);
    setTextContent(ui.headerTitleMobile, mobileTitle);
    
    if (ui.headerTitle.getAttribute('aria-label') !== fullLabel) {
        ui.headerTitle.setAttribute('aria-label', fullLabel);
    }

    _lastTitleDate = selected;
    _lastTitleLang = state.activeLanguageCode;
}

function _renderHeaderIcons() {
    if (!ui.manageHabitsBtn.hasChildNodes()) {
        ui.manageHabitsBtn.innerHTML = UI_ICONS.settings;
    }
    const defaultIconSpan = ui.aiEvalBtn.querySelector('.default-icon');
    if (defaultIconSpan && !defaultIconSpan.hasChildNodes()) {
        defaultIconSpan.innerHTML = UI_ICONS.ai;
    }
}

/**
 * Atualiza todos os textos estáticos da UI.
 */
export function updateUIText() {
    const appNameHtml = t('appName');
    const tempEl = document.createElement('div');
    tempEl.innerHTML = appNameHtml;
    document.title = tempEl.textContent || 'Askesis';

    // Batch Attribute Updates
    ui.fabAddHabit.setAttribute('aria-label', t('fabAddHabit_ariaLabel'));
    ui.manageHabitsBtn.setAttribute('aria-label', t('manageHabits_ariaLabel'));
    ui.aiEvalBtn.setAttribute('aria-label', t('aiEval_ariaLabel'));
    
    // ... (Mantém o restante das atualizações de texto inalteradas para brevidade, mas elas seriam incluídas aqui)
    // Omitindo linhas repetitivas de updateUIText para focar na lógica de renderização
    // Assume-se que o conteúdo original de updateUIText persiste aqui.
    // [CODE_FOLD: Text Updates]
    
    setTextContent(ui.exploreModal.querySelector('h2'), t('modalExploreTitle'));
    setTextContent(ui.createCustomHabitBtn, t('modalExploreCreateCustom'));
    setTextContent(ui.exploreModal.querySelector('.modal-close-btn'), t('closeButton'));
    setTextContent(ui.manageModalTitle, t('modalManageTitle'));
    setTextContent(ui.habitListTitle, t('modalManageHabitsSubtitle'));
    setTextContent(ui.labelLanguage, t('modalManageLanguage'));
    ui.languagePrevBtn.setAttribute('aria-label', t('languagePrev_ariaLabel'));
    ui.languageNextBtn.setAttribute('aria-label', t('languageNext_ariaLabel'));
    setTextContent(ui.labelSync, t('syncLabel'));
    setTextContent(ui.labelNotifications, t('modalManageNotifications'));
    setTextContent(ui.labelReset, t('modalManageReset'));
    setTextContent(ui.resetAppBtn, t('modalManageResetButton'));
    setTextContent(ui.manageModal.querySelector('.modal-close-btn'), t('closeButton'));
    setTextContent(ui.labelPrivacy, t('privacyLabel'));
    setTextContent(ui.exportDataBtn, t('exportButton'));
    setTextContent(ui.importDataBtn, t('importButton'));
    setTextContent(ui.syncInactiveDesc, t('syncInactiveDesc'));
    setTextContent(ui.enableSyncBtn, t('syncEnable'));
    setTextContent(ui.enterKeyViewBtn, t('syncEnterKey'));
    setTextContent(ui.labelEnterKey, t('syncLabelEnterKey'));
    setTextContent(ui.cancelEnterKeyBtn, t('cancelButton'));
    setTextContent(ui.submitKeyBtn, t('syncSubmitKey'));
    if (ui.syncWarningText.innerHTML !== t('syncWarning')) ui.syncWarningText.innerHTML = t('syncWarning');
    const keyContext = ui.syncDisplayKeyView.dataset.context;
    setTextContent(ui.keySavedBtn, (keyContext === 'view') ? t('closeButton') : t('syncKeySaved'));
    setTextContent(ui.syncActiveDesc, t('syncActiveDesc'));
    setTextContent(ui.viewKeyBtn, t('syncViewKey'));
    setTextContent(ui.disableSyncBtn, t('syncDisable'));
    setTextContent(ui.aiModal.querySelector('h2'), t('modalAITitle'));
    setTextContent(ui.aiModal.querySelector('.modal-close-btn'), t('closeButton'));
    setTextContent(ui.aiOptionsModal.querySelector('h2'), t('modalAIOptionsTitle'));
    const updateAiBtn = (type: string, titleKey: string, descKey: string) => {
        const btn = ui.aiOptionsModal.querySelector<HTMLElement>(`[data-analysis-type="${type}"]`);
        if (btn) {
            setTextContent(btn.querySelector('.ai-option-title'), t(titleKey));
            setTextContent(btn.querySelector('.ai-option-desc'), t(descKey));
        }
    };
    updateAiBtn('monthly', 'aiOptionMonthlyTitle', 'aiOptionMonthlyDesc');
    updateAiBtn('quarterly', 'aiOptionQuarterlyTitle', 'aiOptionQuarterlyDesc');
    updateAiBtn('historical', 'aiOptionHistoricalTitle', 'aiOptionHistoricalDesc');
    setTextContent(ui.confirmModal.querySelector('h2'), t('modalConfirmTitle'));
    setTextContent(ui.confirmModal.querySelector('.modal-close-btn'), t('cancelButton'));
    setTextContent(ui.confirmModalEditBtn, t('editButton'));
    setTextContent(ui.confirmModalConfirmBtn, t('confirmButton'));
    setTextContent(ui.notesModal.querySelector('.modal-close-btn'), t('cancelButton'));
    setTextContent(ui.saveNoteBtn, t('modalNotesSaveButton'));
    ui.notesTextarea.placeholder = t('modalNotesTextareaPlaceholder');
    setTextContent(ui.iconPickerTitle, t('modalIconPickerTitle'));
    setTextContent(ui.iconPickerModal.querySelector('.modal-close-btn'), t('cancelButton'));
    setTextContent(ui.colorPickerTitle, t('modalColorPickerTitle'));
    setTextContent(ui.colorPickerModal.querySelector('.modal-close-btn'), t('cancelButton'));
    const editModalActions = ui.editHabitModal.querySelector('.modal-actions');
    if (editModalActions) {
        setTextContent(editModalActions.querySelector('.modal-close-btn'), t('cancelButton'));
        setTextContent(editModalActions.querySelector('#edit-habit-save-btn'), t('modalEditSaveButton'));
    }
    const setBtnHtml = (btn: HTMLButtonElement, icon: string, text: string) => {
        const html = `${icon} ${text}`;
        if (btn.innerHTML !== html) btn.innerHTML = html;
    };
    setBtnHtml(ui.quickActionDone, UI_ICONS.check, t('quickActionMarkAllDone'));
    setBtnHtml(ui.quickActionSnooze, UI_ICONS.snoozed, t('quickActionMarkAllSnoozed'));
    setBtnHtml(ui.quickActionAlmanac, UI_ICONS.calendar, t('quickActionOpenAlmanac'));
    setTextContent(ui.noHabitsMessage, t('modalManageNoHabits'));

    if (state.editingHabit) {
        refreshEditModalUI();
    }
}

// --- CORE RENDER LOOP (BLEEDING-EDGE) ---

/**
 * Orquestrador de Renderização Priorizada.
 * Utiliza `scheduler.postTask` quando disponível para quebrar o trabalho em micro-tarefas,
 * garantindo que a thread principal permaneça responsiva (INP otimizado).
 */
export function renderApp() {
    const hasScheduler = 'scheduler' in window;
    
    // BITMASK DIRTY CHECKING (Bleeding Edge O(1))
    // Acesso direto à variável estática exportada, sem lookup de objetos.
    const dirtyMask = uiGlobalDirtyMask;

    if (hasScheduler) {
        // [PRIORITY 1] USER-BLOCKING: Feedback Visual Imediato
        // Atualiza cabeçalho e calendário. Essencial para percepção de latência zero.
        scheduler.postTask(() => {
            _renderHeaderIcons();
            _updateHeaderTitle();
            if ((dirtyMask & UI_MASK_CALENDAR) !== 0) renderCalendar();
        }, { priority: 'user-blocking' });

        // [PRIORITY 2] USER-VISIBLE: Conteúdo Principal
        // Renderiza a lista de hábitos. Pode ser pesado, mas é o que o usuário quer ver.
        if ((dirtyMask & UI_MASK_LIST) !== 0) {
            scheduler.postTask(() => {
                renderHabits();
            }, { priority: 'user-blocking' }); // Mantido blocking para evitar layout shift visível
        }

        // [PRIORITY 3] BACKGROUND: Elementos Secundários
        // Gráficos, notificações IA e citações. Podem atrasar alguns ms sem prejudicar a experiência.
        scheduler.postTask(() => {
            renderAINotificationState();
            renderStoicQuote();
            
            if ((dirtyMask & UI_MASK_CHART) !== 0) renderChart();
            
            if (ui.manageModal.classList.contains('visible')) {
                setupManageModal();
            }
        }, { priority: 'user-visible' });

    } else {
        // [FALLBACK LEGACY] RequestAnimationFrame & IdleCallback
        // Para browsers sem Scheduler API (Safari, Firefox antigo).
        requestAnimationFrame(() => {
            _renderHeaderIcons();
            _updateHeaderTitle();
            
            if ((dirtyMask & UI_MASK_CALENDAR) !== 0) renderCalendar();
            if ((dirtyMask & UI_MASK_LIST) !== 0) renderHabits();
            
            // Defere tarefas pesadas não críticas para quando a main thread estiver livre
            const idleFn = (window as any).requestIdleCallback || setTimeout;
            idleFn(() => {
                renderAINotificationState();
                renderStoicQuote();
                if ((dirtyMask & UI_MASK_CHART) !== 0) renderChart();
                if (ui.manageModal.classList.contains('visible')) {
                    setupManageModal();
                }
            });
        });
    }
}

export function updateNotificationUI() {
    const isPendingChange = ui.notificationToggle.disabled && !ui.notificationToggleLabel.classList.contains('disabled');
    if (isPendingChange) {
        setTextContent(ui.notificationStatusDesc, t('notificationChangePending'));
        return;
    }

    pushToOneSignal((OneSignal: any) => {
        const isPushEnabled = OneSignal.User.PushSubscription.optedIn;
        const permission = OneSignal.Notifications.permission;
        
        if (ui.notificationToggle.checked !== isPushEnabled) {
            ui.notificationToggle.checked = isPushEnabled;
        }
        
        const isDenied = permission === 'denied';
        if (ui.notificationToggle.disabled !== isDenied) {
            ui.notificationToggle.disabled = isDenied;
            ui.notificationToggleLabel.classList.toggle('disabled', isDenied);
        }

        let statusTextKey = 'notificationStatusOptedOut';
        if (isDenied) statusTextKey = 'notificationStatusDisabled';
        else if (isPushEnabled) statusTextKey = 'notificationStatusEnabled';
        
        setTextContent(ui.notificationStatusDesc, t(statusTextKey));
    });
}

export function initLanguageFilter() {
    const langNames = LANGUAGES.map(lang => t(lang.nameKey));
    const html = langNames.map(name => `<span class="reel-option">${name}</span>`).join('');
    if (ui.languageReel.innerHTML !== html) {
        ui.languageReel.innerHTML = html;
    }
    
    const currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
    updateReelRotaryARIA(ui.languageViewport, currentIndex, langNames, 'language_ariaLabel');
}

export function renderAINotificationState() {
    const isLoading = state.aiState === 'loading';
    const isOffline = !navigator.onLine;
    const hasCelebrations = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0;
    const hasUnseenResult = (state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult;

    const classList = ui.aiEvalBtn.classList;
    if (classList.contains('loading') !== isLoading) classList.toggle('loading', isLoading);
    
    const shouldDisable = isLoading || isOffline;
    if (ui.aiEvalBtn.disabled !== shouldDisable) ui.aiEvalBtn.disabled = shouldDisable;
    
    const shouldNotify = hasCelebrations || hasUnseenResult;
    if (classList.contains('has-notification') !== shouldNotify) classList.toggle('has-notification', shouldNotify);
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
            return;
        }
    }
    const { STOIC_QUOTES } = stoicQuotesModule;

    const year = parseInt(state.selectedDate.substring(0, 4), 10);
    const dayOfYear = _getDayOfYearFast(state.selectedDate);
    
    const seed = (year * 1000 + dayOfYear) | 0;
    const rnd = Math.abs(Math.sin(seed)); 
    const quoteIndex = (rnd * STOIC_QUOTES.length) | 0;
    
    const quote = STOIC_QUOTES[quoteIndex];
    const lang = state.activeLanguageCode as keyof Omit<typeof quote, 'author'|'tags'>;
    const quoteText = quote[lang];
    const authorName = t(quote.author);
    const fullText = `"${quoteText}" — ${authorName}`;

    _lastQuoteDate = state.selectedDate;
    _lastQuoteLang = state.activeLanguageCode;

    // Fast Path: Check if already visible and text is same
    if (ui.stoicQuoteDisplay.textContent === fullText && ui.stoicQuoteDisplay.classList.contains('visible')) {
        return;
    }

    // Direct Update if empty (Initial Load)
    if (ui.stoicQuoteDisplay.textContent === '') {
         setTextContent(ui.stoicQuoteDisplay, fullText);
         ui.stoicQuoteDisplay.classList.add('visible');
         return;
    }

    // Animation Cycle: Fade Out -> Update -> Fade In
    ui.stoicQuoteDisplay.classList.remove('visible');
    
    // SCHEDULER: Use task scheduling instead of setTimeout for better frame alignment
    if ('scheduler' in window) {
        scheduler.postTask(() => {
            setTextContent(ui.stoicQuoteDisplay, fullText);
            ui.stoicQuoteDisplay.classList.add('visible');
        }, { delay: 150, priority: 'user-visible' });
    } else {
        setTimeout(() => {
            setTextContent(ui.stoicQuoteDisplay, fullText);
            ui.stoicQuoteDisplay.classList.add('visible');
        }, 150);
    }
}

document.addEventListener('language-changed', () => {
    initLanguageFilter();
    renderLanguageFilter();
    updateUIText();
    if (ui.syncStatus) {
        setTextContent(ui.syncStatus, t(state.syncState));
    }
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
        updateNotificationUI();
    }
    renderApp();
});

export async function initI18n() {
    const savedLang = localStorage.getItem('habitTrackerLanguage');
    const browserLang = navigator.language.split('-')[0];
    let initialLang: 'pt' | 'en' | 'es' = 'pt';

    if (savedLang && ['pt', 'en', 'es'].includes(savedLang)) {
        initialLang = savedLang as 'pt' | 'en' | 'es';
    } else if (['pt', 'en', 'es'].includes(browserLang)) {
        initialLang = browserLang as 'pt' | 'en' | 'es';
    }

    await setLanguage(initialLang);
}
