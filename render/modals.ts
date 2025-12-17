
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { state, Habit, HabitTemplate, Frequency, PredefinedHabit, TimeOfDay, calculateHabitStreak, STREAK_CONSOLIDATED, PREDEFINED_HABITS, TIMES_OF_DAY, FREQUENCIES, LANGUAGES, getHabitDailyInfoForDate, getScheduleForDate } from '../state';
import { ui } from './ui';
import { t, getHabitDisplayInfo, getTimeOfDayName } from '../i18n';
import { icons, getTimeOfDayIcon } from './icons';
import { setTextContent, updateReelRotaryARIA } from './dom';
import { escapeHTML, getContrastColor, getDateTimeFormat, parseUTCIsoDate, getTodayUTCIso } from '../utils';

const focusTrapListeners = new Map<HTMLElement, (e: KeyboardEvent) => void>();
const previouslyFocusedElements = new WeakMap<HTMLElement, HTMLElement>();

export function openModal(modal: HTMLElement, elementToFocus?: HTMLElement) {
    previouslyFocusedElements.set(modal, document.activeElement as HTMLElement);

    modal.classList.add('visible');

    if (ui.appContainer) {
        ui.appContainer.setAttribute('inert', '');
    }

    const focusableElements = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusableElements.length === 0) return;

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    const targetElement = elementToFocus || firstFocusable;
    
    setTimeout(() => {
        if (targetElement && targetElement.isConnected) {
            if (targetElement instanceof HTMLTextAreaElement) {
                targetElement.focus();
                targetElement.selectionStart = targetElement.selectionEnd = targetElement.value.length;
            } else if (targetElement instanceof HTMLInputElement) {
                targetElement.focus();
                targetElement.select();
            } else {
                targetElement.focus();
            }
        }
    }, 100);


    const trapListener = (e: KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        
        if (e.shiftKey) {
            if (document.activeElement === firstFocusable) {
                lastFocusable.focus();
                e.preventDefault();
            }
        } else {
            if (document.activeElement === lastFocusable) {
                firstFocusable.focus();
                e.preventDefault();
            }
        }
    };
    
    modal.addEventListener('keydown', trapListener);
    focusTrapListeners.set(modal, trapListener);
}

export function closeModal(modal: HTMLElement) {
    modal.classList.remove('visible');
    
    if (ui.appContainer) {
        ui.appContainer.removeAttribute('inert');
    }

    const listener = focusTrapListeners.get(modal);
    if (listener) {
        modal.removeEventListener('keydown', listener);
        focusTrapListeners.delete(modal);
    }

    const elementToRestoreFocus = previouslyFocusedElements.get(modal);
    
    if (elementToRestoreFocus && elementToRestoreFocus.isConnected) {
        elementToRestoreFocus.focus();
    } else {
        ui.habitContainer.focus();
    }
    previouslyFocusedElements.delete(modal);
}

export function initializeModalClosing(modal: HTMLElement, onClose?: () => void) {
    const handleClose = () => {
        closeModal(modal);
        onClose?.();
    };

    modal.addEventListener('click', e => {
        if (e.target === modal) handleClose();
    });
    modal.querySelectorAll<HTMLElement>('.modal-close-btn').forEach(btn => btn.addEventListener('click', handleClose));
}

function getHabitStatusForSorting(habit: Habit): 'active' | 'ended' | 'graduated' {
    if (habit.graduatedOn) {
        return 'graduated';
    }
    const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
    if (lastSchedule.endDate) {
        return 'ended';
    }
    return 'active';
}

