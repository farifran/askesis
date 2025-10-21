/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// FIX: Corrected typo in function name from 'toUTCIsoString' to 'toUTCIsoDateString' to match the export from './state'.
// FIX: Imported TimeOfDay to use in timeToKeyMap.
import { state, getHabitDailyInfoForDate, shouldHabitAppearOnDate, HabitStatus, TimeOfDay, Habit } from "./state";
import { addDays, getTodayUTC, toUTCIsoDateString, parseUTCIsoDate } from './utils';
import { t, getLocaleDayName, getHabitDisplayInfo } from "./i18n";

const statusToSymbol: Record<HabitStatus, string> = {
    completed: '✅',
    snoozed: '➡️',
    pending: '⚪️'
};

// FIX: Added a map to translate TimeOfDay values to translation keys.
const timeToKeyMap: Record<TimeOfDay, string> = {
    'Manhã': 'filterMorning',
    'Tarde': 'filterAfternoon',
    'Noite': 'filterEvening'
};

/**
 * Traverses the habit version history to retrieve the full lineage of a habit.
 * @param habitId The ID of the latest version of the habit.
 * @returns An array of habit objects, chronologically sorted.
 */
function getHabitLineage(habitId: string): Habit[] {
    const lineage: Habit[] = [];
    let currentHabit: Habit | undefined = state.habits.find(h => h.id === habitId);
    while (currentHabit) {
        lineage.unshift(currentHabit); // Add to the beginning to keep it in chronological order
        if (currentHabit.previousVersionId) {
            currentHabit = state.habits.find(h => h.id === currentHabit!.previousVersionId);
        } else {
            break;
        }
    }
    return lineage;
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
            const isoDate = toUTCIsoDateString(date);
            const dailyInfoByHabit = getHabitDailyInfoForDate(isoDate);
            const habitsOnThisDay = state.habits.filter(h => shouldHabitAppearOnDate(h, date) && !h.graduatedOn);

            if (habitsOnThisDay.length > 0) {
                const dayEntries = habitsOnThisDay.map(habit => {
                    const dailyInfo = dailyInfoByHabit[habit.id];
                    const habitInstances = dailyInfo?.instances || {};
                    const scheduleForDay = dailyInfo?.dailySchedule || habit.times;
                    const { name } = getHabitDisplayInfo(habit);

                    const statusDetails = scheduleForDay.map(time => {
                        const instance = habitInstances[time];
                        const status: HabitStatus = instance?.status || 'pending';
                        const note = instance?.note;
                        
                        let detail = statusToSymbol[status];
                        if (scheduleForDay.length > 1) {
                            detail = `${t(timeToKeyMap[time])}${detail}`;
                        }

                        if (note) {
                            detail += ` ("${note}")`;
                        }
                        return detail;
                    });
                    
                    return `- ${name}: ${statusDetails.join(', ')}`;
                });
                daySummaries.push(`${isoDate}:\n${dayEntries.join('\n')}`);
            }
        }
        history = daySummaries.join('\n\n');

    } else if (analysisType === 'general') {
        promptTemplateKey = 'aiPromptGeneral';
        
        // Find the earliest date any habit was created to define the start of our history scan.
        let firstDateEver = today;
        if (state.habits.length > 0) {
            firstDateEver = state.habits.reduce((earliest, habit) => {
                const habitStartDate = parseUTCIsoDate(habit.createdOn);
                return habitStartDate < earliest ? habitStartDate : earliest;
            }, today);
        }
        
        const allHistory: { date: string, entries: string[] }[] = [];
        
        // Iterate from the very first day until today.
        for (let d = firstDateEver; d <= today; d = addDays(d, 1)) {
            const dateISO = toUTCIsoDateString(d);
            const dailyInfoByHabit = getHabitDailyInfoForDate(dateISO);
            const habitsOnThisDay = state.habits.filter(h => shouldHabitAppearOnDate(h, d));

            if (habitsOnThisDay.length > 0) {
                const dayEntries = habitsOnThisDay.map(habit => {
                    const dailyInfo = dailyInfoByHabit[habit.id];
                    const habitInstances = dailyInfo?.instances || {};
                    const scheduleForDay = dailyInfo?.dailySchedule || habit.times;
                    const { name } = getHabitDisplayInfo(habit);

                    const statusDetails = scheduleForDay.map(time => {
                         const status = habitInstances[time]?.status || 'pending';
                         return statusToSymbol[status];
                    });
                    return `- ${name}: ${statusDetails.join('')}`;
                });
                allHistory.push({ date: dateISO, entries: dayEntries });
            }
        }
        
        // Summarize by month to keep the prompt manageable.
        const summaryByMonth: Record<string, string[]> = {};
        allHistory.forEach(day => {
            const month = day.date.substring(0, 7); // YYYY-MM
            if (!summaryByMonth[month]) {
                summaryByMonth[month] = [];
            }
            summaryByMonth[month].push(`${day.date}:\n${day.entries.join('\n')}`);
        });

        history = Object.entries(summaryByMonth)
            .map(([month, entries]) => `${t('aiPromptMonthHeader', { month })}:\n${entries.join('\n')}`)
            .join('\n\n');
    }

    if (!history.trim()) {
        history = t('aiPromptNoData');
    }

    const activeHabits = state.habits.filter(h => !h.endedOn && !h.graduatedOn);
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
            headers: {
                'Content-Type': 'application/json',
            },
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
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep the last, possibly incomplete, line

            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const chunk = JSON.parse(line);
                        // Yield an object that mimics the Gemini SDK's stream chunk
                        if (chunk.text) {
                            yield { text: chunk.text };
                        }
                    } catch (e) {
                        console.error("Error parsing stream chunk:", line, e);
                    }
                }
            }
        }
        
        // Process any remaining data in the buffer after the stream closes
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
        // Re-throw so the UI can catch it.
        throw error;
    }
};
