/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído (Revisão Final).
// O que foi feito: A análise do módulo de renderização foi finalizada. As otimizações anteriores incluíram a implementação de uma estratégia de reconciliação de DOM para as listas de hábitos e calendário, e a refatoração DRY de lógicas duplicadas. Nesta etapa final, a experiência do usuário foi aprimorada no modal "Explorar Hábitos": os hábitos predefinidos que já estão ativos na lista do usuário agora são visualmente desabilitados, prevenindo a criação de duplicatas e fornecendo feedback visual imediato.
// O que falta: Nenhuma análise futura é necessária. O arquivo é considerado finalizado.
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
} from './state';
// FIX: `getActiveHabitsForDate` was missing from the import list.
import { getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate, escapeHTML, pushToOneSignal, addDays, getActiveHabitsForDate, getContrastColor } from './utils';
import { ui } from './ui';
import { t, getLocaleDayName, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { STOIC_QUOTES } from './quotes';
import { icons, getTimeOfDayIcon } from './icons';
import { renderChart } from './chart';

// MANUTENIBILIDADE [2024-11-07]: Utiliza um WeakMap para associar timeouts a elementos de aviso,
// evitando a poluição de objetos do DOM com propriedades personalizadas.
const noticeTimeouts = new WeakMap<HTMLElement, number>();
const focusTrapListeners = new Map<HTMLElement, (e: KeyboardEvent) => void>();
const previouslyFocusedElements = new WeakMap<HTMLElement, HTMLElement>();


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
 * OTIMIZAÇÃO DE PERFORMANCE [2024-10-09]: Nova função auxiliar para atualizar um elemento de dia do calendário existente.
 * Esta função aplica cirurgicamente as mudanças (classes, estilos, atributos ARIA) a um elemento
 * do DOM existente, evitando a destruição e recriação desnecessárias, o que é fundamental para
 * a nova estratégia de renderização otimizada em `renderCalendar`.
 */
function updateCalendarDayElement(dayItem: HTMLElement, date: Date) {
    const todayISO = getTodayUTCIso();
    const isoDate = toUTCIsoDateString(date);

    // 1. Calcula os dados de exibição
    const { completedPercent, totalPercent, showPlus } = calculateDaySummary(isoDate);

    // 2. Atualiza classes e atributos
    dayItem.classList.toggle('selected', isoDate === state.selectedDate);
    dayItem.classList.toggle('today', isoDate === todayISO);
    dayItem.setAttribute('aria-pressed', String(isoDate === state.selectedDate));

    // 3. Atualiza o anel de progresso
    const dayProgressRing = dayItem.querySelector<HTMLElement>('.day-progress-ring');
    if (dayProgressRing) {
        dayProgressRing.style.setProperty('--completed-percent', `${completedPercent}%`);
        dayProgressRing.style.setProperty('--total-percent', `${totalPercent}%`);
    }

    // 4. Atualiza o indicador 'plus'
    const dayNumber = dayItem.querySelector<HTMLElement>('.day-number');
    if (dayNumber) {
        dayNumber.classList.toggle('has-plus', showPlus);
    }
}


function createCalendarDayElement(date: Date): HTMLElement {
    const todayISO = getTodayUTCIso();
    const isoDate = toUTCIsoDateString(date);
    
    // OTIMIZAÇÃO DE PERFORMANCE [2024-09-30]: Usa o helper centralizado para obter todos os dados de exibição
    // do dia (progresso do anel e indicador 'plus') em uma única operação, evitando loops redundantes.
    const { completedPercent, totalPercent, showPlus } = calculateDaySummary(isoDate);

    const dayItem = document.createElement('div');
    dayItem.className = `day-item ${isoDate === state.selectedDate ? 'selected' : ''} ${isoDate === todayISO ? 'today' : ''}`;
    dayItem.dataset.date = isoDate;
    dayItem.setAttribute('role', 'button');
    dayItem.setAttribute('aria-pressed', String(isoDate === state.selectedDate));

    const dayName = document.createElement('span');
    dayName.className = 'day-name';
    dayName.textContent = getLocaleDayName(date);

    const dayProgressRing = document.createElement('div');
    dayProgressRing.className = 'day-progress-ring';
    dayProgressRing.style.setProperty('--completed-percent', `${completedPercent}%`);
    dayProgressRing.style.setProperty('--total-percent', `${totalPercent}%`);

    const dayNumber = document.createElement('span');
    dayNumber.className = `day-number ${showPlus ? 'has-plus' : ''}`;
    dayNumber.textContent = String(date.getUTCDate());

    dayProgressRing.appendChild(dayNumber);
    dayItem.appendChild(dayName);
    dayItem.appendChild(dayProgressRing);

    return dayItem;
}

/**
 * OTIMIZAÇÃO DE PERFORMANCE [2024-10-09]: A função `renderCalendar` foi refatorada para usar uma estratégia
 * de atualização de DOM no local. Em vez de limpar e recriar toda a faixa de dias (`innerHTML = ''`),
 * ela agora itera sobre os elementos de dia existentes e os atualiza com os dados mais recentes.
 * Isso torna as interações, como a seleção de um dia, muito mais rápidas e fluidas.
 */
export function renderCalendar() {
    const dayElements = Array.from(ui.calendarStrip.querySelectorAll<HTMLElement>('.day-item'));
    
    // Se a faixa do calendário estiver vazia, renderiza pela primeira vez.
    if (dayElements.length === 0) {
        const fragment = document.createDocumentFragment();
        state.calendarDates.forEach(date => {
            fragment.appendChild(createCalendarDayElement(date));
        });
        ui.calendarStrip.appendChild(fragment);
        return;
    }
    
    // Se os elementos já existirem, apenas os atualiza.
    dayElements.forEach((dayEl, index) => {
        const date = state.calendarDates[index];
        if (date) { // Verificação de segurança
            updateCalendarDayElement(dayEl, date);
        }
    });
}

// REATORAÇÃO DE MANUTENIBILIDADE [2024-11-06]: Introduzida a função auxiliar _renderReelRotary para unificar a lógica de renderização duplicada entre renderLanguageFilter e renderFrequencyFilter, seguindo o princípio DRY.
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
    const effectiveIndex = Math.max(0, currentIndex); // Garante que o índice não seja -1
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

/**
 * MELHORIA DE ACESSIBILIDADE E FUNCIONALIDADE: Renderiza a visualização do calendário mensal completo.
 * A função foi aprimorada para incluir atributos ARIA para acessibilidade (role, aria-pressed, aria-label)
 * e gerenciamento de foco (tabindex="0" no dia selecionado), permitindo a navegação por teclado.
 */
export function renderFullCalendar() {
    const { year, month } = state.fullCalendar;
    const todayISO = getTodayUTCIso();

    const monthDate = new Date(Date.UTC(year, month, 1));
    ui.fullCalendarMonthYear.textContent = monthDate.toLocaleDateString(state.activeLanguageCode, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });

    const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const startDayOfWeek = firstDayOfMonth.getUTCDay(); // 0 = Domingo, 1 = Segunda...

    const daysInPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const grid = ui.fullCalendarGrid;
    grid.innerHTML = '';
    
    if (ui.fullCalendarWeekdays.childElementCount === 0) {
        const weekdaysFragment = document.createDocumentFragment();
        for (let i = 0; i < 7; i++) {
            const day = new Date(Date.UTC(2024, 0, 7 + i)); // Usa uma semana conhecida para obter os nomes
            const weekdayEl = document.createElement('div');
            weekdayEl.textContent = getLocaleDayName(day).substring(0, 1);
            weekdaysFragment.appendChild(weekdayEl);
        }
        ui.fullCalendarWeekdays.appendChild(weekdaysFragment);
    }
    
    const fragment = document.createDocumentFragment();
    let totalGridCells = 0;

    // Dias do mês anterior
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

    // Dias do mês atual
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
        dayEl.setAttribute('aria-label', currentDate.toLocaleDateString(state.activeLanguageCode, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC'
        }));
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
    
    // Dias do próximo mês
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
    goalEl.innerHTML = '';

    if (status === 'completed') {
        if (habit.goal.type === 'pages' || habit.goal.type === 'minutes') {
            const smartGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
            const completedGoal = dayDataForInstance?.goalOverride ?? smartGoal;
            goalEl.innerHTML = `
                <div class="goal-value-wrapper">
                    <div class="progress" style="color: var(--accent-blue);">${formatGoalForDisplay(completedGoal)}</div>
                    <div class="unit">${getUnitString(habit, completedGoal)}</div>
                </div>`;
        } else {
            goalEl.innerHTML = `<div class="progress" style="color: var(--accent-blue);">✓</div><div class="unit">${getUnitString(habit, 1)}</div>`;
        }
    } else if (status === 'snoozed') {
        const progressDiv = document.createElement('div');
        progressDiv.className = 'progress';
        progressDiv.innerHTML = `<svg class="snoozed-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>`;

        const unitDiv = document.createElement('div');
        unitDiv.className = 'unit snoozed-text';
        unitDiv.textContent = t('habitSnoozed');

        goalEl.append(progressDiv, unitDiv);
    } else { 
        if (habit.goal.type === 'pages' || habit.goal.type === 'minutes') {
            const smartGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
            const currentGoal = dayDataForInstance?.goalOverride ?? smartGoal;
            goalEl.innerHTML = `
                <div class="habit-goal-controls">
                    <button class="goal-control-btn" data-habit-id="${habit.id}" data-time="${time}" data-action="decrement" aria-label="${t('habitGoalDecrement_ariaLabel')}">-</button>
                    <div class="goal-value-wrapper">
                        <div class="progress">${formatGoalForDisplay(currentGoal)}</div>
                        <div class="unit">${getUnitString(habit, currentGoal)}</div>
                    </div>
                    <button class="goal-control-btn" data-habit-id="${habit.id}" data-time="${time}" data-action="increment" aria-label="${t('habitGoalIncrement_ariaLabel')}">+</button>
                </div>`;
        }
    }
}

