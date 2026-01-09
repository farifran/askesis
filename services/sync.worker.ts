
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/sync.worker.ts
 * @description Web Worker para Processamento Pesado (CPU-Bound Tasks).
 */

import type { AppState, Habit, HabitDailyInfo, TimeOfDay, HabitSchedule } from '../state';
import { toUTCIsoDateString, parseUTCIsoDate, decompressString, MS_PER_DAY } from '../utils';
import { encrypt, decrypt } from './crypto';
import { mergeStates } from './dataMerge';

// --- TYPES ---

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
        aiPromptHabitDetails: string;
        aiVirtue: string;
        aiDiscipline: string;
        aiSphere: string;
        stoicVirtueWisdom: string;
        stoicVirtueCourage: string;
        stoicVirtueJustice: string;
        stoicVirtueTemperance: string;
        stoicDisciplineDesire: string;
        stoicDisciplineAction: string;
        stoicDisciplineAssent: string;
        governanceSphereBiological: string;
        governanceSphereStructural: string;
        governanceSphereSocial: string;
        governanceSphereMental: string;
        aiPromptNotesSectionHeader: string;
        aiStreakLabel: string;
        aiSuccessRateLabelMonthly: string;
        aiSuccessRateLabelQuarterly: string;
        aiSuccessRateLabelHistorical: string;
        aiDaysUnit: string;
        [key: string]: string;
    };
    todayISO: string;
};

type QuoteAnalysisPayload = {
    notes: string;
    themeList: string;
    languageName: string;
    translations: {
        aiPromptQuote: string;
        aiSystemInstructionQuote: string;
    };
};

type MergePayload = {
    local: AppState;
    incoming: AppState;
};

// --- WORKER-SIDE CACHE & LIMITS ---
const unarchivedCache = new Map<string, any>();
const _anchorDateCache = new Map<string, Date>();
const MAX_WORKER_CACHE_SIZE = 5; // Limita RAM do worker

function _getScheduleForDateInWorker(habit: Habit, dateISO: string): HabitSchedule | null {
    const history = habit.scheduleHistory;
    for (let i = 0; i < history.length; i++) {
        const s = history[i];
        if (dateISO >= s.startDate && (!s.endDate || dateISO < s.endDate)) return s;
    }
    return null;
}

function getHabitDisplayInfo(habit: Habit, translations: Record<string, string>, dateISO: string): { name: string } {
    const schedule = _getScheduleForDateInWorker(habit, dateISO) || habit.scheduleHistory[habit.scheduleHistory.length - 1];
    if (schedule.nameKey && translations[schedule.nameKey]) return { name: translations[schedule.nameKey] };
    return { name: schedule.name || habit.id };
}

const getDailyDataForDate = async (dateStr: string, dailyData: AppState['dailyData'], archives: AppState['archives']): Promise<Record<string, HabitDailyInfo>> => {
    if (dailyData[dateStr]) return dailyData[dateStr];
    const year = dateStr.substring(0, 4);
    if (unarchivedCache.has(year)) return unarchivedCache.get(year)[dateStr] || {};

    if (archives[year]) {
        try {
            const raw = archives[year];
            const parsed = raw.startsWith('GZIP:') ? JSON.parse(await decompressString(raw.substring(5))) : JSON.parse(raw);
            
            // MEMORY GUARD: Poda do cache se exceder limite.
            if (unarchivedCache.size >= MAX_WORKER_CACHE_SIZE) {
                unarchivedCache.delete(unarchivedCache.keys().next().value);
            }
            
            unarchivedCache.set(year, parsed);
            return parsed[dateStr] || {};
        } catch { return {}; }
    }
    return {};
};

function _getMemoizedDate(dateISO: string): Date {
    let date = _anchorDateCache.get(dateISO);
    if (!date) {
        if (_anchorDateCache.size > 100) _anchorDateCache.clear();
        date = parseUTCIsoDate(dateISO);
        _anchorDateCache.set(dateISO, date);
    }
    return date;
}

