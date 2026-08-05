/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file services/notificationCard.ts
 * @description Cartão de notificação: o texto do lembrete, pré-renderizado no cliente.
 *
 * POR QUE ISSO EXISTE:
 * O servidor não pode montar o texto do lembrete — o estado é E2E cifrado e ele
 * não sabe o que está pendente. Mas com o app fechado nada roda no aparelho: só
 * um push da rede acorda o Service Worker (agendamento local não existe — a
 * Notification Triggers API foi descontinuada e timers de SW morrem em ~30s).
 *
 * A solução é separar gatilho de conteúdo: o servidor manda uma campainha
 * idêntica para todo mundo, e o SW monta o texto lendo ESTE cartão do
 * IndexedDB. O servidor nunca sabe o que a notificação diz.
 *
 * O cartão guarda `title`/`body` JÁ RENDERIZADOS porque o Service Worker não
 * consegue importar o i18n nem `data/quotes.ts` — ele só lê e exibe.
 *
 * Consumido por `OneSignalSDKWorker.js`. Gravado por `services/persistence.ts`.
 */

import { state, HABIT_STATE } from '../state';
import { calculateDaySummary, getActiveHabitsForDate, getHabitDisplayInfo } from './selectors';
import { HabitService } from './HabitService';
import { getTodayUTCIso, parseUTCIsoDate, logger } from '../utils';
import { t } from '../i18n';

/** Chave do cartão no object store `app_state`. Espelhada em OneSignalSDKWorker.js. */
export const NOTIFICATION_CARD_KEY = 'askesis_notification_card';

/** Quantos nomes de hábito cabem no corpo antes de virar "+N". */
const MAX_HABIT_NAMES = 3;

export interface NotificationCard {
    /** Data UTC (YYYY-MM-DD) em que o cartão foi montado. O SW descarta se não for hoje. */
    date: string;
    /** Idioma em que title/body foram renderizados — só para diagnóstico. */
    lang: string;
    title: string;
    body: string;
}

/** Nomes dos hábitos ainda pendentes hoje, na ordem em que aparecem no app. */
function collectPendingNames(dateISO: string): string[] {
    const names: string[] = [];
    const dateObj = parseUTCIsoDate(dateISO);

    for (const { habit, schedule } of getActiveHabitsForDate(dateISO, dateObj)) {
        const isPending = schedule.some(time => HabitService.getStatus(habit.id, dateISO, time) === HABIT_STATE.NULL);
        if (!isPending) continue;

        const { name } = getHabitDisplayInfo(habit, dateISO);
        if (name) names.push(name);
    }
    return names;
}

/**
 * A frase que o app está exibindo agora, publicada por `renderStoicQuote`.
 *
 * A dependência é invertida de propósito: `data/quotes.ts` pesa ~87 KB e é
 * carregado sob demanda (`import()` em render.ts). Importá-lo aqui o traria
 * para o grafo estático e o app pagaria esse custo já no boot.
 */
let publishedQuote: { text: string; authorKey: string } | null = null;

export function setNotificationQuote(quote: { text: string; authorKey: string } | null): void {
    publishedQuote = quote;
}

function currentQuoteBody(): string | null {
    if (!publishedQuote?.text) return null;
    // `author` é chave de i18n ("musoniusRufus"), não o nome já escrito.
    return t('notifyQuoteBody', { text: publishedQuote.text, author: t(publishedQuote.authorKey) });
}

/**
 * Monta o cartão a partir do estado atual.
 *
 * Retorna `null` quando não há o que dizer (nenhum hábito ativo hoje): nesse
 * caso o SW mantém o texto genérico do push em vez de inventar conteúdo.
 */
export function buildNotificationCard(): NotificationCard | null {
    try {
        const dateISO = getTodayUTCIso();
        const { total, pending } = calculateDaySummary(dateISO);

        if (total === 0) return null;

        const base = { date: dateISO, lang: state.activeLanguageCode };

        if (pending === 0) {
            // Slot que o iOS obriga a preencher: é onde a frase estoica cabe melhor,
            // porque não compete com a lista de pendências.
            const quote = currentQuoteBody();
            if (!quote) return null;
            return { ...base, title: t('notifyAllDoneTitle'), body: quote };
        }

        const names = collectPendingNames(dateISO);
        const shown = names.slice(0, MAX_HABIT_NAMES);
        const hidden = names.length - shown.length;
        const list = hidden > 0 ? t('notifyPendingMore', { names: shown.join(', '), count: hidden }) : shown.join(', ');

        return {
            ...base,
            title: t('pendingBadgeTitle'),
            // Sem nomes legíveis, o corpo cai para a contagem pura.
            body: shown.length > 0 ? t('notifyPendingList', { names: list }) : t('pendingBadgeBody', { count: pending })
        };
    } catch (error) {
        // O cartão é um extra: nunca pode derrubar o save do estado.
        logger.error('[NotificationCard] Falha ao montar o cartão', error);
        return null;
    }
}
