/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import type { AppState, Habit, HabitDailyInfo } from '../state';
// DRY FIX [2025-03-08]: Import utils instead of duplicating them. 
import { toUTCIsoDateString, parseUTCIsoDate } from '../utils';
// MODULARITY: Import crypto functions from the dedicated module.
import { encrypt, decrypt } from './crypto';

// --- AI Prompt Building Logic ---

type AIPromptPayload = {
    analysisType: 'monthly' | 'quarterly' | 'historical';
    habits: Habit[];
    dailyData: AppState['dailyData'];
    archives: AppState['archives'];
    languageName: string;
    translations: {
        promptTemplate: string;
        aiPromptGraduatedSection: string;
        aiPromptNoData: string;
        aiPromptNone: string;
        aiSystemInstruction: string;
        [key: string]: string; // For habit name keys
    };
    todayISO: string;
};

// Simplified version of getHabitDisplayInfo for worker context
function getHabitDisplayInfo(habit: Habit, translations: Record<string, string>, dateISO: string): { name: string } {
    const schedule = habit.scheduleHistory.find(s => s.startDate <= dateISO && (!s.endDate || s.endDate > dateISO)) || habit.scheduleHistory[habit.scheduleHistory.length - 1];
    
    if (schedule.nameKey && translations[schedule.nameKey]) {
        return { name: translations[schedule.nameKey] };
    }
    return { name: schedule.name || habit.id };
}

function _getHistoryForPrompt(
    days: number,
    habits: Habit[],
    dailyData: AppState['dailyData'],
    archives: AppState['archives'],
    todayISO: string,
    translations: Record<string, string>
): string {
    let history = '';
    const date = parseUTCIsoDate(todayISO);
    
    // PERFORMANCE [WORKER-SIDE CACHE]: Caches parsed archive JSON to avoid re-parsing on every date lookup within the same AI analysis.
    const unarchivedCache = new Map<string, any>();
    
    const getDailyDataForDate = (dateStr: string): Record<string, HabitDailyInfo> => {
        if (dailyData[dateStr]) return dailyData[dateStr];
        
        const year = dateStr.substring(0, 4);
        if (unarchivedCache.has(year)) {
            return unarchivedCache.get(year)[dateStr] || {};
        }

        if (archives[year]) {
            try {
                const parsed = JSON.parse(archives[year]);
                unarchivedCache.set(year, parsed);
                return parsed[dateStr] || {};
            } catch {
                return {};
            }
        }
        return {};
    };

    for (let i = 0; i < days; i++) {
        const currentDateISO = toUTCIsoDateString(date);
        const dayRecord = getDailyDataForDate(currentDateISO);
        
        const dayHistory = habits.map(habit => {
            const schedule = habit.scheduleHistory.find(s => s.startDate <= currentDateISO && (!s.endDate || s.endDate > currentDateISO));
            if (!schedule) return null;

            const instances = dayRecord[habit.id]?.instances || {};
            const statuses = schedule.times.map(time => {
                const status = instances[time]?.status;
                if (status === 'completed') return '✅';
                if (status === 'snoozed') return '➡️';
                return '⚪️';
            });
            return statuses.join('');
        }).filter(Boolean).join(' | ');

        if (dayHistory) {
            history += `${currentDateISO}: ${dayHistory}\n`;
        }
        date.setUTCDate(date.getUTCDate() - 1);
    }

    return history || translations['aiPromptNoData'];
}


async function buildAIPrompt(payload: AIPromptPayload) {
    const { analysisType, habits, dailyData, archives, languageName, translations, todayISO } = payload;
    
    const promptTemplate = translations.promptTemplate;

    const activeHabits = habits.filter(h => {
        const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
        return !h.graduatedOn && !lastSchedule.endDate;
    });

    const graduatedHabits = habits.filter(h => h.graduatedOn);

    const getHabitListString = (habitList: Habit[]) => {
        return habitList.length > 0 ? habitList.map(h => getHabitDisplayInfo(h, translations, todayISO).name).join(', ') : translations['aiPromptNone'];
    };

    const activeHabitList = getHabitListString(activeHabits);
    const graduatedHabitList = getHabitListString(graduatedHabits);

    let graduatedHabitsSection = '';
    if (graduatedHabits.length > 0) {
        graduatedHabitsSection = translations['aiPromptGraduatedSection'].replace('{graduatedHabitList}', graduatedHabitList);
    }
    
    let daysToAnalyze = 30;
    if (analysisType === 'quarterly') daysToAnalyze = 90;
    if (analysisType === 'historical') {
        const firstHabitDate = habits.reduce((oldest, h) => {
            const created = h.createdOn;
            return created < oldest ? created : oldest;
        }, todayISO);
        const diffTime = Math.abs(parseUTCIsoDate(todayISO).getTime() - parseUTCIsoDate(firstHabitDate).getTime());
        daysToAnalyze = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    }
    
    const history = _getHistoryForPrompt(daysToAnalyze, activeHabits, dailyData, archives, todayISO, translations);

    const prompt = promptTemplate
        .replace('{activeHabitList}', activeHabitList)
        .replace('{graduatedHabitsSection}', graduatedHabitsSection)
        .replace('{history}', history);

    const systemInstruction = translations['aiSystemInstruction'].replace('{languageName}', languageName);
    
    return { prompt, systemInstruction };
}

// --- Worker Message Handler ---

type WorkerRequest = 
    | { id: string; type: 'encrypt'; payload: any; key: string }
    | { id: string; type: 'decrypt'; payload: string; key: string }
    | { id: string; type: 'build-ai-prompt'; payload: AIPromptPayload };

type WorkerResponse = 
    | { id: string; status: 'success'; result: any }
    | { id: string; status: 'error'; error: string };

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
    const { id, type, payload } = e.data;

    try {
        let result;

        if (type === 'encrypt') {
            const jsonString = JSON.stringify(payload);
            result = await encrypt(jsonString, (e.data as any).key);
        } else if (type === 'decrypt') {
            const jsonString = await decrypt(payload as string, (e.data as any).key);
            result = JSON.parse(jsonString);
        } else if (type === 'build-ai-prompt') {
            result = await buildAIPrompt(payload as AIPromptPayload);
        }
        else {
            throw new Error(`Unknown operation type: ${(e.data as any).type}`);
        }

        const response: WorkerResponse = { id, status: 'success', result };
        self.postMessage(response);

    } catch (error: any) {
        console.error(`Worker error during ${type}:`, error);
        const response: WorkerResponse = { 
            id, 
            status: 'error', 
            error: error.message || 'Unknown worker error' 
        };
        self.postMessage(response);
    }
};