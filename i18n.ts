
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { state, Habit, LANGUAGES, PredefinedHabit, TimeOfDay, getScheduleForDate, invalidateChartCache } from './state';
import { ui } from './ui';
import { renderApp, setupManageModal, initLanguageFilter } from './render';
import { pushToOneSignal, getDateTimeFormat } from './utils';

type PluralableTranslation = { one: string; other: string };
type TranslationValue = string | PluralableTranslation;
type Translations = Record<string, TranslationValue>;

// Cache para instâncias de PluralRules para evitar recriação custosa a cada tradução
const pluralRulesCache: Record<string, Intl.PluralRules> = {};

export function getTimeOfDayName(time: TimeOfDay): string {
    return t(`filter${time}`);
}

const loadedTranslations: Record<string, Translations> = {};

async function loadLanguage(langCode: 'pt' | 'en' | 'es'): Promise<void> {
    if (loadedTranslations[langCode]) {
        return;
    }
    try {
        const response = await fetch(`./locales/${langCode}.json`);
        if (!response.ok) {
            throw new Error(`Failed to load language file: ${response.statusText}`);
        }
        const translations = await response.json();
        loadedTranslations[langCode] = translations;
    } catch (error) {
        console.error(`Could not load translations for ${langCode}:`, error);
        // MELHORIA DE ROBUSTEZ: Se o idioma solicitado falhar, tenta carregar o idioma
        // de fallback (pt), mas apenas se ainda não tiver sido carregado. Adiciona
        // tratamento de erro para o próprio fallback, prevenindo uma exceção não capturada.
        if (langCode !== 'pt' && !loadedTranslations['pt']) {
            try {
                await loadLanguage('pt');
            } catch (fallbackError) {
                console.error(`CRITICAL: Could not load fallback language 'pt'. UI text will not be available.`, fallbackError);
            }
        }
    }
}

export function t(key: string, options?: { [key: string]: string | number | undefined }): string {
    const lang = state.activeLanguageCode || 'pt';
    const dict = loadedTranslations[lang] || loadedTranslations['pt'];

    if (!dict) {
        return key;
    }

    const translationValue = dict[key];

    if (translationValue === undefined) {
        return key;
    }

    let translationString: string;

    if (typeof translationValue === 'object') {
        if (options?.count !== undefined) {
            // PERFORMANCE [2025-01-16]: Uso de cache para Intl.PluralRules.
            let pluralRules = pluralRulesCache[lang];
            if (!pluralRules) {
                pluralRules = new Intl.PluralRules(lang);
                pluralRulesCache[lang] = pluralRules;
            }
            
            const pluralKey = pluralRules.select(options.count as number);
            translationString = (translationValue as PluralableTranslation)[pluralKey as keyof PluralableTranslation] || (translationValue as PluralableTranslation).other;
        } else {
            // CORREÇÃO DE BUG: Retorna a chave se uma tradução pluralizável for usada sem 'count',
            // em vez de retornar "[object Object]".
            return key;
        }
    } else {
        translationString = translationValue;
    }

    if (options) {
        return Object.entries(options).reduce((acc, [optKey, optValue]) => {
            // MELHORIA DE ROBUSTEZ: Ignora a substituição se o valor for indefinido para evitar
            // a inserção da string "undefined" na UI.
            if (optValue !== undefined) {
                return acc.split(`{${optKey}}`).join(String(optValue));
            }
            return acc;
        }, translationString);
    }

    return translationString;
}


/**
 * CORREÇÃO DE DADOS HISTÓRICOS [2024-09-20]: A função agora aceita um `dateISO` opcional.
 * Se uma data for fornecida, ela busca o agendamento historicamente correto para essa data,
 * garantindo que o nome e o subtítulo exibidos sejam precisos para o contexto temporal,
 * o que é crucial para a renderização da UI e a geração de prompts para a IA.
 * @param habit O objeto do hábito ou modelo predefinido.
 * @param dateISO A data opcional no formato string ISO para buscar informações históricas.
 * @returns O nome e o subtítulo para exibição.
 */
