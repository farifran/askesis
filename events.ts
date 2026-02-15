/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file events.ts
 * @description Nomes e helpers de eventos globais do app (UI plumbing).
 */

export const APP_EVENTS = {
    renderApp: 'render-app',
    habitsChanged: 'habitsChanged',
    dayChanged: 'dayChanged',
    languageChanged: 'language-changed',
    requestAnalysis: 'request-analysis'
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];

export function emitAppEvent<TDetail = undefined>(name: AppEventName, detail?: TDetail): void {
    if (detail === undefined) {
        document.dispatchEvent(new CustomEvent(name));
    } else {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    }
}

export const emitRenderApp = () => emitAppEvent(APP_EVENTS.renderApp);
export const emitHabitsChanged = () => emitAppEvent(APP_EVENTS.habitsChanged);
export const emitDayChanged = () => emitAppEvent(APP_EVENTS.dayChanged);
export const emitLanguageChanged = () => emitAppEvent(APP_EVENTS.languageChanged);
export const emitRequestAnalysis = (date: string) => emitAppEvent(APP_EVENTS.requestAnalysis, { date });
