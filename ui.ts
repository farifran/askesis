// ui.ts
type UIElements = {
    calendarStrip: HTMLElement;
    headerTitle: HTMLElement;
    timeFilterPrev: HTMLButtonElement;
    timeFilterViewport: HTMLElement;
    timeFilterReel: HTMLElement;
    timeFilterNext: HTMLButtonElement;
    habitContainer: HTMLElement;
    manageHabitsBtn: HTMLElement;
    fabAddHabit: HTMLElement;
    manageModal: HTMLElement;
    exploreModal: HTMLElement;
    exploreHabitList: HTMLElement;
    createCustomHabitBtn: HTMLElement;
    // FIX: Changed type to HTMLButtonElement to allow access to the 'disabled' property.
    aiEvalBtn: HTMLButtonElement;
    aiModal: HTMLElement;
    aiModalTitle: HTMLElement;
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
};

// Exporta um objeto shell, mas tipado como se já estivesse preenchido.
// Este é um contrato de que initUI() DEVE ser chamado antes de qualquer propriedade ser acessada.
export const ui = {} as UIElements;

// Esta função será chamada assim que o DOM estiver pronto para preencher o objeto ui.
export function initUI(): void {
    Object.assign(ui, {
        calendarStrip: document.getElementById('calendar-strip')!,
        headerTitle: document.getElementById('header-title')!,
        timeFilterPrev: document.getElementById('time-filter-prev') as HTMLButtonElement,
        timeFilterViewport: document.getElementById('time-filter-viewport')!,
        timeFilterReel: document.getElementById('time-filter-reel')!,
        timeFilterNext: document.getElementById('time-filter-next') as HTMLButtonElement,
        habitContainer: document.getElementById('habit-container')!,
        manageHabitsBtn: document.getElementById('manage-habits-btn')!,
        fabAddHabit: document.getElementById('fab-add-habit')!,
        manageModal: document.getElementById('manage-modal')!,
        exploreModal: document.getElementById('explore-modal')!,
        exploreHabitList: document.getElementById('explore-habit-list')!,
        createCustomHabitBtn: document.getElementById('create-custom-habit-btn')!,
        // FIX: Added cast to HTMLButtonElement to match the type in UIElements.
        aiEvalBtn: document.getElementById('ai-eval-btn') as HTMLButtonElement,
        aiModal: document.getElementById('ai-modal')!,
        aiModalTitle: document.getElementById('ai-modal-title')!,
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
    });
}