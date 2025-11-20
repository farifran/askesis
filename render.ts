/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. Implementada otimização visual na renderização da citação estoica para eliminar 'blinks' desnecessários e manter a estabilidade da UI.

import {
    state,
    Habit,
    HabitStatus,
    HabitDayData,
    getSmartGoalForHabit,
    calculateHabitStreak,
    LANGUAGES,
    FREQUENCIES,
    TIMES_OF_DAY,
    PREDEFINED_HABITS,
    STREAK_CONSOLIDATED,
    STREAK_SEMI_CONSOLIDATED,
    Frequency,
    PredefinedHabit,
    TimeOfDay,
    getScheduleForDate,
    HabitTemplate,
    getHabitDailyInfoForDate,
    calculateDaySummary,
    getActiveHabitsForDate,
} from './state';
import { getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate, escapeHTML, simpleMarkdownToHTML, pushToOneSignal, addDays, getContrastColor, getDateTimeFormat } from './utils';
import { ui } from './ui';
import { t, getLocaleDayName, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { STOIC_QUOTES } from './quotes';
import { icons, getTimeOfDayIcon } from './icons';
import { renderChart } from './chart';

const noticeTimeouts = new WeakMap<HTMLElement, number>();
const focusTrapListeners = new Map<HTMLElement, (e: KeyboardEvent) => void>();
const previouslyFocusedElements = new WeakMap<HTMLElement, HTMLElement>();

/**
 * OTIMIZAÇÃO DE PERFORMANCE: Helper para atualizar textContent apenas se o valor mudou.
 * Evita recálculos de layout/paint desnecessários no navegador.
 */
function setTextContent(element: Element | null, text: string) {
    if (element && element.textContent !== text) {
        element.textContent = text;
    }
}

function updateReelRotaryARIA(viewportEl: HTMLElement, currentIndex: number, options: readonly string[] | string[], labelKey: string) {
    if (!viewportEl) return;
    viewportEl.setAttribute('role', 'slider');
    viewportEl.setAttribute('aria-label', t(labelKey));
    viewportEl.setAttribute('aria-valuemin', '1');
    viewportEl.setAttribute('aria-valuemax', String(options.length));
    viewportEl.setAttribute('aria-valuenow', String(currentIndex + 1));
    viewportEl.setAttribute('aria-valuetext', options[currentIndex]);
    viewportEl.setAttribute('tabindex', '0');
}

export function initLanguageFilter() {
    const langNames = LANGUAGES.map(lang => t(lang.nameKey));
    ui.languageReel.innerHTML = langNames.map(name => `<span class="reel-option">${name}</span>`).join('');
    const currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
    updateReelRotaryARIA(ui.languageViewport, currentIndex, langNames, 'language_ariaLabel');
}

/**
 * OTIMIZAÇÃO (DRY): Aplica o estado visual a um elemento de dia do calendário.
 * Centraliza a lógica de classes, atributos ARIA e variáveis CSS para evitar duplicação
 * entre criação e atualização.
 */
function _applyDayState(dayItem: HTMLElement, date: Date) {
    const todayISO = getTodayUTCIso();
    const isoDate = toUTCIsoDateString(date);
    const { completedPercent, totalPercent, showPlus } = calculateDaySummary(isoDate);
    const isSelected = isoDate === state.selectedDate;
    const isToday = isoDate === todayISO;

    // Gerenciamento de Classes
    if (isSelected) dayItem.classList.add('selected');
    else dayItem.classList.remove('selected');

    if (isToday) dayItem.classList.add('today');
    else dayItem.classList.remove('today');

    // Acessibilidade e Estado
    dayItem.setAttribute('aria-pressed', String(isSelected));
    // PERFORMANCE [2025-01-16]: Uso de cache para Intl.DateTimeFormat.
    const ariaDate = getDateTimeFormat(state.activeLanguageCode, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC'
    }).format(date);
    dayItem.setAttribute('aria-label', ariaDate);

    // Atualização Visual (Variáveis CSS e Indicadores)
    const dayProgressRing = dayItem.querySelector<HTMLElement>('.day-progress-ring');
    if (dayProgressRing) {
        dayProgressRing.style.setProperty('--completed-percent', `${completedPercent}%`);
        dayProgressRing.style.setProperty('--total-percent', `${totalPercent}%`);
        
        // OTIMIZAÇÃO: Manipulação direta do DOM para o indicador Plus
        const dayNumber = dayProgressRing.querySelector<HTMLElement>('.day-number');
        if (dayNumber) {
            if (showPlus) dayNumber.classList.add('has-plus');
            else dayNumber.classList.remove('has-plus');
            // Usa setTextContent para o número do dia
            setTextContent(dayNumber, String(date.getUTCDate()));
        }
    }
    
    const dayNameEl = dayItem.querySelector('.day-name');
    setTextContent(dayNameEl, getLocaleDayName(date));
}

