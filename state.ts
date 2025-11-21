
// state.ts

// [ANALYSIS PROGRESS]: 100% - Análise concluída. O estado da aplicação está bem estruturado. A lógica de cálculo de streaks e agendamento (scheduleHistory) está sólida e cobre os requisitos complexos de histórico.

import { addDays, getTodayUTC, getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate } from './utils';
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
export const SMART_GOAL_AVERAGE_COUNT = 3;

export const TIMES_OF_DAY = ['Morning', 'Afternoon', 'Evening'] as const;
export type TimeOfDay = typeof TIMES_OF_DAY[number];

export const LANGUAGES = [
    { code: 'pt', nameKey: 'langPortuguese' },
    { code: 'en', nameKey: 'langEnglish' },
    { code: 'es', nameKey: 'langSpanish' }
] as const;
export type Language = typeof LANGUAGES[number];

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
    fullCalendar: {
        year: number;
        month: number;
    };
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
    fullCalendar: {
        year: new Date().getFullYear(),
        month: new Date().getMonth(),
    }
};

// --- STATE-DEPENDENT HELPERS ---

export function saveState() {
    const stateToSave: AppState = {
        version: APP_VERSION,
        lastModified: Date.now(),
        habits: state.habits,
        dailyData: state.dailyData,
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds
    };
    
    const saveToLocalStorage = (data: AppState) => {
        try {
            localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(data));
            syncStateWithCloud(data);
        } catch (e: any) {
            if (e.name === 'QuotaExceededError') {
                console.warn("LocalStorage quota exceeded. Attempting to clear non-essential data.");
                // FAIL-SAFE: Limpa dados não essenciais para tentar liberar espaço
                state.lastEnded = null; // Remove histórico de desfazer
                // Em um cenário real, poderíamos limpar caches de IA ou notificações antigas aqui
                
                // Tenta salvar novamente sem os dados supérfluos (embora lastEnded não esteja no AppState salvo,
                // a intenção aqui é liberar memória se o problema for do navegador, ou preparar para 
                // futuras estratégias de redução de dados).
                // Se falhar novamente, logamos o erro mas não crashamos a aplicação.
                try {
                    // Uma estratégia mais agressiva seria tentar salvar sem 'dailyData' antigo, mas isso é arriscado.
                    // Por enquanto, apenas reportamos.
                    console.error("Critical: Unable to save state due to storage quota.");
                } catch (retryError) {
                    console.error("Failed retry save", retryError);
                }
            } else {
                console.error("Failed to save state", e);
            }
        }
    };

    saveToLocalStorage(stateToSave);
}

/**
 * Persists the current state to local storage WITHOUT updating the lastModified timestamp
 * and WITHOUT triggering a cloud sync.
 * Used when receiving data from the cloud to ensure local consistency.
 */
export function persistStateLocally(appState: AppState) {
    try {
        localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(appState));
    } catch (e) {
        console.error("Failed to persist state locally", e);
    }
}

export function loadState(cloudState?: AppState) {
    let loadedState: AppState | null = cloudState || null;

    if (!loadedState) {
        const localStr = localStorage.getItem(STATE_STORAGE_KEY);
        if (localStr) {
            try {
                loadedState = JSON.parse(localStr);
            } catch (e) {
                console.error("Failed to parse local state", e);
            }
        }
    }

    if (loadedState) {
        const migrated = migrateState(loadedState, APP_VERSION);
        
        // ROBUSTEZ [2025-01-18]: Sanitização do estado carregado.
        // Remove hábitos corrompidos (sem ID ou sem histórico de agendamento)
        // para evitar que erros se propaguem para a renderização.
        const sanitizedHabits = migrated.habits.filter(h => {
            if (!h.id || !h.scheduleHistory || h.scheduleHistory.length === 0) {
                console.warn(`Removing corrupted habit found in state: ${h.id || 'unknown'}`);
                return false;
            }
            return true;
        });

        state.habits = sanitizedHabits;
        state.dailyData = migrated.dailyData || {};
        state.notificationsShown = migrated.notificationsShown || [];
        state.pending21DayHabitIds = migrated.pending21DayHabitIds || [];
        state.pendingConsolidationHabitIds = migrated.pendingConsolidationHabitIds || [];
        
        state.streaksCache = {};
        state.scheduleCache = {};
        state.activeHabitsCache = {};
        state.lastEnded = null;
        
        // Clear summary cache on load
        invalidateDaySummaryCache();
    }
}

