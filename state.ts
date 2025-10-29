// FIX: Add a global declaration for window.OneSignal to avoid TypeScript errors.
declare global {
    interface Window {
        OneSignal?: any[];
    }
}

import { addDays, getTodayUTC, getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate } from './utils';
import { icons } from './icons';
import { syncStateWithCloud } from './cloud';
import { migrateState } from './migration';

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

export interface HabitSchedule {
    startDate: string;
    endDate?: string;
    name?: string;
    subtitle?: string;
    nameKey?: string;
    subtitleKey?: string;
    times: TimeOfDay[];
    frequency: Frequency;
    scheduleAnchor: string;
}

export interface Habit {
    id: string;
    icon: string;
    color: string;
    goal: { 
        type: 'pages' | 'minutes' | 'check'; 
        total?: number; 
        unit?: string;
        unitKey?: string;
    };
    createdOn: string;
    graduatedOn?: string;
    scheduleHistory: HabitSchedule[];
}

export type PredefinedHabit = {
    nameKey: string;
    subtitleKey: string;
    icon: string;
    color: string;
    times: TimeOfDay[];
    goal: {
        type: 'pages' | 'minutes' | 'check';
        total?: number;
        unitKey: string;
    };
    frequency: Frequency;
    isDefault?: boolean;
};

/**
 * Represents the data needed to create a new habit.
 * It can be a predefined habit (identified by nameKey) or a custom one (identified by name).
 */
export type HabitTemplate = {
    icon: string;
    color: string;
    times: TimeOfDay[];
    goal: Habit['goal'];
    frequency: Frequency;
} & ({
    nameKey: string;
    subtitleKey: string;
    name?: never;
    subtitle?: never;
} | {
    name: string;
    subtitle: string;
    nameKey?: never;
    subtitleKey?: never;
});


// Nova interface para o estado completo da aplicação
export interface AppState {
    version: number;
    lastModified: number;
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    notificationsShown: string[];
    pending21DayHabitIds: string[];
    pendingConsolidationHabitIds: string[];
    // Propriedades do estado da IA
    aiState?: 'idle' | 'loading' | 'completed' | 'error';
    lastAIResult?: string | null;
    lastAIError?: string | null;
    hasSeenAIResult?: boolean;
}


// --- CONSTANTS ---
export const STATE_STORAGE_KEY = 'habitTrackerState_v1';
export const APP_VERSION = 6; // Increased version for scheduleHistory refactor
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
    { nameKey: 'predefinedHabitWaterName', subtitleKey: 'predefinedHabitWaterSubtitle', icon: icons.water, color: '#3498db', times: ['Manhã', 'Tarde', 'Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 }, isDefault: true },
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
    lastEnded: { habitId: string, lastSchedule: HabitSchedule } | null;
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
        habitId?: string; // For existing habits
        originalData?: Habit; // For comparing changes
        // A template-like object for the form
        formData: HabitTemplate;
    } | null;
    aiState: 'idle' | 'loading' | 'completed' | 'error';
    hasSeenAIResult: boolean;
    lastAIResult: string | null;
    lastAIError: string | null;
    syncState: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial';
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
    aiState: 'idle',
    hasSeenAIResult: true,
    lastAIResult: null,
    lastAIError: null,
    syncState: 'syncInitial',
};

// --- STATE-DEPENDENT HELPERS ---
/**
 * Invalida o cache de streaks para um hábito específico a partir de uma data.
 * Isso é necessário sempre que o status de um hábito muda, pois afeta o cálculo
 * de streaks para todas as datas futuras.
 * @param habitId O ID do hábito a ser invalidado.
 * @param fromDateISO A data (string ISO) a partir da qual invalidar.
 */
export function invalidateStreakCache(habitId: string, fromDateISO: string) {
    const fromDate = parseUTCIsoDate(fromDateISO);
    for (const key in state.streaksCache) {
        // A chave é no formato "habitId|dateISO"
        if (key.startsWith(`${habitId}|`)) {
            const cachedDateISO = key.substring(habitId.length + 1);
            const cachedDate = parseUTCIsoDate(cachedDateISO);
            if (cachedDate >= fromDate) {
                delete state.streaksCache[key];
            }
        }
    }
}

