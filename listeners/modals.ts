
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from '../render/ui';
import { state, LANGUAGES, PREDEFINED_HABITS, STREAK_SEMI_CONSOLIDATED, STREAK_CONSOLIDATED, saveState, DAYS_IN_CALENDAR, invalidateChartCache } from '../state';
import {
    openModal,
    closeModal,
    setupManageModal,
    renderExploreHabits,
    showConfirmationModal,
    renderLanguageFilter,
    renderAINotificationState,
    openEditModal,
    updateNotificationUI,
    renderFrequencyOptions,
    renderIconPicker,
    renderColorPicker,
    renderFullCalendar,
    renderApp,
} from '../render';
import {
    saveHabitFromModal,
    requestHabitEndingFromModal,
    requestHabitPermanentDeletion,
    requestHabitEditingFromModal,
    resetApplicationData,
    handleSaveNote,
    graduateHabit,
    performAIAnalysis,
    exportData,
    importData,
    requestHabitRestoration,
} from '../habitActions';
import { setLanguage, t, getHabitDisplayInfo } from '../i18n';
import { setupReelRotary } from '../render/rotary';
import { simpleMarkdownToHTML, pushToOneSignal, getContrastColor, addDays, parseUTCIsoDate, toUTCIsoDateString, getDateTimeFormat } from '../utils';
import { icons, getTimeOfDayIcon } from '../render/icons';
import { TimeOfDay, FREQUENCIES, TIMES_OF_DAY } from '../state';
import { setTextContent, updateReelRotaryARIA } from '../render/dom';
import { Habit, HabitTemplate, Frequency, PredefinedHabit } from '../state';
import { getTimeOfDayName } from '../i18n';

// REFACTOR [2024-09-02]: Centraliza a lógica de processamento e formatação de celebrações
const _processAndFormatCelebrations = (
    pendingIds: string[], 
    translationKey: 'aiCelebration21Day' | 'aiCelebration66Day',
    streakMilestone: number
): string => {
    if (pendingIds.length === 0) return '';
    
    const habitNames = pendingIds
        .map(id => state.habits.find(h => h.id === id))
        .filter(Boolean)
        .map(h => getHabitDisplayInfo(h!).name)
        .join(', ');
        
    pendingIds.forEach(id => {
        const celebrationId = `${id}-${streakMilestone}`;
        if (!state.notificationsShown.includes(celebrationId)) {
            state.notificationsShown.push(celebrationId);
        }
    });

    return t(translationKey, { count: pendingIds.length, habitNames });
};

// --- PRIVATE HELPERS (MODAL FORMS) ---

function _handleFrequencyTypeChange(radio: HTMLInputElement) {
    if (!state.editingHabit) return;

    const type = radio.value as 'daily' | 'interval' | 'specific_days_of_week';
    switch (type) {
        case 'daily':
            state.editingHabit.formData.frequency = { type: 'daily' };
            break;
        case 'specific_days_of_week':
            const currentFreq = state.editingHabit.formData.frequency;
            const days = currentFreq.type === 'specific_days_of_week' ? currentFreq.days : [];
            state.editingHabit.formData.frequency = { type: 'specific_days_of_week', days };
            break;
        case 'interval':
            const intervalFreqTpl = FREQUENCIES.find(f => f.value.type === 'interval')!.value as { type: 'interval', unit: 'days' | 'weeks', amount: number };
            const currentIntervalFreq = state.editingHabit.formData.frequency;
            const amount = (currentIntervalFreq.type === 'interval' ? currentIntervalFreq.amount : intervalFreqTpl.amount);
            const unit = (currentIntervalFreq.type === 'interval' ? currentIntervalFreq.unit : intervalFreqTpl.unit);
            state.editingHabit.formData.frequency = { type: 'interval', amount, unit };
            break;
    }
    renderFrequencyOptions();
}

function _handleWeekdaySelectionChange() {
    if (!state.editingHabit) return;

    const days = Array.from(ui.frequencyOptionsContainer.querySelectorAll<HTMLInputElement>('.weekday-picker input:checked'))
        .map(el => parseInt(el.dataset.day!, 10));
    state.editingHabit.formData.frequency = { type: 'specific_days_of_week', days };
}

