
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/drag.ts
 * @description Motor simplificado de Drag & Drop e Auto-Scroll.
 * 
 * [MAIN THREAD CONTEXT]:
 * Implementação simplificada utilizando APIs nativas de Hit Testing e Layout.
 * 
 * ARQUITETURA (Native-First):
 * - **Native Hit Testing:** Utiliza `e.target` e `closest()` para identificar alvos, eliminando caches geométricos complexos.
 * - **Relative Positioning:** Calcula posições baseadas em `offsetTop` relativo ao container, robusto contra reflows.
 * - **Dynamic Auto-Scroll:** Zonas de scroll calculadas dinamicamente baseadas no Viewport do container.
 * - **Geometry Caching (Update):** Cache de `getBoundingClientRect` no início do arrasto para evitar Layout Thrashing.
 * - **CSS Typed OM:** Renderização direta via `attributeStyleMap` para performance máxima (Zero String Parsing).
 */

import { handleHabitDrop, reorderHabit } from '../services/habitActions';
import { TimeOfDay, state } from '../state';
import { getEffectiveScheduleForHabitOnDate } from '../services/selectors';
import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';
import { isCurrentlySwiping } from './swipe';
import { renderApp } from '../render'; // CHAOS FIX: Import renderApp for catch-up

// CONFIGURAÇÃO
const SCROLL_ZONE_PX = 80; // Zona ativa para scroll
const MAX_SCROLL_SPEED = 15; // Velocidade máxima (px/frame)
const DROP_INDICATOR_GAP = 4; // Espaçamento visual

// SNIPER OPTIMIZATION: Feature detection for Typed OM
const hasTypedOM = typeof window !== 'undefined' && !!(window.CSS && (window as any).CSSTranslate && CSS.px);

// --- STATE MACHINE ---
const DragState = {
    // Session
    isActive: false,
    container: null as HTMLElement | null,
    containerRect: null as DOMRect | null, // Cache de geometria
    
    // Source
    sourceEl: null as HTMLElement | null,
    sourceId: null as string | null,
    sourceTime: null as TimeOfDay | null,
    // @fix: The type 'readonly ("Morning" | "Afternoon" | "Evening")[]' is 'readonly' and cannot be assigned to the mutable type '("Morning" | "Afternoon" | "Evening")[]'.
    cachedSchedule: null as readonly TimeOfDay[] | null,
    
    // Targets
    targetZone: null as HTMLElement | null,
    targetCard: null as HTMLElement | null, // Cartão de referência para troca
    insertPos: null as 'before' | 'after' | null,
    
    // UI
    indicator: null as HTMLElement | null,
    renderedZone: null as HTMLElement | null,
    
    // Logic
    isValidDrop: false,
    
    // Scroll
    scrollSpeed: 0,
    rafId: 0
};

// --- SCROLL ENGINE (Animation Loop) ---

function _scrollLoop() {
    if (!DragState.isActive) return;

    // 1. Auto Scroll
    if (DragState.scrollSpeed !== 0 && DragState.container) {
        DragState.container.scrollBy(0, DragState.scrollSpeed);
    }

    // 2. Render Indicator & Highlights
    if (DragState.renderedZone !== DragState.targetZone) {
        // Cleanup old zone
        if (DragState.renderedZone) {
            DragState.renderedZone.classList.remove(CSS_CLASSES.DRAG_OVER, CSS_CLASSES.INVALID_DROP);
            if (DragState.indicator && DragState.indicator.parentElement === DragState.renderedZone) {
                DragState.indicator.remove();
            }
        }
        DragState.renderedZone = DragState.targetZone;
    }

    if (DragState.targetZone && DragState.indicator) {
        // Apply Classes
        const isSelfZone = DragState.targetZone.dataset.time === DragState.sourceTime;
        const showDragOver = DragState.isValidDrop && !isSelfZone;
        const showInvalid = !DragState.isValidDrop;

        if (DragState.targetZone.classList.contains(CSS_CLASSES.DRAG_OVER) !== showDragOver) {
            DragState.targetZone.classList.toggle(CSS_CLASSES.DRAG_OVER, showDragOver);
        }
        if (DragState.targetZone.classList.contains(CSS_CLASSES.INVALID_DROP) !== showInvalid) {
            DragState.targetZone.classList.toggle(CSS_CLASSES.INVALID_DROP, showInvalid);
        }

        // Mount Indicator
        if (DragState.indicator.parentElement !== DragState.targetZone) {
            DragState.targetZone.appendChild(DragState.indicator);
        }

        // Position Indicator
        if (DragState.isValidDrop) {
            DragState.indicator.classList.add('visible');
            
            let topPos = 0;
            
            if (DragState.targetCard) {
                // Posicionamento relativo ao cartão alvo
                // offsetTop é relativo ao pai posicionado (o habit-group)
                if (DragState.insertPos === 'before') {
                    topPos = DragState.targetCard.offsetTop - DROP_INDICATOR_GAP;
                } else {
                    topPos = DragState.targetCard.offsetTop + DragState.targetCard.offsetHeight + DROP_INDICATOR_GAP;
                }
            } else {
                // Fallback: Se não há cartão alvo, joga no final ou início dependendo da zona
                if (DragState.targetZone.children.length === 0) {
                    topPos = DROP_INDICATOR_GAP;
                } else {
                    const lastChild = DragState.targetZone.lastElementChild as HTMLElement;
                    if (lastChild && lastChild !== DragState.indicator) {
                         topPos = lastChild.offsetTop + lastChild.offsetHeight + DROP_INDICATOR_GAP;
                    }
                }
            }
            
            // BLEEDING-EDGE PERF (CSS Typed OM): No "hot path" do loop de arrastar,
            // evitamos a criação e o parsing de strings de `transform`. Em vez disso,
            // escrevemos valores numéricos diretamente no motor de composição do navegador
            // para performance máxima, com fallback para o método tradicional.
            if (hasTypedOM && DragState.indicator.attributeStyleMap) {
                DragState.indicator.attributeStyleMap.set('transform', new (window as any).CSSTranslate(CSS.px(0), CSS.px(topPos), CSS.px(0)));
            } else {
                DragState.indicator.style.transform = `translate3d(0, ${topPos}px, 0)`;
            }
        } else {
            DragState.indicator.classList.remove('visible');
        }
    }

    DragState.rafId = requestAnimationFrame(_scrollLoop);
}

