
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/modals.ts
 * @description Controlador de Interação de Modais (Forms, Configurações, Diálogos).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo gerencia o ciclo de vida de interações complexas que pausam o fluxo principal da aplicação.
 * 
 * ARQUITETURA (Static Dispatch & Zero-Allocation):
 * - **Static Handlers:** Todos os listeners são definidos no nível do módulo. Zero closures em `setupModalListeners`.
 * - **Validation Optimization:** Separação estrita entre validação lógica (Input Loop) e feedback visual (RAF).
 * - **Event Delegation:** Delegação eficiente para listas e grids.
 */

import { ui } from '../render/ui';
import { 
    state, 
    LANGUAGES, 
    STREAK_SEMI_CONSOLIDATED, 
    STREAK_CONSOLIDATED, 
    DAYS_IN_CALENDAR, 
    invalidateChartCache, 
    FREQUENCIES,
    Habit,
    TimeOfDay
} from '../state';
import { saveState } from '../services/persistence';
import { PREDEFINED_HABITS } from '../data/predefinedHabits';
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
} from '../habitActions';
import { t, setLanguage, formatList } from '../i18n';
import { getHabitDisplayInfo } from '../services/selectors';
import { setupReelRotary } from '../render/rotary';
import { simpleMarkdownToHTML, pushToOneSignal, getContrastColor, addDays, parseUTCIsoDate, toUTCIsoDateString } from '../utils';
import { setTextContent } from '../render/dom';
import { isHabitNameDuplicate } from '../services/selectors';

// SECURITY: Limite rígido para inputs de texto para prevenir State Bloat e DoS.
const MAX_HABIT_NAME_LENGTH = 50; 

// CHAOS CONTROL: Semáforo para evitar múltiplas requisições de IA simultâneas
let isAiEvalProcessing = false;

// --- STATIC HELPERS ---

const _processAndFormatCelebrations = (
    pendingIds: string[], 
    translationKey: 'aiCelebration21Day' | 'aiCelebration66Day',
    streakMilestone: number
): string => {
    if (pendingIds.length === 0) return '';
    
    // PERF: Zero-allocation loop if possible, but map/filter is clean here.
    const habitNamesList = pendingIds
        .map(id => state.habits.find(h => h.id === id))
        .filter(Boolean)
        .map(h => getHabitDisplayInfo(h!).name);
    
    const habitNames = formatList(habitNamesList);
        
    pendingIds.forEach(id => {
        const celebrationId = `${id}-${streakMilestone}`;
        if (!state.notificationsShown.includes(celebrationId)) {
            state.notificationsShown.push(celebrationId);
        }
    });

    return t(translationKey, { count: pendingIds.length, habitNames });
};

// HELPER: Centraliza lógica de navegação do Almanaque para evitar duplicação (DRY)
function _navigateToDateFromAlmanac(dateISO: string) {
    state.selectedDate = dateISO;
    const newDate = parseUTCIsoDate(dateISO);
    
    // Regenera a faixa de calendário centrada na nova data
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

// --- VALIDATION LOGIC (Decoupled) ---

/**
 * Valida o nome do hábito e atualiza a UI.
 * PERFORMANCE: Evita Layout Thrashing (offsetWidth) no loop de input.
 * Apenas atualiza o texto de erro se o *tipo* de erro mudar.
 */
function _validateAndFeedback(newName: string): boolean {
    const formNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice')!;
    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    
    const trimmedName = newName.trim();
    let errorKey: string | null = null;

    if (trimmedName.length === 0) {
        errorKey = 'noticeNameCannotBeEmpty';
    } else if (trimmedName.length > 16) {
        errorKey = 'noticeNameTooLong';
    } else if (isHabitNameDuplicate(trimmedName, state.editingHabit?.habitId)) {
        errorKey = 'noticeDuplicateHabitWithName';
    }

    const isValid = errorKey === null;

    // UI Updates (DOM Writes)
    if (isValid) {
        if (formNoticeEl.classList.contains('visible')) {
            formNoticeEl.classList.remove('visible');
            habitNameInput.classList.remove('shake');
        }
    } else {
        const errorText = t(errorKey!);
        // Dirty check text content
        if (formNoticeEl.textContent !== errorText) {
            formNoticeEl.textContent = errorText;
        }
        
        if (!formNoticeEl.classList.contains('visible')) {
            formNoticeEl.classList.add('visible');
            
            // Trigger animation frame only when showing error
            requestAnimationFrame(() => {
                habitNameInput.classList.add('shake');
                habitNameInput.addEventListener('animationend', () => {
                    habitNameInput.classList.remove('shake');
                }, { once: true });
            });
        }
    }

    return isValid;
}

// --- STATIC EVENT HANDLERS ---

const _handleManageHabitsClick = () => {
    // CHAOS FIX: Prevents modal stacking
    if (ui.manageModal.classList.contains('visible')) return;
    
    setupManageModal();
    updateNotificationUI();
    openModal(ui.manageModal);
};

const _handleFabClick = () => {
    // CHAOS FIX: Prevents modal stacking
    if (ui.exploreModal.classList.contains('visible')) return;

    renderExploreHabits();
    openModal(ui.exploreModal);
};

const _handleHabitListClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('button');
    if (!button) return;

    const habitId = button.closest<HTMLLIElement>('li.habit-list-item')?.dataset.habitId;
    if (!habitId) return;

    // CHAOS FIX: Prevent opening confirmation if already open
    if (ui.confirmModal.classList.contains('visible')) return;

    if (button.classList.contains('end-habit-btn')) {
        requestHabitEndingFromModal(habitId);
    } else if (button.classList.contains('permanent-delete-habit-btn')) {
        requestHabitPermanentDeletion(habitId);
    } else if (button.classList.contains('edit-habit-btn')) {
        requestHabitEditingFromModal(habitId);
    } else if (button.classList.contains('graduate-habit-btn')) {
        graduateHabit(habitId);
    }
};

