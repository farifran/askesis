/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state, getHabitDailyInfoForDate, shouldHabitAppearOnDate, HabitStatus, TimeOfDay, getEffectiveScheduleForHabitOnDate } from './state';
import { getHabitDisplayInfo, t } from './i18n';
import { addDays, getTodayUTC, toUTCIsoDateString, parseUTCIsoDate } from './utils';

// --- Lógica de Construção de Prompt ---

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

function generateDailyHabitSummary(date: Date): string | null {
    const isoDate = toUTCIsoDateString(date);
    const dailyInfoByHabit = getHabitDailyInfoForDate(isoDate);
    const habitsOnThisDay = state.habits.filter(h => shouldHabitAppearOnDate(h, date) && !h.graduatedOn);

    if (habitsOnThisDay.length === 0) return null;

    const dayEntries = habitsOnThisDay.map(habit => {
        const dailyInfo = dailyInfoByHabit[habit.id];
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, isoDate);
        if (scheduleForDay.length === 0) return '';
        
        const { name } = getHabitDisplayInfo(habit);
        const habitInstances = dailyInfo?.instances || {};

        const statusDetails = scheduleForDay.map(time => {
            const instance = habitInstances[time];
            const status: HabitStatus = instance?.status || 'pending';
            const note = instance?.note;
            
            let detail = statusToSymbol[status];
            if (scheduleForDay.length > 1) {
                detail = `${t(timeToKeyMap[time])}: ${detail}`;
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
        
        for (let d = firstDateEver; d <= today; d = addDays(d, 1)) {
            const summary = generateDailyHabitSummary(d);
            if (summary) {
                allSummaries.push(summary);
            }
        }
        
        const summaryByMonth: Record<string, string[]> = {};
        allSummaries.forEach(daySummary => {
            const dateStr = daySummary.substring(0, 10);
            const month = dateStr.substring(0, 7);
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

// --- Lógica de Chamada de API ---

/**
 * Busca e transmite uma análise de IA da API Gemini.
 * @param prompt O prompt completo para enviar ao modelo.
 * @param onStream Uma função de callback que recebe o texto acumulado da resposta à medida que chega.
 * @returns O texto completo da resposta.
 */
export async function fetchAIAnalysis(
    prompt: string,
    onStream: (accumulatedText: string) => void
): Promise<string> {
    const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: 'Failed to parse error response' }));
        throw new Error(`API request failed with status ${response.status}: ${errorBody.error || 'Unknown error'}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('Failed to get response reader');
    }

    const decoder = new TextDecoder();
    let fullText = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        onStream(fullText);
    }
    
    return fullText;
}