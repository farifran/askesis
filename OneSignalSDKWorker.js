/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file OneSignalSDKWorker.js
 * @description Service worker de push OneSignal (escopo /onesignal/).
 *
 * Registrado pelo SDK com serviceWorkerPath: 'OneSignalSDKWorker.js' e
 * serviceWorkerParam: { scope: '/onesignal/' } — coexiste com sw.js (offline).
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

/**
 * PERSONALIZAÇÃO LOCAL DO LEMBRETE
 *
 * O servidor manda uma campainha idêntica para todo mundo (o estado é E2E
 * cifrado; ele não sabe o que está pendente). Quem escreve o texto é este
 * worker, lendo o cartão que o app deixou no IndexedDB.
 *
 * POR QUE SUBSTITUIR EM VEZ DE INTERCEPTAR:
 * No SDK v16 o listener de `push` é registrado como função anônima inline, sem
 * referência exportada — `removeEventListener` é impossível. Então deixamos a
 * OneSignal exibir a dela e trocamos o conteúdo em seguida.
 *
 * COMO IDENTIFICAMOS O NOSSO PUSH:
 * Pelo marcador em `data` (REMINDER_MARKER, ver api/reminder.ts), não pela tag.
 * O marcador chega íntegro ao evento `push` e não depende do interno do SDK.
 * Também evita sequestro: um anúncio enviado pelo painel não o carrega.
 *
 * Requisito do iOS/Safari: todo push precisa virar notificação visível. Por
 * isso este código nunca "desiste em silêncio" — se o cartão não servir, a
 * notificação genérica da OneSignal simplesmente permanece.
 */
(function () {
    'use strict';

    /**
     * ATIVAÇÃO IMEDIATA.
     *
     * Sem isto, uma versão nova deste worker é instalada e fica em ESPERA
     * indefinidamente enquanto a antiga segue atendendo os pushes — o SDK da
     * OneSignal não chama `skipWaiting`, e o `sw.js` (que chama) é outro
     * registration. Na prática, correções aqui nunca chegavam ao aparelho.
     */
    self.addEventListener('install', function () {
        self.skipWaiting();
    });

    var REMINDER_MARKER = 'askesis-reminder';

    // Espelha services/persistence.ts / services/notificationCard.ts.
    var DB_NAME = 'AskesisDB';
    var STORE_NAME = 'app_state';
    var CARD_KEY = 'askesis_notification_card';

    var POLL_INTERVAL_MS = 60;
    var POLL_TIMEOUT_MS = 3000;

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function todayUTCIso() {
        return new Date().toISOString().slice(0, 10);
    }

    /**
     * O marcador pode chegar em lugares diferentes conforme o formato de payload
     * do SDK (`custom.a` no legado, `data` no novo). Procura em todos.
     */
    function isReminderPush(event) {
        try {
            var payload = event.data ? event.data.json() : null;
            if (!payload) return false;

            var extra = (payload.custom && payload.custom.a) || payload.data || payload.additionalData;
            if (extra && extra.askesis === REMINDER_MARKER) return true;

            return payload.topic === REMINDER_MARKER;
        } catch (e) {
            return false;
        }
    }

    function openDB() {
        return new Promise(function (resolve, reject) {
            // Sem versão explícita: um worker mais antigo que o app dispararia
            // upgrade/bloqueio. Assim apenas anexamos à versão corrente.
            var req = indexedDB.open(DB_NAME);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
            // Só ocorre se o banco ainda não existir (usuário nunca abriu o app).
            req.onupgradeneeded = function () { resolve(null); };
        });
    }

    function readCard() {
        return openDB().then(function (db) {
            if (!db || !db.objectStoreNames.contains(STORE_NAME)) return null;
            return new Promise(function (resolve) {
                var req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(CARD_KEY);
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { resolve(null); };
            }).then(function (card) {
                db.close();
                return card;
            });
        });
    }

    /**
     * O cartão só serve se for do dia corrente em UTC — a mesma noção de "hoje"
     * que o app usa (`getTodayUTCIso`). Cartão de outro dia significa que o app
     * não foi aberto desde então: o texto genérico do servidor é mais honesto
     * que pendências velhas.
     */
    function isCardUsable(card) {
        return !!card && !!card.title && !!card.body && card.date === todayUTCIso();
    }

    /** Identidade estável o bastante para distinguir notificações na bandeja. */
    function fingerprint(notification) {
        return [notification.tag, notification.title, notification.body, notification.timestamp].join('|');
    }

    /**
     * Espera a OneSignal publicar a notificação DESTE push.
     *
     * Os dois handlers correm em paralelo: sem esperar, a genérica sobrescreveria
     * o texto personalizado. Mas não basta esperar "alguma" notificação — uma
     * antiga na bandeja satisfaria isso na hora, e acabaríamos substituindo a
     * errada enquanto a nova aparece do lado (duas notificações). Por isso
     * fotografamos a bandeja antes e só aceitamos o que for novo.
     */
    function waitForNewNotification(registration) {
        return registration.getNotifications().then(function (before) {
            var known = {};
            before.forEach(function (n) { known[fingerprint(n)] = true; });

            var deadline = Date.now() + POLL_TIMEOUT_MS;

            function attempt() {
                return registration.getNotifications().then(function (list) {
                    for (var i = list.length - 1; i >= 0; i--) {
                        if (!known[fingerprint(list[i])]) return list[i];
                    }
                    if (Date.now() >= deadline) return null;
                    return sleep(POLL_INTERVAL_MS).then(attempt);
                });
            }
            return attempt();
        });
    }

    /**
     * Troca o conteúdo da notificação que a OneSignal acabou de publicar.
     *
     * Fecha a original sempre, em vez de contar com a colisão de tag: se a tag
     * dela vier vazia ou diferente da nossa, a "substituição" viraria uma
     * segunda notificação na bandeja.
     */
    function replaceWith(existing, title, body) {
        existing.close();
        return self.registration.showNotification(title, {
            body: body,
            // Tag própria e fixa: garante que lembretes seguidos colapsem entre si.
            tag: REMINDER_MARKER,
            icon: existing.icon || 'icons/icon-192.svg',
            badge: existing.badge || 'icons/badge.svg',
            // Substituição silenciosa: a OneSignal já alertou o usuário.
            renotify: false,
            // Preserva o payload da OneSignal para o notificationclick dela
            // continuar abrindo a URL e registrando o clique.
            data: existing.data
        });
    }

    self.addEventListener('push', function (event) {
        if (!isReminderPush(event)) return;

        event.waitUntil(
            readCard().catch(function () { return null; }).then(function (card) {
                if (!isCardUsable(card)) return;

                return waitForNewNotification(self.registration).then(function (existing) {
                    // Sem notificação da OneSignal não há o que substituir — e criar
                    // uma aqui arriscaria duplicar caso a dela ainda esteja a caminho.
                    if (!existing) return;
                    return replaceWith(existing, card.title, card.body);
                });
            }).catch(function () {
                // Falhar aqui só significa manter a notificação genérica.
            })
        );
    });
})();
