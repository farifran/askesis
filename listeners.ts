import { state, saveState } from './state';
import { addDays, parseUTCIsoDate } from './utils';
import { ui } from './ui';
import {
    renderHabits,
    updateCalendarSelection,
    updateHeaderTitle,
    createCalendarDayElement,
    renderStoicQuote,
    showConfirmationModal,
} from './render';
import { setupModalListeners } from './modalListeners';
import { setupHabitCardListeners } from './habitCardListeners';
import { setupSwipeHandler } from './swipeHandler';
import { setupDragAndDropHandler } from './dragAndDropHandler';
import { handleUndoDelete, completeAllHabitsForDate, snoozeAllHabitsForDate } from './habitActions';
import { t } from './i18n';
import { renderChart } from './chart';

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
                updateCalendarSelection();
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

    // Handler para "infinite scroll" do calendário
    const handleCalendarScroll = () => {
        const SCROLL_THRESHOLD = 200; // pixels da borda para acionar o carregamento
        const calendar = ui.calendarStrip;
        
        // Carrega mais datas futuras
        if (calendar.scrollLeft + calendar.clientWidth >= calendar.scrollWidth - SCROLL_THRESHOLD) {
            const lastDate = state.calendarDates[state.calendarDates.length - 1];
            const newDates = Array.from({ length: 30 }, (_, i) => addDays(lastDate, i + 1));
            state.calendarDates.push(...newDates);
            
            // Adiciona apenas os novos dias ao DOM
            const futureFragment = document.createDocumentFragment();
            newDates.forEach(date => futureFragment.appendChild(createCalendarDayElement(date)));
            calendar.appendChild(futureFragment);
        }

        // Carrega mais datas passadas
        if (calendar.scrollLeft <= SCROLL_THRESHOLD) {
            const firstDate = state.calendarDates[0];
            const newDates = Array.from({ length: 30 }, (_, i) => addDays(firstDate, -(i + 1))).reverse();
            
            const oldScrollWidth = calendar.scrollWidth;
            const oldScrollLeft = calendar.scrollLeft;

            state.calendarDates.unshift(...newDates);
            
            // Adiciona apenas os novos dias ao DOM
            const pastFragment = document.createDocumentFragment();
            newDates.forEach(date => pastFragment.appendChild(createCalendarDayElement(date)));
            calendar.prepend(pastFragment);

            // Preserva a posição de rolagem após adicionar elementos no início
            const newScrollWidth = calendar.scrollWidth;
            calendar.scrollLeft = oldScrollLeft + (newScrollWidth - oldScrollWidth);
        }
    };

    ui.calendarStrip.addEventListener('scroll', debounce(handleCalendarScroll, 100));


    // Atualiza o título do cabeçalho se a janela for redimensionada
    window.addEventListener('resize', updateHeaderTitle);

    // Listener para o botão "Desfazer" no toast
    ui.undoBtn.addEventListener('click', handleUndoDelete);

    // Garante que o estado seja salvo antes do usuário sair da página
    window.addEventListener('beforeunload', () => saveState());
};


export const setupEventListeners = () => {
    setupHabitCardListeners();
    setupSwipeHandler(ui.habitContainer);
    setupDragAndDropHandler(ui.habitContainer);
    setupModalListeners();
    setupGlobalListeners();
};