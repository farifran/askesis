
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file render/modals.ts
 * @description Motor de Renderização de Modais e Diálogos (UI Overlay Layer).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo gerencia o ciclo de vida visual e a acessibilidade (A11y) de elementos sobrepostos.
 * 
 * ARQUITETURA (Stack-Based Engine):
 * - **Modal Stack:** Gerencia modais aninhados (ex: Confirmação sobre Edição) usando uma pilha LIFO.
 * - **Global Delegation:** Apenas dois listeners globais (`keydown`, `click`) gerenciam todos os modais.
 * - **Typed OM:** Uso estrito de API tipada para estilos.
 */

import { state, Habit, HabitTemplate, Frequency, PredefinedHabit, TimeOfDay, STREAK_CONSOLIDATED, TIMES_OF_DAY, FREQUENCIES, LANGUAGES, getHabitDailyInfoForDate } from '../state';
import { PREDEFINED_HABITS } from '../data/predefinedHabits';
import { getScheduleForDate, calculateHabitStreak, getHabitDisplayInfo } from '../services/selectors';
import { ui } from './ui';
import { t, compareStrings, formatDate, formatInteger, getTimeOfDayName, setLanguage } from '../i18n';
import { HABIT_ICONS, UI_ICONS, getTimeOfDayIcon } from './icons';
import { setTextContent, updateReelRotaryARIA, setTransformX, setCSSVariableString } from './dom';
import { escapeHTML, getContrastColor, parseUTCIsoDate, getTodayUTCIso, getSafeDate } from '../utils';

// --- MODAL STACK ENGINE ---

interface ModalContext {
    element: HTMLElement;
    previousFocus: HTMLElement | null;
    onClose?: () => void;
    firstFocusable?: HTMLElement;
    lastFocusable?: HTMLElement;
}

const modalStack: ModalContext[] = [];

// PERFORMANCE [2025-04-13]: Hoisted Intl Options.
const OPTS_NOTES_DATE: Intl.DateTimeFormatOptions = { 
    day: 'numeric', 
    month: 'long', 
    timeZone: 'UTC' 
};

// --- STATIC HANDLERS (Global Delegation) ---

function _updateInertState() {
    if (modalStack.length > 0) {
        ui.appContainer.setAttribute('inert', '');
    } else {
        ui.appContainer.removeAttribute('inert');
    }
}

function _handleTrapKeydown(e: KeyboardEvent) {
    const activeCtx = modalStack[modalStack.length - 1];
    if (!activeCtx) return;

    if (e.key === 'Escape') {
        closeModal(activeCtx.element);
        e.stopImmediatePropagation();
        return;
    }

    if (e.key === 'Tab') {
        const { firstFocusable, lastFocusable, element } = activeCtx;
        
        if (!firstFocusable || !lastFocusable) {
            e.preventDefault();
            element.focus();
            return;
        }

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
    }
}

function _handleGlobalClick(e: MouseEvent) {
    const activeCtx = modalStack[modalStack.length - 1];
    if (!activeCtx) return;

    const target = e.target as HTMLElement;

    if (target === activeCtx.element) {
        closeModal(activeCtx.element);
        return;
    }

    const closeBtn = target.closest('.modal-close-btn');
    if (closeBtn && activeCtx.element.contains(closeBtn)) {
        closeModal(activeCtx.element);
    }
}

export function initModalEngine() {
    document.addEventListener('keydown', _handleTrapKeydown);
    document.addEventListener('click', _handleGlobalClick);
}

export function openModal(modal: HTMLElement, elementToFocus?: HTMLElement, onClose?: () => void) {
    const ctx: ModalContext = {
        element: modal,
        previousFocus: document.activeElement as HTMLElement,
        onClose
    };

    modal.classList.add('visible');
    
    const focusableElements = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    
    if (focusableElements.length > 0) {
        ctx.firstFocusable = focusableElements[0];
        ctx.lastFocusable = focusableElements[focusableElements.length - 1];
        
        const target = elementToFocus || ctx.firstFocusable;
        
        requestAnimationFrame(() => {
            if (target.isConnected) {
                if (target instanceof HTMLTextAreaElement) {
                    target.focus();
                    target.selectionStart = target.selectionEnd = target.value.length;
                } else if (target instanceof HTMLInputElement) {
                    target.focus();
                    target.select();
                } else {
                    target.focus();
                }
            }
        });
    } else {
        modal.setAttribute('tabindex', '-1');
        modal.focus();
    }

    modalStack.push(ctx);
    _updateInertState();
}

