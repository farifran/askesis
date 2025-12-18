type UIElements = {
    appContainer: HTMLElement; // Cached reference
    calendarStrip: HTMLElement;
    headerTitle: HTMLElement;
    headerTitleDesktop: HTMLElement;
    headerTitleMobile: HTMLElement;
    stoicQuoteDisplay: HTMLElement;
    habitContainer: HTMLElement;
    chartContainer: HTMLElement;
    manageHabitsBtn: HTMLButtonElement;
    fabAddHabit: HTMLButtonElement;
    manageModal: HTMLElement;
    manageModalTitle: HTMLElement;
    habitListTitle: HTMLElement;
    exploreModal: HTMLElement;
    exploreHabitList: HTMLElement;
    createCustomHabitBtn: HTMLButtonElement;
    aiEvalBtn: HTMLButtonElement;
    aiModal: HTMLElement;
    aiOptionsModal: HTMLElement;
    confirmModal: HTMLElement;
    habitList: HTMLElement;
    aiResponse: HTMLElement;
    confirmModalText: HTMLElement;
    confirmModalConfirmBtn: HTMLButtonElement;
    confirmModalEditBtn: HTMLButtonElement;
    notesModal: HTMLElement;
    notesModalTitle: HTMLElement;
    notesModalSubtitle: HTMLElement;
    notesTextarea: HTMLTextAreaElement;
    saveNoteBtn: HTMLButtonElement;
    resetAppBtn: HTMLButtonElement;
    languagePrevBtn: HTMLButtonElement;
    languageViewport: HTMLElement;
    languageReel: HTMLElement;
    languageNextBtn: HTMLButtonElement;
    editHabitModal: HTMLElement;
    editHabitModalTitle: HTMLElement;
    editHabitForm: HTMLFormElement;
    editHabitSaveBtn: HTMLButtonElement;
    habitTimeContainer: HTMLElement;
    frequencyOptionsContainer: HTMLElement;
    syncStatus: HTMLElement;
    syncSection: HTMLElement;
    syncInactiveView: HTMLElement;
    enableSyncBtn: HTMLButtonElement;
    enterKeyViewBtn: HTMLButtonElement;
    syncEnterKeyView: HTMLElement;
    syncKeyInput: HTMLInputElement;
    cancelEnterKeyBtn: HTMLButtonElement;
    submitKeyBtn: HTMLButtonElement;
    syncDisplayKeyView: HTMLElement;
    syncKeyText: HTMLElement;
    copyKeyBtn: HTMLButtonElement;
    keySavedBtn: HTMLButtonElement;
    syncActiveView: HTMLElement;
    viewKeyBtn: HTMLButtonElement;
    disableSyncBtn: HTMLButtonElement;
    notificationToggle: HTMLInputElement;
    notificationToggleLabel: HTMLLabelElement;
    notificationStatusDesc: HTMLElement;
    iconPickerModal: HTMLElement;
    iconPickerGrid: HTMLElement;
    habitIconPickerBtn: HTMLButtonElement;
    colorPickerModal: HTMLElement;
    colorPickerGrid: HTMLElement;
    changeColorFromPickerBtn: HTMLButtonElement;
    fullCalendarModal: HTMLElement;
    fullCalendarHeader: HTMLElement;
    fullCalendarMonthYear: HTMLElement;
    fullCalendarPrevBtn: HTMLButtonElement;
    fullCalendarNextBtn: HTMLButtonElement;
    fullCalendarWeekdays: HTMLElement;
    fullCalendarGrid: HTMLElement;
    calendarQuickActions: HTMLElement;
    quickActionDone: HTMLButtonElement;
    quickActionSnooze: HTMLButtonElement;
    quickActionAlmanac: HTMLButtonElement;
    
    // Static Text Elements (Labels/Titles) for i18n
    labelLanguage: HTMLElement;
    labelSync: HTMLElement;
    labelNotifications: HTMLElement;
    labelReset: HTMLElement;
    labelPrivacy: HTMLElement;
    exportDataBtn: HTMLButtonElement;
    importDataBtn: HTMLButtonElement;
    syncInactiveDesc: HTMLElement;
    labelEnterKey: HTMLElement;
    syncWarningText: HTMLElement;
    syncActiveDesc: HTMLElement;
    iconPickerTitle: HTMLElement;
    colorPickerTitle: HTMLElement;

    // Chart Elements
    chart: {
        title: HTMLElement;
        subtitle: HTMLElement;
        emptyState: HTMLElement;
        dataView: HTMLElement;
        wrapper: HTMLElement;
        svg: SVGSVGElement;
        areaPath: SVGPathElement;
        linePath: SVGPathElement;
        tooltip: HTMLElement;
        tooltipDate: HTMLElement;
        tooltipScoreLabel: HTMLElement;
        tooltipScoreValue: HTMLElement;
        tooltipHabits: HTMLElement;
        indicator: HTMLElement;
        evolutionIndicator: HTMLElement;
        axisStart: HTMLElement;
        axisEnd: HTMLElement;
    }
};