const _handleManageModalClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.id === 'export-data-btn') {
        exportData();
    } else if (target.id === 'import-data-btn') {
        importData();
    }
};

const _handleResetAppClick = () => {
    // CHAOS FIX: Prevent stacking confirmation
    if (ui.confirmModal.classList.contains('visible')) return;

    showConfirmationModal(
        t('confirmResetApp'),
        resetApplicationData,
        { 
            confirmText: t('modalManageResetButton'), 
            title: t('modalManageReset'),
            confirmButtonStyle: 'danger'
        }
    );
};

const _handleNotificationToggleChange = () => {
    pushToOneSignal(async (OneSignal: any) => {
        const wantsEnabled = ui.notificationToggle.checked;
        if (wantsEnabled) {
            await OneSignal.Notifications.requestPermission();
        } else {
            await OneSignal.User.PushSubscription.optOut();
        }
        ui.notificationToggle.disabled = true;
        setTextContent(ui.notificationStatusDesc, t('notificationChangePending'));
    });
};

const _handleExploreHabitListClick = (e: MouseEvent) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
    if (!item) return;
    const index = parseInt(item.dataset.index!, 10);
    const habitTemplate = PREDEFINED_HABITS[index];
    if (habitTemplate) {
        const anyExistingHabit = state.habits.find(h =>
            h.scheduleHistory.some(s => s.nameKey === habitTemplate.nameKey)
        );

        closeModal(ui.exploreModal);

        if (anyExistingHabit) {
            openEditModal(anyExistingHabit);
        } else {
            openEditModal(habitTemplate);
        }
    }
};

const _handleExploreHabitListKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
        if (item) {
            item.click();
        }
    }
};

const _handleCreateCustomHabitClick = () => {
    closeModal(ui.exploreModal);
    openEditModal(null);
};

