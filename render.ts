
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
 */

import { state, LANGUAGES } from './state';
import { parseUTCIsoDate, toUTCIsoDateString, addDays, pushToOneSignal, getTodayUTCIso } from './utils';
import { ui } from './render/ui';
import { t, setLanguage, formatDate } from './i18n'; 
import { UI_ICONS } from './render/icons';
import { STOIC_QUOTES } from './data/quotes'; // FIX: Static Import
import { checkAndAnalyzeDayContext } from './habitActions';
import { selectBestQuote } from './services/quoteEngine';
import { calculateDaySummary } from './services/selectors';

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
// QUOTE CACHE [2025-05-08]: Cache inteligente.
// Armazena: { id: "quote_id", contextKey: "morning|triumph" }
// Se o contexto mudar (ex: virou noite, ou completou tudo), re-renderiza.
let _cachedQuoteState: { id: string, contextKey: string } | null = null;

// PERF: Date Cache (Avoids GC Pressure)
let _cachedRefToday: string | null = null;
let _cachedYesterdayISO: string | null = null;
let _cachedTomorrowISO: string | null = null;

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

const OPTS_HEADER_MOBILE_NUMERIC: Intl.DateTimeFormatOptions = { 
    day: '2-digit', 
    month: '2-digit', 
    timeZone: 'UTC' 
};

function _ensureRelativeDateCache(todayISO: string) {
    if (_cachedRefToday !== todayISO) {
        _cachedRefToday = todayISO;
        const todayDate = parseUTCIsoDate(todayISO);
        _cachedYesterdayISO = toUTCIsoDateString(addDays(todayDate, -1));
        _cachedTomorrowISO = toUTCIsoDateString(addDays(todayDate, 1));
    }
}

