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
