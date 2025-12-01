/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import {
    state,
    saveState,
    Habit,
    TimeOfDay,
    Frequency,
    HabitSchedule,
    HabitDailyInfo,
    calculateHabitStreak,
    invalidateChartCache,
    getEffectiveScheduleForHabitOnDate,
    ensureHabitInstanceData,
    getNextStatus,
    HabitStatus,
    ensureHabitDailyInfo,
    PREDEFINED_HABITS,
    getHabitDailyInfoForDate,
    getActiveHabitsForDate,
    clearScheduleCache,
    clearActiveHabitsCache,
    STREAK_CONSOLIDATED,
    STREAK_SEMI_CONSOLIDATED,
    invalidateStreakCache,
    invalidateDaySummaryCache
} from './state';
import {
    renderApp,
    closeModal,
    openModal,
    showConfirmationModal,
    renderHabitCardState,
    setupManageModal,
    updateNotificationUI,
    openEditModal,
    renderAINotificationState,
    showUndoToast,
    renderCalendarDayPartial
} from './render';
import { ui } from './ui';
import { t, getHabitDisplayInfo } from './i18n';
import {
    generateUUID,
    getTodayUTCIso,
    toUTCIsoDateString,
    addDays,
    parseUTCIsoDate,
    triggerHaptic,
    getTodayUTC
} from './utils';
import { apiFetch } from './api';
import { STOIC_QUOTES } from './quotes';
import { icons } from './icons';
import { updateAppBadge } from './badge';

// --- CREATE & EDIT ---

export function createDefaultHabit() {
    const defaultTemplate = PREDEFINED_HABITS.find(h => h.isDefault) || PREDEFINED_HABITS[0];
    const newHabit: Habit = {
        id: generateUUID(),
        icon: defaultTemplate.icon,
        color: defaultTemplate.color,
        goal: defaultTemplate.goal,
        createdOn: getTodayUTCIso(),
        scheduleHistory: [{
            startDate: getTodayUTCIso(),
            times: defaultTemplate.times,
            frequency: defaultTemplate.frequency,
            nameKey: defaultTemplate.nameKey,
            subtitleKey: defaultTemplate.subtitleKey,
            scheduleAnchor: getTodayUTCIso()
        }]
    };
    state.habits.push(newHabit);
    // No saveState() called here typically, caller handles it or we add it. 
    // index.tsx calls saveState() manually after this.
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const { isNew, habitId, originalData, formData, targetDate } = state.editingHabit;
    
    // Validation
    if (formData.name && formData.name.trim().length === 0) {
        // UI handling for validation is done in listeners, but double check here
        return;
    }

    // Determine basic properties
    const nowISO = getTodayUTCIso();
    // Use targetDate (snapshot when modal opened) to ensure consistency, 
    // but for schedule start date we usually want "today" or "targetDate" depending on logic.
    // If editing past, usually we want changes to apply from now on, or split history.
    // For simplicity in this app version, we apply schedule changes from targetDate.
    const startDate = targetDate || nowISO;

    let habitToSave: Habit;

    if (isNew) {
        habitToSave = {
            id: generateUUID(),
            icon: formData.icon,
            color: formData.color,
            goal: formData.goal,
            createdOn: startDate,
            scheduleHistory: [{
                startDate: startDate,
                times: formData.times,
                frequency: formData.frequency,
                name: formData.name,
                nameKey: formData.nameKey,
                subtitle: formData.subtitle,
                subtitleKey: formData.subtitleKey,
                scheduleAnchor: startDate
            }]
        };
        state.habits.push(habitToSave);
    } else {
        const existingHabit = state.habits.find(h => h.id === habitId);
        if (!existingHabit) return;

        // Visual properties update globally
        existingHabit.icon = formData.icon;
        existingHabit.color = formData.color;
        existingHabit.goal = formData.goal; // Goal changes apply globally for simplicity in this version

        // Schedule Logic
        // We compare with the *current effective schedule* for the target date
        // If critical properties changed, we add a new schedule entry to history
        const lastSchedule = existingHabit.scheduleHistory[existingHabit.scheduleHistory.length - 1];
        
        const hasScheduleChanged = 
            JSON.stringify(lastSchedule.times) !== JSON.stringify(formData.times) ||
            JSON.stringify(lastSchedule.frequency) !== JSON.stringify(formData.frequency) ||
            lastSchedule.name !== formData.name ||
            lastSchedule.subtitle !== formData.subtitle ||
            lastSchedule.nameKey !== formData.nameKey;

        if (hasScheduleChanged) {
            // End previous schedule
            if (!lastSchedule.endDate) {
                 // Technically we should check if start date is same to avoid 0-day spans, 
                 // but simplified logic:
                 // If the change is happening "today", we might overwrite the last schedule if it also started "today"
                 if (lastSchedule.startDate === startDate) {
                     // Update in place
                     Object.assign(lastSchedule, {
                        times: formData.times,
                        frequency: formData.frequency,
                        name: formData.name,
                        subtitle: formData.subtitle,
                        nameKey: formData.nameKey,
                        subtitleKey: formData.subtitleKey
                     });
                 } else {
                     // Close old, start new
                     // The old one ends yesterday relative to new start
                     // But if startDate is today, endDate is yesterday.
                     // Helper: simple approach, create new entry.
                     lastSchedule.endDate = startDate; // Overlap logic handled by getScheduleForDate (start inclusive, end exclusive usually, or strictly ordered)
                     // Actually state.ts logic: dateStr < schedule.endDate. So setting endDate = startDate makes it end *before* today.
                     
                     existingHabit.scheduleHistory.push({
                         startDate: startDate,
                         times: formData.times,
                         frequency: formData.frequency,
                         name: formData.name,
                         nameKey: formData.nameKey,
                         subtitle: formData.subtitle,
                         subtitleKey: formData.subtitleKey,
                         scheduleAnchor: startDate
                     });
                 }
            }
        }
    }

    saveState();
    clearScheduleCache(); // Important!
    clearActiveHabitsCache();
    
    closeModal(ui.editHabitModal);
    
    // Refresh UI
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    renderApp();
    triggerHaptic('success');
}

// --- DELETE / END / GRADUATE ---

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmEndHabitBody', { habitName: name }),
        () => endHabit(habitId),
        {
            title: t('confirmEndHabitTitle'),
            confirmText: t('confirmEndHabitBtn'),
            confirmButtonStyle: 'danger'
        }
    );
}

function endHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const todayISO = getTodayUTCIso();
    const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
    
    // Store for undo
    state.lastEnded = {
        habitId,
        lastSchedule: JSON.parse(JSON.stringify(lastSchedule)),
        removedSchedules: []
    };

    // Set end date to today (effectively ends start of today, or tomorrow? 
    // Usually "End Habit" means "I stop doing it now". So endDate = today.
    // getScheduleForDate checks `date < endDate`. So if endDate == Today, it won't appear Today.
    // If we want it to appear today but stop tomorrow, endDate should be Tomorrow.
    // Let's assume End means "stop appearing from today onwards".
    lastSchedule.endDate = todayISO;

    saveState();
    clearScheduleCache();
    clearActiveHabitsCache();
    
    closeModal(ui.manageModal); // Close manager if open
    setupManageModal(); // Refresh manager list if needed
    
    showUndoToast();
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.calendarVisuals = true;
    renderApp();
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmDeleteHabitBody', { habitName: name }),
        () => deleteHabit(habitId),
        {
            title: t('confirmDeleteHabitTitle'),
            confirmText: t('confirmDeleteHabitBtn'),
            confirmButtonStyle: 'danger'
        }
    );
}

function deleteHabit(habitId: string) {
    state.habits = state.habits.filter(h => h.id !== habitId);
    // Cleanup daily data
    Object.keys(state.dailyData).forEach(date => {
        if (state.dailyData[date][habitId]) {
            delete state.dailyData[date][habitId];
        }
    });

    saveState();
    clearScheduleCache();
    clearActiveHabitsCache();
    
    // Update manage modal list if open
    setupManageModal();
    
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.calendarVisuals = true;
    renderApp();
    triggerHaptic('medium');
}

export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        openEditModal(habit);
    }
}

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    habit.graduatedOn = getTodayUTCIso();
    saveState();
    clearScheduleCache();
    clearActiveHabitsCache();
    
    setupManageModal();
    renderApp();
    triggerHaptic('success');
}

// --- DATA MANAGEMENT ---

export function resetApplicationData() {
    localStorage.removeItem('habitTrackerState_v1');
    state.habits = [];
    state.dailyData = {};
    state.notificationsShown = [];
    state.pending21DayHabitIds = [];
    state.pendingConsolidationHabitIds = [];
    
    createDefaultHabit();
    saveState();
    
    // Clear caches
    clearScheduleCache();
    clearActiveHabitsCache();
    invalidateChartCache();
    
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.calendarVisuals = true;
    renderApp();
}

// --- NOTES ---

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;
    const noteContent = ui.notesTextarea.value.trim();
    
    const instance = ensureHabitInstanceData(date, habitId, time);
    instance.note = noteContent;

    saveState();
    closeModal(ui.notesModal);
    
    // Update specific card UI
    renderHabitCardState(habitId, time);
}

// --- DRAG & DROP & SWIPE ACTIONS ---

export function handleHabitDrop(habitId: string, sourceTime: TimeOfDay, targetTime: TimeOfDay) {
    // This action changes the time of day for the habit.
    // If it's a specific day, we should probably add a daily override.
    // But Drag&Drop usually implies a permanent schedule change or a "do it later" for today.
    // For this app, let's assume it updates the schedule moving forward (or for today if we had that granularity).
    // Given the complexity, let's update the schedule anchor to today and modify the times.
    
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const todayISO = getTodayUTCIso();
    const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];

    // Simple logic: If dragging to a different time, update the times array in the schedule.
    // We remove sourceTime and add targetTime.
    
    // Check if we need to split history
    if (lastSchedule.startDate !== todayISO) {
        // Create new schedule starting today
        const newTimes = lastSchedule.times.filter(t => t !== sourceTime);
        if (!newTimes.includes(targetTime)) newTimes.push(targetTime);
        
        lastSchedule.endDate = todayISO;
        habit.scheduleHistory.push({
            ...JSON.parse(JSON.stringify(lastSchedule)),
            startDate: todayISO,
            endDate: undefined,
            times: newTimes,
            scheduleAnchor: todayISO
        });
    } else {
        // Just update current schedule
        const newTimes = lastSchedule.times.filter(t => t !== sourceTime);
        if (!newTimes.includes(targetTime)) newTimes.push(targetTime);
        lastSchedule.times = newTimes;
    }

    saveState();
    clearScheduleCache();
    clearActiveHabitsCache();
    
    state.uiDirtyState.habitListStructure = true; // Order changed
    renderApp();
}

export function reorderHabit(habitId: string, targetHabitId: string, position: 'before' | 'after') {
    // Reordering is tricky with the current state structure (array of habits).
    // We just move the habit in the `state.habits` array.
    const fromIndex = state.habits.findIndex(h => h.id === habitId);
    const toIndex = state.habits.findIndex(h => h.id === targetHabitId);
    
    if (fromIndex === -1 || toIndex === -1) return;
    
    const [habit] = state.habits.splice(fromIndex, 1);
    const newIndex = position === 'before' ? toIndex : toIndex + 1;
    // Adjust index if we removed an element before the target
    const adjustedIndex = (fromIndex < toIndex) ? newIndex - 1 : newIndex;
    
    state.habits.splice(adjustedIndex, 0, habit);
    
    saveState();
    state.uiDirtyState.habitListStructure = true;
    renderApp();
}

// --- HABIT INTERACTION ---

