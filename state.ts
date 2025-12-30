
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file state.ts
 * @description O Coração de Baixo Nível do Askesis (Kernel de Estado).
 * 
 * [KERNEL ARCHITECTURE - SINGULARITY LEVEL]:
 * Implementa uma arquitetura "Data-Oriented Design" (DOD) sobre um SharedArrayBuffer.
 * Substitui o modelo de objetos JS dispersos por alocação de memória contígua e 
 * Struct-of-Arrays (SoA) para maximizar a coerência de cache e eliminar GC pauses.
 * 
 * [UNIFIED STORAGE MANAGER]:
 * O Kernel agora atua como a única fonte da verdade para I/O de dados de hábitos.
 * Ele gerencia internamente o roteamento entre:
 * 1. HOT PATH: SharedArrayBuffer (Atomics) para dados recentes (Janela Deslizante).
 * 2. COLD PATH: Objetos JS (state.dailyData) para dados históricos antigos.
 * 
 * MEMORY LAYOUT DIAGRAM (1MB Total - Optimized Static Allocation):
 * -----------------------------------------------------------------------------------------
 * [ HEADER (64 Bytes) ]
 * | Magic (4B) | Version (4B) | HabitCount (4B) | Padding (4B) | LastModified (8B) | ... |
 * -----------------------------------------------------------------------------------------
 * [ HABIT METADATA (SoA - Static Capacity: 256 slots) ]
 * | IconIDs (512B)   | Uint16 | Index na Tabela de Ícones (Reservado para Futuro)       |
 * -----------------------------------------------------------------------------------------
 * [ DAILY DATA GRID (Hot Path - 366 Days * 3 TimeSlots) ]
 * | Status Grid (~280KB)| Uint8  | [HabitID * 366 * 3 + (DayIndex * 3 + TimeIndex)]     |
 * | Goal Grid   (~560KB)| Uint16 | [HabitID * 366 * 3 + (DayIndex * 3 + TimeIndex)]     |
 * -----------------------------------------------------------------------------------------
 */

import { getTodayUTCIso, addDays, parseUTCIsoDate } from './utils';

// --- CONSTANTS & SCHEMA DEFINITIONS ---

export const APP_VERSION = 7; // Bumped for Binary Architecture
export const MAX_HABITS = 256; // OPTIMIZATION: Reduced from 1024 to 256 (Human limit realistic)
export const MAX_DAYS_WINDOW = 366; // Rolling window for hot data (Buffer Size)
const MS_PER_DAY = 86400000;

// Calculation: Header + (HabitMeta) + (StatusGrid) + (GoalGrid)
// StatusGrid = 256 * 366 * 3 * 1 bytes ~= 281 KB
// GoalGrid   = 256 * 366 * 3 * 2 bytes ~= 562 KB
// Total Data ~= 843 KB.
// Safe Allocation: 1MB
export const KERNEL_SIZE = 1 * 1024 * 1024; // 1MB Fixed Allocation

// Offsets (Bytes) - Aligned for 64-bit architecture
const OFFSET_MAGIC = 0;       // 4 bytes
const OFFSET_VERSION = 4;     // 4 bytes
const OFFSET_HABIT_COUNT = 8; // 4 bytes
// OFFSET 12 is Padding (4 bytes) to align next Float64 to 8-byte boundary
const OFFSET_LAST_MODIFIED = 16; // 8 bytes (Float64)
const HEADER_SIZE = 64;

// Enums (Mapped to Uint8 for Zero-Copy Read)
export enum KernelHabitStatus {
    PENDING = 0,
    COMPLETED = 1,
    SNOOZED = 2,
    UNSET = 255
}

// Map TimeOfDay string to Index (0, 1, 2)
// EXPORTED FOR HFT ACCESS
export const TIME_INDEX_MAP: Record<string, number> = {
    'Morning': 0,
    'Afternoon': 1,
    'Evening': 2
};

// --- PUBLIC TYPES (Backward Compatibility) ---
// Mantidos para garantir que o resto da aplicação (UI/Logic) compile sem alterações.

export type HabitStatus = 'completed' | 'snoozed' | 'pending';
export type TimeOfDay = 'Morning' | 'Afternoon' | 'Evening';

export type Frequency =
    | { type: 'daily' }
    | { type: 'interval'; unit: 'days' | 'weeks'; amount: number }
    | { type: 'specific_days_of_week'; days: number[] };

