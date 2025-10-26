// ui.ts
type UIElements = {
    calendarStrip: HTMLElement;
    headerTitle: HTMLElement;
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
    aiModalTitle: HTMLElement;
    aiOptionsModal: HTMLElement;
    aiWeeklyCheckinBtn: HTMLButtonElement;
    aiMonthlyReviewBtn: HTMLButtonElement;
    aiGeneralAnalysisBtn: HTMLButtonElement;
    aiNewAnalysisBtn: HTMLButtonElement;
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
    frequencyPrevBtn: HTMLButtonElement;
    frequencyViewport: HTMLElement;
    frequencyReel: HTMLElement;
    frequencyNextBtn: HTMLButtonElement;
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
    notificationToggleInput: HTMLInputElement;
    notificationToggleLabel: HTMLSpanElement;
    notificationToggleDesc: HTMLSpanElement;
};

export const ui = {} as UIElements;

export function initUI(): void {
    Object.assign(ui, {
        calendarStrip: document.getElementById('calendar-strip')!,
        headerTitle: document.getElementById('header-title')!,
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
        aiModalTitle: document.getElementById('ai-modal-title')!,
        aiOptionsModal: document.getElementById('ai-options-modal')!,
        aiWeeklyCheckinBtn: document.getElementById('ai-weekly-checkin-btn') as HTMLButtonElement,
        aiMonthlyReviewBtn: document.getElementById('ai-monthly-review-btn') as HTMLButtonElement,
        aiGeneralAnalysisBtn: document.getElementById('ai-general-analysis-btn') as HTMLButtonElement,
        aiNewAnalysisBtn: document.getElementById('ai-new-analysis-btn') as HTMLButtonElement,
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
        frequencyPrevBtn: document.getElementById('frequency-prev') as HTMLButtonElement,
        frequencyViewport: document.getElementById('frequency-viewport')!,
        frequencyReel: document.getElementById('frequency-reel')!,
        frequencyNextBtn: document.getElementById('frequency-next') as HTMLButtonElement,
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
        notificationToggleInput: document.getElementById('notification-toggle-input') as HTMLInputElement,
        notificationToggleLabel: document.getElementById('label-notifications') as HTMLSpanElement,
        notificationToggleDesc: document.getElementById('label-notifications-desc') as HTMLSpanElement,
    });
}