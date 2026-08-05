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
 * A primeira versão dependia de `web_push_topic` virar `Notification.tag` —
 * suposição sobre o interno do SDK que não se confirmou, e que fazia o worker
 * desistir em silêncio. O marcador chega íntegro ao evento `push`.
 *
 * O marcador também evita sequestro: um push de anúncio enviado pelo painel da
 * OneSignal não o carrega, e portanto não é reescrito com texto de hábitos.
 *
 * Requisito do iOS/Safari: todo push precisa virar notificação visível. Por
 * isso este código nunca "desiste em silêncio" — se o cartão não servir, a
 * notificação genérica da OneSignal simplesmente permanece.
 */
(function () {
    'use strict';

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
        }).catch(function () { return null; });
    }

    /**
     * Espera a OneSignal publicar a notificação dela. Sem filtro de tag: o que
     * esta registration exibe é dela, e assim não dependemos de qual tag usou.
     *
     * A espera é necessária porque os dois handlers correm em paralelo — se a
     * nossa chegasse primeiro, a genérica sobrescreveria o texto personalizado.
     */
    function waitForNotification(registration) {
        var deadline = Date.now() + POLL_TIMEOUT_MS;

        function attempt() {
            return registration.getNotifications().then(function (list) {
                if (list.length > 0) return list[list.length - 1];
                if (Date.now() >= deadline) return null;
                return sleep(POLL_INTERVAL_MS).then(attempt);
            });
        }
        return attempt();
    }

    self.addEventListener('push', function (event) {
        if (!isReminderPush(event)) return;

        event.waitUntil(
            readCard().then(function (card) {
                // Cartão de outro dia significa que o app não foi aberto hoje:
                // o texto genérico da OneSignal é mais honesto que dados velhos.
                if (!card || card.date !== todayUTCIso() || !card.title || !card.body) return;

                return waitForNotification(self.registration).then(function (existing) {
                    // Sem notificação da OneSignal não há o que substituir — e criar
                    // uma aqui arriscaria duplicar caso a dela ainda esteja a caminho.
                    if (!existing) return;

                    var options = {
                        body: card.body,
                        icon: existing.icon || 'icons/icon-192.svg',
                        badge: existing.badge || 'icons/badge.svg',
                        // Substituição silenciosa: a OneSignal já alertou o usuário.
                        renotify: false,
                        // Preserva o payload da OneSignal para o notificationclick
                        // dela continuar abrindo a URL e registrando o clique.
                        data: existing.data
                    };

                    if (existing.tag) {
                        // Mesma tag substitui no lugar de empilhar.
                        options.tag = existing.tag;
                        return self.registration.showNotification(card.title, options);
                    }

                    // Sem tag não há substituição possível: fecha a original antes,
                    // senão ficariam duas notificações na bandeja.
                    existing.close();
                    return self.registration.showNotification(card.title, options);
                });
            }).catch(function () {
                // Falhar aqui só significa manter a notificação genérica.
            })
        );
    });
})();
