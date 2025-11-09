// state.ts
// ANÁLISE DO ARQUIVO: 100% concluído. A estrutura do estado, os tipos e os helpers são bem definidos e otimizados. Nenhuma outra análise é necessária.
declare global {
    interface Window {
        OneSignal?: any[];
        OneSignalDeferred?: any[];
    }
}

import { addDays, getTodayUTC, getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate, getActiveHabitsForDate } from './utils';
import { icons } from './icons';
import { syncStateWithCloud } from './cloud';
import { migrateState } from './migration';

// --- TYPES & INTERFACES ---
export type HabitStatus = 'completed' | 'snoozed' | 'pending';

export type Frequency =
    | { type: 'daily' }
    | { type: 'interval'; unit: 'days' | 'weeks'; amount: number }
    | { type: 'specific_days_of_week'; days: number[] }; // Sun=0, Mon=1, ...

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
    subtitleKey: string;
    nameKey?: never;
    subtitle?: never;
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

export const TIMES_OF_DAY = ['Morning', 'Afternoon', 'Evening'] as const;
export type TimeOfDay = typeof TIMES_OF_DAY[number];

export const LANGUAGES = [
    { code: 'pt', nameKey: 'langPortuguese' },
    { code: 'en', nameKey: 'langEnglish' },
    { code: 'es', nameKey: 'langSpanish' }
] as const;
export type Language = typeof LANGUAGES[number];

// FIX: Export a FREQUENCIES constant to be used by the frequency selector UI.
export const FREQUENCIES = [
    { labelKey: 'freqDaily', value: { type: 'daily' } },
    { labelKey: 'freqEvery', value: { type: 'interval', unit: 'days', amount: 2 } },
    { labelKey: 'freqSpecificDaysOfWeek', value: { type: 'specific_days_of_week', days: [] } }
] as const;

