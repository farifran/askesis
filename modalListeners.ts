/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { ui } from './ui';
import { state, LANGUAGES, PREDEFINED_HABITS, FREQUENCIES, TimeOfDay, saveState } from './state';
import {
    openModal,
    closeModal,
    setupManageModal,
    renderExploreHabits,
    initializeModalClosing,
    showConfirmationModal,
    renderLanguageFilter,
    renderAINotificationState,
    openEditModal,
    updateNotificationUI,
    renderFrequencyFilter,
} from './render';
import {
    saveHabitFromModal,
    requestHabitEndingFromModal,
    requestHabitPermanentDeletion,
    requestHabitEditingFromModal,
    resetApplicationData,
    handleSaveNote,
    graduateHabit,
    performAIAnalysis,
} from './habitActions';
import { setLanguage, t, getHabitDisplayInfo } from './i18n';
import { setupReelRotary } from './rotary';
import { simpleMarkdownToHTML, pushToOneSignal } from './utils';

// REFACTOR [2024-09-02]: Centraliza a lógica de processamento e formatação de celebrações
// para remover duplicação de código e melhorar a legibilidade no listener do botão de IA.
const _processAndFormatCelebrations = (
    pendingIds: string[], 
    translationKey: 'aiCelebration21Day' | 'aiCelebration66Day'
): string => {
    if (pendingIds.length === 0) return '';
    
    const habitNames = pendingIds
        .map(id => state.habits.find(h => h.id === id))
        .filter(Boolean)
        .map(h => getHabitDisplayInfo(h!).name)
        .join(', ');
        
    // Marca as celebrações como "vistas"
    pendingIds.forEach(id => {
        if (!state.notificationsShown.includes(id)) {
            state.notificationsShown.push(id);
        }
    });

    return t(translationKey, { count: pendingIds.length, habitNames });
};


