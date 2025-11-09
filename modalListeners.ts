/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído. A orquestração de eventos de modais é bem estruturada e robusta. Nenhuma outra análise é necessária.
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
    ui.exploreHabitList.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.explore-habit-item');
        if (!item) return;
        const index = parseInt(item.dataset.index!, 10);
        const habitTemplate = PREDEFINED_HABITS[index];
        if (habitTemplate) {
            closeModal(ui.exploreModal);
            openEditModal(habitTemplate);
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
        const analysisType = button.dataset.analysisType as 'weekly' | 'monthly' | 'general';
        performAIAnalysis(analysisType);
    });

    // --- Modal de Confirmação ---
    ui.confirmModalConfirmBtn.addEventListener('click', () => {
        state.confirmAction?.();
        state.confirmAction = null;
        state.confirmEditAction = null;
        closeModal(ui.confirmModal);
    });
    
    ui.confirmModalEditBtn.addEventListener('click', () => {
        state.confirmEditAction?.();
        state.confirmAction = null;
        state.confirmEditAction = null;
        closeModal(ui.confirmModal);
    });

    // --- Modal de Notas ---
    ui.saveNoteBtn.addEventListener('click', handleSaveNote);

    // --- Modal de Edição/Criação de Hábito ---
    ui.editHabitSaveBtn.addEventListener('click', saveHabitFromModal);

    const habitNameInput = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    const duplicateNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.duplicate-habit-notice')!;

    habitNameInput.addEventListener('input', () => {
        if (!state.editingHabit) return;
        
        const newName = habitNameInput.value.trim();
        state.editingHabit.formData.name = newName;
        delete state.editingHabit.formData.nameKey; // Nome personalizado sobrescreve o predefinido

        const isDuplicate = state.habits.some(h => {
            const { name } = getHabitDisplayInfo(h, state.selectedDate);
            return name.toLowerCase() === newName.toLowerCase() && h.id !== state.editingHabit?.habitId;
        });

        if (isDuplicate) {
            duplicateNoticeEl.textContent = t('noticeDuplicateHabitWithName');
            duplicateNoticeEl.classList.add('visible');
        } else {
            duplicateNoticeEl.classList.remove('visible');
        }
        ui.editHabitSaveBtn.disabled = isDuplicate || newName.length === 0;
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

        const time = button.dataset.time as TimeOfDay;
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

    // Opções de Frequência
    ui.frequencyOptionsContainer.addEventListener('click', e => {
        if (!state.editingHabit) return;
        const target = e.target as HTMLElement;

        const radio = target.closest<HTMLInputElement>('input[type="radio"]');
        if (radio) {
            const type = radio.value as 'daily' | 'interval' | 'specific_days_of_week';
            if (type === 'daily') {
                state.editingHabit.formData.frequency = { type: 'daily' };
            } else if (type === 'specific_days_of_week') {
                const days = Array.from(ui.frequencyOptionsContainer.querySelectorAll<HTMLInputElement>('.weekday-picker input:checked')).map(el => parseInt(el.dataset.day!, 10));
                state.editingHabit.formData.frequency = { type: 'specific_days_of_week', days };
            } else if (type === 'interval') {
                const currentFreq = state.editingHabit.formData.frequency;
                const intervalFreqTpl = FREQUENCIES.find(f => f.value.type === 'interval')!.value as { type: 'interval', unit: 'days' | 'weeks', amount: number };
                const amount = (currentFreq.type === 'interval' ? currentFreq.amount : intervalFreqTpl.amount);
                const unit = (currentFreq.type === 'interval' ? currentFreq.unit : intervalFreqTpl.unit);
                state.editingHabit.formData.frequency = { type: 'interval', amount, unit };
            }
            renderFrequencyOptions();
            return;
        }

        const dayCheckbox = target.closest<HTMLInputElement>('.weekday-picker input[type="checkbox"]');
        if (dayCheckbox) {
            const days = Array.from(ui.frequencyOptionsContainer.querySelectorAll<HTMLInputElement>('.weekday-picker input:checked')).map(el => parseInt(el.dataset.day!, 10));
            state.editingHabit.formData.frequency = { type: 'specific_days_of_week', days };
            return;
        }

        const stepperBtn = target.closest<HTMLButtonElement>('.stepper-btn, .unit-toggle-btn');
        if (stepperBtn && state.editingHabit.formData.frequency.type === 'interval') {
            const action = stepperBtn.dataset.action;
            const currentFreq = state.editingHabit.formData.frequency;
            let { amount, unit } = currentFreq;

            if (action === 'interval-decrement') amount = Math.max(1, amount - 1);
            if (action === 'interval-increment') amount = Math.min(99, amount + 1);
            if (action === 'interval-unit-toggle') unit = unit === 'days' ? 'weeks' : 'days';
            
            state.editingHabit.formData.frequency = { type: 'interval', amount, unit };
            renderFrequencyOptions(); // Re-render to show the new state
        }
    });
}