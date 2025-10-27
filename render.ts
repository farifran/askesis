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
    HabitSchedule,
    HabitTemplate,
} from './state';
import { getTodayUTCIso, addDays, toUTCIsoDateString, parseUTCIsoDate, getTodayUTC } from './utils';
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
    viewportEl.setAttribute('tabindex', '0'); // Torna o elemento focável
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
        const activeSchedule = getScheduleForDate(habit, dateObj);
        if (!activeSchedule) return;

        const instances = habitDailyInfo?.instances || {};
        const scheduleForDay = habitDailyInfo?.dailySchedule || activeSchedule.times;
        
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

    const dayEl = document.createElement('div');
    dayEl.className = 'day-item';
    dayEl.dataset.date = isoDate;
    dayEl.setAttribute('role', 'button');
    dayEl.setAttribute('tabindex', '0');
    dayEl.setAttribute('aria-label', date.toLocaleDateString(state.activeLanguageCode, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }));

    if (isoDate === state.selectedDate) dayEl.classList.add('selected');
    if (isoDate === todayISO) dayEl.classList.add('today');

    dayEl.innerHTML = `
        <span class="day-name">${getLocaleDayName(date)}</span>
        <div class="day-progress-ring" style="--completed-percent: ${completedPercent}%; --total-percent: ${totalPercent}%;">
            <span class="day-number ${showPlus ? 'has-plus' : ''}">${date.getUTCDate()}</span>
        </div>
    `;
    return dayEl;
}

export function renderCalendar() {
    ui.calendarStrip.innerHTML = '';
    state.calendarDates.forEach(date => {
        ui.calendarStrip.appendChild(createCalendarDayElement(date));
    });
}

export function updateHeaderTitle() {
    const today = getTodayUTC();
    const selected = parseUTCIsoDate(state.selectedDate);
    const diffDays = Math.round((selected.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
        ui.headerTitle.textContent = t('headerTitleToday');
    } else if (diffDays === -1) {
        ui.headerTitle.textContent = t('headerTitleYesterday');
    } else if (diffDays === 1) {
        ui.headerTitle.textContent = t('headerTitleTomorrow');
    } else {
        ui.headerTitle.textContent = selected.toLocaleDateString(state.activeLanguageCode, {
            day: 'numeric',
            month: 'long',
            timeZone: 'UTC'
        });
    }
}

export function renderStoicQuote() {
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24));
    const quoteIndex = dayOfYear % STOIC_QUOTES.length;
    const quote = STOIC_QUOTES[quoteIndex][state.activeLanguageCode] || STOIC_QUOTES[quoteIndex]['en'];
    ui.stoicQuoteDisplay.innerHTML = `&ldquo;${quote}&rdquo; &ndash; ${t('marcusAurelius')}`;
    
    // Animação de fade-in
    ui.stoicQuoteDisplay.classList.remove('visible');
    setTimeout(() => ui.stoicQuoteDisplay.classList.add('visible'), 50);
}

export const formatGoalForDisplay = (goalValue?: number): string => {
    if (goalValue === undefined) return '';
    return goalValue.toLocaleString(state.activeLanguageCode);
};

export const getUnitString = (habit: Habit, goal: number): string => {
    return t(habit.goal.unitKey, { count: goal });
};

