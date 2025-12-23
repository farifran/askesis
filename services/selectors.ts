
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ARQUITETURA]: Módulo de Seletores (Selectors Module).
// Este módulo centraliza toda a lógica de "leitura" e "cálculo" do estado da aplicação.
// Funções aqui são puras (Pure Functions): recebem o estado como entrada e retornar dados derivados,
// sem causar efeitos colaterais (side effects). Isso melhora a testabilidade, o cache e a manutenibilidade.

import { state, Habit, TimeOfDay, HabitSchedule, getHabitDailyInfoForDate, STREAK_LOOKBACK_DAYS } from '../state';
import { toUTCIsoDateString, parseUTCIsoDate, addDays, getTodayUTCIso } from '../utils';
import { getHabitDisplayInfo } from '../i18n';

// --- Internal Cache for Static Dates ---
// Anchor dates in schedules rarely change, but are read thousands of times during streak calculations.
// Memoizing the Date object prevents GC pressure from repetitive new Date() calls.
const _anchorDateCache = new Map<string, Date>();

function _getMemoizedDate(dateISO: string): Date {
    let date = _anchorDateCache.get(dateISO);
    if (!date) {
        date = parseUTCIsoDate(dateISO);
        _anchorDateCache.set(dateISO, date);
    }
    return date;
}

// --- Seletores de Agendamento (Schedule Selectors) ---

/**
 * Encontra o agendamento específico de um hábito que estava ativo em uma determinada data.
 * Utiliza cache aninhado (Habit -> Date) para otimizar buscas repetidas sem alocação de strings.
 */
export function getScheduleForDate(habit: Habit, dateISO: string): HabitSchedule | null {
    let subCache = state.scheduleCache.get(habit.id);
    if (!subCache) {
        subCache = new Map();
        state.scheduleCache.set(habit.id, subCache);
    }
    
    if (subCache.has(dateISO)) {
        return subCache.get(dateISO)!;
    }
    
    // OPTIMIZATION [2025-03-12]: Removed .sort().
    // The scheduleHistory array MUST be sorted by startDate upon insertion/loading.
    
    const schedule = habit.scheduleHistory.find(s =>
        dateISO >= s.startDate && (!s.endDate || dateISO < s.endDate)
    ) || null;

    subCache.set(dateISO, schedule);
    return schedule;
}

/**
 * Retorna o array de horários do dia (manhã, tarde, noite) para um hábito em uma data específica,
 * considerando os overrides de "Apenas Hoje".
 */
export function getEffectiveScheduleForHabitOnDate(habit: Habit, dateISO: string): TimeOfDay[] {
    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    if (dailyInfo?.dailySchedule) {
        return dailyInfo.dailySchedule;
    }
    const schedule = getScheduleForDate(habit, dateISO);
    return schedule?.times || [];
}

/**
 * Determina se um hábito deve aparecer em uma data específica com base em sua frequência.
 * Utiliza cache aninhado para performance.
 * PERFORMANCE [2025-03-13]: Accepts optional preParsedDate to avoid creating new Date objects in tight loops.
 */
export function shouldHabitAppearOnDate(habit: Habit, dateISO: string, preParsedDate?: Date): boolean {
    let subCache = state.habitAppearanceCache.get(habit.id);
    if (!subCache) {
        subCache = new Map();
        state.habitAppearanceCache.set(habit.id, subCache);
    }

    if (subCache.has(dateISO)) {
        return subCache.get(dateISO)!;
    }

    const schedule = getScheduleForDate(habit, dateISO);
    if (!schedule || habit.graduatedOn) {
        subCache.set(dateISO, false);
        return false;
    }

    // OPTIMIZATION: Use injected date object if available to avoid parsing overhead
    const date = preParsedDate || parseUTCIsoDate(dateISO);
    const frequency = schedule.frequency;
    let appears = false;

    switch (frequency.type) {
        case 'daily':
            appears = true;
            break;
        case 'interval':
            // PERFORMANCE [2025-03-18]: Use Memoized Date for Anchor.
            const anchorDate = _getMemoizedDate(schedule.scheduleAnchor || schedule.startDate);
            const diffTime = date.getTime() - anchorDate.getTime();
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
            if (frequency.unit === 'days') {
                appears = diffDays >= 0 && diffDays % frequency.amount === 0;
            } else { // weeks
                const diffWeeks = Math.floor(diffDays / 7);
                appears = diffDays >= 0 && date.getUTCDay() === anchorDate.getUTCDay() && diffWeeks % frequency.amount === 0;
            }
            break;
        case 'specific_days_of_week':
            appears = frequency.days.includes(date.getUTCDay());
            break;
    }

    subCache.set(dateISO, appears);
    return appears;
}


