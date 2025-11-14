/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 0% concluído. Todos os arquivos precisam ser revisados. Quando um arquivo atingir 100%, não será mais necessário revisá-lo.
import { ui } from './ui';
import { state, LANGUAGES, PREDEFINED_HABITS, TimeOfDay, saveState, STREAK_SEMI_CONSOLIDATED, STREAK_CONSOLIDATED, Frequency, FREQUENCIES } from './state';
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
// FIX: Corrected imports for functions that were missing exports.
import {
    saveHabitFromModal,
    requestHabitEndingFromModal,
    requestHabitPermanentDeletion,
    requestHabitEditingFromModal,
    resetApplicationData,
    handleSaveNote,
    graduateHabit,
    performAIAnalysis,
} from './habitActions';
import { setLanguage, t, getHabitDisplayInfo } from './i18n';
import { setupReelRotary } from './rotary';
import { simpleMarkdownToHTML, pushToOneSignal, getContrastColor } from './utils';
import { icons } from './icons';

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
    ui.habitList.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const button = target.closest<HTMLButtonElement>('[data-action]');
        if (!button) return;

        const habitId = button.closest<HTMLLIElement>('li.habit-list-item')?.dataset.habitId;
        if (!habitId) return;

        const action = button.dataset.action;
        if (action === 'end') {
            requestHabitEndingFromModal(habitId);
        } else if (action === 'permanent-delete') {
            requestHabitPermanentDeletion(habitId);
        } else if (action === 'edit') {
            requestHabitEditingFromModal(habitId);
        } else if (action === 'graduate') {
            graduateHabit(habitId);
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


    // --- Modal de Explorar Hábitos (Explore) ---
    ui.exploreHabitList.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const item = target.closest<HTMLElement>('.explore-habit-item');
        if (item) {
            const index = parseInt(item.dataset.index!, 10);
            const habitTemplate = PREDEFINED_HABITS[index];
            if (habitTemplate) {
                closeModal(ui.exploreModal);
                openEditModal(habitTemplate);
            }
        }
    });

    ui.createCustomHabitBtn.addEventListener('click', () => {
        closeModal(ui.exploreModal);
        openEditModal(null);
    });
    
    // --- Modal de Avaliação/Opções da IA ---
    ui.aiEvalBtn.addEventListener('click', () => {
        // 1. Verifica se há um resultado de análise não visto.
        const hasUnseenResult = (state.aiState === 'completed' || state.aiState === 'error') && !state.hasSeenAIResult;
        if (hasUnseenResult) {
            ui.aiResponse.innerHTML = simpleMarkdownToHTML(state.lastAIResult || '');
            openModal(ui.aiModal);
            return;
        }

        // 2. Se não, verifica se há celebrações de marcos (lógica existente).
        const has21Day = state.pending21DayHabitIds.length > 0;
        const has66Day = state.pendingConsolidationHabitIds.length > 0;

        if (has21Day || has66Day) {
            let celebrationHTML = '';
            if (has21Day) {
                celebrationHTML += _processAndFormatCelebrations(state.pending21DayHabitIds, 'aiCelebration21Day', STREAK_SEMI_CONSOLIDATED);
                state.pending21DayHabitIds = [];
            }
            if (has66Day) {
                celebrationHTML += _processAndFormatCelebrations(state.pendingConsolidationHabitIds, 'aiCelebration66Day', STREAK_CONSOLIDATED);
                state.pendingConsolidationHabitIds = [];
            }

            ui.aiResponse.innerHTML = simpleMarkdownToHTML(celebrationHTML);
            openModal(ui.aiModal);
            renderAINotificationState();
            saveState();
        } else {
            // 3. Se não houver resultados não vistos nem celebrações, abre as opções para uma nova análise.
            openModal(ui.aiOptionsModal);
        }
    });


    ui.aiOptionsModal.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const button = target.closest<HTMLButtonElement>('.ai-option-btn');
        const analysisType = button?.dataset.analysisType as 'weekly' | 'monthly' | 'general' | undefined;
        if (analysisType) {
            performAIAnalysis(analysisType);
        }
    });

    // --- Modal de Confirmação ---
    ui.confirmModalConfirmBtn.addEventListener('click', () => {
        state.confirmAction?.();
        closeModal(ui.confirmModal);
        state.confirmAction = null;
        state.confirmEditAction = null;
    });
    
    ui.confirmModalEditBtn.addEventListener('click', () => {
        state.confirmEditAction?.();
        closeModal(ui.confirmModal);
        state.confirmAction = null;
        state.confirmEditAction = null;
    });

    // --- Modal de Notas ---
    ui.saveNoteBtn.addEventListener('click', handleSaveNote);

    // --- Modal de Edição/Criação de Hábito ---
    ui.editHabitSaveBtn.addEventListener('click', () => {
        saveHabitFromModal();
    });

    ui.editHabitForm.addEventListener('input', (e) => {
        if (!state.editingHabit) return;
        const target = e.target as HTMLElement;
        const noticeEl = ui.editHabitForm.querySelector<HTMLElement>('.duplicate-habit-notice')!;
        
        // Validação de nome duplicado em tempo real
        if (target.id === 'habit-name') {
            const habitName = (target as HTMLInputElement).value.trim();
            const isDuplicate = state.habits.some(h => {
                if (h.id === state.editingHabit?.habitId) return false;
                const { name } = getHabitDisplayInfo(h);
                return name.toLowerCase() === habitName.toLowerCase() && !h.scheduleHistory[h.scheduleHistory.length-1].endDate;
            });
            
            const isNameEmpty = habitName.length === 0;

            if (isDuplicate) {
                noticeEl.textContent = t('noticeDuplicateHabitWithName');
                noticeEl.classList.add('visible');
                ui.editHabitSaveBtn.disabled = true;
            } else if (isNameEmpty) {
                noticeEl.textContent = t('noticeNameCannotBeEmpty');
                noticeEl.classList.add('visible');
                ui.editHabitSaveBtn.disabled = true;
            } else {
                noticeEl.classList.remove('visible');
                ui.editHabitSaveBtn.disabled = false;
            }
        }
    });

    ui.editHabitForm.addEventListener('click', (e) => {
        if (!state.editingHabit) return;
        const target = e.target as HTMLElement;
        
        // Lógica do controle segmentado de horário
        const timeButton = target.closest<HTMLButtonElement>('.segmented-control-option');
        if (timeButton) {
            const time = timeButton.dataset.time as TimeOfDay;
            timeButton.classList.toggle('selected');
            const selectedTimes = Array.from(ui.habitTimeContainer.querySelectorAll<HTMLButtonElement>('.segmented-control-option.selected'))
                .map(btn => btn.dataset.time as TimeOfDay);
            state.editingHabit.formData.times = selectedTimes;
            return;
        }

        // Lógica do seletor de frequência (botões de rádio)
        const radio = target.closest<HTMLInputElement>('input[name="frequency-type"]');
        if (radio) {
            const type = radio.value as Frequency['type'];
            
            // Atualiza a visibilidade dos detalhes
            ui.frequencyOptionsContainer.querySelectorAll('.frequency-details').forEach(el => el.classList.remove('visible'));
            const details = radio.closest('.form-row')?.querySelector('.frequency-details');
            if (details) {
                details.classList.add('visible');
            }
            
            // Atualiza o estado
            if (type === 'daily') {
                state.editingHabit.formData.frequency = { type: 'daily' };
            } else if (type === 'specific_days_of_week') {
                const days = Array.from(ui.frequencyOptionsContainer.querySelectorAll<HTMLInputElement>('.weekday-picker input:checked')).map(input => parseInt(input.dataset.day!));
                state.editingHabit.formData.frequency = { type: 'specific_days_of_week', days };
            } else if (type === 'interval') {
                const amount = parseInt(ui.frequencyOptionsContainer.querySelector('.interval-amount-display')!.textContent || '2');
                const unit = ui.frequencyOptionsContainer.querySelector('.unit-toggle-btn')!.textContent === t('unitWeeks') ? 'weeks' : 'days';
                state.editingHabit.formData.frequency = { type: 'interval', unit, amount };
            }
            return;
        }

        // Lógica para os detalhes da frequência (dias da semana, intervalo)
        const dayCheckbox = target.closest<HTMLInputElement>('.weekday-picker input[type="checkbox"]');
        if (dayCheckbox) {
            const days = Array.from(ui.frequencyOptionsContainer.querySelectorAll<HTMLInputElement>('.weekday-picker input:checked')).map(input => parseInt(input.dataset.day!));
            state.editingHabit.formData.frequency = { type: 'specific_days_of_week', days };
            return;
        }

        const stepperBtn = target.closest<HTMLButtonElement>('.stepper-btn');
        if (stepperBtn) {
            const amountDisplay = ui.frequencyOptionsContainer.querySelector<HTMLElement>('.interval-amount-display')!;
            let amount = parseInt(amountDisplay.textContent || '2');
            const action = stepperBtn.dataset.action;

            if (action === 'interval-increment') amount++;
            else if (action === 'interval-decrement') amount = Math.max(1, amount - 1);

            amountDisplay.textContent = String(amount);
            (state.editingHabit.formData.frequency as { type: 'interval', amount: number }).amount = amount;
            return;
        }

        const unitToggleBtn = target.closest<HTMLButtonElement>('.unit-toggle-btn');
        if (unitToggleBtn) {
            const currentUnit = (state.editingHabit.formData.frequency as { type: 'interval', unit: 'days' | 'weeks' }).unit;
            const newUnit = currentUnit === 'days' ? 'weeks' : 'days';
            unitToggleBtn.textContent = newUnit === 'days' ? t('unitDays') : t('unitWeeks');
            (state.editingHabit.formData.frequency as { type: 'interval', unit: 'days' | 'weeks' }).unit = newUnit;
        }
    });

    ui.habitIconPickerBtn.addEventListener('click', () => {
        renderIconPicker();
        openModal(ui.iconPickerModal);
    });

    // --- Modal de Seletor de Ícones ---
    ui.iconPickerModal.addEventListener('click', e => {
        if (!state.editingHabit) return;
        const target = e.target as HTMLElement;

        const iconItem = target.closest<HTMLButtonElement>('.icon-picker-item');
        if (iconItem) {
            const newIcon = iconItem.dataset.iconSvg!;
            state.editingHabit.formData.icon = newIcon;
            ui.habitIconPickerBtn.innerHTML = newIcon;
            closeModal(ui.iconPickerModal);
            return;
        }

        const changeColorBtn = target.closest<HTMLButtonElement>('#change-color-from-picker-btn');
        if (changeColorBtn) {
            ui.iconPickerModal.classList.add('is-picking-color');
            renderColorPicker();
            openModal(ui.colorPickerModal);
        }
    });

    // --- Modal de Seletor de Cores ---
    ui.colorPickerModal.addEventListener('click', e => {
        if (!state.editingHabit) return;
        const swatch = (e.target as HTMLElement).closest<HTMLButtonElement>('.color-swatch');
        if (swatch) {
            const newColor = swatch.dataset.color!;
            state.editingHabit.formData.color = newColor;

            // Atualiza a visualização do botão de ícone no formulário principal
            ui.habitIconPickerBtn.style.backgroundColor = newColor;
            ui.habitIconPickerBtn.style.color = getContrastColor(newColor);
            
            closeModal(ui.colorPickerModal);
            closeModal(ui.iconPickerModal);
        }
    });

    // --- Modal de Calendário Completo ---
    const updateFullCalendarMonth = (direction: -1 | 1) => {
        let { year, month } = state.fullCalendar;
        month += direction;
        if (month > 11) {
            month = 0;
            year++;
        } else if (month < 0) {
            month = 11;
            year--;
        }
        state.fullCalendar.year = year;
        state.fullCalendar.month = month;
        renderFullCalendar();
    };

    ui.fullCalendarPrevBtn.addEventListener('click', () => updateFullCalendarMonth(-1));
    ui.fullCalendarNextBtn.addEventListener('click', () => updateFullCalendarMonth(1));

    ui.fullCalendarGrid.addEventListener('click', e => {
        const dayEl = (e.target as HTMLElement).closest<HTMLElement>('.full-calendar-day');
        if (dayEl && dayEl.dataset.date) {
            state.selectedDate = dayEl.dataset.date;
            closeModal(ui.fullCalendarModal);
            renderApp();
        }
    });
}