export interface HabitDayData {
    status: HabitStatus;
    goalOverride: number | undefined;
    note: string | undefined;
}

export type HabitDailyInstances = Partial<Record<TimeOfDay, HabitDayData>>;

export interface HabitDailyInfo {
    instances: HabitDailyInstances;
    dailySchedule: TimeOfDay[] | undefined;
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

export interface AppState {
    version: number;
    lastModified: number;
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    archives: Record<string, string>;
    notificationsShown: string[];
    pending21DayHabitIds: string[];
    pendingConsolidationHabitIds: string[];
    // UI State
    aiState?: 'idle' | 'loading' | 'completed' | 'error';
    lastAIResult?: string | null;
    lastAIError?: string | null;
    hasSeenAIResult?: boolean;
    syncState?: 'syncInitial' | 'syncSaving' | 'syncSynced' | 'syncError';
}

// --- CONSTANTS (Logic) ---
export const DAYS_IN_CALENDAR = 61;
export const STREAK_SEMI_CONSOLIDATED = 21;
export const STREAK_CONSOLIDATED = 66;
export const STREAK_LOOKBACK_DAYS = 730;

export const TIMES_OF_DAY = ['Morning', 'Afternoon', 'Evening'] as const;

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

// --- KERNEL IMPLEMENTATION ---

export class StateKernel {
    public buffer: SharedArrayBuffer | ArrayBuffer;
    public isShared: boolean;
    
    // Header Views
    private headerView: DataView;
    
    // Hot Data Grids (PUBLIC FOR HFT OPTIMIZATION)
    public dailyStatusGrid: Uint8Array;
    public dailyGoalGrid: Uint16Array; // Phase 2 Expansion

    // String Management (Heap-based wrapper for now)
    // Maps HabitIndex (Int) -> UUID (String) for O(1) lookups
    private idRegistry: string[] = new Array(MAX_HABITS).fill('');
    private idLookup: Map<string, number> = new Map();
    
    constructor(existingBuffer?: SharedArrayBuffer | ArrayBuffer) {
        let bufferToUse = existingBuffer;

        if (bufferToUse) {
            if (bufferToUse.byteLength !== KERNEL_SIZE) {
                console.warn(`Kernel: Buffer size mismatch. Expected ${KERNEL_SIZE}, got ${bufferToUse.byteLength}. Resetting.`);
                bufferToUse = this._createBuffer();
            }
        } else {
            bufferToUse = this._createBuffer();
        }

        this.buffer = bufferToUse;
        
        // ROBUSTEZ: Verifica se estamos rodando em ambiente com suporte a SharedArrayBuffer
        // e se o buffer criado é de fato compartilhado.
        this.isShared = typeof SharedArrayBuffer !== 'undefined' && this.buffer instanceof SharedArrayBuffer;

        this.headerView = new DataView(this.buffer, 0, HEADER_SIZE);
        
        let offset = HEADER_SIZE;
        
        // Skip Metadata Area (Reserved for future Flag/Icon/Color optimization if needed)
        // Currently skipping ~5KB reserved space to maintain alignment
        offset += (MAX_HABITS * 5); 
        offset = (offset + 3) & ~3; // Align 4 bytes
        
        // 1. Daily Status Grid (Habits * Days * 3 TimesOfDay * 1 Byte)
        // Size: 256 * 366 * 3 bytes ~= 281 KB
        this.dailyStatusGrid = new Uint8Array(this.buffer, offset, MAX_HABITS * MAX_DAYS_WINDOW * 3);
        offset += (MAX_HABITS * MAX_DAYS_WINDOW * 3);
        
        // Align to 2 bytes for Uint16
        offset = (offset + 1) & ~1; 

        // 2. Daily Goal Grid (Habits * Days * 3 TimesOfDay * 2 Bytes)
        // Size: 256 * 366 * 3 * 2 bytes ~= 562 KB
        // 0 = No Override (Default), >0 = Override Value
        this.dailyGoalGrid = new Uint16Array(this.buffer, offset, MAX_HABITS * MAX_DAYS_WINDOW * 3);

        if (!existingBuffer) {
            this._initHeader();
        }
    }

    private _createBuffer(): SharedArrayBuffer | ArrayBuffer {
        // ROBUSTEZ: Fallback para ambientes sem Cross-Origin Isolation
        if (typeof SharedArrayBuffer !== 'undefined') {
            return new SharedArrayBuffer(KERNEL_SIZE);
        } else {
            return new ArrayBuffer(KERNEL_SIZE);
        }
    }