function updateCalendarDayElement(dayItem: HTMLElement, date: Date) {
    _applyDayState(dayItem, date);
}

function createCalendarDayElement(date: Date): HTMLElement {
    const dayItem = document.createElement('div');
    dayItem.className = 'day-item';
    dayItem.dataset.date = toUTCIsoDateString(date);
    dayItem.setAttribute('role', 'button');

    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = getLocaleDayName(date);

    const dayProgressRing = document.createElement('div');
    dayProgressRing.className = 'day-progress-ring';

    const dayNumber = document.createElement('span');
    dayNumber.className = 'day-number';
    dayNumber.textContent = String(date.getUTCDate());

    dayProgressRing.appendChild(dayNumber);
    dayItem.appendChild(dayName);
    dayItem.appendChild(dayProgressRing);

    // Aplica o estado inicial imediatamente
    _applyDayState(dayItem, date);

    return dayItem;
}

/**
 * Helper centralizado para rolar o calendário para o dia "Hoje".
 * Garante consistência visual (alinhamento ao final) em toda a aplicação.
 */
export function scrollToToday(behavior: ScrollBehavior = 'auto') {
    // setTimeout com 0ms garante que o layout tenha sido calculado antes de rolar,
    // especialmente útil quando chamado logo após atualizações do DOM.
    setTimeout(() => {
        const todayEl = ui.calendarStrip.querySelector<HTMLElement>('.day-item.today');
        if (todayEl) {
            todayEl.scrollIntoView({ behavior, block: 'nearest', inline: 'end' });
        }
    }, 0);
}

export function renderCalendar() {
    const dayElements = Array.from(ui.calendarStrip.querySelectorAll<HTMLElement>('.day-item'));
    
    if (dayElements.length === 0) {
        const fragment = document.createDocumentFragment();
        state.calendarDates.forEach(date => {
            fragment.appendChild(createCalendarDayElement(date));
        });
        ui.calendarStrip.appendChild(fragment);

        // UX IMPROVEMENT: Rola automaticamente o calendário na inicialização.
        scrollToToday('auto');
        return;
    }
    
    dayElements.forEach((dayEl, index) => {
        const date = state.calendarDates[index];
        if (date) {
            updateCalendarDayElement(dayEl, date);
        }
    });
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
        95, // Largura de fallback
        'language_ariaLabel'
    );
}

