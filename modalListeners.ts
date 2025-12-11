
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída.
// [NOTA COMPARATIVA]: Este arquivo atua como o 'Controlador de Interações Modais'. Diferente de 'habitActions.ts' (Regras de Negócio) ou 'render.ts' (Manipulação DOM), este módulo foca exclusivamente em capturar a intenção do usuário e delegar a execução. O código está bem desacoplado, utilizando event delegation para listas e helpers privados para lógica de formulário.

import { ui } from './ui';
import { state, LANGUAGES, PREDEFINED_HABITS, saveState, STREAK_SEMI_CONSOLIDATED, STREAK_CONSOLIDATED, FREQUENCIES, invalidateChartCache, DAYS_IN_CALENDAR } from './state';
import {
    openModal,
    closeModal,
    setupManageModal,
    renderExploreHabits,
    initializeModalClosing,
    showConfirmationModal,
    renderLanguageFilter,
    renderAINotificationState,
    openEditModal,
    updateNotificationUI,
    renderFrequencyOptions,
    renderIconPicker,
    renderColorPicker,
    renderFullCalendar,
    renderApp,
} from './render';
import {
    saveHabitFromModal,
    requestHabitEndingFromModal,
    requestHabitPermanentDeletion,
    requestHabitEditingFromModal,
    resetApplicationData,
    handleSaveNote,
    graduateHabit,
    performAIAnalysis,
    exportData,
    importData,
} from './habitActions';
import { setLanguage, t, getHabitDisplayInfo } from './i18n';
import { setupReelRotary } from './rotary';
import { simpleMarkdownToHTML, pushToOneSignal, getContrastColor, addDays, parseUTCIsoDate, toUTCIsoDateString } from './utils';

// REFACTOR [2024-09-02]: Centraliza a lógica de processamento e formatação de celebrações
// para remover duplicação de código e melhorar a legibilidade no listener do botão de IA.
const _processAndFormatCelebrations = (
    pendingIds: string[], 
    translationKey: 'aiCelebration21Day' | 'aiCelebration66Day',
    // NOVO PARÂMETRO: O marco de streak para construir a chave de notificação correta.
    streakMilestone: number
): string => {
    if (pendingIds.length === 0) return '';
    
    const habitNames = pendingIds
        .map(id => state.habits.find(h => h.id === id))
        .filter(Boolean)
        .map(h => getHabitDisplayInfo(h!).name)
        .join(', ');
        
    // CORREÇÃO DE LÓGICA [2024-10-23]: Utiliza a chave composta ('habitId-dias') para marcar
    // as celebrações como "vistas", garantindo que cada marco seja rastreado independentemente.
    pendingIds.forEach(id => {
        const celebrationId = `${id}-${streakMilestone}`;
        if (!state.notificationsShown.includes(celebrationId)) {
            state.notificationsShown.push(celebrationId);
        }
    });

    return t(translationKey, { count: pendingIds.length, habitNames });
};

// --- PRIVATE HELPERS (MODAL FORMS) ---

/**
 * REATORAÇÃO DE MODULARIDADE: Lida com a mudança do tipo de frequência (diária, dias específicos, intervalo).
 */
function _handleFrequencyTypeChange(radio: HTMLInputElement) {
    if (!state.editingHabit) return;

    const type = radio.value as 'daily' | 'interval' | 'specific_days_of_week';
    switch (type) {
        case 'daily':
            state.editingHabit.formData.frequency = { type: 'daily' };
            break;
        case 'specific_days_of_week':
            // Mantém os dias já selecionados, ou inicializa como um array vazio se estiver mudando de outro tipo.
            const currentFreq = state.editingHabit.formData.frequency;
            const days = currentFreq.type === 'specific_days_of_week' ? currentFreq.days : [];
            state.editingHabit.formData.frequency = { type: 'specific_days_of_week', days };
            break;
        case 'interval':
            // Usa o padrão do template ou mantém os valores atuais se já for um intervalo.
            const intervalFreqTpl = FREQUENCIES.find(f => f.value.type === 'interval')!.value as { type: 'interval', unit: 'days' | 'weeks', amount: number };
            const currentIntervalFreq = state.editingHabit.formData.frequency;
            const amount = (currentIntervalFreq.type === 'interval' ? currentIntervalFreq.amount : intervalFreqTpl.amount);
            const unit = (currentIntervalFreq.type === 'interval' ? currentIntervalFreq.unit : intervalFreqTpl.unit);
            state.editingHabit.formData.frequency = { type: 'interval', amount, unit };
            break;
    }
    renderFrequencyOptions();
}

