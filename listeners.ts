import { state, saveState, TIMES_OF_DAY } from './state';
import { addDays, parseUTCIsoDate, toUTCIsoDateString } from './utils';
import { ui } from './ui';
import {
    renderHabits,
    renderCalendar,
    updateHeaderTitle,
    createCalendarDayElement,
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
import { updateUserHabitTags } from './cloud';

/**
 * Cria uma função "debounced" que atrasa a invocação de `func` até que `wait`
 * milissegundos tenham se passado desde a última vez que a função debounced foi invocada.
 */
function debounce<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: number | null = null;
    return function(this: ThisParameterType<T>, ...args: Parameters<T>): void {
        const context = this;
        if (timeout !== null) clearTimeout(timeout);
        timeout = window.setTimeout(() => {
            timeout = null;
            func.apply(context, args);
        }, wait);
    };
}

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
            if (state.selectedDate !== date) {
                state.selectedDate = date;
                renderCalendar();
                updateHeaderTitle();
                renderHabits();
                renderStoicQuote();
                renderChart();
            }
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

    // Keyboard navigation for calendar strip
    ui.calendarStrip.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const currentSelected = ui.calendarStrip.querySelector('.selected');
            if (!currentSelected) return;

            const direction = e.key === 'ArrowLeft' ? -1 : 1;
            const newIndex = state.calendarDates.findIndex(d => toUTCIsoDateString(d) === state.selectedDate) + direction;
            
            if (newIndex >= 0 && newIndex < state.calendarDates.length) {
                const newDate = state.calendarDates[newIndex];
                state.selectedDate = toUTCIsoDateString(newDate);
                renderCalendar();
                updateHeaderTitle();
                renderHabits();
                renderStoicQuote();
                renderChart();
                const newSelectedEl = ui.calendarStrip.querySelector<HTMLElement>(`.day-item[data-date="${state.selectedDate}"]`);
                newSelectedEl?.focus();
            }
        }
    });

    // Keyboard navigation for habit groups (collapsing)
    ui.habitContainer.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            const target = e.target as HTMLElement;
            const wrapper = target.closest<HTMLElement>('.habit-group-wrapper.is-collapsible');
            if (wrapper) {
                e.preventDefault();
                wrapper.classList.toggle('is-collapsed');
            }
        }
    });

    ui.habitContainer.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const header = target.closest<HTMLElement>('.habit-group-wrapper.is-collapsible h2');
        if (header) {
            header.parentElement?.classList.toggle('is-collapsed');
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