import { state } from './state';
import { toUTCIsoDateString, debounce } from './utils';
import { ui } from './ui';
import {
    renderHabits,
    renderCalendar,
    updateHeaderTitle,
    renderStoicQuote,
    renderAINotificationState,
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


const setupGlobalListeners = () => {
    let clickTimeout: number | null = null;
    let clickCount = 0;
    // BUGFIX [2024-08-15]: Usa a string da data em vez da referência do elemento para rastrear cliques.
    // Isso sobrevive a re-renderizações, corrigindo o bug onde cliques múltiplos em um novo dia falhavam.
    let lastClickDate: string | null = null;
    const CLICK_DELAY = 250; // Atraso padrão para distinguir cliques múltiplos.

    // UX IMPROVEMENT [2024-08-22]: O manipulador de cliques do calendário foi refatorado para fornecer feedback imediato.
    // A ação de clique único (selecionar dia) agora ocorre instantaneamente para uma melhor capacidade de resposta da UI,
    // enquanto a lógica de múltiplos cliques é preservada por meio de um temporizador.
    const handleCalendarClick = (e: MouseEvent) => {
        const dayItem = (e.target as HTMLElement).closest<HTMLElement>('.day-item');
        if (!dayItem?.dataset.date) return;
        
        const date = dayItem.dataset.date;

        if (date !== lastClickDate) {
            clickCount = 1; // É o primeiro clique para esta data
            lastClickDate = date;
            updateSelectedDateAndRender(date); // Ação IMEDIATA para responsividade
        } else {
            clickCount++; // Clique subsequente na mesma data
        }
        
        if (clickTimeout) {
            clearTimeout(clickTimeout);
        }
    
        // O temporizador agora apenas aciona ações de múltiplos cliques ou reseta o contador.
        clickTimeout = window.setTimeout(() => {
            if (clickCount === 2) {
                completeAllHabitsForDate(date);
            } else if (clickCount >= 3) {
                snoozeAllHabitsForDate(date);
            }
            // Reseta após o tempo limite, independentemente do que aconteceu.
            clickCount = 0;
            lastClickDate = null;
        }, CLICK_DELAY);
    };
    
    ui.calendarStrip.addEventListener('click', handleCalendarClick);

    ui.undoBtn.addEventListener('click', handleUndoDelete);

    const debouncedResize = debounce(() => {
        updateHeaderTitle();
        renderChart();
    }, 250);
    window.addEventListener('resize', debouncedResize);

    document.addEventListener('visibilitychange', () => {
        // Atualiza o emblema quando o aplicativo se torna visível, pois o dia pode ter mudado.
        if (document.visibilityState === 'visible') {
            updateAppBadge();
        }
    });

    // Listeners para o status da conexão
    window.addEventListener('online', handleConnectionChange);
    window.addEventListener('offline', handleConnectionChange);
    // Verifica o estado inicial da conexão no carregamento
    handleConnectionChange();

    // Keyboard navigation for calendar strip
    ui.calendarStrip.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const currentSelected = ui.calendarStrip.querySelector('.selected');
            if (!currentSelected) return;

            const direction = e.key === 'ArrowLeft' ? -1 : 1;
            const newIndex = state.calendarDates.findIndex(d => toUTCIsoDateString(d) === state.selectedDate) + direction;
            
            if (newIndex >= 0 && newIndex < state.calendarDates.length) {
                const newDate = state.calendarDates[newIndex];
                const newDateISO = toUTCIsoDateString(newDate);
                
                updateSelectedDateAndRender(newDateISO);
                
                // Adia a focagem para após a renderização para garantir que o elemento exista
                requestAnimationFrame(() => {
                    const newSelectedEl = ui.calendarStrip.querySelector<HTMLElement>(`.day-item[data-date="${state.selectedDate}"]`);
                    newSelectedEl?.focus();
                });
            }
        }
    });

    // UX IMPROVEMENT [2024-08-21]: Adiciona um listener global para fechar cartões de hábito abertos por deslize ao clicar em qualquer lugar fora deles, melhorando a fluidez da UI.
    document.addEventListener('pointerdown', (e) => {
        const target = e.target as HTMLElement;

        // Se um modal estiver visível, não interfere. Clicar no overlay de um modal já tem seu próprio comportamento de fechamento.
        if (target.closest('.modal-overlay.visible')) {
            return;
        }

        const openCard = document.querySelector('.habit-card.is-open-left, .habit-card.is-open-right');
        
        // Se houver um cartão aberto e o clique foi fora dele.
        if (openCard && !openCard.contains(target)) {
            openCard.classList.remove('is-open-left', 'is-open-right');
        }
    });
};

export const setupEventListeners = () => {
    setupGlobalListeners();
    setupModalListeners();
    setupHabitCardListeners();
    setupSwipeHandler(ui.habitContainer);
    setupDragAndDropHandler(ui.habitContainer);
};