export function closeModal(modal: HTMLElement) {
    const index = modalStack.findIndex(ctx => ctx.element === modal);
    if (index === -1) return;

    const ctx = modalStack[index];
    modalStack.splice(index, 1);
    
    modal.classList.remove('visible');
    _updateInertState();

    ctx.onClose?.();

    const isTopInteraction = modalStack.length === 0 || index === modalStack.length; 
    
    if (isTopInteraction && ctx.previousFocus && ctx.previousFocus.isConnected) {
        ctx.previousFocus.focus();
    } else if (modalStack.length === 0) {
        ui.habitContainer.focus();
    }
}

// --- DOM TEMPLATES ---
let manageItemTemplate: HTMLLIElement | null = null;
const buttonTemplates: Record<string, HTMLButtonElement> = {};

const STATUS_ORDER = { 'active': 0, 'graduated': 1, 'ended': 2 } as const;

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

function getManageItemTemplate(): HTMLLIElement {
    if (!manageItemTemplate) {
        manageItemTemplate = document.createElement('li');
        manageItemTemplate.className = 'habit-list-item';

        const mainSpan = document.createElement('span');
        mainSpan.className = 'habit-main-info';
        
        const iconSpan = document.createElement('span');
        iconSpan.className = 'habit-icon-slot';
        
        const textWrapper = document.createElement('div');
        textWrapper.style.display = 'flex';
        textWrapper.style.flexDirection = 'column';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'habit-name';

        const subtitleSpan = document.createElement('span');
        subtitleSpan.className = 'habit-subtitle';
        subtitleSpan.style.fontSize = '11px';
        subtitleSpan.style.color = 'var(--text-tertiary)';
        
        textWrapper.appendChild(nameSpan);
        textWrapper.appendChild(subtitleSpan);
        
        const statusSpan = document.createElement('span');
        statusSpan.className = 'habit-name-status';
        
        mainSpan.append(iconSpan, textWrapper, statusSpan);
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'habit-list-actions';
        
        manageItemTemplate.append(mainSpan, actionsDiv);
    }
    return manageItemTemplate;
}

function getButtonTemplate(className: string, iconHtml: string): HTMLButtonElement {
    if (!buttonTemplates[className]) {
        const button = document.createElement('button');
        button.className = className;
        button.type = "button";
        button.innerHTML = iconHtml;
        buttonTemplates[className] = button;
    }
    return buttonTemplates[className];
}

function _appendManageButton(actionsDiv: HTMLElement, className: string, ariaLabel: string, icon: string) {
    const btn = getButtonTemplate(className, icon).cloneNode(true) as HTMLButtonElement;
    btn.setAttribute('aria-label', ariaLabel);
    actionsDiv.appendChild(btn);
}