function _createManageHabitListItem(habitData: { habit: Habit; status: 'active' | 'ended' | 'graduated'; name: string; }, todayISO: string): HTMLLIElement {
    const { habit, status, name } = habitData;
    
    // PERFORMANCE FIX [2025-03-03]: Recebe todayISO pré-calculado para evitar múltiplas alocações de Date.
    const streak = calculateHabitStreak(habit.id, todayISO); 
    const isConsolidated = streak >= STREAK_CONSOLIDATED;

    const li = document.createElement('li');
    li.className = `habit-list-item ${status}`;
    li.dataset.habitId = habit.id;

    const mainSpan = document.createElement('span');
    
    const iconSpan = document.createElement('span');
    iconSpan.innerHTML = habit.icon;
    iconSpan.style.color = habit.color;
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'habit-name';
    nameSpan.textContent = name;

    mainSpan.append(iconSpan, nameSpan);

    if (status === 'graduated' || status === 'ended') {
        const statusSpan = document.createElement('span');
        statusSpan.className = 'habit-name-status';
        statusSpan.textContent = t(status === 'graduated' ? 'modalStatusGraduated' : 'modalStatusEnded');
        mainSpan.appendChild(statusSpan);
    }
    
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'habit-list-actions';

    const createActionButton = (className: string, habitId: string, ariaLabel: string, icon: string): HTMLButtonElement => {
        const button = document.createElement('button');
        button.className = className;
        button.dataset.habitId = habitId;
        button.setAttribute('aria-label', ariaLabel);
        button.type = "button"; 
        button.innerHTML = icon;
        return button;
    };

    switch(status) {
        case 'ended':
            actionsDiv.appendChild(createActionButton(
                'permanent-delete-habit-btn', habit.id, t('aria_delete_permanent', { habitName: name }), icons.deletePermanentAction
            ));
            break;
        case 'active':
            actionsDiv.appendChild(createActionButton(
                'edit-habit-btn', habit.id, t('aria_edit', { habitName: name }), icons.editAction
            ));
            if (isConsolidated) {
                actionsDiv.appendChild(createActionButton(
                    'graduate-habit-btn', habit.id, t('aria_graduate', { habitName: name }), icons.graduateAction
                ));
            } else {
                actionsDiv.appendChild(createActionButton(
                    'end-habit-btn', habit.id, t('aria_end', { habitName: name }), icons.endAction
                ));
            }
            break;
    }
    
    li.append(mainSpan, actionsDiv);
    return li;
}

export function setupManageModal() {
    const habitsByName = new Map<string, Habit[]>();
    
    state.habits.forEach(habit => {
        const { name } = getHabitDisplayInfo(habit);
        if (!habitsByName.has(name)) {
            habitsByName.set(name, []);
        }
        habitsByName.get(name)!.push(habit);
    });

    const habitsForModal = [];
    const statusOrder = { 'active': 0, 'graduated': 1, 'ended': 2 };

    for (const [name, habitGroup] of habitsByName) {
        habitGroup.sort((a, b) => {
            const statusA = getHabitStatusForSorting(a);
            const statusB = getHabitStatusForSorting(b);
            
            if (statusA !== statusB) {
                return statusOrder[statusA] - statusOrder[statusB];
            }
            const lastA = a.scheduleHistory[a.scheduleHistory.length-1].startDate;
            const lastB = b.scheduleHistory[b.scheduleHistory.length-1].startDate;
            return lastB.localeCompare(lastA);
        });

        const representative = habitGroup[0]; 
        
        habitsForModal.push({
            habit: representative,
            status: getHabitStatusForSorting(representative),
            name: name
        });
    }

    habitsForModal.sort((a, b) => {
        const statusDifference = statusOrder[a.status] - statusOrder[b.status];
        if (statusDifference !== 0) {
            return statusDifference;
        }
        return a.name.localeCompare(b.name);
    });

    const fragment = document.createDocumentFragment();
    
    // PERFORMANCE FIX: Hoist today calculation out of the loop
    const todayISO = getTodayUTCIso();
    
    habitsForModal.forEach(habitData => {
        fragment.appendChild(_createManageHabitListItem(habitData, todayISO));
    });

    ui.habitList.innerHTML = '';
    ui.habitList.appendChild(fragment);
}

export function showUndoToast() {
    if (state.undoTimeout) clearTimeout(state.undoTimeout);
    ui.undoToast.classList.add('visible');
    state.undoTimeout = window.setTimeout(() => {
        ui.undoToast.classList.remove('visible');
        state.lastEnded = null;
    }, 5000);
}