function _shouldHabitAppearOnDateInWorker(habit: Habit, dateISO: string, preParsedDate?: Date): boolean {
    const schedule = _getScheduleForDateInWorker(habit, dateISO);
    if (!schedule || habit.graduatedOn) return false;
    const { frequency } = schedule;
    const date = preParsedDate || parseUTCIsoDate(dateISO);
    switch (frequency.type) {
        case 'daily': return true;
        case 'specific_days_of_week': return frequency.days.includes(date.getUTCDay());
        case 'interval':
            const anchorDate = _getMemoizedDate(schedule.scheduleAnchor || schedule.startDate);
            const diffDays = Math.round((date.getTime() - anchorDate.getTime()) / MS_PER_DAY);
            if (frequency.unit === 'days') return diffDays >= 0 && (diffDays % frequency.amount === 0);
            return diffDays >= 0 && date.getUTCDay() === anchorDate.getUTCDay() && (Math.floor(diffDays / 7) % frequency.amount === 0);
    }
    return false;
}

async function _isHabitConsistentlyDoneInWorker(habit: Habit, dateISO: string, dailyData: AppState['dailyData'], archives: AppState['archives']): Promise<boolean> {
    const schedule = (_getScheduleForDateInWorker(habit, dateISO))?.times || [];
    if (schedule.length === 0) return true;
    const dayRecord = await getDailyDataForDate(dateISO, dailyData, archives), dailyInfo = dayRecord[habit.id];
    for (const time of schedule) {
        const s = dailyInfo?.instances[time]?.status;
        if (s !== 'completed' && s !== 'snoozed') return false;
    }
    return true;
}

async function _calculateHabitStreakInWorker(habit: Habit, endDateISO: string, dailyData: AppState['dailyData'], archives: AppState['archives']): Promise<number> {
    let streak = 0, currentTimestamp = parseUTCIsoDate(endDateISO).getTime();
    for (let i = 0; i < 365; i++) {
        const iterDate = new Date(currentTimestamp), currentISO = toUTCIsoDateString(iterDate);
        if (currentISO < habit.createdOn) break;
        if (_shouldHabitAppearOnDateInWorker(habit, currentISO, iterDate)) {
            if (await _isHabitConsistentlyDoneInWorker(habit, currentISO, dailyData, archives)) streak++;
            else break;
        }
        currentTimestamp -= MS_PER_DAY;
    }
    return streak;
}

async function _calculateSuccessRateInWorker(habit: Habit, todayISO: string, dailyData: AppState['dailyData'], archives: AppState['archives'], days: number): Promise<number> {
    let total = 0, done = 0, currentTimestamp = parseUTCIsoDate(todayISO).getTime();
    for (let i = 0; i < days; i++) {
        const iterDate = new Date(currentTimestamp), currentISO = toUTCIsoDateString(iterDate);
        if (currentISO < habit.createdOn) break;
        if (_shouldHabitAppearOnDateInWorker(habit, currentISO, iterDate)) {
            total++;
            if (await _isHabitConsistentlyDoneInWorker(habit, currentISO, dailyData, archives)) done++;
        }
        currentTimestamp -= MS_PER_DAY;
    }
    return total > 0 ? Math.round((done / total) * 100) : 0;
}

async function _getHistoryForPrompt(days: number, habits: Habit[], dailyData: AppState['dailyData'], archives: AppState['archives'], todayISO: string): Promise<string> {
    let history = ''; const date = parseUTCIsoDate(todayISO);
    for (let i = 0; i < days; i++) {
        const currentISO = toUTCIsoDateString(date), dayRecord = await getDailyDataForDate(currentISO, dailyData, archives);
        const dayHistory = habits.map(h => {
            const sch = (_getScheduleForDateInWorker(h, currentISO))?.times || [];
            if (sch.length === 0) return null;
            const inst = dayRecord[h.id]?.instances || {};
            return sch.map(t => inst[t]?.status === 'completed' ? '✅' : (inst[t]?.status === 'snoozed' ? '➡️' : '⚪️')).join('');
        }).filter(Boolean).join(' | ');
        if (dayHistory) history += `${currentISO}: ${dayHistory}\n`;
        date.setUTCDate(date.getUTCDate() - 1);
    }
    return history;
}