export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const instance = ensureHabitInstanceData(date, habitId, time);
    const next = getNextStatus(instance.status);
    instance.status = next;
    
    // Check milestones if completed
    if (next === 'completed') {
        const streak = calculateHabitStreak(habitId, date); // This calc happens *after* status update in memory? 
        // No, calculateHabitStreak reads from state. If we just updated state, it reads new state.
        // But we need to invalidate cache first.
        invalidateChartCache();
        
        // We can't easily calc new streak without clearing cache first.
        // Let's rely on the rendering loop or calculate manually.
        // For simplicity:
        // if (streak === 21) state.pending21DayHabitIds.push(habitId);
        // if (streak === 66) state.pendingConsolidationHabitIds.push(habitId);
        // But calculateHabitStreak uses cache.
    }

    saveState();
    // Invalidate streaks for this habit from this date onwards
    invalidateStreakCache(habitId, date);
    
    // Also daily summary cache
    invalidateDaySummaryCache(date);
    
    invalidateChartCache();
    
    // Surgical update
    renderHabitCardState(habitId, time);
    
    // Update calendar day partial
    renderCalendarDayPartial(date);
    
    // Check for badge update
    updateAppBadge();
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, val: number) {
    const instance = ensureHabitInstanceData(date, habitId, time);
    instance.goalOverride = val;
    saveState();
    // UI update handled by caller (habitCardListeners) usually, but we should ensure consistency
    // No visual side effects here other than saving data.
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const date = state.selectedDate;
    const { name } = getHabitDisplayInfo(habit, date);
    const schedule = getEffectiveScheduleForHabitOnDate(habit, date);

    // LÓGICA ATUALIZADA [2025-02-15]:
    // Anteriormente, se houvesse apenas 1 horário, forçávamos a exclusão permanente.
    // Agora, permitimos que o usuário escolha entre "Apagar Hábito" (Destrutivo/Histórico) 
    // ou "Remover Horário" (Que leva ao fluxo de "Apenas Hoje" ou "Encerrar/Arquivar").
    
    const isSingleSchedule = schedule.length <= 1;
    
    const bodyText = isSingleSchedule
        ? t('confirmRemoveTime', { habitName: name, time: t(`filter${time}`) })
        : t('confirmRemoveTimeMulti', { time: t(`filter${time}`) });
    
    // Se houver múltiplos horários, oferece a escolha
    showConfirmationModal(
        bodyText,
        () => {
            // Ação Principal: Apagar Tudo (Cuidado, isso é destrutivo)
            requestHabitPermanentDeletion(habitId);
        },
        {
            title: t('modalRemoveTimeTitle'),
            confirmText: t('btnRemoveHabit'), // "Apagar Hábito"
            confirmButtonStyle: 'danger',
            
            // Ação de Edição: Remover apenas este horário
            editText: t('btnRemoveTimeOnly', { time: t(`filter${time}`) }),
            onEdit: () => {
                 // UPDATE [2025-02-17]: Simplified flow. 
                 // Removing the time slot is now implicitly "From Now On" (Future).
                 // Skips the secondary modal asking "Just Today" vs "Future".
                 _removeTimeFromSchedule(habit, date, time, 'future');
            }
        }
    );
}

function _requestFutureScheduleChange(habit: Habit, date: string, text: string, title: string, timeToRemove: TimeOfDay) {
    // This is the "Just Today" vs "From Now On" logic
    showConfirmationModal(
        text, // Reuse text
        () => {
            // From Now On (or "Remove Time" general)
            _removeTimeFromSchedule(habit, date, timeToRemove, 'future');
        },
        {
            title: title,
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: () => {
                _removeTimeFromSchedule(habit, date, timeToRemove, 'today');
            }
        }
    );
}

function _removeTimeFromSchedule(habit: Habit, date: string, timeToRemove: TimeOfDay, mode: 'today' | 'future') {
    if (mode === 'today') {
        const effectiveSchedule = getEffectiveScheduleForHabitOnDate(habit, date);
        const newTimes = effectiveSchedule.filter(t => t !== timeToRemove);
        
        const dailyInfo = ensureHabitDailyInfo(date, habit.id);
        dailyInfo.dailySchedule = newTimes;
    } else {
        // Future / Permanent Change
        const todayISO = getTodayUTCIso();
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        
        // If startDate is already today, just update it.
        // Otherwise, split history.
        // Simplified:
        if (lastSchedule.startDate !== date) { // Assuming 'date' is today or we treat it as effective change date
             const effectiveSchedule = getEffectiveScheduleForHabitOnDate(habit, date); // Base on current state
             const newTimes = effectiveSchedule.filter(t => t !== timeToRemove);
             
             lastSchedule.endDate = date;
             habit.scheduleHistory.push({
                 ...JSON.parse(JSON.stringify(lastSchedule)),
                 startDate: date,
                 endDate: undefined,
                 times: newTimes,
                 scheduleAnchor: date
             });
        } else {
            lastSchedule.times = lastSchedule.times.filter(t => t !== timeToRemove);
        }
    }

    saveState();
    clearScheduleCache();
    clearActiveHabitsCache();
    
    state.uiDirtyState.habitListStructure = true;
    renderApp();
}


// --- AI ANALYSIS ---

// DEFINIÇÃO DE CABEÇALHOS PRE-TRADUZIDOS (PROMPT ENGINEERING)
// Isso evita alucinações da IA e garante que a UI exiba os títulos corretos.
const PROMPT_HEADERS = {
    pt: {
        projection: "O Horizonte (Praemeditatio)",
        insight: "O Diagnóstico Filosófico", 
        system_low: "O Protocolo de Ação (Algoritmo)",
        system_high: "O Desafio da Excelência",
        socratic: "A Questão Cortante",
        connection: "A Voz dos Antigos",
        action_low: "Ação Imediata",
        archetype: "Arquétipo"
    },
    en: {
        projection: "The Horizon (Praemeditatio)",
        insight: "Philosophical Diagnosis",
        system_low: "Action Protocol (Algorithm)",
        system_high: "The Challenge of Excellence",
        socratic: "The Cutting Question",
        connection: "Voice of the Ancients",
        action_low: "Immediate Action",
        archetype: "Archetype"
    },
    es: {
        projection: "El Horizonte (Praemeditatio)",
        insight: "Diagnóstico Filosófico",
        system_low: "Protocolo de Acción (Algoritmo)",
        system_high: "El Desafío de la Excelencia",
        socratic: "La Cuestión Cortante",
        connection: "La Voz de los Antiguos",
        action_low: "Acción Inmediata",
        archetype: "Arquetipo"
    }
};

const IMPLEMENTATION_TEMPLATES = {
    pt: "Quando [Gatilho], eu vou [Ação].",
    en: "When [Trigger], I will [Action].",
    es: "Cuando [Desencadenante], haré [Acción]."
};

const RECALIBRATION_TEMPLATES = {
    pt: "Eu ajusto minha meta de [Meta Antiga] para [Nova Meta] para garantir consistência.",
    en: "I adjust my goal from [Old Goal] to [New Goal] to ensure consistency.",
    es: "Ajusto mi objetivo de [Meta Antigua] a [Nueva Meta] para asegurar la consistencia."
};

// NEW [2025-02-15]: Calculates conditional probability of failure.
// "If TriggerHabit fails, how often does TargetHabit fail?"
function calculateCorrelation(
    triggerHabitId: string, 
    targetHabitId: string, 
    dailyData: Record<string, Record<string, any>>, 
    daysToCheck: string[]
): number {
    let triggerFailures = 0;
    let jointFailures = 0;

    for (const date of daysToCheck) {
        const triggerStatus = dailyData[date]?.[triggerHabitId]?.instances || {};
        // Check if trigger failed (assuming only 1 schedule for simplicity or ANY failure in day)
        // We look for Absence of 'completed' status in any slot of the day for the trigger
        const triggerDayFailed = !Object.values(triggerStatus).some((i: any) => i.status === 'completed');

        if (triggerDayFailed) {
            triggerFailures++;
            const targetStatus = dailyData[date]?.[targetHabitId]?.instances || {};
            const targetDayFailed = !Object.values(targetStatus).some((i: any) => i.status === 'completed');
            
            if (targetDayFailed) {
                jointFailures++;
            }
        }
    }

    return triggerFailures > 0 ? (jointFailures / triggerFailures) : 0;
}