// --- Seletores de Dados e Estatísticas (Data & Stats Selectors) ---

/**
 * Calcula a sequência (streak) atual de um hábito até uma data específica.
 * Usa cache aninhado e um lookback limitado para performance.
 */
export function calculateHabitStreak(habitId: string, endDateISO: string): number {
    let subCache = state.streaksCache.get(habitId);
    if (!subCache) {
        subCache = new Map();
        state.streaksCache.set(habitId, subCache);
    }

    if (subCache.has(endDateISO)) {
        return subCache.get(endDateISO)!;
    }

    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return 0;

    let streak = 0;
    const iteratorDate = parseUTCIsoDate(endDateISO);

    for (let i = 0; i < STREAK_LOOKBACK_DAYS; i++) {
        const currentDateISO = toUTCIsoDateString(iteratorDate);
        if (currentDateISO < habit.createdOn) break;

        // Pass the iteratorDate directly to avoid re-parsing inside shouldHabitAppearOnDate
        if (shouldHabitAppearOnDate(habit, currentDateISO, iteratorDate)) {
            const schedule = getEffectiveScheduleForHabitOnDate(habit, currentDateISO);
            const dailyInfo = getHabitDailyInfoForDate(currentDateISO)[habitId];
            
            if (schedule.length > 0) {
                const allDoneOrSnoozed = schedule.every(time => {
                    const status = dailyInfo?.instances[time]?.status;
                    return status === 'completed' || status === 'snoozed';
                });
                if (allDoneOrSnoozed) {
                    streak++;
                } else {
                    break;
                }
            }
        }
        iteratorDate.setUTCDate(iteratorDate.getUTCDate() - 1);
    }
    
    subCache.set(endDateISO, streak);
    return streak;
}

/**
 * Calcula a meta "inteligente" para um hábito numérico em um dia.
 * A meta aumenta com a sequência (streak) para incentivar o progresso.
 */
export function getSmartGoalForHabit(habit: Habit, dateISO: string, time: TimeOfDay): number {
    if (habit.goal.type === 'check' || !habit.goal.total) {
        return 1;
    }

    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    if (dailyInfo?.instances[time]?.goalOverride) {
        return dailyInfo.instances[time].goalOverride;
    }
    
    const baseGoal = habit.goal.total;
    const streak = calculateHabitStreak(habit.id, toUTCIsoDateString(addDays(parseUTCIsoDate(dateISO), -1)));
    
    const streakBonus = Math.floor(streak / 7) * 5; // +5 for every week of streak
    return Math.max(5, baseGoal + streakBonus);
}

/**
 * Obtém a meta atual para uma instância de hábito, considerando overrides e metas inteligentes.
 */
export function getCurrentGoalForInstance(habit: Habit, dateISO: string, time: TimeOfDay): number {
    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    return dailyInfo?.instances[time]?.goalOverride ?? getSmartGoalForHabit(habit, dateISO, time);
}


/**
 * Retorna uma lista de hábitos que estão ativos em uma data específica.
 * Usa cache para otimizar a performance.
 * PERFORMANCE [2025-03-13]: Accepts optional preParsedDate.
 */
