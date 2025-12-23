
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file state.ts
 * @description Single Source of Truth (SSOT) & Multi-Tier Storage Engine.
 * 
 * [MAIN THREAD]: Este módulo gerencia o estado reativo da UI e orquestra o acesso a dados 
 * entre o Hot Storage (RAM) e o Cold Storage (Archives).
 * 
 * ARQUITETURA DE DADOS:
 * 1. **Reactive Dirty Checking:** Utiliza flags booleanas (`uiDirtyState`) para evitar o custo 
 *    de diffing de VDOM, disparando renderizações cirúrgicas apenas quando necessário.
 * 2. **Multi-tier Caching:** Implementa Mapas aninhados para acesso O(1) a streaks e agendamentos, 
 *    eliminando concatenação de strings e buscas lineares em loops de 60fps.
 * 3. **Hierarquia de Persistência:** 
 *    - Hot: Dados dos últimos 90 dias (JSON vivo).
 *    - Cold: Dados históricos arquivados por ano (JSON stringificado para reduzir pressão de GC).
 * 4. **Memory Management:** Uso de `Object.freeze` em objetos vazios compartilhados para 
 *    minimizar alocações redundantes.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `utils.ts`: Orquestração de datas UTC e geração de IDs.
 * - `habitActions.ts`: Único ponto autorizado para mutação estrutural complexa.
 */

import { addDays, getTodayUTC, getTodayUTCIso } from './utils';

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
    dailyData: Record<string, Record<string, HabitDailyInfo>>; // HOT STORAGE (Last 90 days)
    archives: Record<string, string>; // COLD STORAGE: Key="YYYY", Value=JSON String of dailyData. Optimized for parsing speed.
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
// CONSTANT [2025-02-23]: Limit for streak calculation lookback (2 years).
export const STREAK_LOOKBACK_DAYS = 730;

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
/**
 * Singleton de Estado Global.
 * DO NOT REFACTOR: Estrutura baseada em Mapas para performance O(1) e 
 * flags booleanas para otimização de renderização reativa.
 */
export const state: {
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>; // HOT STORAGE (Last 90 days)
    archives: Record<string, string>; // COLD STORAGE (JSON Strings)
    // RUNTIME CACHE [2025-02-23]: Holds parsed archive data in memory to avoid repetitive JSON.parse.
    // Key: Year (e.g., "2023"), Value: Parsed daily data map.
    unarchivedCache: Map<string, Record<string, Record<string, HabitDailyInfo>>>;
    
    // PERFORMANCE [2025-03-15]: Nested Maps for O(1) access without string allocation overhead.
    // Structure: Map<HabitID, Map<DateISO, Value>>
    streaksCache: Map<string, Map<string, number>>;
    habitAppearanceCache: Map<string, Map<string, boolean>>;
    scheduleCache: Map<string, Map<string, HabitSchedule | null>>;
    
    // Flat caches (Key: DateISO)
    activeHabitsCache: Map<string, Array<{ habit: Habit; schedule: TimeOfDay[] }>>;
    daySummaryCache: Map<string, any>;
    
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
        targetDate: string; // [2025-02-04] Snapshot of the date being edited to prevent context drift
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
    // PERFORMANCE [2025-01-26]: Dirty flags para controle granular de renderização UI.
    // Impede que o motor de renderização percorra toda a árvore do DOM se apenas uma meta mudou.
    uiDirtyState: {
        calendarVisuals: boolean; // Verdadeiro se a seleção de data ou o intervalo de dias mudou.
        habitListStructure: boolean; // Verdadeiro se a ordem, quantidade ou conteúdo textual dos hábitos mudou.
        chartData: boolean;
    };
} = {
    habits: [],
    dailyData: {},
    archives: {},
    unarchivedCache: new Map(),
    streaksCache: new Map(),
    habitAppearanceCache: new Map(),
    scheduleCache: new Map(),
    activeHabitsCache: new Map(),
    daySummaryCache: new Map(),
    // LOGIC UPDATE [2025-02-05]: Calendar range centered on today (30 past + Today + 30 future).
    // i=30 corresponds to Today (addDays(Today, 0)).
    // PERFORMANCE: Loop manual via Array.from é O(N) e evita custos de spread/push.
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
    },
    // PERFORMANCE: Inicializa como true para garantir a primeira renderização completa (FCP).
    uiDirtyState: {
        calendarVisuals: true,
        habitListStructure: true,
        chartData: true,
    }
};

// --- CACHE MANAGEMENT ---

/**
 * Consome a flag dirty do gráfico.
 * DO NOT REFACTOR: O reset da flag após a leitura é vital para garantir atomicidade.
 */
