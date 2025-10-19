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

const handleAIEvaluationClick = async () => {
    if (handleCelebrationCheck('pendingConsolidationHabitIds', 'celebrationConsolidatedTitle', 'celebrationConsolidatedBody')) return;
    if (handleCelebrationCheck('pending21DayHabitIds', 'celebrationSemiConsolidatedTitle', 'celebrationSemiConsolidatedBody')) return;

    if (!navigator.onLine) {
        ui.aiModalTitle.textContent = t('modalAIOfflineTitle');
        ui.aiResponse.innerHTML = `<p>${t('modalAIOfflineMessage')}</p>`;
        openModal(ui.aiModal);
        return;
    }

    const prompt = buildAIPrompt();

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
    openModal(ui.aiModal);
    
    ui.aiEvalBtn.disabled = true;
    ui.aiEvalBtn.classList.add('loading');
    const responseContentEl = document.getElementById('ai-response-content');
    
    try {
        const responseStream = getAIEvaluationStream(prompt);
        let fullText = '';
        if (responseContentEl) responseContentEl.innerHTML = '';
        for await (const chunk of responseStream) {
            fullText += chunk.text;
            if (responseContentEl) responseContentEl.innerHTML = simpleMarkdownToHTML(fullText);
        }
    } catch (error) {
        console.error("AI Evaluation Error:", error);
        if (responseContentEl) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            responseContentEl.innerHTML = `
                <p>${t('modalAIError')}</p>
                <p style="font-family: monospace; background: var(--bg-color); padding: 8px; border-radius: 4px; margin-top: 12px; font-size: 13px; color: var(--color-red); word-wrap: break-word;">
                    <strong>${t('errorDetail')}:</strong> ${errorMessage}
                </p>
            `;
        }
    } finally {
        ui.aiEvalBtn.disabled = false;
        ui.aiEvalBtn.classList.remove('loading');
    }
};

const setupLanguageFilterListeners = () => {
    const handleLanguageChange = async (direction: 'next' | 'prev') => {
        const currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
        let nextIndex;
        if (direction === 'next') {
            nextIndex = (currentIndex + 1) % LANGUAGES.length;
        } else {
            nextIndex = (currentIndex - 1 + LANGUAGES.length) % LANGUAGES.length;
        }
        await setLanguage(LANGUAGES[nextIndex].code);
        renderLanguageFilter();
    };

    ui.languagePrevBtn.addEventListener('click', () => handleLanguageChange('prev'));
    ui.languageNextBtn.addEventListener('click', () => handleLanguageChange('next'));
    ui.languageViewport.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') handleLanguageChange('next');
        else if (e.key === 'ArrowLeft') handleLanguageChange('prev');
    });

    let startX = 0;
    let isSwiping = false;
    let startTransformX = 0;
    let itemWidth = 95;
    const SWIPE_THRESHOLD = 40;

    const pointerMove = (e: PointerEvent) => {
        if (!isSwiping) return;
        const currentX = e.clientX;
        const diffX = currentX - startX;
        const newTranslateX = startTransformX + diffX;
        const minTranslateX = -(LANGUAGES.length - 1) * itemWidth;
        const maxTranslateX = 0;
        const clampedTranslateX = Math.max(minTranslateX, Math.min(maxTranslateX, newTranslateX));
        ui.languageReel.style.transform = `translateX(${clampedTranslateX}px)`;
    };

    const pointerUp = async (e: PointerEvent) => {
        if (!isSwiping) return;
        const currentX = e.clientX;
        const diffX = currentX - startX;
        let currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
        
        if (Math.abs(diffX) > SWIPE_THRESHOLD) {
            if (diffX < 0) currentIndex = Math.min(LANGUAGES.length - 1, currentIndex + 1);
            else currentIndex = Math.max(0, currentIndex - 1);
            await setLanguage(LANGUAGES[currentIndex].code);
        }
        renderLanguageFilter();

        setTimeout(() => {
            ui.languageReel.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
        }, 50);

        window.removeEventListener('pointermove', pointerMove);
        window.removeEventListener('pointerup', pointerUp);
        isSwiping = false;
    };

    ui.languageViewport.addEventListener('pointerdown', (e: PointerEvent) => {
        startX = e.clientX;
        isSwiping = true;
        const firstOption = ui.languageReel.querySelector('.reel-option') as HTMLElement | null;
        itemWidth = firstOption?.offsetWidth || 95;
        const currentStyle = window.getComputedStyle(ui.languageReel);
        const matrix = new DOMMatrix(currentStyle.transform);
        startTransformX = matrix.m41;
        ui.languageReel.style.transition = 'none';
        window.addEventListener('pointermove', pointerMove);
        window.addEventListener('pointerup', pointerUp);
    });
};