export function getScheduleForDate(habit: Habit, date: Date | string): HabitSchedule | null {
    const dateStr = typeof date === 'string' ? date : toUTCIsoDateString(date);
    const dateAsTime = parseUTCIsoDate(dateStr).getTime();

    for (const schedule of [...habit.scheduleHistory].reverse()) {
        const startAsTime = parseUTCIsoDate(schedule.startDate).getTime();
        const endAsTime = schedule.endDate ? parseUTCIsoDate(schedule.endDate).getTime() : Infinity;

        if (dateAsTime >= startAsTime && dateAsTime < endAsTime) {
            return schedule;
        }
    }
    return null;
}

/**
 * Obtém o agendamento de horários efetivo para um hábito em uma data específica,
 * considerando os agendamentos diários personalizados sobre o agendamento padrão.
 * @param habit O objeto do hábito.
 * @param dateISO A data no formato string ISO.
 * @returns Um array de TimeOfDay representando os horários agendados.
 */
export function getEffectiveScheduleForHabitOnDate(habit: Habit, dateISO: string): TimeOfDay[] {
    const dailyInfo = state.dailyData[dateISO]?.[habit.id];
    const activeSchedule = getScheduleForDate(habit, parseUTCIsoDate(dateISO));
    if (!activeSchedule) return [];
    
    return dailyInfo?.dailySchedule || activeSchedule.times;
}

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

    const activeSchedule = getScheduleForDate(habit, date);
    if (!activeSchedule) return false;

    const anchorDate = parseUTCIsoDate(activeSchedule.scheduleAnchor);
    const daysDifference = Math.round((date.getTime() - anchorDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysDifference < 0) {
        return false;
    }

    if (activeSchedule.frequency.type === 'daily') {
        return daysDifference % activeSchedule.frequency.interval === 0;
    }

    if (activeSchedule.frequency.type === 'weekly') {
        if (date.getUTCDay() !== anchorDate.getUTCDay()) return false;
        const weeksDifference = Math.floor(daysDifference / 7);
        return weeksDifference % activeSchedule.frequency.interval === 0;
    }

    return true;
}

function getPreviousCompletedOccurrences(habit: Habit, startDate: Date, count: number): Date[] {
    const dates: Date[] = [];
    let currentDate = new Date(startDate);
    const earliestDate = parseUTCIsoDate(habit.createdOn);

    while (dates.length < count && currentDate > earliestDate) {
        currentDate = addDays(currentDate, -1);

        if (shouldHabitAppearOnDate(habit, currentDate)) {
            const dayISO = toUTCIsoDateString(currentDate);
            const dailyInfo = state.dailyData[dayISO]?.[habit.id];
            const instances = dailyInfo?.instances || {};
            const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, dayISO);

            const statuses = scheduleForDay.map(time => instances[time]?.status ?? 'pending');
            
            const allCompleted = statuses.length > 0 && statuses.every(s => s === 'completed');
            const hasPending = statuses.some(s => s === 'pending');

            if (allCompleted) {
                dates.push(new Date(currentDate));
            } else if (hasPending) {
                return []; // Streak broken
            }
        }
    }
    
    return dates;
}

export function shouldShowPlusIndicator(dateISO: string): boolean {
    const dateObj = parseUTCIsoDate(dateISO);
    const dailyInfo = state.dailyData[dateISO] || {};
    const activeHabitsOnDate = state.habits.filter(h => shouldHabitAppearOnDate(h, dateObj));

    if (activeHabitsOnDate.length === 0) return false;

    // 1. Prerequisite: Check if ALL active habits for the day are completed.
    const allHabitsCompleted = activeHabitsOnDate.every(habit => {
        const habitDailyInfo = dailyInfo[habit.id];
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, dateISO);
        const instances = habitDailyInfo?.instances || {};

        // If a habit is scheduled but has no instance data, it's not complete.
        if (scheduleForDay.length > 0 && Object.keys(instances).length < scheduleForDay.length) {
            return false;
        }
        
        // Every scheduled instance must be 'completed'.
        return scheduleForDay.every(time => instances[time]?.status === 'completed');
    });

    if (!allHabitsCompleted) {
        return false;
    }

    // 2. Find habits where the goal was exceeded.
    const goalExceededHabits = activeHabitsOnDate.filter(habit => {
        if (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes') return false;
        
        const habitDailyInfo = dailyInfo[habit.id];
        if (!habitDailyInfo) return false; // Should be present due to the previous check
        
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, dateISO);

        return scheduleForDay.some(time => {
            const instance = habitDailyInfo.instances[time];
            // Status check is redundant because of the prerequisite, but good for safety.
            return instance?.status === 'completed' &&
                   instance.goalOverride !== undefined &&
                   instance.goalOverride > (habit.goal.total ?? 0);
        });
    });

    if (goalExceededHabits.length === 0) {
        return false;
    }

    // 3. Check if at least one of the exceeded habits has the required streak.
    const hasExceededHabitWithStreak = goalExceededHabits.some(habit => {
        const previousCompletions = getPreviousCompletedOccurrences(habit, dateObj, 2);
        return previousCompletions.length === 2;
    });

    return hasExceededHabitWithStreak;
}