export function isChartDataDirty(): boolean {
    const wasDirty = state.uiDirtyState.chartData;
    if (wasDirty) {
        state.uiDirtyState.chartData = false; // Consome a flag
    }
    return wasDirty;
}

export function invalidateChartCache() {
    state.uiDirtyState.chartData = true;
}

/**
 * REFACTOR [2025-03-04]: Centralized AppState Snapshot.
 * PERFORMANCE: Cria um objeto plano para persistência rápida sem overhead de metadados de runtime.
 * Elimina duplicação across saveState, exportData, e cloud sync logic (DRY Principle).
 */
export function getPersistableState(): AppState {
    return {
        version: APP_VERSION,
        lastModified: Date.now(),
        habits: state.habits,
        dailyData: state.dailyData,
        archives: state.archives,
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds
    };
}

/**
 * Invalidação de Cache Unificada.
 * PERFORMANCE: Limpa apenas os caches afetados por mudanças estruturais de agendamento.
 */
export function clearScheduleCache() {
    state.scheduleCache.clear();
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    state.uiDirtyState.chartData = true;
}

/**
 * Invalidação de Cache de Visão.
 * PERFORMANCE: Limpa caches voláteis que não dependem do histórico fixo.
 */
export function clearActiveHabitsCache() {
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    state.uiDirtyState.chartData = true;
}


/**
 * Centraliza a invalidação de cache para mudanças em dados diários.
 */
export function invalidateCachesForDateChange(dateISO: string, habitIds: string[]) {
    state.uiDirtyState.chartData = true;
    state.daySummaryCache.delete(dateISO);
    
    // PERFORMANCE: Invalidação granular de streaks.
    habitIds.forEach(id => {
        // BUGFIX [2025-03-15]: Streak Integrity.
        // Mudar um status passado afeta o cálculo de streak para todas as datas futuras.
        // Devemos invalidar o cache COMPLETO do hábito, não apenas o dia atual.
        state.streaksCache.delete(id);
    });
}

// PERFORMANCE: Singleton empty object congelado para evitar alocação de memória (GC pressure) em acessos vazios.
const EMPTY_DAILY_INFO = Object.freeze({});

/**
 * LAZY LOADING ACCESSOR [2025-02-23]:
 * PERFORMANCE: Recupera dados diários com estratégia de "Warm Cache".
 * 1. Verifica Hot Storage (`dailyData`) - Instantâneo.
 * 2. Se falhar, verifica cache de memória de anos já lidos (`unarchivedCache`).
 * 3. Se falhar, realiza o JSON.parse apenas do bloco de ano necessário (`archives`).
 */
export function getHabitDailyInfoForDate(date: string): Record<string, HabitDailyInfo> {
    // 1. Check Hot Storage (Fastest)
    if (state.dailyData[date]) {
        return state.dailyData[date];
    }

    // 2. Check Archive Memory Cache
    const year = date.substring(0, 4);
    
    if (state.unarchivedCache.has(year)) {
        const yearData = state.unarchivedCache.get(year)!;
        return yearData[date] || (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
    }

    // 3. Check Cold Storage (Stringified JSON)
    if (state.archives[year]) {
        try {
            console.log(`Lazy loading archive for year ${year}...`);
            const parsedYearData = JSON.parse(state.archives[year]) as Record<string, Record<string, HabitDailyInfo>>;
            // PERFORMANCE: Cacheia em memória para evitar parsing repetitivo no mesmo loop de renderização.
            state.unarchivedCache.set(year, parsedYearData);
            return parsedYearData[date] || (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
        } catch (e) {
            console.error(`Error parsing archive for ${year}`, e);
        }
    }

    return (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
}

/**
 * REATORAÇÃO [2024-10-04]: Garante que a estrutura de dados diários exista para mutação.
 * DO NOT REFACTOR: A lógica de "Thawing" (descongelamento) é necessária para mover dados 
 * do Cold Storage para o Hot Storage antes de permitir edições.
 */
export function ensureHabitDailyInfo(date: string, habitId: string): HabitDailyInfo {
    if (!state.dailyData[date]) {
        const archivedDay = getHabitDailyInfoForDate(date);
        
        if (archivedDay !== EMPTY_DAILY_INFO) {
            // PERFORMANCE: structuredClone é mais eficiente que JSON parse/stringify para objetos profundos.
            state.dailyData[date] = structuredClone(archivedDay);
        } else {
            state.dailyData[date] = {};
        }
    }

    state.dailyData[date][habitId] ??= { instances: {} };
    return state.dailyData[date][habitId];
}

export function ensureHabitInstanceData(date: string, habitId: string, time: TimeOfDay): HabitDayData {
    ensureHabitDailyInfo(date, habitId);
    state.dailyData[date][habitId].instances[time] ??= { status: 'pending' };
    return state.dailyData[date][habitId].instances[time]!;
}