function _updateHeaderTitle() {
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
    
    const date = parseUTCIsoDate(selected);
    const numericDateStr = formatDate(date, OPTS_HEADER_MOBILE_NUMERIC);
    
    if (titleKey) {
        const localizedTitle = t(titleKey);
        desktopTitle = localizedTitle;
        mobileTitle = (selected === todayISO) ? localizedTitle : numericDateStr;
        fullLabel = formatDate(date, OPTS_HEADER_ARIA);
    } else {
        mobileTitle = numericDateStr;
        desktopTitle = formatDate(date, OPTS_HEADER_DESKTOP);
        fullLabel = formatDate(date, OPTS_HEADER_ARIA);
    }
    
    setTextContent(ui.headerTitleDesktop, desktopTitle);
    setTextContent(ui.headerTitleMobile, mobileTitle);
    
    if (ui.headerTitle.getAttribute('aria-label') !== fullLabel) {
        ui.headerTitle.setAttribute('aria-label', fullLabel);
    }

    const isPast = selected < todayISO;
    const isFuture = selected > todayISO;
    
    if (ui.navArrowPast.classList.contains('hidden') === isPast) {
        ui.navArrowPast.classList.toggle('hidden', !isPast);
    }
    if (ui.navArrowFuture.classList.contains('hidden') === isFuture) {
        ui.navArrowFuture.classList.toggle('hidden', !isFuture);
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

export function updateUIText() {
    const appNameHtml = t('appName');
    const tempEl = document.createElement('div');
    tempEl.innerHTML = appNameHtml;
    document.title = tempEl.textContent || 'Askesis';

    ui.fabAddHabit.setAttribute('aria-label', t('fabAddHabit_ariaLabel'));
    ui.manageHabitsBtn.setAttribute('aria-label', t('manageHabits_ariaLabel'));
    ui.aiEvalBtn.setAttribute('aria-label', t('aiEval_ariaLabel'));
    
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

export function renderApp() {
    _renderHeaderIcons();
    _updateHeaderTitle();
    renderCalendar();
    renderHabits();

    if ('scheduler' in window && (window as any).scheduler) {
        (window as any).scheduler.postTask(() => {
            renderAINotificationState();
            renderChart();
            (window as any).scheduler!.postTask(() => {
                renderStoicQuote();
            }, { priority: 'background' });
        }, { priority: 'user-visible' });
    } else {
        requestAnimationFrame(() => {
            renderAINotificationState();
            renderChart();
            if ('requestIdleCallback' in window) {
                requestIdleCallback(() => renderStoicQuote());
            } else {
                setTimeout(renderStoicQuote, 50);
            }
        });
    }

    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
    }
}

export function updateNotificationUI() {
    if (ui.notificationToggle.disabled && !ui.notificationToggleLabel.classList.contains('disabled')) {
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
    if (ui.aiEvalBtn.disabled !== isLoading) ui.aiEvalBtn.disabled = isLoading;
    if (classList.contains('offline') !== isOffline) classList.toggle('offline', isOffline);
    
    const shouldNotify = hasCelebrations || hasUnseenResult;
    if (classList.contains('has-notification') !== shouldNotify) classList.toggle('has-notification', shouldNotify);
}

let _quoteCollapseListener: ((e: Event) => void) | null = null;

function _setupQuoteAutoCollapse() {
    if (_quoteCollapseListener) return;

    _quoteCollapseListener = (e: Event) => {
        const target = e.target as HTMLElement;
        if (target.closest('.stoic-quote')) return;

        const expandedQuote = ui.stoicQuoteDisplay.querySelector('.quote-expanded');
        if (expandedQuote) {
            _cachedQuoteState = null; 
            renderStoicQuote(); 
        }
    };

    document.addEventListener('click', _quoteCollapseListener, { capture: true });
    ui.habitContainer.addEventListener('scroll', _quoteCollapseListener, { passive: true });
}

export async function renderStoicQuote() {
    checkAndAnalyzeDayContext(state.selectedDate);

    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'Morning' : (hour < 18 ? 'Afternoon' : 'Evening');
    
    const summary = calculateDaySummary(state.selectedDate);
    const performanceSig = `${summary.completed}/${summary.total}`;

    const currentContextKey = `${state.selectedDate}|${state.activeLanguageCode}|${timeOfDay}|${performanceSig}`;

    if (_cachedQuoteState && _cachedQuoteState.contextKey === currentContextKey) {
        return;
    }

    const selectedQuote = selectBestQuote(STOIC_QUOTES, state.selectedDate);

    _cachedQuoteState = { id: selectedQuote.id, contextKey: currentContextKey };

    const diagnosis = state.dailyDiagnoses[state.selectedDate];
    const userLevel = diagnosis ? diagnosis.level : 1;

    const lang = state.activeLanguageCode as 'pt' | 'en' | 'es';
    
    const levelKey = `level_${userLevel}` as keyof typeof selectedQuote.adaptations;
    const adaptationText = selectedQuote.adaptations[levelKey][lang];
    
    const originalText = selectedQuote.original_text[lang];
    const authorName = t(selectedQuote.author);

    const container = ui.stoicQuoteDisplay;
    container.classList.remove('visible');
    container.innerHTML = '';
    
    container.style.justifyContent = 'flex-start';
    container.style.textAlign = 'left';
    
    const adaptationSpan = document.createElement('span');
    adaptationSpan.className = 'quote-adaptation';
    adaptationSpan.textContent = adaptationText + ' ';
    
    const expander = document.createElement('button');
    expander.className = 'quote-expander';
    expander.textContent = '...';
    expander.setAttribute('aria-label', t('expandQuote'));
    
    expander.onclick = (e) => {
        e.stopPropagation();
        container.innerHTML = '';

        container.style.justifyContent = 'flex-start';
        container.style.textAlign = 'left';
        
        const originalSpan = document.createElement('span');
        originalSpan.className = 'quote-expanded';
        originalSpan.style.fontStyle = 'italic';
        originalSpan.textContent = `"${originalText}" — ${authorName}`;
        container.appendChild(originalSpan);
        _setupQuoteAutoCollapse();

        container.classList.add('visible');
    };

    container.appendChild(adaptationSpan);
    container.appendChild(expander);

    requestAnimationFrame(() => {
        if (!adaptationSpan.isConnected) return;

        const rects = adaptationSpan.getClientRects();
        let isSingleLine = rects.length === 1;
        
        if (rects.length > 1) {
            const firstTop = rects[0].top;
            const lastTop = rects[rects.length - 1].top;
            if (Math.abs(lastTop - firstTop) < 5) {
                isSingleLine = true;
            } else {
                isSingleLine = false;
            }
        }

        if (isSingleLine) {
            container.style.justifyContent = 'flex-end';
            container.style.textAlign = 'right';
        } else {
            container.style.justifyContent = 'flex-start';
            container.style.textAlign = 'left';
        }
        
        container.classList.add('visible');
    });
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

document.addEventListener('habitsChanged', () => {
    _cachedQuoteState = null;
    if ('requestIdleCallback' in window) {
        requestIdleCallback(() => renderStoicQuote());
    } else {
        setTimeout(renderStoicQuote, 1000);
    }
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
