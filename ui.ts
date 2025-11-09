// ui.ts
// ANÁLISE DO ARQUIVO: 100% concluído. As referências da UI foram atualizadas para mapear os novos elementos de título de data para desktop e mobile, refletindo a refatoração da estrutura HTML. O módulo permanece direto e finalizado.
type UIElements = {
    calendarStrip: HTMLElement;
    headerTitleDesktop: HTMLElement;
    headerTitleMobile: HTMLElement;
    stoicQuoteDisplay: HTMLElement;
    habitContainer: HTMLElement;
    chartContainer: HTMLElement;
    manageHabitsBtn: HTMLElement;
    fabAddHabit: HTMLElement;
    manageModal: HTMLElement;
    manageModalTitle: HTMLElement;
    habitListTitle: HTMLElement;
    exploreModal: HTMLElement;
    exploreHabitList: HTMLElement;
    createCustomHabitBtn: HTMLElement;
    aiEvalBtn: HTMLButtonElement;
    aiModal: HTMLElement;
    aiOptionsModal: HTMLElement;
    confirmModal: HTMLElement;
    habitList: HTMLElement;
    aiResponse: HTMLElement;
    confirmModalText: HTMLElement;
    confirmModalConfirmBtn: HTMLElement;
    confirmModalEditBtn: HTMLElement;
    undoToast: HTMLElement;
    undoBtn: HTMLElement;
    notesModal: HTMLElement;
    notesModalTitle: HTMLElement;
    notesModalSubtitle: HTMLElement;
    notesTextarea: HTMLTextAreaElement;
    saveNoteBtn: HTMLElement;
    resetAppBtn: HTMLElement;
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
};

export const ui = {} as UIElements;

export function initUI(): void {
    Object.assign(ui, {
        calendarStrip: document.getElementById('calendar-strip')!,
        headerTitleDesktop: document.querySelector('#header-title .header-title-desktop')!,
        headerTitleMobile: document.querySelector('#header-title .header-title-mobile')!,
        stoicQuoteDisplay: document.getElementById('stoic-quote-display')!,
        habitContainer: document.getElementById('habit-container')!,
        chartContainer: document.getElementById('chart-container')!,
        manageHabitsBtn: document.getElementById('manage-habits-btn')!,
        fabAddHabit: document.getElementById('fab-add-habit')!,
        manageModal: document.getElementById('manage-modal')!,
        manageModalTitle: document.getElementById('manage-modal-title')!,
        habitListTitle: document.getElementById('habit-list-title')!,
        exploreModal: document.getElementById('explore-modal')!,
        exploreHabitList: document.getElementById('explore-habit-list')!,
        createCustomHabitBtn: document.getElementById('create-custom-habit-btn')!,
        aiEvalBtn: document.getElementById('ai-eval-btn') as HTMLButtonElement,
        aiModal: document.getElementById('ai-modal')!,
        aiOptionsModal: document.getElementById('ai-options-modal')!,
        confirmModal: document.getElementById('confirm-modal')!,
        habitList: document.getElementById('habit-list')!,
        aiResponse: document.getElementById('ai-response')!,
        confirmModalText: document.getElementById('confirm-modal-text')!,
        confirmModalConfirmBtn: document.getElementById('confirm-modal-confirm-btn')!,
        confirmModalEditBtn: document.getElementById('confirm-modal-edit-btn')!,
        undoToast: document.getElementById('undo-toast')!,
        undoBtn: document.getElementById('undo-btn')!,
        notesModal: document.getElementById('notes-modal')!,
        notesModalTitle: document.getElementById('notes-modal-title')!,
        notesModalSubtitle: document.getElementById('notes-modal-subtitle')!,
        notesTextarea: document.getElementById('notes-textarea') as HTMLTextAreaElement,
        saveNoteBtn: document.getElementById('save-note-btn')!,
        resetAppBtn: document.getElementById('reset-app-btn')!,
        languagePrevBtn: document.getElementById('language-prev') as HTMLButtonElement,
        languageViewport: document.getElementById('language-viewport')!,
        languageReel: document.getElementById('language-reel')!,
        languageNextBtn: document.getElementById('language-next') as HTMLButtonElement,
        editHabitModal: document.getElementById('edit-habit-modal')!,
        editHabitModalTitle: document.getElementById('edit-habit-modal-title')!,
        editHabitForm: document.getElementById('edit-habit-form') as HTMLFormElement,
        editHabitSaveBtn: document.getElementById('edit-habit-save-btn') as HTMLButtonElement,
        habitTimeContainer: document.getElementById('habit-time-container')!,
        frequencyOptionsContainer: document.getElementById('frequency-options-container')!,
        syncStatus: document.getElementById('sync-status')!,
        syncSection: document.getElementById('sync-section')!,
        syncInactiveView: document.getElementById('sync-inactive-view')!,
        enableSyncBtn: document.getElementById('enable-sync-btn') as HTMLButtonElement,
        enterKeyViewBtn: document.getElementById('enter-key-view-btn') as HTMLButtonElement,
        syncEnterKeyView: document.getElementById('sync-enter-key-view')!,
        syncKeyInput: document.getElementById('sync-key-input') as HTMLInputElement,
        cancelEnterKeyBtn: document.getElementById('cancel-enter-key-btn') as HTMLButtonElement,
        submitKeyBtn: document.getElementById('submit-key-btn') as HTMLButtonElement,
        syncDisplayKeyView: document.getElementById('sync-display-key-view')!,
        syncKeyText: document.getElementById('sync-key-text')!,
        copyKeyBtn: document.getElementById('copy-key-btn') as HTMLButtonElement,
        keySavedBtn: document.getElementById('key-saved-btn') as HTMLButtonElement,
        syncActiveView: document.getElementById('sync-active-view')!,
        viewKeyBtn: document.getElementById('view-key-btn') as HTMLButtonElement,
        disableSyncBtn: document.getElementById('disable-sync-btn') as HTMLButtonElement,
        notificationToggle: document.getElementById('notification-toggle') as HTMLInputElement,
        notificationToggleLabel: document.getElementById('notification-toggle-label') as HTMLLabelElement,
        notificationStatusDesc: document.getElementById('notification-status-desc')!,
        iconPickerModal: document.getElementById('icon-picker-modal')!,
        iconPickerGrid: document.getElementById('icon-picker-grid')!,
        habitIconPickerBtn: document.getElementById('habit-icon-picker-btn') as HTMLButtonElement,
        colorPickerModal: document.getElementById('color-picker-modal')!,
        colorPickerGrid: document.getElementById('color-picker-grid')!,
        changeColorFromPickerBtn: document.getElementById('change-color-from-picker-btn') as HTMLButtonElement,
    });
}