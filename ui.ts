
type UIElements = {
    calendarStrip: HTMLElement;
    headerTitle: HTMLElement; // [2025-01-16] Added to allow click listener on the full title container
    headerTitleDesktop: HTMLElement;
    headerTitleMobile: HTMLElement;
    stoicQuoteDisplay: HTMLElement;
    habitContainer: HTMLElement;
    chartContainer: HTMLElement;
    manageHabitsBtn: HTMLButtonElement; // TYPE FIX [2025-02-23]: Specific type
    fabAddHabit: HTMLButtonElement;     // TYPE FIX [2025-02-23]: Specific type
    manageModal: HTMLElement;
    manageModalTitle: HTMLElement;
    habitListTitle: HTMLElement;
    exploreModal: HTMLElement;
    exploreHabitList: HTMLElement;
    createCustomHabitBtn: HTMLButtonElement; // TYPE FIX [2025-02-23]: Specific type
    aiEvalBtn: HTMLButtonElement;
    aiModal: HTMLElement;
    aiOptionsModal: HTMLElement;
    confirmModal: HTMLElement;
    habitList: HTMLElement;
    aiResponse: HTMLElement;
    confirmModalText: HTMLElement;
    confirmModalConfirmBtn: HTMLButtonElement; // TYPE FIX [2025-02-23]: Specific type
    confirmModalEditBtn: HTMLButtonElement;    // TYPE FIX [2025-02-23]: Specific type
    undoToast: HTMLElement;
    undoBtn: HTMLButtonElement; // TYPE FIX [2025-02-23]: Specific type
    notesModal: HTMLElement;
    notesModalTitle: HTMLElement;
    notesModalSubtitle: HTMLElement;
    notesTextarea: HTMLTextAreaElement;
    saveNoteBtn: HTMLButtonElement; // TYPE FIX [2025-02-23]: Specific type
    resetAppBtn: HTMLButtonElement; // TYPE FIX [2025-02-23]: Specific type
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
};

export const ui = {} as UIElements;

/**
 * REATORAÇÃO DE ROBUSTEZ: Função auxiliar para consultar um elemento do DOM.
 * Lança um erro claro se o elemento não for encontrado, evitando erros de
 * tempo de execução causados por seletores ou IDs incorretos.
 * @param selector O seletor CSS para o elemento.
 * @returns O elemento HTMLElement encontrado.
 */
function queryElement<T extends HTMLElement>(selector: string): T {
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
        undoToast: queryElement('#undo-toast'),
        undoBtn: queryElement<HTMLButtonElement>('#undo-btn'),
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
    });
}
