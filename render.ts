import {
    state,
    Habit,
    HabitStatus,
    HabitDayData,
    getHabitDailyInfoForDate,
    getSmartGoalForHabit,
    shouldShowPlusIndicator,
    calculateHabitStreak,
    getTodayUTCIso,
    FILTERS,
    LANGUAGES,
    FREQUENCIES,
    TIMES_OF_DAY,
    PREDEFINED_HABITS,
    STREAK_CONSOLIDATED,
    STREAK_SEMI_CONSOLIDATED,
    addDays,
    shouldHabitAppearOnDate,
    Frequency,
    PredefinedHabit,
    TimeOfDay,
    toUTCIsoDateString,
    parseUTCIsoDate,
    getTodayUTC,
} from './state';
import { ui } from './ui';
import { t, getLocaleDayName, getHabitDisplayInfo } from './i18n';

function updateReelRotaryARIA(viewportEl: HTMLElement, currentIndex: number, options: readonly string[] | string[], labelKey: string) {
    if (!viewportEl) return;
    viewportEl.setAttribute('role', 'slider');
    viewportEl.setAttribute('aria-label', t(labelKey));
    viewportEl.setAttribute('aria-valuemin', '1');
    viewportEl.setAttribute('aria-valuemax', String(options.length));
    viewportEl.setAttribute('aria-valuenow', String(currentIndex + 1));
    viewportEl.setAttribute('aria-valuetext', options[currentIndex]);
    viewportEl.setAttribute('tabindex', '0'); // Torna o elemento focável
}

export function initFilters() {
    const filterNames = [t('filterAllDay'), t('filterMorning'), t('filterAfternoon'), t('filterEvening')];
    ui.timeFilterReel.innerHTML = filterNames.map(text => `<span class="reel-option">${text}</span>`).join('');
    updateReelRotaryARIA(ui.timeFilterViewport, FILTERS.indexOf(state.activeFilter), filterNames, 'timeFilter_ariaLabel');
}

export function initLanguageFilter() {
    const langNames = LANGUAGES.map(lang => t(lang.nameKey));
    ui.languageReel.innerHTML = langNames.map(name => `<span class="reel-option">${name}</span>`).join('');
    const currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
    updateReelRotaryARIA(ui.languageViewport, currentIndex, langNames, 'language_ariaLabel');
}

export function initFrequencyFilter() {
    const freqLabels = FREQUENCIES.map(freq => t(freq.labelKey));
    ui.frequencyReel.innerHTML = freqLabels.map(label => `<span class="reel-option">${label}</span>`).join('');
    updateReelRotaryARIA(ui.frequencyViewport, 0, freqLabels, 'frequency_ariaLabel');
}

export function initHabitTimeFilter() {
    // This function is no longer needed as the rotary selector was replaced by checkboxes.
    // Kept to avoid breaking the import chain, but its content is removed.
}

export function updateCalendarSelection() {
    document.querySelectorAll('.day-item').forEach(el => el.classList.toggle('selected', el.getAttribute('data-date') === state.selectedDate));
}

function calculateDayProgress(isoDate: string): { completedPercent: number, totalPercent: number } {
    const dailyInfo = getHabitDailyInfoForDate(isoDate);
    const dateObj = parseUTCIsoDate(isoDate);
    const activeHabitsOnDate = state.habits.filter(h => shouldHabitAppearOnDate(h, dateObj));
    
    let totalInstances = 0;
    let completedInstances = 0;
    let snoozedInstances = 0;

    activeHabitsOnDate.forEach(habit => {
        const habitDailyInfo = dailyInfo[habit.id];
        const instances = habitDailyInfo?.instances || {};
        const scheduleForDay = habitDailyInfo?.dailySchedule || habit.times;
        
        scheduleForDay.forEach(time => {
            totalInstances++;
            const status = instances[time]?.status;
            if (status === 'completed') completedInstances++;
            if (status === 'snoozed') snoozedInstances++;
        });
    });

    if (totalInstances === 0) return { completedPercent: 0, totalPercent: 0 };
    
    const completedPercent = Math.round((completedInstances / totalInstances) * 100);
    const totalPercent = Math.round(((completedInstances + snoozedInstances) / totalInstances) * 100);

    return { completedPercent, totalPercent };
}