    private _initHeader() {
        this.headerView.setUint32(OFFSET_MAGIC, 0x41534B53, true); // 'ASKS'
        this.headerView.setUint32(OFFSET_VERSION, APP_VERSION, true);
        this.headerView.setUint32(OFFSET_HABIT_COUNT, 0, true);
        // Padding (bytes 12-15) implicitly zeroed
        this.setLastModified();
    }

    // --- Lifecycle Methods ---

    public reset() {
        // Zero out memory
        if (this.isShared) {
            // Assume single thread ownership
            this.dailyStatusGrid.fill(0);
            this.dailyGoalGrid.fill(0);
        } else {
            this.dailyStatusGrid.fill(0);
            this.dailyGoalGrid.fill(0);
        }
        
        // Reset Header
        this._initHeader();
        
        // Reset Registries
        this.idRegistry.fill('');
        this.idLookup.clear();
        
        console.log("Kernel: Memory Reset Complete.");
    }

    public get habitCount(): number {
        return this.headerView.getUint32(OFFSET_HABIT_COUNT, true);
    }

    private set habitCount(val: number) {
        this.headerView.setUint32(OFFSET_HABIT_COUNT, val, true);
    }

    public setLastModified() {
        this.headerView.setFloat64(OFFSET_LAST_MODIFIED, Date.now(), true);
    }

    // --- Atomic Operations ---

    public registerHabit(uuid: string): number {
        let index = this.idLookup.get(uuid);
        if (index !== undefined) return index;

        const count = this.habitCount;
        if (count >= MAX_HABITS) {
            console.error("Kernel Panic: MAX_HABITS exceeded");
            return -1;
        }

        index = count;
        this.habitCount = count + 1;
        
        this.idRegistry[index] = uuid;
        this.idLookup.set(uuid, index);
        
        return index;
    }

    public getHabitIndex(uuid: string): number {
        const idx = this.idLookup.get(uuid);
        return idx !== undefined ? idx : -1;
    }

    // --- Hot Path Accessors (With Cold Fallback) ---

    // PUBLIC FOR HFT
    public getDayIndex(dateISO: string): number {
        const date = parseUTCIsoDate(dateISO);
        // Math.floor para garantir inteiro. 86400000 = MS_PER_DAY.
        const epochDays = Math.floor(date.getTime() / MS_PER_DAY);
        
        // Modulo positivo seguro
        return ((epochDays % MAX_DAYS_WINDOW) + MAX_DAYS_WINDOW) % MAX_DAYS_WINDOW;
    }

    // UNIFIED ACCESSOR: Routes to Hot (Buffer) or Cold (Object) storage transparently
    public setDailyStatus(uuid: string, dateISO: string, time: TimeOfDay, status: KernelHabitStatus) {
        // Always register ID to ensure consistency
        const hIdx = this.registerHabit(uuid);
        
        if (isDateInKernelRange(dateISO) && hIdx !== -1) {
            // --- HOT PATH ---
            const dIdx = this.getDayIndex(dateISO);
            const tIdx = TIME_INDEX_MAP[time];
            const flatIdx = (hIdx * MAX_DAYS_WINDOW * 3) + (dIdx * 3) + tIdx;
            
            if (this.isShared) {
                Atomics.store(this.dailyStatusGrid, flatIdx, status);
            } else {
                this.dailyStatusGrid[flatIdx] = status;
            }
        } else {
            // --- COLD PATH ---
            // Fallback para edição de histórico antigo
            const statusStr = kernelToStatus(status);
            this._ensureColdStorage(dateISO, uuid, time).status = statusStr;
        }
        this.setLastModified();
    }

    // UNIFIED ACCESSOR
    public getDailyStatus(uuid: string, dateISO: string, time: TimeOfDay): KernelHabitStatus {
        const hIdx = this.getHabitIndex(uuid);
        
        if (isDateInKernelRange(dateISO) && hIdx !== -1) {
            // --- HOT PATH ---
            const dIdx = this.getDayIndex(dateISO);
            const tIdx = TIME_INDEX_MAP[time];
            const flatIdx = (hIdx * MAX_DAYS_WINDOW * 3) + (dIdx * 3) + tIdx;
            
            let status: number;
            if (this.isShared) {
                status = Atomics.load(this.dailyStatusGrid, flatIdx);
            } else {
                status = this.dailyStatusGrid[flatIdx];
            }
            return status as KernelHabitStatus;
        } else {
            // --- COLD PATH ---
            // Se o hábito não está no índice, assume pendente/unset
            if (hIdx === -1 && !state.dailyData[dateISO]?.[uuid]) return KernelHabitStatus.UNSET;
            
            const instance = state.dailyData[dateISO]?.[uuid]?.instances[time];
            const statusStr = instance?.status || 'pending';
            return statusToKernel(statusStr);
        }
    }

