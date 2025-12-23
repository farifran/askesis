
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file i18n.ts
 * @description Orquestrador de Localização e Internacionalização (i18n).
 * 
 * [MAIN THREAD]: Foco em 60fps. Este módulo gerencia a re-tradução da UI e formatação de dados culturais.
 * 
 * ARQUITETURA:
 * 1. **Responsabilidade Única:** Centralizar a semântica textual do sistema e prover formatação localizada de datas/números.
 * 2. **Estratégia de Performance (Zero-Copy/Zero-Alloc):**
 *    - Caching agressivo de instâncias `Intl.PluralRules` e `Intl.DateTimeFormat` para evitar o custo de inicialização de objetos do SO.
 *    - Interpolação de strings via Regex pré-compilada em passo único (Single-pass O(N)).
 * 3. **Resiliência:** Implementa carregamento assíncrono de dicionários com fallback automático para 'pt' em caso de falha de rede ou arquivo corrompido.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: Consome o idioma ativo e estado dos hábitos.
 * - `render/ui.ts`: Referências diretas ao DOM para atualização massiva de textos.
 * - `utils.ts`: Utiliza formatadores de data para consistência temporal.
 */

import { state, Habit, LANGUAGES, PredefinedHabit, TimeOfDay } from './state';
import { getScheduleForDate } from './services/selectors';
import { ui } from './render/ui';
import { renderApp, setupManageModal, initLanguageFilter, refreshEditModalUI, renderLanguageFilter, updateNotificationUI } from './render';
import { pushToOneSignal, getDateTimeFormat } from './utils';
import { UI_ICONS } from './render/icons';

type PluralableTranslation = { one: string; other: string };
type TranslationValue = string | PluralableTranslation;
type Translations = Record<string, TranslationValue>;

// PERFORMANCE: Memoização de objetos Intl.PluralRules para evitar overhead de alocação no critical path.
const pluralRulesCache: Record<string, Intl.PluralRules> = {};

export function getTimeOfDayName(time: TimeOfDay): string {
    return t(`filter${time}`);
}

// PERFORMANCE: Repositório em memória para dicionários carregados via rede. Evita re-fetch e parsing redundante.
const loadedTranslations: Record<string, Translations> = {};

/**
 * Carrega dinamicamente o arquivo JSON de tradução.
 * // DO NOT REFACTOR: A lógica de fallback para 'pt' é vital para evitar telas em branco se a rede falhar.
 */
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

// PERFORMANCE: Regex pré-compilada para interpolação global. 
// Evita parsing de string em cada chamada da função t().
const INTERPOLATION_REGEX = /{([^{}]+)}/g;

/**
 * Tradutor universal com suporte a interpolação e pluralização.
 * // PERFORMANCE: Implementação O(N) onde N é o tamanho da string, vs O(K*N) em abordagens de loop múltiplo.
 * // DO NOT REFACTOR: A ordem de precedência (lang -> default pt -> key) garante que o app nunca trave por falta de string.
 */
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
            // PERFORMANCE: Reutiliza instância cacheada de PluralRules.
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
        // PERFORMANCE: Single-pass interpolation usando Regex e função de substituição.
        // Evita múltiplos loops e alocações de memória causados por split/join/replace encadeados.
        return translationString.replace(INTERPOLATION_REGEX, (_match, key) => {
            const value = options[key];
            return value !== undefined ? String(value) : _match;
        });
    }

    return translationString;
}


/**
 * CORREÇÃO DE DADOS HISTÓRICOS [2024-09-20]: A função agora aceita um `dateISO` opcional.
 * Se uma data for fornecida, ela busca o agendamento historicamente correto para essa data,
 * garantindo que o nome e o subtítulo exibidos sejam precisos para o contexto temporal.
 * 
 * // CRITICAL LOGIC: Resolução histórico-temporal. Hábitos podem mudar de nome no tempo.
 * // Mudar esta lógica quebraria a integridade visual do Calendário e da IA.
 */