export function renderFullCalendar() {
    const { year, month } = state.fullCalendar;
    const todayISO = getTodayUTCIso();

    const monthDate = new Date(Date.UTC(year, month, 1));
    // PERFORMANCE [2025-01-16]: Uso de cache para Intl.DateTimeFormat.
    ui.fullCalendarMonthYear.textContent = getDateTimeFormat(state.activeLanguageCode, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(monthDate);

    const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const startDayOfWeek = firstDayOfMonth.getUTCDay();

    const daysInPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const grid = ui.fullCalendarGrid;
    grid.innerHTML = '';
    
    if (ui.fullCalendarWeekdays.childElementCount === 0) {
        const weekdaysFragment = document.createDocumentFragment();
        for (let i = 0; i < 7; i++) {
            const day = new Date(Date.UTC(2024, 0, 7 + i));
            const weekdayEl = document.createElement('div');
            weekdayEl.textContent = getLocaleDayName(day).substring(0, 1);
            weekdaysFragment.appendChild(weekdayEl);
        }
        ui.fullCalendarWeekdays.appendChild(weekdaysFragment);
    }
    
    const fragment = document.createDocumentFragment();
    let totalGridCells = 0;

    for (let i = 0; i < startDayOfWeek; i++) {
        const day = daysInPrevMonth - startDayOfWeek + 1 + i;
        const dayEl = document.createElement('div');
        dayEl.className = 'full-calendar-day other-month';
        
        const numberEl = document.createElement('span');
        numberEl.className = 'day-number';
        numberEl.textContent = String(day);
        
        dayEl.appendChild(numberEl);
        fragment.appendChild(dayEl);
        totalGridCells++;
    }

    // Cache formatters fora do loop
    const ariaDateFormatter = getDateTimeFormat(state.activeLanguageCode, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC'
    });

    for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(Date.UTC(year, month, day));
        const isoDate = toUTCIsoDateString(currentDate);
        const { completedPercent, totalPercent } = calculateDaySummary(isoDate);

        const dayEl = document.createElement('div');
        dayEl.className = 'full-calendar-day';
        dayEl.dataset.date = isoDate;
        dayEl.setAttribute('role', 'button');
        const isSelected = isoDate === state.selectedDate;
        dayEl.classList.toggle('selected', isSelected);
        dayEl.classList.toggle('today', isoDate === todayISO);
        dayEl.setAttribute('aria-pressed', String(isSelected));
        dayEl.setAttribute('aria-label', ariaDateFormatter.format(currentDate));
        dayEl.setAttribute('tabindex', isSelected ? '0' : '-1');

        const ringEl = document.createElement('div');
        ringEl.className = 'day-progress-ring';
        ringEl.style.setProperty('--completed-percent', `${completedPercent}%`);
        ringEl.style.setProperty('--total-percent', `${totalPercent}%`);

        const numberEl = document.createElement('span');
        numberEl.className = 'day-number';
        numberEl.textContent = String(day);
        
        ringEl.appendChild(numberEl);
        dayEl.appendChild(ringEl);
        fragment.appendChild(dayEl);
        totalGridCells++;
    }
    
    const remainingCells = (7 - (totalGridCells % 7)) % 7;
    for (let i = 1; i <= remainingCells; i++) {
        const day = i;
        const dayEl = document.createElement('div');
        dayEl.className = 'full-calendar-day other-month';
        
        const numberEl = document.createElement('span');
        numberEl.className = 'day-number';
        numberEl.textContent = String(day);
        
        dayEl.appendChild(numberEl);
        fragment.appendChild(dayEl);
    }
    
    grid.appendChild(fragment);
}