// --- EVENT HANDLERS ---

const _handleDragOver = (e: DragEvent) => {
    e.preventDefault(); // Obrigatório para permitir drop
    if (!DragState.isActive || !DragState.container) return;

    const y = e.clientY;

    // --- 1. Calcular Scroll Speed (Dinâmico) ---
    // PERF: Usa geometria cacheada no dragStart para evitar Layout Thrashing
    const rect = DragState.containerRect;
    
    if (rect) {
        const { top, height } = rect;
        const bottom = top + height;
        
        const topThreshold = top + SCROLL_ZONE_PX;
        const bottomThreshold = bottom - SCROLL_ZONE_PX;

        if (y < topThreshold) {
            const ratio = (topThreshold - y) / SCROLL_ZONE_PX;
            DragState.scrollSpeed = -Math.max(2, ratio * MAX_SCROLL_SPEED);
        } else if (y > bottomThreshold) {
            const ratio = (y - bottomThreshold) / SCROLL_ZONE_PX;
            DragState.scrollSpeed = Math.max(2, ratio * MAX_SCROLL_SPEED);
        } else {
            DragState.scrollSpeed = 0;
        }
    }

    // --- 2. Identificar Drop Zone ---
    const target = e.target as HTMLElement;
    
    // Tenta encontrar a zona de drop (grupo de hábitos)
    let dropZone = target.closest<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
    if (!dropZone) {
        // Fallback para wrapper se o mouse estiver no padding/gap
        const wrapper = target.closest<HTMLElement>('.habit-group-wrapper');
        if (wrapper) dropZone = wrapper.querySelector<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
    }

    if (!dropZone) {
        DragState.targetZone = null;
        DragState.isValidDrop = false;
        return;
    }

    // --- 3. Validar Drop ---
    const targetTime = dropZone.dataset.time as TimeOfDay;
    const isSameGroup = targetTime === DragState.sourceTime;
    
    // Regra: Não pode dropar se o hábito já existe naquele horário (exceto se for o próprio grupo)
    // Permite reordenar no mesmo grupo.
    let isValid = true;
    if (!isSameGroup && DragState.cachedSchedule?.includes(targetTime)) {
        // Exceção: Se for mover, o horário de origem vai sumir. 
        // Mas se ele JÁ existe no destino, não pode duplicar.
        isValid = false;
    }

    DragState.targetZone = dropZone;
    DragState.isValidDrop = isValid;

    // --- 4. Calcular Posição de Inserção (Reorder) ---
    // Encontrar o cartão mais próximo sob o cursor
    const card = target.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
    
    if (card && card !== DragState.sourceEl && dropZone.contains(card)) {
        const rect = card.getBoundingClientRect();
        const midY = rect.top + (rect.height / 2);
        
        DragState.targetCard = card;
        DragState.insertPos = y < midY ? 'before' : 'after';
    } else {
        // Se não está sobre um cartão, assumimos append no final se estiver na zona
        DragState.targetCard = null;
        DragState.insertPos = null;
    }
    
    // Atualiza o efeito do cursor
    e.dataTransfer!.dropEffect = isValid ? 'move' : 'none';
};

