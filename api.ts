/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state, addDays, getHabitDailyInfoForDate, getTodayUTC, toUTCIsoDateString, shouldHabitAppearOnDate } from "./state";
import { t, getLocaleDayName, getHabitDisplayInfo } from "./i18n";

export const buildAIPrompt = (): string => {
    let history = `${t('aiPromptHistoryHeader')}\n`;
    for (let i = 0; i < 7; i++) {
        const date = addDays(getTodayUTC(), -i);
        const isoDate = toUTCIsoDateString(date);
        const dailyInfoByHabit = getHabitDailyInfoForDate(isoDate);
        const dayName = getLocaleDayName(date);
        history += `\n**${dayName} (${isoDate})**\n`;

        const habitsOnThisDay = state.habits.filter(h => shouldHabitAppearOnDate(h, date) && !h.graduatedOn);

        if (habitsOnThisDay.length > 0) {
            let dayEntries: string[] = [];
            for (const habit of habitsOnThisDay) {
                const dailyInfo = dailyInfoByHabit[habit.id];
                const habitInstances = dailyInfo?.instances || {};
                const scheduleForDay = dailyInfo?.dailySchedule || habit.times;
                const { name } = getHabitDisplayInfo(habit);
                
                if (scheduleForDay.length > 1) {
                    dayEntries.push(`- **${name}**:`);
                    scheduleForDay.forEach(time => {
                        const instance = habitInstances[time];
                        const status = instance?.status || 'pending';
                        const note = instance?.note;
                        let entry = `  - ${t(`filter${time}`)}: ${t(`aiPromptStatus_${status}`)}`;
                        if (note) {
                            entry += ` (${t('aiPromptNotePrefix')}"${note}")`;
                        }
                        dayEntries.push(entry);
                    });
                } else if (scheduleForDay.length === 1) {
                    const time = scheduleForDay[0];
                    const instance = habitInstances[time];
                    const status = instance?.status || 'pending';
                    const note = instance?.note;
                    let entry = `- **${name}**: ${t(`aiPromptStatus_${status}`)}`;
                    if (note) {
                        entry += ` (${t('aiPromptNotePrefix')}"${note}")`;
                    }
                    dayEntries.push(entry);
                }
            }
            history += dayEntries.join('\n');
        } else {
            history += t('aiPromptNoHabits');
        }
        history += "\n";
    }

    const activeHabits = state.habits.filter(h => !h.endedOn && !h.graduatedOn);
    const graduatedHabits = state.habits.filter(h => h.graduatedOn);

    const activeHabitList = activeHabits.map(h => getHabitDisplayInfo(h).name).join(', ') || 'Nenhum';
    
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