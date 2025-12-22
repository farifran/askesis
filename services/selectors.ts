/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ARQUITETURA]: Módulo de Seletores (Selectors Module).
// Este módulo centraliza toda a lógica de "leitura" e "cálculo" do estado da aplicação.
// Funções aqui são puras (Pure Functions): recebem o estado como entrada e retornam dados derivados,
// sem causar efeitos colaterais (side effects). Isso melhora a testabilidade, o cache e a manutenibilidade.

import { state, Habit, TimeOfDay, HabitSchedule, HabitDailyInfo, STREAK_LOOKBACK_DAYS, MAX_CACHE_SIZE, getHabitDailyInfoForDate } from '../state';
import { toUTCIsoDateString, parseUTCIsoDate, addDays, getTodayUTCIso } from '../utils';

// --- Seletores de Agendamento (Schedule Selectors) ---

/**
 * Encontra o agendamento específico de um hábito que estava ativo em uma determinada data.
 * Utiliza cache para otimizar buscas repetidas.
 */
export function getScheduleForDate(habit: Habit, dateISO: string): HabitSchedule | null {
    const cacheKey = `${habit.id}|${dateISO}`;
    if (state.scheduleCache.has(cacheKey)) {
        return state.scheduleCache.get(cacheKey)!;
    }
    // Otimização: Ordena apenas uma vez se necessário, mas geralmente já está ordenado.
    habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
    const schedule = habit.scheduleHistory.find(s =>
        dateISO >= s.startDate && (!s.endDate || dateISO < s.endDate)
    ) || null;

    if (state.scheduleCache.size > MAX_CACHE_SIZE) state.scheduleCache.clear();
    state.scheduleCache.set(cacheKey, schedule);

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
 * Utiliza cache para performance.
 */
export function shouldHabitAppearOnDate(habit: Habit, dateISO: string): boolean {
    const cacheKey = `${habit.id}|${dateISO}`;
    if (state.habitAppearanceCache.has(cacheKey)) {
        return state.habitAppearanceCache.get(cacheKey)!;
    }

    const schedule = getScheduleForDate(habit, dateISO);
    if (!schedule || habit.graduatedOn) {
        state.habitAppearanceCache.set(cacheKey, false);
        return false;
    }

    const date = parseUTCIsoDate(dateISO);
    const frequency = schedule.frequency;
    let appears = false;

    switch (frequency.type) {
        case 'daily':
            appears = true;
            break;
        case 'interval':
            const anchorDate = parseUTCIsoDate(schedule.scheduleAnchor || schedule.startDate);
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

    if (state.habitAppearanceCache.size > MAX_CACHE_SIZE) state.habitAppearanceCache.clear();
    state.habitAppearanceCache.set(cacheKey, appears);
    return appears;
}


// --- Seletores de Dados e Estatísticas (Data & Stats Selectors) ---

/**
 * Calcula a sequência (streak) atual de um hábito até uma data específica.
 * Usa cache e um lookback limitado para performance.
 */
export function calculateHabitStreak(habitId: string, endDateISO: string): number {
    const cacheKey = `${habitId}|${endDateISO}`;
    if (state.streaksCache.has(cacheKey)) {
        return state.streaksCache.get(cacheKey)!;
    }

    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return 0;

    let streak = 0;
    const iteratorDate = parseUTCIsoDate(endDateISO);

    for (let i = 0; i < STREAK_LOOKBACK_DAYS; i++) {
        const currentDateISO = toUTCIsoDateString(iteratorDate);
        if (currentDateISO < habit.createdOn) break;

        if (shouldHabitAppearOnDate(habit, currentDateISO)) {
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
    
    if (state.streaksCache.size > MAX_CACHE_SIZE) state.streaksCache.clear();
    state.streaksCache.set(cacheKey, streak);
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
 */
export function getActiveHabitsForDate(dateISO: string): Array<{ habit: Habit, schedule: TimeOfDay[] }> {
    if (state.activeHabitsCache.has(dateISO)) {
        return state.activeHabitsCache.get(dateISO)!;
    }
    
    const activeHabits = state.habits
        .filter(habit => shouldHabitAppearOnDate(habit, dateISO))
        .map(habit => ({
            habit,
            schedule: getEffectiveScheduleForHabitOnDate(habit, dateISO)
        }))
        .filter(item => item.schedule.length > 0);
    
    if (state.activeHabitsCache.size > MAX_CACHE_SIZE) state.activeHabitsCache.clear();
    state.activeHabitsCache.set(dateISO, activeHabits);
    return activeHabits;
}

/**
 * Calcula um resumo do dia: total de hábitos, concluídos, adiados, etc.
 * Usa cache para performance.
 */
export function calculateDaySummary(dateISO: string) {
    if (state.daySummaryCache.has(dateISO)) {
        return state.daySummaryCache.get(dateISO);
    }

    const activeHabits = getActiveHabitsForDate(dateISO);
    let total = 0;
    let completed = 0;
    let snoozed = 0;
    let pending = 0;
    let hasNumericOverachieved = false;

    const dailyInfoForDate = getHabitDailyInfoForDate(dateISO);

    for (const { habit, schedule } of activeHabits) {
        const dailyInfo = dailyInfoForDate[habit.id];
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
    
    if (state.daySummaryCache.size > MAX_CACHE_SIZE) state.daySummaryCache.clear();
    state.daySummaryCache.set(dateISO, summary);
    return summary;
}