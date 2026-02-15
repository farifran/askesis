
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/sync.worker.ts
 * @description Web Worker para Criptografia e Processamento de Dados Pesados.
 */

import { murmurHash3 } from './murmurHash3';

const SALT_LEN = 16;
const IV_LEN = 12;

function jsonReplacer(key: string, value: any) {
    if (typeof value === 'bigint') return { __type: 'bigint', val: value.toString() };
    if (value instanceof Map) return { __type: 'map', val: Array.from(value.entries()) };
    return value;
}

function jsonReviver(key: string, value: any) {
    if (value && typeof value === 'object') {
        if (value.__type === 'bigint') return BigInt(value.val);
        if (value.__type === 'map') return new Map(value.val);
    }
    if (typeof value === 'string' && value.startsWith('0x')) {
        try { return BigInt(value); } catch(e) { return value; }
    }
    return value;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
        keyMaterial, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
}

async function encrypt(payload: any, password: string): Promise<string> {
    const text = JSON.stringify(payload, jsonReplacer);
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await deriveKey(password, salt);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
    const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    combined.set(salt);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(encrypted), salt.length + iv.length);
    return btoa(String.fromCharCode(...combined));
}

async function encryptJson(jsonText: string, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await deriveKey(password, salt);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(jsonText));
    const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    combined.set(salt);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(encrypted), salt.length + iv.length);
    return btoa(String.fromCharCode(...combined));
}

async function decrypt(encryptedBase64: string, password: string): Promise<any> {
    const str = atob(encryptedBase64);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    const salt = bytes.slice(0, SALT_LEN);
    const iv = bytes.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const data = bytes.slice(SALT_LEN + IV_LEN);
    const key = await deriveKey(password, salt);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return JSON.parse(new TextDecoder().decode(decrypted), jsonReviver);
}

async function decryptWithHash(encryptedBase64: string, password: string): Promise<{ value: any; hash: string }> {
    const str = atob(encryptedBase64);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    const salt = bytes.slice(0, SALT_LEN);
    const iv = bytes.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const data = bytes.slice(SALT_LEN + IV_LEN);
    const key = await deriveKey(password, salt);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    const text = new TextDecoder().decode(decrypted);
    return { value: JSON.parse(text, jsonReviver), hash: murmurHash3(text) };
}

/**
 * Remove todos os rastros de um hábito de dentro dos arquivos JSON comprimidos.
 */
function pruneHabitFromArchives(habitId: string, archives: Record<string, any>): Record<string, any> {
    const updated: Record<string, any> = {};
    for (const year in archives) {
        let content = archives[year];
        if (typeof content === 'string') {
            try { content = JSON.parse(content); } catch { continue; }
        }
        
        let changed = false;
        for (const date in content) {
            if (content[date][habitId]) {
                delete content[date][habitId];
                changed = true;
            }
            if (Object.keys(content[date]).length === 0) delete content[date];
        }
        
        if (changed) {
            updated[year] = Object.keys(content).length === 0 ? "" : JSON.stringify(content);
        }
    }
    return updated;
}

self.onmessage = async (e) => {
    const { id, type, payload, key } = e.data;
    try {
        let result: any;
        switch (type) {
            case 'encrypt': result = await encrypt(payload, key!); break;
            case 'encrypt-json': result = await encryptJson(String(payload || ''), key!); break;
            case 'decrypt': result = await decrypt(payload, key!); break;
            case 'decrypt-with-hash': result = await decryptWithHash(payload, key!); break;
            case 'build-ai-prompt': result = buildAiPrompt(payload); break;
            case 'build-quote-analysis-prompt': result = buildAiQuoteAnalysisPrompt(payload); break;
            case 'archive': result = processArchiving(payload); break;
            case 'prune-habit': result = pruneHabitFromArchives(payload.habitId, payload.archives); break;
            default: throw new Error(`Task unknown: ${type}`);
        }
        self.postMessage({ id, status: 'success', result });
    } catch (error: any) {
        self.postMessage({ id, status: 'error', error: error.message });
    }
};

function buildAiPrompt(data: any) {
    const { habits, dailyData, translations, languageName } = data;
    let details = "";
    habits.forEach((h: any) => {
        if (!h || h.graduatedOn || h.deletedOn) return;
        const scheduleHistory = Array.isArray(h.scheduleHistory) ? h.scheduleHistory : [];
        const lastSchedule = scheduleHistory[scheduleHistory.length - 1];
        if (!lastSchedule) return;
        const translatedName = lastSchedule.nameKey ? translations?.[lastSchedule.nameKey] : undefined;
        const name = lastSchedule.name || translatedName || 'Hábito';
        const mode = lastSchedule.mode === 'attitudinal' ? 'attitudinal' : 'scheduled';
        details += `- ${name} [mode=${mode}]\n`;
    });

    let recordedDays = 0;
    const orderedDates = Object.keys(dailyData || {}).sort();
    orderedDates.forEach((dateKey) => {
        const day = dailyData[dateKey] || {};
        const hasEntries = Object.values(day).some((info: any) => {
            if (!info || typeof info !== 'object') return false;
            const instances = info.instances || {};
            if (Object.keys(instances).length > 0) return true;
            return !!Object.values(instances).find((instance: any) => instance?.note && String(instance.note).trim());
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

    return {
        prompt: translations.promptTemplate.replace('{activeHabitDetails}', details).replace('{history}', JSON.stringify(dailyData)) + contextBlock,
        systemInstruction: translations.aiSystemInstruction.replace('{languageName}', languageName)
    };
}

function buildAiQuoteAnalysisPrompt(data: any) {
    const context = data.dataContext || {};
    const habitModesBlock = (data.habitModes && String(data.habitModes).trim())
        ? `\n\n[HABIT_MODES]\n${data.habitModes}`
        : '';
    const contextBlock = [
        '',
        '[DATA_CONTEXT]',
        `first_entry=${context.firstEntry ? 'true' : 'false'}`,
        `historical_days_with_notes=${context.historicalDaysWithNotes ?? 0}`,
        `historical_days_before_target=${context.daysBeforeTargetWithNotes ?? 0}`,
        'analysis_rules=When first_entry=true, evaluate only today notes and avoid assumptions about prior missing months.'
    ].join('\n');

    return {
        prompt: data.translations.aiPromptQuote.replace('{notes}', data.notes).replace('{theme_list}', data.themeList) + habitModesBlock + contextBlock,
        systemInstruction: data.translations.aiSystemInstructionQuote
    };
}

function processArchiving(payload: any) {
    const result: Record<string, string> = {};
    for (const year in payload) {
        let base = payload[year].base || {};
        if (typeof base === 'string') {
            try { base = JSON.parse(base); } catch { base = {}; }
        }
        const merged = { ...base, ...payload[year].additions };
        result[year] = JSON.stringify(merged);
    }
    return result;
}
