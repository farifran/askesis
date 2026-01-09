
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
 * ARQUITETURA (Facade Pattern & SOTA Rendering):
 * - **Responsabilidade Única:** Centraliza la API de renderização pública.
 * - **Prioritized Rendering:** Utiliza a `Scheduler API` (`postTask`) para segmentar a renderização
 *   em tarefas críticas (Lista/Calendário) e secundárias (Gráficos/IA), garantindo TTI instantâneo.
 * - **Memoization de Datas:** Cálculos de datas relativas (Ontem/Amanhã) são cacheados e executados
 *   com aritmética inteira onde possível.
 * - **Static LUTs:** Uso de Tabelas de Busca para dias do mês, evitando lógica condicional complexa.
 */

import { state, LANGUAGES } from './state';
import { parseUTCIsoDate, toUTCIsoDateString, addDays, pushToOneSignal, getTodayUTCIso } from './utils';
import { ui } from './render/ui';
import { t, setLanguage, formatDate } from './i18n'; 
import { UI_ICONS } from './render/icons';
import type { Quote } from './data/quotes';
import { checkAndAnalyzeDayContext } from './habitActions';
import { selectBestQuote } from './services/quoteEngine'; // NEW: Import Engine
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

// @fix: Update stoicQuotesModule type definition to expect readonly STOIC_QUOTES.
let stoicQuotesModule: { STOIC_QUOTES: readonly Quote[] } | null = null;

// PERF: Date Cache (Avoids GC Pressure)
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