function _handleIntervalControlChange(button: HTMLButtonElement) {
    if (!state.editingHabit || state.editingHabit.formData.frequency.type !== 'interval') return;

    const action = button.dataset.action;
    const currentFreq = state.editingHabit.formData.frequency;
    let { amount, unit } = currentFreq;

    if (action === 'interval-decrement') amount = Math.max(1, amount - 1);
    if (action === 'interval-increment') amount = Math.min(99, amount + 1);
    if (action === 'interval-unit-toggle') unit = unit === 'days' ? 'weeks' : 'days';

    state.editingHabit.formData.frequency = { type: 'interval', amount, unit };
    renderFrequencyOptions();
}

function _validateHabitName(newName: string, currentHabitId?: string): boolean {
    const formNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice')!;
    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;

    formNoticeEl.classList.remove('visible');
    habitNameInput.classList.remove('shake');

    if (newName.length === 0) {
        formNoticeEl.textContent = t('noticeNameCannotBeEmpty');
        formNoticeEl.classList.add('visible');
        
        requestAnimationFrame(() => {
            habitNameInput.classList.add('shake');
            habitNameInput.addEventListener('animationend', () => {
                habitNameInput.classList.remove('shake');
            }, { once: true });
        });
        
        return false;
    }

    if (newName.length > 16) {
        formNoticeEl.textContent = t('noticeNameTooLong');
        formNoticeEl.classList.add('visible');
        
        requestAnimationFrame(() => {
            habitNameInput.classList.add('shake');
            habitNameInput.addEventListener('animationend', () => {
                habitNameInput.classList.remove('shake');
            }, { once: true });
        });
        
        return false;
    }

    return true;
}