    // Phase 2: Goal Overrides (Unified)
    public setDailyGoal(uuid: string, dateISO: string, time: TimeOfDay, value: number) {
        const hIdx = this.registerHabit(uuid);
        
        if (isDateInKernelRange(dateISO) && hIdx !== -1) {
            // --- HOT PATH ---
            const dIdx = this.getDayIndex(dateISO);
            const tIdx = TIME_INDEX_MAP[time];
            const flatIdx = (hIdx * MAX_DAYS_WINDOW * 3) + (dIdx * 3) + tIdx;
            
            // Clamp to Uint16 range (0-65535)
            const safeValue = Math.min(Math.max(0, value), 65535);

            if (this.isShared) {
                Atomics.store(this.dailyGoalGrid, flatIdx, safeValue);
            } else {
                this.dailyGoalGrid[flatIdx] = safeValue;
            }
        } else {
            // --- COLD PATH ---
            const safeValue = value > 0 ? value : undefined;
            this._ensureColdStorage(dateISO, uuid, time).goalOverride = safeValue;
        }
        this.setLastModified();
    }

    public getDailyGoal(uuid: string, dateISO: string, time: TimeOfDay): number {
        const hIdx = this.getHabitIndex(uuid);
        
        if (isDateInKernelRange(dateISO) && hIdx !== -1) {
            // --- HOT PATH ---
            const dIdx = this.getDayIndex(dateISO);
            const tIdx = TIME_INDEX_MAP[time];
            const flatIdx = (hIdx * MAX_DAYS_WINDOW * 3) + (dIdx * 3) + tIdx;
            
            if (this.isShared) {
                return Atomics.load(this.dailyGoalGrid, flatIdx);
            } else {
                return this.dailyGoalGrid[flatIdx];
            }
        } else {
            // --- COLD PATH ---
            const instance = state.dailyData[dateISO]?.[uuid]?.instances[time];
            return instance?.goalOverride || 0;
        }
    }

    // Helper para manipulação segura de objetos legados
    private _ensureColdStorage(date: string, habitId: string, time: TimeOfDay): HabitDayData {
        if (!state.dailyData[date]) state.dailyData[date] = {};
        if (!state.dailyData[date][habitId]) state.dailyData[date][habitId] = { instances: {}, dailySchedule: undefined };
        if (!state.dailyData[date][habitId].instances[time]) {
            state.dailyData[date][habitId].instances[time] = { status: 'pending', goalOverride: undefined, note: undefined };
        }
        return state.dailyData[date][habitId].instances[time]!;
    }
}

// --- SINGLETON KERNEL ---
export const kernel = new StateKernel();

// --- STATE FACADE (Compatibility Layer) ---
// Mantém a interface de objeto JS para o resto da aplicação, mas sincroniza
// dados críticos com o Kernel binário.

// BITMASK UI FLAGS (Bleeding Edge)
export const UI_MASK_CALENDAR = 1; // 001
export const UI_MASK_LIST = 2;     // 010
export const UI_MASK_CHART = 4;    // 100

// HOT MEMORY: UI Dirty Bitmask (Static Integer)
// Used by render.ts for O(1) dirty checking.
export let uiGlobalDirtyMask = 7; // Initial state: 111 (All dirty)

export const state: {
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    archives: Record<string, string>;
    // ... caches and UI state
    unarchivedCache: Map<string, any>;
    streaksCache: Map<string, Map<string, number>>;
    habitAppearanceCache: Map<string, Map<string, boolean>>;
    scheduleCache: Map<string, Map<string, HabitSchedule | null>>;
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
    editingNoteFor: any;
    editingHabit: any;
    aiState: 'idle' | 'loading' | 'completed' | 'error';
    hasSeenAIResult: boolean;
    lastAIResult: string | null;
    lastAIError: string | null;
    syncState: any;
    fullCalendar: { year: number; month: number };
    // UI State: PROXY for Bitmask
    uiDirtyState: { calendarVisuals: boolean; habitListStructure: boolean; chartData: boolean };
} = {
    habits: [],
    dailyData: {}, // Now acts as "Complex Data Overlay" (Notes, Overrides)
    archives: {},
    unarchivedCache: new Map(),
    streaksCache: new Map(),
    habitAppearanceCache: new Map(),
    scheduleCache: new Map(),
    activeHabitsCache: new Map(),
    daySummaryCache: new Map(),
    calendarDates: Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => addDays(new Date(), i - 30)),
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
    // PROXY PATTERN: Writes to bitmask, reads from bitmask.
    get uiDirtyState() {
        return {
            get calendarVisuals() { return (uiGlobalDirtyMask & UI_MASK_CALENDAR) !== 0; },
            set calendarVisuals(v: boolean) { if(v) uiGlobalDirtyMask |= UI_MASK_CALENDAR; else uiGlobalDirtyMask &= ~UI_MASK_CALENDAR; },
            
            get habitListStructure() { return (uiGlobalDirtyMask & UI_MASK_LIST) !== 0; },
            set habitListStructure(v: boolean) { if(v) uiGlobalDirtyMask |= UI_MASK_LIST; else uiGlobalDirtyMask &= ~UI_MASK_LIST; },
            
            get chartData() { return (uiGlobalDirtyMask & UI_MASK_CHART) !== 0; },
            set chartData(v: boolean) { if(v) uiGlobalDirtyMask |= UI_MASK_CHART; else uiGlobalDirtyMask &= ~UI_MASK_CHART; }
        };
    },
    // Dummy setter to prevent assignment errors during init
    set uiDirtyState(v) {}
};