const createHabitElement = (habit: Habit, time: TimeOfDay): HTMLElement => {
    const { name, subtitle } = getHabitDisplayInfo(habit);
    const date = state.selectedDate;
    const dayHabitData = state.dailyData[date]?.[habit.id]?.instances[time];
    const status = dayHabitData?.status || 'pending';
    const smartGoal = getSmartGoalForHabit(habit, date, time);
    const goalOverride = dayHabitData?.goalOverride;

    const streak = calculateHabitStreak(habit.id, date);
    const isSemiConsolidated = streak >= STREAK_SEMI_CONSOLIDATED && streak < STREAK_CONSOLIDATED;
    const isConsolidated = streak >= STREAK_CONSOLIDATED;
    // FIX: Corrected typo from `isSemi-consolidated` to `isSemiConsolidated`.
    const consolidationMessage = isConsolidated ? t('habitConsolidatedMessage') : (isSemiConsolidated ? t('habitSemiConsolidatedMessage') : '');

    const card = document.createElement('div');
    card.className = `habit-card ${status}`;
    if (isSemiConsolidated) card.classList.add('semi-consolidated');
    if (isConsolidated) card.classList.add('consolidated');

    card.dataset.habitId = habit.id;
    card.dataset.time = time;

    let goalHtml = '';
    if (habit.goal.type === 'check') {
        goalHtml = `<div class="habit-goal-controls"></div>`;
    } else if (habit.goal.type === 'pages' || habit.goal.type === 'minutes') {
        const displayGoal = goalOverride ?? smartGoal;
        goalHtml = `
            <div class="habit-goal-controls">
                <button class="goal-control-btn" data-action="decrement" aria-label="${t('habitGoalDecrement_ariaLabel')}">-</button>
                <div class="goal-value-wrapper">
                    <span class="progress">${formatGoalForDisplay(displayGoal)}</span><br>
                    <span class="unit">${getUnitString(habit, displayGoal)}</span>
                </div>
                <button class="goal-control-btn" data-action="increment" aria-label="${t('habitGoalIncrement_ariaLabel')}">+</button>
            </div>`;
    }

    card.innerHTML = `
        <div class="habit-actions-left">
             <button class="swipe-delete-btn" aria-label="${t('habitEnd_ariaLabel')}"></button>
        </div>
        <div class="habit-content-wrapper" draggable="true">
            <div class="time-of-day-icon" style="opacity: 0;">
                ${icons[time === 'Manhã' ? 'sunlight' : (time === 'Tarde' ? 'walk' : 'disconnect')].replace('stroke="#f39c12"', 'stroke="currentColor"').replace('stroke="#27ae60"', 'stroke="currentColor"').replace('stroke="#2980b9"', 'stroke="currentColor"')}
            </div>
            <div class="habit-icon">${habit.icon}</div>
            <div class="habit-details">
                <div class="name">${name}</div>
                ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
                ${consolidationMessage ? `<div class="consolidation-message">${consolidationMessage}</div>` : ''}
            </div>
            <div class="habit-goal">
                ${goalHtml}
            </div>
        </div>
        <div class="habit-actions-right">
            <button class="swipe-note-btn ${dayHabitData?.note ? 'has-note' : ''}" aria-label="${dayHabitData?.note ? t('habitNoteEdit_ariaLabel') : t('habitNoteAdd_ariaLabel')}"></button>
        </div>
    `;

    return card;
};

export function renderHabits() {
    const date = parseUTCIsoDate(state.selectedDate);
    const dailyInfo = getHabitDailyInfoForDate(state.selectedDate);
    const activeHabitsOnDate = state.habits.filter(h => shouldHabitAppearOnDate(h, date));

    const timeGroups: Record<TimeOfDay, Habit[]> = { 'Manhã': [], 'Tarde': [], 'Noite': [] };
    
    activeHabitsOnDate.forEach(habit => {
        const activeSchedule = getScheduleForDate(habit, date);
        if (!activeSchedule) return;

        const habitDailyInfo = dailyInfo[habit.id];
        const scheduleForDay = habitDailyInfo?.dailySchedule || activeSchedule.times;

        scheduleForDay.forEach(time => {
            if (timeGroups[time]) {
                timeGroups[time].push(habit);
            }
        });
    });

    const isDraggingActive = document.body.classList.contains('is-dragging-active');

    TIMES_OF_DAY.forEach(time => {
        const groupEl = ui.habitContainer.querySelector<HTMLElement>(`.habit-group[data-time="${time}"]`)!;
        const wrapperEl = groupEl.closest<HTMLElement>('.habit-group-wrapper')!;
        const placeholder = wrapperEl.querySelector<HTMLElement>('.empty-group-placeholder');
        groupEl.innerHTML = '';

        const habitsForTime = timeGroups[time];

        if (habitsForTime.length > 0) {
            wrapperEl.classList.add('has-habits');
            habitsForTime.forEach(habit => {
                const habitEl = createHabitElement(habit, time);
                groupEl.appendChild(habitEl);
            });
        } else {
            wrapperEl.classList.remove('has-habits');
        }
        
        if (placeholder) {
            const hasPredefinedHabitsForTime = PREDEFINED_HABITS.some(p => p.times.includes(time));
            if (hasPredefinedHabitsForTime && !isDraggingActive) {
                placeholder.classList.add('show-smart-placeholder');
            } else {
                placeholder.classList.remove('show-smart-placeholder');
            }
            placeholder.querySelector('.placeholder-text')!.textContent = t('dragToAddHabit');
        }
    });
}

