import { state, FilterType, FILTERS, addDays, saveState } from './state';
import { ui } from './ui';
import {
    renderHabits,
    updateCalendarSelection,
    updateHeaderTitle,
    renderFilters,
    createCalendarDayElement,
    renderStoicQuote,
} from './render';
import { setupModalListeners } from './modalListeners';
import { setupHabitCardListeners } from './habitCardListeners';
import { setupSwipeHandler } from './swipeHandler';
import { setupDragAndDropHandler } from './dragAndDropHandler';
import { handleUndoDelete, completeAllHabitsForDate, snoozeAllHabitsForDate } from './habitActions';

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
    const CLICK_DELAY = 250; // ms

    // Listener para a faixa de calendário (gerencia clique, duplo e triplo)
    ui.calendarStrip.addEventListener('click', (e) => {
        const dayItem = (e.target as HTMLElement).closest<HTMLElement>('.day-item');
        if (!dayItem?.dataset.date) return;

        const date = dayItem.dataset.date;
        clickCount++;

        // No primeiro clique de uma sequência, executa a ação de clique simples imediatamente
        // para uma resposta de UI mais rápida e para garantir que o estado de seleção esteja correto
        // antes que as ações de clique duplo/triplo sejam acionadas.
        if (clickCount === 1) {
            state.selectedDate = date;
            updateCalendarSelection();
            updateHeaderTitle();
            renderHabits();
            renderStoicQuote();
        }

        if (clickTimeout) {
            clearTimeout(clickTimeout);
        }

        // Atrasamos a execução para verificar se mais cliques ocorreram para "aprimorar" a ação.
        clickTimeout = window.setTimeout(() => {
            // A ação de clique simples já foi executada, então só precisamos lidar com múltiplos cliques.
            if (clickCount === 2) {
                completeAllHabitsForDate(date);
            } else if (clickCount >= 3) {
                snoozeAllHabitsForDate(date);
            }
            // Reseta a contagem após a ação ser executada.
            clickCount = 0;
        }, CLICK_DELAY);
    });

    // Listener para o novo filtro de horários rotativo (com swipe e teclado)
    const handleFilterChange = (direction: 'next' | 'prev') => {
        const currentIndex = FILTERS.indexOf(state.activeFilter);
        let nextIndex;
        if (direction === 'next') {
            nextIndex = (currentIndex + 1) % FILTERS.length;
        } else {
            nextIndex = (currentIndex - 1 + FILTERS.length) % FILTERS.length;
        }
        state.activeFilter = FILTERS[nextIndex];
        renderFilters();
        renderHabits();
    };

    ui.timeFilterPrev.addEventListener('click', () => handleFilterChange('prev'));
    ui.timeFilterNext.addEventListener('click', () => handleFilterChange('next'));
    ui.timeFilterViewport.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') handleFilterChange('next');
        else if (e.key === 'ArrowLeft') handleFilterChange('prev');
    });

    // Swipe handler para o novo filtro de carrossel
    let filterStartX = 0;
    let filterIsSwiping = false;
    let startTransformX = 0;
    let itemWidth = 52; // Valor padrão de fallback
    const SWIPE_THRESHOLD = 30; // pixels

    const filterPointerMove = (e: PointerEvent) => {
        if (!filterIsSwiping) return;
        const currentX = e.clientX;
        const diffX = currentX - filterStartX;
        const newTranslateX = startTransformX + diffX;

        // Limita a translação para evitar o deslize além das extremidades
        const minTranslateX = -(FILTERS.length - 1) * itemWidth;
        const maxTranslateX = 0;
        const clampedTranslateX = Math.max(minTranslateX, Math.min(maxTranslateX, newTranslateX));

        ui.timeFilterReel.style.transform = `translateX(${clampedTranslateX}px)`;
    };

    const filterPointerUp = (e: PointerEvent) => {
        if (!filterIsSwiping) return;

        const currentX = e.clientX;
        const diffX = currentX - filterStartX;

        let currentIndex = FILTERS.indexOf(state.activeFilter);
        if (Math.abs(diffX) > SWIPE_THRESHOLD) {
            if (diffX < 0) { // Deslizou para a esquerda
                currentIndex = Math.min(FILTERS.length - 1, currentIndex + 1);
            } else { // Deslizou para a direita
                currentIndex = Math.max(0, currentIndex - 1);
            }
        }
        
        state.activeFilter = FILTERS[currentIndex];
        renderFilters(); // Anima para a posição correta
        renderHabits();

        setTimeout(() => {
            ui.timeFilterReel.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
        }, 50);

        window.removeEventListener('pointermove', filterPointerMove);
        window.removeEventListener('pointerup', filterPointerUp);
        filterIsSwiping = false;
    };

    ui.timeFilterViewport.addEventListener('pointerdown', (e: PointerEvent) => {
        filterStartX = e.clientX;
        filterIsSwiping = true;

        // Lê a largura do item dinamicamente do DOM
        const firstOption = ui.timeFilterReel.querySelector('.reel-option') as HTMLElement | null;
        itemWidth = firstOption?.offsetWidth || 52;

        const currentStyle = window.getComputedStyle(ui.timeFilterReel);
        const matrix = new DOMMatrix(currentStyle.transform);
        startTransformX = matrix.m41;

        ui.timeFilterReel.style.transition = 'none'; // Remove transição para manipulação direta
        window.addEventListener('pointermove', filterPointerMove);
        window.addEventListener('pointerup', filterPointerUp);
    });

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