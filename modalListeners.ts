/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { ui } from './ui';
import { state, LANGUAGES, Habit, STREAK_SEMI_CONSOLIDATED, STREAK_CONSOLIDATED, PredefinedHabit, saveState, PREDEFINED_HABITS, FREQUENCIES, TIMES_OF_DAY } from './state';
import {
    openModal,
    closeModal,
    setupManageModal,
    renderExploreHabits,
    initializeModalClosing,
    showConfirmationModal,
    renderLanguageFilter,
    renderAINotificationState,
    showInlineNotice,
    openEditModal,
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
import { getAIEvaluationStream, buildAIPrompt } from './api';
import { t, setLanguage, getHabitDisplayInfo } from './i18n';
import { setupReelRotary } from './rotary';

function simpleMarkdownToHTML(text: string): string {
    const lines = text.split('\n');
    let html = '';
    let inList = false;

    for (const line of lines) {
        const trimmedLine = line.trim();
        let processedLine = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        const isListItem = trimmedLine.startsWith('* ') || trimmedLine.startsWith('- ');

        if (isListItem) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            html += `<li>${processedLine.trim().substring(2)}</li>`;
        } else {
            if (inList) {
                html += '</ul>';
                inList = false;
            }
            if (trimmedLine.length > 0) html += `<p>${processedLine}</p>`;
        }
    }
    if (inList) html += '</ul>';
    return html;
}

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
        renderAINotificationState();
        ui.aiModalTitle.textContent = t('modalAIOfflineTitle');
        ui.aiResponse.innerHTML = state.lastAIError;
        ui.aiNewAnalysisBtn.style.display = 'block';
        openModal(ui.aiModal);
        return;
    }
    
    state.aiState = 'loading';
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
        const responseStream = getAIEvaluationStream(prompt);
        let fullText = '';
        if (responseContentEl) responseContentEl.innerHTML = '';
        for await (const chunk of responseStream) {
            fullText += chunk.text;
            if (responseContentEl) responseContentEl.innerHTML = simpleMarkdownToHTML(fullText);
        }
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

    // Roteia a ação com base no estado atual da IA.
    switch (state.aiState) {
        case 'completed':
            ui.aiModalTitle.textContent = t('modalAITitle');
            ui.aiResponse.innerHTML = simpleMarkdownToHTML(state.lastAIResult!);
            ui.aiNewAnalysisBtn.style.display = 'block';
            openModal(ui.aiModal);
            break;
        case 'error':
            ui.aiModalTitle.textContent = t('modalAIError');
            ui.aiResponse.innerHTML = state.lastAIError!;
            ui.aiNewAnalysisBtn.style.display = 'block';
            openModal(ui.aiModal);
            break;
        case 'idle':
            openModal(ui.aiOptionsModal);
            break;
        case 'loading':
            // O botão está desativado, então esta ação não deve ser acionada.
            // Nenhuma ação é necessária como fallback.
            break;
    }
};

export const setupModalListeners = () => {
    ui.manageHabitsBtn.addEventListener('click', () => {
        setupManageModal();
        renderLanguageFilter();
        openModal(ui.manageModal);
    });
    ui.fabAddHabit.addEventListener('click', () => {
        renderExploreHabits();
        openModal(ui.exploreModal);
    });
    ui.aiEvalBtn.addEventListener('click', handleAIEvaluationClick);

    [ui.manageModal, ui.exploreModal, ui.aiModal, ui.confirmModal, ui.notesModal, ui.editHabitModal, ui.aiOptionsModal].forEach(initializeModalClosing);

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
            openEditModal(existingHabit);
        } else {
            openEditModal(predefinedHabit);
        }
    });

    ui.createCustomHabitBtn.addEventListener('click', () => {
        closeModal(ui.exploreModal);
        openEditModal(null);
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
        closeModal(ui.manageModal);
        showConfirmationModal(t('confirmResetApp'), resetApplicationData);
    });

    ui.aiWeeklyCheckinBtn.addEventListener('click', () => runAIEvaluation('weekly'));
    ui.aiMonthlyReviewBtn.addEventListener('click', () => runAIEvaluation('monthly'));
    ui.aiGeneralAnalysisBtn.addEventListener('click', () => runAIEvaluation('general'));
    
    ui.aiNewAnalysisBtn.addEventListener('click', () => {
        state.aiState = 'idle';
        state.lastAIResult = null;
        state.lastAIError = null;
        renderAINotificationState();
        closeModal(ui.aiModal);
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