const _handleAiEvalClick = async () => {
    // CHAOS FIX: Mutex for Async Operation + Visibility Check
    if (isAiEvalProcessing || ui.aiModal.classList.contains('visible') || ui.aiOptionsModal.classList.contains('visible')) {
        return;
    }
    
    isAiEvalProcessing = true;

    try {
        // OFFLINE HANDLING
        if (!navigator.onLine) {
            try {
                const { STOIC_QUOTES } = await import('../data/quotes');
                const offlineQuotes = STOIC_QUOTES.filter(q => 
                    q.metadata.tags.includes('control') || 
                    q.metadata.tags.includes('acceptance') ||
                    q.metadata.tags.includes('perception')
                );
                const sourceArray = offlineQuotes.length > 0 ? offlineQuotes : STOIC_QUOTES;
                const randomQuote = sourceArray[Math.floor(Math.random() * sourceArray.length)];
                const lang = state.activeLanguageCode as 'pt'|'en'|'es';
                const quoteText = randomQuote.original_text[lang];
                const author = t(randomQuote.author);

                const message = `
                    <div class="offline-header">
                        <h3 class="offline-title">${t('aiOfflineTitle')}</h3>
                        <p class="offline-desc">${t('aiOfflineMessage')}</p>
                    </div>
                    <div class="offline-quote-box">
                        <blockquote class="offline-quote-text">
                            "${quoteText}"
                        </blockquote>
                        <div class="offline-quote-author">
                            — ${author}
                        </div>
                    </div>
                `;
                ui.aiResponse.innerHTML = message;
                openModal(ui.aiModal);
            } catch (e) {
                console.error("Failed to load offline quote", e);
            }
            return;
        }

        let message = '';
        
        const celebration21DayText = _processAndFormatCelebrations(state.pending21DayHabitIds, 'aiCelebration21Day', STREAK_SEMI_CONSOLIDATED);
        const celebration66DayText = _processAndFormatCelebrations(state.pendingConsolidationHabitIds, 'aiCelebration66Day', STREAK_CONSOLIDATED);
        const allCelebrations = [celebration66DayText, celebration21DayText].filter(Boolean).join('\n\n');

        if (allCelebrations) {
            message = simpleMarkdownToHTML(allCelebrations);
            state.pending21DayHabitIds = [];
            state.pendingConsolidationHabitIds = [];
            saveState();
            renderAINotificationState();
        } else if ((state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult && state.lastAIResult) {
            message = simpleMarkdownToHTML(state.lastAIResult);
        }
        
        if (message) {
            ui.aiResponse.innerHTML = message;
            openModal(ui.aiModal, undefined, () => {
                state.hasSeenAIResult = true;
                renderAINotificationState();
            });
        } else {
            openModal(ui.aiOptionsModal);
        }
    } finally {
        isAiEvalProcessing = false;
    }
};

const _handleAiOptionsClick = (e: MouseEvent) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.ai-option-btn');
    if (!button) return;
    const analysisType = button.dataset.analysisType as 'monthly' | 'quarterly' | 'historical';
    performAIAnalysis(analysisType);
};

const _handleConfirmClick = () => {
    const action = state.confirmAction;
    state.confirmAction = null;
    state.confirmEditAction = null;
    closeModal(ui.confirmModal);
    action?.();
};

const _handleEditClick = () => {
    const editAction = state.confirmEditAction;
    state.confirmAction = null;
    state.confirmEditAction = null;
    closeModal(ui.confirmModal);
    editAction?.();
};

const _handleFullCalendarPrevClick = () => {
    state.fullCalendar.month--;
    if (state.fullCalendar.month < 0) {
        state.fullCalendar.month = 11;
        state.fullCalendar.year--;
    }
    renderFullCalendar();
};

const _handleFullCalendarNextClick = () => {
    state.fullCalendar.month++;
    if (state.fullCalendar.month > 11) {
        state.fullCalendar.month = 0;
        state.fullCalendar.year++;
    }
    renderFullCalendar();
};

const _handleFullCalendarGridClick = (e: MouseEvent) => {
    const dayEl = (e.target as HTMLElement).closest<HTMLElement>('.full-calendar-day');
    if (dayEl && dayEl.dataset.date) {
        _navigateToDateFromAlmanac(dayEl.dataset.date);
    }
};

const _handleFullCalendarGridKeydown = (e: KeyboardEvent) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key)) {
        return;
    }
    e.preventDefault();

    if (e.key === 'Enter' || e.key === ' ') {
        _navigateToDateFromAlmanac(state.selectedDate);
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
};

const _handleHabitNameInput = () => {
    if (!state.editingHabit) return;
    
    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    let newName = habitNameInput.value;

    // BLINDAGEM CONTRA DOS: Truncar input excessivo
    if (newName.length > MAX_HABIT_NAME_LENGTH) {
        newName = newName.substring(0, MAX_HABIT_NAME_LENGTH);
        habitNameInput.value = newName; // Reflete na UI
    }

    state.editingHabit.formData.name = newName;
    delete state.editingHabit.formData.nameKey; 

    // Validation Logic decoupled
    const isValid = _validateAndFeedback(newName);
    ui.editHabitSaveBtn.disabled = !isValid;
};

const _handleIconPickerClick = () => {
    renderIconPicker();
    openModal(ui.iconPickerModal);
};

const _handleIconGridClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLButtonElement>('.icon-picker-item');
    if (item && state.editingHabit) {
        const iconSVG = item.dataset.iconSvg!;
        state.editingHabit.formData.icon = iconSVG;
        ui.habitIconPickerBtn.innerHTML = iconSVG;
        closeModal(ui.iconPickerModal);
    }
};

const _handleColorGridClick = (e: MouseEvent) => {
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
};