export function setupModalListeners() {
    ui.manageHabitsBtn.addEventListener('click', () => {
        setupManageModal();
        updateNotificationUI();
        openModal(ui.manageModal);
    });

    ui.fabAddHabit.addEventListener('click', () => {
        renderExploreHabits();
        openModal(ui.exploreModal);
    });
    
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
        } else if (button.classList.contains('restore-habit-btn')) {
            requestHabitRestoration(habitId);
        }
    });

    ui.manageModal.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.id === 'export-data-btn') {
            exportData();
        } else if (target.id === 'import-data-btn') {
            importData();
        }
    });

    ui.resetAppBtn.addEventListener('click', () => {
        showConfirmationModal(
            t('confirmResetApp'),
            resetApplicationData,
            { 
                confirmText: t('modalManageResetButton'), 
                title: t('modalManageReset'),
                confirmButtonStyle: 'danger'
            }
        );
    });
    
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
    
    ui.notificationToggle.addEventListener('change', () => {
        pushToOneSignal(async (OneSignal: any) => {
            const wantsEnabled = ui.notificationToggle.checked;
            
            // Execute the action in the background
            if (wantsEnabled) {
                await OneSignal.Notifications.requestPermission();
            } else {
                await OneSignal.User.PushSubscription.optOut();
            }

            // Update UI immediately to show pending state
            ui.notificationToggle.disabled = true;
            setTextContent(ui.notificationStatusDesc, t('notificationChangePending'));
        });
    });

    ui.exploreHabitList.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
        if (!item) return;
        const index = parseInt(item.dataset.index!, 10);
        const habitTemplate = PREDEFINED_HABITS[index];
        if (habitTemplate) {
            // DATA INTEGRITY FIX: Search for ANY existing habit (active, ended, graduated)
            // that matches the template's unique identifier (nameKey).
            const anyExistingHabit = state.habits.find(h =>
                h.scheduleHistory.some(s => s.nameKey === habitTemplate.nameKey)
            );
    
            closeModal(ui.exploreModal);
    
            if (anyExistingHabit) {
                // Determine if the found habit is currently active.
                const lastSchedule = anyExistingHabit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate))[anyExistingHabit.scheduleHistory.length - 1];
                const isActive = !anyExistingHabit.graduatedOn && !lastSchedule.endDate;
    
                if (isActive) {
                    // If it's active, open the edit modal for the existing habit.
                    openEditModal(anyExistingHabit);
                } else {
                    // If it exists but is ended or graduated, prompt the user to restore it.
                    const { name } = getHabitDisplayInfo(anyExistingHabit);
                    showConfirmationModal(
                        t('confirmRestoreHabit', { habitName: name }),
                        () => {
                            requestHabitRestoration(anyExistingHabit.id);
                        },
                        { 
                            confirmText: t('restoreButton'),
                            title: t('modalRestoreHabitTitle')
                        }
                    );
                }
            } else {
                // If no habit of this type exists at all, create a new one from the template.
                openEditModal(habitTemplate);
            }
        }
    });

    ui.exploreHabitList.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
            if (item) {
                item.click();
            }
        }
    });

    ui.createCustomHabitBtn.addEventListener('click', () => {
        closeModal(ui.exploreModal);
        openEditModal(null);
    });

    ui.aiEvalBtn.addEventListener('click', () => {
        const celebration21DayText = _processAndFormatCelebrations(state.pending21DayHabitIds, 'aiCelebration21Day', STREAK_SEMI_CONSOLIDATED);
        const celebration66DayText = _processAndFormatCelebrations(state.pendingConsolidationHabitIds, 'aiCelebration66Day', STREAK_CONSOLIDATED);
        
        const allCelebrations = [celebration66DayText, celebration21DayText].filter(Boolean).join('\n\n');

        if (allCelebrations) {
            ui.aiResponse.innerHTML = simpleMarkdownToHTML(allCelebrations);
            openModal(ui.aiModal, undefined, () => {
                state.hasSeenAIResult = true;
                renderAINotificationState();
            });
            state.pending21DayHabitIds = [];
            state.pendingConsolidationHabitIds = [];
            saveState(); // Salva que as notificações foram vistas
            renderAINotificationState();
        } else if ((state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult && state.lastAIResult) {
            ui.aiResponse.innerHTML = simpleMarkdownToHTML(state.lastAIResult);
            openModal(ui.aiModal, undefined, () => {
                state.hasSeenAIResult = true;
                renderAINotificationState();
            });
        } else {
            openModal(ui.aiOptionsModal);
        }
    });

    ui.aiOptionsModal.addEventListener('click', e => {
        const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.ai-option-btn');
        if (!button) return;
        const analysisType = button.dataset.analysisType as 'monthly' | 'quarterly' | 'historical';
        performAIAnalysis(analysisType);
    });

    ui.confirmModalConfirmBtn.addEventListener('click', () => {
        const action = state.confirmAction;
        state.confirmAction = null;
        state.confirmEditAction = null;
        closeModal(ui.confirmModal);
        action?.();
    });
    
    ui.confirmModalEditBtn.addEventListener('click', () => {
        const editAction = state.confirmEditAction;
        state.confirmAction = null;
        state.confirmEditAction = null;
        closeModal(ui.confirmModal);
        editAction?.();
    });

    ui.saveNoteBtn.addEventListener('click', handleSaveNote);

    ui.fullCalendarPrevBtn.addEventListener('click', () => {
        state.fullCalendar.month--;
        if (state.fullCalendar.month < 0) {
            state.fullCalendar.month = 11;
            state.fullCalendar.year--;
        }
        renderFullCalendar();
    });

    ui.fullCalendarNextBtn.addEventListener('click', () => {
        state.fullCalendar.month++;
        if (state.fullCalendar.month > 11) {
            state.fullCalendar.month = 0;
            state.fullCalendar.year++;
        }
        renderFullCalendar();
    });

    ui.fullCalendarGrid.addEventListener('click', (e) => {
        const dayEl = (e.target as HTMLElement).closest<HTMLElement>('.full-calendar-day');
        if (dayEl && dayEl.dataset.date) {
            state.selectedDate = dayEl.dataset.date;
            
            const newDate = parseUTCIsoDate(state.selectedDate);
            state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
                addDays(newDate, i - 30)
            );

            closeModal(ui.fullCalendarModal);
            
            state.uiDirtyState.calendarVisuals = true;
            state.uiDirtyState.habitListStructure = true;
            invalidateChartCache();
            
            renderApp();

            requestAnimationFrame(() => {
                const selectedEl = ui.calendarStrip.querySelector('.day-item.selected');
                selectedEl?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
            });
        }
    });

    ui.fullCalendarGrid.addEventListener('keydown', (e) => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key)) {
            return;
        }
        e.preventDefault();
    
        if (e.key === 'Enter' || e.key === ' ') {
            closeModal(ui.fullCalendarModal);
            const newDate = parseUTCIsoDate(state.selectedDate);
            state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
                addDays(newDate, i - 30)
            );

            state.uiDirtyState.calendarVisuals = true;
            state.uiDirtyState.habitListStructure = true;
            invalidateChartCache();
            
            renderApp();
            
            requestAnimationFrame(() => {
                const selectedEl = ui.calendarStrip.querySelector('.day-item.selected');
                selectedEl?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
            });
            return;
        }
    
        const currentSelectedDate = parseUTCIsoDate(state.selectedDate);
        let newDate: Date;
    
        switch (e.key) {
            case 'ArrowRight': newDate = addDays(currentSelectedDate, 1); break;
            case 'ArrowLeft': newDate = addDays(currentSelectedDate, -1); break;
            case 'ArrowUp': newDate = addDays(currentSelectedDate, -7); break;
            case 'ArrowDown': newDate = addDays(currentSelectedDate, 7); break;
            default: return;
        }
    
        state.selectedDate = toUTCIsoDateString(newDate);
    
        if (newDate.getUTCMonth() !== state.fullCalendar.month || newDate.getUTCFullYear() !== state.fullCalendar.year) {
            state.fullCalendar.month = newDate.getUTCMonth();
            state.fullCalendar.year = newDate.getUTCFullYear();
        }
        
        renderFullCalendar();
        
        requestAnimationFrame(() => {
            const newSelectedEl = ui.fullCalendarGrid.querySelector<HTMLElement>(`.full-calendar-day[data-date="${state.selectedDate}"]`);
            newSelectedEl?.focus();
        });
    });

    ui.editHabitSaveBtn.addEventListener('click', saveHabitFromModal);

    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    
    habitNameInput.addEventListener('input', () => {
        if (!state.editingHabit) return;
        
        const newName = habitNameInput.value.trim();
        state.editingHabit.formData.name = newName;
        delete state.editingHabit.formData.nameKey; 

        const isValid = _validateHabitName(newName, state.editingHabit.habitId);
        ui.editHabitSaveBtn.disabled = !isValid;
    });

    ui.habitIconPickerBtn.addEventListener('click', () => {
        renderIconPicker();
        openModal(ui.iconPickerModal);
    });

    ui.iconPickerGrid.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const item = target.closest<HTMLButtonElement>('.icon-picker-item');
        if (item && state.editingHabit) {
            const iconSVG = item.dataset.iconSvg!;
            state.editingHabit.formData.icon = iconSVG;
            ui.habitIconPickerBtn.innerHTML = iconSVG;
            closeModal(ui.iconPickerModal);
        }
    });
    
    ui.colorPickerGrid.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const swatch = target.closest<HTMLButtonElement>('.color-swatch');
        if (swatch && state.editingHabit) {
            const color = swatch.dataset.color!;
            state.editingHabit.formData.color = color;

            const iconColor = getContrastColor(color);
            ui.habitIconPickerBtn.style.backgroundColor = color;
            ui.habitIconPickerBtn.style.color = iconColor;
            
            ui.colorPickerGrid.querySelector('.selected')?.classList.remove('selected');
            swatch.classList.add('selected');

            ui.iconPickerModal.classList.remove('is-picking-color');
            renderIconPicker();
            closeModal(ui.colorPickerModal);
        }
    });

    ui.changeColorFromPickerBtn.addEventListener('click', () => {
        renderColorPicker();
        ui.iconPickerModal.classList.add('is-picking-color');
        openModal(ui.colorPickerModal, undefined, () => {
            ui.iconPickerModal.classList.remove('is-picking-color');
            renderIconPicker();
        });
    });

    ui.habitTimeContainer.addEventListener('click', e => {
        if (!state.editingHabit) return;
        const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.segmented-control-option');
        if (!button) return;

        const time = button.dataset.time as any; 
        const currentlySelected = state.editingHabit.formData.times.includes(time);

        if (currentlySelected) {
            if (state.editingHabit.formData.times.length > 1) {
                state.editingHabit.formData.times = state.editingHabit.formData.times.filter(t => t !== time);
                button.classList.remove('selected');
            }
        } else {
            state.editingHabit.formData.times.push(time);
            button.classList.add('selected');
        }
    });

    ui.frequencyOptionsContainer.addEventListener('change', e => {
        const target = e.target as HTMLElement;
        if (target.matches('input[name="frequency-type"]')) {
            _handleFrequencyTypeChange(target as HTMLInputElement);
        } else if (target.closest('.weekday-picker input')) {
            _handleWeekdaySelectionChange();
        }
    });

    ui.frequencyOptionsContainer.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const btn = target.closest<HTMLButtonElement>('.stepper-btn, .unit-toggle-btn');
        if (btn) {
            _handleIntervalControlChange(btn);
        }
    });
}