export function getHabitDisplayInfo(habit: Habit | PredefinedHabit, dateISO?: string): { name: string, subtitle: string } {
    let source: any = habit;
    
    if ('scheduleHistory' in habit && habit.scheduleHistory.length > 0) {
        if (dateISO) {
            // Busca o agendamento ativo para a data específica.
            source = getScheduleForDate(habit, dateISO) || habit.scheduleHistory[habit.scheduleHistory.length - 1];
        } else {
            // Se nenhuma data for fornecida, assume o comportamento padrão de usar o agendamento mais recente.
            source = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        }
    }

    if (source.nameKey) {
        return {
            name: t(source.nameKey),
            subtitle: source.subtitleKey ? t(source.subtitleKey) : ''
        };
    }
    return {
        name: source.name || '',
        subtitle: source.subtitleKey ? t(source.subtitleKey) : (source.subtitle || '')
    };
}

export function getLocaleDayName(date: Date): string {
    // PERFORMANCE [2025-01-16]: Uso de cache para Intl.DateTimeFormat para evitar recriação em loops de calendário.
    return getDateTimeFormat(state.activeLanguageCode, { weekday: 'short', timeZone: 'UTC' }).format(date).toUpperCase();
}

function updateUIText() {
    const appNameHtml = t('appName');
    
    // Strip HTML for the document title
    const tempEl = document.createElement('div');
    tempEl.innerHTML = appNameHtml;
    document.title = tempEl.textContent || 'Askesis';

    ui.fabAddHabit.setAttribute('aria-label', t('fabAddHabit_ariaLabel'));
    ui.manageHabitsBtn.setAttribute('aria-label', t('manageHabits_ariaLabel'));
    ui.aiEvalBtn.setAttribute('aria-label', t('aiEval_ariaLabel'));
    
    ui.exploreModal.querySelector('h2')!.textContent = t('modalExploreTitle');
    ui.createCustomHabitBtn.textContent = t('modalExploreCreateCustom');
    ui.exploreModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');

    ui.manageModalTitle.textContent = t('modalManageTitle');
    ui.habitListTitle.textContent = t('modalManageHabitsSubtitle');
    
    // Elementos que não estão no objeto 'ui' precisam ser buscados
    const labelLanguage = document.getElementById('label-language');
    if (labelLanguage) labelLanguage.textContent = t('modalManageLanguage');

    ui.languagePrevBtn.setAttribute('aria-label', t('languagePrev_ariaLabel'));
    ui.languageNextBtn.setAttribute('aria-label', t('languageNext_ariaLabel'));
    
    const labelSync = document.getElementById('label-sync');
    if (labelSync) labelSync.textContent = t('syncLabel');

    const labelNotifications = document.getElementById('label-notifications');
    if (labelNotifications) labelNotifications.textContent = t('modalManageNotifications');

    ui.notificationStatusDesc.textContent = t('modalManageNotificationsStaticDesc');
    
    const labelReset = document.getElementById('label-reset');
    if (labelReset) labelReset.textContent = t('modalManageReset');

    ui.resetAppBtn.textContent = t('modalManageResetButton');
    ui.manageModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
    const syncInactiveDesc = document.getElementById('sync-inactive-desc');
    if (syncInactiveDesc) syncInactiveDesc.textContent = t('syncInactiveDesc');

    ui.enableSyncBtn.textContent = t('syncEnable');
    ui.enterKeyViewBtn.textContent = t('syncEnterKey');
    
    const labelEnterKey = document.getElementById('label-enter-key');
    if (labelEnterKey) labelEnterKey.textContent = t('syncLabelEnterKey');

    ui.cancelEnterKeyBtn.textContent = t('cancelButton');
    ui.submitKeyBtn.textContent = t('syncSubmitKey');
    
    const syncWarningText = document.getElementById('sync-warning-text');
    if (syncWarningText) syncWarningText.innerHTML = t('syncWarning');

    ui.keySavedBtn.textContent = t('syncKeySaved');
    
    const syncActiveDesc = document.getElementById('sync-active-desc');
    if (syncActiveDesc) syncActiveDesc.textContent = t('syncActiveDesc');

    ui.viewKeyBtn.textContent = t('syncViewKey');
    ui.disableSyncBtn.textContent = t('syncDisable');
    
    ui.aiModal.querySelector('h2')!.textContent = t('modalAITitle');
    ui.aiModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
    ui.aiOptionsModal.querySelector('h2')!.textContent = t('modalAIOptionsTitle');
    
    const monthlyBtn = ui.aiOptionsModal.querySelector<HTMLElement>('[data-analysis-type="monthly"]');
    if (monthlyBtn) {
        monthlyBtn.querySelector('.ai-option-title')!.textContent = t('aiOptionMonthlyTitle');
        monthlyBtn.querySelector('.ai-option-desc')!.textContent = t('aiOptionMonthlyDesc');
    }

    const quarterlyBtn = ui.aiOptionsModal.querySelector<HTMLElement>('[data-analysis-type="quarterly"]');
    if (quarterlyBtn) {
        quarterlyBtn.querySelector('.ai-option-title')!.textContent = t('aiOptionQuarterlyTitle');
        quarterlyBtn.querySelector('.ai-option-desc')!.textContent = t('aiOptionQuarterlyDesc');
    }

    const historicalBtn = ui.aiOptionsModal.querySelector<HTMLElement>('[data-analysis-type="historical"]');
    if (historicalBtn) {
        historicalBtn.querySelector('.ai-option-title')!.textContent = t('aiOptionHistoricalTitle');
        historicalBtn.querySelector('.ai-option-desc')!.textContent = t('aiOptionHistoricalDesc');
    }

    ui.confirmModal.querySelector('h2')!.textContent = t('modalConfirmTitle');
    ui.confirmModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
    ui.confirmModalEditBtn.textContent = t('editButton');
    ui.confirmModalConfirmBtn.textContent = t('confirmButton');

    ui.notesModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
    ui.saveNoteBtn.textContent = t('modalNotesSaveButton');
    ui.notesTextarea.placeholder = t('modalNotesTextareaPlaceholder');

    const iconPickerTitle = document.getElementById('icon-picker-modal-title');
    if (iconPickerTitle) iconPickerTitle.textContent = t('modalIconPickerTitle');
    
    ui.iconPickerModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');

    const colorPickerTitle = document.getElementById('color-picker-modal-title');
    if (colorPickerTitle) colorPickerTitle.textContent = t('modalColorPickerTitle');
    
    ui.colorPickerModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');

    const editModalActions = ui.editHabitModal.querySelector('.modal-actions');
    if (editModalActions) {
        editModalActions.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
        editModalActions.querySelector('#edit-habit-save-btn')!.textContent = t('modalEditSaveButton');
    }
    
    if (ui.undoToast.firstElementChild) {
        ui.undoToast.firstElementChild.textContent = t('undoToastText');
    }
    ui.undoBtn.textContent = t('undoButton');
}