/**
 * REATORAÇÃO DE DRY: Gerencia a renderização da mensagem de consolidação de um hábito.
 * Cria, atualiza ou remove a mensagem com base na sequência atual do hábito.
 * @param detailsEl O elemento DOM que contém os detalhes do hábito.
 * @param streak O número de dias de sequência do hábito.
 */
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
        msgEl.textContent = messageText;
    } else if (msgEl) {
        msgEl.remove();
    }
}


/**
 * OTIMIZAÇÃO DE PERFORMANCE [2024-10-08]: Nova função auxiliar para atualizar um cartão de hábito existente no DOM.
 * Esta função aplica cirurgicamente as mudanças (classes, texto, ícones) a um elemento existente,
 * evitando a necessidade de destruir e recriar o cartão, o que é fundamental para a nova estratégia
 * de reconciliação de DOM em `renderHabits`.
 */
function updateHabitCardElement(card: HTMLElement, habit: Habit, time: TimeOfDay): void {
    const dailyInfo = getHabitDailyInfoForDate(state.selectedDate);
    const habitInstanceData = dailyInfo[habit.id]?.instances?.[time];
    const status = habitInstanceData?.status ?? 'pending';
    const hasNote = habitInstanceData?.note && habitInstanceData.note.length > 0;
    const streak = calculateHabitStreak(habit.id, getTodayUTCIso());

    // 1. Atualiza as classes do cartão
    card.className = `habit-card ${status}`; // Reseta as classes com base no status
    if (streak >= STREAK_CONSOLIDATED) card.classList.add('consolidated');
    else if (streak >= STREAK_SEMI_CONSOLIDATED) card.classList.add('semi-consolidated');
    
    // 2. Atualiza as informações de exibição (nome, subtítulo)
    const { name, subtitle } = getHabitDisplayInfo(habit, state.selectedDate);
    card.querySelector<HTMLElement>('.habit-details .name')!.textContent = name;
    card.querySelector<HTMLElement>('.habit-details .subtitle')!.textContent = subtitle;

    // 3. Atualiza a mensagem de consolidação
    const detailsEl = card.querySelector<HTMLElement>('.habit-details');
    if(detailsEl) {
        _updateConsolidationMessage(detailsEl, streak);
    }
    
    // 4. Atualiza o ícone de nota
    const noteBtn = card.querySelector<HTMLElement>('.swipe-note-btn');
    if (noteBtn) {
        noteBtn.innerHTML = hasNote ? icons.swipeNoteHasNote : icons.swipeNote;
        noteBtn.setAttribute('aria-label', t(hasNote ? 'habitNoteEdit_ariaLabel' : 'habitNoteAdd_ariaLabel'));
    }

    // 5. Atualiza o conteúdo da meta
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
    // CORREÇÃO DE UX [2024-10-07]: O status de consolidação agora é calculado com base na sequência ATÉ HOJE,
    // não na data selecionada. Isso garante que a conquista seja exibida de forma persistente,
    // reforçando o sentimento de realização do usuário, independentemente da data que ele está visualizando.
    const streak = calculateHabitStreak(habit.id, getTodayUTCIso());
    
    const card = document.createElement('div');
    card.className = `habit-card ${status}`;
    card.dataset.habitId = habit.id;
    card.dataset.time = time;

    if (streak >= STREAK_CONSOLIDATED) card.classList.add('consolidated');
    else if (streak >= STREAK_SEMI_CONSOLIDATED) card.classList.add('semi-consolidated');

    // CORREÇÃO DE DADOS HISTÓRICOS [2024-09-20]: Passa a data selecionada para garantir que
    // o nome e o subtítulo corretos sejam exibidos para o dia visualizado.
    const { name, subtitle } = getHabitDisplayInfo(habit, state.selectedDate);

    // REATORAÇÃO DE ARQUITETURA [2024-09-22]: Os ícones de ação agora são injetados diretamente
    // do módulo 'icons.ts', em vez de serem aplicados via CSS mask-image.
    // Isso centraliza todos os ícones da aplicação em um único local, melhorando a manutenibilidade.
    const actionsLeft = document.createElement('div');
    actionsLeft.className = 'habit-actions-left';
    actionsLeft.innerHTML = `<button class="swipe-delete-btn" aria-label="${t('habitEnd_ariaLabel')}">${icons.swipeDelete}</button>`;

    const actionsRight = document.createElement('div');
    actionsRight.className = 'habit-actions-right';
    actionsRight.innerHTML = `<button class="swipe-note-btn" aria-label="${t(hasNote ? 'habitNoteEdit_ariaLabel' : 'habitNoteAdd_ariaLabel')}">${hasNote ? icons.swipeNoteHasNote : icons.swipeNote}</button>`;
    
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
    
    // REATORAÇÃO DE DRY: Chama o helper centralizado para lidar com a mensagem de consolidação.
    _updateConsolidationMessage(details, streak);

    const goal = document.createElement('div');
    goal.className = 'habit-goal';
    goal.className = 'habit-goal';
    updateGoalContentElement(goal, status, habit, time, habitInstanceData);

    contentWrapper.append(timeOfDayIcon, icon, details, goal);
    card.append(actionsLeft, actionsRight, contentWrapper);
    
    return card;
}

