import { state, saveState, TIMES_OF_DAY } from './state';
import { addDays, parseUTCIsoDate, toUTCIsoDateString, debounce } from './utils';
import { ui } from './ui';
import {
    renderHabits,
    renderCalendar,
    updateHeaderTitle,
    renderStoicQuote,
    showConfirmationModal,
    updateNotificationUI,
} from './render';
import { setupModalListeners } from './modalListeners';
import { setupHabitCardListeners } from './habitCardListeners';
import { setupSwipeHandler } from './swipeHandler';
import { setupDragAndDropHandler } from './dragAndDropHandler';
import { handleUndoDelete, completeAllHabitsForDate, snoozeAllHabitsForDate } from './habitActions';
import { t } from './i18n';
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
};


const setupGlobalListeners = () => {
    let clickTimeout: number | null = null;
    let clickCount = 0;
    let lastClickElement: HTMLElement | null = null;
    const CLICK_DELAY = 300; // Atraso aumentado para cliques múltiplos mais tolerantes

    const handleCalendarClick = (e: MouseEvent) => {
        const dayItem = (e.target as HTMLElement).closest<HTMLElement>('.day-item');
        if (!dayItem?.dataset.date) return;
        
        const date = dayItem.dataset.date;

        // Se clicar em um item de dia diferente, reinicia o contador.
        if (dayItem !== lastClickElement) {
            clickCount = 0;
            if (clickTimeout) {
                clearTimeout(clickTimeout);
            }
        }
        lastClickElement = dayItem;
        
        clickCount++;

        if (clickTimeout) {
            clearTimeout(clickTimeout);
        }

        // Lida imediatamente com o primeiro clique para responsividade (seleção de dia)
        if (clickCount === 1) {
            updateSelectedDateAndRender(date);
        }
        
        // Define um timeout para aguardar mais cliques antes de disparar ações em massa
        clickTimeout = window.setTimeout(() => {
            // O timeout disparou. Agora executa a ação com base na contagem final de cliques.
            if (clickCount === 2) {
                completeAllHabitsForDate(date);
            } else if (clickCount >= 3) {
                snoozeAllHabitsForDate(date);
            }
            
            // Reinicia para a próxima série de cliques.
            clickCount = 0;
            lastClickElement = null;
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
};

export const setupEventListeners = () => {
    setupGlobalListeners();
    setupModalListeners();
    setupHabitCardListeners();
    setupSwipeHandler(ui.habitContainer);
    setupDragAndDropHandler(ui.habitContainer);
};