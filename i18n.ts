/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state, Habit, LANGUAGES, PredefinedHabit } from './state';
import { ui } from './ui';
import { renderApp, updateHeaderTitle, initFrequencyFilter, setupManageModal, initLanguageFilter } from './render';

type PluralableTranslation = { one: string; other: string };
type TranslationValue = string | PluralableTranslation;
type Translations = Record<string, TranslationValue>;

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

export function getHabitDisplayInfo(habit: Habit | PredefinedHabit): { name: string, subtitle: string } {
    let source: any = habit;
    // If it's a full Habit object, get the latest schedule for its display info
    if ('scheduleHistory' in habit && habit.scheduleHistory.length > 0) {
        source = habit.scheduleHistory[habit.scheduleHistory.length - 1];
    }

    if (source.nameKey) {
        return {
            name: t(source.nameKey),
            subtitle: source.subtitleKey ? t(source.subtitleKey) : ''
        };
    }
    return {
        name: source.name || '',
        subtitle: source.subtitle || ''
    };
}

export function getLocaleDayName(date: Date): string {
    return date.toLocaleDateString(state.activeLanguageCode, { weekday: 'short', timeZone: 'UTC' }).toUpperCase();
}

function updateUIText() {
    document.title = t('appName');
    ui.fabAddHabit.setAttribute('aria-label', t('fabAddHabit_ariaLabel'));
    ui.manageHabitsBtn.setAttribute('aria-label', t('manageHabits_ariaLabel'));
    ui.aiEvalBtn.setAttribute('aria-label', t('aiEval_ariaLabel'));
    
    ui.exploreModal.querySelector('h2')!.textContent = t('modalExploreTitle');
    ui.createCustomHabitBtn.textContent = t('modalExploreCreateCustom');
    ui.exploreModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');

    ui.manageModalTitle.textContent = t('modalManageTitle');
    ui.habitListTitle.textContent = t('modalManageHabitsSubtitle');
    document.getElementById('label-language')!.textContent = t('modalManageLanguage');
    document.getElementById('label-sync')!.textContent = t('syncLabel');
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
    
    ui.aiModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
    ui.aiOptionsModal.querySelector('h2')!.textContent = t('modalAIOptionsTitle');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('#ai-weekly-checkin-btn .ai-option-title')!.textContent = t('aiOptionWeeklyTitle');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('#ai-weekly-checkin-btn .ai-option-desc')!.textContent = t('aiOptionWeeklyDesc');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('#ai-monthly-review-btn .ai-option-title')!.textContent = t('aiOptionMonthlyTitle');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('#ai-monthly-review-btn .ai-option-desc')!.textContent = t('aiOptionMonthlyDesc');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('#ai-general-analysis-btn .ai-option-title')!.textContent = t('aiOptionGeneralTitle');
    ui.aiOptionsModal.querySelector<HTMLSpanElement>('#ai-general-analysis-btn .ai-option-desc')!.textContent = t('aiOptionGeneralDesc');

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
    
    initFrequencyFilter();
    initLanguageFilter();

    updateUIText();
    
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
    }

    renderApp();
    updateHeaderTitle();
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