export function setupModalListeners() {
    // --- Inicialização Geral de Modais ---
    const modalsToInitialize = [
        ui.manageModal,
        ui.exploreModal,
        ui.editHabitModal,
        ui.confirmModal,
        ui.notesModal,
        ui.aiOptionsModal,
    ];
    // REFACTOR [2024-08-18]: Utiliza a função `initializeModalClosing` aprimorada para todos os modais,
    // eliminando a lógica de fechamento duplicada para o modal de IA e centralizando o padrão de fechamento.
    modalsToInitialize.forEach(modal => initializeModalClosing(modal));

    // A lógica de fechamento customizada para o modal de IA agora é injetada como um callback.
    initializeModalClosing(ui.aiModal, () => {
        state.hasSeenAIResult = true;
        renderAINotificationState();
    });

    // --- Botões para Abrir Modais Principais ---
    ui.manageHabitsBtn.addEventListener('click', () => {
        setupManageModal();
        updateNotificationUI();
        openModal(ui.manageModal);
    });

    ui.fabAddHabit.addEventListener('click', () => {
        renderExploreHabits();
        openModal(ui.exploreModal);
    });
    
    // --- Modal de Gerenciamento de Hábitos (Manage) ---
    ui.habitList.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const button = target.closest<HTMLButtonElement>('button');
        if (!button) return;

        const habitId = button.closest<HTMLLIElement>('li.habit-list-item')?.dataset.habitId;
        if (!habitId) return;

        if (button.classList.contains('end-habit-btn')) {
            requestHabitEndingFromModal(habitId);
        } else if (button.classList.contains('permanent-delete-habit-btn')) {
            requestHabitPermanentDeletion(habitId);
        } else if (button.classList.contains('edit-habit-btn')) {
            requestHabitEditingFromModal(habitId);
        } else if (button.classList.contains('graduate-habit-btn')) {
            graduateHabit(habitId);
        }
    });

    ui.resetAppBtn.addEventListener('click', () => {
        showConfirmationModal(
            t('confirmResetApp'),
            resetApplicationData,
            { confirmText: t('modalManageResetButton'), title: t('modalManageReset') }
        );
    });
    
    // --- Seletor de Idioma ---
    setupReelRotary({
        viewportEl: ui.languageViewport,
        reelEl: ui.languageReel,
        prevBtn: ui.languagePrevBtn,
        nextBtn: ui.languageNextBtn,
        optionsCount: LANGUAGES.length,
        getInitialIndex: () => LANGUAGES.findIndex(l => l.code === state.activeLanguageCode),
        onIndexChange: async (index) => {
            const newLang = LANGUAGES[index].code;
            if (newLang !== state.activeLanguageCode) {
                await setLanguage(newLang);
            }
        },
        render: renderLanguageFilter,
    });
    
    // Toggle de Notificações
    ui.notificationToggle.addEventListener('change', async () => {
        pushToOneSignal(async (OneSignal: any) => {
            const isPushEnabled = OneSignal.User.PushSubscription.optedIn;
            if (isPushEnabled) {
                await OneSignal.User.PushSubscription.optOut();
            } else {
                await OneSignal.Notifications.requestPermission();
            }
            // A UI será atualizada pelo listener de 'permissionChange'
        });
    });


    // --- Modal de Exploração de Hábitos (Explore) ---
    ui.exploreHabitList.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
        if (item?.dataset.index) {
            const habitTemplate = PREDEFINED_HABITS[parseInt(item.dataset.index, 10)];
            if (habitTemplate) {
                openEditModal(habitTemplate);
                closeModal(ui.exploreModal);
            }
        }
    });

    ui.createCustomHabitBtn.addEventListener('click', () => {
        openEditModal(null);
        closeModal(ui.exploreModal);
    });

    // --- Modal de Edição de Hábito ---
    ui.editHabitForm.addEventListener('submit', (e) => {
        e.preventDefault();
        saveHabitFromModal();
    });
    
    // --- Seletor de Frequência ---
    setupReelRotary({
        viewportEl: ui.frequencyViewport,
        reelEl: ui.frequencyReel,
        prevBtn: ui.frequencyPrevBtn,
        nextBtn: ui.frequencyNextBtn,
        optionsCount: FREQUENCIES.length,
        getInitialIndex: () => {
            if (!state.editingHabit) return 0;
            const currentFreq = state.editingHabit.formData.frequency;
            const index = FREQUENCIES.findIndex(f => f.value.type === currentFreq.type && f.value.interval === currentFreq.interval);
            return Math.max(0, index); // Garante que não seja -1
        },
        onIndexChange: (index) => {
            if (state.editingHabit) {
                state.editingHabit.formData.frequency = FREQUENCIES[index].value;
            }
        },
        render: renderFrequencyFilter,
    });

    // --- Modal de Confirmação ---
    ui.confirmModalConfirmBtn.addEventListener('click', () => {
        state.confirmAction?.();
        closeModal(ui.confirmModal);
    });

    ui.confirmModalEditBtn.addEventListener('click', () => {
        state.confirmEditAction?.();
        closeModal(ui.confirmModal);
    });

    // --- Modal de Anotações ---
    ui.saveNoteBtn.addEventListener('click', handleSaveNote);
    ui.notesTextarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            handleSaveNote();
        }
    });
    
    // --- Modais de IA ---
    ui.aiEvalBtn.addEventListener('click', () => {
        if ((state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult) {
            ui.aiResponse.innerHTML = state.lastAIResult 
                ? simpleMarkdownToHTML(state.lastAIResult)
                : `<p class="ai-error-message">${t('aiErrorPrefix')}: ${state.lastAIError}</p>`;
            openModal(ui.aiModal);
            state.hasSeenAIResult = true;
            renderAINotificationState();
        } else {
            const hasCelebrations = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0;
            if (hasCelebrations) {
                let celebrationText = '';
                celebrationText += _processAndFormatCelebrations(state.pending21DayHabitIds, 'aiCelebration21Day');
                celebrationText += _processAndFormatCelebrations(state.pendingConsolidationHabitIds, 'aiCelebration66Day');

                // Limpa as listas de pendentes após o processamento
                state.pending21DayHabitIds = [];
                state.pendingConsolidationHabitIds = [];
                saveState();
                
                ui.aiResponse.innerHTML = simpleMarkdownToHTML(celebrationText);
                openModal(ui.aiModal);
                state.hasSeenAIResult = true; // Marca como visto
                renderAINotificationState();
            } else {
                openModal(ui.aiOptionsModal);
            }
        }
    });

    // REATORAÇÃO: Listener único para as opções de IA
    const aiOptionsList = ui.aiOptionsModal.querySelector('.ai-options-list');
    aiOptionsList?.addEventListener('click', (e) => {
        const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.ai-option-btn');
        const analysisType = button?.dataset.analysisType as 'weekly' | 'monthly' | 'general' | undefined;
        if (analysisType) {
            performAIAnalysis(analysisType);
        }
    });
}