export function createCalendarDayElement(date: Date): HTMLElement {
    const todayISO = getTodayUTCIso();
    const isoDate = toUTCIsoDateString(date);
    const { completedPercent, totalPercent } = calculateDayProgress(isoDate);
    const showPlus = shouldShowPlusIndicator(isoDate);

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

export function renderCalendar() {
    ui.calendarStrip.innerHTML = ''; // Limpa os elementos existentes
    const fragment = document.createDocumentFragment();
    state.calendarDates.forEach(date => {
        fragment.appendChild(createCalendarDayElement(date));
    });
    ui.calendarStrip.appendChild(fragment);
}


export function renderFilters() {
    const currentIndex = FILTERS.indexOf(state.activeFilter);
    const firstOption = ui.timeFilterReel.querySelector('.reel-option') as HTMLElement | null;
    const itemWidth = firstOption?.offsetWidth || 52;
    const transformX = -currentIndex * itemWidth;
    ui.timeFilterReel.style.transform = `translateX(${transformX}px)`;
    const filterNames = [t('filterAllDay'), t('filterMorning'), t('filterAfternoon'), t('filterEvening')];
    updateReelRotaryARIA(ui.timeFilterViewport, currentIndex, filterNames, 'timeFilter_ariaLabel');
}

export function renderLanguageFilter() {
    const currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
    const langNames = LANGUAGES.map(lang => t(lang.nameKey));
    const firstOption = ui.languageReel.querySelector('.reel-option') as HTMLElement | null;
    const itemWidth = firstOption?.offsetWidth || 95;
    const transformX = -currentIndex * itemWidth;
    ui.languageReel.style.transform = `translateX(${transformX}px)`;
    updateReelRotaryARIA(ui.languageViewport, currentIndex, langNames, 'language_ariaLabel');
}

export function renderFrequencyFilter() {
    if (!state.editingHabit) return;
    const currentFrequency = state.editingHabit.habitData.frequency;
    const freqLabels = FREQUENCIES.map(f => t(f.labelKey));
    const currentIndex = FREQUENCIES.findIndex(f => 
        f.value.type === currentFrequency.type && f.value.interval === currentFrequency.interval
    );
    const firstOption = ui.frequencyReel.querySelector('.reel-option') as HTMLElement | null;
    const itemWidth = firstOption?.offsetWidth || 125;
    const transformX = -Math.max(0, currentIndex) * itemWidth;
    ui.frequencyReel.style.transform = `translateX(${transformX}px)`;
    updateReelRotaryARIA(ui.frequencyViewport, Math.max(0, currentIndex), freqLabels, 'frequency_ariaLabel');
}

export function renderHabitTimeFilter() {
    // This function is no longer needed as the rotary selector was replaced by checkboxes.
    // Kept to avoid breaking the import chain, but its content is removed.
}

const getUnitString = (habit: Habit, value: number | undefined) => {
    const unitKey = habit.goal.unitKey || 'unitCheck';
    return t(unitKey, { count: value });
};

export const formatGoalForDisplay = (goal: number): string => {
    if (goal < 5) return '< 5';
    if (goal > 95) return '> 95';
    return goal.toString();
};

function updateGoalContentElement(goalEl: HTMLElement, status: HabitStatus, habit: Habit, time: TimeOfDay, dayDataForInstance: HabitDayData | undefined) {
    goalEl.innerHTML = ''; // Limpa o conteúdo anterior

    switch (status) {
        case 'completed':
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
            break;

        case 'snoozed':
            goalEl.innerHTML = `
                <div class="progress">
                    <svg class="snoozed-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>
                </div>
                <div class="unit snoozed-text">${t('habitSnoozed')}</div>`;
            break;

        default: // 'pending'
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
            break;
    }
}

export function createHabitCardElement(habit: Habit, time: TimeOfDay): HTMLElement {
    const dailyInfo = getHabitDailyInfoForDate(state.selectedDate);
    const habitInstanceData = dailyInfo[habit.id]?.instances?.[time];
    const status = habitInstanceData?.status ?? 'pending';
    const hasNote = habitInstanceData?.note && habitInstanceData.note.length > 0;
    const streak = calculateHabitStreak(habit.id, state.selectedDate);
    
    const card = document.createElement('div');
    card.className = `habit-card ${status}`;
    card.dataset.habitId = habit.id;
    card.dataset.time = time;

    if (streak >= STREAK_CONSOLIDATED) card.classList.add('consolidated');
    else if (streak >= STREAK_SEMI_CONSOLIDATED) card.classList.add('semi-consolidated');

    const { name, subtitle } = getHabitDisplayInfo(habit);

    const actionsLeft = document.createElement('div');
    actionsLeft.className = 'habit-actions-left';
    actionsLeft.innerHTML = `<button class="swipe-delete-btn" aria-label="${t('habitEnd_ariaLabel')}"></button>`;

    const actionsRight = document.createElement('div');
    actionsRight.className = 'habit-actions-right';
    actionsRight.innerHTML = `<button class="swipe-note-btn ${hasNote ? 'has-note' : ''}" aria-label="${t(hasNote ? 'habitNoteEdit_ariaLabel' : 'habitNoteAdd_ariaLabel')}"></button>`;
    
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'habit-content-wrapper';
    contentWrapper.draggable = true;
    
    const icon = document.createElement('div');
    icon.className = 'habit-icon';
    icon.style.backgroundColor = `${habit.color}30`;
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
    
    if (streak >= STREAK_CONSOLIDATED) {
        const msg = document.createElement('div');
        msg.className = 'consolidation-message';
        msg.textContent = t('habitConsolidatedMessage');
        details.appendChild(msg);
    } else if (streak >= STREAK_SEMI_CONSOLIDATED) {
        const msg = document.createElement('div');
        msg.className = 'consolidation-message';
        msg.textContent = t('habitSemiConsolidatedMessage');
        details.appendChild(msg);
    }

    const goal = document.createElement('div');
    goal.className = 'habit-goal';
    updateGoalContentElement(goal, status, habit, time, habitInstanceData);

    contentWrapper.append(icon, details, goal);
    card.append(actionsLeft, actionsRight, contentWrapper);
    
    return card;
}

export function renderHabits() {
    const selectedDateObj = parseUTCIsoDate(state.selectedDate);
    const dailyInfoByHabit = getHabitDailyInfoForDate(state.selectedDate);

    const habitGroups: Record<TimeOfDay, DocumentFragment> = {
        'Manhã': document.createDocumentFragment(),
        'Tarde': document.createDocumentFragment(),
        'Noite': document.createDocumentFragment()
    };
    
    state.habits.forEach(habit => {
        if (shouldHabitAppearOnDate(habit, selectedDateObj)) {
            const habitDailyInfo = dailyInfoByHabit[habit.id];
            const scheduleForDay = habitDailyInfo?.dailySchedule || habit.times;
            
            scheduleForDay.forEach(time => {
                if (habitGroups[time]) {
                    habitGroups[time].appendChild(createHabitCardElement(habit, time));
                }
            });
        }
    });

    TIMES_OF_DAY.forEach(time => {
        const wrapperEl = ui.habitContainer.querySelector(`.habit-group-wrapper[data-time-wrapper="${time}"]`);
        const groupEl = ui.habitContainer.querySelector<HTMLElement>(`.habit-group[data-time="${time}"]`);
        const titleEl = wrapperEl?.querySelector('h2');
        if (!wrapperEl || !groupEl || !titleEl) return;
        
        const timeToKeyMap: Record<TimeOfDay, string> = {
            'Manhã': 'filterMorning',
            'Tarde': 'filterAfternoon',
            'Noite': 'filterEvening'
        };
        titleEl.textContent = t(timeToKeyMap[time]);
        
        (wrapperEl as HTMLElement).hidden = !(state.activeFilter === 'Todos' || state.activeFilter === time);
        
        groupEl.innerHTML = '';
        groupEl.appendChild(habitGroups[time]);
        updateGroupPlaceholder(groupEl);
    });
}


export function renderExploreHabits() {
    ui.exploreHabitList.innerHTML = PREDEFINED_HABITS.map((habit, index) => {
        const name = t(habit.nameKey);
        const subtitle = t(habit.subtitleKey);
        return `
            <div class="explore-habit-item" data-index="${index}" role="button">
                <div class="explore-habit-icon" style="background-color: ${habit.color}30;">${habit.icon}</div>
                <div class="explore-habit-details">
                    <div class="name">${name}</div>
                    <div class="subtitle">${subtitle}</div>
                </div>
            </div>`;
    }).join('');
}

export function renderAINotificationState() {
    const hasNotifications = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0;
    ui.aiEvalBtn.classList.toggle('has-notification', hasNotifications);
}

export function renderApp() {
    renderCalendar();
    renderHabits();
    renderAINotificationState();
}

export function updateHabitCardDOM(habitId: string, time: TimeOfDay) {
    const card = ui.habitContainer.querySelector<HTMLElement>(`.habit-card[data-habit-id="${habitId}"][data-time="${time}"]`);
    if (!card) return;
    
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const dailyInfo = getHabitDailyInfoForDate(state.selectedDate);
    const habitInstanceData = dailyInfo[habit.id]?.instances?.[time];
    const status = habitInstanceData?.status ?? 'pending';
    const hasNote = !!(habitInstanceData?.note && habitInstanceData.note.length > 0);
    const streak = calculateHabitStreak(habit.id, state.selectedDate);
    const { name, subtitle } = getHabitDisplayInfo(habit);

    // Atualiza as classes
    card.className = `habit-card ${status}`;
    if (streak >= STREAK_CONSOLIDATED) card.classList.add('consolidated');
    else if (streak >= STREAK_SEMI_CONSOLIDATED) card.classList.add('semi-consolidated');
    card.dataset.time = time; // Ensure data-time is set

    // Atualiza o botão de nota
    const noteBtn = card.querySelector<HTMLElement>('.swipe-note-btn');
    if (noteBtn) {
        noteBtn.classList.toggle('has-note', hasNote);
        noteBtn.setAttribute('aria-label', t(hasNote ? 'habitNoteEdit_ariaLabel' : 'habitNoteAdd_ariaLabel'));
    }

    // Atualiza os detalhes
    const detailsEl = card.querySelector<HTMLElement>('.habit-details');
    if (detailsEl) {
        detailsEl.querySelector<HTMLElement>('.name')!.textContent = name;
        detailsEl.querySelector<HTMLElement>('.subtitle')!.textContent = subtitle;
        
        let consolidationMessage = '';
        if (streak >= STREAK_CONSOLIDATED) consolidationMessage = t('habitConsolidatedMessage');
        else if (streak >= STREAK_SEMI_CONSOLIDATED) consolidationMessage = t('habitSemiConsolidatedMessage');
        
        let msgEl = detailsEl.querySelector<HTMLElement>('.consolidation-message');
        if (consolidationMessage) {
            if (!msgEl) {
                msgEl = document.createElement('div');
                msgEl.className = 'consolidation-message';
                detailsEl.appendChild(msgEl);
            }
            msgEl.textContent = consolidationMessage;
        } else if (msgEl) {
            msgEl.remove();
        }
    }
    
    // Atualiza o conteúdo da meta
    const goalEl = card.querySelector<HTMLElement>('.habit-goal');
    if (goalEl) {
        updateGoalContentElement(goalEl, status, habit, time, habitInstanceData);
    }
}


export function updateCalendarDayDOM(dateISO: string) {
    const dayItem = ui.calendarStrip.querySelector<HTMLElement>(`.day-item[data-date="${dateISO}"]`);
    if (!dayItem) return;

    const { completedPercent, totalPercent } = calculateDayProgress(dateISO);
    const showPlus = shouldShowPlusIndicator(dateISO);
    
    const ringEl = dayItem.querySelector<HTMLElement>('.day-progress-ring');
    if (ringEl) {
        ringEl.style.setProperty('--completed-percent', `${completedPercent}%`);
        ringEl.style.setProperty('--total-percent', `${totalPercent}%`);
    }
    
    dayItem.querySelector<HTMLElement>('.day-number')?.classList.toggle('has-plus', showPlus);
}

// Mapa para armazenar os listeners de focus trap para poder removê-los depois
const focusTrapListeners = new Map<HTMLElement, (e: KeyboardEvent) => void>();

export function openModal(modal: HTMLElement) {
    modal.classList.add('visible');
    
    const focusableElements = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusableElements.length === 0) return;

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    // Move o foco para o primeiro elemento focável dentro do modal
    firstFocusable.focus();

    const trapListener = (e: KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        
        if (e.shiftKey) { // Tab reverso
            if (document.activeElement === firstFocusable) {
                lastFocusable.focus();
                e.preventDefault();
            }
        } else { // Tab normal
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
}

export function initializeModalClosing(modal: HTMLElement) {
    modal.addEventListener('click', e => {
        if (e.target === modal) closeModal(modal);
    });
    modal.querySelectorAll<HTMLElement>('.modal-close-btn').forEach(btn => btn.addEventListener('click', () => closeModal(modal)));
}

export function showInlineNotice(element: HTMLElement, message: string) {
    const existingTimeout = (element as any)._noticeTimeout;
    if (existingTimeout) clearTimeout(existingTimeout);
    element.textContent = message;
    element.classList.add('visible');
    const newTimeout = window.setTimeout(() => element.classList.remove('visible'), 2500);
    (element as any)._noticeTimeout = newTimeout;
}

export function createManageHabitListItemHTML(habit: Habit): string {
    const isEnded = !!habit.endedOn;
    const isGraduated = !!habit.graduatedOn;
    const streak = calculateHabitStreak(habit.id, getTodayUTCIso());
    const isConsolidated = streak >= STREAK_CONSOLIDATED;
    const { name } = getHabitDisplayInfo(habit);

    let actionButtons = '', statusClass = '', statusText = '';

    if (isGraduated) {
        statusClass = 'graduated';
        statusText = ` <span class="habit-name-status">${t('modalStatusGraduated')}</span>`;
    } else if (isEnded) {
        statusClass = 'ended';
        statusText = ` <span class="habit-name-status">${t('modalStatusEnded')}</span>`;
        actionButtons = `<button class="permanent-delete-habit-btn" data-habit-id="${habit.id}" aria-label="${t('aria_delete_permanent', { habitName: name })}"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`;
    } else {
        const editButton = `<button class="edit-habit-btn" data-habit-id="${habit.id}" aria-label="${t('aria_edit', { habitName: name })}"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
        if (isConsolidated) {
            actionButtons = `<button class="graduate-habit-btn" data-habit-id="${habit.id}" aria-label="${t('aria_graduate', { habitName: name })}"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2"/><path d="M12 18v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2"/><path d="M6 12h12"/><path d="M18 12v6"/><path d="M18 6V4a2 2 0 0 0-2-2h-2"/><path d="M18 12h-6"/><path d="M12 12V6"/></svg></button>`;
        } else {
            actionButtons = `${editButton}<button class="end-habit-btn" data-habit-id="${habit.id}" aria-label="${t('aria_end', { habitName: name })}"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>`;
        }
    }

    return `
        <li class="habit-list-item ${statusClass}" data-habit-id="${habit.id}">
            <span>${habit.icon}<span class="habit-name">${name}</span>${statusText}</span>
            <div class="habit-list-actions">${actionButtons}</div>
        </li>`;
}

export function setupManageModal() {
    // Filtra as versões antigas dos hábitos para não as mostrar na lista.
    const nextVersionIds = new Set(state.habits.map(h => h.previousVersionId).filter(Boolean));
    const visibleHabits = state.habits.filter(h => !nextVersionIds.has(h.id));

    const habitsToDisplay = [...visibleHabits].sort((a, b) => {
        const aIsActive = !a.endedOn && !a.graduatedOn;
        const bIsActive = !b.endedOn && !b.graduatedOn;
        if (aIsActive !== bIsActive) return aIsActive ? -1 : 1;
        return getHabitDisplayInfo(a).name.localeCompare(getHabitDisplayInfo(b).name);
    });
    ui.habitList.innerHTML = habitsToDisplay.map(createManageHabitListItemHTML).join('');
}

export function showUndoToast() {
    if (state.undoTimeout) clearTimeout(state.undoTimeout);
    ui.undoToast.classList.add('visible');
    state.undoTimeout = window.setTimeout(() => {
        ui.undoToast.classList.remove('visible');
        state.lastEnded = null;
    }, 5000);
}

export function showConfirmationModal(text: string, onConfirm: () => void, onEdit?: () => void) {
    ui.confirmModalText.innerHTML = text; // Usa innerHTML para permitir formatação
    state.confirmAction = onConfirm;
    state.confirmEditAction = onEdit || null;
    ui.confirmModalEditBtn.style.display = onEdit ? 'inline-flex' : 'none';
    openModal(ui.confirmModal);
}

export function openNotesModal(habitId: string, date: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    state.editingNoteFor = { habitId, date, time };
    const habitNote = getHabitDailyInfoForDate(date)[habitId]?.instances?.[time]?.note || '';
    const { name } = getHabitDisplayInfo(habit);
    ui.notesModalTitle.textContent = t('modalNotesTitleFor', { habitName: name });
    const dateObj = parseUTCIsoDate(date);
    ui.notesModalSubtitle.textContent = dateObj.toLocaleDateString(state.activeLanguageCode, { weekday: 'long', day: 'numeric', month: 'long' });
    ui.notesTextarea.value = habitNote;
    openModal(ui.notesModal);
    ui.notesTextarea.focus();
}

export function openEditModal(habitData: Habit | PredefinedHabit | null) {
    const form = ui.editHabitForm;
    const nameInput = form.elements.namedItem('habit-name') as HTMLInputElement;
    const noticeEl = form.querySelector<HTMLElement>('.duplicate-habit-notice');

    const isExistingHabit = habitData !== null && 'id' in habitData;
    const isCustomNew = habitData === null;
    const template = isCustomNew ? {
        nameKey: '', name: '', subtitleKey: '', subtitle: '',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8e44ad" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>',
        color: '#8e44ad',
        times: state.activeFilter !== 'Todos' ? [state.activeFilter] : ['Manhã'],
        goal: { type: 'check', unitKey: 'unitCheck' } as const,
        frequency: { type: 'daily', interval: 1 } as Frequency,
    } : (habitData as Habit | PredefinedHabit);
    
    const habitInfo = getHabitDisplayInfo(template as Habit);
    
    state.editingHabit = { isNew: !isExistingHabit, habitData: template as Omit<Habit, 'id'|'createdOn'> };
    ui.editHabitModalTitle.textContent = isExistingHabit ? t('modalEditTitle') : (isCustomNew ? t('modalCreateTitle') : t('modalAddHabitTitle', { habitName: habitInfo.name }));
    nameInput.value = habitInfo.name;

    const checkboxes = form.querySelectorAll<HTMLInputElement>('input[name="habit-time"]');
    checkboxes.forEach(cb => {
        cb.checked = template.times.includes(cb.value as TimeOfDay);
    });

    renderFrequencyFilter();
    
    nameInput.readOnly = false;
    if(noticeEl) noticeEl.classList.remove('visible');
    openModal(ui.editHabitModal);
    if(isCustomNew) nameInput.focus();
}

export function updateHeaderTitle() {
    const selectedDate = parseUTCIsoDate(state.selectedDate);
    const today = getTodayUTC();
    const yesterday = addDays(today, -1);
    const tomorrow = addDays(today, 1);
    const isMobile = window.innerWidth < 768;

    ui.headerTitle.style.display = 'block';

    if (selectedDate.getTime() === today.getTime()) {
        ui.headerTitle.textContent = t('headerTitleToday');
    } else if (selectedDate.getTime() === yesterday.getTime()) {
        ui.headerTitle.textContent = t('headerTitleYesterday');
    } else if (selectedDate.getTime() === tomorrow.getTime()) {
        ui.headerTitle.textContent = t('headerTitleTomorrow');
    } else {
        const formatOptions: Intl.DateTimeFormatOptions = isMobile 
            ? { day: '2-digit', month: '2-digit', timeZone: 'UTC' }
            : { day: 'numeric', month: 'long', timeZone: 'UTC' };
        ui.headerTitle.textContent = selectedDate.toLocaleDateString(state.activeLanguageCode, formatOptions);
    }
}

export function updateGroupPlaceholder(groupEl: HTMLElement | null) {
    if (!groupEl) return;
    let placeholder = groupEl.querySelector<HTMLElement>('.empty-group-placeholder');
    const hasHabits = !!groupEl.querySelector('.habit-card');

    if (hasHabits && placeholder) {
        placeholder.remove();
    } else if (!hasHabits && !placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'empty-group-placeholder';
        placeholder.textContent = t('noHabitsToday');
        groupEl.appendChild(placeholder);
    } else if (!hasHabits && placeholder) {
        placeholder.textContent = t('noHabitsToday');
    }
}

export function addHabitToDOM(habit: Habit) {
    renderHabits(); // Re-render all habits to place the new one correctly in all its time slots
    ui.habitList.insertAdjacentHTML('beforeend', createManageHabitListItemHTML(habit));
}

export function removeHabitFromDOM(habitId: string) {
    const cardEls = ui.habitContainer.querySelectorAll<HTMLElement>(`.habit-card[data-habit-id="${habitId}"]`);
    cardEls.forEach(cardEl => {
        const parentGroup = cardEl.parentElement as HTMLElement;
        cardEl.remove();
        updateGroupPlaceholder(parentGroup);
    });
    ui.habitList.querySelector<HTMLElement>(`li[data-habit-id="${habitId}"]`)?.remove();
}