// --- DATA ACCESSORS (Kernel-Aware) ---

// Conversion Helpers
export function statusToKernel(s: HabitStatus): KernelHabitStatus {
    if (s === 'completed') return KernelHabitStatus.COMPLETED;
    if (s === 'snoozed') return KernelHabitStatus.SNOOZED;
    return KernelHabitStatus.PENDING;
}

export function kernelToStatus(k: KernelHabitStatus): HabitStatus {
    if (k === KernelHabitStatus.COMPLETED) return 'completed';
    if (k === KernelHabitStatus.SNOOZED) return 'snoozed';
    return 'pending';
}

export function resetKernel() {
    kernel.reset();
}

export function isChartDataDirty(): boolean {
    const wasDirty = (uiGlobalDirtyMask & UI_MASK_CHART) !== 0;
    if (wasDirty) uiGlobalDirtyMask &= ~UI_MASK_CHART;
    return wasDirty;
}

export function invalidateChartCache() {
    uiGlobalDirtyMask |= UI_MASK_CHART;
}

// PERSISTENCE SANITIZATION:
// Proxies cannot be cloned by IndexedDB (structured clone).
// We must traverse the dailyData and unwrap all proxies into plain objects.
// SOPA FIX [2025-04-22]: Force Kernel read for hot data.
function sanitizeDailyData(source: Record<string, Record<string, HabitDailyInfo>>): Record<string, Record<string, HabitDailyInfo>> {
    const clean: Record<string, Record<string, HabitDailyInfo>> = {};
    for (const date in source) {
        const dayRecord = source[date];
        const inKernel = isDateInKernelRange(date); // Check if this date is in kernel

        clean[date] = {};
        for (const habitId in dayRecord) {
            const habitInfo = dayRecord[habitId];
            const cleanInstances: HabitDailyInfo['instances'] = {};
            
            for (const tKey in habitInfo.instances) {
                const time = tKey as TimeOfDay;
                const instance = habitInfo.instances[time];
                
                if (instance) {
                    let status = instance.status;
                    let goalOverride = instance.goalOverride;

                    // SOPA: Force KERNEL READ if in range.
                    // The object properties in `source` might be stale because we block writes to them.
                    if (inKernel) {
                        const kStatus = kernel.getDailyStatus(habitId, date, time);
                        if (kStatus !== KernelHabitStatus.UNSET) {
                            status = kernelToStatus(kStatus);
                        }
                        
                        const kGoal = kernel.getDailyGoal(habitId, date, time);
                        if (kGoal > 0) {
                            goalOverride = kGoal;
                        } else {
                            // If kernel says 0 (unset), override is undefined.
                            goalOverride = undefined;
                        }
                    }

                    cleanInstances[time] = {
                        status: status,
                        goalOverride: goalOverride,
                        note: instance.note
                    };
                }
            }

            clean[date][habitId] = {
                dailySchedule: habitInfo.dailySchedule ? [...habitInfo.dailySchedule] : undefined,
                instances: cleanInstances
            };
        }
    }
    return clean;
}

