/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file OneSignalSDKWorker.js
 * @description Service worker dedicado da OneSignal (push).
 *
 * Registrado pelo SDK v16 com escopo restrito '/onesignal/' (ver
 * ensureOneSignalReady em utils.ts) para coexistir com o SW principal do app
 * (sw.js, escopo '/'): este cuida apenas de push/notification-click da
 * OneSignal; o offline e o badge local continuam no sw.js.
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
