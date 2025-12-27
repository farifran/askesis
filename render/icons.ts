/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file render/icons.ts
 * @description Helpers de Interface para Ícones (View Helpers).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este arquivo importa os dados brutos de `data/icons.ts` e fornece funções utilitárias
 * para seleção de ícones baseada em estado (TimeOfDay).
 * 
 * ARQUITETURA:
 * - **Facade Pattern:** Re-exporta `HABIT_ICONS` e `UI_ICONS` para que o restante da UI
 *   não precise importar diretamente da camada de dados, mantendo o acoplamento baixo.
 * - **Lógica de Apresentação:** `getTimeOfDayIcon` decide qual ícone mostrar.
 * 
 * DEPENDÊNCIAS:
 * - `data/icons.ts`: Fonte da verdade das strings SVG.
 */

import type { TimeOfDay } from '../state';
import { UI_ICONS } from '../data/icons';

// Re-exporta para manter compatibilidade com módulos de renderização
export * from '../data/icons';

// PERFORMANCE: Lookup Table O(1) em vez de switch/case.
// Em hot paths de renderização, acesso a propriedade de objeto é mais otimizável pelo V8.
const TIME_ICONS: Record<TimeOfDay, string> = {
    'Morning': UI_ICONS.morning,
    'Afternoon': UI_ICONS.afternoon,
    'Evening': UI_ICONS.evening
};

export function getTimeOfDayIcon(time: TimeOfDay): string {
    // Retorna o ícone mapeado ou 'Morning' como fallback de segurança (type-safety runtime)
    return TIME_ICONS[time] ?? UI_ICONS.morning;
}
