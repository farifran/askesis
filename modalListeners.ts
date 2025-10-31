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
} from './habitActions';
import { setLanguage, t, getHabitDisplayInfo } from './i18n';
import { buildAIPrompt } from './api';
import { setupReelRotary } from './rotary';
import { simpleMarkdownToHTML, pushToOneSignal } from './utils';

export function setupModalListeners() {
    // --- Inicialização Geral de Modais ---
    const allModals = [
        ui.manageModal,
        ui.exploreModal,
        ui.editHabitModal,
        ui.confirmModal,
        ui.notesModal,
        ui.aiModal,
        ui.aiOptionsModal,
    ];
    allModals.forEach(initializeModalClosing);

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
    const handleAIClick = (analysisType: 'weekly' | 'monthly' | 'general') => {
        return async () => {
            state.aiState = 'loading';
            renderAINotificationState();
            ui.aiResponse.innerHTML = '<div class="spinner"></div>'; // Mostra um spinner
            closeModal(ui.aiOptionsModal);
            openModal(ui.aiModal);

            try {
                const promptData = buildAIPrompt(analysisType);
                
                // Lógica de fetch in-line
                const response = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(promptData),
                });
    
                if (!response.ok) {
                    const errorBody = await response.json().catch(() => ({ error: 'Failed to parse error response' }));
                    throw new Error(`API request failed with status ${response.status}: ${errorBody.error || 'Unknown error'}`);
                }
    
                const reader = response.body?.getReader();
                if (!reader) {
                    throw new Error('Failed to get response reader');
                }
    
                const decoder = new TextDecoder();
                let fullText = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value, { stream: true });
                    fullText += chunk;
                    ui.aiResponse.innerHTML = simpleMarkdownToHTML(fullText);
                }
                
                state.lastAIResult = fullText;
                state.lastAIError = null;
                state.aiState = 'completed';
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : t('aiErrorUnknown');
                ui.aiResponse.innerHTML = `<p class="ai-error-message">${t('aiErrorPrefix')}: ${errorMessage}</p>`;
                state.lastAIResult = null;
                state.lastAIError = errorMessage;
                state.aiState = 'error';
            } finally {
                state.hasSeenAIResult = false;
                renderAINotificationState();
            }
        };
    };

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
                if (state.pending21DayHabitIds.length > 0) {
                    const habitNames = state.pending21DayHabitIds
                        .map(id => state.habits.find(h => h.id === id))
                        .filter(Boolean)
                        .map(h => getHabitDisplayInfo(h!).name).join(', ');
                    celebrationText += t('aiCelebration21Day', { count: state.pending21DayHabitIds.length, habitNames });
                }
                if (state.pendingConsolidationHabitIds.length > 0) {
                    const habitNames = state.pendingConsolidationHabitIds
                        .map(id => state.habits.find(h => h.id === id))
                        .filter(Boolean)
                        .map(h => getHabitDisplayInfo(h!).name).join(', ');
                    celebrationText += t('aiCelebration66Day', { count: state.pendingConsolidationHabitIds.length, habitNames });
                }

                state.pending21DayHabitIds.forEach(id => { if (!state.notificationsShown.includes(id)) state.notificationsShown.push(id); });
                state.pendingConsolidationHabitIds.forEach(id => { if (!state.notificationsShown.includes(id)) state.notificationsShown.push(id); });
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
    
    // Close AI modal logic
    const closeAIModal = () => {
        closeModal(ui.aiModal);
        state.hasSeenAIResult = true;
        renderAINotificationState();
    };
    
    ui.aiModal.addEventListener('click', e => {
        if (e.target === ui.aiModal) closeAIModal();
    });
    ui.aiModal.querySelector<HTMLElement>('.modal-close-btn')?.addEventListener('click', closeAIModal);


    ui.aiWeeklyCheckinBtn.addEventListener('click', handleAIClick('weekly'));
    ui.aiMonthlyReviewBtn.addEventListener('click', handleAIClick('monthly'));
    ui.aiGeneralAnalysisBtn.addEventListener('click', handleAIClick('general'));

}