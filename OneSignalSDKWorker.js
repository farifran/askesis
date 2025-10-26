/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Este script do service worker é essencial para o funcionamento das notificações push do OneSignal.
// Ele simplesmente importa o script principal do SDK do OneSignal a partir de sua CDN.
// Não adicione nenhum outro código a este arquivo, pois ele é gerenciado pelo OneSignal.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
