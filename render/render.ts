
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file render.ts
 * @description Orquestrador de Renderização (View Orchestrator / Facade).
 */

import { state, LANGUAGES } from './state';
import { parseUTCIsoDate, toUTCIsoDateString, addDays, pushToOneSignal, getTodayUTCIso } from './utils';
import { ui } from './render/ui';
import { t, setLanguage, formatDate } from './i18n'; 
import { UI_ICONS } from './render/icons';
import type { Quote } from './data/quotes';
import { checkAndAnalyzeDayContext } from './habitActions';
import { selectBestQuote } from './services/quoteEngine';
import { calculateDaySummary } from './services/selectors';

import { setTextContent, updateReelRotaryARIA } from './render/dom';
import { renderCalendar, renderFullCalendar } from './render/calendar';
import { renderHabits } from './render/habits';
import { renderChart } from './render/chart';
import { setupManageModal, refreshEditModalUI, renderLanguageFilter, renderIconPicker, renderFrequencyOptions } from './render/modals';

export * from './render/dom';
export * from './render/calendar';
export * from './render/habits';
export * from './render/modals';
export * from './render/chart';

let _lastTitleDate: string | null = null;
let _lastTitleLang: string | null = null;
let _cachedQuoteState: { id: string, contextKey: string } | null = null;

let stoicQuotesModule: { STOIC_QUOTES: readonly Quote[] } | null = null;
let _quotesImportPromise: Promise<typeof import('../data/quotes')> | null = null;

let _cachedRefToday: string | null = null;
let _renderTaskController: AbortController | null = null;
let _rafHandle: number | null = null;

const OPTS_HEADER_ARIA: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' };

/**
 * Atualiza o título do cabeçalho com lógica simplificada.
 */