export function renderFrequencyOptions() {
    if (!state.editingHabit) return;

    const currentFrequency = state.editingHabit.formData.frequency;
    const container = ui.frequencyOptionsContainer;
    const isDaily = currentFrequency.type === 'daily';
    const isSpecificDays = currentFrequency.type === 'specific_days_of_week';
    const isInterval = currentFrequency.type === 'interval';

    const weekdays = [
        { key: 'weekdaySun', day: 0 }, { key: 'weekdayMon', day: 1 }, { key: 'weekdayTue', day: 2 },
        { key: 'weekdayWed', day: 3 }, { key: 'weekdayThu', day: 4 }, { key: 'weekdayFri', day: 5 },
        { key: 'weekdaySat', day: 6 }
    ];
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
            <div class="form-row">
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


export const getUnitString = (habit: Habit, value: number | undefined) => {
    const unitKey = habit.goal.unitKey || 'unitCheck';
    return t(unitKey, { count: value });
};

export const formatGoalForDisplay = (goal: number): string => {
    if (goal < 5) return '< 5';
    if (goal > 95) return '> 95';
    return goal.toString();
};

function updateGoalContentElement(goalEl: HTMLElement, status: HabitStatus, habit: Habit, time: TimeOfDay, dayDataForInstance: HabitDayData | undefined) {
    // OTIMIZAÇÃO DE PERFORMANCE: Verificação de reconciliação DOM para evitar recriação do innerHTML
    // se a estrutura já estiver correta, atualizando apenas o texto e classes.

    if (status === 'completed') {
        if (habit.goal.type === 'pages' || habit.goal.type === 'minutes') {
            const smartGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
            const completedGoal = dayDataForInstance?.goalOverride ?? smartGoal;
            const displayVal = formatGoalForDisplay(completedGoal);
            const unitVal = getUnitString(habit, completedGoal);

            // Verifica se a estrutura de meta numérica completa já existe
            const existingWrapper = goalEl.querySelector('.goal-value-wrapper');
            const existingControls = goalEl.querySelector('.habit-goal-controls');
            
            // Se existe o wrapper E NÃO existem os controles (botões +/-), é a view "concluída numérica" correta
            if (existingWrapper && !existingControls) {
                 const prog = goalEl.querySelector('.progress');
                 const unit = goalEl.querySelector('.unit');
                 if (prog && unit) {
                      setTextContent(prog, displayVal);
                      setTextContent(unit, unitVal);
                 }
                 return; // Reconciliação bem sucedida
            }
            
            // Fallback: Recria a estrutura
            goalEl.innerHTML = `
                <div class="goal-value-wrapper">
                    <div class="progress" style="color: var(--accent-blue);">${displayVal}</div>
                    <div class="unit">${unitVal}</div>
                </div>`;
        } else {
            // Checkmark
            if (goalEl.innerHTML.includes('✓') && goalEl.querySelector('.progress')) return;
            goalEl.innerHTML = `<div class="progress" style="color: var(--accent-blue);">✓</div><div class="unit">${getUnitString(habit, 1)}</div>`;
        }
    } else if (status === 'snoozed') {
        // CORREÇÃO DE LAYOUT [2025-01-16]: Uso de wrapper específico para evitar sobreposição de ícone e texto.
        if (goalEl.querySelector('.snoozed-wrapper')) return;

        goalEl.innerHTML = `
            <div class="snoozed-wrapper">
                <svg class="snoozed-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="13 17 18 12 13 7"></polyline>
                    <polyline points="6 17 11 12 6 7"></polyline>
                </svg>
                <span class="snoozed-text">${t('habitSnoozed')}</span>
            </div>`;
    } else { 
        // Pending (Controls)
        if (habit.goal.type === 'pages' || habit.goal.type === 'minutes') {
            const smartGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
            const currentGoal = dayDataForInstance?.goalOverride ?? smartGoal;
            const displayVal = formatGoalForDisplay(currentGoal);
            const unitVal = getUnitString(habit, currentGoal);

            // Verifica se os controles já existem
            const existingControls = goalEl.querySelector('.habit-goal-controls');
            if (existingControls) {
                const prog = goalEl.querySelector('.progress');
                const unit = goalEl.querySelector('.unit');
                if (prog && unit) {
                    setTextContent(prog, displayVal);
                    setTextContent(unit, unitVal);
                }
                return; // Reconciliação bem sucedida
            }

            // Fallback: Recria a estrutura com type="button" para evitar submit acidental
            goalEl.innerHTML = `
                <div class="habit-goal-controls">
                    <button type="button" class="goal-control-btn" data-habit-id="${habit.id}" data-time="${time}" data-action="decrement" aria-label="${t('habitGoalDecrement_ariaLabel')}">-</button>
                    <div class="goal-value-wrapper">
                        <div class="progress">${displayVal}</div>
                        <div class="unit">${unitVal}</div>
                    </div>
                    <button type="button" class="goal-control-btn" data-habit-id="${habit.id}" data-time="${time}" data-action="increment" aria-label="${t('habitGoalIncrement_ariaLabel')}">+</button>
                </div>`;
        } else {
            goalEl.innerHTML = ''; // Limpa se não for meta numérica
        }
    }
}

function _updateConsolidationMessage(detailsEl: HTMLElement, streak: number) {
    let msgEl = detailsEl.querySelector<HTMLElement>('.consolidation-message');

    let messageText: string | null = null;
    if (streak >= STREAK_CONSOLIDATED) {
        messageText = t('habitConsolidatedMessage');
    } else if (streak >= STREAK_SEMI_CONSOLIDATED) {
        messageText = t('habitSemiConsolidatedMessage');
    }

    if (messageText) {
        if (!msgEl) {
            msgEl = document.createElement('div');
            msgEl.className = 'consolidation-message';
            detailsEl.appendChild(msgEl);
        }
        setTextContent(msgEl, messageText);
    } else if (msgEl) {
        msgEl.remove();
    }
}

function updateHabitCardElement(card: HTMLElement, habit: Habit, time: TimeOfDay): void {
    const dailyInfo = getHabitDailyInfoForDate(state.selectedDate);
    const habitInstanceData = dailyInfo[habit.id]?.instances?.[time];
    const status = habitInstanceData?.status ?? 'pending';
    const hasNote = habitInstanceData?.note && habitInstanceData.note.length > 0;
    const streak = calculateHabitStreak(habit.id, getTodayUTCIso());

    // UX-FIX [2024-12-28]: Atualiza classes com segurança para preservar o estado de interação
    // (como 'is-open-left', 'dragging') durante atualizações de dados.
    // Remove classes de status antigas de forma cirúrgica
    card.classList.remove('pending', 'completed', 'snoozed');
    // Adiciona a classe de status atual
    card.classList.add(status);

    card.classList.remove('consolidated', 'semi-consolidated');
    if (streak >= STREAK_CONSOLIDATED) card.classList.add('consolidated');
    else if (streak >= STREAK_SEMI_CONSOLIDATED) card.classList.add('semi-consolidated');
    
    const { name, subtitle } = getHabitDisplayInfo(habit, state.selectedDate);
    setTextContent(card.querySelector('.habit-details .name'), name);
    setTextContent(card.querySelector('.habit-details .subtitle'), subtitle);

    const detailsEl = card.querySelector<HTMLElement>('.habit-details');
    if(detailsEl) {
        _updateConsolidationMessage(detailsEl, streak);
    }
    
    const noteBtn = card.querySelector<HTMLElement>('.swipe-note-btn');
    if (noteBtn) {
        const hasNoteStr = String(hasNote);
        // OTIMIZAÇÃO: Verifica o estado via dataset antes de manipular o DOM/SVG
        if (noteBtn.dataset.hasNote !== hasNoteStr) {
            noteBtn.innerHTML = hasNote ? icons.swipeNoteHasNote : icons.swipeNote;
            noteBtn.setAttribute('aria-label', t(hasNote ? 'habitNoteEdit_ariaLabel' : 'habitNoteAdd_ariaLabel'));
            noteBtn.dataset.hasNote = hasNoteStr;
        }
    }

    const goalEl = card.querySelector<HTMLElement>('.habit-goal');
    if (goalEl) {
        updateGoalContentElement(goalEl, status, habit, time, habitInstanceData);
    }
}


export function createHabitCardElement(habit: Habit, time: TimeOfDay): HTMLElement {
    const dailyInfo = getHabitDailyInfoForDate(state.selectedDate);
    const habitInstanceData = dailyInfo[habit.id]?.instances?.[time];
    const status = habitInstanceData?.status ?? 'pending';
    const hasNote = habitInstanceData?.note && habitInstanceData.note.length > 0;
    const streak = calculateHabitStreak(habit.id, getTodayUTCIso());
    
    const card = document.createElement('div');
    // Define as classes iniciais. Como é um novo elemento, não precisamos nos preocupar com estado anterior.
    card.className = `habit-card ${status}`;
    card.dataset.habitId = habit.id;
    card.dataset.time = time;

    if (streak >= STREAK_CONSOLIDATED) card.classList.add('consolidated');
    else if (streak >= STREAK_SEMI_CONSOLIDATED) card.classList.add('semi-consolidated');

    const { name, subtitle } = getHabitDisplayInfo(habit, state.selectedDate);

    const actionsLeft = document.createElement('div');
    actionsLeft.className = 'habit-actions-left';
    actionsLeft.innerHTML = `<button type="button" class="swipe-delete-btn" aria-label="${t('habitEnd_ariaLabel')}">${icons.swipeDelete}</button>`;

    const actionsRight = document.createElement('div');
    actionsRight.className = 'habit-actions-right';
    // Inicializa o dataset.hasNote para sincronização correta no update futuro
    actionsRight.innerHTML = `<button type="button" class="swipe-note-btn" data-has-note="${hasNote}" aria-label="${t(hasNote ? 'habitNoteEdit_ariaLabel' : 'habitNoteAdd_ariaLabel')}">${hasNote ? icons.swipeNoteHasNote : icons.swipeNote}</button>`;
    
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'habit-content-wrapper';
    contentWrapper.draggable = true;

    const timeOfDayIcon = document.createElement('div');
    timeOfDayIcon.className = 'time-of-day-icon';
    timeOfDayIcon.innerHTML = getTimeOfDayIcon(time);
    
    const icon = document.createElement('div');
    icon.className = 'habit-icon';
    icon.style.backgroundColor = `${habit.color}30`;
    icon.style.color = habit.color;
    icon.innerHTML = habit.icon;

    const details = document.createElement('div');
    details.className = 'habit-details';
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = name;
    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'subtitle';
    subtitleEl.textContent = subtitle;
    details.append(nameEl, subtitleEl);
    
    _updateConsolidationMessage(details, streak);

    const goal = document.createElement('div');
    goal.className = 'habit-goal';
    updateGoalContentElement(goal, status, habit, time, habitInstanceData);

    contentWrapper.append(timeOfDayIcon, icon, details, goal);
    card.append(actionsLeft, actionsRight, contentWrapper);
    
    return card;
}

function updatePlaceholderForGroup(groupEl: HTMLElement, time: TimeOfDay, hasHabits: boolean, isSmartPlaceholder: boolean, emptyTimes: TimeOfDay[]) {
    let placeholder = groupEl.querySelector<HTMLElement>('.empty-group-placeholder');
    
    if (!hasHabits) {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'empty-group-placeholder';
            groupEl.appendChild(placeholder);
        }
        placeholder.classList.toggle('show-smart-placeholder', isSmartPlaceholder);
        
        const text = t('dragToAddHabit');
        let iconHTML = '';

        if (isSmartPlaceholder) {
            const genericIconHTML = emptyTimes
                .map(getTimeOfDayIcon)
                .join('<span class="icon-separator">/</span>');
            const specificIconHTML = getTimeOfDayIcon(time);
            
            iconHTML = `
                <span class="placeholder-icon-generic">${genericIconHTML}</span>
                <span class="placeholder-icon-specific">${specificIconHTML}</span>
            `;
        } else {
            iconHTML = `<span class="placeholder-icon-specific">${getTimeOfDayIcon(time)}</span>`;
        }
        
        placeholder.innerHTML = `<div class="time-of-day-icon">${iconHTML}</div><span>${text}</span>`;

    } else if (placeholder) {
        placeholder.remove();
    }
}

