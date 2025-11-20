
import { state } from './state';
import { toUTCIsoDateString, parseUTCIsoDate, debounce, triggerHaptic } from './utils';
import { ui } from './ui';
import {
    renderHabits,
    renderCalendar,
    updateHeaderTitle,
    renderStoicQuote,
    renderAINotificationState,
    openModal,
    renderFullCalendar,
} from './render';
import { setupModalListeners } from './modalListeners';
import { setupHabitCardListeners } from './habitCardListeners';
import { setupSwipeHandler } from './swipeHandler';
import { setupDragAndDropHandler } from './dragAndDropHandler';
import { handleUndoDelete, completeAllHabitsForDate, snoozeAllHabitsForDate } from './habitActions';
import { renderChart } from './chart';
import { updateAppBadge } from './badge';

/**
 * REATORAÇÃO: Centraliza a lógica para atualizar a data selecionada e renderizar a UI.
 * Evita a duplicação de código entre os manipuladores de clique e de teclado.
 * @param newDateISO A nova data selecionada como uma string ISO.
 */
function updateSelectedDateAndRender(newDateISO: string) {
    if (state.selectedDate === newDateISO) {
        return; // Nenhuma alteração necessária
    }
    state.selectedDate = newDateISO;
    renderCalendar();
    updateHeaderTitle();
    renderHabits();
    renderStoicQuote();
    renderChart();
}

/**
 * Lida com mudanças no status da conexão de rede, atualizando a UI.
 */
const handleConnectionChange = () => {
    const isOffline = !navigator.onLine;
    document.body.classList.toggle('is-offline', isOffline);

    // REATORAÇÃO [2024-08-17]: Delega a atualização do estado do botão de IA
    // para a função de renderização centralizada, garantindo consistência.
    renderAINotificationState();

    // Desabilita outros botões dependentes da rede.
    ui.syncSection.querySelectorAll('button').forEach(button => {
        button.disabled = isOffline;
    });
};

/**
 * Lida com interações de múltiplos cliques na faixa de calendário para ações rápidas.
 * - Clique único: Seleciona o dia.
 * - Clique duplo: Completa todos os hábitos do dia.
 * - Clique triplo: Adia todos os hábitos do dia.
 */
function _setupCalendarMultiClickHandler(calendarStrip: HTMLElement) {
    let clickTimeout: number | null = null;
    let clickCount = 0;
    let lastClickDate: string | null = null;
    const CLICK_DELAY = 250;

    calendarStrip.addEventListener('click', (e: MouseEvent) => {
        const dayItem = (e.target as HTMLElement).closest<HTMLElement>('.day-item');
        if (!dayItem?.dataset.date) return;
        
        const date = dayItem.dataset.date;

        // Reseta o contador se clicar em um dia diferente
        if (date !== lastClickDate) {
            clickCount = 1;
            lastClickDate = date;
            triggerHaptic('selection');
            updateSelectedDateAndRender(date); // Ação de clique único
        } else {
            clickCount++;
        }
        
        if (clickTimeout) {
            clearTimeout(clickTimeout);
        }
    
        // Aguarda por mais cliques antes de disparar ações de múltiplos cliques
        clickTimeout = window.setTimeout(() => {
            if (clickCount === 2) {
                triggerHaptic('medium');
                completeAllHabitsForDate(date);
            } else if (clickCount >= 3) {
                triggerHaptic('heavy');
                snoozeAllHabitsForDate(date);
            }
            // Reseta após o atraso
            clickCount = 0;
            lastClickDate = null;
        }, CLICK_DELAY);
    });
}

/**
 * Lida com interações de "long-press" na faixa de calendário para abrir a visualização do calendário completo.
 */
