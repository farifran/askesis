/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state, getHabitDailyInfoForDate, shouldHabitAppearOnDate, HabitStatus, TimeOfDay, Habit, getScheduleForDate } from "./state";
import { addDays, getTodayUTC, toUTCIsoDateString, parseUTCIsoDate } from './utils';
import { t, getHabitDisplayInfo } from "./i18n";

const statusToSymbol: Record<HabitStatus, string> = {
    completed: '✅',
    snoozed: '➡️',
    pending: '⚪️'
};

const timeToKeyMap: Record<TimeOfDay, string> = {
    'Manhã': 'filterMorning',
    'Tarde': 'filterAfternoon',
    'Noite': 'filterEvening'
};

/**
 * REATORAÇÃO: Função auxiliar para gerar o resumo de texto para um único dia.
 * @param date O objeto Date para o qual gerar o resumo.
 * @returns Uma string formatada para o prompt da IA, ou null se não houver hábitos ativos.
 */
function generateDailyHabitSummary(date: Date): string | null {
    const isoDate = toUTCIsoDateString(date);
    const dailyInfoByHabit = getHabitDailyInfoForDate(isoDate);
    const habitsOnThisDay = state.habits.filter(h => shouldHabitAppearOnDate(h, date) && !h.graduatedOn);

    if (habitsOnThisDay.length === 0) {
        return null;
    }

    const dayEntries = habitsOnThisDay.map(habit => {
        const dailyInfo = dailyInfoByHabit[habit.id];
        const activeSchedule = getScheduleForDate(habit, date);
        if (!activeSchedule) return '';
        
        const { name } = getHabitDisplayInfo({ ...habit, scheduleHistory: [activeSchedule] });
        const habitInstances = dailyInfo?.instances || {};
        const scheduleForDay = dailyInfo?.dailySchedule || activeSchedule.times;

        const statusDetails = scheduleForDay.map(time => {
            const instance = habitInstances[time];
            const status: HabitStatus = instance?.status || 'pending';
            const note = instance?.note;
            
            let detail = statusToSymbol[status];
            if (scheduleForDay.length > 1) {
                detail = `${t(timeToKeyMap[time])}${detail}`;
            }

            if ((habit.goal.type === 'pages' || habit.goal.type === 'minutes') && instance?.status === 'completed' && instance.goalOverride !== undefined) {
                const unit = t(habit.goal.unitKey, { count: instance.goalOverride });
                detail += ` ${instance.goalOverride} ${unit}`;
            }

            if (note) {
                detail += ` ("${note}")`;
            }
            return detail;
        });
        
        return `- ${name}: ${statusDetails.join(', ')}`;
    }).filter(Boolean);

    if (dayEntries.length > 0) {
        return `${isoDate}:\n${dayEntries.join('\n')}`;
    }

    return null;
}


export const buildAIPrompt = (analysisType: 'weekly' | 'monthly' | 'general'): string => {
    let history = '';
    let promptTemplateKey = '';
    const templateOptions: { [key: string]: string | undefined } = {};
    const daySummaries: string[] = [];
    const today = getTodayUTC();

    if (analysisType === 'weekly' || analysisType === 'monthly') {
        const daysToScan = analysisType === 'weekly' ? 7 : 30;
        promptTemplateKey = analysisType === 'weekly' ? 'aiPromptWeekly' : 'aiPromptMonthly';

        // REATORAÇÃO: Usa a função auxiliar para simplificar a coleta de dados.
        for (let i = 0; i < daysToScan; i++) {
            const date = addDays(today, -i);
            const summary = generateDailyHabitSummary(date);
            if (summary) {
                daySummaries.push(summary);
            }
        }
        history = daySummaries.join('\n\n');

    } else if (analysisType === 'general') {
        promptTemplateKey = 'aiPromptGeneral';
        
        let firstDateEver = today;
        if (state.habits.length > 0) {
            firstDateEver = state.habits.reduce((earliest, habit) => {
                const habitStartDate = parseUTCIsoDate(habit.createdOn);
                return habitStartDate < earliest ? habitStartDate : earliest;
            }, today);
        }
        
        const allSummaries: string[] = [];
        
        // REATORAÇÃO: Usa a função auxiliar para simplificar a coleta de dados.
        for (let d = firstDateEver; d <= today; d = addDays(d, 1)) {
            const summary = generateDailyHabitSummary(d);
            if (summary) {
                allSummaries.push(summary);
            }
        }
        
        // REATORAÇÃO: A lógica de agrupamento por mês agora opera em resumos já formatados.
        const summaryByMonth: Record<string, string[]> = {};
        allSummaries.forEach(daySummary => {
            const dateStr = daySummary.substring(0, 10); // Extrai 'YYYY-MM-DD'
            const month = dateStr.substring(0, 7); // Extrai 'YYYY-MM'
            if (!summaryByMonth[month]) {
                summaryByMonth[month] = [];
            }
            summaryByMonth[month].push(daySummary);
        });

        history = Object.entries(summaryByMonth)
            .map(([month, entries]) => `${t('aiPromptMonthHeader', { month })}:\n${entries.join('\n')}`)
            .join('\n\n');
    }

    if (!history.trim()) {
        history = t('aiPromptNoData');
    }

    const activeHabits = state.habits.filter(h => {
        const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
        return !lastSchedule.endDate && !h.graduatedOn;
    });
    const graduatedHabits = state.habits.filter(h => h.graduatedOn);

    const activeHabitList = activeHabits.map(h => getHabitDisplayInfo(h).name).join(', ') || t('aiPromptNone');
    
    let graduatedHabitsSection = '';
    if (graduatedHabits.length > 0) {
        const graduatedHabitList = graduatedHabits.map(h => getHabitDisplayInfo(h).name).join(', ');
        graduatedHabitsSection = t('aiPromptGraduatedSection', { graduatedHabitList });
    }
    
    const languageName = {
        'pt': 'Português (Brasil)',
        'en': 'English',
        'es': 'Español'
    }[state.activeLanguageCode] || 'Português (Brasil)';

    templateOptions.activeHabitList = activeHabitList;
    templateOptions.graduatedHabitsSection = graduatedHabitsSection;
    templateOptions.history = history;
    templateOptions.languageName = languageName;
    
    return t(promptTemplateKey, templateOptions);
};

export const getAIEvaluationStream = async function* (prompt: string) {
    try {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', },
            body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: `HTTP error! status: ${response.status}` }));
            throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }

        if (!response.body) {
            throw new Error("Response has no body");
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const chunk = JSON.parse(line);
                        if (chunk.text) {
                            yield { text: chunk.text };
                        }
                    } catch (e) {
                        console.error("Error parsing stream chunk:", line, e);
                    }
                }
            }
        }
        
        if (buffer.trim()) {
            try {
                const chunk = JSON.parse(buffer);
                 if (chunk.text) {
                    yield { text: chunk.text };
                }
            } catch (e) {
                console.error("Error parsing final stream chunk:", buffer, e);
            }
        }

    } catch (error) {
        console.error("API call to /api/generate failed:", error);
        throw error;
    }
};