const _handleChangeColorClick = () => {
    renderColorPicker();
    ui.iconPickerModal.classList.add('is-picking-color');
    openModal(ui.colorPickerModal, undefined, () => {
        ui.iconPickerModal.classList.remove('is-picking-color');
        renderIconPicker();
    });
};

const _handleTimeContainerClick = (e: MouseEvent) => {
    if (!state.editingHabit) return;
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.segmented-control-option');
    if (!button) return;

    const time = button.dataset.time as TimeOfDay; 
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
};

const _handleFrequencyChange = (e: Event) => {
    const target = e.target as HTMLElement;
    if (!state.editingHabit) return;

    if (target.matches('input[name="frequency-type"]')) {
        const radio = target as HTMLInputElement;
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
    } else if (target.closest('.weekday-picker input')) {
        const days = Array.from(ui.frequencyOptionsContainer.querySelectorAll<HTMLInputElement>('.weekday-picker input:checked'))
            .map(el => parseInt(el.dataset.day!, 10));
        state.editingHabit.formData.frequency = { type: 'specific_days_of_week', days };
    }
};

const _handleFrequencyClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>('.stepper-btn, .unit-toggle-btn');
    if (!btn || !state.editingHabit || state.editingHabit.formData.frequency.type !== 'interval') return;

    const action = btn.dataset.action;
    const currentFreq = state.editingHabit.formData.frequency;
    let { amount, unit } = currentFreq;

    if (action === 'interval-decrement') amount = Math.max(1, amount - 1);
    if (action === 'interval-increment') amount = Math.min(99, amount + 1);
    if (action === 'interval-unit-toggle') unit = unit === 'days' ? 'weeks' : 'days';

    state.editingHabit.formData.frequency = { type: 'interval', amount, unit };
    renderFrequencyOptions();
};

export function setupModalListeners() {
    // Main Actions
    ui.manageHabitsBtn.addEventListener('click', _handleManageHabitsClick);
    ui.fabAddHabit.addEventListener('click', _handleFabClick);
    ui.habitList.addEventListener('click', _handleHabitListClick);
    ui.manageModal.addEventListener('click', _handleManageModalClick);
    ui.resetAppBtn.addEventListener('click', _handleResetAppClick);
    ui.notificationToggle.addEventListener('change', _handleNotificationToggleChange);

    // Rotary Config
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

    // Explore / Create
    ui.exploreHabitList.addEventListener('click', _handleExploreHabitListClick);
    ui.exploreHabitList.addEventListener('keydown', _handleExploreHabitListKeydown);
    ui.createCustomHabitBtn.addEventListener('click', _handleCreateCustomHabitClick);

    // AI
    ui.aiEvalBtn.addEventListener('click', _handleAiEvalClick);
    ui.aiOptionsModal.addEventListener('click', _handleAiOptionsClick);

    // Dialogs
    ui.confirmModalConfirmBtn.addEventListener('click', _handleConfirmClick);
    ui.confirmModalEditBtn.addEventListener('click', _handleEditClick);
    ui.saveNoteBtn.addEventListener('click', handleSaveNote);

    // Full Calendar
    ui.fullCalendarPrevBtn.addEventListener('click', _handleFullCalendarPrevClick);
    ui.fullCalendarNextBtn.addEventListener('click', _handleFullCalendarNextClick);
    ui.fullCalendarGrid.addEventListener('click', _handleFullCalendarGridClick);
    ui.fullCalendarGrid.addEventListener('keydown', _handleFullCalendarGridKeydown);

    // Habit Editing Form
    ui.editHabitSaveBtn.addEventListener('click', saveHabitFromModal);
    
    // Performance Optimized Input Handler
    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    // BROWSER LEVEL GUARD: Define maxLength no DOM para prevenir colagem excessiva
    habitNameInput.maxLength = MAX_HABIT_NAME_LENGTH;
    habitNameInput.addEventListener('input', _handleHabitNameInput);

    // Pickers
    ui.habitIconPickerBtn.addEventListener('click', _handleIconPickerClick);
    ui.iconPickerGrid.addEventListener('click', _handleIconGridClick);
    ui.colorPickerGrid.addEventListener('click', _handleColorGridClick);
    ui.changeColorFromPickerBtn.addEventListener('click', _handleChangeColorClick);
    ui.habitTimeContainer.addEventListener('click', _handleTimeContainerClick);
    
    // Frequency Controls
    ui.frequencyOptionsContainer.addEventListener('change', _handleFrequencyChange);
    ui.frequencyOptionsContainer.addEventListener('click', _handleFrequencyClick);
}