const setupFrequencyFilterListeners = () => {
    const handleFrequencyChange = (direction: 'next' | 'prev') => {
        if (!state.editingHabit) return;
        const currentFrequency = state.editingHabit.habitData.frequency;
        const currentIndex = FREQUENCIES.findIndex(f => f.value.type === currentFrequency.type && f.value.interval === currentFrequency.interval);
        let nextIndex;
        if (direction === 'next') nextIndex = (currentIndex + 1) % FREQUENCIES.length;
        else nextIndex = (currentIndex - 1 + FREQUENCIES.length) % FREQUENCIES.length;
        state.editingHabit.habitData.frequency = FREQUENCIES[nextIndex].value;
        renderFrequencyFilter();
    };
    ui.frequencyPrevBtn.addEventListener('click', () => handleFrequencyChange('prev'));
    ui.frequencyNextBtn.addEventListener('click', () => handleFrequencyChange('next'));
    ui.frequencyViewport.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') handleFrequencyChange('next');
        else if (e.key === 'ArrowLeft') handleFrequencyChange('prev');
    });
    
    let startX = 0, isSwiping = false, startTransformX = 0;
    let itemWidth = 125;
    const SWIPE_THRESHOLD = 50;
    const pointerMove = (e: PointerEvent) => {
        if (!isSwiping) return;
        const diffX = e.clientX - startX;
        const newTranslateX = startTransformX + diffX;
        const minTranslateX = -(FREQUENCIES.length - 1) * itemWidth;
        const clampedTranslateX = Math.max(minTranslateX, Math.min(0, newTranslateX));
        ui.frequencyReel.style.transform = `translateX(${clampedTranslateX}px)`;
    };
    const pointerUp = (e: PointerEvent) => {
        if (!isSwiping || !state.editingHabit) return;
        const diffX = e.clientX - startX;
        const currentFrequency = state.editingHabit.habitData.frequency;
        let currentIndex = FREQUENCIES.findIndex(f => f.value.type === currentFrequency.type && f.value.interval === currentFrequency.interval);
        if (Math.abs(diffX) > SWIPE_THRESHOLD) {
            if (diffX < 0) currentIndex = Math.min(FREQUENCIES.length - 1, currentIndex + 1);
            else currentIndex = Math.max(0, currentIndex - 1);
            state.editingHabit.habitData.frequency = FREQUENCIES[currentIndex].value;
        }
        renderFrequencyFilter();
        setTimeout(() => { ui.frequencyReel.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)'; }, 50);
        window.removeEventListener('pointermove', pointerMove);
        window.removeEventListener('pointerup', pointerUp);
        isSwiping = false;
    };
    ui.frequencyViewport.addEventListener('pointerdown', (e: PointerEvent) => {
        startX = e.clientX;
        isSwiping = true;
        const firstOption = ui.frequencyReel.querySelector('.reel-option') as HTMLElement | null;
        itemWidth = firstOption?.offsetWidth || 125;
        const matrix = new DOMMatrix(window.getComputedStyle(ui.frequencyReel).transform);
        startTransformX = matrix.m41;
        ui.frequencyReel.style.transition = 'none';
        window.addEventListener('pointermove', pointerMove);
        window.addEventListener('pointerup', pointerUp);
    });
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

    [ui.manageModal, ui.exploreModal, ui.aiModal, ui.confirmModal, ui.notesModal, ui.editHabitModal].forEach(initializeModalClosing);

    ui.exploreHabitList.addEventListener('click', e => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
        if (!item?.dataset.index) return;
        
        const predefinedHabit = PREDEFINED_HABITS[parseInt(item.dataset.index)];
        const existingHabit = state.habits.find(h => h.nameKey === predefinedHabit.nameKey && !h.endedOn && !h.graduatedOn);
        
        closeModal(ui.exploreModal);
        
        if (existingHabit) {
            // If habit already exists, open it for editing
            openEditModal(existingHabit);
        } else {
            // Otherwise, open a new one from the template
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

    setupLanguageFilterListeners();
    setupFrequencyFilterListeners();
};