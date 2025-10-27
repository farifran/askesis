/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { ui } from './ui';
import { state, LANGUAGES, Habit, STREAK_SEMI_CONSOLIDATED, STREAK_CONSOLIDATED, PredefinedHabit, saveState, PREDEFINED_HABITS, FREQUENCIES, TimeOfDay } from './state';
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
    // FIX: Import 'renderFrequencyFilter' to resolve 'Cannot find name' error.
    renderFrequencyFilter,
} from './render';
import {
    saveHabitFromModal,
    requestHabitPermanentDeletion,
    requestHabitEndingFromModal,
    handleSaveNote,
    resetApplicationData,
    graduateHabit,
    requestHabitEditingFromModal,
} from './habitActions';
import { t, setLanguage, getHabitDisplayInfo } from './i18n';
import { setupReelRotary } from './rotary';
import { simpleMarkdownToHTML } from './utils';
import { buildAIPrompt, fetchAIAnalysis } from './api';

type PendingHabitKey = 'pending21DayHabitIds' | 'pendingConsolidationHabitIds';

const showCelebrationModal = (titleKey: string, contentHTML: string, pendingListKey: PendingHabitKey) => {
    ui.aiModalTitle.textContent = t(titleKey);
    ui.aiResponse.innerHTML = contentHTML;

    const pendingHabits = state[pendingListKey];
    state.notificationsShown.push(...pendingHabits);
    state[pendingListKey] = [];
    saveState();

    renderAINotificationState();
    openModal(ui.aiModal);
};

const handleCelebrationCheck = (
    pendingListKey: PendingHabitKey, 
    titleKey: string, 
    bodyKey: string
): boolean => {
    const pendingIds = state[pendingListKey];
    if (pendingIds.length === 0) return false;

    const habitsToCelebrate = pendingIds
        .map(id => state.habits.find(h => h.id === id))
        .filter((h): h is Habit => !!h);
    
    if (habitsToCelebrate.length > 0) {
        const habitListHTML = habitsToCelebrate.map(h => `<li>${h.icon} ${getHabitDisplayInfo(h).name}</li>`).join('');
        const content = t(bodyKey, { habitList: habitListHTML });
        showCelebrationModal(titleKey, content, pendingListKey);
        return true;
    }
    return false;
};