const _handleDrop = (e: DragEvent) => {
    e.preventDefault();
    if (!DragState.isActive || !DragState.isValidDrop || !DragState.sourceId || !DragState.sourceTime) return;

    const targetTime = DragState.targetZone!.dataset.time as TimeOfDay;
    const isReorder = DragState.sourceTime === targetTime;
    
    // Executa Ação
    if (isReorder) {
        if (DragState.targetCard && DragState.targetCard.dataset.habitId) {
            triggerHaptic('medium');
            const targetId = DragState.targetCard.dataset.habitId;
            reorderHabit(DragState.sourceId, targetId, DragState.insertPos || 'after');
        }
    } else {
        triggerHaptic('medium');
        // Drop em outro horário
        let reorderInfo = undefined;
        if (DragState.targetCard && DragState.targetCard.dataset.habitId) {
            reorderInfo = {
                id: DragState.targetCard.dataset.habitId,
                pos: DragState.insertPos || 'after'
            };
        }
        
        handleHabitDrop(
            DragState.sourceId,
            DragState.sourceTime,
            targetTime,
            reorderInfo as any // Type assertion compatibilidade
        );
    }
    
    _reset();
};

const _reset = () => {
    if (DragState.rafId) cancelAnimationFrame(DragState.rafId);
    
    // 1. Remove Render Locks
    document.body.classList.remove('is-dragging-active');
    
    // CHAOS FIX: CATCH-UP RENDER
    // Se houve alterações de estado (ex: sync background) enquanto o drag estava ativo,
    // o render loop ignorou. Agora que o lock saiu, precisamos processar o backlog visual.
    if (state.uiDirtyState.habitListStructure || state.uiDirtyState.calendarVisuals) {
        // Usa requestAnimationFrame para garantir que a remoção das classes de drag
        // seja processada pelo browser antes de recalcular o layout complexo.
        requestAnimationFrame(() => renderApp());
    }

    DragState.sourceEl?.classList.remove(CSS_CLASSES.DRAGGING);
    
    if (DragState.container) {
        DragState.container.classList.remove('is-dragging');
    }
    
    if (DragState.renderedZone) {
        DragState.renderedZone.classList.remove(CSS_CLASSES.DRAG_OVER, CSS_CLASSES.INVALID_DROP);
    }
    
    DragState.indicator?.remove();
    
    // Remove Global Listeners
    document.removeEventListener('dragover', _handleDragOver);
    document.removeEventListener('drop', _handleDrop);
    document.removeEventListener('dragend', _reset);

    // Clear State
    DragState.isActive = false;
    DragState.sourceEl = null;
    DragState.targetZone = null;
    DragState.targetCard = null;
    DragState.renderedZone = null;
    DragState.scrollSpeed = 0;
    DragState.containerRect = null; // Clear Cache
};

const _handleDragStart = (e: DragEvent) => {
    if (isCurrentlySwiping()) {
        e.preventDefault();
        return;
    }

    const target = e.target as HTMLElement;
    // Garante que pegamos o cartão mesmo clicando dentro
    const card = target.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
    if (!card || !card.dataset.habitId || !card.dataset.time) return;

    // Inicializa Estado
    DragState.isActive = true;
    DragState.sourceEl = card;
    DragState.sourceId = card.dataset.habitId;
    DragState.sourceTime = card.dataset.time as TimeOfDay;
    
    // PERF: Captura a geometria do container UMA VEZ no início.
    // getBoundingClientRect é custoso, não devemos chamar no dragOver (loop).
    if (DragState.container) {
        DragState.containerRect = DragState.container.getBoundingClientRect();
    }
    
    // Cache de dados do hábito para validação
    const habit = state.habits.find(h => h.id === DragState.sourceId);
    if (habit) {
        DragState.cachedSchedule = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);
    }

    // Configura Drag Data
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', DragState.sourceId);

    // Cria Ghost Image Customizada (Visual)
    const content = card.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
    if (content) {
        const ghost = content.cloneNode(true) as HTMLElement;
        ghost.classList.add(CSS_CLASSES.DRAG_IMAGE_GHOST);
        ghost.style.width = `${content.offsetWidth}px`;
        ghost.style.height = `${content.offsetHeight}px`;
        
        // Copia estilos computados críticos
        const styles = window.getComputedStyle(content);
        ghost.style.backgroundColor = styles.backgroundColor;
        
        document.body.appendChild(ghost);
        e.dataTransfer!.setDragImage(ghost, e.offsetX, e.offsetY);
        
        // Cleanup ghost imediato (o navegador já tirou o snapshot)
        requestAnimationFrame(() => ghost.remove());
    }

    // Cria Indicador de Drop
    DragState.indicator = document.createElement('div');
    DragState.indicator.className = 'drop-indicator';

    // Configura Listeners Globais
    document.addEventListener('dragover', _handleDragOver);
    document.addEventListener('drop', _handleDrop);
    document.addEventListener('dragend', _reset);

    // UI Updates
    triggerHaptic('light');
    requestAnimationFrame(() => {
        card.classList.add(CSS_CLASSES.DRAGGING);
        document.body.classList.add('is-dragging-active');
        if (DragState.container) DragState.container.classList.add('is-dragging');
        _scrollLoop();
    });
};

export function setupDragHandler(container: HTMLElement) {
    DragState.container = container;
    // Otimização: Apenas escutamos dragstart no container.
    // O resto é delegado para document durante o arrasto.
    container.addEventListener('dragstart', _handleDragStart);
}
