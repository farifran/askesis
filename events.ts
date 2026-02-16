/**
 * @license
 * SPDX-License-Identifier: MIT
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

export const CARD_EVENTS = {
    statusChanged: 'card-status-changed',
    goalChanged: 'card-goal-changed'
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];
export type CardEventName = (typeof CARD_EVENTS)[keyof typeof CARD_EVENTS];

function _emitEvent<TDetail = undefined>(name: string, detail?: TDetail): void {
    if (detail === undefined) {
        document.dispatchEvent(new CustomEvent(name));
    } else {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    }
}

export function emitAppEvent<TDetail = undefined>(name: AppEventName, detail?: TDetail): void {
    _emitEvent(name, detail);
}

export function emitCardEvent<TDetail = undefined>(name: CardEventName, detail?: TDetail): void {
    _emitEvent(name, detail);
}

export const emitRenderApp = () => emitAppEvent(APP_EVENTS.renderApp);
export const emitHabitsChanged = () => emitAppEvent(APP_EVENTS.habitsChanged);
export const emitDayChanged = () => emitAppEvent(APP_EVENTS.dayChanged);
export const emitLanguageChanged = () => emitAppEvent(APP_EVENTS.languageChanged);
export const emitRequestAnalysis = (date: string) => emitAppEvent(APP_EVENTS.requestAnalysis, { date });

export const emitCardStatusChanged = (detail: { habitId: string; time: string; date?: string }) =>
    emitCardEvent(CARD_EVENTS.statusChanged, detail);

export const emitCardGoalChanged = (detail: { habitId: string; time: string; date?: string }) =>
    emitCardEvent(CARD_EVENTS.goalChanged, detail);
