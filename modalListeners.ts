/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído. A orquestração de eventos de modais é bem estruturada e robusta. Nenhuma outra análise é necessária.
import { ui } from './ui';
import { state, LANGUAGES, PREDEFINED_HABITS, FREQUENCIES, TimeOfDay, saveState, STREAK_SEMI_CONSOLIDATED, STREAK_CONSOLIDATED } from './state';
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
    translationKey: 'aiCelebration21Day' | 'aiCelebration66Day',
    // NOVO PARÂMETRO: O marco de streak para construir a chave de notificação correta.
    streakMilestone: number
): string => {
    if (pendingIds.length === 0) return '';
    
    const habitNames = pendingIds
        .map(id => state.habits.find(h => h.id === id))
        .filter(Boolean)
        .map(h => getHabitDisplayInfo(h!).name)
        .join(', ');
        
    // CORREÇÃO DE LÓGICA [2024-10-23]: Utiliza a chave composta ('habitId-dias') para marcar
    // as celebrações como "vistas", garantindo que cada marco seja rastreado independentemente.
    pendingIds.forEach(id => {
        const celebrationId = `${id}-${streakMilestone}`;
        if (!state.notificationsShown.includes(celebrationId)) {
            state.notificationsShown.push(celebrationId);
        }
    });

    return t(translationKey, { count: pendingIds.length, habitNames });
};


export function setupModalListeners() {
    // --- Inicialização Geral de Modais ---
    // REATORAÇÃO DE ESTADO [2024-10-26]: A inicialização de fechamento dos modais de edição
    // foi separada para incluir callbacks `onClose`. Isso previne "vazamentos de estado"
    // onde dados temporários (state.editingHabit, state.editingNoteFor) persistiam
    // desnecessariamente após o cancelamento, tornando a aplicação mais robusta.
    const modalsToInitialize = [
        ui.manageModal,
        ui.exploreModal,
        // Modais com estado temporário são movidos para inicializações customizadas abaixo
        // ui.editHabitModal,
        // ui.notesModal,
        ui.confirmModal,
        ui.aiOptionsModal,
    ];
    modalsToInitialize.forEach(modal => initializeModalClosing(modal));

    // Lida com o fechamento dos modais de edição para limpar o estado temporário
    initializeModalClosing(ui.editHabitModal, () => {
        state.editingHabit = null;
    });
    initializeModalClosing(ui.notesModal, () => {
        state.editingNoteFor = null;
    });

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
            { 
                confirmText: t('modalManageResetButton'), 
                title: t('modalManageReset'),
                // UX-FIX [2024-10-27]: Usa o estilo 'danger' para o botão de confirmação.
                confirmButtonStyle: 'danger'
            }
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
                celebrationText += _processAndFormatCelebrations(state.pending21DayHabitIds, 'aiCelebration21Day', STREAK_SEMI_CONSOLIDATED);
                celebrationText += _processAndFormatCelebrations(state.pendingConsolidationHabitIds, 'aiCelebration66Day', STREAK_CONSOLIDATED);

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