export async function setLanguage(langCode: 'pt' | 'en' | 'es') {
    await loadLanguage(langCode);
    state.activeLanguageCode = langCode;
    document.documentElement.lang = langCode;
    localStorage.setItem('habitTrackerLanguage', langCode);
    
    // BUGFIX DE ROBUSTEZ [2024-10-19]: Utiliza o helper pushToOneSignal para garantir que
    // a configuração de idioma seja enfileirada e executada de forma confiável, mesmo que o SDK
    // do OneSignal ainda não tenha sido totalmente inicializado. Isso previne uma condição de corrida.
    pushToOneSignal((OneSignal: any) => {
        OneSignal.User.setLanguage(langCode);
    });
    
    initLanguageFilter();

    // CRITICAL FIX [2025-02-05]: Invalidação de cache de UI (Dirty Checking).
    // Ao trocar o idioma, a lógica de renderApp() normalmente pularia a renderização
    // porque os dados em si não mudaram. Aqui forçamos as flags de 'dirty' para true,
    // obrigando o redesenho imediato do calendário, lista de hábitos e gráficos com o novo idioma.
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    invalidateChartCache();

    updateUIText();
    // Garante que o status de sincronização dinâmico seja re-traduzido a partir do estado.
    ui.syncStatus.textContent = t(state.syncState);
    
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
    }

    // REFACTOR [2024-09-02]: Remove a chamada redundante para `updateHeaderTitle`
    // uma vez que `renderApp` já a executa internamente.
    renderApp();
}

export async function initI18n() {
    const savedLang = localStorage.getItem('habitTrackerLanguage');
    const browserLang = navigator.language.split('-')[0];
    let initialLang: 'pt' | 'en' | 'es' = 'pt';

    if (savedLang && ['pt', 'en', 'es'].includes(savedLang)) {
        initialLang = savedLang as 'pt' | 'en' | 'es';
    } else if (['pt', 'en', 'es'].includes(browserLang)) {
        initialLang = browserLang as 'pt' | 'en' | 'es';
    }

    await setLanguage(initialLang);
}