function _updateHeaderTitle() {
    if (_lastTitleDate === state.selectedDate && _lastTitleLang === state.activeLanguageCode) return;

    const todayISO = getTodayUTCIso();
    const selected = state.selectedDate;
    const date = parseUTCIsoDate(selected);
    
    const displayTitle = (selected === todayISO) 
        ? t('headerTitleToday') 
        : `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    
    setTextContent(ui.headerTitleDesktop, displayTitle);
    setTextContent(ui.headerTitleMobile, displayTitle);
    
    const fullLabel = formatDate(date, OPTS_HEADER_ARIA);
    if (ui.headerTitle.getAttribute('aria-label') !== fullLabel) ui.headerTitle.setAttribute('aria-label', fullLabel);

    ui.navArrowPast.classList.toggle('hidden', !(selected < todayISO));
    ui.navArrowFuture.classList.toggle('hidden', !(selected > todayISO));

    _lastTitleDate = selected;
    _lastTitleLang = state.activeLanguageCode;
}

function _renderHeaderIcons() {
    if (!ui.manageHabitsBtn.hasChildNodes()) ui.manageHabitsBtn.innerHTML = UI_ICONS.settings;
    const def = ui.aiEvalBtn.querySelector('.default-icon');
    if (def && !def.hasChildNodes()) def.innerHTML = UI_ICONS.ai;
}

export function updateUIText() {
    const setT = (el: Element | null, key: string, opts?: any) => setTextContent(el, t(key, opts));
    
    const appNameHtml = t('appName');
    const tempEl = document.createElement('div');
    tempEl.innerHTML = appNameHtml;
    document.title = tempEl.textContent || 'Askesis';

    ui.fabAddHabit.setAttribute('aria-label', t('fabAddHabit_ariaLabel'));
    ui.manageHabitsBtn.setAttribute('aria-label', t('manageHabits_ariaLabel'));
    ui.aiEvalBtn.setAttribute('aria-label', t('aiEval_ariaLabel'));
    
    setT(ui.exploreModal.querySelector('h2'), 'modalExploreTitle');
    setT(ui.createCustomHabitBtn, 'modalExploreCreateCustom');
    setT(ui.exploreModal.querySelector('.modal-close-btn'), 'closeButton');
    setT(ui.manageModalTitle, 'modalManageTitle');
    setT(ui.habitListTitle, 'modalManageHabitsSubtitle');
    setT(ui.labelLanguage, 'modalManageLanguage');
    ui.languagePrevBtn.setAttribute('aria-label', t('languagePrev_ariaLabel'));
    ui.languageNextBtn.setAttribute('aria-label', t('languageNext_ariaLabel'));
    
    setT(ui.labelSync, 'syncLabel');
    setT(ui.labelNotifications, 'modalManageNotifications');
    setT(ui.labelReset, 'modalManageReset');
    setT(ui.resetAppBtn, 'modalManageResetButton');
    setT(ui.manageModal.querySelector('.modal-close-btn'), 'closeButton');
    setT(ui.labelPrivacy, 'privacyLabel');
    setT(ui.exportDataBtn, 'exportButton');
    setT(ui.importDataBtn, 'importButton');
    setT(ui.syncInactiveDesc, 'syncInactiveDesc');
    setT(ui.enableSyncBtn, 'syncEnable');
    setT(ui.enterKeyViewBtn, 'syncEnterKey');
    setT(ui.labelEnterKey, 'syncLabelEnterKey');
    setT(ui.cancelEnterKeyBtn, 'cancelButton');
    setT(ui.submitKeyBtn, 'syncSubmitKey');
    
    if (ui.syncWarningText.innerHTML !== t('syncWarning')) ui.syncWarningText.innerHTML = t('syncWarning');
    setT(ui.keySavedBtn, ui.syncDisplayKeyView.dataset.context === 'view' ? 'closeButton' : 'syncKeySaved');
    setT(ui.syncActiveDesc, 'syncActiveDesc');
    setT(ui.viewKeyBtn, 'syncViewKey');
    setT(ui.disableSyncBtn, 'syncDisable');
    setT(ui.aiModal.querySelector('h2'), 'modalAITitle');
    setT(ui.aiModal.querySelector('.modal-close-btn'), 'closeButton');
    setT(ui.aiOptionsModal.querySelector('h2'), 'modalAIOptionsTitle');
    
    const updAi = (type: string, k1: string, k2: string) => {
        const b = ui.aiOptionsModal.querySelector<HTMLElement>(`[data-analysis-type="${type}"]`);
        if (b) { setT(b.querySelector('.ai-option-title'), k1); setT(b.querySelector('.ai-option-desc'), k2); }
    };
    updAi('monthly', 'aiOptionMonthlyTitle', 'aiOptionMonthlyDesc');
    updAi('quarterly', 'aiOptionQuarterlyTitle', 'aiOptionQuarterlyDesc');
    updAi('historical', 'aiOptionHistoricalTitle', 'aiOptionHistoricalDesc');

    setT(ui.confirmModal.querySelector('h2'), 'modalConfirmTitle');
    setT(ui.confirmModal.querySelector('.modal-close-btn'), 'cancelButton');
    setT(ui.confirmModalEditBtn, 'editButton');
    setT(ui.confirmModalConfirmBtn, 'confirmButton');
    setT(ui.notesModal.querySelector('.modal-close-btn'), 'cancelButton');
    setT(ui.saveNoteBtn, 'modalNotesSaveButton');
    ui.notesTextarea.placeholder = t('modalNotesTextareaPlaceholder');
    setT(ui.iconPickerTitle, 'modalIconPickerTitle');
    setT(ui.iconPickerModal.querySelector('.modal-close-btn'), 'cancelButton');
    setT(ui.colorPickerTitle, 'modalColorPickerTitle');
    setT(ui.colorPickerModal.querySelector('.modal-close-btn'), 'cancelButton');

    const setBtn = (b: HTMLButtonElement, i: string, k: string) => { b.innerHTML = `${i} ${t(k)}`; };
    setBtn(ui.quickActionDone, UI_ICONS.check, 'quickActionMarkAllDone');
    setBtn(ui.quickActionSnooze, UI_ICONS.snoozed, 'quickActionMarkAllSnoozed');
    setBtn(ui.quickActionAlmanac, UI_ICONS.calendar, 'quickActionOpenAlmanac');
    setT(ui.noHabitsMessage, 'modalManageNoHabits');

    if (state.editingHabit) refreshEditModalUI();
}

export function renderApp() {
    _renderHeaderIcons();
    _updateHeaderTitle();
    renderCalendar();
    renderHabits();

    if ('scheduler' in window && (window as any).scheduler) {
        _renderTaskController?.abort();
        _renderTaskController = new AbortController();
        const signal = _renderTaskController.signal;

        (window as any).scheduler.postTask(() => {
            renderAINotificationState();
            renderChart();
            (window as any).scheduler!.postTask(() => renderStoicQuote(), { priority: 'background', signal });
        }, { priority: 'user-visible', signal }).catch(() => {});
    } else {
        if (_rafHandle) cancelAnimationFrame(_rafHandle);
        _rafHandle = requestAnimationFrame(() => {
            _rafHandle = null;
            renderAINotificationState();
            renderChart();
            'requestIdleCallback' in window ? requestIdleCallback(() => renderStoicQuote()) : setTimeout(renderStoicQuote, 50);
        });
    }
    if (ui.manageModal.classList.contains('visible')) setupManageModal();
}

export function updateNotificationUI() {
    if (ui.notificationToggle.disabled && !ui.notificationToggleLabel.classList.contains('disabled')) {
        setTextContent(ui.notificationStatusDesc, t('notificationChangePending'));
        return;
    }
    pushToOneSignal((os: any) => {
        const sub = os.User.PushSubscription.optedIn, perm = os.Notifications.permission, denied = perm === 'denied';
        ui.notificationToggle.checked = sub;
        ui.notificationToggle.disabled = denied;
        ui.notificationToggleLabel.classList.toggle('disabled', denied);
        setTextContent(ui.notificationStatusDesc, t(denied ? 'notificationStatusDisabled' : (sub ? 'notificationStatusEnabled' : 'notificationStatusOptedOut')));
    });
}

export function initLanguageFilter() {
    const names = LANGUAGES.map(l => t(l.nameKey));
    ui.languageReel.innerHTML = names.map(n => `<span class="reel-option">${n}</span>`).join('');
    updateReelRotaryARIA(ui.languageViewport, LANGUAGES.findIndex(l => l.code === state.activeLanguageCode), names, 'language_ariaLabel');
}

export function renderAINotificationState() {
    const isL = state.aiState === 'loading', isO = !navigator.onLine;
    const hasN = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0 || ((state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult);

    ui.aiEvalBtn.classList.toggle('loading', isL);
    ui.aiEvalBtn.classList.toggle('offline', isO);
    ui.aiEvalBtn.classList.toggle('has-notification', hasN);
    ui.aiEvalBtn.disabled = isL;
}

let _quoteCollapseListener: ((e: Event) => void) | null = null;

function _setupQuoteAutoCollapse() {
    if (_quoteCollapseListener) return;
    _quoteCollapseListener = (e: Event) => {
        if ((e.target as HTMLElement).closest('.stoic-quote')) return;
        if (ui.stoicQuoteDisplay.querySelector('.quote-expanded')) { _cachedQuoteState = null; renderStoicQuote(); }
        document.removeEventListener('click', _quoteCollapseListener!, { capture: true });
        ui.habitContainer.removeEventListener('scroll', _quoteCollapseListener!, { passive: true });
        _quoteCollapseListener = null;
    };
    document.addEventListener('click', _quoteCollapseListener, { capture: true });
    ui.habitContainer.addEventListener('scroll', _quoteCollapseListener, { passive: true });
}

export async function renderStoicQuote() {
    checkAndAnalyzeDayContext(state.selectedDate);
    const hour = new Date().getHours(), tod = hour < 12 ? 'Morning' : (hour < 18 ? 'Afternoon' : 'Evening');
    const summ = calculateDaySummary(state.selectedDate), sig = `${summ.completed}/${summ.total}`;
    const ctxKey = `${state.selectedDate}|${state.activeLanguageCode}|${tod}|${sig}`;

    if (_cachedQuoteState?.contextKey === ctxKey) return;
    if (!stoicQuotesModule) {
        _quotesImportPromise = _quotesImportPromise || import('../data/quotes');
        try { stoicQuotesModule = await _quotesImportPromise; } catch { _quotesImportPromise = null; return; }
    }

    const sel = selectBestQuote(stoicQuotesModule.STOIC_QUOTES, state.selectedDate);
    _cachedQuoteState = { id: sel.id, contextKey: ctxKey };

    const diag = state.dailyDiagnoses[state.selectedDate], lvl = diag ? diag.level : 1;
    const lang = state.activeLanguageCode as 'pt' | 'en' | 'es', lk = `level_${lvl}` as keyof typeof sel.adaptations;
    
    const container = ui.stoicQuoteDisplay;
    container.classList.remove('visible'); container.innerHTML = '';
    
    const span = document.createElement('span'); span.className = 'quote-adaptation'; span.textContent = sel.adaptations[lk][lang] + ' ';
    const exp = document.createElement('button'); exp.className = 'quote-expander'; exp.textContent = '...'; exp.setAttribute('aria-label', t('expandQuote'));
    
    exp.onclick = (e) => {
        e.stopPropagation(); container.innerHTML = '';
        const os = document.createElement('span'); os.className = 'quote-expanded'; os.style.fontStyle = 'italic';
        os.textContent = `"${sel.original_text[lang]}" — ${t(sel.author)}`;
        container.appendChild(os); _setupQuoteAutoCollapse();
    };

    container.append(span, exp);
    requestAnimationFrame(() => {
        if (!span.isConnected) return;
        const rects = span.getClientRects();
        let isS = rects.length === 1;
        if (rects.length > 1) {
            const firstTop = rects[0].top;
            const lastTop = rects[rects.length - 1].top;
            if (Math.abs(lastTop - firstTop) < 5) isS = true;
        }
        container.style.justifyContent = isS ? 'flex-end' : 'flex-start';
        container.style.textAlign = isS ? 'right' : 'left';
        container.classList.add('visible');
    });
}

document.addEventListener('language-changed', () => { initLanguageFilter(); renderLanguageFilter(); updateUIText(); if (ui.syncStatus) setTextContent(ui.syncStatus, t(state.syncState)); renderApp(); });
document.addEventListener('habitsChanged', () => { _cachedQuoteState = null; 'requestIdleCallback' in window ? requestIdleCallback(() => renderStoicQuote()) : setTimeout(renderStoicQuote, 1000); });

export async function initI18n() {
    const saved = localStorage.getItem('habitTrackerLanguage'), browser = navigator.language.split('-')[0];
    let lang: 'pt' | 'en' | 'es' = (['pt', 'en', 'es'].includes(saved!) ? saved : (['pt', 'en', 'es'].includes(browser) ? browser : 'pt')) as any;
    await setLanguage(lang);
}