export function getPersistableState(): AppState {
    return {
        version: APP_VERSION,
        lastModified: Date.now(),
        habits: state.habits,
        dailyData: sanitizeDailyData(state.dailyData),
        archives: state.archives,
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds
    };
}

export function clearScheduleCache() {
    state.scheduleCache.clear();
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    uiGlobalDirtyMask |= UI_MASK_CHART;
}

export function clearActiveHabitsCache() {
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    uiGlobalDirtyMask |= UI_MASK_CHART;
}

export function invalidateCachesForDateChange(dateISO: string, habitIds: string[]) {
    uiGlobalDirtyMask |= UI_MASK_CHART;
    state.daySummaryCache.delete(dateISO);
    for (const id of habitIds) {
        state.streaksCache.delete(id);
    }
}

export function isDateLoading(date: string): boolean {
    const year = date.substring(0, 4);
    const pendingKey = `${year}_pending`;
    return state.unarchivedCache.has(pendingKey);
}

// --- PROXY HANDLER FOR HYBRID DATA ---
// SOPA FIX: Cache proxies to prevent recursive wrapping (Proxy(Proxy(...)))
// and stack overflow errors.
const proxyCache = new WeakMap<object, HabitDayData>();

// ROLLING WINDOW LOCK:
// Instead of Year-based, we use a window centered on Today.
// Range: [Today - 180, Today + 180] approx.
// This ensures "Last Year" (Dec 31) stays in Kernel even if Today is Jan 1.
// 180 days margin prevents collision in 366 days buffer.
const WINDOW_HALF_SIZE = 180;

export function isDateInKernelRange(dateISO: string): boolean {
    const target = parseUTCIsoDate(dateISO).getTime();
    // Optimization: We could cache today's timestamp, but Date.now() is fast.
    // Using Date.now() ensures the window slides with the session.
    const now = Date.now(); 
    const diff = Math.abs(target - now);
    return diff < (WINDOW_HALF_SIZE * MS_PER_DAY);
}

// Intercepts reads/writes to `status` to route them to the Kernel.
// UPDATE: As escritas no Cold Path agora são feitas diretamente pelo Kernel.
// O Proxy é mantido principalmente para leituras transparentes na camada de UI/Seletores.
const createHabitInstanceProxy = (target: HabitDayData, habitId: string, date: string, time: TimeOfDay): HabitDayData => {
    // 1. Cache Hit (Fastest)
    if (proxyCache.has(target)) {
        return proxyCache.get(target)!;
    }

    const inKernel = isDateInKernelRange(date);

    // 2. SELF-HEALING / LAZY HYDRATION (Critical Fix for Reloads)
    if (inKernel) {
        // Status Hydration
        const currentKernelStatus = kernel.getDailyStatus(habitId, date, time);
        if (currentKernelStatus === KernelHabitStatus.PENDING && target.status && target.status !== 'pending') {
            kernel.setDailyStatus(habitId, date, time, statusToKernel(target.status));
        }
        
        // Goal Hydration (Phase 2)
        const currentKernelGoal = kernel.getDailyGoal(habitId, date, time);
        if (currentKernelGoal === 0 && target.goalOverride !== undefined) {
            kernel.setDailyGoal(habitId, date, time, target.goalOverride);
        }
    }

    // 3. Create Proxy
    const proxy = new Proxy(target, {
        get(obj, prop) {
            if (prop === 'status' && inKernel) {
                const kStatus = kernel.getDailyStatus(habitId, date, time);
                if (kStatus === KernelHabitStatus.UNSET) return 'pending';
                return kernelToStatus(kStatus);
            }
            // Phase 2: Goal Reading
            if (prop === 'goalOverride' && inKernel) {
                const kGoal = kernel.getDailyGoal(habitId, date, time);
                if (kGoal > 0) return kGoal; // 0 = undefined/unset in kernel logic
                return undefined;
            }
            return Reflect.get(obj, prop);
        },
        set(obj, prop, value) {
            if (prop === 'status') {
                // Use Kernel Unified Accessor (Handles both Hot and Cold logic)
                kernel.setDailyStatus(habitId, date, time, statusToKernel(value as HabitStatus));
                
                // Keep JS Object structure updated even if hot path handles value, 
                // ensures persistence traversal sees structure.
                return Reflect.set(obj, prop, value);
            }
            // Phase 2: Goal Writing
            if (prop === 'goalOverride') {
                const val = (value === undefined || value === null) ? 0 : Number(value);
                kernel.setDailyGoal(habitId, date, time, val);
                return Reflect.set(obj, prop, value);
            }
            return Reflect.set(obj, prop, value);
        }
    });

    // 4. Cache and Return
    proxyCache.set(target, proxy);
    return proxy;
};

