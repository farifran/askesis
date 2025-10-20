/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// FIX: Corrected typo in function name from 'toUTCIsoString' to 'toUTCIsoDateString' to match the export from './state'.
// FIX: Imported TimeOfDay to use in timeToKeyMap.
import { state, addDays, getHabitDailyInfoForDate, getTodayUTC, toUTCIsoDateString, shouldHabitAppearOnDate, HabitStatus, TimeOfDay } from "./state";
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

export const buildAIPrompt = (): string => {
    const daySummaries: string[] = [];

    for (let i = 0; i < 7; i++) {
        const date = addDays(getTodayUTC(), -i);
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
                    // Adiciona o nome do horário apenas para hábitos com múltiplos horários para economizar espaço
                    if (scheduleForDay.length > 1) {
                        // FIX: Used timeToKeyMap to get the correct translation key for the time of day.
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
    
    let history = daySummaries.join('\n\n');

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
    
    return t('aiPromptMain', {
        activeHabitList: activeHabitList,
        graduatedHabitsSection: graduatedHabitsSection,
        history: history
    });
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