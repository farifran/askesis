/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import {
    state,
    Habit,
    HabitStatus,
    HabitDayData,
    getHabitDailyInfoForDate,
    getSmartGoalForHabit,
    shouldShowPlusIndicator,
    calculateHabitStreak,
    LANGUAGES,
    FREQUENCIES,
    TIMES_OF_DAY,
    PREDEFINED_HABITS,
    STREAK_CONSOLIDATED,
    STREAK_SEMI_CONSOLIDATED,
    shouldHabitAppearOnDate,
    Frequency,
    PredefinedHabit,
    TimeOfDay,
    getScheduleForDate,
    HabitTemplate,
    getEffectiveScheduleForHabitOnDate,
} from './state';
import { getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate, escapeHTML, pushToOneSignal } from './utils';
import { ui } from './ui';
import { t, getLocaleDayName, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { STOIC_QUOTES } from './quotes';
import { icons } from './icons';
import { renderChart } from './chart';

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

export function initFrequencyFilter() {
    const freqLabels = FREQUENCIES.map(freq => t(freq.labelKey));
    ui.frequencyReel.innerHTML = freqLabels.map(label => `<span class="reel-option">${label}</span>`).join('');
    updateReelRotaryARIA(ui.frequencyViewport, 0, freqLabels, 'frequency_ariaLabel');
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
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, isoDate);
        const instances = habitDailyInfo?.instances || {};
        
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


function createCalendarDayElement(date: Date): HTMLElement {
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
    ui.calendarStrip.innerHTML = '';
    const fragment = document.createDocumentFragment();
    state.calendarDates.forEach(date => {
        fragment.appendChild(createCalendarDayElement(date));
    });
    ui.calendarStrip.appendChild(fragment);
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
    const currentFrequency = state.editingHabit.formData.frequency;
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
        progressDiv.innerHTML = `<svg class="snoozed-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>`;

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

function getTimeOfDayIcon(time: TimeOfDay): string {
    switch (time) {
        case 'Morning': return icons.morning;
        case 'Afternoon': return icons.afternoon;
        case 'Evening': return icons.evening;
        default: return '';
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

    const timeOfDayIcon = document.createElement('div');
    timeOfDayIcon.className = 'time-of-day-icon';
    timeOfDayIcon.innerHTML = getTimeOfDayIcon(time);
    
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

    contentWrapper.append(timeOfDayIcon, icon, details, goal);
    card.append(actionsLeft, actionsRight, contentWrapper);
    
    return card;
}

export function renderHabits() {
    const selectedDateObj = parseUTCIsoDate(state.selectedDate);
    const dailyInfoByHabit = getHabitDailyInfoForDate(state.selectedDate);

    const habitsByTime: Record<TimeOfDay, Habit[]> = { 'Morning': [], 'Afternoon': [], 'Evening': [] };
    
    state.habits.forEach(habit => {
        if (shouldHabitAppearOnDate(habit, selectedDateObj)) {
            const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);
            
            scheduleForDay.forEach(time => {
                if (habitsByTime[time]) {
                    habitsByTime[time].push(habit);
                }
            });
        }
    });

    const groupHasHabits: Record<TimeOfDay, boolean> = { 'Morning': false, 'Afternoon': false, 'Evening': false };
    TIMES_OF_DAY.forEach(time => {
        groupHasHabits[time] = habitsByTime[time].length > 0;
    });

    const emptyTimes = TIMES_OF_DAY.filter(time => !groupHasHabits[time]);
    let targetTime: TimeOfDay | null = null;
    if (groupHasHabits['Morning'] && !groupHasHabits['Afternoon'] && groupHasHabits['Evening']) {
        targetTime = 'Afternoon';
    } else if (!groupHasHabits['Morning']) {
        targetTime = 'Morning';
    } else if (!groupHasHabits['Afternoon']) {
        targetTime = 'Afternoon';
    } else if (!groupHasHabits['Evening']) {
        targetTime = 'Evening';
    }

    TIMES_OF_DAY.forEach(time => {
        const wrapperEl = ui.habitContainer.querySelector(`.habit-group-wrapper[data-time-wrapper="${time}"]`);
        const groupEl = wrapperEl?.querySelector<HTMLElement>(`.habit-group[data-time="${time}"]`);
        if (!wrapperEl || !groupEl) return;
        
        const fragment = document.createDocumentFragment();
        habitsByTime[time].forEach(habit => {
            fragment.appendChild(createHabitCardElement(habit, time));
        });
        groupEl.innerHTML = '';
        groupEl.appendChild(fragment);
        
        const hasHabits = groupHasHabits[time];
        const isSmartPlaceholder = time === targetTime;
        
        wrapperEl.classList.toggle('has-habits', hasHabits);
        wrapperEl.classList.toggle('is-collapsible', !hasHabits && !isSmartPlaceholder);

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

            if (isSmartPlaceholder && emptyTimes.length > 1) {
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
    const isLoading = state.aiState === 'loading';
    const hasCelebrations = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0;
    const hasUnseenResult = (state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult;

    ui.aiEvalBtn.classList.toggle('loading', isLoading);
    ui.aiEvalBtn.disabled = isLoading;
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
}

const focusTrapListeners = new Map<HTMLElement, (e: KeyboardEvent) => void>();
const previouslyFocusedElements = new WeakMap<HTMLElement, HTMLElement>();

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
    
    // Usa um pequeno timeout para garantir que o elemento seja focável após a transição do modal.
    setTimeout(() => {
        if (targetElement && targetElement.isConnected) {
            if (targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement) {
                targetElement.focus(); // Foca explicitamente primeiro
                targetElement.select(); // Depois seleciona o conteúdo
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

export function setupManageModal() {
    const habitsToDisplay = [...state.habits];

    habitsToDisplay.sort((a, b) => {
        const aIsGraduated = !!a.graduatedOn;
        const bIsGraduated = !!b.graduatedOn;
        const aLastSchedule = a.scheduleHistory[a.scheduleHistory.length - 1];
        const bLastSchedule = b.scheduleHistory[b.scheduleHistory.length - 1];
        const aIsEnded = !!aLastSchedule.endDate;
        const bIsEnded = !!bLastSchedule.endDate;

        if (aIsGraduated !== bIsGraduated) return aIsGraduated ? 1 : -1;
        if (aIsEnded !== bIsEnded) return aIsEnded ? 1 : -1;
        
        return getHabitDisplayInfo(a).name.localeCompare(getHabitDisplayInfo(b).name);
    });
    
    ui.habitList.innerHTML = habitsToDisplay.map(habit => {
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        const isEnded = !!lastSchedule.endDate;
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

        const innerHTML = `<span>${habit.icon}<span class="habit-name">${escapeHTML(name)}</span>${statusText}</span>
            <div class="habit-list-actions">${actionButtons}</div>`;

        return `<li class="habit-list-item ${statusClass}" data-habit-id="${habit.id}">${innerHTML}</li>`;
    }).join('');
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
        onEdit?: () => void;
        confirmText?: string;
        editText?: string;
        cancelText?: string;
    }
) {
    const titleEl = ui.confirmModal.querySelector('h2');
    if (titleEl) {
        titleEl.textContent = options?.title || t('modalConfirmTitle');
    }

    ui.confirmModalText.innerHTML = text;
    state.confirmAction = onConfirm;
    state.confirmEditAction = options?.onEdit || null;

    const confirmBtn = ui.confirmModalConfirmBtn;
    const editBtn = ui.confirmModalEditBtn;
    const cancelBtn = ui.confirmModal.querySelector('.modal-close-btn') as HTMLButtonElement;

    confirmBtn.textContent = options?.confirmText || t('confirmButton');
    if (cancelBtn) {
        cancelBtn.textContent = options?.cancelText || t('cancelButton');
    }

    if (options?.onEdit) {
        editBtn.style.display = 'inline-flex';
        editBtn.textContent = options.editText || t('editButton');
    } else {
        editBtn.style.display = 'none';
    }

    openModal(ui.confirmModal, confirmBtn);
}


export function openNotesModal(habitId: string, date: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    state.editingNoteFor = { habitId, date, time };
    const habitNote = getHabitDailyInfoForDate(date)[habitId]?.instances?.[time]?.note || '';
    const { name } = getHabitDisplayInfo(habit);
    ui.notesModalTitle.textContent = name;
    const dateObj = parseUTCIsoDate(date);
    ui.notesModalSubtitle.textContent = dateObj.toLocaleDateString(state.activeLanguageCode, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    ui.notesTextarea.value = habitNote;
    openModal(ui.notesModal, ui.notesTextarea);
}

export function openEditModal(habitOrTemplate: Habit | PredefinedHabit | null) {
    const form = ui.editHabitForm;
    const nameInput = form.elements.namedItem('habit-name') as HTMLInputElement;
    const noticeEl = form.querySelector<HTMLElement>('.duplicate-habit-notice');

    const isNew = habitOrTemplate === null || !('id' in habitOrTemplate);

    let habitId: string | undefined;
    let originalHabit: Habit | undefined;
    let formData: HabitTemplate;

    if (isNew) {
        if (habitOrTemplate === null) { 
            formData = {
                name: '',
                subtitle: t('customHabitSubtitle'),
                icon: icons.custom,
                color: '#8e44ad',
                times: ['Morning'],
                goal: { type: 'check', unitKey: 'unitCheck' },
                frequency: { type: 'daily', interval: 1 },
            };
        } else { 
            // FIX: Explicitly create object from template to ensure type correctness
            // and prevent extra properties like 'isDefault' from being included.
            const template = habitOrTemplate as PredefinedHabit;
            formData = {
                nameKey: template.nameKey,
                subtitleKey: template.subtitleKey,
                icon: template.icon,
                color: template.color,
                times: template.times,
                goal: template.goal,
                frequency: template.frequency,
            };
        }
    } else { 
        originalHabit = habitOrTemplate as Habit;
        habitId = originalHabit.id;
        const latestSchedule = originalHabit.scheduleHistory[originalHabit.scheduleHistory.length - 1];
        const displayInfo = getHabitDisplayInfo(originalHabit);
        
        formData = {
            name: displayInfo.name,
            subtitle: displayInfo.subtitle,
            icon: originalHabit.icon,
            color: originalHabit.color,
            times: latestSchedule.times,
            goal: originalHabit.goal,
            frequency: latestSchedule.frequency,
        };
    }

    state.editingHabit = { isNew, habitId, originalData: originalHabit, formData };
    
    const habitDisplayName = 'name' in formData ? formData.name : t(formData.nameKey!);
    
    ui.editHabitModalTitle.textContent = isNew ? t('modalAddTitle') : t('modalEditTitle');
    nameInput.value = habitDisplayName;

    const checkboxes = form.querySelectorAll<HTMLInputElement>('input[name="habit-time"]');
    checkboxes.forEach(cb => {
        cb.checked = formData.times.includes(cb.value as TimeOfDay);
    });
    
    renderFrequencyFilter();
    
    if(noticeEl) noticeEl.classList.remove('visible');
    openModal(ui.editHabitModal, nameInput);
}

export function updateHeaderTitle() {
    const selectedDate = parseUTCIsoDate(state.selectedDate);
    const today = parseUTCIsoDate(getTodayUTCIso());
    const yesterday = new Date(today);
    yesterday.setUTCDate(today.getUTCDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(today.getUTCDate() + 1);
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