export function showUndoToast() {
    if (state.undoTimeout) clearTimeout(state.undoTimeout);
    ui.undoToast.classList.add('visible');
    state.undoTimeout = window.setTimeout(() => {
        ui.undoToast.classList.remove('visible');
        state.lastEnded = null;
    }, 5000);
}


// --- MODAL RENDERING AND MANAGEMENT ---

export function openModal(modal: HTMLElement) {
    modal.classList.add('visible');
}

export function closeModal(modal: HTMLElement) {
    modal.classList.remove('visible');
}

export function initializeModalClosing(modal: HTMLElement) {
    const closeBtn = modal.querySelector<HTMLButtonElement>('.modal-close-btn');
    modal.addEventListener('click', e => {
        if (e.target === modal) closeModal(modal);
    });
    closeBtn?.addEventListener('click', () => closeModal(modal));
}

export function showConfirmationModal(
    text: string, 
    onConfirm: () => void,
    options: { onEdit?: () => void; title?: string, confirmText?: string; editText?: string, cancelText?: string } = {}
) {
    const { onEdit, title, confirmText, editText } = options;
    
    ui.confirmModalText.innerHTML = text;
    state.confirmAction = onConfirm;
    state.confirmEditAction = onEdit || null;
    
    if (title) {
        (ui.confirmModal.querySelector('h2') as HTMLElement).textContent = title;
    }
    
    ui.confirmModalConfirmBtn.textContent = confirmText || t('confirmButton');
    
    if (onEdit) {
        ui.confirmModalEditBtn.style.display = 'block';
        ui.confirmModalEditBtn.textContent = editText || t('editButton');
    } else {
        ui.confirmModalEditBtn.style.display = 'none';
    }

    openModal(ui.confirmModal);
}

export function renderExploreHabits() {
    ui.exploreHabitList.innerHTML = PREDEFINED_HABITS.map((habit, index) => {
        const { name, subtitle } = getHabitDisplayInfo(habit);
        const isDisabled = state.habits.some(h => {
            const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
            return lastSchedule.nameKey === habit.nameKey && !lastSchedule.endDate && !h.graduatedOn;
        });

        return `
            <div class="explore-habit-item ${isDisabled ? 'disabled' : ''}" data-index="${index}" role="button" tabindex="0" aria-disabled="${isDisabled}">
                <div class="explore-habit-icon">${habit.icon}</div>
                <div class="explore-habit-details">
                    <div class="name">${name}</div>
                    <div class="subtitle">${subtitle}</div>
                </div>
            </div>
        `;
    }).join('');
}

export function setupManageModal() {
    const endedHabits: Habit[] = [];
    const activeHabits: Habit[] = [];

    state.habits.forEach(habit => {
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        if (lastSchedule.endDate || habit.graduatedOn) {
            endedHabits.push(habit);
        } else {
            activeHabits.push(habit);
        }
    });

    const createListItem = (habit: Habit) => {
        const { name } = getHabitDisplayInfo(habit);
        const isEnded = !!habit.scheduleHistory[habit.scheduleHistory.length - 1].endDate;
        const isGraduated = !!habit.graduatedOn;

        let statusText = '';
        let itemClass = '';
        if (isGraduated) {
            statusText = `<span class="status-text">${t('modalStatusGraduated')}</span>`;
            itemClass = 'graduated';
        } else if (isEnded) {
            statusText = `<span class="status-text">${t('modalStatusEnded')}</span>`;
            itemClass = 'ended';
        }
        
        const canGraduate = calculateHabitStreak(habit.id, getTodayUTCIso()) >= STREAK_CONSOLIDATED && !isGraduated;

        return `
            <li class="habit-list-item ${itemClass}">
                <span>${habit.icon} ${name} ${statusText}</span>
                <div class="habit-list-actions">
                    ${!isEnded && !isGraduated ? `<button class="edit-habit-btn" data-habit-id="${habit.id}" aria-label="${t('aria_edit', { habitName: name })}"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>` : ''}
                    ${canGraduate ? `<button class="graduate-habit-btn" data-habit-id="${habit.id}" aria-label="${t('aria_graduate', { habitName: name })}"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg></button>` : ''}
                    ${!isEnded && !isGraduated ? `<button class="end-habit-btn" data-habit-id="${habit.id}" aria-label="${t('aria_end', { habitName: name })}"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg></button>` : ''}
                    ${isEnded && !isGraduated ? `<button class="permanent-delete-habit-btn" data-habit-id="${habit.id}" aria-label="${t('aria_delete_permanent', { habitName: name })}"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>` : ''}
                </div>
            </li>
        `;
    };

    const activeListHtml = activeHabits.map(createListItem).join('');
    const endedListHtml = endedHabits.map(createListItem).join('');
    ui.habitList.innerHTML = activeListHtml + endedListHtml;
}