function _createManageHabitListItem(habitData: { habit: Habit; status: 'active' | 'ended' | 'graduated'; name: string; subtitle: string }, todayISO: string): HTMLLIElement {
    const { habit, status, name, subtitle } = habitData;
    
    const li = getManageItemTemplate().cloneNode(true) as HTMLLIElement;
    
    li.classList.add(status);
    li.dataset.habitId = habit.id;

    const mainSpan = li.firstElementChild as HTMLElement;
    const iconSpan = mainSpan.children[0] as HTMLElement;
    const textWrapper = mainSpan.children[1] as HTMLElement;
    const statusSpan = mainSpan.children[2] as HTMLElement;
    const actionsDiv = li.children[1] as HTMLElement;

    iconSpan.innerHTML = habit.icon;
    iconSpan.style.color = habit.color;

    const nameSpan = textWrapper.children[0];
    setTextContent(nameSpan, name);

    const subtitleSpan = textWrapper.children[1];
    if (subtitle) {
        setTextContent(subtitleSpan, subtitle);
    } else {
        subtitleSpan.remove();
    }

    if (status === 'graduated' || status === 'ended') {
        setTextContent(statusSpan, t(status === 'graduated' ? 'modalStatusGraduated' : 'modalStatusEnded'));
    } else {
        statusSpan.remove();
    }
    
    const streak = calculateHabitStreak(habit.id, todayISO); 
    const isConsolidated = streak >= STREAK_CONSOLIDATED;

    if (status === 'active') {
        _appendManageButton(actionsDiv, 'edit-habit-btn', t('aria_edit', { habitName: name }), UI_ICONS.editAction);
        if (isConsolidated) {
            _appendManageButton(actionsDiv, 'graduate-habit-btn', t('aria_graduate', { habitName: name }), UI_ICONS.graduateAction);
        } else {
            _appendManageButton(actionsDiv, 'end-habit-btn', t('aria_end', { habitName: name }), UI_ICONS.endAction);
        }
    } else if (status === 'ended' || status === 'graduated') {
        _appendManageButton(actionsDiv, 'permanent-delete-habit-btn', t('aria_delete_permanent', { habitName: name }), UI_ICONS.deletePermanentAction);
    }
    
    return li;
}

type ManageHabitItem = {
    habit: Habit;
    status: 'active' | 'ended' | 'graduated';
    name: string;
    subtitle: string;
};

function _habitSorter(a: ManageHabitItem, b: ManageHabitItem): number {
    const statusDifference = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDifference !== 0) {
        return statusDifference;
    }
    if (a.status !== 'active') {
         const lastA = a.habit.scheduleHistory[a.habit.scheduleHistory.length-1].endDate || '';
         const lastB = b.habit.scheduleHistory[b.habit.scheduleHistory.length-1].endDate || '';
         if (lastA !== lastB) return lastB.localeCompare(lastA);
    }
    return compareStrings(a.name, b.name);
}

export function setupManageModal() {
    if (state.habits.length === 0) {
        ui.habitList.classList.add('hidden');
        ui.noHabitsMessage.classList.remove('hidden');
        ui.noHabitsMessage.textContent = t('modalManageNoHabits');
    } else {
        ui.habitList.classList.remove('hidden');
        ui.noHabitsMessage.classList.add('hidden');

        const habitsForModal = state.habits.map(habit => {
            const { name, subtitle } = getHabitDisplayInfo(habit);
            return {
                habit,
                status: getHabitStatusForSorting(habit),
                name,
                subtitle
            };
        });

        habitsForModal.sort(_habitSorter);

        const fragment = document.createDocumentFragment();
        const todayISO = getTodayUTCIso();
        
        const len = habitsForModal.length;
        for (let i = 0; i < len; i = (i + 1) | 0) {
            fragment.appendChild(_createManageHabitListItem(habitsForModal[i], todayISO));
        }

        ui.habitList.innerHTML = '';
        ui.habitList.appendChild(fragment);
    }
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
        ui.confirmModalEditBtn.classList.remove('hidden');
        setTextContent(ui.confirmModalEditBtn, options.editText);
    } else {
        ui.confirmModalEditBtn.classList.add('hidden');
    }

    openModal(ui.confirmModal);
}

export function openNotesModal(habitId: string, date: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    state.editingNoteFor = { habitId, date, time };
    
    const { name } = getHabitDisplayInfo(habit, date);
    const dateObj = parseUTCIsoDate(date);
    const formattedDate = formatDate(dateObj, OPTS_NOTES_DATE);
    const timeName = getTimeOfDayName(time);

    setTextContent(ui.notesModalTitle, name);
    setTextContent(ui.notesModalSubtitle, `${formattedDate} - ${timeName}`);
    
    const dayData = getHabitDailyInfoForDate(date)[habitId]?.instances[time];
    ui.notesTextarea.value = dayData?.note || '';
    
    openModal(ui.notesModal, ui.notesTextarea, () => {
        state.editingNoteFor = null;
    });
}

const PALETTE_COLORS = ['#e74c3c', '#f1c40f', '#3498db', '#2ecc71', '#9b59b6', '#1abc9c', '#34495e', '#e67e22', '#e84393', '#7f8c8d'];