// --- SOPA: RUNTIME VIEW POOL ---
// Cache transiente para visualizações de leitura (Render Loop) que ainda não foram persistidas.
// Garante estabilidade de referências (===) para o Virtual DOM do renderizador sem poluir a store persistente com objetos vazios.
const runtimeViewPool = new Map<string, Record<string, HabitDailyInfo>>();

// Helper to keep DRY
function _hydrateViewWithProxies(container: Record<string, HabitDailyInfo>, date: string) {
    for (const habit of state.habits) {
        kernel.registerHabit(habit.id); // Ensure kernel index
        
        if (!container[habit.id]) {
            container[habit.id] = { instances: {}, dailySchedule: undefined };
        }
        
        // We must ensure every relevant time slot has a proxy
        const times = habit.scheduleHistory[habit.scheduleHistory.length-1].times;
        
        for (const t of times) {
            if (!container[habit.id].instances[t]) {
                // Initialize empty object to be proxied
                container[habit.id].instances[t] = { status: 'pending', goalOverride: undefined, note: undefined };
            }
            
            // Wrap in Proxy (Cached via WeakMap inside the factory)
            container[habit.id].instances[t] = createHabitInstanceProxy(container[habit.id].instances[t]!, habit.id, date, t);
        }
    }
    return container;
}

// PERF: Optimized Accessor
// Reads Status from Kernel (Fast), Reads Notes from Object (Slow)
export function getHabitDailyInfoForDate(date: string): Record<string, HabitDailyInfo> {
    // 1. Hot Storage (Persisted/Modified)
    if (state.dailyData[date]) {
        return _hydrateViewWithProxies(state.dailyData[date], date);
    }

    // 2. View Pool (Read-Only Stable References for SOPA)
    let view = runtimeViewPool.get(date);
    if (!view) {
        view = {};
        runtimeViewPool.set(date, view);
    }
    
    return _hydrateViewWithProxies(view, date);
}

export function ensureHabitDailyInfo(date: string, habitId: string): HabitDailyInfo {
    kernel.registerHabit(habitId);
    
    // PROMOTE FROM POOL TO STATE (Write-On-Demand)
    if (!state.dailyData[date]) {
        // Se existia uma view cached, promovemos ela para o estado persistente
        if (runtimeViewPool.has(date)) {
            state.dailyData[date] = runtimeViewPool.get(date)!;
            runtimeViewPool.delete(date);
        } else {
            state.dailyData[date] = {};
        }
    }

    if (!state.dailyData[date][habitId]) state.dailyData[date][habitId] = { instances: {}, dailySchedule: undefined };
    
    return state.dailyData[date][habitId];
}

export function ensureHabitInstanceData(date: string, habitId: string, time: TimeOfDay): HabitDayData {
    const habitInfo = ensureHabitDailyInfo(date, habitId);
    
    if (!habitInfo.instances[time]) {
        habitInfo.instances[time] = { status: 'pending', goalOverride: undefined, note: undefined };
    }
    
    // Return Proxy to enable write-through to Kernel
    return createHabitInstanceProxy(habitInfo.instances[time]!, habitId, date, time);
}

export function getNextStatus(s: HabitStatus): HabitStatus {
    if (s === 'pending') return 'completed';
    if (s === 'completed') return 'snoozed';
    return 'pending';
}

// --- PREDEFINED TYPES & TEMPLATES ---
export type PredefinedHabit = {
    nameKey: string;
    subtitleKey: string;
    icon: string;
    color: string;
    times: TimeOfDay[];
    goal: Habit['goal'];
    frequency: Frequency;
    isDefault?: boolean;
};

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