export function getHabitDisplayInfo(habit: Habit | PredefinedHabit, dateISO?: string): { name: string, subtitle: string } {
    let source: any = habit;
    
    if ('scheduleHistory' in habit && habit.scheduleHistory.length > 0) {
        if (dateISO) {
            // PERFORMANCE: Delegado ao seletor otimizado com cache.
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
    // PERFORMANCE: Uso de cache para Intl.DateTimeFormat (via helper utils.ts) para evitar recriação em loops de calendário.
    return getDateTimeFormat(state.activeLanguageCode, { weekday: 'short', timeZone: 'UTC' }).format(date).toUpperCase();
}

/**
 * Atualiza todos os textos estáticos do DOM de acordo com o idioma ativo.
 * // [MAIN THREAD]: Esta função causa Layout Thrashing massivo (Write-only).
 * // DO NOT REFACTOR: Deve ser chamada apenas durante a troca de idioma ou inicialização.
 */
function updateUIText() {
    const appNameHtml = t('appName');
    
    // PERFORMANCE: Strip HTML para o título do documento usando elemento temporário off-DOM.
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
    
    ui.labelLanguage.textContent = t('modalManageLanguage');

    ui.languagePrevBtn.setAttribute('aria-label', t('languagePrev_ariaLabel'));
    ui.languageNextBtn.setAttribute('aria-label', t('languageNext_ariaLabel'));
    
    ui.labelSync.textContent = t('syncLabel');
    ui.labelNotifications.textContent = t('modalManageNotifications');
    
    ui.labelReset.textContent = t('modalManageReset');

    ui.resetAppBtn.textContent = t('modalManageResetButton');
    ui.manageModal.querySelector('.modal-close-btn')!.textContent = t('closeButton');
    
    ui.labelPrivacy.textContent = t('privacyLabel');
    ui.exportDataBtn.textContent = t('exportButton');
    ui.importDataBtn.textContent = t('importButton');
    
    ui.syncInactiveDesc.textContent = t('syncInactiveDesc');

    ui.enableSyncBtn.textContent = t('syncEnable');
    ui.enterKeyViewBtn.textContent = t('syncEnterKey');
    
    ui.labelEnterKey.textContent = t('syncLabelEnterKey');

    ui.cancelEnterKeyBtn.textContent = t('cancelButton');
    ui.submitKeyBtn.textContent = t('syncSubmitKey');
    
    ui.syncWarningText.innerHTML = t('syncWarning');

    // CONTEXT AWARENESS: Verifica o contexto do botão (visualização vs salvamento)
    const keyContext = ui.syncDisplayKeyView.dataset.context;
    ui.keySavedBtn.textContent = (keyContext === 'view') ? t('closeButton') : t('syncKeySaved');
    
    ui.syncActiveDesc.textContent = t('syncActiveDesc');

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

    ui.iconPickerTitle.textContent = t('modalIconPickerTitle');
    ui.iconPickerModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');

    ui.colorPickerTitle.textContent = t('modalColorPickerTitle');
    ui.colorPickerModal.querySelector('.modal-close-btn')!.textContent = t('cancelButton');

    const editModalActions = ui.editHabitModal.querySelector('.modal-actions');
    if (editModalActions) {
        editModalActions.querySelector('.modal-close-btn')!.textContent = t('cancelButton');
        editModalActions.querySelector('#edit-habit-save-btn')!.textContent = t('modalEditSaveButton');
    }

    // Quick Actions Menu
    ui.quickActionDone.innerHTML = `${UI_ICONS.check} ${t('quickActionMarkAllDone')}`;
    ui.quickActionSnooze.innerHTML = `${UI_ICONS.snoozed} ${t('quickActionMarkAllSnoozed')}`;
    ui.quickActionAlmanac.innerHTML = `${UI_ICONS.calendar} ${t('quickActionOpenAlmanac')}`;


    if (state.editingHabit) {
        refreshEditModalUI();
    }
}

/**
 * Define o idioma global da aplicação.
 * // CRITICAL LOGIC: Orquestra sincronização com OneSignal e invalidação de caches de UI.
 */
export async function setLanguage(langCode: 'pt' | 'en' | 'es') {
    await loadLanguage(langCode);
    state.activeLanguageCode = langCode;
    document.documentElement.lang = langCode;
    localStorage.setItem('habitTrackerLanguage', langCode);
    
    // BUGFIX DE ROBUSTEZ: Enfileira a atualização no OneSignal para evitar race conditions.
    pushToOneSignal((OneSignal: any) => {
        OneSignal.User.setLanguage(langCode);
    });
    
    initLanguageFilter();
    // BUGFIX: Posicionamento visual imediato do idioma selecionado.
    renderLanguageFilter();

    // PERFORMANCE: Invalidação de Dirty Checking. Força re-renderização completa no próximo frame.
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.chartData = true;

    updateUIText();
    // Re-traduz o status de sincronização a partir do novo dicionário.
    ui.syncStatus.textContent = t(state.syncState);
    
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
        updateNotificationUI();
    }

    renderApp();
}

/**
 * Inicializa o sistema de i18n no boot da aplicação.
 * // [RACE-TO-IDLE]: Chamado antes da primeira renderização para garantir consistência visual.
 */
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