function _setupCalendarLongPressHandler(calendarStrip: HTMLElement) {
    let longPressTimer: number | null = null;
    let longPressStartX = 0;
    let longPressStartY = 0;
    let longPressFired = false;
    let pressedElement: HTMLElement | null = null;

    const cleanup = () => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        if (pressedElement) {
            pressedElement.classList.remove('is-pressing');
            pressedElement = null;
        }
        window.removeEventListener('pointermove', handlePointerMoveForLongPress);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointerleave', cleanup);
    };

    const handlePointerMoveForLongPress = (e: PointerEvent) => {
        // Se o ponteiro se mover muito, é um scroll, não um "long-press"
        if (Math.abs(e.clientX - longPressStartX) > 10 || Math.abs(e.clientY - longPressStartY) > 10) {
            cleanup();
        }
    };

    calendarStrip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; // Apenas para o botão primário
        
        longPressStartX = e.clientX;
        longPressStartY = e.clientY;
        longPressFired = false;
        
        pressedElement = (e.target as HTMLElement).closest<HTMLElement>('.day-item');
        if (pressedElement) {
            pressedElement.classList.add('is-pressing');
        }

        window.addEventListener('pointermove', handlePointerMoveForLongPress);
        window.addEventListener('pointerup', cleanup);
        window.addEventListener('pointerleave', cleanup);
        
        // UX-OPTIMIZATION [2024-12-26]: Tempo de long-press reduzido para 500ms.
        // 750ms parecia muito lento e não responsivo.
        longPressTimer = window.setTimeout(() => {
            longPressFired = true;
            // Armazena a referência ao dia antes de cleanup remover a classe
            const dayItem = pressedElement;
            cleanup(); // Remove listeners e classe visual
            
            if (dayItem) {
                 triggerHaptic('medium');
                 const dateToOpen = dayItem.dataset.date ? parseUTCIsoDate(dayItem.dataset.date) : parseUTCIsoDate(state.selectedDate);
                 
                 state.fullCalendar.year = dateToOpen.getUTCFullYear();
                 state.fullCalendar.month = dateToOpen.getUTCMonth();
                 renderFullCalendar();
                 openModal(ui.fullCalendarModal);
            }
        }, 500);
    });

    // Suprime o evento de clique que se segue a um "long-press" bem-sucedido para evitar ações de clique único
    calendarStrip.addEventListener('click', (e) => {
        if (longPressFired) {
            e.stopImmediatePropagation();
        }
    }, true); // Usa a fase de captura para capturar o evento mais cedo
    
    // Desativa o menu de contexto no "long-press" (para dispositivos móveis)
    calendarStrip.addEventListener('contextmenu', (e) => e.preventDefault());
}

/**
 * Lida com a navegação por teclado (ArrowLeft, ArrowRight) para a faixa de calendário.
 */
function _setupCalendarKeyboardHandler(calendarStrip: HTMLElement) {
    calendarStrip.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const currentSelected = calendarStrip.querySelector('.selected');
            if (!currentSelected) return;

            const direction = e.key === 'ArrowLeft' ? -1 : 1;
            const newIndex = state.calendarDates.findIndex(d => toUTCIsoDateString(d) === state.selectedDate) + direction;
            
            if (newIndex >= 0 && newIndex < state.calendarDates.length) {
                const newDate = state.calendarDates[newIndex];
                const newDateISO = toUTCIsoDateString(newDate);
                
                updateSelectedDateAndRender(newDateISO);
                
                // Adia o foco até depois do próximo ciclo de renderização
                requestAnimationFrame(() => {
                    const newSelectedEl = calendarStrip.querySelector<HTMLElement>(`.day-item[data-date="${state.selectedDate}"]`);
                    newSelectedEl?.focus();
                });
            }
        }
    });
}


/**
 * REATORAÇÃO DE MODULARIDADE: Agrupa todos os listeners de interação do calendário
 * (clique, clique-múltiplo, long-press e teclado) em uma única função para
 * melhorar a organização e legibilidade.
 */
const _setupCalendarInteractionListeners = () => {
    _setupCalendarMultiClickHandler(ui.calendarStrip);
    _setupCalendarLongPressHandler(ui.calendarStrip);
    _setupCalendarKeyboardHandler(ui.calendarStrip);
};

/**
 * REATORAÇÃO DE MODULARIDADE: Configura listeners de eventos relacionados à janela e ao estado do documento.
 */
const _setupWindowListeners = () => {
    const debouncedResize = debounce(() => {
        updateHeaderTitle();
        renderChart();
    }, 250);
    window.addEventListener('resize', debouncedResize);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            updateAppBadge();
        }
    });

    window.addEventListener('online', handleConnectionChange);
    window.addEventListener('offline', handleConnectionChange);
    handleConnectionChange(); // Checagem inicial
};

/**
 * REATORAÇÃO DE MODULARIDADE: Configura listeners para interações globais da UI, como o botão "Desfazer".
 */
const _setupGlobalInteractionListeners = () => {
    ui.undoBtn.addEventListener('click', () => {
        triggerHaptic('medium');
        handleUndoDelete();
    });

    document.addEventListener('pointerdown', (e) => {
        const target = e.target as HTMLElement;

        if (target.closest('.modal-overlay.visible')) {
            return;
        }

        const openCard = document.querySelector('.habit-card.is-open-left, .habit-card.is-open-right');
        
        if (openCard && !target.closest('.habit-card')) {
            openCard.classList.remove('is-open-left', 'is-open-right');
        }
    });
};

/**
 * REATORAÇÃO DE MODULARIDADE: A função `setupGlobalListeners` foi dividida em múltiplos helpers
 * para melhorar a clareza e a separação de responsabilidades.
 */
const setupGlobalListeners = () => {
    _setupCalendarInteractionListeners();
    _setupWindowListeners();
    _setupGlobalInteractionListeners();
};


export function setupEventListeners() {
    setupGlobalListeners();
    setupModalListeners();
    setupHabitCardListeners();
    setupSwipeHandler(ui.habitContainer);
    setupDragAndDropHandler(ui.habitContainer);
}