export async function performAIAnalysis(analysisType: 'weekly' | 'monthly' | 'general') {
    closeModal(ui.aiOptionsModal);
    
    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    renderAINotificationState();

    const today = parseUTCIsoDate(getTodayUTCIso());
    let startDate: Date;
    let daysCount = 0;

    if (analysisType === 'weekly') {
        startDate = addDays(today, -7);
        daysCount = 7;
    } else if (analysisType === 'monthly') {
        startDate = addDays(today, -30);
        daysCount = 30;
    } else {
        startDate = addDays(today, -14); // General context
        daysCount = 14;
    }

    const langCode = state.activeLanguageCode || 'pt';
    const langMap: Record<string, string> = { 'pt': 'Portuguese', 'es': 'Spanish', 'en': 'English' };
    const targetLang = langMap[langCode];
    const headers = PROMPT_HEADERS[langCode as keyof typeof PROMPT_HEADERS] || PROMPT_HEADERS['pt'];
    
    // Default templates
    let implTemplate = IMPLEMENTATION_TEMPLATES[langCode as keyof typeof IMPLEMENTATION_TEMPLATES] || IMPLEMENTATION_TEMPLATES['en'];

    // Data Calculation structures
    const semanticLog: string[] = [];
    const dateList: string[] = []; // Track dates for correlation calc
    
    // Stats per Habit
    const statsMap = new Map<string, { 
        scheduled: number, 
        completed: number, 
        snoozed: number, 
        missed: number, // Explicitly track simple failures
        notesCount: number, 
        habit: Habit,
        extraMiles: number, 
        bounces: number,
        accumulatedValue: number, 
        valueCount: number 
    }>();
    
    // Stats per Time of Day (Chronobiology)
    const timeOfDayStats = {
        Morning: { scheduled: 0, completed: 0 },
        Afternoon: { scheduled: 0, completed: 0 },
        Evening: { scheduled: 0, completed: 0 }
    };

    // Trend Analysis
    const midPoint = Math.floor(daysCount / 2);
    const trendStats = {
        firstHalf: { scheduled: 0, completed: 0 },
        secondHalf: { scheduled: 0, completed: 0 }
    };

    // Contextual Variance
    const contextStats = {
        weekday: { scheduled: 0, completed: 0 },
        weekend: { scheduled: 0, completed: 0 }
    };

    // Bad Day Analysis
    const failedHabitsOnBadDays: Record<string, number> = {};
    const previousDayStatus: Record<string, string> = {}; 

    let totalLogs = 0;
    let totalNotes = 0;

    let currentDate = startDate;
    let dayIndex = 0;
    let redFlagDay = ""; // Specific day of collapse
    let sparklineHabitId: string | null = null;
    
    // OPTIMIZATION [2025-02-09]: Instantiate formatters outside loop
    const dayFormatter = new Intl.DateTimeFormat(state.activeLanguageCode, { weekday: 'short' });
    
    // [2025-02-14] New Metric: Active Habits Count for Burnout Detection
    const activeHabitsCount = state.habits.filter(h => !h.graduatedOn && !h.scheduleHistory[h.scheduleHistory.length-1].endDate).length;

    while (currentDate <= today) {
        const dateISO = toUTCIsoDateString(currentDate);
        dateList.push(dateISO);
        
        const activeHabits = getActiveHabitsForDate(dateISO);
        const dailyInfo = getHabitDailyInfoForDate(dateISO);
        
        let dayScheduled = 0;
        let dayCompleted = 0;
        let dayLog = ""; // Build string for semantic log
        
        // 0 = Sunday, 6 = Saturday
        const dayOfWeek = currentDate.getUTCDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        if (activeHabits.length > 0) {
            // Setup habit stats
            activeHabits.forEach(({ habit }) => {
                if (!statsMap.has(habit.id)) {
                    statsMap.set(habit.id, { 
                        scheduled: 0, completed: 0, snoozed: 0, missed: 0, notesCount: 0, 
                        habit, extraMiles: 0, bounces: 0,
                        accumulatedValue: 0, valueCount: 0
                    });
                }
            });

            const dayEntriesStrings: string[] = [];

            // Get aggregate status
            activeHabits.forEach(({ habit, schedule }) => {
                const stats = statsMap.get(habit.id)!;
                const { name } = getHabitDisplayInfo(habit, dateISO);

                schedule.forEach(time => {
                    const instance = dailyInfo[habit.id]?.instances?.[time];
                    const status = instance?.status || 'pending';
                    const hasNote = instance?.note && instance.note.trim().length > 0;
                    
                    // Update Habit Stats
                    totalLogs++;
                    stats.scheduled++;
                    dayScheduled++;
                    
                    if (isWeekend) contextStats.weekend.scheduled++;
                    else contextStats.weekday.scheduled++;

                    if (hasNote) {
                        totalNotes++;
                        stats.notesCount++;
                    }
                    
                    timeOfDayStats[time].scheduled++;

                    if (dayIndex < midPoint) {
                        trendStats.firstHalf.scheduled++;
                    } else {
                        trendStats.secondHalf.scheduled++;
                    }

                    const target = habit.goal.total || 0;
                    const actual = instance?.goalOverride ?? (status === 'completed' ? target : 0);
                    
                    if (status === 'completed' && actual > target && target > 0) {
                        stats.extraMiles++;
                    }
                    
                    if (actual > 0) {
                        stats.accumulatedValue += actual;
                        stats.valueCount++;
                    }

                    if (status === 'completed') {
                        stats.completed++;
                        dayCompleted++;
                        timeOfDayStats[time].completed++;
                        if (dayIndex < midPoint) trendStats.firstHalf.completed++;
                        else trendStats.secondHalf.completed++;
                        
                        if (isWeekend) contextStats.weekend.completed++;
                        else contextStats.weekday.completed++;

                        if (previousDayStatus[habit.id] && previousDayStatus[habit.id] !== 'completed') {
                            stats.bounces++;
                        }
                        previousDayStatus[habit.id] = 'completed';
                    }
                    else {
                        if (status === 'snoozed') stats.snoozed++;
                        else stats.missed++; // Track pure misses
                        
                        previousDayStatus[habit.id] = status; 
                    }

                    // SEMANTIC LOG BUILDING (Token efficient)
                    // Symbol mapping: Completed=✅, Snoozed=⏸️, Pending=❌
                    let symbol = '❌';
                    if (status === 'completed') symbol = '✅';
                    if (status === 'snoozed') symbol = '⏸️';
                    
                    let valStr = '';
                    if (actual > 0 && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
                        valStr = ` ${actual}/${target}`;
                    }
                    
                    let noteStr = '';
                    if (hasNote) {
                        noteStr = ` "${instance!.note}"`;
                    }
                    
                    dayEntriesStrings.push(`${name}(${symbol}${valStr}${noteStr})`);
                });
            });

            const dayName = dayFormatter.format(currentDate);
            dayLog = `${dateISO.substring(5)} (${dayName}): ${dayEntriesStrings.join(', ')}`;
            semanticLog.push(dayLog);

            // Bad Day Logic
            if (dayScheduled > 0) {
                const successRate = dayCompleted / dayScheduled;
                if (successRate < 0.5) {
                     redFlagDay = `${dayName} (${dateISO.substring(5)})`;
                }
                
                if (successRate < 0.5) {
                    activeHabits.forEach(({ habit, schedule }) => {
                        const daily = dailyInfo[habit.id]?.instances;
                        schedule.forEach(time => {
                            const s = daily?.[time]?.status || 'pending';
                            if (s !== 'completed' && s !== 'snoozed') {
                                 failedHabitsOnBadDays[getHabitDisplayInfo(habit, dateISO).name] = (failedHabitsOnBadDays[getHabitDisplayInfo(habit, dateISO).name] || 0) + 1;
                            }
                        });
                    });
                }
            }
        } else {
             const dayName = dayFormatter.format(currentDate);
             semanticLog.push(`${dateISO.substring(5)} (${dayName}): ▪️ (No habits scheduled)`);
        }
        currentDate = addDays(currentDate, 1);
        dayIndex++;
    }

    // Build Statistics
    let statsSummary = "";
    const mysteryHabits: string[] = []; 
    let totalExtraMiles = 0;
    let totalBounces = 0;
    
    let highestStreakHabitName = "";
    let highestStreakValue = 0;
    let nemesisName = "";
    let nemesisId = "";
    let highestSnoozeRate = -1;
    let highestMissRate = -1;
    let realityGapWarning = "";
    
    statsMap.forEach((data, id) => {
        const { name } = getHabitDisplayInfo(data.habit, toUTCIsoDateString(today));
        const rate = data.scheduled > 0 ? (data.completed / data.scheduled) : 0;
        const snoozeRate = data.scheduled > 0 ? (data.snoozed / data.scheduled) : 0;
        const missRate = data.scheduled > 0 ? (data.missed / data.scheduled) : 0;
        
        const streak = calculateHabitStreak(id, toUTCIsoDateString(today));
        const noteInfo = data.notesCount > 0 ? `${data.notesCount} notes` : "NO NOTES";
        
        totalExtraMiles += data.extraMiles;
        totalBounces += data.bounces;

        statsSummary += `- **${name}**: ${Math.round(rate * 100)}% Success. Streak: ${streak}. (Snoozed: ${Math.round(snoozeRate * 100)}%). Notes: ${noteInfo}\n`;

        if (rate < 0.6 && data.notesCount === 0) {
            mysteryHabits.push(name);
        }
        
        if (streak > highestStreakValue) {
            highestStreakValue = streak;
            highestStreakHabitName = name;
        }

        // Determine Nemesis: The one with high snoozes OR high misses
        // Prioritize Snoozes as "Resistance", Misses as "Neglect"
        if ((snoozeRate + missRate) > (highestSnoozeRate + highestMissRate) && data.scheduled > 3) { 
            highestSnoozeRate = snoozeRate;
            highestMissRate = missRate;
            nemesisName = name;
            nemesisId = id;
        }

        if (data.habit.goal.type === 'pages' || data.habit.goal.type === 'minutes') {
            const target = data.habit.goal.total || 0;
            if (target > 0 && data.valueCount > 0) {
                const avgActual = data.accumulatedValue / data.valueCount;
                if (avgActual < target * 0.7) { 
                    const suggested = Math.floor(avgActual);
                    realityGapWarning += `Habit '${name}': Target ${target}, Avg Actual ${Math.round(avgActual)}. -> SUGGESTION: Lower goal to ${suggested}.\n`;
                }
            }
        }
    });
    
    // --- ADVANCED ANALYSIS: CORRELATION & FRICTION ---
    let correlationInfo = "No clear dependencies found.";
    let frictionDiagnosis = "";

    if (nemesisId) {
        // 1. Friction Type Diagnosis
        // If > 20% Snooze: Resistance (Psychological). If > 20% Miss: Neglect (Logistical).
        if (highestSnoozeRate > 0.2) {
            frictionDiagnosis = `DIAGNOSIS: The user struggles with **Internal Resistance** (Fear/Procrastination) on '${nemesisName}'. They see the task but delay it (Snooze). ADVICE: Lower the emotional barrier. The goal is too scary.`;
        } else if (highestMissRate > 0.2) {
            frictionDiagnosis = `DIAGNOSIS: The user struggles with **Neglect/Visibility** on '${nemesisName}'. They forget or run out of time (Miss). ADVICE: Increase visibility or change the trigger time. The prompt is too weak.`;
        }

        // 2. Domino Effect Analysis
        // Check correlations between Nemesis failure and other habits
        let dominoEffectFound = false;
        statsMap.forEach((data, otherId) => {
            if (otherId !== nemesisId && data.scheduled > 3) {
                // Calculate P(Other Fails | Nemesis Fails)
                const correlation = calculateCorrelation(nemesisId, otherId, state.dailyData, dateList);
                if (correlation > 0.75) {
                    const { name: otherName } = getHabitDisplayInfo(data.habit, toUTCIsoDateString(today));
                    correlationInfo = `**CRITICAL CHAIN REACTION DETECTED:** When the user fails '${nemesisName}', there is a ${Math.round(correlation * 100)}% chance they will ALSO fail '${otherName}'. Fix '${nemesisName}' to save the day.`;
                    dominoEffectFound = true;
                }
            }
        });
        
        if (!dominoEffectFound) {
            correlationInfo = "Failures appear isolated. No strong domino effect detected.";
        }
    }

    if (!statsSummary) {
        statsSummary = "No active habits tracked yet.";
    }

    const nemesisInfo = nemesisName 
        ? `The Nemesis: **${nemesisName}**. ${frictionDiagnosis}` 
        : "No significant Nemesis.";

    // --- GLOBAL METRICS ---
    const totalScheduled = Object.values(trendStats.firstHalf).reduce((a, b) => a + b, 0) + Object.values(trendStats.secondHalf).reduce((a, b) => a + b, 0);
    const globalRate = totalScheduled > 0 ? ((trendStats.firstHalf.completed + trendStats.secondHalf.completed) / totalScheduled) * 100 : 0;
    
    // Trend
    const firstHalfRate = trendStats.firstHalf.scheduled > 0 ? (trendStats.firstHalf.completed / trendStats.firstHalf.scheduled) * 100 : 0;
    const secondHalfRate = trendStats.secondHalf.scheduled > 0 ? (trendStats.secondHalf.completed / trendStats.secondHalf.scheduled) * 100 : 0;
    const trendDiff = secondHalfRate - firstHalfRate;
    
    let trendDescription = "Stable";
    if (trendDiff > 5) trendDescription = "Significantly Improving";
    else if (trendDiff > 1) trendDescription = "Slightly Improving";
    else if (trendDiff < -5) trendDescription = "Crashing (Urgent)";
    else if (trendDiff < -1) trendDescription = "Declining";

    // Culprit (Consistently failing habit)
    const culpritInfo = nemesisName || "None";

    // Note Density
    const noteDensity = totalLogs > 0 ? Math.round((totalNotes / totalLogs) * 100) : 0;
    let dataQualityWarning = "";
    if (noteDensity < 5 && globalRate < 50) {
        dataQualityWarning = "WARNING: User is failing but writing almost NO notes. Blind spots are high.";
    }

    // --- TEMPORAL PATTERNS ---
    let temporalSummary = "";
    let lowestPerfTime: TimeOfDay = 'Morning';
    let lowestPerfRate = 1.0;

    Object.entries(timeOfDayStats).forEach(([time, data]) => {
        const rate = data.scheduled > 0 ? Math.round((data.completed / data.scheduled) * 100) : 0;
        if (data.scheduled > 0) {
            temporalSummary += `- **${time}**: ${rate}% Success Rate (${data.completed}/${data.scheduled})\n`;
            
            // Find struggling time
            if ((data.completed / data.scheduled) < lowestPerfRate) {
                lowestPerfRate = data.completed / data.scheduled;
                lowestPerfTime = time as TimeOfDay;
            }
        }
    });

    // --- DYNAMIC INSTRUCTION INJECTION (Prompt Engineering) ---
    // Instead of complex IF/ELSE inside the prompt text, we inject the specific instruction
    // based on the user's state (Winter vs Summer). This reduces token usage and cognitive load on the AI.
    let systemInstructionText = "Suggest a specific 'Implementation Intention' to reduce friction (Mise-en-place).";
    
    // REFINE [2025-02-09]: 'Gateway Habit' terminology for low performance
    // BEHAVIORAL UPDATE [2025-02-09]: Require Biological/Mechanical Anchors.
    // CRITICAL UPDATE [2025-02-12]: Moved TIMING RULE here to make it dynamic.
    let actionInstructionText = `One tiny, 'Gateway Habit' (less than 2 min). A physical movement that initiates the flow. Link it to a PRECISE BIOLOGICAL/MECHANICAL ANCHOR (e.g. 'Feet hit floor', 'Turn off shower', 'Close laptop') suitable for the user's struggle time (${lowestPerfTime}). Avoid time-based anchors (e.g. 'At 8am'). Time Horizon: NOW or TONIGHT. Never Tomorrow.`;
    
    // Determine dynamic Action Instruction based on Friction Diagnosis
    // RECOMMENDATION EXPERT LOGIC [2025-02-16]: Apply Fogg Behavior Model principles.
    // High Snooze = Low Motivation (Requires lowering the barrier/fun).
    // High Miss = Low Ability/Trigger (Requires simplification or better prompts).
    if (highestSnoozeRate > 0.2) {
        actionInstructionText += " **DIAGNOSIS: High Resistance (Snoozing).** The user has Ability but lacks Motivation/Courage. The Action must be 'Stupidly Small' to bypass the amygdala (e.g., 'Put on one shoe'). Lower the threat level.";
    } else if (highestMissRate > 0.2) {
        actionInstructionText += " **DIAGNOSIS: Low Visibility (Missing).** The user lacks a Prompt or Ability (Time). The Action must be a 'Forced Encounter' (e.g., placing the book on the pillow). Improve the Trigger.";
    }

    let socraticInstruction = "Ask about FRICTION (What stands in the way? Is it fatigue or fear?).";
    
    // DEEPENING ANALYSIS [2025-02-15]: Benefit Reinforcement Logic.
    // If a Nemesis exists, we must explain WHY overcoming it matters.
    // REFACTOR [2025-02-16]: Removed dependency on 'archetype'.
    let teleologyInstruction = "";
    if (nemesisName) {
        teleologyInstruction = `**CRITICAL:** The user is struggling with '${nemesisName}'. In the 'Hidden Virtue' section, do NOT scold. Instead, SELL THE BENEFIT. Explain the deep, philosophical, or psychological reward of '${nemesisName}' that the user is missing out on. Frame it as the specific antidote to their current struggle. e.g., If drifting, the benefit is Anchoring. If anxious, the benefit is Clarity.`;
    } else {
        teleologyInstruction = `The user is consistent. In the 'Hidden Virtue' section, reinforce the COMPOUND INTEREST of their 'Keystone Habit' (${highestStreakHabitName || 'consistency'}). Explain what character trait they are forging by not quitting.`;
    }

    // DEEPENING ANALYSIS [2025-02-15]: "Domino Effect" Detection.
    // Instead of just identifying a turning point, ask the AI to look for causal links between Morning failures and Evening collapses.
    let patternInstruction = `Use the Semantic Log. ${correlationInfo} Scan for other subtle links. Does a specific success trigger a streak?`;

    let tweaksExamples = `
    Examples of System Tweaks (Low Friction):
    - Bad: "Read more." -> Good: "When I drink coffee, I will open the book."
    - Bad: "Workout." -> Good: "When I wake up, I will put on gym shoes."
    `;

    let headerSystem = headers.system_low;
    let headerAction = headers.action_low;
    
    let insightPlaceholder = "[A surgical analysis of the current state. Don't just list data; interpret the CAUSE of the friction or the SOURCE of the flow. Use Stoic physics: Cause and Effect.]";
    let actionPlaceholder = "[One tiny 'Gateway Habit' step (< 2 min). Focus on MISE-EN-PLACE (Preparation) linked to an ANCHOR.]";


    // FOCUS LOGIC & SPARKLINE GENERATION
    let focusTarget = "Consistency"; // Default
    let seasonalPhase = "";
    
    if (globalRate > 85 && trendDiff >= -2) seasonalPhase = "SUMMER (Harvest/Flow) - High performance.";
    else if (globalRate < 50) seasonalPhase = "WINTER (The Citadel) - Low performance, focus on resilience.";
    else if (trendDiff > 5) seasonalPhase = "SPRING (Ascent) - Growing momentum.";
    else seasonalPhase = "AUTUMN (Turbulence) - Declining momentum.";

    // REFACTOR [2025-02-16]: Projection is no longer hardcoded text.
    // We pass raw metrics to the AI and let it derive the trajectory based on Stoic Physics (Cause & Effect).
    // This allows for nuanced predictions (e.g., "High stats but declining trend" = Hubris).
    
    let historicalDepth = "Short (New)";
    if (highestStreakValue > 66) historicalDepth = "Deep (Consolidated)";
    else if (highestStreakValue > 21) historicalDepth = "Medium (Forming)";

    const projectionMetrics = `
    - Current Consistency: ${Math.round(globalRate)}%
    - Momentum (Last 7 Days vs Previous): ${trendDiff > 0 ? '+' : ''}${Math.round(trendDiff)}%
    - History Depth: ${historicalDepth}
    - Streak Risk: ${highestStreakValue > 10 ? "High Stakes" : "Low Stakes"}
    `;

    // REMOVED: ARCHETYPE CALCULATION
    
    // --- SMART QUOTE SELECTION (Contextual Filtering by TAGS) ---
    let quoteFilterFn = (q: any) => true; // Default to all
    let quoteReason = "General Wisdom"; 

    // NEW [2025-02-14]: Burnout / Overwhelm Detection
    const isBurnout = activeHabitsCount > 6 && trendDiff < 0;
    
    // NEW [2025-02-14]: Drifter / Lack of Focus Detection
    const isDrifter = globalRate < 50 && trendDiff <= 0;

    if (isBurnout) {
        // PROBLEM: Doing too much, crashing.
        // TAGS: Simplicity, Essentialism, Rest
        quoteFilterFn = (q) => q.tags.includes('simplicity') || q.tags.includes('essentialism') || q.tags.includes('rest');
        quoteReason = "burnout prevention (doing less, better)";
        focusTarget = "Essentialism (Cut the Noise)";
        systemInstructionText = "Suggest REMOVING a habit or reducing intensity. Focus on 'Via Negativa'.";
        headerSystem = "The Art of Subtraction";
        insightPlaceholder = "[Validate the effort but warn about the cost of overextension. Suggest strategic rest.]";
    } else if (isDrifter) {
        // PROBLEM: Low consistency, no improvement.
        // TAGS: Discipline, Action, Duty
        quoteFilterFn = (q) => q.tags.includes('discipline') || q.tags.includes('duty') || q.tags.includes('action');
        quoteReason = "instilling discipline and duty";
        focusTarget = "Discipline (The Anchor)";
        insightPlaceholder = "[A wake-up call. Gentle but firm. Point out the drift and the cost of inaction.]";
    } else if (redFlagDay) {
        // PROBLEM: Specific Day Collapse
        // TAGS: Acceptance, Fate
        quoteFilterFn = (q) => q.tags.includes('acceptance') || q.tags.includes('fate');
        quoteReason = "accepting the chaos of a bad day (Amor Fati)";
    } else if (totalLogs < 20) {
        // PROBLEM: Fear of starting
        // TAGS: Courage, Preparation
        quoteFilterFn = (q) => q.tags.includes('courage') || q.tags.includes('preparation');
        quoteReason = "finding the courage to begin";
    }

    const quotePool = STOIC_QUOTES.filter(quoteFilterFn);
    // Fallback if pool is empty
    const finalPool = quotePool.length > 0 ? quotePool : STOIC_QUOTES;
    
    // Deterministic Randomness based on Date to avoid jitter on re-runs same day?
    // No, randomness is fine for "refreshing" wisdom.
    const quoteIdx = Math.floor(Math.random() * finalPool.length);
    const quote = finalPool[quoteIdx];
    
    // LANGUAGE SAFEGUARD: Ensure quote exists in target language
    const quoteText = quote[state.activeLanguageCode as 'en'|'pt'|'es'] || quote['en'];
    const quoteAuthor = t(quote.author);

    // Generate Sparkline (Mini-graph) using Semantic Log
    // We can rebuild it from the semantic log array we created.
    // Visual: ▂▄▆█
    // Simple Text:  __..Il
    const logContent = semanticLog.join('\n');
    let sparkline = "";
    if (semanticLog.length > 0) {
        sparkline = semanticLog.map(line => {
            if (line.includes("✅")) return "I"; // Success
            if (line.includes("⏸️")) return "."; // Snooze
            return "_"; // Fail
        }).join("");
    }

    let taskDescription = "Analyze the user's habit log and provide Stoic guidance.";

    // --- COLD START / ONBOARDING MODE ---
    // Detects new users with very little data to prevent hallucinated pattern recognition.
    if (totalLogs < 5) {
        seasonalPhase = "THE BEGINNING (Day 1)";
        focusTarget = "Building the Foundation (Start Small)";
        systemInstructionText = "Suggest a very small, almost ridiculous starting step to build momentum.";
        socraticInstruction = "Ask what is the smallest version of this habit they can do even on their worst day.";
        patternInstruction = "Do NOT look for trends yet. Validate the courage of the first step.";
        insightPlaceholder = "[Welcome them to the Stoic path. Validate the difficulty of starting. Focus on the courage to begin.]";
        taskDescription = "Write a welcoming and foundational Stoic mentorship letter for a beginner.";
        sparkline = ""; // No sparkline for beginners
    } else if (globalRate > 80 || seasonalPhase.includes("SUMMER")) {
        // --- HIGH PERFORMANCE MODE ---
        focusTarget = "Excellence (Arete)";
        systemInstructionText = "Suggest a 'Level Up' challenge. How to increase intensity or quality?";
        headerSystem = headers.system_high;
        insightPlaceholder = "[Acknowledge the flow state. Warn against hubris (Pride). Challenge them to maintain this standard.]";
    }

    // LANGUAGE SPECIFIC FORBIDDEN WORDS
    const forbiddenWhyMap = {
        pt: '"Por que"',
        en: '"Why"',
        es: '"Por qué"'
    };
    const forbiddenWhy = forbiddenWhyMap[langCode as 'pt'|'en'|'es'] || '"Why"';
    
    // CURRENT DATE FOR CONTEXT
    const currentDateStr = toUTCIsoDateString(today);


    const prompt = `
        ### THE COMPASS (Primary Focus):
        PRIMARY FOCUS: ${focusTarget}
        PATTERN: ${sparkline}
        REFERENCE DATE (TODAY): ${currentDateStr}
        (The Title, Insight, and System Tweak MUST revolve around this focus.)

        ### 1. THE CONTEXT (Data)
        - **Stats:** \n${statsSummary}
        - **Gaps:** Note Density: ${noteDensity}%. ${dataQualityWarning}
        - **Trend:** Momentum: ${trendDescription}. Keystone Failure: ${culpritInfo}
        - **Friction Diagnosis:** ${nemesisInfo}
        - **Chain Reaction (Domino):** ${correlationInfo}
        - **Red Flag Day (Collapse):** ${redFlagDay || "None"}
        - **Struggling Time:** ${lowestPerfTime}

        ### 2. THE STRATEGY
        - **Bio-rhythm:** \n${temporalSummary}
        - **Reality Check (Math Calculated):** \n${realityGapWarning || "Goals are realistic."}
        - **Metrics:** Extra Miles: ${totalExtraMiles}. Bounce Backs: ${totalBounces}.

        ### 3. THE PHILOSOPHY
        - **Season:** ${seasonalPhase}
        - **Trajectory Metrics:** \n${projectionMetrics}
        - **Selected Wisdom:** "${quoteText}" - ${quoteAuthor}
        - **Wisdom Intent:** Chosen to address: ${quoteReason}

        ### SEMANTIC LOG (The User's Week):
        (Legend: ✅=Success, ❌=Pending/Fail, ⏸️=Snoozed, "Text"=User Note. Ordered by time of day.)
        ${logContent}

        INSTRUCTIONS:
        1. **BENEVOLENT DETACHMENT:** Do NOT praise ("Good job") or scold ("Do better"). Be an observant mirror. Firm but warm. Do NOT write "Based on the data". Speak naturally, like a mentor writing a letter. Use PARAGRAPHS, NOT LISTS for text sections. NO GREETINGS. NO SIGNATURES. Start directly with the Title.
        2. **BE SOCRATIC:** ${socraticInstruction}
           - **CONSTRAINT:** One single, piercing sentence. DO NOT use the word ${forbiddenWhy} (or its translations). AVOID YES/NO questions (e.g. "Are you commited?"). Force deep processing.
        3. **PATTERN RECOGNITION:** ${patternInstruction}
        4. **THE TELEOLOGY (THE REWARD):** ${teleologyInstruction}
        5. **THE PROTOCOL (SYSTEM):** 
           - ${systemInstructionText}
           - **SYNTAX:** Use EXACTLY this template: "${implTemplate}" (REMOVE BRACKETS when filling). (Output ONLY the sentence, no intro/outro)
           - **FOCUS:** Focus on the PRIMARY FOCUS defined above. ZERO COST.
           - **CONSTRAINT:** ACTION must be a single, binary event (e.g. 'open book', 'put on shoes'). Forbidden verbs: try, attempt, focus, aim, should.
        6. **CONNECT WISDOM:** Use the provided quote ("${quoteText}"). Do NOT explain the quote itself. Use the quote's concept to illuminate the user's specific struggle/victory.
        7. **INTERPRET LOG:** 
           - ✅ = Success.
           - ⏸️ = **Resistance** (User saw it but delayed). REMEDY: Lower the bar. 
           - **NOTE HANDLING:** If a "Note" is present with ⏸️ or ❌, analyze the sentiment. If it's Internal (Lazy, Bored), treat as Resistance (Action required). If it's External (Sick, Emergency), treat as Amor Fati (Acceptance).
           - ❌ = **Neglect** (User forgot). REMEDY: Increase Visibility / Better Trigger.
           - ▪️ = **Rest/No Schedule** (Not a failure).
           - **NUMBERS (e.g. 5/10):** Partial Success. If Actual < Target, acknowledge effort but note the gap.
        8. **THE TRIGGER (PHYSICS):** ${actionInstructionText}

        OUTPUT STRUCTURE (Markdown in ${targetLang}):

        ### 🏛️ [Title: Format "On [Concept]" or Abstract Noun. NO CHEESY TITLES.]

        **🔮 ${headers.projection}**
        [Analyze the 'Trajectory Metrics'. Don't just predict a date. Extrapolate the current curve: Is it leading to Entropy (Chaos) or Ataraxia (Order)? Be brutally honest but encouraging.]

        **📊 ${headers.insight}**
        ${insightPlaceholder}

        **💎 [Title about the Virtue/Benefit of the Struggle]**
        [The 'Teleology' section. Explain the deep benefit of the struggling habit. Why is this specific pain necessary for the user's growth right now?]

        **⚙️ ${headerSystem}**
        [The Implementation Intention using the template: "${implTemplate}". Zero cost. The Rule. REMOVE BRACKETS.]

        **❓ ${headers.socratic}**
        [One deep, single-sentence question.]

        **🏛️ ${headers.connection}**
        [Quote provided above]
        [Connect the wisdom to the data.]

        **🎯 ${headerAction}**
        ${actionPlaceholder}
    `;

    try {
        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({
                prompt,
                systemInstruction: `You are Askesis AI, a wise Stoic companion. ${taskDescription}. You write "Stoic Letters" - dense, profound, and direct blocks of wisdom.
                
                STYLE: Epistolary (Letter-like), concise, grave but kind. Benevolent Detachment.
                FORBIDDEN: "Based on the data", "Here is the analysis", "According to the stats", "Why", "Amor Fati", "Mise-en-place". (Apply the concepts, do not name them).
                STRUCTURE: Do NOT use greetings ("Hello", "Dear User") or sign-offs ("Best regards"). Start directly with the Title.
                GOLDEN RULE: Never advise "trying harder" or "being more disciplined". Advise "changing the method" or "altering the environment".
                
                FOCUS:
                1. Identity (Who they are becoming).
                2. Environment (How to change the room, not the will).
                3. The Why (Deep understanding of patterns).
                4. Amor Fati (Accept failure as data, not sin).
                
                ${tweaksExamples}

                FORBIDDEN VERBS (Action): try, attempt, focus, aim, should, must, will try.
                REQUIRED VERBS: open, put, write, step, walk, turn off.
                TIME HORIZON: Actions must be doable NOW or TONIGHT. Never "Tomorrow".
                `
            })
        });

        if (!response.ok) throw new Error('AI request failed');

        const text = await response.text();
        state.lastAIResult = text;
        state.aiState = 'completed';
        
        // REFACTOR [2025-02-16]: Do not open modal automatically.
        // Instead, mark as unseen and update the UI (notification dot).
        state.hasSeenAIResult = false;
        
        // Removed: ui.aiResponse.innerHTML = simpleMarkdownToHTML(text);
        // Removed: openModal(ui.aiModal);

    } catch (error) {
        console.error("AI Analysis failed", error);
        state.aiState = 'error';
        state.lastAIResult = t('aiErrorGeneric');
        state.lastAIError = error instanceof Error ? error.message : String(error);
        state.hasSeenAIResult = false; // Even error should notify
    } finally {
        renderAINotificationState();
        saveState();
    }
}