/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state, Habit, LANGUAGES, PredefinedHabit } from './state';
import { ui } from './ui';
import { renderApp, updateHeaderTitle, initFilters, initFrequencyFilter, initHabitTimeFilter, setupManageModal, initLanguageFilter } from './render';

type PluralableTranslation = { one: string; other: string };
type TranslationValue = string | PluralableTranslation;
type Translations = Record<string, TranslationValue>;

// Cache para armazenar os idiomas já carregados.
const loadedTranslations: Record<string, Translations> = {};

async function loadLanguage(langCode: 'pt' | 'en' | 'es'): Promise<void> {
    if (loadedTranslations[langCode]) {
        return; // Já está carregado
    }
    try {
        // Usamos um caminho relativo que funcionará após o build.
        const response = await fetch(`./locales/${langCode}.json`);
        if (!response.ok) {
            throw new Error(`Failed to load language file: ${response.statusText}`);
        }
        const translations = await response.json();
        loadedTranslations[langCode] = translations;
    } catch (error) {
        console.error(`Could not load translations for ${langCode}:`, error);
        // Carrega o português como fallback em caso de erro.
        if (langCode !== 'pt') {
            await loadLanguage('pt');
        }
    }
}

export function t(key: string, options?: { [key: string]: string | number }): string {
    const lang = state.activeLanguageCode || 'pt';
    const dict = loadedTranslations[lang] || loadedTranslations['pt']; // Fallback para PT se o idioma atual não estiver carregado.
    
    if (!dict) {
        return key; // Retorna a chave se nenhum idioma estiver carregado.
    }

    const translation = dict[key] || key;

    if (typeof translation === 'object' && options?.count !== undefined) {
        const pluralKey = new Intl.PluralRules(lang).select(options.count as number);
        const value = (translation as PluralableTranslation)[pluralKey as keyof PluralableTranslation] || (translation as PluralableTranslation).other;
        return value;
    }

    if (typeof translation === 'string' && options) {
        return Object.entries(options).reduce((acc, [optKey, optValue]) => {
            return acc.replace(new RegExp(`{${optKey}}`, 'g'), String(optValue));
        }, translation);
    }

    return String(translation);
}

export function getHabitDisplayInfo(habit: Habit | PredefinedHabit): { name: string, subtitle: string } {
    if ('nameKey' in habit && habit.nameKey) {
        return {
            name: t(habit.nameKey),
            subtitle: habit.subtitleKey ? t(habit.subtitleKey) : ''
        };
    }
    // FIX: Provide fallbacks for optional name/subtitle properties.
    return {
        name: (habit as Habit).name || '',
        subtitle: (habit as Habit).subtitle || ''
    };
}

export function getLocaleDayName(date: Date): string {
    return date.toLocaleDateString(state.activeLanguageCode, { weekday: 'short' }).toUpperCase();
}

function updateUIText() {
    document.title = t('appName');
    ui.fabAddHabit.setAttribute('aria-label', t('fabAddHabit_ariaLabel'));
    ui.manageHabitsBtn.setAttribute('aria-label', t('manageHabits_ariaLabel'));
    ui.aiEvalBtn.setAttribute('aria-label', t('aiEval_ariaLabel'));
    ui.timeFilterPrev.setAttribute('aria-label', t('timeFilterPrev_ariaLabel'));
    ui.timeFilterNext.setAttribute('aria-label', t('timeFilterNext_ariaLabel'));
    
    // Modals
    ui.exploreModal.querySelector('h2')!.textContent = t('modalExploreTitle');
    ui.createCustomHabitBtn.textContent = t('modalExploreCreateCustom');
    ui.exploreModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');

    ui.manageModal.querySelector('h2')!.textContent = t('modalManageTitle');
    ui.manageModal.querySelector('h3')!.textContent = t('modalManageGeneralSettings');
    document.getElementById('label-language')!.textContent = t('modalManageLanguage');
    document.getElementById('label-reset')!.textContent = t('modalManageReset');
    ui.resetAppBtn.textContent = t('modalManageResetButton');
    ui.manageModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
    ui.aiModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
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
    
    ui.undoToast.firstChild!.textContent = `${t('undoToastText')} `;
    ui.undoBtn.textContent = t('undoButton');
}

export async function setLanguage(langCode: 'pt' | 'en' | 'es') {
    await loadLanguage(langCode);
    state.activeLanguageCode = langCode;
    document.documentElement.lang = langCode;
    localStorage.setItem('habitTrackerLanguage', langCode);
    
    // Re-initialize dynamic text components
    initFilters();
    initFrequencyFilter();
    initHabitTimeFilter();
    initLanguageFilter();

    // Update all static text
    updateUIText();
    
    // Re-render the manage modal content if it's open
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
    }

    // Re-render the main app view to apply all other dynamic text changes
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
