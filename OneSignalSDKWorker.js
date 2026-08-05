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
 * OneSignal exibir a dela e trocamos o conteúdo em seguida, reusando a MESMA
 * tag: `showNotification` com tag repetida substitui a anterior no lugar de
 * empilhar. A OneSignal define `tag` a partir do `web_push_topic` enviado pela
 * REST API (ver api/reminder.ts).
 *
 * Requisito do iOS/Safari: todo push precisa virar notificação visível. Por
 * isso este código nunca "desiste em silêncio" — se o cartão não servir, a
 * notificação genérica da OneSignal simplesmente permanece.
 */
(function () {
    'use strict';

    // Espelha o web_push_topic enviado por api/reminder.ts. É por essa tag que
    // trocamos o texto genérico pelo personalizado.
    // Distinta da tag do badge (services/badge.ts) de propósito: substituição por
    // tag só vale dentro da MESMA registration, e o badge vive no sw.js.
    var NOTIFICATION_TAG = 'askesis-reminder';

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
     * Abre o banco SEM informar versão: com versão explícita, um worker mais
     * antigo que o app dispararia upgrade/bloqueio. Sem ela, apenas anexamos à
     * versão corrente. IndexedDB é escopado por origem, então o worker de push
     * (escopo /onesignal/) enxerga o banco do app normalmente.
     */
    function openDB() {
        return new Promise(function (resolve, reject) {
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
     * A OneSignal e este handler correm em paralelo. Esperamos a notificação
     * dela aparecer antes de trocar — sem isso, se a nossa chegasse primeiro, a
     * dela sobrescreveria o texto personalizado com o genérico.
     */
    function waitForNotification(registration) {
        var deadline = Date.now() + POLL_TIMEOUT_MS;

        function attempt() {
            return registration.getNotifications({ tag: NOTIFICATION_TAG }).then(function (list) {
                if (list.length > 0) return list[0];
                if (Date.now() >= deadline) return null;
                return sleep(POLL_INTERVAL_MS).then(attempt);
            });
        }
        return attempt();
    }

    self.addEventListener('push', function (event) {
        event.waitUntil(
            readCard().then(function (card) {
                // Cartão de outro dia significa que o app não foi aberto hoje:
                // o texto genérico da OneSignal é mais honesto que dados velhos.
                if (!card || card.date !== todayUTCIso() || !card.title || !card.body) return;

                return waitForNotification(self.registration).then(function (existing) {
                    // Sem notificação da OneSignal não há o que substituir — e criar
                    // uma aqui arriscaria duplicar caso a dela ainda esteja a caminho.
                    if (!existing) return;

                    return self.registration.showNotification(card.title, {
                        body: card.body,
                        tag: NOTIFICATION_TAG,
                        icon: existing.icon || 'icons/icon-192.svg',
                        badge: existing.badge || 'icons/badge.svg',
                        // Substituição silenciosa: a OneSignal já alertou o usuário.
                        renotify: false,
                        // Preserva o payload da OneSignal para o notificationclick
                        // dela continuar abrindo a URL e registrando o clique.
                        data: existing.data
                    });
                });
            }).catch(function () {
                // Falhar aqui só significa manter a notificação genérica.
            })
        );
    });
})();
