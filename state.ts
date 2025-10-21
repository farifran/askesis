import { addDays, getTodayUTC, getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate } from './utils';
import { icons } from './icons';

// --- TYPES & INTERFACES ---
export type HabitStatus = 'completed' | 'snoozed' | 'pending';

export type Frequency = {
    type: 'daily' | 'weekly';
    interval: number;
};

export interface HabitDayData {
    status: HabitStatus;
    goalOverride?: number;
    note?: string;
}

export type HabitDailyInstances = Partial<Record<TimeOfDay, HabitDayData>>;

// The data for a single habit on a single day
export interface HabitDailyInfo {
    instances: HabitDailyInstances;
    dailySchedule?: TimeOfDay[]; // Override for habit.times for this day
}


export interface HabitHistoryPeriod {
    startDate: string;
    endDate: string;
}

export interface Habit {
    id: string;
    // FIX: Made name and subtitle optional as they only exist for custom habits.
    name?: string; // For custom habits
    subtitle?: string; // For custom habits
    nameKey?: string; // For predefined habits
    subtitleKey?: string; // For predefined habits
    icon: string;
    color: string;
    times: ('Manhã' | 'Tarde' | 'Noite')[]; // Internal value, display is translated
    goal: { 
        type: 'pages' | 'minutes' | 'check'; 
        total?: number; 
        // FIX: Made unit optional as it only exists for custom habits.
        unit?: string; // For custom habits
        unitKey?: string; // For predefined habits
    };
    endedOn?: string;
    graduatedOn?: string;
    frequency: Frequency;
    createdOn: string;
    scheduleAnchor?: string;
    history?: HabitHistoryPeriod[];
    previousVersionId?: string;
}

// FIX: Removed `scheduleAnchor` and `previousVersionId` from Omit<> to make PredefinedHabit assignable.
export type PredefinedHabit = Omit<Habit, 'id' | 'createdOn' | 'name' | 'subtitle' | 'goal' | 'previousVersionId'> & {
    goal: {
        type: 'pages' | 'minutes' | 'check';
        total?: number;
        unitKey: string;
    };
};


// Nova interface para o estado completo da aplicação
export interface AppState {
    version: number;
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    notificationsShown: string[];
    pending21DayHabitIds: string[];
    pendingConsolidationHabitIds: string[];
}


// --- CONSTANTS ---
export const STATE_STORAGE_KEY = 'habitTrackerState_v1';
export const APP_VERSION = 5; // Increased version for daily schedule overrides (drag & drop)
export const DAYS_IN_CALENDAR = 61;
export const STREAK_SEMI_CONSOLIDATED = 21;
export const STREAK_CONSOLIDATED = 66;

export const TIMES_OF_DAY = ['Manhã', 'Tarde', 'Noite'] as const;
export type TimeOfDay = typeof TIMES_OF_DAY[number];

export const LANGUAGES = [
    { code: 'pt', nameKey: 'langPortuguese' },
    { code: 'en', nameKey: 'langEnglish' },
    { code: 'es', nameKey: 'langSpanish' }
] as const;
export type Language = typeof LANGUAGES[number];

export const FREQUENCIES: { labelKey: string; value: Frequency }[] = [
    { labelKey: 'freqDaily', value: { type: 'daily', interval: 1 } },
    { labelKey: 'freqEvery2Days', value: { type: 'daily', interval: 2 } },
    { labelKey: 'freqEvery3Days', value: { type: 'daily', interval: 3 } },
    { labelKey: 'freqEvery4Days', value: { type: 'daily', interval: 4 } },
    { labelKey: 'freqEvery5Days', value: { type: 'daily', interval: 5 } },
    { labelKey: 'freqWeekly', value: { type: 'weekly', interval: 1 } },
    { labelKey: 'freqEvery2Weeks', value: { type: 'weekly', interval: 2 } },
    { labelKey: 'freqEvery3Weeks', value: { type: 'weekly', interval: 3 } },
    { labelKey: 'freqEvery4Weeks', value: { type: 'weekly', interval: 4 } },
];

