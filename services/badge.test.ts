/**
 * @file services/badge.test.ts
 * @description Testes do badge de pendências: API nativa e fallback Android
 * (notificação silenciosa via service worker).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const summaryMock = vi.fn();
vi.mock('./selectors', () => ({
    calculateDaySummary: (...args: unknown[]) => summaryMock(...args)
}));

let _optIn: boolean | null = true;
let _permission: NotificationPermission = 'granted';
vi.mock('../utils', () => ({
    getTodayUTCIso: () => '2026-08-01',
    getLocalPushOptIn: () => _optIn,
    getNotificationPermission: () => _permission,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));

vi.mock('../i18n', () => ({
    t: (key: string, opts?: { count?: number }) =>
        opts?.count !== undefined ? `${key}:${opts.count}` : key
}));

const showNotificationMock = vi.fn();
const closeMock = vi.fn();
const getNotificationsMock = vi.fn();

function setSummary(pending: number) {
    summaryMock.mockReturnValue({ pending, total: 3, completed: 3 - pending, snoozed: 0 });
}

function installSwRegistration() {
    const registration = {
        showNotification: showNotificationMock,
        getNotifications: getNotificationsMock.mockResolvedValue([{ close: closeMock }])
    };
    Object.defineProperty(navigator, 'serviceWorker', {
        value: { ready: Promise.resolve(registration) },
        configurable: true
    });
    return registration;
}

function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

function removeNativeBadgeApi() {
    delete (navigator as unknown as Record<string, unknown>).setAppBadge;
    delete (navigator as unknown as Record<string, unknown>).clearAppBadge;
}

describe('updateAppBadge', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        _optIn = true;
        _permission = 'granted';
        // jsdom não implementa a Notification API; o fallback só exige a existência do global.
        vi.stubGlobal('Notification', class MockNotification {});
        installSwRegistration();
        removeNativeBadgeApi();
    });

    describe('Badging API nativa (iOS/desktop)', () => {
        it('usa setAppBadge com a contagem quando há pendências', async () => {
            const setAppBadge = vi.fn().mockResolvedValue(undefined);
            const clearAppBadge = vi.fn().mockResolvedValue(undefined);
            Object.assign(navigator, { setAppBadge, clearAppBadge });

            setSummary(2);
            const { updateAppBadge } = await import('./badge');
            await updateAppBadge();

            expect(setAppBadge).toHaveBeenCalledWith(2);
            expect(showNotificationMock).not.toHaveBeenCalled();
        });

        it('limpa o badge quando não há pendências', async () => {
            const setAppBadge = vi.fn().mockResolvedValue(undefined);
            const clearAppBadge = vi.fn().mockResolvedValue(undefined);
            Object.assign(navigator, { setAppBadge, clearAppBadge });

            setSummary(0);
            const { updateAppBadge } = await import('./badge');
            await updateAppBadge();

            expect(clearAppBadge).toHaveBeenCalled();
            expect(setAppBadge).not.toHaveBeenCalled();
        });
    });

    describe('Fallback Android (sem Badging API)', () => {
        it('publica notificação silenciosa quando o app esconde com pendências', async () => {
            setSummary(3);
            setVisibility('hidden');

            const { updateAppBadge, PENDING_NOTIFICATION_TAG } = await import('./badge');
            await updateAppBadge();

            expect(showNotificationMock).toHaveBeenCalledTimes(1);
            const [title, options] = showNotificationMock.mock.calls[0];
            expect(title).toBe('pendingBadgeTitle');
            expect(options.tag).toBe(PENDING_NOTIFICATION_TAG);
            expect(options.body).toBe('pendingBadgeBody:3');
            expect(options.silent).toBe(true);
        });

        it('remove a notificação quando o app volta a ficar visível', async () => {
            setSummary(3);
            setVisibility('visible');

            const { updateAppBadge } = await import('./badge');
            await updateAppBadge();

            expect(showNotificationMock).not.toHaveBeenCalled();
            expect(closeMock).toHaveBeenCalled();
        });

        it('remove a notificação quando as pendências zeram', async () => {
            setSummary(0);
            setVisibility('hidden');

            const { updateAppBadge } = await import('./badge');
            await updateAppBadge();

            expect(showNotificationMock).not.toHaveBeenCalled();
            expect(closeMock).toHaveBeenCalled();
        });

        it('não faz nada sem permissão de notificação', async () => {
            _permission = 'default';
            setSummary(3);
            setVisibility('hidden');

            const { updateAppBadge } = await import('./badge');
            await updateAppBadge();

            expect(showNotificationMock).not.toHaveBeenCalled();
            expect(getNotificationsMock).not.toHaveBeenCalled();
        });

        it('delega ao service worker por postMessage quando há controller', async () => {
            const postMessage = vi.fn();
            Object.defineProperty(navigator, 'serviceWorker', {
                value: { ready: Promise.resolve({ showNotification: showNotificationMock, getNotifications: getNotificationsMock }), controller: { postMessage } },
                configurable: true
            });
            setSummary(2);
            setVisibility('hidden');

            const { updateAppBadge } = await import('./badge');
            await updateAppBadge();

            expect(postMessage).toHaveBeenCalledWith({
                type: 'SHOW_PENDING_BADGE',
                title: 'pendingBadgeTitle',
                body: 'pendingBadgeBody:2'
            });
            // Delegou: não deve tocar na registration diretamente.
            expect(showNotificationMock).not.toHaveBeenCalled();
        });

        it('posta ao SW de forma SÍNCRONA (a página pode congelar logo após esconder)', async () => {
            const postMessage = vi.fn();
            Object.defineProperty(navigator, 'serviceWorker', {
                value: { ready: new Promise(() => { /* nunca resolve: simula congelamento */ }), controller: { postMessage } },
                configurable: true
            });
            setSummary(1);
            setVisibility('hidden');

            const { updateAppBadge } = await import('./badge');
            updateAppBadge(); // sem await: nenhuma microtask pendente pode ser necessária

            expect(postMessage).toHaveBeenCalledTimes(1);
        });

        it('manda limpar via postMessage ao voltar ao foco', async () => {
            const postMessage = vi.fn();
            Object.defineProperty(navigator, 'serviceWorker', {
                value: { ready: Promise.resolve({}), controller: { postMessage } },
                configurable: true
            });
            setSummary(3);
            setVisibility('visible');

            const { updateAppBadge } = await import('./badge');
            await updateAppBadge();

            expect(postMessage).toHaveBeenCalledWith({ type: 'CLEAR_PENDING_BADGE' });
        });

        it('não faz nada sem opt-in explícito do usuário', async () => {
            _optIn = false;
            setSummary(3);
            setVisibility('hidden');

            const { updateAppBadge } = await import('./badge');
            await updateAppBadge();

            expect(showNotificationMock).not.toHaveBeenCalled();
            expect(getNotificationsMock).not.toHaveBeenCalled();
        });
    });
});
