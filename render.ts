
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
 * ARQUITETURA (Facade Pattern & Zero-Allocation):
 * - **Responsabilidade Única:** Centraliza a API de renderização pública.
 * - **Memoization de Datas:** Cálculos de datas relativas (Ontem/Amanhã) são cacheados e recalculados apenas na mudança de dia.
 * - **DOM Reads Otimizados:** Evita `innerHTML` para verificações de existência.
 */

import { state, LANGUAGES } from './state';
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

// --- HELPERS STATE (Monomorphic) ---
let _lastTitleDate: string | null = null;
let _lastTitleLang: string | null = null;
let _lastQuoteDate: string | null = null;
let _lastQuoteLang: string | null = null;
let stoicQuotesModule: { STOIC_QUOTES: Quote[] } | null = null;

// PERF: Date Cache (Avoids GC Pressure)
// Armazena as strings ISO de hoje, ontem e amanhã para comparação rápida (string internada)
// sem alocar novos objetos Date a cada frame.
let _cachedRefToday: string | null = null;
let _cachedYesterdayISO: string | null = null;
let _cachedTomorrowISO: string | null = null;

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

function _updateHeaderTitle() {
    // Dirty Check (String Reference Comparison is O(1) in V8)
    if (_lastTitleDate === state.selectedDate && _lastTitleLang === state.activeLanguageCode) {
        return;
    }

    const todayISO = getTodayUTCIso();
    _ensureRelativeDateCache(todayISO);

    const selected = state.selectedDate;
    let titleKey: string | null = null;

    // Fast Path: String Comparison
    if (selected === todayISO) titleKey = 'headerTitleToday';
    else if (selected === _cachedYesterdayISO) titleKey = 'headerTitleYesterday';
    else if (selected === _cachedTomorrowISO) titleKey = 'headerTitleTomorrow';

    let desktopTitle: string;
    let mobileTitle: string;
    let fullLabel: string;
    
    // Lazy Date Parsing: Só aloca o objeto Date se for necessário formatar
    if (titleKey) {
        const localizedTitle = t(titleKey);
        desktopTitle = localizedTitle;
        mobileTitle = localizedTitle;
        
        // Precisamos da data apenas para o ARIA label completo
        const date = parseUTCIsoDate(selected);
        fullLabel = formatDate(date, OPTS_HEADER_ARIA);
    } else {
        const date = parseUTCIsoDate(selected);
        
        // Optimized Date Formatting for Mobile (Manual)
        const day = date.getUTCDate();
        const month = date.getUTCMonth() + 1;
        // Smi (Small Integer) concatenation is fast
        mobileTitle = (day < 10 ? '0' : '') + day + '/' + (month < 10 ? '0' : '') + month;
        
        desktopTitle = formatDate(date, OPTS_HEADER_DESKTOP);
        fullLabel = formatDate(date, OPTS_HEADER_ARIA);
    }
    
    setTextContent(ui.headerTitleDesktop, desktopTitle);
    setTextContent(ui.headerTitleMobile, mobileTitle);
    
    // DOM Write com Dirty Check implícito (getAttribute é rápido)
    if (ui.headerTitle.getAttribute('aria-label') !== fullLabel) {
        ui.headerTitle.setAttribute('aria-label', fullLabel);
    }

    _lastTitleDate = selected;
    _lastTitleLang = state.activeLanguageCode;
}

function _renderHeaderIcons() {
    // PERFORMANCE: 'hasChildNodes' é mais rápido que ler 'innerHTML' (evita serialização)
    if (!ui.manageHabitsBtn.hasChildNodes()) {
        ui.manageHabitsBtn.innerHTML = UI_ICONS.settings;
    }
    const aiDefaultIcon = ui.aiEvalBtn.firstElementChild as HTMLElement; // .loading-icon is first, but structure might vary.
    // Melhor usar seletor específico cacheado ou verificação direta
    // A estrutura é: svg.loading-icon, span.default-icon, svg.offline-icon
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
    
    // Modal Titles & Buttons
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
    
    // innerHTML necessário para tags de formatação
    if (ui.syncWarningText.innerHTML !== t('syncWarning')) {
        ui.syncWarningText.innerHTML = t('syncWarning');
    }

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

    // Quick Actions - Icons + Text
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

// --- ORQUESTRAÇÃO GLOBAL ---

export function renderApp() {
    _renderHeaderIcons();
    _updateHeaderTitle();
    renderStoicQuote();
    renderCalendar();
    renderHabits();
    renderAINotificationState();
    renderChart();

    // UX UPDATE: Refresh Manage Modal List if visible.
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
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
    // Optimization: Build string once
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

    // PERF: Optimized Day of Year Calculation (Integer Math)
    const date = parseUTCIsoDate(state.selectedDate);
    const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
    // Bitwise OR to truncate float to int (Smi)
    const diff = (date.getTime() - startOfYear.getTime()) | 0;
    const oneDay = 86400000; // 1000 * 60 * 60 * 24
    const dayOfYear = (diff / oneDay) | 0;
    
    // Deterministic Seed
    const seed = (date.getFullYear() * 1000 + dayOfYear) | 0;
    const rnd = Math.abs(Math.sin(seed)); 
    // Bitwise truncation again
    const quoteIndex = (rnd * STOIC_QUOTES.length) | 0;
    
    const quote = STOIC_QUOTES[quoteIndex];
    const lang = state.activeLanguageCode as keyof Omit<typeof quote, 'author'|'tags'>;
    const quoteText = quote[lang];
    const authorName = t(quote.author);
    const fullText = `"${quoteText}" — ${authorName}`;

    _lastQuoteDate = state.selectedDate;
    _lastQuoteLang = state.activeLanguageCode;

    // DOM Read & Write (Dirty Check)
    if (ui.stoicQuoteDisplay.textContent === fullText && ui.stoicQuoteDisplay.classList.contains('visible')) {
        return;
    }

    if (ui.stoicQuoteDisplay.textContent === '') {
         setTextContent(ui.stoicQuoteDisplay, fullText);
         ui.stoicQuoteDisplay.classList.add('visible');
         return;
    }

    // Transition Logic
    ui.stoicQuoteDisplay.classList.remove('visible');
    setTimeout(() => {
        setTextContent(ui.stoicQuoteDisplay, fullText);
        ui.stoicQuoteDisplay.classList.add('visible');
    }, 150);
}

// SETUP: Listen for language changes dispatched from i18n module
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

    // Dispatches 'language-changed' event internally
    await setLanguage(initialLang);
}