/**
 * Manages the creation, update, and removal of the placeholder element for an empty habit group.
 * @param groupEl The habit group DOM element.
 * @param time The time of day for this group.
 * @param hasHabits Whether the group currently contains habits.
 * @param isSmartPlaceholder Whether this placeholder should show icons for all empty slots.
 * @param emptyTimes A list of all time slots that are currently empty.
 */
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

/**
 * OTIMIZAÇÃO DE PERFORMANCE E CORREÇÃO DE ORDEM [2024-12-26]: 
 * A função `renderHabits` foi refatorada. A versão anterior usava reconciliação "in-place" que
 * falhava em atualizar a *ordem visual* dos cartões se eles fossem reordenados no estado.
 * Esta nova versão garante que a ordem DOM sempre corresponda à ordem do array `desiredHabits`,
 * movendo os elementos existentes para a posição correta através de `appendChild` (que move nós
 * existentes), garantindo a persistência correta de operações Drag & Drop.
 */
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
        
        // Itera sobre os hábitos desejados na ordem CORRETA do estado
        desiredHabits.forEach(habit => {
            const key = `${habit.id}|${time}`;
            let card = existingCardsMap.get(key);
            
            if (card) {
                // Hábito já existe, atualize-o
                updateHabitCardElement(card, habit, time);
                existingCardsMap.delete(key); // Marca como processado
            } else {
                // Hábito é novo, crie-o
                card = createHabitCardElement(habit, time);
            }
            
            // CRÍTICO: `appendChild` move o elemento se ele já estiver no DOM.
            // Ao chamar isso sequencialmente na ordem de `desiredHabits`, garantimos
            // que a ordem visual do DOM corresponda exatamente à ordem do array.
            if (card) {
                groupEl.appendChild(card);
            }
        });

        // Remove cartões que não estão mais no estado atual
        existingCardsMap.forEach(cardToRemove => cardToRemove.remove());
        
        const hasHabits = groupHasHabits[time];
        const isSmartPlaceholder = time === smartPlaceholderTargetTime;
        
        // Atualiza as classes do wrapper
        wrapperEl.classList.toggle('has-habits', hasHabits);
        wrapperEl.classList.toggle('is-collapsible', !hasHabits && !isSmartPlaceholder);

        updatePlaceholderForGroup(groupEl, time, hasHabits, isSmartPlaceholder, emptyTimes);
    });
}