const runAIEvaluation = async (analysisType: 'weekly' | 'monthly' | 'general') => {
    closeModal(ui.aiOptionsModal);

    if (!navigator.onLine) {
        state.lastAIError = `<p>${t('modalAIOfflineMessage')}</p>`;
        state.aiState = 'error';
        saveState();
        renderAINotificationState();
        ui.aiModalTitle.textContent = t('modalAIOfflineTitle');
        ui.aiResponse.innerHTML = state.lastAIError;
        ui.aiNewAnalysisBtn.style.display = 'block';
        openModal(ui.aiModal);
        return;
    }
    
    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    state.lastAIResult = null;
    state.lastAIError = null;
    renderAINotificationState();
    
    const prompt = buildAIPrompt(analysisType);
    ui.aiModalTitle.textContent = t('modalAITitle');
    ui.aiResponse.innerHTML = `
        <details>
            <summary>${t('promptShow')}</summary>
            <pre style="white-space: pre-wrap; word-wrap: break-word; font-size: 12px; background: var(--bg-color); padding: 8px; border-radius: 4px; margin-top: 8px;">${prompt}</pre>
        </details>
        <div id="ai-response-content" style="margin-top: 16px;">
            <div class="loader">${t('modalAILoading')}</div>
        </div>
    `;
    ui.aiNewAnalysisBtn.style.display = 'none';
    openModal(ui.aiModal);

    const responseContentEl = document.getElementById('ai-response-content');

    try {
        if (responseContentEl) responseContentEl.innerHTML = '';

        const fullText = await fetchAIAnalysis(prompt, (streamedText) => {
             if (responseContentEl) responseContentEl.innerHTML = simpleMarkdownToHTML(streamedText);
        });

        state.lastAIResult = fullText;
        state.aiState = 'completed';
    } catch (error) {
        console.error("AI Evaluation Error:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.lastAIError = `
            <p>${t('modalAIError')}</p>
            <p style="font-family: monospace; background: var(--bg-color); padding: 8px; border-radius: 4px; margin-top: 12px; font-size: 13px; color: var(--color-red); word-wrap: break-word;">
                <strong>${t('errorDetail')}:</strong> ${errorMessage}
            </p>
        `;
        state.aiState = 'error';
        if (responseContentEl) {
            responseContentEl.innerHTML = state.lastAIError;
        }
    } finally {
        saveState();
        renderAINotificationState();
        if (state.aiState !== 'loading') {
            ui.aiNewAnalysisBtn.style.display = 'block';
        }
    }
}


const handleAIEvaluationClick = async () => {
    // As celebrações de marco têm prioridade sobre a exibição de resultados de IA.
    if (handleCelebrationCheck('pendingConsolidationHabitIds', 'celebrationConsolidatedTitle', 'celebrationConsolidatedBody')) return;
    if (handleCelebrationCheck('pending21DayHabitIds', 'celebrationSemiConsolidatedTitle', 'celebrationSemiConsolidatedBody')) return;

    const showResult = () => {
        const isError = state.aiState === 'error';
        if (isError) {
            ui.aiModalTitle.textContent = t('modalAIError');
            ui.aiResponse.innerHTML = state.lastAIError!;
        } else { // 'completed'
            ui.aiModalTitle.textContent = t('modalAITitle');
            ui.aiResponse.innerHTML = simpleMarkdownToHTML(state.lastAIResult!);
        }
        ui.aiNewAnalysisBtn.style.display = 'block';
        openModal(ui.aiModal);
        
        // Marca como visto e remove a notificação
        if (!state.hasSeenAIResult) {
            state.hasSeenAIResult = true;
            saveState();
            renderAINotificationState();
        }
    };

    // Roteia a ação com base no estado atual da IA.
    switch (state.aiState) {
        case 'completed':
        case 'error':
            showResult();
            break;
        case 'idle':
            openModal(ui.aiOptionsModal);
            break;
        case 'loading':
            // O botão está desativado, então esta ação não deve ser acionada.
            break;
    }
};

const closeAIModalAndReset = () => {
    closeModal(ui.aiModal);
    state.aiState = 'idle';
    state.lastAIResult = null;
    state.lastAIError = null;
    state.hasSeenAIResult = true; // Garante que foi marcado como visto/resetado
    saveState(); // Salva o estado resetado
    renderAINotificationState();
};

export const setupModalListeners = () => {
    ui.manageHabitsBtn.addEventListener('click', () => {
        setupManageModal();
        renderLanguageFilter();
        
        // Abre o modal imediatamente.
        openModal(ui.manageModal);

        // A nova função lida com seu próprio estado de carregamento e atualiza a UI completamente.
        updateNotificationUI();
    });

    ui.fabAddHabit.addEventListener('click', () => {
        renderExploreHabits();
        openModal(ui.exploreModal);
    });
    ui.aiEvalBtn.addEventListener('click', handleAIEvaluationClick);

    // Initialize generic closing for modals that don't need special cleanup
    [ui.manageModal, ui.exploreModal, ui.confirmModal, ui.notesModal, ui.aiOptionsModal].forEach(initializeModalClosing);

    // Custom closing for the AI modal
    ui.aiModal.addEventListener('click', e => {
        if (e.target === ui.aiModal) {
             // Apenas fecha o modal, não reseta o estado, para que o usuário possa reabrir.
            closeModal(ui.aiModal);
        }
    });

    ui.aiModal.querySelector('.modal-close-btn')!.addEventListener('click', () => {
        // O botão 'Fechar' também apenas fecha o modal.
        closeModal(ui.aiModal);
    });

    // Custom closing for edit habit modal to handle back navigation
    const closeEditHabitModalWithBackNavigation = () => {
        const source = state.editingHabit?.sourceModal;
        
        closeModal(ui.editHabitModal);
        state.editingHabit = null; // Always clear state on close

        if (source === 'explore') {
            renderExploreHabits();
            openModal(ui.exploreModal);
        } else if (source === 'manage') {
            setupManageModal();
            openModal(ui.manageModal);
        }
    };

    ui.editHabitModal.addEventListener('click', e => {
        if (e.target === ui.editHabitModal) {
            closeEditHabitModalWithBackNavigation();
        }
    });

    ui.editHabitModal.querySelector<HTMLButtonElement>('.modal-close-btn')!.addEventListener('click', closeEditHabitModalWithBackNavigation);


    ui.exploreHabitList.addEventListener('click', e => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
        if (!item?.dataset.index) return;
        
        const predefinedHabit = PREDEFINED_HABITS[parseInt(item.dataset.index)];
        const existingHabit = state.habits.find(h => {
            const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
            return lastSchedule.nameKey === predefinedHabit.nameKey && !lastSchedule.endDate && !h.graduatedOn;
        });
        
        closeModal(ui.exploreModal);
        
        if (existingHabit) {
            openEditModal(existingHabit, 'explore');
        } else {
            openEditModal(predefinedHabit, 'explore');
        }
    });

    ui.createCustomHabitBtn.addEventListener('click', () => {
        closeModal(ui.exploreModal);
        openEditModal(null, 'explore');
    });

    ui.confirmModalConfirmBtn.addEventListener('click', () => {
        state.confirmAction?.();
        closeModal(ui.confirmModal);
        state.confirmAction = null;
        state.confirmEditAction = null;
    });

    ui.confirmModalEditBtn.addEventListener('click', () => {
        closeModal(ui.confirmModal);
        state.confirmEditAction?.();
        state.confirmAction = null;
        state.confirmEditAction = null;
    });

    ui.saveNoteBtn.addEventListener('click', handleSaveNote);
    ui.editHabitForm.addEventListener('submit', e => {
        e.preventDefault();
        saveHabitFromModal();
    });

    ui.habitList.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const btn = target.closest<HTMLButtonElement>('button');
        if (!btn?.dataset.habitId) return;

        const habitId = btn.dataset.habitId;
        if (btn.classList.contains('graduate-habit-btn')) graduateHabit(habitId);
        else if (btn.classList.contains('end-habit-btn')) requestHabitEndingFromModal(habitId);
        else if (btn.classList.contains('edit-habit-btn')) requestHabitEditingFromModal(habitId);
        else if (btn.classList.contains('permanent-delete-habit-btn')) requestHabitPermanentDeletion(habitId);
    });

    ui.resetAppBtn.addEventListener('click', () => {
        showConfirmationModal(t('confirmResetApp'), () => {
            resetApplicationData();
        });
    });

    ui.aiWeeklyCheckinBtn.addEventListener('click', () => runAIEvaluation('weekly'));
    ui.aiMonthlyReviewBtn.addEventListener('click', () => runAIEvaluation('monthly'));
    ui.aiGeneralAnalysisBtn.addEventListener('click', () => runAIEvaluation('general'));
    
    // O botão "Iniciar Nova Análise" agora reseta o estado da IA para permitir um novo ciclo.
    ui.aiNewAnalysisBtn.addEventListener('click', () => {
        closeAIModalAndReset();
        openModal(ui.aiOptionsModal);
    });

    // REATORAÇÃO: Usa o módulo rotary reutilizável para ambos os seletores
    setupReelRotary({
        viewportEl: ui.languageViewport,
        reelEl: ui.languageReel,
        prevBtn: ui.languagePrevBtn,
        nextBtn: ui.languageNextBtn,
        optionsCount: LANGUAGES.length,
        getInitialIndex: () => LANGUAGES.findIndex(l => l.code === state.activeLanguageCode),
        onIndexChange: async (index) => {
            await setLanguage(LANGUAGES[index].code);
        },
        render: renderLanguageFilter,
    });

    setupReelRotary({
        viewportEl: ui.frequencyViewport,
        reelEl: ui.frequencyReel,
        prevBtn: ui.frequencyPrevBtn,
        nextBtn: ui.frequencyNextBtn,
        optionsCount: FREQUENCIES.length,
        getInitialIndex: () => {
            if (!state.editingHabit) return 0;
            const currentFrequency = state.editingHabit.formData.frequency;
            const index = FREQUENCIES.findIndex(f => f.value.type === currentFrequency.type && f.value.interval === currentFrequency.interval);
            return Math.max(0, index);
        },
        onIndexChange: (index) => {
            if (!state.editingHabit) return;
            state.editingHabit.formData.frequency = FREQUENCIES[index].value;
            renderFrequencyFilter();
        },
        render: renderFrequencyFilter,
    });
};