export function showConfirmationModal(
    text: string, 
    onConfirm: () => void, 
    options?: { 
        title?: string;
        confirmText?: string;
        cancelText?: string;
        editText?: string;
        onEdit?: () => void;
        confirmButtonStyle?: 'primary' | 'danger';
        hideCancel?: boolean;
    }
) {
    ui.confirmModalText.innerHTML = text;
    state.confirmAction = onConfirm;
    state.confirmEditAction = options?.onEdit || null;

    setTextContent(ui.confirmModal.querySelector('h2'), options?.title || t('modalConfirmTitle'));
    const confirmBtn = ui.confirmModalConfirmBtn;
    setTextContent(confirmBtn, options?.confirmText || t('confirmButton'));
    
    confirmBtn.classList.remove('btn--primary', 'btn--danger');
    confirmBtn.classList.add(options?.confirmButtonStyle === 'danger' ? 'btn--danger' : 'btn--primary');
    
    const cancelBtn = ui.confirmModal.querySelector<HTMLElement>('.modal-close-btn');
    if (cancelBtn) {
        setTextContent(cancelBtn, options?.cancelText || t('cancelButton'));
        cancelBtn.style.display = options?.hideCancel ? 'none' : '';
    }
    
    if (options?.editText && options?.onEdit) {
        ui.confirmModalEditBtn.style.display = 'inline-block';
        setTextContent(ui.confirmModalEditBtn, options.editText);
    } else {
        ui.confirmModalEditBtn.style.display = 'none';
    }

    openModal(ui.confirmModal);
}