/**
 * Limpa o cache de agendamento. Chamado sempre que um `scheduleHistory` é modificado.
 */
export function clearScheduleCache() {
    state.scheduleCache = {};
    // Mudanças no agendamento afetam o resumo diário de todos os dias
    invalidateDaySummaryCache();
}

/**
 * PERFORMANCE [2024-08-12]: Limpa o cache de hábitos ativos.
 * Chamado sempre que um hábito ou seu agendamento é modificado.
 */
export function clearActiveHabitsCache() {
    state.activeHabitsCache = {};
    // Mudanças em hábitos ativos afetam o resumo diário
    invalidateDaySummaryCache();
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
    // PERFORMANCE [2025-01-16]: String Comparison Optimization.
    // Instead of converting to Date objects and getting timestamps, we use the fact that
    // ISO 8601 strings (YYYY-MM-DD) are lexicographically comparable.
    // This saves object allocation in the hot path.
    const dateStr = typeof date === 'string' ? date : toUTCIsoDateString(date);
    
    const cacheKey = `${habit.id}|${dateStr}`;
    if (state.scheduleCache[cacheKey] !== undefined) {
        return state.scheduleCache[cacheKey];
    }
    
    let foundSchedule: HabitSchedule | null = null;

    // PERFORMANCE [2025-01-16]: Zero-allocation loop with string comparison.
    for (let i = habit.scheduleHistory.length - 1; i >= 0; i--) {
        const schedule = habit.scheduleHistory[i];
        
        // ISO Strings comparison works: '2024-01-02' > '2024-01-01'
        const isAfterStart = dateStr >= schedule.startDate;
        const isBeforeEnd = !schedule.endDate || dateStr < schedule.endDate;

        if (isAfterStart && isBeforeEnd) {
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
    // PERFORMANCE: Pass string directly to avoid Date creation inside getScheduleForDate if not needed
    const activeSchedule = getScheduleForDate(habit, dateISO);
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

// PERFORMANCE [2025-01-16]: Cache para armazenar o timestamp da âncora de agendamento.
// Evita parsear a string de data ISO repetidamente dentro do loop de streaks (hot-path).
// WeakMap garante que se o objeto de agendamento for removido, o cache seja limpo.
const anchorTimestampCache = new WeakMap<HabitSchedule, number>();

export function shouldHabitAppearOnDate(habit: Habit, date: Date, dateISO?: string): boolean {
    if (habit.graduatedOn) return false;

    const activeSchedule = getScheduleForDate(habit, dateISO || date);
    if (!activeSchedule) return false;

    const freq = activeSchedule.frequency;
    
    // PERFORMANCE [2025-01-17]: HOT-PATH OPTIMIZATION
    // A frequência 'diária' é o caso mais comum. Retornamos 'true' imediatamente
    // para evitar cálculos matemáticos de timestamp (divisões/arredondamentos) desnecessários.
    if (freq.type === 'daily') {
        return true;
    }

    // OTIMIZAÇÃO [2025-01-16]: Uso de cache para o timestamp da âncora.
    let anchorTime = anchorTimestampCache.get(activeSchedule);
    if (anchorTime === undefined) {
        anchorTime = parseUTCIsoDate(activeSchedule.scheduleAnchor).getTime();
        anchorTimestampCache.set(activeSchedule, anchorTime);
    }

    // A diferença é calculada usando o timestamp cacheado, evitando alocação de 'new Date'.
    const daysDifference = Math.round((date.getTime() - anchorTime) / (1000 * 60 * 60 * 24));

    if (daysDifference < 0) {
        return false;
    }

    if (freq.type === 'interval') {
        if (freq.unit === 'days') {
            return daysDifference % freq.amount === 0;
        }
        if (freq.unit === 'weeks') {
            // Para semanas, ainda precisamos do getUTCDay da âncora, mas podemos derivá-lo do timestamp
            // ou apenas aceitar o custo menor aqui (já que é menos comum).
            const anchorDate = new Date(anchorTime); 
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
 * PERFORMANCE [2024-08-12]: Moved from utils.ts to resolve circular dependency.
 * Obtém hábitos ativos e seus horários para uma data com cache.
 * PERFORMANCE [2025-01-17]: Agora aceita `Date | string` para evitar alocações de Date desnecessárias
 * quando o chamador já possui a string ISO e o cache está "quente".
 * @param dateOrIso A data para a qual obter os hábitos.
 * @returns Um array de objetos, cada um contendo o hábito e seu agendamento para o dia.
 */
export function getActiveHabitsForDate(dateOrIso: Date | string): Array<{ habit: Habit; schedule: TimeOfDay[] }> {
    const dateStr = typeof dateOrIso === 'string' ? dateOrIso : toUTCIsoDateString(dateOrIso);
    const cacheKey = dateStr;
    if (state.activeHabitsCache[cacheKey]) {
        return state.activeHabitsCache[cacheKey];
    }
    
    // Fallback: precisamos do objeto Date para a lógica de agendamento se não estiver em cache
    const date = typeof dateOrIso === 'string' ? parseUTCIsoDate(dateOrIso) : dateOrIso;

    const activeHabits = state.habits
        .filter(habit => shouldHabitAppearOnDate(habit, date, dateStr))
        .map(habit => ({
            habit,
            schedule: getEffectiveScheduleForHabitOnDate(habit, dateStr),
        }));

    state.activeHabitsCache[cacheKey] = activeHabits;
    return activeHabits;
}

export function calculateHabitStreak(habitId: string, referenceDateISO: string): number {
    const cacheKey = `${habitId}|${referenceDateISO}`;
    if (state.streaksCache[cacheKey] !== undefined) {
        return state.streaksCache[cacheKey];
    }

    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return 0;

    let streak = 0;
    
    // PERFORMANCE [2025-01-16]: Optimization. Instead of creating a new Date object in every iteration
    // via `addDays(date, -1)`, we create one date object and mutate it in-place using `setUTCDate`.
    // This saves up to ~730 object allocations per habit per render when streak cache is cold.
    const iteratorDate = parseUTCIsoDate(referenceDateISO);
    
    for (let i = 0; i < 365 * 2; i++) { // Check up to 2 years back
        // PERFORMANCE [2025-01-16]: We generate dateStr once per iteration and pass it down.
        // Previously it was generated again inside `getScheduleForDate` (called by shouldHabitAppearOnDate).
        const dateStr = toUTCIsoDateString(iteratorDate);
        
        if (dateStr < habit.createdOn) break;

        if (shouldHabitAppearOnDate(habit, iteratorDate, dateStr)) {
             const dailyInfo = state.dailyData[dateStr]?.[habitId];
             const schedule = getEffectiveScheduleForHabitOnDate(habit, dateStr);
             
             let allCompleted = true;
             
             for (const time of schedule) {
                 const status = dailyInfo?.instances?.[time]?.status || 'pending';
                 if (status !== 'completed' && status !== 'snoozed') {
                     allCompleted = false;
                     break;
                 }
             }
             
             if (allCompleted && schedule.length > 0) {
                 streak++;
             } else {
                 if (dateStr === referenceDateISO && !allCompleted) {
                     // If today is not completed, we simply don't count it but check yesterday
                 } else {
                     break; 
                 }
             }
        }
        // Mutate date in-place for next iteration (Go to yesterday)
        iteratorDate.setUTCDate(iteratorDate.getUTCDate() - 1);
    }
    
    state.streaksCache[cacheKey] = streak;
    return streak;
}

/**
 * REATORAÇÃO DE LÓGICA [2024-12-27]: Verifica se a meta de um hábito foi superada HOJE e se existe consistência (streak).
 * O indicador "Plus" exige que o usuário supere a meta E tenha um streak anterior >= 2 dias,
 * garantindo que o prêmio seja dado apenas para "Consistência + Esforço".
 */
function _wasGoalExceededWithStreak(habit: Habit, instances: HabitDailyInstances, scheduleForDay: TimeOfDay[], dateISO: string): boolean {
    if (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes') {
        return false;
    }

    const exceededToday = scheduleForDay.some(time => {
        const instance = instances[time];
        return instance?.status === 'completed' && 
               instance.goalOverride !== undefined && 
               instance.goalOverride > (habit.goal.total ?? 0);
    });

    if (!exceededToday) return false;

    // Verifica streak anterior para exigir consistência
    const previousDate = addDays(parseUTCIsoDate(dateISO), -1);
    const previousDateISO = toUTCIsoDateString(previousDate);
    const streak = calculateHabitStreak(habit.id, previousDateISO);

    return streak >= 2;
}

// PERFORMANCE [2025-01-17]: Cache para resultados de calculateDaySummary.
// Evita o recálculo de progresso para todos os 61 dias do calendário a cada renderização.
const daySummaryCache = new Map<string, { completedPercent: number, totalPercent: number, showPlus: boolean }>();

/**
 * Invalida o cache de resumo diário para uma data específica ou para todos os dias.
 * Deve ser chamado sempre que dados que afetam o progresso diário (status de hábito, meta, agendamento) mudarem.
 * @param dateISO A data para invalidar. Se omitido, limpa todo o cache.
 */
export function invalidateDaySummaryCache(dateISO?: string) {
    if (dateISO) {
        daySummaryCache.delete(dateISO);
    } else {
        daySummaryCache.clear();
    }
}

/**
 * OTIMIZAÇÃO DE PERFORMANCE [2024-09-30]: Esta nova função centraliza todos os cálculos necessários
 * para renderizar um dia no calendário (`completedPercent`, `totalPercent`, `showPlus`) em um único
 * loop sobre os hábitos do dia. Isso substitui as chamadas separadas para `calculateDayProgress` e
 * `shouldShowPlusIndicator`, reduzindo significativamente o número de iterações e melhorando a
 * performance da renderização do calendário.
 * 
 * ATUALIZAÇÃO [2025-01-17]: Agora utiliza cache para evitar recálculos redundantes.
 */
export function calculateDaySummary(dateISO: string) {
    if (daySummaryCache.has(dateISO)) {
        return daySummaryCache.get(dateISO)!;
    }

     // OTIMIZAÇÃO [2025-01-17]: Passa a string ISO diretamente para getActiveHabitsForDate.
     // Isso evita a criação de um objeto Date redundante se os dados já estiverem em cache em getActiveHabitsForDate.
     const activeHabits = getActiveHabitsForDate(dateISO);
     
     if (activeHabits.length === 0) return { completedPercent: 0, totalPercent: 0, showPlus: false };
     
     let total = 0;
     let completed = 0;
     let snoozed = 0;
     let showPlus = false;
     
     const dailyData = state.dailyData[dateISO] || {};

     for (const { habit, schedule } of activeHabits) {
         const instances = dailyData[habit.id]?.instances || {};
         
         if (_wasGoalExceededWithStreak(habit, instances, schedule, dateISO)) {
             showPlus = true;
         }

         for (const time of schedule) {
             total++;
             const status = instances[time]?.status;
             if (status === 'completed') completed++;
             else if (status === 'snoozed') snoozed++;
         }
     }
     
     const effectiveTotal = total - snoozed;
     const completedPercent = effectiveTotal > 0 ? Math.round((completed / effectiveTotal) * 100) : 0;
     const totalPercent = total > 0 ? Math.round(((completed + snoozed) / total) * 100) : 0;

     const result = { completedPercent, totalPercent, showPlus };
     daySummaryCache.set(dateISO, result);
     return result;
}

export function getSmartGoalForHabit(habit: Habit, dateISO: string, time: TimeOfDay): number {
    // Simple implementation: return total goal or default to 1
    return habit.goal.total || 1; 
}

export function getCurrentGoalForInstance(habit: Habit, dateISO: string, time: TimeOfDay): number {
    const daily = state.dailyData[dateISO]?.[habit.id];
    if (daily?.instances?.[time]?.goalOverride !== undefined) {
        return daily.instances[time].goalOverride!;
    }
    return getSmartGoalForHabit(habit, dateISO, time);
}