async function _getNotesForPrompt(dailyData: AppState['dailyData'], archives: AppState['archives'], todayISO: string): Promise<string> {
    let notes = ''; const date = parseUTCIsoDate(todayISO);
    for (let i = 0; i < 30; i++) {
        const currentISO = toUTCIsoDateString(date), dayRecord = await getDailyDataForDate(currentISO, dailyData, archives);
        for (const id in dayRecord) {
            const info = dayRecord[id];
            if (info?.instances) Object.values(info.instances).forEach(inst => { if (inst?.note) notes += `${currentISO}: ${inst.note}\n`; });
        }
        date.setUTCDate(date.getUTCDate() - 1);
    }
    return notes;
}

async function buildAIPrompt(payload: AIPromptPayload) {
    const { analysisType: type, habits, dailyData, archives, languageName, translations: t, todayISO } = payload;
    unarchivedCache.clear(); _anchorDateCache.clear();

    const active = habits.filter(h => !h.graduatedOn && !h.scheduleHistory[h.scheduleHistory.length - 1].endDate);
    const graduated = habits.filter(h => h.graduatedOn);

    const getDetails = async (list: Habit[]) => {
        if (list.length === 0) return t['aiPromptNone'] + '\n';
        let res = '';
        for (const h of list) {
            const { name } = getHabitDisplayInfo(h, t, todayISO);
            const streak = await _calculateHabitStreakInWorker(h, todayISO, dailyData, archives);
            const success = await _calculateSuccessRateInWorker(h, todayISO, dailyData, archives, type === 'quarterly' ? 90 : (type === 'historical' ? 365 : 30));
            let line = t['aiPromptHabitDetails'].replace('{habitName}', name).replace('{streak}', String(streak)).replace('{successRate}', String(success)).replace('{aiStreakLabel}', t['aiStreakLabel']).replace('{successRateLabel}', t[type === 'quarterly' ? 'aiSuccessRateLabelQuarterly' : (type === 'historical' ? 'aiSuccessRateLabelHistorical' : 'aiSuccessRateLabelMonthly')]).replace('{aiDaysUnit}', t['aiDaysUnit']);
            if (h.philosophy) line = line.replace('{aiVirtue}', t['aiVirtue']).replace('{virtue}', t[`stoicVirtue${h.philosophy.virtue}`] || h.philosophy.virtue).replace('{aiDiscipline}', t['aiDiscipline']).replace('{discipline}', t[`stoicDiscipline${h.philosophy.discipline}`] || h.philosophy.discipline).replace('{aiSphere}', t['aiSphere']).replace('{sphere}', t[`governanceSphere${h.philosophy.sphere}`] || h.philosophy.sphere);
            else line = line.substring(0, line.indexOf('(')).trim() + '\n';
            res += line;
        }
        return res;
    };
    
    const notes = await _getNotesForPrompt(dailyData, archives, todayISO);
    const history = await _getHistoryForPrompt(type === 'quarterly' ? 90 : (type === 'historical' ? 180 : 30), active, dailyData, archives, todayISO);

    const prompt = t.promptTemplate
        .replace('{activeHabitDetails}', await getDetails(active))
        .replace('{graduatedHabitsSection}', graduated.length ? t['aiPromptGraduatedSection'].replace('{graduatedHabitDetails}', await getDetails(graduated)) : '')
        .replace('{notesSection}', notes.trim() ? t['aiPromptNotesSectionHeader'] + notes : '')
        .replace('{history}', history.trim() || t['aiPromptNoData']);

    return { prompt, systemInstruction: t['aiSystemInstruction'].replace('{languageName}', languageName) };
}

self.onmessage = async (e: MessageEvent<any>) => {
    const { id, type, payload, key } = e.data;
    try {
        let result;
        if (type === 'encrypt') result = await encrypt(JSON.stringify(payload), key);
        else if (type === 'decrypt') result = JSON.parse(await decrypt(payload, key));
        else if (type === 'build-ai-prompt') result = await buildAIPrompt(payload);
        else if (type === 'merge') result = await mergeStates(payload.local, payload.incoming);
        else throw new Error("Unknown type");
        self.postMessage({ id, status: 'success', result });
    } catch (err: any) {
        self.postMessage({ id, status: 'error', error: err.message });
    }
};