export function openNotesModal(habitId: string, date: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    state.editingNoteFor = { habitId, date, time };
    
    const { name } = getHabitDisplayInfo(habit, date);
    const dateObj = parseUTCIsoDate(date);
    const formattedDate = getDateTimeFormat(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(dateObj);
    const timeName = getTimeOfDayName(time);

    setTextContent(ui.notesModalTitle, name);
    setTextContent(ui.notesModalSubtitle, `${formattedDate} - ${timeName}`);
    
    // FIX [2025-02-23]: Use lazy loading accessor to ensure we can read notes from archives.
    const dayData = getHabitDailyInfoForDate(date)[habitId]?.instances[time];
    ui.notesTextarea.value = dayData?.note || '';
    
    openModal(ui.notesModal, ui.notesTextarea);
}

const PALETTE_COLORS = ['#e74c3c', '#f1c40f', '#3498db', '#2ecc71', '#9b59b6', '#1abc9c', '#34495e', '#e67e22', '#e84393', '#7f8c8d'];

export function renderIconPicker() {
    if (!state.editingHabit) return;
    const bgColor = state.editingHabit.formData.color;
    const fgColor = getContrastColor(bgColor);

    ui.iconPickerGrid.style.setProperty('--current-habit-bg-color', bgColor);
    ui.iconPickerGrid.style.setProperty('--current-habit-fg-color', fgColor);

    if (ui.iconPickerGrid.children.length === 0) {
        const nonHabitIconKeys = new Set(['morning', 'afternoon', 'evening', 'deletePermanentAction', 'editAction', 'graduateAction', 'endAction', 'swipeDelete', 'swipeNote', 'swipeNoteHasNote', 'colorPicker', 'edit', 'snoozed', 'check']);
        
        const iconButtons = Object.keys(icons)
            .filter(key => !nonHabitIconKeys.has(key))
            .map(key => {
                const iconSVG = (icons as any)[key];
                return `
                    <button type="button" class="icon-picker-item" data-icon-svg="${escapeHTML(iconSVG)}">
                        ${iconSVG}
                    </button>
                `;
            }).join('');

        ui.iconPickerGrid.innerHTML = iconButtons;
    }

    const changeColorBtn = ui.iconPickerModal.querySelector<HTMLButtonElement>('#change-color-from-picker-btn');
    if (changeColorBtn) {
        changeColorBtn.innerHTML = icons.colorPicker;
        changeColorBtn.setAttribute('aria-label', t('habitColorPicker_ariaLabel'));
    }
}

export function renderColorPicker() {
    if (!state.editingHabit) return;
    const currentColor = state.editingHabit.formData.color;
    ui.colorPickerGrid.innerHTML = PALETTE_COLORS.map(color => `
        <button type="button" class="color-swatch ${currentColor === color ? 'selected' : ''}" style="background-color: ${color}" data-color="${color}" aria-label="${color}"></button>
    `).join('');
}

export function renderFrequencyOptions() {
    if (!state.editingHabit) return;

    const currentFrequency = state.editingHabit.formData.frequency;
    const container = ui.frequencyOptionsContainer;
    const isDaily = currentFrequency.type === 'daily';
    const isSpecificDays = currentFrequency.type === 'specific_days_of_week';
    const isInterval = currentFrequency.type === 'interval';

    const rawWeekdays = [
        { key: 'weekdaySun', day: 0 }, { key: 'weekdayMon', day: 1 }, { key: 'weekdayTue', day: 2 },
        { key: 'weekdayWed', day: 3 }, { key: 'weekdayThu', day: 4 }, { key: 'weekdayFri', day: 5 },
        { key: 'weekdaySat', day: 6 }
    ];

    let weekdays = rawWeekdays;
    if (state.activeLanguageCode === 'es' || state.activeLanguageCode === 'en') {
        weekdays = [
            rawWeekdays[1], rawWeekdays[2], rawWeekdays[3], rawWeekdays[4], rawWeekdays[5], rawWeekdays[6], rawWeekdays[0]
        ];
    }

    const selectedDays = isSpecificDays ? new Set(currentFrequency.days) : new Set();
    const weekdayPickerHTML = `
        <div class="weekday-picker">
            ${weekdays.map(({ key, day }) => {
                const dayName = t(key);
                return `
                <label title="${dayName}">
                    <input type="checkbox" data-day="${day}" ${selectedDays.has(day) ? 'checked' : ''}>
                    <span class="weekday-button">${dayName.substring(0, 1)}</span>
                </label>
            `}).join('')}
        </div>`;

    const intervalFreqTpl = FREQUENCIES.find(f => f.value.type === 'interval')!;
    const amount = isInterval ? currentFrequency.amount : (intervalFreqTpl.value.type === 'interval' ? intervalFreqTpl.value.amount : 2);
    const unit = isInterval ? currentFrequency.unit : (intervalFreqTpl.value.type === 'interval' ? intervalFreqTpl.value.unit : 'days');
    
    const unitText = unit === 'days' ? t('unitDays') : t('unitWeeks');
    const intervalControlsHTML = `
        <div class="interval-control-group">
            <button type="button" class="stepper-btn" data-action="interval-decrement" aria-label="${t('habitGoalDecrement_ariaLabel')}">-</button>
            <span class="interval-amount-display">${amount}</span>
            <button type="button" class="stepper-btn" data-action="interval-increment" aria-label="${t('habitGoalIncrement_ariaLabel')}">+</button>
            <button type="button" class="unit-toggle-btn" data-action="interval-unit-toggle">${unitText}</button>
        </div>
    `;

    container.innerHTML = `
        <div class="form-section frequency-options">
            <div class="form-row">
                <label>
                    <input type="radio" name="frequency-type" value="daily" ${isDaily ? 'checked' : ''}>
                    ${t('freqDaily')}
                </label>
            </div>
            <div class="form-row form-row--vertical">
                <label>
                    <input type="radio" name="frequency-type" value="specific_days_of_week" ${isSpecificDays ? 'checked' : ''}>
                    ${t('freqSpecificDaysOfWeek')}
                </label>
                <div class="frequency-details ${isSpecificDays ? 'visible' : ''}">
                    ${weekdayPickerHTML}
                </div>
            </div>
            <div class="form-row form-row--vertical">
                <label>
                    <input type="radio" name="frequency-type" value="interval" ${isInterval ? 'checked' : ''}>
                    ${t('freqEvery')}
                </label>
                <div class="frequency-details ${isInterval ? 'visible' : ''}">
                    ${intervalControlsHTML}
                </div>
            </div>
        </div>`;
}

function _createHabitTemplateForForm(habitOrTemplate: Habit | PredefinedHabit | null, selectedDate: string): HabitTemplate {
    if (!habitOrTemplate) {
        const commonData = {
            icon: icons.custom,
            color: '#000000',
            times: ['Morning'] as TimeOfDay[],
            goal: { type: 'check', unitKey: 'unitCheck' } as Habit['goal'],
            frequency: { type: 'interval', unit: 'days', amount: 2 } as Frequency,
        };
        return {
            ...commonData,
            name: '',
            subtitleKey: 'customHabitSubtitle',
        };
    }

    if (!('id' in habitOrTemplate)) {
        const template = habitOrTemplate as PredefinedHabit;
        return {
            icon: template.icon,
            color: template.color,
            times: template.times,
            goal: template.goal,
            frequency: template.frequency,
            nameKey: template.nameKey,
            subtitleKey: template.subtitleKey,
        };
    }

    const habit = habitOrTemplate as Habit;
    const schedule = getScheduleForDate(habit, selectedDate) || habit.scheduleHistory[habit.scheduleHistory.length - 1];
    const { name } = getHabitDisplayInfo(habit, selectedDate);

    const commonData = {
        subtitleKey: schedule.subtitleKey || 'customHabitSubtitle',
        icon: habit.icon,
        color: habit.color,
        times: [...schedule.times],
        goal: { ...habit.goal },
        frequency: { ...schedule.frequency },
    };

    if (schedule.nameKey) {
        return { ...commonData, nameKey: schedule.nameKey };
    } else {
        return { ...commonData, name: name };
    }
}

/**
 * REFRESH DYNAMIC CONTENT [2025-03-03]:
 * Re-renders specific sections of the Edit Habit modal that contain dynamic text (Frequency options, Time segments).
 * This ensures that if the language changes while the modal is open (or cached in DOM), the texts update immediately.
 */
export function refreshEditModalUI() {
    if (!state.editingHabit) return;

    // 1. Update Frequency Options (Daily/Weekly labels)
    renderFrequencyOptions();

    // 2. Update Time Segmented Control
    const formData = state.editingHabit.formData;
    ui.habitTimeContainer.innerHTML = `
        <div class="segmented-control">
            ${TIMES_OF_DAY.map(time => `
                <button type="button" class="segmented-control-option ${formData.times.includes(time) ? 'selected' : ''}" data-time="${time}">
                    ${getTimeOfDayIcon(time)}
                    ${getTimeOfDayName(time)}
                </button>
            `).join('')}
        </div>
    `;
    
    // 3. Update Input Placeholder
    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    if (habitNameInput) {
        habitNameInput.placeholder = t('modalEditFormNameLabel');
        
        // If it's a predefined habit (has a key) and not a custom name, translate the value too
        if (state.editingHabit.formData.nameKey) {
            habitNameInput.value = t(state.editingHabit.formData.nameKey);
        }
    }
}

export function openEditModal(habitOrTemplate: Habit | HabitTemplate | null) {
    const isNew = !habitOrTemplate || !('id' in habitOrTemplate);
    const form = ui.editHabitForm;
    
    // FIX [2025-02-23]: Reset de estado visual de validação.
    const formNoticeEl = form.querySelector<HTMLElement>('.form-notice')!; // Seleciona o novo aviso genérico
    const nameInput = form.elements.namedItem('habit-name') as HTMLInputElement;

    if (formNoticeEl) formNoticeEl.classList.remove('visible');
    if (nameInput) nameInput.classList.remove('shake');
    
    // BUGFIX: Reseta o estado desabilitado do botão de salvar.
    // Isso previne que o botão permaneça "travado" se o usuário fechou o modal 
    // enquanto ele estava em estado de erro (ex: nome muito longo) e reabriu.
    ui.editHabitSaveBtn.disabled = false;

    form.reset();
    
    const formData = _createHabitTemplateForForm(habitOrTemplate as Habit | PredefinedHabit | null, state.selectedDate);
    // nameInput is already selected above
    nameInput.placeholder = t('modalEditFormNameLabel');

    if (isNew) {
        setTextContent(ui.editHabitModalTitle, t('modalEditNewTitle'));
        nameInput.value = (habitOrTemplate && 'nameKey' in habitOrTemplate) ? t(habitOrTemplate.nameKey) : '';
    } else {
        // const habit = habitOrTemplate as Habit;
        const { name } = getHabitDisplayInfo(habitOrTemplate as Habit, state.selectedDate);
        setTextContent(ui.editHabitModalTitle, name);
        nameInput.value = name;
    }

    state.editingHabit = {
        isNew: isNew,
        habitId: isNew ? undefined : (habitOrTemplate as Habit).id,
        originalData: isNew ? undefined : { ...(habitOrTemplate as Habit) },
        formData: formData,
        targetDate: state.selectedDate
    };

    ui.editHabitModal.querySelector<HTMLElement>('.edit-icon-overlay')!.innerHTML = icons.edit;
    const iconColor = getContrastColor(formData.color);
    ui.habitIconPickerBtn.innerHTML = formData.icon;
    ui.habitIconPickerBtn.style.backgroundColor = formData.color;
    ui.habitIconPickerBtn.style.color = iconColor;
    
    ui.habitTimeContainer.innerHTML = `
        <div class="segmented-control">
            ${TIMES_OF_DAY.map(time => `
                <button type="button" class="segmented-control-option ${formData.times.includes(time) ? 'selected' : ''}" data-time="${time}">
                    ${getTimeOfDayIcon(time)}
                    ${getTimeOfDayName(time)}
                </button>
            `).join('')}
        </div>
    `;

    renderFrequencyOptions();
    openModal(ui.editHabitModal);
}

export function renderExploreHabits() {
    const fragment = document.createDocumentFragment();

    PREDEFINED_HABITS.forEach((habit, index) => {
        const name = t(habit.nameKey);
        const subtitle = t(habit.subtitleKey);

        const itemEl = document.createElement('div');
        itemEl.className = 'explore-habit-item';
        itemEl.dataset.index = String(index);
        itemEl.setAttribute('role', 'button');
        itemEl.setAttribute('tabindex', '0');

        const iconEl = document.createElement('div');
        iconEl.className = 'explore-habit-icon';
        iconEl.style.backgroundColor = `${habit.color}30`;
        iconEl.style.color = habit.color;
        iconEl.innerHTML = habit.icon;

        const detailsEl = document.createElement('div');
        detailsEl.className = 'explore-habit-details';

        const nameEl = document.createElement('div');
        nameEl.className = 'name';
        nameEl.textContent = name;

        const subtitleEl = document.createElement('div');
        subtitleEl.className = 'subtitle';
        subtitleEl.textContent = subtitle;

        detailsEl.appendChild(nameEl);
        detailsEl.appendChild(subtitleEl);

        itemEl.appendChild(iconEl);
        itemEl.appendChild(detailsEl);

        fragment.appendChild(itemEl);
    });

    ui.exploreHabitList.innerHTML = '';
    ui.exploreHabitList.appendChild(fragment);
}

function _renderReelRotary(
    reelEl: HTMLElement,
    viewportEl: HTMLElement,
    options: readonly string[] | string[],
    currentIndex: number,
    fallbackItemWidth: number,
    ariaLabelKey: string
) {
    if (!reelEl) return;
    const firstOption = reelEl.querySelector('.reel-option') as HTMLElement | null;
    const itemWidth = firstOption?.offsetWidth || fallbackItemWidth;
    const effectiveIndex = Math.max(0, currentIndex);
    const transformX = -effectiveIndex * itemWidth;
    reelEl.style.transform = `translateX(${transformX}px)`;
    updateReelRotaryARIA(viewportEl, effectiveIndex, options, ariaLabelKey);
}

export function renderLanguageFilter() {
    const currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
    const langNames = LANGUAGES.map(lang => t(lang.nameKey));
    _renderReelRotary(
        ui.languageReel,
        ui.languageViewport,
        langNames,
        currentIndex,
        95, 
        'language_ariaLabel'
    );
}