export function openNotesModal(habitId: string, date: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const { name } = getHabitDisplayInfo(habit);
    const dayInstanceData = state.dailyData[date]?.[habit.id]?.instances[time];

    state.editingNoteFor = { habitId, date, time };
    ui.notesModalTitle.textContent = t('modalNotesTitleFor', { habitName: name });
    ui.notesModalSubtitle.textContent = parseUTCIsoDate(date).toLocaleDateString(state.activeLanguageCode, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    ui.notesTextarea.value = dayInstanceData?.note || '';
    
    openModal(ui.notesModal);
    ui.notesTextarea.focus();
}

export function openEditModal(habitOrTemplate: Habit | PredefinedHabit | null, sourceModal?: 'explore' | 'manage') {
    const isNew = !habitOrTemplate || 'nameKey' in habitOrTemplate || !('id' in habitOrTemplate);

    let formData: HabitTemplate;
    
    if (isNew) {
        if (habitOrTemplate) { // Predefined
            formData = {
                nameKey: (habitOrTemplate as PredefinedHabit).nameKey,
                subtitleKey: (habitOrTemplate as PredefinedHabit).subtitleKey,
                icon: habitOrTemplate.icon,
                color: habitOrTemplate.color,
                // FIX: Cast habitOrTemplate to PredefinedHabit to access the 'times' property, as the base 'Habit' type does not have it.
                times: [...(habitOrTemplate as PredefinedHabit).times],
                goal: { ...habitOrTemplate.goal },
                frequency: { ...(habitOrTemplate as PredefinedHabit).frequency },
            };
        } else { // Custom
            formData = {
                name: '',
                subtitle: t('customHabitSubtitle'),
                icon: icons.custom,
                color: '#8e44ad',
                times: ['Manhã'],
                goal: { type: 'check', unitKey: 'unitCheck' },
                frequency: { type: 'daily', interval: 1 },
            };
        }
    } else { // Editing existing
        const habit = habitOrTemplate as Habit;
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        const { name, subtitle } = getHabitDisplayInfo(habit);
        formData = {
            name: name,
            subtitle: subtitle,
            icon: habit.icon,
            color: habit.color,
            times: [...lastSchedule.times],
            goal: { ...habit.goal },
            frequency: { ...lastSchedule.frequency },
        };
    }
    
    state.editingHabit = {
        isNew: isNew,
        habitId: isNew ? undefined : (habitOrTemplate as Habit).id,
        originalData: isNew ? undefined : (habitOrTemplate as Habit),
        formData: formData,
        sourceModal: sourceModal,
    };
    
    const { name } = getHabitDisplayInfo({ 'scheduleHistory': [formData] } as any);

    ui.editHabitModalTitle.textContent = isNew ? t('modalAddHabitTitle', { habitName: name }) : t('modalEditTitle');
    
    const form = ui.editHabitForm;
    (form.elements.namedItem('habit-name') as HTMLInputElement).value = name;

    const timeCheckboxes = form.querySelectorAll<HTMLInputElement>('input[name="habit-time"]');
    timeCheckboxes.forEach(cb => {
        cb.checked = formData.times.includes(cb.value as TimeOfDay);
    });

    renderFrequencyFilter();

    // Limpa o aviso de duplicado ao abrir
    const noticeEl = form.querySelector<HTMLElement>('.duplicate-habit-notice');
    if (noticeEl) {
        noticeEl.classList.remove('visible');
        noticeEl.textContent = '';
    }
    
    openModal(ui.editHabitModal);
}

export function renderLanguageFilter() {
    const currentIndex = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode);
    const itemWidth = ui.languageReel.firstElementChild?.clientWidth || 0;
    ui.languageReel.style.transform = `translateX(-${currentIndex * itemWidth}px)`;
    updateReelRotaryARIA(ui.languageViewport, currentIndex, LANGUAGES.map(l => t(l.nameKey)), 'language_ariaLabel');
}

