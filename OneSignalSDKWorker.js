/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file OneSignalSDKWorker.js
 * @description Compatibilidade: path legado na raiz.
 *
 * Novas inscrições usam /push/onesignal/OneSignalSDKWorker.js.
 * Mantido para clients que ainda têm registration no path antigo e para o
 * default do dashboard OneSignal (workerName na raiz).
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
