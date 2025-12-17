/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { calculateDaySummary } from '../state';
import { getTodayUTCIso } from '../utils';

// [2025-01-15] TYPE SAFETY: Definição de interface local para a Badging API.
// Evita o uso repetido de 'as any' e fornece autocompletar/verificação se o TS for atualizado.
interface NavigatorWithBadging extends Navigator {
    setAppBadge(contents?: number): Promise<void>;
    clearAppBadge(): Promise<void>;
}

/**
 * Atualiza o emblema do ícone do aplicativo com o número atual de hábitos pendentes para hoje.
 * Se a contagem for zero, o emblema é limpo.
 * Esta função verifica o suporte do navegador antes de tentar definir o emblema.
 */
export async function updateAppBadge(): Promise<void> {
    // A API de Emblema é suportada no objeto navigator.
    if ('setAppBadge' in navigator && 'clearAppBadge' in navigator) {
        try {
            // REFACTOR [2025-03-05]: Remove a função local redundante e usa a função
            // centralizada e cacheada 'calculateDaySummary' para obter a contagem de pendentes.
            const { pending: count } = calculateDaySummary(getTodayUTCIso());
            const nav = navigator as NavigatorWithBadging;

            if (count > 0) {
                await nav.setAppBadge(count);
            } else {
                await nav.clearAppBadge();
            }
        } catch (error) {
            // Falha silenciosa ou log discreto é aceitável para funcionalidades de UI progressivas
            console.error('Failed to set app badge:', error);
        }
    }
}