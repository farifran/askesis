/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

// --- UUID ---
export function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- Date Helpers ---
export function toUTCIsoDateString(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function getTodayUTC(): Date {
    const today = new Date();
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
}

export function getTodayUTCIso(): string {
    return toUTCIsoDateString(getTodayUTC());
}

export function parseUTCIsoDate(isoString: string): Date {
    return new Date(`${isoString}T00:00:00.000Z`);
}

export function addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}