export function renderExploreHabits() {
    // OTIMIZAÇÃO DE UX: Cria um conjunto de chaves de nome de hábitos predefinidos que já estão ativos
    // para desabilitá-los visualmente no modal, prevenindo duplicatas.
    const activePredefinedHabitKeys = new Set<string>();
    state.habits.forEach(habit => {
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        const isActive = !habit.graduatedOn && !lastSchedule.endDate;

        if (isActive) {
            habit.scheduleHistory.forEach(schedule => {
                if (schedule.nameKey) {
                    activePredefinedHabitKeys.add(schedule.nameKey);
                }
            });
        }
    });

    // OTIMIZAÇÃO DE PERFORMANCE [2024-12-26]: Uso de DocumentFragment e createElement
    // substitui a manipulação de strings innerHTML, melhorando a performance e segurança.
    const fragment = document.createDocumentFragment();

    PREDEFINED_HABITS.forEach((habit, index) => {
        const name = t(habit.nameKey);
        const subtitle = t(habit.subtitleKey);
        const isDisabled = activePredefinedHabitKeys.has(habit.nameKey);

        const itemEl = document.createElement('div');
        itemEl.className = `explore-habit-item ${isDisabled ? 'disabled' : ''}`;
        itemEl.dataset.index = String(index);
        itemEl.setAttribute('role', 'button');
        itemEl.setAttribute('tabindex', isDisabled ? '-1' : '0');

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
    // REFACTOR [2024-08-03]: A lógica do estado desabilitado do botão de IA foi centralizada aqui.
    // Agora, ele considera tanto o estado de 'loading' QUANTO o status 'offline' da rede,
    // tornando esta função a única fonte da verdade e eliminando lógica duplicada em 'listeners.ts'.
    const isLoading = state.aiState === 'loading';
    const isOffline = !navigator.onLine;
    const hasCelebrations = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0;
    const hasUnseenResult = (state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult;

    ui.aiEvalBtn.classList.toggle('loading', isLoading);
    ui.aiEvalBtn.disabled = isLoading || isOffline;
    // CORREÇÃO DE BUG [2024-12-09]: Corrigido erro de digitação (`ui.aiEval-btn` para `ui.aiEvalBtn`). A propriedade incorreta causava um erro em tempo de execução que impedia a atualização do estado de notificação do botão da IA.
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
    
    ui.stoicQuoteDisplay.classList.remove('visible');
    
    setTimeout(() => {
        ui.stoicQuoteDisplay.textContent = `"${quoteText}" — ${t('marcusAurelius')}`;
        ui.stoicQuoteDisplay.classList.add('visible');
    }, 100);
}

// REATORAÇÃO [2024-11-19]: A função foi refatorada para preencher os elementos de título de desktop e mobile separadamente. A lógica de detecção de `window.innerWidth` foi removida, delegando a responsabilidade de exibição para o CSS.
// REATORAÇÃO DE CLAREZA [2024-11-23]: A lógica if/else para datas especiais (Hoje, Ontem, Amanhã) foi substituída por um mapeamento de objetos. Isso reduz a repetição de código e torna a intenção mais clara, melhorando a manutenibilidade.
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

        // Formato para Mobile (DD/MM)
        const day = String(date.getUTCDate()).padStart(2, '0');
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        mobileTitle = `${day}/${month}`;
        
        // Formato para Desktop (Mês por extenso, dia)
        const formatOptions: Intl.DateTimeFormatOptions = {
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC'
        };
        desktopTitle = date.toLocaleDateString(state.activeLanguageCode, formatOptions);
    }
    ui.headerTitleDesktop.textContent = desktopTitle;
    ui.headerTitleMobile.textContent = mobileTitle;
}


export function updateNotificationUI() {
    // Esta função pode ser chamada antes da inicialização do OneSignal.
    // Esperamos que o objeto OneSignal esteja disponível.
    pushToOneSignal((OneSignal: any) => {
        const permission = OneSignal.Notifications.permission;
        const isPushEnabled = OneSignal.User.PushSubscription.optedIn;

        if (permission === "denied") {
            ui.notificationToggle.checked = false;
            ui.notificationToggle.disabled = true;
            ui.notificationToggleLabel.style.cursor = 'not-allowed';
            ui.notificationStatusDesc.textContent = t('notificationStatusDisabled');
        } else {
            ui.notificationToggle.disabled = false;
            ui.notificationToggleLabel.style.cursor = 'pointer';

            // O interruptor deve refletir se o usuário está inscrito atualmente
            ui.notificationToggle.checked = isPushEnabled;

            if (isPushEnabled) {
                ui.notificationStatusDesc.textContent = t('notificationStatusEnabled');
            } else {
                // Abrange tanto a permissão 'default' quanto a 'granted' mas não optou por participar.
                ui.notificationStatusDesc.textContent = t('modalManageNotificationsStaticDesc');
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
    // FIX: updateHeaderTitle() was missing from here in some versions, adding it back ensures consistency.
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
    
    // BUGFIX DE FOCO [2024-11-05]: Reverte para um setTimeout. Após várias tentativas, a falha do foco
    // imediato e do `transitionend` em acionar o teclado móvel indica uma condição de corrida de renderização
    // do navegador. Um pequeno atraso (menor que a animação) dá ao navegador tempo suficiente para processar
    // a mudança de visibilidade do modal, tornando o elemento focável ANTES da chamada de foco, o que
    // resolve o problema de forma mais confiável em todos os dispositivos.
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

// REFACTOR [2024-08-18]: Modifica `initializeModalClosing` para aceitar um callback `onClose` opcional.
// Isso centraliza a lógica de fechamento de modais (cliques no overlay e no botão) e a torna mais extensível,
// permitindo que modais como o de IA se conectem ao evento de fechamento sem duplicar a lógica de listeners.
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
    
    element.textContent = message;
    element.classList.add('visible');
    
    const newTimeout = window.setTimeout(() => {
        element.classList.remove('visible');
        noticeTimeouts.delete(element);
    }, 2500);
    
    noticeTimeouts.set(element, newTimeout);
}

/**
 * Determina o status de um hábito para fins de ordenação na UI.
 * @param habit O hábito a ser avaliado.
 * @returns 'active', 'ended', ou 'graduated'.
 */
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

/**
 * REATORAÇÃO DE SEGURANÇA E MANUTENIBILIDADE [2024-11-07]: A função foi reescrita para usar `document.createElement`
 * e `textContent` em vez de construir strings HTML com `innerHTML`. Isso elimina qualquer risco potencial de
 * injeção de script (XSS), mesmo que os dados de entrada sejam confiáveis, e torna a estrutura da função
 * mais clara, robusta e fácil de depurar.
 */
function _createManageHabitListItem(habitData: { habit: Habit; status: 'active' | 'ended' | 'graduated'; name: string; }): HTMLLIElement {
    const { habit, status, name } = habitData;
    const streak = calculateHabitStreak(habit.id, getTodayUTCIso());
    const isConsolidated = streak >= STREAK_CONSOLIDATED;

    const li = document.createElement('li');
    li.className = `habit-list-item ${status}`;
    li.dataset.habitId = habit.id;

    const mainSpan = document.createElement('span');
    
    const iconSpan = document.createElement('span');
    iconSpan.innerHTML = habit.icon; // Ícones são SVGs seguros e confiáveis de `icons.ts`
    // CORREÇÃO VISUAL [2024-12-08]: Define a cor do ícone com base na cor do hábito.
    // Isso corrige um bug onde os ícones na lista de gerenciamento apareciam em escala de cinza
    // em vez de suas cores designadas, alinhando-os com a aparência dos cartões de hábito.
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
    // Otimização: calcula status e nome de cada hábito uma única vez.
    const habitsForModal = state.habits.map(habit => {
        const { name } = getHabitDisplayInfo(habit);
        return {
            habit,
            status: getHabitStatusForSorting(habit),
            name: name
        };
    });

    const statusOrder = { 'active': 0, 'ended': 1, 'graduated': 2 };

    // Ordena o array com base no status pré-calculado e, em seguida no nome.
    habitsForModal.sort((a, b) => {
        const statusDifference = statusOrder[a.status] - statusOrder[b.status];
        if (statusDifference !== 0) {
            return statusDifference;
        }
        return a.name.localeCompare(b.name);
    });

    // REATORAÇÃO [2024-09-11]: Utiliza DocumentFragment e uma função helper para a criação de elementos
    // em vez de manipulação de strings com innerHTML. Isso melhora a performance e a manutenibilidade.
    const fragment = document.createDocumentFragment();
    habitsForModal.forEach(habitData => {
        fragment.appendChild(_createManageHabitListItem(habitData as { habit: Habit; status: 'active' | 'ended' | 'graduated'; name: string; }));
    });

    ui.habitList.innerHTML = '';
    ui.habitList.appendChild(fragment);
}


// FIX: Add missing modal-related functions
export function showUndoToast() {
    if (state.undoTimeout) clearTimeout(state.undoTimeout);
    ui.undoToast.classList.add('visible');
    state.undoTimeout = window.setTimeout(() => {
        ui.undoToast.classList.remove('visible');
        state.lastEnded = null; // Clear the undo state after timeout
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
        // UX-FIX [2024-10-27]: Adiciona a opção de estilo para o botão de confirmação.
        // Permite que ações destrutivas usem um botão vermelho ('danger') para alertar o usuário.
        confirmButtonStyle?: 'primary' | 'danger';
    }
) {
    ui.confirmModalText.innerHTML = text;
    state.confirmAction = onConfirm;
    state.confirmEditAction = options?.onEdit || null;

    ui.confirmModal.querySelector('h2')!.textContent = options?.title || t('modalConfirmTitle');
    const confirmBtn = ui.confirmModalConfirmBtn;
    confirmBtn.textContent = options?.confirmText || t('confirmButton');
    
    // UX-FIX [2024-10-27]: Aplica a classe de estilo correta ao botão de confirmação.
    confirmBtn.classList.remove('btn--primary', 'btn--danger');
    confirmBtn.classList.add(options?.confirmButtonStyle === 'danger' ? 'btn--danger' : 'btn--primary');
    
    const cancelBtn = ui.confirmModal.querySelector<HTMLElement>('.modal-close-btn');
    if (cancelBtn) {
        cancelBtn.textContent = options?.cancelText || t('cancelButton');
    }
    
    if (options?.editText && options?.onEdit) {
        ui.confirmModalEditBtn.style.display = 'inline-block';
        ui.confirmModalEditBtn.textContent = options.editText;
    } else {
        ui.confirmModalEditBtn.style.display = 'none';
    }

    openModal(ui.confirmModal);
}

export function openNotesModal(habitId: string, date: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    state.editingNoteFor = { habitId, date, time };
    
    // CORREÇÃO DE DADOS HISTÓRICOS [2024-09-20]: Passa a data selecionada para obter o nome correto.
    const { name } = getHabitDisplayInfo(habit, date);
    const dateObj = parseUTCIsoDate(date);
    const formattedDate = dateObj.toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const timeName = getTimeOfDayName(time);

    ui.notesModalTitle.textContent = name;
    ui.notesModalSubtitle.textContent = `${formattedDate} - ${timeName}`;
    
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
                    <button class="icon-picker-item" data-icon-svg="${escapeHTML(iconSVG)}">
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
        <button class="color-swatch ${currentColor === color ? 'selected' : ''}" style="background-color: ${color}" data-color="${color}" aria-label="${color}"></button>
    `).join('');
}

/**
 * REATORAÇÃO [2024-09-13]: A lógica para criar o estado do formulário de hábito foi extraída
 * para a função auxiliar _createHabitTemplateForForm. Isso remove a duplicação de código em
 * openEditModal e centraliza a criação do objeto formData a partir de um hábito existente,
 * um modelo predefinido ou um novo hábito personalizado.
 */
function _createHabitTemplateForForm(habitOrTemplate: Habit | PredefinedHabit | null, selectedDate: string): HabitTemplate {
    // Caso 1: Criando um novo hábito personalizado do zero.
    if (!habitOrTemplate) {
        const commonData = {
            icon: icons.custom,
            color: '#000000',
            times: ['Morning'] as TimeOfDay[],
            goal: { type: 'check', unitKey: 'unitCheck' } as Habit['goal'],
            // UX IMPROVEMENT: Default to a non-daily frequency to show advanced options initially.
            frequency: { type: 'interval', unit: 'days', amount: 2 } as Frequency,
        };
        return {
            ...commonData,
            name: '',
            subtitleKey: 'customHabitSubtitle',
        };
    }

    // Caso 2: Criando a partir de um modelo predefinido.
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

    // Caso 3: Editando um hábito existente.
    const habit = habitOrTemplate as Habit;
    const schedule = getScheduleForDate(habit, selectedDate) || habit.scheduleHistory[habit.scheduleHistory.length - 1];
    // CORREÇÃO DE DADOS HISTÓRICOS [2024-09-20]: Passa a data para obter o nome historicamente correto.
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
    nameInput.placeholder = t('modalEditFormNameLabel'); // Use a chave da etiqueta como placeholder

    if (isNew) {
        ui.editHabitModalTitle.textContent = t('modalEditNewTitle');
        nameInput.value = (habitOrTemplate && 'nameKey' in habitOrTemplate) ? t(habitOrTemplate.nameKey) : '';
    } else {
        const habit = habitOrTemplate as Habit;
        // CORREÇÃO DE DADOS HISTÓRICOS [2024-09-20]: Passa a data para obter o nome correto.
        const { name } = getHabitDisplayInfo(habit, state.selectedDate);
        ui.editHabitModalTitle.textContent = name;
        nameInput.value = name;
    }

    state.editingHabit = {
        isNew: isNew,
        habitId: isNew ? undefined : (habitOrTemplate as Habit).id,
        originalData: isNew ? undefined : { ...(habitOrTemplate as Habit) },
        formData: formData
    };

    // Atualiza a nova UI de identidade do hábito
    ui.editHabitModal.querySelector<HTMLElement>('.edit-icon-overlay')!.innerHTML = icons.edit;
    const iconColor = getContrastColor(formData.color);
    ui.habitIconPickerBtn.innerHTML = formData.icon;
    ui.habitIconPickerBtn.style.backgroundColor = formData.color;
    ui.habitIconPickerBtn.style.color = iconColor;
    
    // Renderiza o novo controle segmentado para horários
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