/**
 * REATORAÇÃO DE MODULARIDADE: Lida com a seleção/desseleção de dias da semana.
 */
function _handleWeekdaySelectionChange() {
    if (!state.editingHabit) return;

    const days = Array.from(ui.frequencyOptionsContainer.querySelectorAll<HTMLInputElement>('.weekday-picker input:checked'))
        .map(el => parseInt(el.dataset.day!, 10));
    state.editingHabit.formData.frequency = { type: 'specific_days_of_week', days };
    // A re-renderização não é necessária aqui, pois a UI (checkbox) já foi atualizada pelo clique do usuário.
}

/**
 * REATORAÇÃO DE MODULARIDADE: Lida com os controles de intervalo (incremento/decremento/unidade).
 */
function _handleIntervalControlChange(button: HTMLButtonElement) {
    if (!state.editingHabit || state.editingHabit.formData.frequency.type !== 'interval') return;

    const action = button.dataset.action;
    const currentFreq = state.editingHabit.formData.frequency;
    let { amount, unit } = currentFreq;

    if (action === 'interval-decrement') amount = Math.max(1, amount - 1);
    if (action === 'interval-increment') amount = Math.min(99, amount + 1);
    if (action === 'interval-unit-toggle') unit = unit === 'days' ? 'weeks' : 'days';

    state.editingHabit.formData.frequency = { type: 'interval', amount, unit };
    renderFrequencyOptions();
}

/**
 * REATORAÇÃO DE MODULARIDADE: Centraliza a lógica de validação do nome do hábito,
 * gerenciando o feedback da UI para erros e retornando a validade.
 */
function _validateHabitName(newName: string, currentHabitId?: string): boolean {
    const duplicateNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.duplicate-habit-notice')!;
    const formNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice')!;
    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;

    // Reseta as notificações e animações
    duplicateNoticeEl.classList.remove('visible');
    formNoticeEl.classList.remove('visible');
    habitNameInput.classList.remove('shake');

    // Verifica se está vazio
    if (newName.length === 0) {
        formNoticeEl.textContent = t('noticeNameCannotBeEmpty');
        formNoticeEl.classList.add('visible');
        
        // Trigger shake animation for visual feedback
        requestAnimationFrame(() => {
            habitNameInput.classList.add('shake');
            habitNameInput.addEventListener('animationend', () => {
                habitNameInput.classList.remove('shake');
            }, { once: true });
        });
        
        return false;
    }

    // Verifica se há duplicatas
    const isDuplicate = state.habits.some(h => {
        const { name } = getHabitDisplayInfo(h, state.selectedDate);
        return name.toLowerCase() === newName.toLowerCase() && h.id !== currentHabitId;
    });

    if (isDuplicate) {
        duplicateNoticeEl.textContent = t('noticeDuplicateHabitWithName');
        duplicateNoticeEl.classList.add('visible');
        
        // Trigger shake animation for visual feedback
        requestAnimationFrame(() => {
            habitNameInput.classList.add('shake');
            habitNameInput.addEventListener('animationend', () => {
                habitNameInput.classList.remove('shake');
            }, { once: true });
        });
        
        return false;
    }

    return true;
}


