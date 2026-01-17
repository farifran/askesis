/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/migration.ts
 * @description Inicializador de Estado e Sanitizador de Schema.
 * 
 * [MAIN THREAD CONTEXT]:
 * Como não há dados legados de produção, este módulo atua apenas para garantir
 * a integridade estrutural do estado (Schema Enforcement) e inicializar
 * estruturas de dados runtime (como Maps) corretamente.
 */

import { AppState } from '../state';

export function migrateState(loadedState: any, targetVersion: number): AppState {
    // 1. FRESH INSTALL / NULL STATE
    if (!loadedState) {
        return { 
            version: targetVersion, 
            habits: [], 
            dailyData: {}, 
            archives: {}, 
            dailyDiagnoses: {}, 
            lastModified: Date.now(), 
            notificationsShown: [], 
            pending21DayHabitIds: [], 
            pendingConsolidationHabitIds: [], 
            monthlyLogs: new Map() // Bitmask Init
        } as AppState;
    }

    // 2. SCHEMA ENFORCEMENT & HYDRATION
    // Garante que o estado carregado tenha a estrutura mínima necessária para a versão atual.
    // Não realizamos migrações de dados antigos pois assumimos "Greenfield" (sem legado V1-V6).
    
    const state = loadedState as AppState;

    // DATA INTEGRITY: Garante que monthlyLogs seja sempre um Map,
    // recuperando de possíveis serializações incorretas (JSON Object).
    if (!state.monthlyLogs || !(state.monthlyLogs instanceof Map)) {
        state.monthlyLogs = new Map();
    }

    // Força a versão atual
    (state as any).version = targetVersion;
    
    return state;
}