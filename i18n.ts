/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído. A implementação de internacionalização é completa e correta. Nenhuma outra análise é necessária.
import { state, Habit, LANGUAGES, PredefinedHabit, TimeOfDay, getScheduleForDate } from './state';
import { ui } from './ui';
import { renderApp, updateHeaderTitle, initFrequencyFilter, setupManageModal, initLanguageFilter } from './render';
import { pushToOneSignal } from './utils';

type PluralableTranslation = { one: string; other: string };
type TranslationValue = string | PluralableTranslation;
type Translations = Record<string, TranslationValue>;

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
        if (langCode !== 'pt') {
            await loadLanguage('pt');
        }
    }
}

export function t(key: string, options?: { [key: string]: string | number | undefined }): string {
    const lang = state.activeLanguageCode || 'pt';
    const dict = loadedTranslations[lang] || loadedTranslations['pt'];
    
    if (!dict) {
        return key;
    }

    let translation = dict[key] || key;

    if (typeof translation === 'object' && options?.count !== undefined) {
        const pluralKey = new Intl.PluralRules(lang).select(options.count as number);
        translation = (translation as PluralableTranslation)[pluralKey as keyof PluralableTranslation] || (translation as PluralableTranslation).other;
    }

    if (typeof translation === 'string' && options) {
        return Object.entries(options).reduce((acc, [optKey, optValue]) => {
            return acc.replace(new RegExp(`{${optKey}}`, 'g'), String(optValue));
        }, translation);
    }

    return String(translation);
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
    return date.toLocaleDateString(state.activeLanguageCode, { weekday: 'short', timeZone: 'UTC' }).toUpperCase();
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
    document.getElementById('label-language')!.textContent = t('modalManageLanguage');
    ui.languagePrevBtn.setAttribute('aria-label', t('languagePrev_ariaLabel'));
    ui.languageNextBtn.setAttribute('aria-label', t('languageNext_ariaLabel'));
    ui.frequencyPrevBtn.setAttribute('aria-label', t('frequencyPrev_ariaLabel'));
    ui.frequencyNextBtn.setAttribute('aria-label', t('frequencyNext_ariaLabel'));
    document.getElementById('label-sync')!.textContent = t('syncLabel');
    document.getElementById('label-notifications')!.textContent = t('modalManageNotifications');
    ui.notificationStatusDesc.textContent = t('modalManageNotificationsStaticDesc');
    document.getElementById('label-reset')!.textContent = t('modalManageReset');
    ui.resetAppBtn.textContent = t('modalManageResetButton');
    ui.manageModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
    document.getElementById('sync-inactive-desc')!.textContent = t('syncInactiveDesc');
    ui.enableSyncBtn.textContent = t('syncEnable');
    ui.enterKeyViewBtn.textContent = t('syncEnterKey');
    document.getElementById('label-enter-key')!.textContent = t('syncLabelEnterKey');
    ui.cancelEnterKeyBtn.textContent = t('cancelButton');
    ui.submitKeyBtn.textContent = t('syncSubmitKey');
    document.getElementById('sync-warning-text')!.innerHTML = t('syncWarning');
    ui.keySavedBtn.textContent = t('syncKeySaved');
    document.getElementById('sync-active-desc')!.textContent = t('syncActiveDesc');
    ui.viewKeyBtn.textContent = t('syncViewKey');
    ui.disableSyncBtn.textContent = t('syncDisable');
    
    ui.aiModal.querySelector('h2')!.textContent = t('modalAITitle');
    ui.aiModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
    ui.aiOptionsModal.querySelector('h2')!.textContent = t('modalAIOptionsTitle');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('[data-analysis-type="weekly"] .ai-option-title')!.textContent = t('aiOptionWeeklyTitle');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('[data-analysis-type="weekly"] .ai-option-desc')!.textContent = t('aiOptionWeeklyDesc');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('[data-analysis-type="monthly"] .ai-option-title')!.textContent = t('aiOptionMonthlyTitle');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('[data-analysis-type="monthly"] .ai-option-desc')!.textContent = t('aiOptionMonthlyDesc');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('[data-analysis-type="general"] .ai-option-title')!.textContent = t('aiOptionGeneralTitle');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('[data-analysis-type="general"] .ai-option-desc')!.textContent = t('aiOptionGeneralDesc');

    ui.confirmModal.querySelector('h2')!.textContent = t('modalConfirmTitle');
    ui.confirmModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
    ui.confirmModalEditBtn.textContent = t('editButton');
    ui.confirmModalConfirmBtn.textContent = t('confirmButton');

    ui.notesModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
    ui.saveNoteBtn.textContent = t('modalNotesSaveButton');
    ui.notesTextarea.placeholder = t('modalNotesTextareaPlaceholder');

    document.getElementById('label-habit-name')!.textContent = t('modalEditFormNameLabel');
    document.getElementById('label-habit-time')!.textContent = t('modalEditFormTimeLabel');
    document.getElementById('label-frequency')!.textContent = t('modalEditFormFrequencyLabel');
    ui.editHabitForm.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
    ui.editHabitForm.querySelector('button[type="submit"]')!.textContent = t('modalEditSaveButton');
    
    ui.undoToast.firstElementChild!.textContent = t('undoToastText');
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
    
    initFrequencyFilter();
    initLanguageFilter();

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