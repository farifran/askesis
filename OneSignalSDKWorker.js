/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file OneSignalSDKWorker.js
 * @description Compat / migração do worker legado de push.
 *
 * O push ativo agora vive em sw.js (importScripts do SDK OneSignal + offline).
 * Mantemos este arquivo na raiz para:
 *  1) clients antigos que ainda têm registration em /OneSignalSDKWorker.js
 *  2) smoke test e o default do dashboard OneSignal (workerName neste path)
 *
 * Novas inscrições usam serviceWorkerPath: 'sw.js' (ver ensureOneSignalReady).
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