export function getSmartGoalForHabit(habit: Habit, dateISO: string, time: TimeOfDay): number {
    const activeSchedule = getScheduleForDate(habit, dateISO);
    const baseGoal = habit.goal.total ?? 0;
    if (!activeSchedule || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return baseGoal;

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
                return baseGoal;
            }
        }
    }
    
    const sum = consecutiveExceededGoals.reduce((a, b) => a + b, 0);
    return Math.round(sum / 3);
}

export function calculateHabitStreak(habitId: string, dateISO: string): number {
    const cacheKey = `${habitId}|${dateISO}`;
    if (state.streaksCache[cacheKey] !== undefined) return state.streaksCache[cacheKey];

    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) {
        state.streaksCache[cacheKey] = 0;
        return 0;
    }
    
    let streak = 0;
    let currentDate = parseUTCIsoDate(dateISO);
    const earliestDate = parseUTCIsoDate(habit.createdOn);

    while (currentDate >= earliestDate) {
        if (shouldHabitAppearOnDate(habit, currentDate)) {
            const currentDayISO = toUTCIsoDateString(currentDate);
            const dailyInfo = state.dailyData[currentDayISO]?.[habit.id];
            
            const instances = dailyInfo?.instances || {};
            const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, currentDayISO);
            
            const statuses = scheduleForDay.map(time => instances[time]?.status ?? 'pending');
            
            const allCompleted = statuses.length > 0 && statuses.every(s => s === 'completed');
            const hasPending = statuses.some(s => s === 'pending');

            if (allCompleted) {
                streak++;
            } else if (hasPending) {
                break;
            }
        }
        currentDate = addDays(currentDate, -1);
    }

    state.streaksCache[cacheKey] = streak;
    return streak;
}


// --- CLOUD SYNC & STATE MANAGEMENT ---

export function saveState() {
    const appState: AppState = {
        version: APP_VERSION,
        lastModified: Date.now(),
        habits: state.habits,
        dailyData: state.dailyData,
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds,
        // Propriedades do estado da IA
        aiState: state.aiState,
        lastAIResult: state.lastAIResult,
        lastAIError: state.lastAIError,
        hasSeenAIResult: state.hasSeenAIResult,
    };
    try {
        localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(appState));
        localStorage.setItem('habitTrackerLanguage', state.activeLanguageCode);
    } catch (e) {
        console.error("Failed to save state to localStorage:", e);
    }
    
    syncStateWithCloud(appState);
}

export function loadState(cloudState?: AppState) {
    let loadedAppState: any | null = null; // Use any to handle old structures before migration

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
        
        // Refactored: Centralized migration logic
        if (loadedVersion < APP_VERSION) {
            loadedAppState = migrateState(loadedAppState);
        }

        state.habits = loadedAppState.habits;
        state.dailyData = loadedAppState.dailyData;
        state.notificationsShown = loadedAppState.notificationsShown || [];
        state.pending21DayHabitIds = loadedAppState.pending21DayHabitIds || [];
        state.pendingConsolidationHabitIds = loadedAppState.pendingConsolidationHabitIds || [];
        // Carrega o estado da IA, com padrões para versões antigas
        state.aiState = loadedAppState.aiState || 'idle';
        state.lastAIResult = loadedAppState.lastAIResult || null;
        state.lastAIError = loadedAppState.lastAIError || null;
        state.hasSeenAIResult = loadedAppState.hasSeenAIResult ?? true;
        // Se um estado de 'loading' foi carregado de uma sessão anterior, reseta-o para evitar travamento.
        if (state.aiState === 'loading') {
            state.aiState = 'idle';
        }
        // Limpa o cache ao carregar um novo estado para garantir consistência.
        state.streaksCache = {};
    } else {
        state.habits = [];
        state.dailyData = {};
        state.notificationsShown = [];
        state.pending21DayHabitIds = [];
        state.pendingConsolidationHabitIds = [];
        // Define padrões para um estado novo
        state.aiState = 'idle';
        state.lastAIResult = null;
        state.lastAIError = null;
        state.hasSeenAIResult = true;
        // Limpa o cache ao criar um estado novo.
        state.streaksCache = {};
    }
}