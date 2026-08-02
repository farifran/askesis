
/**
 * @license
 * SPDX-License-Identifier: MIT
*/

/**
 * @file services/sync.worker.ts
 * @description Web Worker para Criptografia e Processamento de Dados Pesados.
 */

import { murmurHash3 } from './murmurHash3';
import { encrypt as encryptText, decrypt as decryptText } from './crypto';
import { type WorkerTaskMessage, type WorkerResponseMessage } from '../contracts/worker';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null;
}

function jsonReplacer(key: string, value: unknown) {
    if (typeof value === 'bigint') return { __type: 'bigint', val: value.toString() };
    if (value instanceof Map) return { __type: 'map', val: Array.from(value.entries()) };
    return value;
}

function jsonReviver(key: string, value: unknown) {
    if (isRecord(value)) {
        if (value.__type === 'bigint' && typeof value.val === 'string') return BigInt(value.val);
        if (value.__type === 'map' && Array.isArray(value.val)) return new Map(value.val as Array<[unknown, unknown]>);
    }
    if (typeof value === 'string' && value.startsWith('0x')) {
        try { return BigInt(value); } catch(e) { return value; }
    }
    return value;
}

// O envelope criptográfico vive em ./crypto (fonte única de verdade). Aqui ficam
// apenas as camadas de (de)serialização JSON que são específicas do worker.

async function encrypt(payload: unknown, password: string): Promise<string> {
    return encryptText(JSON.stringify(payload, jsonReplacer), password);
}

async function encryptJson(jsonText: string, password: string): Promise<string> {
    return encryptText(jsonText, password);
}

async function decrypt(encryptedBase64: string, password: string): Promise<unknown> {
    return JSON.parse(await decryptText(encryptedBase64, password), jsonReviver);
}

async function decryptWithHash(encryptedBase64: string, password: string): Promise<{ value: unknown; hash: string }> {
    const text = await decryptText(encryptedBase64, password);
    return { value: JSON.parse(text, jsonReviver), hash: murmurHash3(text) };
}

/**
 * Remove todos os rastros de um hábito de dentro dos arquivos JSON comprimidos.
 */
function pruneHabitFromArchives(habitId: string, archives: Record<string, unknown>): Record<string, string> {
    const updated: Record<string, string> = {};
    for (const year in archives) {
        let content = archives[year];
        if (typeof content === 'string') {
            try { content = JSON.parse(content); } catch { continue; }
        }

        if (!isRecord(content)) continue;
        
        let changed = false;
        for (const date in content) {
            const day = content[date];
            if (!isRecord(day)) continue;
            if (day[habitId]) {
                delete day[habitId];
                changed = true;
            }
            if (Object.keys(day).length === 0) delete content[date];
        }
        
        if (changed) {
            updated[year] = Object.keys(content).length === 0 ? "" : JSON.stringify(content);
        }
    }
    return updated;
}

self.onmessage = async (e: MessageEvent<WorkerTaskMessage>) => {
    const { id, type, payload, key } = e.data;
    try {
        let result: unknown;
        switch (type) {
            case 'encrypt': result = await encrypt(payload, key!); break;
            case 'encrypt-json': result = await encryptJson(String(payload || ''), key!); break;
            case 'decrypt': result = await decrypt(payload, key!); break;
            case 'decrypt-with-hash': result = await decryptWithHash(payload, key!); break;
            case 'build-ai-prompt': result = buildAiPrompt(payload); break;
            case 'build-quote-analysis-prompt': result = buildAiQuoteAnalysisPrompt(payload); break;
            case 'archive': result = processArchiving(payload); break;
            case 'prune-habit': {
                const p = isRecord(payload) ? payload : {};
                const habitId = typeof p.habitId === 'string' ? p.habitId : '';
                const archives = isRecord(p.archives) ? p.archives : {};
                result = pruneHabitFromArchives(habitId, archives);
                break;
            }
            default: throw new Error(`Task unknown: ${type}`);
        }
        const msg: WorkerResponseMessage = { id, status: 'success', result };
        self.postMessage(msg);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const msg: WorkerResponseMessage = { id, status: 'error', error: message };
        self.postMessage(msg);
    }
};