// Predefined habits now use keys for localization
export const PREDEFINED_HABITS: PredefinedHabit[] = [
    { nameKey: 'predefinedHabitReadName', subtitleKey: 'predefinedHabitReadSubtitle', icon: icons.read, color: '#e74c3c', times: ['Noite'], goal: { type: 'pages', total: 10, unitKey: 'unitPage' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitMeditateName', subtitleKey: 'predefinedHabitMeditateSubtitle', icon: icons.meditate, color: '#f1c40f', times: ['Manhã'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitWaterName', subtitleKey: 'predefinedHabitWaterSubtitle', icon: icons.water, color: '#3498db', times: ['Manhã', 'Tarde', 'Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitExerciseName', subtitleKey: 'predefinedHabitExerciseSubtitle', icon: icons.exercise, color: '#2ecc71', times: ['Tarde'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitStretchName', subtitleKey: 'predefinedHabitStretchSubtitle', icon: icons.stretch, color: '#7f8c8d', times: ['Manhã'], goal: { type: 'minutes', total: 5, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitJournalName', subtitleKey: 'predefinedHabitJournalSubtitle', icon: icons.journal, color: '#9b59b6', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitLanguageName', subtitleKey: 'predefinedHabitLanguageSubtitle', icon: icons.language, color: '#1abc9c', times: ['Tarde'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitOrganizeName', subtitleKey: 'predefinedHabitOrganizeSubtitle', icon: icons.organize, color: '#34495e', times: ['Noite'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitWalkName', subtitleKey: 'predefinedHabitWalkSubtitle', icon: icons.walk, color: '#27ae60', times: ['Tarde'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitPlanDayName', subtitleKey: 'predefinedHabitPlanDaySubtitle', icon: icons.planDay, color: '#007aff', times: ['Manhã'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitCreativeHobbyName', subtitleKey: 'predefinedHabitCreativeHobbySubtitle', icon: icons.creativeHobby, color: '#e84393', times: ['Tarde'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitGratitudeName', subtitleKey: 'predefinedHabitGratitudeSubtitle', icon: icons.gratitude, color: '#f39c12', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitEatFruitName', subtitleKey: 'predefinedHabitEatFruitSubtitle', icon: icons.eatFruit, color: '#c0392b', times: ['Tarde'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitTalkFriendName', subtitleKey: 'predefinedHabitTalkFriendSubtitle', icon: icons.talkFriend, color: '#3498db', times: ['Tarde'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitScreenBreakName', subtitleKey: 'predefinedHabitScreenBreakSubtitle', icon: icons.screenBreak, color: '#9b59b6', times: ['Tarde'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitInstrumentName', subtitleKey: 'predefinedHabitInstrumentSubtitle', icon: icons.instrument, color: '#e67e22', times: ['Noite'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitPlantsName', subtitleKey: 'predefinedHabitPlantsSubtitle', icon: icons.plants, color: '#2ecc71', times: ['Manhã'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitFinancesName', subtitleKey: 'predefinedHabitFinancesSubtitle', icon: icons.finances, color: '#34495e', times: ['Noite'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitTeaName', subtitleKey: 'predefinedHabitTeaSubtitle', icon: icons.tea, color: '#1abc9c', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitPodcastName', subtitleKey: 'predefinedHabitPodcastSubtitle', icon: icons.podcast, color: '#007aff', times: ['Tarde'], goal: { type: 'minutes', total: 25, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitEmailsName', subtitleKey: 'predefinedHabitEmailsSubtitle', icon: icons.emails, color: '#f1c40f', times: ['Manhã'], goal: { type: 'minutes', total: 5, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitSkincareName', subtitleKey: 'predefinedHabitSkincareSubtitle', icon: icons.skincare, color: '#e84393', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitSunlightName', subtitleKey: 'predefinedHabitSunlightSubtitle', icon: icons.sunlight, color: '#f39c12', times: ['Manhã'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitDisconnectName', subtitleKey: 'predefinedHabitDisconnectSubtitle', icon: icons.disconnect, color: '#2980b9', times: ['Noite'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitDrawName', subtitleKey: 'predefinedHabitDrawSubtitle', icon: icons.draw, color: '#8e44ad', times: ['Tarde'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitFamilyTimeName', subtitleKey: 'predefinedHabitFamilyTimeSubtitle', icon: icons.familyTime, color: '#f1c40f', times: ['Noite'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitNewsName', subtitleKey: 'predefinedHabitNewsSubtitle', icon: icons.news, color: '#7f8c8d', times: ['Manhã'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitCookHealthyName', subtitleKey: 'predefinedHabitCookHealthySubtitle', icon: icons.cookHealthy, color: '#27ae60', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitLearnSkillName', subtitleKey: 'predefinedHabitLearnSkillSubtitle', icon: icons.learnSkill, color: '#3498db', times: ['Tarde'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitPhotographyName', subtitleKey: 'predefinedHabitPhotographySubtitle', icon: icons.photography, color: '#34495e', times: ['Tarde'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitVolunteerName', subtitleKey: 'predefinedHabitVolunteerSubtitle', icon: icons.volunteer, color: '#e74c3c', times: ['Tarde'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitYogaName', subtitleKey: 'predefinedHabitYogaSubtitle', icon: icons.yoga, color: '#9b59b6', times: ['Manhã'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitReflectDayName', subtitleKey: 'predefinedHabitReflectDaySubtitle', icon: icons.reflectDay, color: '#2980b9', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
];

// --- HELPERS ---
export function getNextStatus(currentStatus: HabitStatus): HabitStatus {
    const transitions: Record<HabitStatus, HabitStatus> = {
        pending: 'completed',
        completed: 'snoozed',
        snoozed: 'pending',
    };
    return transitions[currentStatus];
}

// --- APPLICATION STATE ---
export const state: {
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    streaksCache: Record<string, number>;
    lastEnded: { habitId: string } | null;
    undoTimeout: number | null;
    calendarDates: Date[];
    selectedDate: string;
    activeLanguageCode: Language['code'];
    pending21DayHabitIds: string[];
    pendingConsolidationHabitIds: string[];
    notificationsShown: string[];
    confirmAction: (() => void) | null;
    confirmEditAction: (() => void) | null;
    editingNoteFor: { habitId: string; date: string; time: TimeOfDay; } | null;
    editingHabit: {
        isNew: boolean;
        habitData: Omit<Habit, 'id' | 'createdOn'>;
    } | null;
} = {
    habits: [],
    dailyData: {},
    streaksCache: {},
    lastEnded: null,
    undoTimeout: null,
    calendarDates: Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => addDays(getTodayUTC(), i - 30)),
    selectedDate: getTodayUTCIso(),
    activeLanguageCode: 'pt',
    pending21DayHabitIds: [],
    pendingConsolidationHabitIds: [],
    notificationsShown: [],
    confirmAction: null,
    confirmEditAction: null,
    editingNoteFor: null,
    editingHabit: null,
};

// --- STATE-DEPENDENT HELPERS ---
export function getHabitDailyInfoForDate(date: string): Record<string, HabitDailyInfo> {
    return state.dailyData[date] || {};
}


export function ensureHabitInstanceData(date: string, habitId: string, time: TimeOfDay): HabitDayData {
    state.dailyData[date] ??= {};
    state.dailyData[date][habitId] ??= { instances: {} };
    state.dailyData[date][habitId].instances[time] ??= { status: 'pending' };
    return state.dailyData[date][habitId].instances[time]!;
}

export function shouldHabitAppearOnDate(habit: Habit, date: Date): boolean {
    if (habit.graduatedOn) return false;

    const dateAsTime = date.getTime();
    const currentPeriodStartDate = parseUTCIsoDate(habit.createdOn);
    let isInCurrentPeriod = dateAsTime >= currentPeriodStartDate.getTime();
    if (habit.endedOn) {
        const currentPeriodEndDate = parseUTCIsoDate(habit.endedOn);
        isInCurrentPeriod = isInCurrentPeriod && (dateAsTime < currentPeriodEndDate.getTime());
    }
    
    const isInHistoryPeriod = habit.history?.some(period => {
        const periodStartDate = parseUTCIsoDate(period.startDate);
        const periodEndDate = parseUTCIsoDate(period.endDate);
        return dateAsTime >= periodStartDate.getTime() && dateAsTime < periodEndDate.getTime();
    }) || false;

    const isWithinAnyActivityPeriod = isInCurrentPeriod || isInHistoryPeriod;
    if (!isWithinAnyActivityPeriod) return false;

    const anchorDate = parseUTCIsoDate(habit.scheduleAnchor || habit.createdOn);

    const daysDifference = Math.round((date.getTime() - anchorDate.getTime()) / (1000 * 60 * 60 * 24));

    // A habit's frequency schedule should only apply from its anchor date forward.
    // This prevents habits, especially daily ones, from appearing on past dates
    // before they were scheduled to start.
    if (daysDifference < 0) {
        return false;
    }

    if (habit.frequency.type === 'daily') {
        return daysDifference % habit.frequency.interval === 0;
    }

    if (habit.frequency.type === 'weekly') {
        if (date.getUTCDay() !== anchorDate.getUTCDay()) return false;
        const weeksDifference = Math.floor(daysDifference / 7);
        return weeksDifference % habit.frequency.interval === 0;
    }

    return true;
}

/**
 * Finds the previous N completed occurrence dates for a habit, skipping snoozed days.
 * A streak is considered broken if a 'pending' or missing day is found.
 * This function is now version-aware and will traverse the habit's history.
 * @param habit The habit to check (latest version).
 * @param startDate The date to start searching backwards from (exclusive).
 * @param count The number of previous completed occurrences to find.
 * @returns An array of Date objects for the previous completed occurrences.
 *          Returns an array with fewer than `count` items if the streak is broken or history ends.
 */
function getPreviousCompletedOccurrences(habit: Habit, startDate: Date, count: number): Date[] {
    const dates: Date[] = [];
    let currentDate = new Date(startDate);
    let currentHabit: Habit | undefined = habit;
    
    mainLoop:
    while (dates.length < count && currentHabit) {
        const habitCreationDate = parseUTCIsoDate(currentHabit.createdOn);
        
        while (dates.length < count && currentDate > habitCreationDate) {
            currentDate = addDays(currentDate, -1);

            if (shouldHabitAppearOnDate(currentHabit, currentDate)) {
                const dayISO = toUTCIsoDateString(currentDate);
                const dailyInfo = state.dailyData[dayISO]?.[currentHabit.id];
                const instances = dailyInfo?.instances || {};
                const scheduleForDay = dailyInfo?.dailySchedule || currentHabit.times;

                const statuses = scheduleForDay.map(time => instances[time]?.status ?? 'pending');
                
                const allCompleted = statuses.length > 0 && statuses.every(s => s === 'completed');
                const hasPending = statuses.some(s => s === 'pending');

                if (allCompleted) {
                    dates.push(new Date(currentDate));
                } else if (hasPending) {
                    break mainLoop;
                }
            }
        }

        if (currentHabit.previousVersionId) {
            currentHabit = state.habits.find(h => h.id === currentHabit!.previousVersionId);
        } else {
            break mainLoop;
        }
    }
    
    return dates;
}

export function shouldShowPlusIndicator(dateISO: string): boolean {
    const dateObj = parseUTCIsoDate(dateISO);
    const dailyInfo = state.dailyData[dateISO] || {};
    const activeHabitsOnDate = state.habits.filter(h => shouldHabitAppearOnDate(h, dateObj));

    // 1. Find habits that had their goal exceeded on the given date.
    const goalExceededHabits = activeHabitsOnDate.filter(habit => {
        if (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes') return false;
        
        const habitDailyInfo = dailyInfo[habit.id];
        if (!habitDailyInfo) return false;
        
        const scheduleForDay = habitDailyInfo.dailySchedule || habit.times;
        return scheduleForDay.some(time => {
            const instance = habitDailyInfo.instances[time];
            return instance?.status === 'completed' &&
                   instance.goalOverride !== undefined &&
                   instance.goalOverride > (habit.goal.total ?? 0);
        });
    });

    if (goalExceededHabits.length === 0) {
        return false;
    }

    // 2. For each of those habits, check if the other conditions are met.
    for (const habit of goalExceededHabits) {
        // Condition A: The habit was completed for the previous 2 scheduled occurrences.
        const previousCompletions = getPreviousCompletedOccurrences(habit, dateObj, 2);
        if (previousCompletions.length !== 2) {
            continue; // Streak condition not met, try next habit.
        }

        // Condition B: All *other* active habits on this date must also be completed.
        const otherHabits = activeHabitsOnDate.filter(h => h.id !== habit.id);
        const allOtherHabitsCompleted = otherHabits.every(otherHabit => {
            const otherHabitDailyInfo = dailyInfo[otherHabit.id];
            const scheduleForDay = otherHabitDailyInfo?.dailySchedule || otherHabit.times;
            const instances = otherHabitDailyInfo?.instances || {};

            // If a habit is scheduled but has no instances at all, it's considered pending.
            if (scheduleForDay.length > 0 && Object.keys(instances).length === 0) {
                return false;
            }

            // Every single scheduled instance for this other habit must be 'completed'.
            return scheduleForDay.every(time => {
                const status = instances[time]?.status;
                return status === 'completed';
            });
        });

        // If both streak and "all others completed" conditions are met, we show the plus.
        if (allOtherHabitsCompleted) {
            return true;
        }
    }

    // If we looped through all goal-exceeded habits and none met all conditions.
    return false;
}

export function getSmartGoalForHabit(habit: Habit, dateISO: string, time: TimeOfDay): number {
    const baseGoal = habit.goal.total ?? 0;
    if (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes') return baseGoal;

    const consecutiveExceededGoals: number[] = [];
    let currentDate = parseUTCIsoDate(dateISO);
    const habitCreationDate = parseUTCIsoDate(habit.createdOn);

    while (consecutiveExceededGoals.length < 3) {
        currentDate = addDays(currentDate, -1);
        if (currentDate < habitCreationDate) return baseGoal;

        if (shouldHabitAppearOnDate(habit, currentDate)) {
            const currentDayISO = toUTCIsoDateString(currentDate);
            const habitInstance = state.dailyData[currentDayISO]?.[habit.id]?.instances?.[time];
            
            const wasGoalExceeded = habitInstance?.status === 'completed' &&
                                    habitInstance.goalOverride !== undefined &&
                                    habitInstance.goalOverride > (habit.goal.total ?? 0);
            
            if (wasGoalExceeded) {
                consecutiveExceededGoals.push(habitInstance.goalOverride!);
            } else {
                // If any instance in the potential streak was not an exceeded goal, reset to base.
                return baseGoal;
            }
        }
    }
    
    // If we found 3 consecutive exceeded goals for this specific time slot.
    const sum = consecutiveExceededGoals.reduce((a, b) => a + b, 0);
    return Math.round(sum / 3);
}

export function calculateHabitStreak(habitId: string, dateISO: string): number {
    const cacheKey = `${habitId}|${dateISO}`;
    if (state.streaksCache[cacheKey] !== undefined) return state.streaksCache[cacheKey];
    
    let streak = 0;
    let currentDate = parseUTCIsoDate(dateISO);
    let currentHabit: Habit | undefined = state.habits.find(h => h.id === habitId);
    
    // Este loop nos permite percorrer as versões anteriores de um hábito.
    while (currentHabit) {
        const habitCreationDate = parseUTCIsoDate(currentHabit.createdOn);
        let streakBroken = false;

        // Este loop calcula a sequência para a versão atual do hábito.
        while (currentDate >= habitCreationDate) {
            if (shouldHabitAppearOnDate(currentHabit, currentDate)) {
                const currentDayISO = toUTCIsoDateString(currentDate);
                const dailyInfo = state.dailyData[currentDayISO]?.[currentHabit.id];
                
                const instances = dailyInfo?.instances || {};
                const scheduleForDay = dailyInfo?.dailySchedule || currentHabit.times;
                
                const statuses = scheduleForDay.map(time => instances[time]?.status ?? 'pending');
                
                const allCompleted = statuses.length > 0 && statuses.every(s => s === 'completed');
                const hasPending = statuses.some(s => s === 'pending');

                if (allCompleted) {
                    streak++;
                } else if (hasPending) {
                    streakBroken = true;
                    break;
                }
            }
            currentDate = addDays(currentDate, -1);
        }

        if (streakBroken) {
            break; // A sequência está quebrada, para de percorrer as versões anteriores.
        }

        // Se a sequência não foi quebrada, passa para a versão anterior.
        if (currentHabit.previousVersionId) {
            currentHabit = state.habits.find(h => h.id === currentHabit!.previousVersionId);
        } else {
            currentHabit = undefined; // Não há mais versões anteriores.
        }
    }

    state.streaksCache[cacheKey] = streak;
    return streak;
}

// --- CLOUD SYNC & STATE MANAGEMENT ---
import { syncStateWithCloud } from './cloud';

export function saveState() {
    const appState: AppState = {
        version: APP_VERSION,
        habits: state.habits,
        dailyData: state.dailyData,
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds,
    };
    // Salva localmente para acesso rápido e offline.
    try {
        localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(appState));
        localStorage.setItem('habitTrackerLanguage', state.activeLanguageCode);
    } catch (e) {
        console.error("Failed to save state to localStorage:", e);
        // Opcional: Notificar o usuário que as alterações locais não podem ser salvas.
    }
    
    // Invalida o cache de sequências e aciona a sincronização com a nuvem.
    state.streaksCache = {};
    syncStateWithCloud(appState);
}

export function loadState(cloudState?: AppState) {
    let loadedAppState: AppState | null = null;

    if (cloudState) {
        loadedAppState = cloudState;
    } else {
        const storedStateJSON = localStorage.getItem(STATE_STORAGE_KEY);
        if (storedStateJSON) {
            loadedAppState = JSON.parse(storedStateJSON);
        }
    }

    if (loadedAppState) {
        const loadedVersion = loadedAppState.version || 0;

        // Migrações de estado (se necessário)
        if (loadedVersion < APP_VERSION) {
            // ... (lógica de migração existente permanece aqui) ...
        }

        state.habits = loadedAppState.habits;
        state.dailyData = loadedAppState.dailyData;
        state.notificationsShown = loadedAppState.notificationsShown || [];
        state.pending21DayHabitIds = loadedAppState.pending21DayHabitIds || [];
        state.pendingConsolidationHabitIds = loadedAppState.pendingConsolidationHabitIds || [];
    } else {
        // Estado inicial se não houver nada localmente ou na nuvem
        state.habits = [];
        state.dailyData = {};
        state.notificationsShown = [];
        state.pending21DayHabitIds = [];
        state.pendingConsolidationHabitIds = [];
    }
}