export const ui = {} as UIElements;

/**
 * REATORAÇÃO DE ROBUSTEZ: Função auxiliar para consultar um elemento do DOM.
 * Lança um erro claro se o elemento não for encontrado, evitando erros de
 * tempo de execução causados por seletores ou IDs incorretos.
 * @param selector O seletor CSS para o elemento.
 * @returns O elemento encontrado.
 */
// FIX: Changed constraint from HTMLElement to Element to support SVG elements, and added a default type of HTMLElement to maintain compatibility with existing calls.
function queryElement<T extends Element = HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) {
        throw new Error(`UI element with selector "${selector}" not found in the DOM.`);
    }
    return element;
}


export function initUI(): void {
    // [ANALYSIS PROGRESS]: 100% - Análise concluída. Mapeamento Singleton do DOM.
    // [NOTA COMPARATIVA]: Infraestrutura crítica mas de baixa complexidade lógica. 
    // Garante Type Safety entre o HTML e o TypeScript.
    
    Object.assign(ui, {
        appContainer: queryElement('.app-container'),
        calendarStrip: queryElement('#calendar-strip'),
        headerTitle: queryElement('#header-title'), 
        headerTitleDesktop: queryElement('#header-title .header-title-desktop'),
        headerTitleMobile: queryElement('#header-title .header-title-mobile'),
        stoicQuoteDisplay: queryElement('#stoic-quote-display'),
        habitContainer: queryElement('#habit-container'),
        chartContainer: queryElement('#chart-container'),
        manageHabitsBtn: queryElement<HTMLButtonElement>('#manage-habits-btn'),
        fabAddHabit: queryElement<HTMLButtonElement>('#fab-add-habit'),
        manageModal: queryElement('#manage-modal'),
        manageModalTitle: queryElement('#manage-modal-title'),
        habitListTitle: queryElement('#habit-list-title'),
        exploreModal: queryElement('#explore-modal'),
        exploreHabitList: queryElement('#explore-habit-list'),
        createCustomHabitBtn: queryElement<HTMLButtonElement>('#create-custom-habit-btn'),
        aiEvalBtn: queryElement<HTMLButtonElement>('#ai-eval-btn'),
        aiModal: queryElement('#ai-modal'),
        aiOptionsModal: queryElement('#ai-options-modal'),
        confirmModal: queryElement('#confirm-modal'),
        habitList: queryElement('#habit-list'),
        aiResponse: queryElement('#ai-response'),
        confirmModalText: queryElement('#confirm-modal-text'),
        confirmModalConfirmBtn: queryElement<HTMLButtonElement>('#confirm-modal-confirm-btn'),
        confirmModalEditBtn: queryElement<HTMLButtonElement>('#confirm-modal-edit-btn'),
        notesModal: queryElement('#notes-modal'),
        notesModalTitle: queryElement('#notes-modal-title'),
        notesModalSubtitle: queryElement('#notes-modal-subtitle'),
        notesTextarea: queryElement<HTMLTextAreaElement>('#notes-textarea'),
        saveNoteBtn: queryElement<HTMLButtonElement>('#save-note-btn'),
        resetAppBtn: queryElement<HTMLButtonElement>('#reset-app-btn'),
        languagePrevBtn: queryElement<HTMLButtonElement>('#language-prev'),
        languageViewport: queryElement('#language-viewport'),
        languageReel: queryElement('#language-reel'),
        languageNextBtn: queryElement<HTMLButtonElement>('#language-next'),
        editHabitModal: queryElement('#edit-habit-modal'),
        editHabitModalTitle: queryElement('#edit-habit-modal-title'),
        editHabitForm: queryElement<HTMLFormElement>('#edit-habit-form'),
        editHabitSaveBtn: queryElement<HTMLButtonElement>('#edit-habit-save-btn'),
        habitTimeContainer: queryElement('#habit-time-container'),
        frequencyOptionsContainer: queryElement('#frequency-options-container'),
        syncStatus: queryElement('#sync-status'),
        syncSection: queryElement('#sync-section'),
        syncInactiveView: queryElement('#sync-inactive-view'),
        enableSyncBtn: queryElement<HTMLButtonElement>('#enable-sync-btn'),
        enterKeyViewBtn: queryElement<HTMLButtonElement>('#enter-key-view-btn'),
        syncEnterKeyView: queryElement('#sync-enter-key-view'),
        syncKeyInput: queryElement<HTMLInputElement>('#sync-key-input'),
        cancelEnterKeyBtn: queryElement<HTMLButtonElement>('#cancel-enter-key-btn'),
        submitKeyBtn: queryElement<HTMLButtonElement>('#submit-key-btn'),
        syncDisplayKeyView: queryElement('#sync-display-key-view'),
        syncKeyText: queryElement('#sync-key-text'),
        copyKeyBtn: queryElement<HTMLButtonElement>('#copy-key-btn'),
        keySavedBtn: queryElement<HTMLButtonElement>('#key-saved-btn'),
        syncActiveView: queryElement('#sync-active-view'),
        viewKeyBtn: queryElement<HTMLButtonElement>('#view-key-btn'),
        disableSyncBtn: queryElement<HTMLButtonElement>('#disable-sync-btn'),
        notificationToggle: queryElement<HTMLInputElement>('#notification-toggle'),
        notificationToggleLabel: queryElement<HTMLLabelElement>('#notification-toggle-label'),
        notificationStatusDesc: queryElement('#notification-status-desc'),
        iconPickerModal: queryElement('#icon-picker-modal'),
        iconPickerGrid: queryElement('#icon-picker-grid'),
        habitIconPickerBtn: queryElement<HTMLButtonElement>('#habit-icon-picker-btn'),
        colorPickerModal: queryElement('#color-picker-modal'),
        colorPickerGrid: queryElement('#color-picker-grid'),
        changeColorFromPickerBtn: queryElement<HTMLButtonElement>('#change-color-from-picker-btn'),
        fullCalendarModal: queryElement('#full-calendar-modal'),
        fullCalendarHeader: queryElement('#full-calendar-header'),
        fullCalendarMonthYear: queryElement('#full-calendar-month-year'),
        fullCalendarPrevBtn: queryElement<HTMLButtonElement>('#full-calendar-prev'),
        fullCalendarNextBtn: queryElement<HTMLButtonElement>('#full-calendar-next'),
        fullCalendarWeekdays: queryElement('#full-calendar-weekdays'),
        fullCalendarGrid: queryElement('#full-calendar-grid'),
        calendarQuickActions: queryElement('#calendar-quick-actions'),
        quickActionDone: queryElement<HTMLButtonElement>('#quick-action-done'),
        quickActionSnooze: queryElement<HTMLButtonElement>('#quick-action-snooze'),
        quickActionAlmanac: queryElement<HTMLButtonElement>('#quick-action-almanac'),
        
        // Static Text Elements
        labelLanguage: queryElement('#label-language'),
        labelSync: queryElement('#label-sync'),
        labelNotifications: queryElement('#label-notifications'),
        labelReset: queryElement('#label-reset'),
        labelPrivacy: queryElement('#label-privacy'),
        exportDataBtn: queryElement<HTMLButtonElement>('#export-data-btn'),
        importDataBtn: queryElement<HTMLButtonElement>('#import-data-btn'),
        syncInactiveDesc: queryElement('#sync-inactive-desc'),
        labelEnterKey: queryElement('#label-enter-key'),
        syncWarningText: queryElement('#sync-warning-text'),
        syncActiveDesc: queryElement('#sync-active-desc'),
        iconPickerTitle: queryElement('#icon-picker-modal-title'),
        colorPickerTitle: queryElement('#color-picker-modal-title'),

        // Chart Elements
        chart: {
            title: queryElement('#chart-container .chart-title'),
            subtitle: queryElement('#chart-container .app-subtitle'),
            emptyState: queryElement('#chart-container .chart-empty-state'),
            dataView: queryElement('#chart-container .chart-data-view'),
            wrapper: queryElement('#chart-container .chart-wrapper'),
            svg: queryElement<SVGSVGElement>('.chart-svg'),
            areaPath: queryElement<SVGPathElement>('.chart-area'),
            linePath: queryElement<SVGPathElement>('.chart-line'),
            tooltip: queryElement('#chart-container .chart-tooltip'),
            tooltipDate: queryElement('#chart-container .tooltip-date'),
            tooltipScoreLabel: queryElement('#chart-container .tooltip-score-label'),
            tooltipScoreValue: queryElement('#chart-container .tooltip-score-value'),
            tooltipHabits: queryElement('#chart-container .tooltip-habits li'),
            indicator: queryElement('#chart-container .chart-indicator'),
            evolutionIndicator: queryElement('#chart-container .chart-evolution-indicator'),
            axisStart: queryElement('#chart-container .chart-axis-labels span:first-child'),
            axisEnd: queryElement('#chart-container .chart-axis-labels span:last-child'),
        }
    });
}