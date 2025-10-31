/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state, getHabitDailyInfoForDate, shouldHabitAppearOnDate, HabitStatus, TimeOfDay, getEffectiveScheduleForHabitOnDate } from './state';
import { getHabitDisplayInfo, t } from './i18n';
import { addDays, getTodayUTC, toUTCIsoDateString, parseUTCIsoDate } from './utils';
import { GoogleGenAI } from '@google/genai';

// --- Lógica de Construção de Prompt ---

const statusToSymbol: Record<HabitStatus, string> = {
    completed: '✅',
    snoozed: '➡️',
    pending: '⚪️'
};

const timeToKeyMap: Record<TimeOfDay, string> = {
    'Morning': 'filterMorning',
    'Afternoon': 'filterAfternoon',
    'Evening': 'filterEvening'
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

function buildAIPrompt(analysisType: 'weekly' | 'monthly' | 'general'): { prompt: string, systemInstruction: string } {
    let history = '';
    let promptTemplateKey = '';
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

    const systemInstruction = t('aiSystemInstruction', { languageName });
    const prompt = t(promptTemplateKey, {
        activeHabitList,
        graduatedHabitsSection,
        history,
    });
    
    return { prompt, systemInstruction };
};

export async function fetchAIAnalysisStream(
    analysisType: 'weekly' | 'monthly' | 'general',
    onChunk: (fullText: string) => void
): Promise<string> {
    const { prompt, systemInstruction } = buildAIPrompt(analysisType);

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
        const responseStream = await ai.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
            },
        });

        let fullText = '';
        for await (const chunk of responseStream) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                onChunk(fullText); // Chama o callback com o texto acumulado
            }
        }
        return fullText;

    } catch (error) {
        console.error("Gemini API request failed:", error);
        if (error instanceof Error) {
            throw new Error(`Gemini API Error: ${error.message}`);
        }
        throw new Error("An unknown error occurred with the Gemini API");
    }
}