export function getActiveHabitsForDate(dateISO: string, preParsedDate?: Date): Array<{ habit: Habit, schedule: TimeOfDay[] }> {
    if (state.activeHabitsCache.has(dateISO)) {
        return state.activeHabitsCache.get(dateISO)!;
    }
    
    const activeHabits = state.habits
        .filter(habit => shouldHabitAppearOnDate(habit, dateISO, preParsedDate))
        .map(habit => ({
            habit,
            schedule: getEffectiveScheduleForHabitOnDate(habit, dateISO)
        }))
        .filter(item => item.schedule.length > 0);
    
    // No explicit limit for this cache; relying on GC or global clears.
    state.activeHabitsCache.set(dateISO, activeHabits);
    return activeHabits;
}

/**
 * Calcula um resumo do dia: total de hábitos, concluídos, adiados, etc.
 * Usa cache para performance.
 * PERFORMANCE [2025-03-13]: Accepts optional preParsedDate to optimize loop usage.
 */
export function calculateDaySummary(dateISO: string, preParsedDate?: Date) {
    if (state.daySummaryCache.has(dateISO)) {
        return state.daySummaryCache.get(dateISO);
    }

    const activeHabits = getActiveHabitsForDate(dateISO, preParsedDate);
    let total = 0;
    let completed = 0;
    let snoozed = 0;
    let pending = 0;
    let hasNumericOverachieved = false;

    // OPTIMIZATION [2025-03-16]: Hoist data retrieval out of the loop.
    // getHabitDailyInfoForDate returns a map of { [habitId]: info }.
    // Fetching it once avoids repeated checks/unarchiving inside the habit loop.
    const dailyInfoMap = getHabitDailyInfoForDate(dateISO);

    for (const { habit, schedule } of activeHabits) {
        // Direct O(1) access from the pre-fetched map
        const dailyInfo = dailyInfoMap[habit.id];
        
        for (const time of schedule) {
            total++;
            const instance = dailyInfo?.instances[time];
            const status = instance?.status || 'pending';
            
            if (status === 'completed') {
                completed++;
                if ((habit.goal.type === 'pages' || habit.goal.type === 'minutes') && habit.goal.total) {
                     const currentGoal = getCurrentGoalForInstance(habit, dateISO, time);
                     if (currentGoal > habit.goal.total) {
                         hasNumericOverachieved = true;
                     }
                }
            } else if (status === 'snoozed') {
                snoozed++;
            } else {
                pending++;
            }
        }
    }
    
    const summary = {
        total,
        completed,
        snoozed,
        pending,
        completedPercent: total > 0 ? (completed / total) * 100 : 0,
        snoozedPercent: total > 0 ? (snoozed / total) * 100 : 0,
        showPlusIndicator: hasNumericOverachieved
    };
    
    state.daySummaryCache.set(dateISO, summary);
    return summary;
}

/**
 * Verifica se um nome de hábito já existe, ignorando o próprio hábito durante a edição.
 * @param name O nome a ser verificado.
 * @param currentHabitId O ID do hábito que está sendo editado, para ser excluído da verificação.
 * @returns `true` se o nome for um duplicado, `false` caso contrário.
 */
export function isHabitNameDuplicate(name: string, currentHabitId?: string): boolean {
    const normalizedNewName = name.trim().toLowerCase();
    if (!normalizedNewName) {
        return false;
    }

    // PERFORMANCE [2025-03-16]: Hoisted today calculation out of the loop.
    const todayISO = getTodayUTCIso();

    return state.habits.some(habit => {
        if (habit.id === currentHabitId) {
            return false;
        }
        // Usa a data de hoje como contexto para o nome do hábito existente.
        const { name: existingHabitName } = getHabitDisplayInfo(habit, todayISO);
        return existingHabitName.trim().toLowerCase() === normalizedNewName;
    });
}