export function renderHabits() {
    const selectedDateObj = parseUTCIsoDate(state.selectedDate);
    const activeHabitsData = getActiveHabitsForDate(selectedDateObj);
    const habitsByTime: Record<TimeOfDay, Habit[]> = { 'Morning': [], 'Afternoon': [], 'Evening': [] };
    
    activeHabitsData.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            if (habitsByTime[time]) {
                habitsByTime[time].push(habit);
            }
        });
    });

    const groupHasHabits: Record<TimeOfDay, boolean> = { 'Morning': false, 'Afternoon': false, 'Evening': false };
    TIMES_OF_DAY.forEach(time => {
        groupHasHabits[time] = habitsByTime[time].length > 0;
    });

    const emptyTimes = TIMES_OF_DAY.filter(time => !groupHasHabits[time]);
    const smartPlaceholderTargetTime: TimeOfDay | undefined = emptyTimes[0];

    TIMES_OF_DAY.forEach(time => {
        const wrapperEl = ui.habitContainer.querySelector(`.habit-group-wrapper[data-time-wrapper="${time}"]`);
        const groupEl = wrapperEl?.querySelector<HTMLElement>(`.habit-group[data-time="${time}"]`);
        if (!wrapperEl || !groupEl) return;
        
        const existingCards = Array.from(groupEl.querySelectorAll<HTMLElement>('.habit-card'));
        const existingCardsMap = new Map<string, HTMLElement>();
        existingCards.forEach(card => {
            const key = `${card.dataset.habitId}|${card.dataset.time}`;
            existingCardsMap.set(key, card);
        });

        const desiredHabits = habitsByTime[time];
        
        // DOM RECONCILIATION STRATEGY:
        // Iteramos pela lista de hábitos desejados na ordem correta.
        // Mantemos um cursor (currentIndex) que aponta para a posição esperada no DOM.
        // Se o elemento no cursor não for o card desejado, inserimos o card antes dele.
        // Isso garante a ordem correta com o mínimo de movimentações e preserva o estado do DOM.
        
        let currentIndex = 0;

        desiredHabits.forEach(habit => {
            const key = `${habit.id}|${time}`;
            let card = existingCardsMap.get(key);
            
            if (card) {
                updateHabitCardElement(card, habit, time);
                existingCardsMap.delete(key); // Remove do mapa para sabermos quais sobraram (e devem ser deletados)
            } else {
                card = createHabitCardElement(habit, time);
            }
            
            if (card) {
                const currentChildAtIndex = groupEl.children[currentIndex];
                
                // Se o card não estiver na posição exata que esperamos...
                if (currentChildAtIndex !== card) {
                    if (currentChildAtIndex) {
                        // Insere antes do elemento que está ocupando o lugar errado
                        groupEl.insertBefore(card, currentChildAtIndex);
                    } else {
                        // Se não há elemento na posição (fim da lista), apenas anexa
                        groupEl.appendChild(card);
                    }
                }
                // Avança o cursor apenas se inserimos ou confirmamos um card de hábito
                currentIndex++;
            }
        });

        // Remove quaisquer cards que sobraram no DOM mas não estão mais na lista ativa
        existingCardsMap.forEach(cardToRemove => cardToRemove.remove());
        
        const hasHabits = groupHasHabits[time];
        const isSmartPlaceholder = time === smartPlaceholderTargetTime;
        
        wrapperEl.classList.toggle('has-habits', hasHabits);
        wrapperEl.classList.toggle('is-collapsible', !hasHabits && !isSmartPlaceholder);

        updatePlaceholderForGroup(groupEl, time, hasHabits, isSmartPlaceholder, emptyTimes);
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

export function renderAINotificationState() {
    const isLoading = state.aiState === 'loading';
    const isOffline = !navigator.onLine;
    const hasCelebrations = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0;
    const hasUnseenResult = (state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult;

    ui.aiEvalBtn.classList.toggle('loading', isLoading);
    ui.aiEvalBtn.disabled = isLoading || isOffline;
    ui.aiEvalBtn.classList.toggle('has-notification', hasCelebrations || hasUnseenResult);
}

export function renderStoicQuote() {
    const date = parseUTCIsoDate(state.selectedDate);
    const startOfYear = new Date(date.getUTCFullYear(), 0, 0);
    const diff = date.getTime() - startOfYear.getTime();
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);
    
    const quoteIndex = dayOfYear % STOIC_QUOTES.length;
    const quote = STOIC_QUOTES[quoteIndex];
    
    const lang = state.activeLanguageCode as keyof typeof quote;
    const quoteText = quote[lang];
    
    const fullText = `"${quoteText}" — ${t('marcusAurelius')}`;

    // UX POLISH [2025-01-16]: Evita o "blink" da citação se o texto não mudou.
    // Isso mantém a UI estável quando renderApp() é chamado por ações que não alteram a data.
    if (ui.stoicQuoteDisplay.textContent === fullText && ui.stoicQuoteDisplay.classList.contains('visible')) {
        return;
    }

    // STARTUP OPTIMIZATION [2025-01-16]: Se for a primeira renderização (conteúdo vazio), mostra imediatamente.
    // Isso melhora a percepção de velocidade inicial da app (LCP).
    if (ui.stoicQuoteDisplay.textContent === '') {
         setTextContent(ui.stoicQuoteDisplay, fullText);
         ui.stoicQuoteDisplay.classList.add('visible');
         return;
    }

    ui.stoicQuoteDisplay.classList.remove('visible');
    
    setTimeout(() => {
        setTextContent(ui.stoicQuoteDisplay, fullText);
        ui.stoicQuoteDisplay.classList.add('visible');
    }, 100);
}

export function updateHeaderTitle() {
    const todayISO = getTodayUTCIso();
    const yesterdayISO = toUTCIsoDateString(addDays(parseUTCIsoDate(todayISO), -1));
    const tomorrowISO = toUTCIsoDateString(addDays(parseUTCIsoDate(todayISO), 1));

    const specialDateMap: Record<string, string> = {
        [todayISO]: 'headerTitleToday',
        [yesterdayISO]: 'headerTitleYesterday',
        [tomorrowISO]: 'headerTitleTomorrow',
    };

    let desktopTitle: string;
    let mobileTitle: string;
    
    const specialDateKey = specialDateMap[state.selectedDate];

    if (specialDateKey) {
        const title = t(specialDateKey);
        desktopTitle = title;
        mobileTitle = title;
    } else {
        const date = parseUTCIsoDate(state.selectedDate);

        const day = String(date.getUTCDate()).padStart(2, '0');
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        mobileTitle = `${day}/${month}`;
        
        // PERFORMANCE [2025-01-16]: Uso de cache para Intl.DateTimeFormat.
        desktopTitle = getDateTimeFormat(state.activeLanguageCode, {
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC'
        }).format(date);
    }
    setTextContent(ui.headerTitleDesktop, desktopTitle);
    setTextContent(ui.headerTitleMobile, mobileTitle);
}


export function updateNotificationUI() {
    pushToOneSignal((OneSignal: any) => {
        const permission = OneSignal.Notifications.permission;
        const isPushEnabled = OneSignal.User.PushSubscription.optedIn;

        if (permission === "denied") {
            ui.notificationToggle.checked = false;
            ui.notificationToggle.disabled = true;
            ui.notificationToggleLabel.style.cursor = 'not-allowed';
            setTextContent(ui.notificationStatusDesc, t('notificationStatusDisabled'));
        } else {
            ui.notificationToggle.disabled = false;
            ui.notificationToggleLabel.style.cursor = 'pointer';

            ui.notificationToggle.checked = isPushEnabled;

            if (isPushEnabled) {
                setTextContent(ui.notificationStatusDesc, t('notificationStatusEnabled'));
            } else {
                setTextContent(ui.notificationStatusDesc, t('modalManageNotificationsStaticDesc'));
            }
        }
    });
}


export function renderApp() {
    renderHabits();
    renderCalendar();
    renderAINotificationState();
    renderStoicQuote();
    renderChart();
    updateHeaderTitle();
}

export function openModal(modal: HTMLElement, elementToFocus?: HTMLElement) {
    previouslyFocusedElements.set(modal, document.activeElement as HTMLElement);

    modal.classList.add('visible');

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
    
    const listener = focusTrapListeners.get(modal);
    if (listener) {
        modal.removeEventListener('keydown', listener);
        focusTrapListeners.delete(modal);
    }

    const elementToRestoreFocus = previouslyFocusedElements.get(modal);
    if (elementToRestoreFocus) {
        elementToRestoreFocus.focus();
        previouslyFocusedElements.delete(modal);
    }
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

export function showInlineNotice(element: HTMLElement, message: string) {
    const existingTimeout = noticeTimeouts.get(element);
    if (existingTimeout) clearTimeout(existingTimeout);
    
    setTextContent(element, message);
    element.classList.add('visible');
    
    const newTimeout = window.setTimeout(() => {
        element.classList.remove('visible');
        noticeTimeouts.delete(element);
    }, 2500);
    
    noticeTimeouts.set(element, newTimeout);
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

function _createManageHabitListItem(habitData: { habit: Habit; status: 'active' | 'ended' | 'graduated'; name: string; }): HTMLLIElement {
    const { habit, status, name } = habitData;
    const streak = calculateHabitStreak(habit.id, getTodayUTCIso());
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
        // PROTECTION: type="button" prevents form submission if this is used inside a form context
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
    const habitsForModal = state.habits.map(habit => {
        const { name } = getHabitDisplayInfo(habit);
        return {
            habit,
            status: getHabitStatusForSorting(habit),
            name: name
        };
    });

    const statusOrder = { 'active': 0, 'ended': 1, 'graduated': 2 };

    habitsForModal.sort((a, b) => {
        const statusDifference = statusOrder[a.status] - statusOrder[b.status];
        if (statusDifference !== 0) {
            return statusDifference;
        }
        return a.name.localeCompare(b.name);
    });

    const fragment = document.createDocumentFragment();
    habitsForModal.forEach(habitData => {
        fragment.appendChild(_createManageHabitListItem(habitData as { habit: Habit; status: 'active' | 'ended' | 'graduated'; name: string; }));
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
    // PERFORMANCE [2025-01-16]: Uso de cache para Intl.DateTimeFormat.
    const formattedDate = getDateTimeFormat(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(dateObj);
    const timeName = getTimeOfDayName(time);

    setTextContent(ui.notesModalTitle, name);
    setTextContent(ui.notesModalSubtitle, `${formattedDate} - ${timeName}`);
    
    const dayData = state.dailyData[date]?.[habitId]?.instances[time];
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
        const nonHabitIconKeys = new Set(['morning', 'afternoon', 'evening', 'deletePermanentAction', 'editAction', 'graduateAction', 'endAction', 'swipeDelete', 'swipeNote', 'swipeNoteHasNote', 'colorPicker', 'edit']);
        
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

export function openEditModal(habitOrTemplate: Habit | HabitTemplate | null) {
    const isNew = !habitOrTemplate || !('id' in habitOrTemplate);
    const form = ui.editHabitForm;
    const noticeEl = form.querySelector<HTMLElement>('.duplicate-habit-notice')!;
    noticeEl.classList.remove('visible');
    form.reset();
    
    const formData = _createHabitTemplateForForm(habitOrTemplate as Habit | PredefinedHabit | null, state.selectedDate);
    const nameInput = form.elements.namedItem('habit-name') as HTMLInputElement;
    nameInput.placeholder = t('modalEditFormNameLabel');

    if (isNew) {
        setTextContent(ui.editHabitModalTitle, t('modalEditNewTitle'));
        nameInput.value = (habitOrTemplate && 'nameKey' in habitOrTemplate) ? t(habitOrTemplate.nameKey) : '';
    } else {
        const habit = habitOrTemplate as Habit;
        const { name } = getHabitDisplayInfo(habit, state.selectedDate);
        setTextContent(ui.editHabitModalTitle, name);
        nameInput.value = name;
    }

    state.editingHabit = {
        isNew: isNew,
        habitId: isNew ? undefined : (habitOrTemplate as Habit).id,
        originalData: isNew ? undefined : { ...(habitOrTemplate as Habit) },
        formData: formData
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
    openModal(ui.editHabitModal, form.elements.namedItem('habit-name') as HTMLElement);
}