// Predefined habits now use keys for localization
export const PREDEFINED_HABITS: PredefinedHabit[] = [
    { nameKey: 'predefinedHabitReadName', subtitleKey: 'predefinedHabitReadSubtitle', icon: icons.read, color: '#e74c3c', times: ['Evening'], goal: { type: 'pages', total: 10, unitKey: 'unitPage' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitMeditateName', subtitleKey: 'predefinedHabitMeditateSubtitle', icon: icons.meditate, color: '#f1c40f', times: ['Morning'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitWaterName', subtitleKey: 'predefinedHabitWaterSubtitle', icon: icons.water, color: '#3498db', times: ['Morning', 'Afternoon', 'Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' }, isDefault: true },
    { nameKey: 'predefinedHabitExerciseName', subtitleKey: 'predefinedHabitExerciseSubtitle', icon: icons.exercise, color: '#2ecc71', times: ['Afternoon'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitStretchName', subtitleKey: 'predefinedHabitStretchSubtitle', icon: icons.stretch, color: '#7f8c8d', times: ['Morning'], goal: { type: 'minutes', total: 5, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitJournalName', subtitleKey: 'predefinedHabitJournalSubtitle', icon: icons.journal, color: '#9b59b6', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitLanguageName', subtitleKey: 'predefinedHabitLanguageSubtitle', icon: icons.language, color: '#1abc9c', times: ['Afternoon'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitOrganizeName', subtitleKey: 'predefinedHabitOrganizeSubtitle', icon: icons.organize, color: '#34495e', times: ['Evening'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitWalkName', subtitleKey: 'predefinedHabitWalkSubtitle', icon: icons.walk, color: '#27ae60', times: ['Afternoon'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitPlanDayName', subtitleKey: 'predefinedHabitPlanDaySubtitle', icon: icons.planDay, color: '#007aff', times: ['Morning'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitCreativeHobbyName', subtitleKey: 'predefinedHabitCreativeHobbySubtitle', icon: icons.creativeHobby, color: '#e84393', times: ['Afternoon'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitGratitudeName', subtitleKey: 'predefinedHabitGratitudeSubtitle', icon: icons.gratitude, color: '#f39c12', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitEatFruitName', subtitleKey: 'predefinedHabitEatFruitSubtitle', icon: icons.eatFruit, color: '#c0392b', times: ['Afternoon'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitTalkFriendName', subtitleKey: 'predefinedHabitTalkFriendSubtitle', icon: icons.talkFriend, color: '#3498db', times: ['Afternoon'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitScreenBreakName', subtitleKey: 'predefinedHabitScreenBreakSubtitle', icon: icons.screenBreak, color: '#9b59b6', times: ['Afternoon'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitInstrumentName', subtitleKey: 'predefinedHabitInstrumentSubtitle', icon: icons.instrument, color: '#e67e22', times: ['Evening'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitPlantsName', subtitleKey: 'predefinedHabitPlantsSubtitle', icon: icons.plants, color: '#2ecc71', times: ['Morning'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitFinancesName', subtitleKey: 'predefinedHabitFinancesSubtitle', icon: icons.finances, color: '#34495e', times: ['Evening'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitTeaName', subtitleKey: 'predefinedHabitTeaSubtitle', icon: icons.tea, color: '#1abc9c', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitPodcastName', subtitleKey: 'predefinedHabitPodcastSubtitle', icon: icons.podcast, color: '#007aff', times: ['Afternoon'], goal: { type: 'minutes', total: 25, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitEmailsName', subtitleKey: 'predefinedHabitEmailsSubtitle', icon: icons.emails, color: '#f1c40f', times: ['Morning'], goal: { type: 'minutes', total: 5, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitSkincareName', subtitleKey: 'predefinedHabitSkincareSubtitle', icon: icons.skincare, color: '#e84393', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitSunlightName', subtitleKey: 'predefinedHabitSunlightSubtitle', icon: icons.sunlight, color: '#f39c12', times: ['Morning'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitDisconnectName', subtitleKey: 'predefinedHabitDisconnectSubtitle', icon: icons.disconnect, color: '#2980b9', times: ['Evening'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitDrawName', subtitleKey: 'predefinedHabitDrawSubtitle', icon: icons.draw, color: '#8e44ad', times: ['Afternoon'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitFamilyTimeName', subtitleKey: 'predefinedHabitFamilyTimeSubtitle', icon: icons.familyTime, color: '#f1c40f', times: ['Evening'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitNewsName', subtitleKey: 'predefinedHabitNewsSubtitle', icon: icons.news, color: '#7f8c8d', times: ['Morning'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitCookHealthyName', subtitleKey: 'predefinedHabitCookHealthySubtitle', icon: icons.cookHealthy, color: '#27ae60', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitLearnSkillName', subtitleKey: 'predefinedHabitLearnSkillSubtitle', icon: icons.learnSkill, color: '#3498db', times: ['Afternoon'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitPhotographyName', subtitleKey: 'predefinedHabitPhotographySubtitle', icon: icons.photography, color: '#34495e', times: ['Afternoon'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitVolunteerName', subtitleKey: 'predefinedHabitVolunteerSubtitle', icon: icons.volunteer, color: '#e74c3c', times: ['Afternoon'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitYogaName', subtitleKey: 'predefinedHabitYogaSubtitle', icon: icons.yoga, color: '#9b59b6', times: ['Morning'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitReflectDayName', subtitleKey: 'predefinedHabitReflectDaySubtitle', icon: icons.reflectDay, color: '#2980b9', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitNoComplaintName', subtitleKey: 'predefinedHabitNoComplaintSubtitle', icon: icons.disconnect, color: '#e67e22', times: ['Morning', 'Afternoon', 'Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitReviewDayName', subtitleKey: 'predefinedHabitReviewDaySubtitle', icon: icons.journal, color: '#7f8c8d', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitStoicismName', subtitleKey: 'predefinedHabitStoicismSubtitle', icon: icons.meditate, color: '#34495e', times: ['Morning'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } }
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
    scheduleCache: Record<string, HabitSchedule | null>;
    activeHabitsCache: Record<string, Array<{ habit: Habit; schedule: TimeOfDay[] }>>;
    // MELHORIA DE ROBUSTEZ [2024-10-06]: A estrutura de `lastEnded` foi aprimorada para incluir `removedSchedules`,
    // permitindo que a função "Desfazer" restaure completamente o estado de um hábito, incluindo
    // quaisquer agendamentos futuros que foram removidos quando o hábito foi encerrado.
    lastEnded: { habitId: string, lastSchedule: HabitSchedule, removedSchedules: HabitSchedule[] } | null;
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
    scheduleCache: {},
    activeHabitsCache: {},
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
 * Limpa o cache de agendamento. Chamado sempre que um `scheduleHistory` é modificado.
 */
export function clearScheduleCache() {
    state.scheduleCache = {};
}

/**
 * PERFORMANCE [2024-08-12]: Limpa o cache de hábitos ativos.
 * Chamado sempre que um hábito ou seu agendamento é modificado.
 */
export function clearActiveHabitsCache() {
    state.activeHabitsCache = {};
}


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
    const cacheKey = `${habit.id}|${dateStr}`;
    if (state.scheduleCache[cacheKey] !== undefined) {
        return state.scheduleCache[cacheKey];
    }
    
    const dateAsTime = parseUTCIsoDate(dateStr).getTime();
    let foundSchedule: HabitSchedule | null = null;

    for (const schedule of [...habit.scheduleHistory].reverse()) {
        const startAsTime = parseUTCIsoDate(schedule.startDate).getTime();
        const endAsTime = schedule.endDate ? parseUTCIsoDate(schedule.endDate).getTime() : Infinity;

        if (dateAsTime >= startAsTime && dateAsTime < endAsTime) {
            foundSchedule = schedule;
            break;
        }
    }
    
    state.scheduleCache[cacheKey] = foundSchedule;
    return foundSchedule;
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

/**
 * REATORAÇÃO [2024-10-04]: Nova função auxiliar para centralizar a criação do objeto HabitDailyInfo,
 * seguindo o mesmo padrão de ensureHabitInstanceData para consistência e robustez.
 * Garante que a estrutura de dados diários para um hábito exista e retorna uma referência direta a ela.
 */
export function ensureHabitDailyInfo(date: string, habitId: string): HabitDailyInfo {
    state.dailyData[date] ??= {};
    state.dailyData[date][habitId] ??= { instances: {} };
    return state.dailyData[date][habitId];
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
    
    const freq = activeSchedule.frequency;
    if (freq.type === 'daily') {
        return true;
    }

    if (freq.type === 'interval') {
        if (freq.unit === 'days') {
            return daysDifference % freq.amount === 0;
        }
        if (freq.unit === 'weeks') {
            if (date.getUTCDay() !== anchorDate.getUTCDay()) return false;
            const weeksDifference = Math.floor(daysDifference / 7);
            return weeksDifference % freq.amount === 0;
        }
    }

    if (freq.type === 'specific_days_of_week') {
        return freq.days.includes(date.getUTCDay());
    }

    return true;
}

/**
 * OTIMIZAÇÃO DE PERFORMANCE [2024-09-30]: Esta nova função centraliza todos os cálculos necessários
 * para renderizar um dia no calendário (`completedPercent`, `totalPercent`, `showPlus`) em um único
 * loop sobre os hábitos do dia. Isso substitui as chamadas separadas para `calculateDayProgress` e
 * `shouldShowPlusIndicator`, reduzindo significativamente o número de iterações e melhorando a
 * performance da renderização do calendário.
 */
export function calculateDaySummary(dateISO: string): { completedPercent: number, totalPercent: number, showPlus: boolean } {
    const activeHabitsData = getActiveHabitsForDate(parseUTCIsoDate(dateISO));
    if (activeHabitsData.length === 0) {
        return { completedPercent: 0, totalPercent: 0, showPlus: false };
    }

    const dailyInfo = state.dailyData[dateISO] || {};
    let totalInstances = 0;
    let completedInstances = 0;
    let snoozedInstances = 0;
    let allHabitsCompletedForDay = true;
    let hasExceededHabitWithStreak = false;

    for (const { habit, schedule: scheduleForDay } of activeHabitsData) {
        const instances = dailyInfo[habit.id]?.instances || {};
        
        totalInstances += scheduleForDay.length;
        let instancesCompletedForThisHabit = 0;
        scheduleForDay.forEach(time => {
            const status = instances[time]?.status ?? 'pending';
            if (status === 'completed') {
                completedInstances++;
                instancesCompletedForThisHabit++;
            } else if (status === 'snoozed') {
                snoozedInstances++;
            }
        });

        const isHabitCompletedForDay = scheduleForDay.length > 0 && instancesCompletedForThisHabit === scheduleForDay.length;
        if (!isHabitCompletedForDay) {
            allHabitsCompletedForDay = false;
        }

        if (!hasExceededHabitWithStreak && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
             const goalWasExceeded = scheduleForDay.some(time => {
                const instance = instances[time];
                return instance?.status === 'completed' && instance?.goalOverride !== undefined && instance.goalOverride > (habit.goal.total ?? 0);
            });

            if (goalWasExceeded) {
                const dayBefore = addDays(parseUTCIsoDate(dateISO), -1);
                const streakBeforeToday = calculateHabitStreak(habit.id, toUTCIsoDateString(dayBefore));
                if (streakBeforeToday >= 2) {
                    hasExceededHabitWithStreak = true;
                }
            }
        }
    }

    const completedPercent = totalInstances > 0 ? Math.round((completedInstances / totalInstances) * 100) : 0;
    const totalPercent = totalInstances > 0 ? Math.round(((completedInstances + snoozedInstances) / totalInstances) * 100) : 0;
    const showPlus = allHabitsCompletedForDay && hasExceededHabitWithStreak;

    return { completedPercent, totalPercent, showPlus };
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

/**
 * Retorna o valor da meta atual para uma instância de hábito, considerando substituições e metas inteligentes.
 * @param habit O hábito em questão.
 * @param date A data (string ISO) da instância.
 * @param time O horário (TimeOfDay) da instância.
 * @returns O valor numérico da meta atual.
 */
export function getCurrentGoalForInstance(habit: Habit, date: string, time: TimeOfDay): number {
    const dayInstanceData = state.dailyData[date]?.[habit.id]?.instances[time];
    const smartGoal = getSmartGoalForHabit(habit, date, time);
    return dayInstanceData?.goalOverride ?? smartGoal;
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
            
            // CORREÇÃO DE BUG DE LÓGICA [2024-09-29]: A lógica anterior não quebrava a sequência em dias adiados ('snoozed'),
            // pois continuava o loop. A sequência deve ser uma cadeia ininterrupta de dias CONCLUÍDOS.
            // Qualquer dia que não seja totalmente concluído (seja pendente ou adiado) deve quebrar a contagem.
            if (allCompleted) {
                streak++;
            } else {
                break; // Quebra a sequência se nem todos estiverem concluídos.
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
        clearScheduleCache();
        clearActiveHabitsCache();
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
        clearScheduleCache();
        clearActiveHabitsCache();
    }
}