function buildAiPrompt(data: unknown) {
    const payload = isRecord(data) ? data : {};
    const habits = Array.isArray(payload.habits) ? payload.habits : [];
    const dailyData = isRecord(payload.dailyData) ? payload.dailyData : {};
    const translations = isRecord(payload.translations) ? payload.translations : {};
    const languageName = typeof payload.languageName === 'string' ? payload.languageName : 'English';
    let details = "";
    habits.forEach((habitEntry) => {
        if (!isRecord(habitEntry) || habitEntry.graduatedOn || habitEntry.deletedOn) return;
        const scheduleHistory = Array.isArray(habitEntry.scheduleHistory) ? habitEntry.scheduleHistory : [];
        const lastSchedule = scheduleHistory[scheduleHistory.length - 1];
        if (!isRecord(lastSchedule)) return;
        if (!lastSchedule) return;
        const translatedName = typeof lastSchedule.nameKey === 'string'
            ? translations[lastSchedule.nameKey]
            : undefined;
        const name = (typeof lastSchedule.name === 'string' && lastSchedule.name)
            || (typeof translatedName === 'string' && translatedName)
            || 'Hábito';
        const mode = lastSchedule.mode === 'attitudinal' ? 'attitudinal' : 'scheduled';
        details += `- ${name} [mode=${mode}]\n`;
    });

    let recordedDays = 0;
    const orderedDates = Object.keys(dailyData).sort();
    orderedDates.forEach((dateKey) => {
        const day = isRecord(dailyData[dateKey]) ? dailyData[dateKey] : {};
        const hasEntries = Object.values(day).some((info) => {
            if (!isRecord(info)) return false;
            const instances = isRecord(info.instances) ? info.instances : {};
            if (Object.keys(instances).length > 0) return true;
            return !!Object.values(instances).find((instance) => isRecord(instance) && instance.note && String(instance.note).trim());
        });
        if (hasEntries) recordedDays++;
    });

    const isFirstEntry = recordedDays <= 1;
    const sparseHistory = recordedDays > 1 && recordedDays < 7;
    const contextBlock = [
        '',
        '[DATA_CONTEXT]',
        `first_entry=${isFirstEntry ? 'true' : 'false'}`,
        `sparse_history=${sparseHistory ? 'true' : 'false'}`,
        `recorded_days_in_payload=${recordedDays}`,
        'analysis_rules=When first_entry=true, treat this as beginning of journey. Do not infer "month without records" or prolonged inactivity. Focus only on provided data.'
    ].join('\n');

    const promptTemplate = typeof translations.promptTemplate === 'string' ? translations.promptTemplate : '';
    const systemTemplate = typeof translations.aiSystemInstruction === 'string' ? translations.aiSystemInstruction : '';

    return {
        // Substituição por função: nomes de hábitos e notas são texto do usuário e
        // não podem ser interpretados como padrões (`$&`, `$\``, `$'`, `$$`).
        prompt: promptTemplate.replace('{activeHabitDetails}', () => details).replace('{history}', () => JSON.stringify(dailyData)) + contextBlock,
        systemInstruction: systemTemplate.replace('{languageName}', () => languageName)
    };
}

export function buildAiQuoteAnalysisPrompt(data: unknown) {
    const payload = isRecord(data) ? data : {};
    const context = isRecord(payload.dataContext) ? payload.dataContext : {};
    const habitModes = typeof payload.habitModes === 'string' ? payload.habitModes : '';
    const habitModesBlock = (habitModes && String(habitModes).trim())
        ? `\n\n[HABIT_MODES]\n${habitModes}`
        : '';
    const contextBlock = [
        '',
        '[DATA_CONTEXT]',
        `first_entry=${context.firstEntry ? 'true' : 'false'}`,
        `historical_days_with_notes=${context.historicalDaysWithNotes ?? 0}`,
        `historical_days_before_target=${context.daysBeforeTargetWithNotes ?? 0}`,
        'analysis_rules=When first_entry=true, evaluate only today notes and avoid assumptions about prior missing months.'
    ].join('\n');

    const translations = isRecord(payload.translations) ? payload.translations : {};
    const promptTemplate = typeof translations.aiPromptQuote === 'string' ? translations.aiPromptQuote : '';
    const systemInstruction = typeof translations.aiSystemInstructionQuote === 'string' ? translations.aiSystemInstructionQuote : '';
    const notes = typeof payload.notes === 'string' ? payload.notes : '';
    const themeList = typeof payload.themeList === 'string' ? payload.themeList : '';

    return {
        // Substituição por função: com string, `$&`, `$\``, `$'` e `$$` dentro das
        // notas seriam interpretados como padrões e corromperiam o texto do usuário.
        prompt: promptTemplate.replace('{notes}', () => notes).replace('{theme_list}', () => themeList) + habitModesBlock + contextBlock,
        systemInstruction
    };
}

function processArchiving(payload: unknown) {
    const data = isRecord(payload) ? payload : {};
    const result: Record<string, string> = {};
    for (const year in data) {
        const yearPayload = isRecord(data[year]) ? data[year] : {};
        let base = yearPayload.base ?? {};
        if (typeof base === 'string') {
            try { base = JSON.parse(base); } catch { base = {}; }
        }
        const additions = isRecord(yearPayload.additions) ? yearPayload.additions : {};
        const normalizedBase = isRecord(base) ? base : {};
        const merged = { ...normalizedBase, ...additions };
        result[year] = JSON.stringify(merged);
    }
    return result;
}