export function setupModalListeners() {
    // --- Inicialização Geral de Modais ---
    // REATORAÇÃO DE ESTADO [2024-10-26]: A inicialização de fechamento dos modais de edição
    // foi separada para incluir callbacks `onClose`. Isso previne "vazamentos de estado"
    // onde dados temporários (state.editingHabit, state.editingNoteFor) persistiam
    // desnecessariamente após o cancelamento, tornando a aplicação mais robusta.
    const modalsToInitialize = [
        ui.manageModal,
        ui.exploreModal,
        ui.confirmModal,
        ui.aiOptionsModal,
        ui.fullCalendarModal,
    ];
    modalsToInitialize.forEach(modal => initializeModalClosing(modal));

    // Lida com o fechamento dos modais de edição para limpar o estado temporário
    initializeModalClosing(ui.editHabitModal, () => {
        state.editingHabit = null;
    });
    initializeModalClosing(ui.notesModal, () => {
        state.editingNoteFor = null;
    });
    initializeModalClosing(ui.iconPickerModal);
    initializeModalClosing(ui.colorPickerModal, () => {
        ui.iconPickerModal.classList.remove('is-picking-color');
        renderIconPicker();
    });


    // A lógica de fechamento customizada para o modal de IA agora é injetada como um callback.
    initializeModalClosing(ui.aiModal, () => {
        state.hasSeenAIResult = true;
        renderAINotificationState();
    });

    // --- Botões para Abrir Modais Principais ---
    ui.manageHabitsBtn.addEventListener('click', () => {
        setupManageModal();
        updateNotificationUI();
        openModal(ui.manageModal);
    });

    ui.fabAddHabit.addEventListener('click', () => {
        renderExploreHabits();
        openModal(ui.exploreModal);
    });
    
    // --- Modal de Gerenciamento de Hábitos (Manage) ---
    // Listeners para os botões de lista (via delegação no elemento pai)
    ui.habitList.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const button = target.closest<HTMLButtonElement>('button');
        if (!button) return;

        const habitId = button.closest<HTMLLIElement>('li.habit-list-item')?.dataset.habitId;
        if (!habitId) return;

        if (button.classList.contains('end-habit-btn')) {
            requestHabitEndingFromModal(habitId);
        } else if (button.classList.contains('permanent-delete-habit-btn')) {
            requestHabitPermanentDeletion(habitId);
        } else if (button.classList.contains('edit-habit-btn')) {
            requestHabitEditingFromModal(habitId);
        } else if (button.classList.contains('graduate-habit-btn')) {
            graduateHabit(habitId);
        }
    });

    // Listeners para os botões de Dados e Privacidade (Adicionados dinamicamente)
    // Usamos delegação no modal de gerenciamento para capturar o clique, pois os botões são injetados.
    ui.manageModal.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.id === 'export-data-btn') {
            exportData();
        } else if (target.id === 'import-data-btn') {
            importData();
        }
    });

    ui.resetAppBtn.addEventListener('click', () => {
        showConfirmationModal(
            t('confirmResetApp'),
            resetApplicationData,
            { 
                confirmText: t('modalManageResetButton'), 
                title: t('modalManageReset'),
                // UX-FIX [2024-10-27]: Usa o estilo 'danger' para o botão de confirmação.
                confirmButtonStyle: 'danger'
            }
        );
    });
    
    // --- Seletor de Idioma ---
    setupReelRotary({
        viewportEl: ui.languageViewport,
        reelEl: ui.languageReel,
        prevBtn: ui.languagePrevBtn,
        nextBtn: ui.languageNextBtn,
        optionsCount: LANGUAGES.length,
        getInitialIndex: () => LANGUAGES.findIndex(l => l.code === state.activeLanguageCode),
        onIndexChange: async (index) => {
            const newLang = LANGUAGES[index].code;
            if (newLang !== state.activeLanguageCode) {
                await setLanguage(newLang);
            }
        },
        render: renderLanguageFilter,
    });
    
    // Toggle de Notificações
    ui.notificationToggle.addEventListener('change', async () => {
        pushToOneSignal(async (OneSignal: any) => {
            const isPushEnabled = OneSignal.User.PushSubscription.optedIn;
            if (isPushEnabled) {
                await OneSignal.User.PushSubscription.optOut();
            } else {
                await OneSignal.Notifications.requestPermission();
            }
            // A UI será atualizada pelo listener de 'permissionChange'
        });
    });


    // --- Modal de Exploração de Hábitos (Explore) ---
    // Lida com o clique do mouse
    ui.exploreHabitList.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
        if (!item) return;
        const index = parseInt(item.dataset.index!, 10);
        const habitTemplate = PREDEFINED_HABITS[index];
        if (habitTemplate) {
            // OTIMIZAÇÃO DE UX [2024-12-22]: Se o usuário tentar adicionar um hábito predefinido que
            // já existe e está ativo, o modal de edição é preenchido com o estado atual desse hábito
            // em vez de usar o modelo padrão. Isso evita a criação de duplicatas e permite uma edição mais fácil.
            const existingActiveHabit = state.habits.find(h => {
                const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
                const isActive = !h.graduatedOn && !lastSchedule.endDate;
    
                if (!isActive) return false;
    
                // Compara o 'nameKey' para identificar o hábito predefinido.
                return h.scheduleHistory.some(s => s.nameKey === habitTemplate.nameKey);
            });
    
            closeModal(ui.exploreModal);
            // Abre o modal de edição com o hábito existente (se encontrado e ativo) ou com o modelo padrão.
            openEditModal(existingActiveHabit || habitTemplate);
        }
    });

    // A11Y [2025-01-16]: Adiciona suporte a teclado (Enter/Space) para itens da lista de exploração.
    // Como são divs com role="button", eles não disparam 'click' nativamente com teclas.
    ui.exploreHabitList.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); // Previne rolagem com a barra de espaço
            const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
            if (item) {
                item.click(); // Dispara programaticamente o handler de clique existente
            }
        }
    });

    ui.createCustomHabitBtn.addEventListener('click', () => {
        closeModal(ui.exploreModal);
        openEditModal(null); // Abre sem template para um hábito personalizado
    });

    // --- Modal e Opções da IA ---
    ui.aiEvalBtn.addEventListener('click', () => {
        const celebration21DayText = _processAndFormatCelebrations(state.pending21DayHabitIds, 'aiCelebration21Day', STREAK_SEMI_CONSOLIDATED);
        const celebration66DayText = _processAndFormatCelebrations(state.pendingConsolidationHabitIds, 'aiCelebration66Day', STREAK_CONSOLIDATED);
        
        const allCelebrations = [celebration66DayText, celebration21DayText].filter(Boolean).join('\n\n');

        if (allCelebrations) {
            ui.aiResponse.innerHTML = simpleMarkdownToHTML(allCelebrations);
            openModal(ui.aiModal);
            state.pending21DayHabitIds = [];
            state.pendingConsolidationHabitIds = [];
            saveState(); // Salva que as notificações foram vistas
            renderAINotificationState();
        } else if ((state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult && state.lastAIResult) {
            ui.aiResponse.innerHTML = simpleMarkdownToHTML(state.lastAIResult);
            openModal(ui.aiModal);
        } else {
            openModal(ui.aiOptionsModal);
        }
    });

    ui.aiOptionsModal.addEventListener('click', e => {
        const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.ai-option-btn');
        if (!button) return;
        const analysisType = button.dataset.analysisType as 'monthly' | 'quarterly' | 'historical';
        performAIAnalysis(analysisType);
    });

    // --- Modal de Confirmação ---
    // UX FIX [2025-02-15]: "Close-First" Pattern.
    // O modal deve ser fechado ANTES de executar a ação. Isso previne problemas em fluxos
    // onde a ação abre *outro* modal (Nested Modals), garantindo que o novo modal não seja
    // fechado acidentalmente pela limpeza do antigo.
    ui.confirmModalConfirmBtn.addEventListener('click', () => {
        const action = state.confirmAction;
        
        // Limpa o estado e fecha o modal primeiro
        state.confirmAction = null;
        state.confirmEditAction = null;
        closeModal(ui.confirmModal);
        
        // Executa a ação (se houver)
        action?.();
    });
    
    ui.confirmModalEditBtn.addEventListener('click', () => {
        const editAction = state.confirmEditAction;
        
        // Limpa o estado e fecha o modal primeiro
        state.confirmAction = null;
        state.confirmEditAction = null;
        closeModal(ui.confirmModal);
        
        // Executa a ação de edição (se houver)
        editAction?.();
    });

    // --- Modal de Notas ---
    ui.saveNoteBtn.addEventListener('click', handleSaveNote);

    // --- Modal de Calendário Completo ---
    ui.fullCalendarPrevBtn.addEventListener('click', () => {
        state.fullCalendar.month--;
        if (state.fullCalendar.month < 0) {
            state.fullCalendar.month = 11;
            state.fullCalendar.year--;
        }
        renderFullCalendar();
    });

    ui.fullCalendarNextBtn.addEventListener('click', () => {
        state.fullCalendar.month++;
        if (state.fullCalendar.month > 11) {
            state.fullCalendar.month = 0;
            state.fullCalendar.year++;
        }
        renderFullCalendar();
    });

    ui.fullCalendarGrid.addEventListener('click', (e) => {
        const dayEl = (e.target as HTMLElement).closest<HTMLElement>('.full-calendar-day');
        if (dayEl && dayEl.dataset.date) {
            state.selectedDate = dayEl.dataset.date;
            
            // UX UPDATE [2025-02-16]: Recentraliza a faixa de calendário.
            // Ao saltar para uma data distante via almanaque, a faixa horizontal (calendarStrip)
            // deve ser regenerada para mostrar a data selecionada no centro/foco.
            const newDate = parseUTCIsoDate(state.selectedDate);
            state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
                addDays(newDate, i - 30) // 30 dias atrás, 30 dias à frente
            );

            closeModal(ui.fullCalendarModal);
            
            state.uiDirtyState.calendarVisuals = true;
            state.uiDirtyState.habitListStructure = true;
            invalidateChartCache();
            
            renderApp();

            // Force scroll to the new selection
            requestAnimationFrame(() => {
                const selectedEl = ui.calendarStrip.querySelector('.day-item.selected');
                selectedEl?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
            });
        }
    });

    ui.fullCalendarGrid.addEventListener('keydown', (e) => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key)) {
            return;
        }
        e.preventDefault();
    
        if (e.key === 'Enter' || e.key === ' ') {
            closeModal(ui.fullCalendarModal);
            
            // Também regenera a faixa no enter para consistência
            const newDate = parseUTCIsoDate(state.selectedDate);
            state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
                addDays(newDate, i - 30)
            );

            state.uiDirtyState.calendarVisuals = true;
            state.uiDirtyState.habitListStructure = true;
            invalidateChartCache();
            
            renderApp();
            
            requestAnimationFrame(() => {
                const selectedEl = ui.calendarStrip.querySelector('.day-item.selected');
                selectedEl?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
            });
            return;
        }
    
        const currentSelectedDate = parseUTCIsoDate(state.selectedDate);
        let newDate: Date;
    
        switch (e.key) {
            case 'ArrowRight':
                newDate = addDays(currentSelectedDate, 1);
                break;
            case 'ArrowLeft':
                newDate = addDays(currentSelectedDate, -1);
                break;
            case 'ArrowUp':
                newDate = addDays(currentSelectedDate, -7);
                break;
            case 'ArrowDown':
                newDate = addDays(currentSelectedDate, 7);
                break;
            default:
                return;
        }
    
        state.selectedDate = toUTCIsoDateString(newDate);
    
        if (newDate.getUTCMonth() !== state.fullCalendar.month || newDate.getUTCFullYear() !== state.fullCalendar.year) {
            state.fullCalendar.month = newDate.getUTCMonth();
            state.fullCalendar.year = newDate.getUTCFullYear();
        }
        
        renderFullCalendar();
        
        requestAnimationFrame(() => {
            const newSelectedEl = ui.fullCalendarGrid.querySelector<HTMLElement>(`.full-calendar-day[data-date="${state.selectedDate}"]`);
            newSelectedEl?.focus();
        });
    });


    // --- Modal de Edição/Criação de Hábito ---
    ui.editHabitSaveBtn.addEventListener('click', saveHabitFromModal);

    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    
    habitNameInput.addEventListener('input', () => {
        if (!state.editingHabit) return;
        
        const newName = habitNameInput.value.trim();
        state.editingHabit.formData.name = newName;
        delete state.editingHabit.formData.nameKey; // Nome personalizado sobrescreve o predefinido

        const isValid = _validateHabitName(newName, state.editingHabit.habitId);
        ui.editHabitSaveBtn.disabled = !isValid;
    });

    // Seletor de Ícone
    ui.habitIconPickerBtn.addEventListener('click', () => {
        renderIconPicker();
        openModal(ui.iconPickerModal);
    });

    ui.iconPickerGrid.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const item = target.closest<HTMLButtonElement>('.icon-picker-item');
        if (item && state.editingHabit) {
            const iconSVG = item.dataset.iconSvg!;
            state.editingHabit.formData.icon = iconSVG;
            ui.habitIconPickerBtn.innerHTML = iconSVG;
            closeModal(ui.iconPickerModal);
        }
    });
    
    // --- Seletores de Cor e Ícone ---
    ui.colorPickerGrid.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const swatch = target.closest<HTMLButtonElement>('.color-swatch');
        if (swatch && state.editingHabit) {
            const color = swatch.dataset.color!;
            state.editingHabit.formData.color = color;

            const iconColor = getContrastColor(color);
            ui.habitIconPickerBtn.style.backgroundColor = color;
            ui.habitIconPickerBtn.style.color = iconColor;
            
            ui.colorPickerGrid.querySelector('.selected')?.classList.remove('selected');
            swatch.classList.add('selected');

            ui.iconPickerModal.classList.remove('is-picking-color');
            renderIconPicker();
            closeModal(ui.colorPickerModal);
        }
    });

    ui.changeColorFromPickerBtn.addEventListener('click', () => {
        renderColorPicker();
        ui.iconPickerModal.classList.add('is-picking-color');
        openModal(ui.colorPickerModal);
    });

    // Controle Segmentado de Horário
    ui.habitTimeContainer.addEventListener('click', e => {
        if (!state.editingHabit) return;
        const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.segmented-control-option');
        if (!button) return;

        const time = button.dataset.time as any; // Using any cast to avoid explicit import of TimeOfDay for local DOM handling
        const currentlySelected = state.editingHabit.formData.times.includes(time);

        if (currentlySelected) {
            if (state.editingHabit.formData.times.length > 1) {
                state.editingHabit.formData.times = state.editingHabit.formData.times.filter(t => t !== time);
                button.classList.remove('selected');
            }
        } else {
            state.editingHabit.formData.times.push(time);
            button.classList.add('selected');
        }
    });

    // Opções de Frequência (Refatorado para ser um despachante)
    ui.frequencyOptionsContainer.addEventListener('click', e => {
        const target = e.target as HTMLElement;

        const radio = target.closest<HTMLInputElement>('input[type="radio"]');
        if (radio) {
            _handleFrequencyTypeChange(radio);
            return;
        }

        const dayCheckbox = target.closest<HTMLInputElement>('.weekday-picker input[type="checkbox"]');
        if (dayCheckbox) {
            _handleWeekdaySelectionChange();
            // Nenhuma re-renderização necessária
            return;
        }

        const stepperBtn = target.closest<HTMLButtonElement>('.stepper-btn, .unit-toggle-btn');
        if (stepperBtn) {
            _handleIntervalControlChange(stepperBtn);
        }
    });
}