let cachedIconButtonsHTML: string | null = null;

export function renderIconPicker() {
    if (!state.editingHabit) return;
    const bgColor = state.editingHabit.formData.color;
    const fgColor = getContrastColor(bgColor);

    // BLEEDING-EDGE FIX: Use Typed OM for String Variables (Colors)
    setCSSVariableString(ui.iconPickerGrid, '--current-habit-bg-color', bgColor);
    setCSSVariableString(ui.iconPickerGrid, '--current-habit-fg-color', fgColor);

    if (!cachedIconButtonsHTML) {
        cachedIconButtonsHTML = Object.keys(HABIT_ICONS)
            .map(key => {
                const iconSVG = (HABIT_ICONS as any)[key];
                return `
                    <button type="button" class="icon-picker-item" data-icon-svg="${escapeHTML(iconSVG)}">
                        ${iconSVG}
                    </button>
                `;
            }).join('');
    }

    if (ui.iconPickerGrid.innerHTML !== cachedIconButtonsHTML) {
        ui.iconPickerGrid.innerHTML = cachedIconButtonsHTML;
    }

    const changeColorBtn = ui.iconPickerModal.querySelector<HTMLButtonElement>('#change-color-from-picker-btn');
    if (changeColorBtn) {
        changeColorBtn.innerHTML = UI_ICONS.colorPicker;
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
        { key: 'weekdayWed', day: 3 }, { key: 'weekdayThu', day: 4 }, { key: 'weekdayFri', day: 5 }, { key: 'weekdaySat', day: 6 }
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
                    <input type="checkbox" class="visually-hidden" data-day="${day}" ${selectedDays.has(day) ? 'checked' : ''}>
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
            <span class="interval-amount-display">${formatInteger(amount)}</span>
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
            icon: HABIT_ICONS.custom,
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

export function refreshEditModalUI() {
    if (!state.editingHabit) return;

    renderFrequencyOptions();

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
    
    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    if (habitNameInput) {
        habitNameInput.placeholder = t('modalEditFormNameLabel');
        
        if (state.editingHabit.formData.nameKey) {
            habitNameInput.value = t(state.editingHabit.formData.nameKey);
        }
    }
}

export function openEditModal(habitOrTemplate: Habit | HabitTemplate | null) {
    const isNew = !habitOrTemplate || !('id' in habitOrTemplate);
    const form = ui.editHabitForm;
    
    const formNoticeEl = form.querySelector<HTMLElement>('.form-notice')!;
    const nameInput = form.elements.namedItem('habit-name') as HTMLInputElement;

    if (formNoticeEl) formNoticeEl.classList.remove('visible');
    if (nameInput) nameInput.classList.remove('shake');
    
    ui.editHabitSaveBtn.disabled = false;
    form.reset();
    
    const safeDate = getSafeDate(state.selectedDate);
    const formData = _createHabitTemplateForForm(habitOrTemplate as Habit | PredefinedHabit | null, safeDate);
    nameInput.placeholder = t('modalEditFormNameLabel');

    if (isNew) {
        setTextContent(ui.editHabitModalTitle, t('modalEditNewTitle'));
        nameInput.value = (habitOrTemplate && 'nameKey' in habitOrTemplate) ? t(habitOrTemplate.nameKey) : '';
    } else {
        const { name } = getHabitDisplayInfo(habitOrTemplate as Habit, safeDate);
        setTextContent(ui.editHabitModalTitle, name);
        nameInput.value = name;
    }

    state.editingHabit = {
        isNew: isNew,
        habitId: isNew ? undefined : (habitOrTemplate as Habit).id,
        originalData: isNew ? undefined : { ...(habitOrTemplate as Habit) },
        formData: formData,
        targetDate: safeDate
    };

    ui.editHabitModal.querySelector<HTMLElement>('.edit-icon-overlay')!.innerHTML = UI_ICONS.edit;
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
    openModal(ui.editHabitModal, undefined, () => {
        state.editingHabit = null;
    });
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
    
    // BLEEDING-EDGE FIX: CSS Typed OM for Translation
    setTransformX(reelEl, transformX);
    
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