// LOCALIZATION FIX [2025-05-02]: Formato numérico curto adaptável (DD/MM para PT/ES, MM/DD para EN-US)
const OPTS_HEADER_MOBILE_NUMERIC: Intl.DateTimeFormatOptions = { 
    day: '2-digit', 
    month: '2-digit', 
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
    
    const date = parseUTCIsoDate(selected);

    // LOCALIZATION FIX [2025-05-02]: Use Intl formatter instead of substring
    // This ensures 25/05 for PT/ES and 05/25 for EN-US automatically based on active language.
    const numericDateStr = formatDate(date, OPTS_HEADER_MOBILE_NUMERIC);
    
    // Lazy Date Parsing: Só aloca o objeto Date se for necessário formatar
    if (titleKey) {
        const localizedTitle = t(titleKey);
        desktopTitle = localizedTitle;
        
        // UX REQUEST [2025-05-02]: Mobile shows numeric date for Yesterday/Tomorrow to save space.
        // Only "Today" keeps the text label.
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

    // UPDATED INDICATORS (Real Buttons) [2025-05-16]
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

// --- ORQUESTRAÇÃO GLOBAL ---

/**
 * SOTA UPDATE [2025-05-02]: Prioritized Rendering Pipeline.
 * Divide o trabalho de renderização em estágios para evitar Long Tasks na Main Thread.
 * 
 * 1. Critical Path (Sync): Cabeçalho, Calendário, Hábitos. (Bloqueia até estar pronto - ~5ms)
 * 2. Secondary (User-Visible): Estado da IA, Gráficos. (PostTask - roda após o próximo paint)
 * 3. Background: Citações e Modais.
 */
export function renderApp() {
    // Stage 1: Critical Rendering (Above the fold & Primary Interaction)
    _renderHeaderIcons();
    _updateHeaderTitle();
    renderCalendar();
    renderHabits();

    // Stage 2: Heavy Calculation Deferral (Chart SVG & AI Logic)
    // @fix: Cast to any to correctly narrow and access scheduler.postTask
    if ('scheduler' in window && (window as any).scheduler) {
        // Scheduler API (Modern Browsers): Prioridade 'user-visible' garante que
        // isso rode logo após o paint crítico, mas sem bloquear inputs.
        (window as any).scheduler.postTask(() => {
            renderAINotificationState();
            renderChart();
            // Stage 3: Low Priority (Background)
            // Agendamos dentro do callback para encadear, ou usamos 'background' priority
            // @fix: Cast to any to avoid TS error on postTask
            (window as any).scheduler!.postTask(() => {
                renderStoicQuote();
            }, { priority: 'background' });
        }, { priority: 'user-visible' });
    } else {
        // Fallback Strategy (Safari/Legacy):
        // requestAnimationFrame empurra para o próximo frame de renderização visual.
        requestAnimationFrame(() => {
            renderAINotificationState();
            renderChart();
            // requestIdleCallback para itens de baixa prioridade (Citações)
            if ('requestIdleCallback' in window) {
                requestIdleCallback(() => renderStoicQuote());
            } else {
                setTimeout(renderStoicQuote, 50); // Fallback final
            }
        });
    }

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
    
    // OFFLINE SUPPORT [2025-05-05]: Botão habilitado mesmo offline para mostrar mensagem.
    const shouldDisable = isLoading;
    if (ui.aiEvalBtn.disabled !== shouldDisable) ui.aiEvalBtn.disabled = shouldDisable;
    
    // CSS Toggle para estado Offline (ícone visual)
    if (classList.contains('offline') !== isOffline) classList.toggle('offline', isOffline);
    
    const shouldNotify = hasCelebrations || hasUnseenResult;
    if (classList.contains('has-notification') !== shouldNotify) classList.toggle('has-notification', shouldNotify);
}

// Logic to handle auto-collapse on interaction
let _quoteCollapseListener: ((e: Event) => void) | null = null;

function _setupQuoteAutoCollapse() {
    if (_quoteCollapseListener) return;

    _quoteCollapseListener = (e: Event) => {
        const target = e.target as HTMLElement;
        // Ignore clicks inside the quote itself (except the specific expand button)
        if (target.closest('.stoic-quote')) return;

        // Reset expanded state
        const expandedQuote = ui.stoicQuoteDisplay.querySelector('.quote-expanded');
        if (expandedQuote) {
            // Force re-render to collapse
            _cachedQuoteState = null; // Invalidate cache
            renderStoicQuote(); 
        }
    };

    // Capture phase to detect clicks anywhere
    document.addEventListener('click', _quoteCollapseListener, { capture: true });
    // Also collapse on scroll of habit container
    ui.habitContainer.addEventListener('scroll', _quoteCollapseListener, { passive: true });
}

export async function renderStoicQuote() {
    // 1. Trigger background diagnosis (if needed)
    checkAndAnalyzeDayContext(state.selectedDate);

    // CRITICAL FIX: Robust Context Key Generation
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'Morning' : (hour < 18 ? 'Afternoon' : 'Evening');
    
    const summary = calculateDaySummary(state.selectedDate);
    const performanceSig = `${summary.completed}/${summary.total}`;

    const currentContextKey = `${state.selectedDate}|${state.activeLanguageCode}|${timeOfDay}|${performanceSig}`;

    if (_cachedQuoteState && _cachedQuoteState.contextKey === currentContextKey) {
        return;
    }

    if (!stoicQuotesModule) {
        try {
            stoicQuotesModule = await import('../data/quotes');
        } catch (e) {
            console.error("Failed to load stoic quotes module", e);
            return;
        }
    }
    const { STOIC_QUOTES } = stoicQuotesModule;

    // 2. Select Quote using The Stoic Oracle Engine
    const dateISO = state.selectedDate;
    let selectedQuote: Quote;
    
    try {
        selectedQuote = selectBestQuote(STOIC_QUOTES, dateISO);
    } catch (e) {
        console.warn("Quote engine failed, fallback to random", e);
        selectedQuote = STOIC_QUOTES[0];
    }

    _cachedQuoteState = { id: selectedQuote.id, contextKey: currentContextKey };

    // 3. Determine Diagnosis Level for Adaptation
    const diagnosis = state.dailyDiagnoses[dateISO];
    const userLevel = diagnosis ? diagnosis.level : 1;

    const lang = state.activeLanguageCode as 'pt' | 'en' | 'es';
    
    const levelKey = `level_${userLevel}` as keyof typeof selectedQuote.adaptations;
    const adaptationText = selectedQuote.adaptations[levelKey][lang];
    
    const originalText = selectedQuote.original_text[lang];
    const authorName = t(selectedQuote.author);

    // 4. Render
    const container = ui.stoicQuoteDisplay;
    container.classList.remove('visible');
    container.innerHTML = '';
    
    // Default alignment (multi-line)
    container.style.justifyContent = 'flex-start';
    container.style.textAlign = 'left';
    
    const adaptationSpan = document.createElement('span');
    adaptationSpan.className = 'quote-adaptation';
    adaptationSpan.textContent = adaptationText + ' ';
    
    const expander = document.createElement('button');
    expander.className = 'quote-expander';
    expander.textContent = '...';
    expander.setAttribute('aria-label', t('expandQuote'));
    expander.style.border = 'none';
    expander.style.background = 'transparent';
    expander.style.color = 'var(--accent-blue)';
    expander.style.cursor = 'pointer';
    expander.style.fontWeight = 'bold';
    expander.style.padding = '0 4px';

    // Click to Expand
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

    // Dynamic alignment based on line count using getClientRects() for robustness
    requestAnimationFrame(() => {
        if (!adaptationSpan.isConnected) return;

        // CRITICAL FIX: Use getClientRects() to detect wrapping lines.
        // For inline elements, this returns a rect for each line of text.
        const rects = adaptationSpan.getClientRects();
        
        // Robust check: length 1 means single line.
        // Extra check: Vertical difference between first and last rect to handle edge cases.
        let isSingleLine = rects.length === 1;
        
        if (rects.length > 1) {
            // Check if they are actually on same Y (some browsers split inline rects on formatting changes)
            // If top of last rect is significantly below top of first rect, it wrapped.
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

// Listeners
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
