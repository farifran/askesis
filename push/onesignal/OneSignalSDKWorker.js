/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file push/onesignal/OneSignalSDKWorker.js
 * @description Service worker dedicado da OneSignal (push).
 *
 * Path e escopo oficiais para coexistir com o SW offline (sw.js, escopo `/`):
 *   serviceWorkerPath: 'push/onesignal/OneSignalSDKWorker.js'
 *   serviceWorkerParam: { scope: '/push/onesignal/' }
 *
 * Ver: https://documentation.onesignal.com/docs/onesignal-service-worker-faq
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