export function renderFrequencyFilter() {
    if (!state.editingHabit) return;
    const currentFrequency = state.editingHabit.formData.frequency;
    const currentIndex = FREQUENCIES.findIndex(f => f.value.type === currentFrequency.type && f.value.interval === currentFrequency.interval);
    const itemWidth = ui.frequencyReel.firstElementChild?.clientWidth || 0;
    ui.frequencyReel.style.transform = `translateX(-${Math.max(0, currentIndex) * itemWidth}px)`;
    updateReelRotaryARIA(ui.frequencyViewport, Math.max(0, currentIndex), FREQUENCIES.map(f => t(f.labelKey)), 'frequency_ariaLabel');
}

export function renderAINotificationState() {
    const hasUnseenResult = state.aiState === 'completed' && !state.hasSeenAIResult;
    const hasPendingNotification = state.pending21DayHabitIds.length > 0 || state.pendingConsolidationHabitIds.length > 0;
    
    ui.aiEvalBtn.classList.toggle('has-notification', hasUnseenResult || hasPendingNotification);
    
    if (state.aiState === 'loading') {
        ui.aiEvalBtn.classList.add('loading');
        ui.aiEvalBtn.disabled = true;
    } else {
        ui.aiEvalBtn.classList.remove('loading');
        ui.aiEvalBtn.disabled = false;
    }
}

export async function updateNotificationUI() {
    // FIX: Refactored to fix race condition and type errors.
    // The logic now runs entirely within the OneSignal callback to ensure
    // `permissionStatus` is available when the UI is built.
    await window.OneSignal?.push(async (OneSignal: any) => {
        const permissionStatus: 'default' | 'granted' | 'denied' = OneSignal.Notifications.permission;
        let pushSubscriptionEnabled = false;
        
        if (permissionStatus === 'granted') {
            pushSubscriptionEnabled = OneSignal.User.PushSubscription.optedIn;
        }

        const statusSection = document.getElementById('notification-status-section')!;
        const descEl = ui.notificationStatusDesc;
        let content = '';

        if (permissionStatus === 'granted') {
            if (pushSubscriptionEnabled) {
                content = `<div class="notification-status-item"><strong>Status:</strong> Ativado</div>`;
                descEl.textContent = t('modalManageNotificationsStaticDesc');
            } else {
                content = `<div class="notification-status-item"><strong>Status:</strong> Ativado, mas desativado no OneSignal.</div>`;
                descEl.textContent = "Você permitiu notificações, mas pode tê-las desativado nas configurações do OneSignal ou do dispositivo.";
            }
        } else if (permissionStatus === 'denied') {
            content = `<div class="notification-status-item"><strong>Status:</strong> Bloqueado</div>`;
            descEl.textContent = "Você bloqueou as notificações. Para ativá-las, você precisará alterar as permissões para este site nas configurações do seu navegador.";
        } else { // default
            content = `<button id="enable-notifications-btn" class="btn">${t('notificationPromptTitle')}</button>`;
            descEl.textContent = t('notificationPromptMessage');
        }

        statusSection.innerHTML = descEl.outerHTML + content;

        const enableBtn = document.getElementById('enable-notifications-btn');
        enableBtn?.addEventListener('click', async () => {
            await OneSignal.Notifications.requestPermission();
            updateNotificationUI(); // Re-renderiza a UI após a tentativa de permissão
        });
    });
}

export function showInlineNotice(element: HTMLElement, message: string) {
    element.textContent = message;
    element.classList.add('visible');
    setTimeout(() => {
        element.classList.remove('visible');
    }, 3000);
}

export function renderApp() {
    renderCalendar();
    renderHabits();
    renderChart();
}