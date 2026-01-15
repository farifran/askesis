/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/sync.worker.ts
 * @description Web Worker para Processamento Pesado (CPU-Bound Tasks).
 * Agora suporta Arquitetura de Bitmasks, Serialização Binária e Cifragem Zero-Copy.
 */

import type { AppState, Habit, HabitDailyInfo, TimeOfDay, HabitSchedule } from '../state';
import { toUTCIsoDateString, parseUTCIsoDate, decompressString, MS_PER_DAY, compressToBuffer, decompressFromBuffer, arrayBufferToBase64, base64ToArrayBuffer } from '../utils';
import { encrypt, decryptToBuffer } from './crypto';
import { mergeStates } from './dataMerge';

// --- CONSTANTS (Bitmask Logic copy for Isolation) ---
const PERIOD_OFFSET: Record<string, number> = { 'Morning': 0, 'Afternoon': 2, 'Evening': 4 };
const HABIT_STATE = { NULL: 0, DONE: 1, DEFERRED: 2, DONE_PLUS: 3 };

// --- TYPES ---

type AIPromptPayload = {
    analysisType: 'monthly' | 'quarterly' | 'historical';
    habits: Habit[];
    dailyData: AppState['dailyData'];
    archives: AppState['archives'];
    monthlyLogs?: Map<string, bigint>; // NOVO: Bitmasks
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
        aiHistoryChange: string;
        aiHistoryChangeFrequency: string;
        aiHistoryChangeGoal: string;
        aiHistoryChangeTimes: string;
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

// --- WORKER-SIDE CACHE & LIMITS ---
const unarchivedCache = new Map<string, any>();
const _anchorDateCache = new Map<string, Date>();
const MAX_WORKER_CACHE_SIZE = 5; // Limita RAM do worker

// --- BITMASK HELPERS ---

function _getLogKey(habitId: string, dateISO: string): string {
    return `${habitId}_${dateISO.substring(0, 7)}`; // ID_YYYY-MM
}

/**
 * Lê o status de um hábito diretamente do Bitmask (BigInt).
 * Retorna HABIT_STATE.NULL (0) se não encontrado.
 */
function _getStatusFromBitmask(habitId: string, dateISO: string, time: TimeOfDay, logs?: Map<string, bigint>): number {
    if (!logs) return HABIT_STATE.NULL;
    const key = _getLogKey(habitId, dateISO);
    const log = logs.get(key);
    
    if (log !== undefined) {
        const day = parseInt(dateISO.substring(8, 10), 10);
        // Aritmética de ponteiro: (Dia - 1) * 6 bits + Offset do Período
        // ROBUSTEZ: Fallback para 0 se o time for inválido para evitar BigInt(NaN) crash.
        const offset = PERIOD_OFFSET[time] ?? 0;
        const bitPos = BigInt(((day - 1) * 6) + offset);
        // Extrai 2 bits e converte para número
        return Number((log >> bitPos) & 0b11n);
    }
    return HABIT_STATE.NULL;
}

// --- CLOUD SERIALIZATION HELPERS ---

/**
 * JSON Replacer Inteligente:
 * - Converte Map (monthlyLogs) para Array de Hex Strings.
 * - Converte Uint8Array (Archives Binários) para Base64 com prefixo 'B64:'.
 * - Mantém o resto intacto.
 */
function cloudReplacer(key: string, value: any) {
    // 1. Map -> Array (monthlyLogs específico com BigInt -> Hex)
    if (key === 'monthlyLogs' && value instanceof Map) {
        return Array.from(value.entries()).map(([k, v]) => {
            // Conversão BigInt -> Hex String
            return [k, typeof v === 'bigint' ? v.toString(16) : v];
        });
    }
    
    // 2. Uint8Array -> Base64 (Archives/Binaries)
    if (value instanceof Uint8Array) {
        // Segurança: Garante que estamos pegando o buffer correto
        // Se for um subarray (view), copiamos para garantir apenas os dados relevantes
        if (value.byteLength !== value.buffer.byteLength) {
             const copy = new Uint8Array(value);
             return 'B64:' + arrayBufferToBase64(copy.buffer);
        }
        return 'B64:' + arrayBufferToBase64(value.buffer);
    }
    
    // 3. Fallback genérico para BigInt isolados (não esperados, mas seguro ter)
    if (typeof value === 'bigint') {
        return value.toString();
    }
    
    return value;
}

/**
 * JSON Reviver Inteligente:
 * - Restaura Base64 (prefixo 'B64:') para Uint8Array.
 * - Restaura monthlyLogs para Map<string, bigint>.
 */
function cloudReviver(key: string, value: any) {
    // 1. Base64 -> Uint8Array
    if (typeof value === 'string' && value.startsWith('B64:')) {
        try {
            return new Uint8Array(base64ToArrayBuffer(value.substring(4)));
        } catch (e) {
            console.warn("Falha ao reviver binário B64", e);
            return value; // Retorna original se falhar
        }
    }
    
    // 2. Array -> Map (monthlyLogs)
    if (key === 'monthlyLogs' && Array.isArray(value)) {
        const map = new Map<string, bigint>();
        for (const [k, v] of value) {
            if (typeof v === 'string') {
                try {
                    // Reconstrói BigInt a partir de Hex ("0x" + string)
                    map.set(k, BigInt("0x" + v));
                } catch (e) {
                    // Ignora entradas malformadas
                }
            }
        }
        return map;
    }
    
    return value;
}

// --- CORE LOGIC ---

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

// HYBRID READER: Handles Uint8Array and String (GZIP/JSON)
const getDailyDataForDate = async (dateStr: string, dailyData: AppState['dailyData'], archives: AppState['archives']): Promise<Record<string, HabitDailyInfo>> => {
    if (dailyData[dateStr]) return dailyData[dateStr];
    const year = dateStr.substring(0, 4);
    if (unarchivedCache.has(year)) return unarchivedCache.get(year)[dateStr] || {};

    const raw = archives[year];
    if (raw) {
        try {
            let parsed: any;
            // 1. Binary Path
            if (raw instanceof Uint8Array) {
                const json = await decompressFromBuffer(raw);
                parsed = JSON.parse(json);
            } 
            // 2. Legacy String Path
            else if (typeof raw === 'string') {
                parsed = raw.startsWith('GZIP:') ? JSON.parse(await decompressString(raw.substring(5))) : JSON.parse(raw);
            } else {
                return {};
            }
            
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

/**
 * CLEAN ARCHITECTURE: Verifica consistência usando APENAS Bitmasks.
 * Assinatura limpa: Removemos dailyData/archives pois não são mais usados para ler status.
 */
function _isHabitConsistentlyDoneInWorker(habit: Habit, dateISO: string, schedule: HabitSchedule | null, monthlyLogs?: Map<string, bigint>): boolean {
    const times = schedule?.times || [];
    if (times.length === 0) return true;

    if (monthlyLogs) {
        for (const time of times) {
            const status = _getStatusFromBitmask(habit.id, dateISO, time as TimeOfDay, monthlyLogs);
            
            // Regra estrita: Apenas DONE (1) ou DONE_PLUS (3) contam como feito.
            // NULL (0) e DEFERRED (2) quebram a consistência para cálculo de streak.
            if (status !== HABIT_STATE.DONE && status !== HABIT_STATE.DONE_PLUS) {
                return false;
            }
        }
        return true;
    }

    // Se não houver monthlyLogs (ex: dados corrompidos ou não inicializados), assume falso.
    return false;
}

async function _calculateHabitStreakInWorker(habit: Habit, endDateISO: string, monthlyLogs?: Map<string, bigint>): Promise<number> {
    let streak = 0, currentTimestamp = parseUTCIsoDate(endDateISO).getTime();
    for (let i = 0; i < 365; i++) {
        const iterDate = new Date(currentTimestamp), currentISO = toUTCIsoDateString(iterDate);
        if (currentISO < habit.createdOn) break;
        if (_shouldHabitAppearOnDateInWorker(habit, currentISO, iterDate)) {
            const schedule = _getScheduleForDateInWorker(habit, currentISO);
            if (_isHabitConsistentlyDoneInWorker(habit, currentISO, schedule, monthlyLogs)) streak++;
            else break;
        }
        currentTimestamp -= MS_PER_DAY;
    }
    return streak;
}

async function _calculateSuccessRateInWorker(habit: Habit, todayISO: string, monthlyLogs: Map<string, bigint> | undefined, days: number): Promise<number> {
    let total = 0, done = 0, currentTimestamp = parseUTCIsoDate(todayISO).getTime();
    for (let i = 0; i < days; i++) {
        const iterDate = new Date(currentTimestamp), currentISO = toUTCIsoDateString(iterDate);
        if (currentISO < habit.createdOn) break;
        if (_shouldHabitAppearOnDateInWorker(habit, currentISO, iterDate)) {
            total++;
            const schedule = _getScheduleForDateInWorker(habit, currentISO);
            if (_isHabitConsistentlyDoneInWorker(habit, currentISO, schedule, monthlyLogs)) done++;
        }
        currentTimestamp -= MS_PER_DAY;
    }
    return total > 0 ? Math.round((done / total) * 100) : 0;
}

async function _getHistoryForPrompt(days: number, habits: Habit[], monthlyLogs: Map<string, bigint> | undefined, todayISO: string): Promise<string> {
    let history = ''; const date = parseUTCIsoDate(todayISO);
    for (let i = 0; i < days; i++) {
        const currentISO = toUTCIsoDateString(date);
        
        const dayHistory = habits.map(h => {
            const sch = (_getScheduleForDateInWorker(h, currentISO))?.times || [];
            if (sch.length === 0) return null;
            
            return sch.map(t => {
                // CLEAN: Leitura exclusiva do Bitmask
                const bitStatus = _getStatusFromBitmask(h.id, currentISO, t as TimeOfDay, monthlyLogs);
                
                if (bitStatus === HABIT_STATE.DONE || bitStatus === HABIT_STATE.DONE_PLUS) return '✅';
                if (bitStatus === HABIT_STATE.DEFERRED) return '➡️';
                return '⚪️'; // NULL
            }).join('');
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
            // Notas ainda residem no JSON, então mantemos a leitura.
            if (info?.instances) Object.values(info.instances).forEach(inst => { if (inst?.note) notes += `${currentISO}: ${inst.note}\n`; });
        }
        date.setUTCDate(date.getUTCDate() - 1);
    }
    return notes;
}

async function buildAIPrompt(payload: AIPromptPayload) {
    const { analysisType: type, habits, dailyData, archives, monthlyLogs, languageName, translations: t, todayISO } = payload;
    unarchivedCache.clear(); _anchorDateCache.clear();

    const active = habits.filter(h => !h.graduatedOn && !h.scheduleHistory[h.scheduleHistory.length - 1].endDate);
    const graduated = habits.filter(h => h.graduatedOn);

    const getDetails = async (list: Habit[]) => {
        if (list.length === 0) return t['aiPromptNone'] + '\n';
        let res = '';
        for (const h of list) {
            const { name } = getHabitDisplayInfo(h, t, todayISO);
            // CLEAN: Signature update
            const streak = await _calculateHabitStreakInWorker(h, todayISO, monthlyLogs);
            const success = await _calculateSuccessRateInWorker(h, todayISO, monthlyLogs, type === 'quarterly' ? 90 : (type === 'historical' ? 365 : 30));
            
            let historySummary = '';
            if (h.scheduleHistory && h.scheduleHistory.length > 1) {
                const changes: string[] = [];
                for (let i = 1; i < h.scheduleHistory.length; i++) {
                    const prev = h.scheduleHistory[i - 1];
                    const curr = h.scheduleHistory[i];
                    const date = curr.startDate;

                    if (JSON.stringify(prev.frequency) !== JSON.stringify(curr.frequency)) {
                        changes.push(t.aiHistoryChangeFrequency.replace('{date}', date));
                    }
                    if (JSON.stringify(prev.goal) !== JSON.stringify(curr.goal)) {
                        changes.push(t.aiHistoryChangeGoal.replace('{date}', date));
                    }
                    if (prev.times.join(',') !== curr.times.join(',')) {
                        changes.push(t.aiHistoryChangeTimes.replace('{date}', date));
                    }
                }
                if (changes.length > 0) {
                    historySummary = `  ${t.aiHistoryChange}\n${changes.map(c => `  ${c}`).join('\n')}\n`;
                }
            }

            let line = t['aiPromptHabitDetails']
                .replace('{habitName}', name)
                .replace('{streak}', String(streak))
                .replace('{successRate}', String(success))
                .replace('{aiStreakLabel}', t['aiStreakLabel'])
                .replace('{successRateLabel}', t[type === 'quarterly' ? 'aiSuccessRateLabelQuarterly' : (type === 'historical' ? 'aiSuccessRateLabelHistorical' : 'aiSuccessRateLabelMonthly')])
                .replace('{aiDaysUnit}', t['aiDaysUnit'])
                .replace('{historySummary}', historySummary);

            const schedule = _getScheduleForDateInWorker(h, todayISO);
            if (schedule?.philosophy) {
                const p = schedule.philosophy;
                line = line.replace('{aiVirtue}', t['aiVirtue']).replace('{virtue}', t[`stoicVirtue${p.virtue}`] || p.virtue).replace('{aiDiscipline}', t['aiDiscipline']).replace('{discipline}', t[`stoicDiscipline${p.discipline}`] || p.discipline).replace('{aiSphere}', t['aiSphere']).replace('{sphere}', t[`governanceSphere${p.sphere}`] || p.sphere);
            } else {
                line = line.substring(0, line.indexOf('(')).trim() + '\n';
            }
            res += line;
        }
        return res;
    };
    
    // Notes still require dailyData/archives
    const notes = await _getNotesForPrompt(dailyData, archives, todayISO);
    // History uses bitmasks only now
    const history = await _getHistoryForPrompt(type === 'quarterly' ? 90 : (type === 'historical' ? 180 : 30), active, monthlyLogs, todayISO);

    const prompt = t.promptTemplate
        .replace('{activeHabitDetails}', await getDetails(active))
        .replace('{graduatedHabitsSection}', graduated.length ? t['aiPromptGraduatedSection'].replace('{graduatedHabitDetails}', await getDetails(graduated)) : '')
        .replace('{notesSection}', notes.trim() ? t['aiPromptNotesSectionHeader'] + notes : '')
        .replace('{history}', history.trim() || t['aiPromptNoData']);

    return { prompt, systemInstruction: t['aiSystemInstruction'].replace('{languageName}', languageName) };
}

// BUG FIX: Implementada a função de construção de prompt para análise de citações
async function buildQuoteAnalysisPrompt(payload: QuoteAnalysisPayload) {
    const { notes, themeList, languageName, translations } = payload;
    const prompt = translations.aiPromptQuote
        .replace('{notes}', notes)
        .replace('{theme_list}', themeList);
        
    return { 
        prompt, 
        systemInstruction: translations.aiSystemInstructionQuote.replace('{languageName}', languageName) 
    };
}

async function pruneHabitFromArchives(payload: { habitId: string, archives: AppState['archives'], startYear: number }) {
    const { habitId, archives, startYear } = payload;
    const updates: Record<string, string | Uint8Array> = {};
    const currentYear = new Date().getUTCFullYear();

    for (let y = startYear; y <= currentYear; y++) {
        const yearKey = String(y);
        const raw = archives[yearKey];
        if (!raw) continue;

        try {
            let data: Record<string, HabitDailyInfo>;
            
            // Hybrid Read
            if (raw instanceof Uint8Array) {
                data = JSON.parse(await decompressFromBuffer(raw));
            } else if (typeof raw === 'string') {
                if (raw.startsWith('GZIP:')) {
                    data = JSON.parse(await decompressString(raw.substring(5)));
                } else {
                    data = JSON.parse(raw);
                }
            } else {
                continue;
            }

            let dirty = false;
            const dates = Object.keys(data);
            
            for (const date of dates) {
                if (data[date][habitId]) {
                    delete data[date][habitId];
                    dirty = true;
                    if (Object.keys(data[date]).length === 0) {
                        delete data[date];
                    }
                }
            }

            if (dirty) {
                if (Object.keys(data).length === 0) {
                    updates[yearKey] = ""; // Signal deletion
                } else {
                    // BINARY WRITE: Compress to Uint8Array (No Base64 overhead)
                    const compressed = await compressToBuffer(JSON.stringify(data));
                    updates[yearKey] = compressed;
                }
            }
        } catch (e) {
            console.error(`Prune error for year ${y}`, e);
        }
    }
    // Clean up cache after heavy op
    unarchivedCache.clear();
    return updates;
}

async function processArchival(buckets: Record<string, { additions: Record<string, HabitDailyInfo>, base: string | Uint8Array | undefined }>) {
    const updates: Record<string, string | Uint8Array> = {};
    
    for (const year in buckets) {
        const { additions, base } = buckets[year];
        let currentData: Record<string, HabitDailyInfo> = {};
        
        try {
            if (base) {
                // Hybrid Read
                if (base instanceof Uint8Array) {
                    currentData = JSON.parse(await decompressFromBuffer(base));
                } else if (typeof base === 'string') {
                    if (base.startsWith('GZIP:')) {
                        currentData = JSON.parse(await decompressString(base.substring(5)));
                    } else {
                        currentData = JSON.parse(base);
                    }
                }
            }

            Object.assign(currentData, additions);
            
            // BINARY WRITE: Compress to Uint8Array
            const compressed = await compressToBuffer(JSON.stringify(currentData));
            updates[year] = compressed;
        } catch (e) {
            console.error(`Archival error for year ${year}`, e);
        }
    }
    // Clean up cache after heavy op
    unarchivedCache.clear();
    return updates;
}

// --- MAIN LISTENER ---

self.onmessage = async (e: MessageEvent<any>) => {
    const { id, type, payload, key } = e.data;
    try {
        let result;
        if (type === 'encrypt') {
            // WORKFLOW: stringify -> compress -> encrypt -> base64
            const jsonString = JSON.stringify(payload, cloudReplacer);
            const compressedBuffer = await compressToBuffer(jsonString);
            const encryptedBuffer = await encrypt(compressedBuffer, key);
            // Codifica o buffer binário final para Base64 para transporte via JSON.
            result = arrayBufferToBase64(encryptedBuffer.buffer);
        }
        else if (type === 'decrypt') {
            // WORKFLOW: base64 -> decrypt -> decompress -> parse
            // Decodifica o Base64 da nuvem para um buffer binário.
            const encryptedBuffer = base64ToArrayBuffer(payload);
            // Descriptografa o buffer binário. O resultado ainda está comprimido.
            const decryptedBuffer = await decryptToBuffer(new Uint8Array(encryptedBuffer), key);
            // Descomprime o buffer para uma string JSON.
            const decompressedJSON = await decompressFromBuffer(decryptedBuffer);
            result = JSON.parse(decompressedJSON, cloudReviver);
        }
        else if (type === 'build-ai-prompt') result = await buildAIPrompt(payload);
        else if (type === 'build-quote-analysis-prompt') result = await buildQuoteAnalysisPrompt(payload);
        else if (type === 'merge') result = await mergeStates(payload.local, payload.incoming);
        else if (type === 'prune-habit') result = await pruneHabitFromArchives(payload);
        else if (type === 'archive') result = await processArchival(payload);
        else throw new Error(`Unknown type: ${type}`);
        
        self.postMessage({ id, status: 'success', result });
    } catch (err: any) {
        self.postMessage({ id, status: 'error', error: err.message });
    }
};
