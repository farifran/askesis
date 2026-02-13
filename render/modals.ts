
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file render/modals.ts
 * @description Motor de Renderização de Modais e Diálogos (UI Overlay Layer).
 */

import { state, Habit, HabitTemplate, Frequency, PredefinedHabit, TimeOfDay, STREAK_CONSOLIDATED, TIMES_OF_DAY, FREQUENCIES, LANGUAGES, getHabitDailyInfoForDate, MAX_HABIT_NAME_LENGTH } from '../state';
import { PREDEFINED_HABITS } from '../data/predefinedHabits';
import { getScheduleForDate, calculateHabitStreak, getHabitDisplayInfo } from '../services/selectors';
import { ui } from './ui';
import { t, compareStrings, formatDate, formatInteger, getTimeOfDayName } from '../i18n';
import { HABIT_ICONS, UI_ICONS, getTimeOfDayIcon, sanitizeHabitIcon } from './icons';
import { setTextContent, updateReelRotaryARIA } from './dom';
import { MODAL_COLORS, EXPLORE_STAGGER_DELAY_MS } from './constants';
import { getContrastColor, parseUTCIsoDate, getTodayUTCIso, getSafeDate, triggerHaptic } from '../utils';

interface ModalContext { element: HTMLElement; previousFocus: HTMLElement | null; onClose?: () => void; firstFocusable?: HTMLElement; lastFocusable?: HTMLElement; }
const modalStack: ModalContext[] = [];
const OPTS_NOTES = { day: 'numeric', month: 'long', timeZone: 'UTC' } as const;
interface ConfirmationModalOptions {
    onEdit?: () => void;
    title?: string;
    confirmButtonStyle?: 'danger' | 'primary';
    confirmText?: string;
    editText?: string;
    onCancel?: () => void;
    allowHtml?: boolean;
}
type ManageHabitStatus = 'active' | 'graduated' | 'ended';
type ManageHabitItem = { h: Habit; st: ManageHabitStatus; name: string; subtitle: string };

function buildManageActionButton(className: string, ariaLabel: string, iconHtml: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = className;
    btn.setAttribute('aria-label', ariaLabel);
    btn.innerHTML = iconHtml;
    return btn;
}

function buildManageHabitListItem(item: ManageHabitItem, today: string): HTMLLIElement {
    const { h, st, name, subtitle } = item;
    const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
    const safeIcon = sanitizeHabitIcon(lastSchedule.icon, '❓');

    const li = document.createElement('li');
    li.className = `habit-list-item ${st}`;
    li.dataset.habitId = h.id;

    const mainInfo = document.createElement('span');
    mainInfo.className = 'habit-main-info';

    const iconSlot = document.createElement('span');
    iconSlot.className = 'habit-icon-slot';
    iconSlot.style.color = lastSchedule.color;
    iconSlot.innerHTML = safeIcon;

    const detailsWrap = document.createElement('div');
    detailsWrap.style.display = 'flex';
    detailsWrap.style.flexDirection = 'column';
    detailsWrap.style.flexGrow = '1';

    const nameEl = document.createElement('span');
    nameEl.className = 'habit-name';
    nameEl.textContent = name;
    detailsWrap.appendChild(nameEl);

    if (subtitle) {
        const subtitleEl = document.createElement('span');
        subtitleEl.className = 'habit-subtitle';
        subtitleEl.style.fontSize = '11px';
        subtitleEl.style.color = 'var(--text-tertiary)';
        subtitleEl.textContent = subtitle;
        detailsWrap.appendChild(subtitleEl);
    }

    if (st !== 'active') {
        const statusEl = document.createElement('span');
        statusEl.className = 'habit-name-status';
        statusEl.textContent = t(st === 'graduated' ? 'modalStatusGraduated' : 'modalStatusEnded');
        mainInfo.appendChild(statusEl);
    }

    const actions = document.createElement('div');
    actions.className = 'habit-list-actions';

    if (st === 'active') {
        const isConsolidated = calculateHabitStreak(h, today) >= STREAK_CONSOLIDATED;
        if (isConsolidated) {
            actions.appendChild(buildManageActionButton(
                'graduate-habit-btn',
                t('aria_graduate', { name }),
                UI_ICONS.graduateAction
            ));
        } else {
            actions.appendChild(buildManageActionButton(
                'end-habit-btn',
                t('aria_end', { name }),
                UI_ICONS.endAction
            ));
        }
    } else {
        actions.appendChild(buildManageActionButton(
            'permanent-delete-habit-btn',
            t('aria_delete_permanent', { name }),
            UI_ICONS.deletePermanentAction
        ));
    }

    mainInfo.append(iconSlot, detailsWrap);
    li.append(mainInfo, actions);
    return li;
}

function computeManageHabitItems(activeHabits: Habit[]): ManageHabitItem[] {
    const order: Record<ManageHabitStatus, number> = { active: 0, graduated: 1, ended: 2 };
    return activeHabits
        .map(h => {
            const { name, subtitle } = getHabitDisplayInfo(h);
            const st: ManageHabitStatus = h.graduatedOn
                ? 'graduated'
                : (h.scheduleHistory[h.scheduleHistory.length - 1].endDate ? 'ended' : 'active');
            return { h, st, name, subtitle };
        })
        .sort((a, b) => (order[a.st] - order[b.st]) || compareStrings(a.name, b.name));
}

function buildIconPickerItem(svg: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-picker-item';
    btn.dataset.iconSvg = svg;
    btn.innerHTML = svg;
    return btn;
}

function buildColorSwatch(color: string, selected: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `color-swatch${selected ? ' selected' : ''}`;
    btn.style.backgroundColor = color;
    btn.dataset.color = color;
    return btn;
}

function buildFrequencyTypeLabel(type: Frequency['type'], checked: boolean, label: string): HTMLLabelElement {
    const wrap = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'frequency-type';
    input.value = type;
    input.checked = checked;
    wrap.append(input, label);
    return wrap;
}

function buildExploreHabitItem(h: PredefinedHabit, index: number): HTMLElement {
    const item = document.createElement('div');
    item.className = 'explore-habit-item';
    item.dataset.index = String(index);
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.style.setProperty('--delay', `${index * EXPLORE_STAGGER_DELAY_MS}ms`);

    const icon = document.createElement('div');
    icon.className = 'explore-habit-icon';
    icon.style.backgroundColor = `${h.color}30`;
    icon.style.color = h.color;
    icon.innerHTML = sanitizeHabitIcon(h.icon, '❓');

    const details = document.createElement('div');
    details.className = 'explore-habit-details';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = t(h.nameKey);

    const subtitle = document.createElement('div');
    subtitle.className = 'subtitle';
    subtitle.textContent = t(h.subtitleKey);

    details.append(name, subtitle);
    item.append(icon, details);
    return item;
}

function buildTimeSegmentedButton(time: TimeOfDay, isSelected: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `segmented-control-option${isSelected ? ' selected' : ''}`;
    btn.dataset.time = time;
    const icon = document.createElement('span');
    icon.className = 'segmented-control-option-icon';
    icon.innerHTML = getTimeOfDayIcon(time);
    const label = document.createElement('span');
    label.className = 'segmented-control-option-label';
    label.textContent = getTimeOfDayName(time);
    btn.append(icon, label);
    return btn;
}

function buildTimeSegmentedControl(selectedTimes: readonly TimeOfDay[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'segmented-control';
    wrap.replaceChildren(...TIMES_OF_DAY.map(time => buildTimeSegmentedButton(time, selectedTimes.includes(time))));
    return wrap;
}

function _getLeastUsedColor(): string {
    const counts = new Map<string, number>(MODAL_COLORS.map(c => [c, 0]));
    state.habits.forEach(h => {
        const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
        if (!h.graduatedOn && lastSchedule && counts.has(lastSchedule.color)) {
            counts.set(lastSchedule.color, counts.get(lastSchedule.color)! + 1);
        }
    });
    let min = Math.min(...counts.values());
    const candidates = MODAL_COLORS.filter(c => counts.get(c) === min);
    return candidates[state.habits.length % candidates.length];
}

export function initModalEngine() {
    document.addEventListener('keydown', e => {
        const ctx = modalStack[modalStack.length - 1]; if (!ctx) return;
        if (e.key === 'Escape') {
            triggerHaptic('light');
            closeModal(ctx.element);
        }
        else if (e.key === 'Tab') {
            const { firstFocusable: f, lastFocusable: l } = ctx;
            if (f && l) {
                if (e.shiftKey && document.activeElement === f) { l.focus(); e.preventDefault(); }
                else if (!e.shiftKey && document.activeElement === l) { f.focus(); e.preventDefault(); }
            }
        }
    });
    document.addEventListener('click', e => {
        const ctx = modalStack[modalStack.length - 1]; if (!ctx) return;
        if (e.target === ctx.element) {
            triggerHaptic('light');
            closeModal(ctx.element);
        }
    });
}

export function openModal(modal: HTMLElement, focusEl?: HTMLElement, onClose?: () => void) {
    const ctx: ModalContext = { element: modal, previousFocus: document.activeElement as HTMLElement, onClose };
    
    const header = modal.querySelector('.modal-header');
    if (header) {
        const spacer = header.querySelector('.modal-header-spacer');
        if (spacer && !spacer.previousElementSibling?.classList.contains('modal-back-btn')) {
            const backBtn = document.createElement('button');
            backBtn.className = 'modal-back-btn';
            backBtn.innerHTML = UI_ICONS.backArrow;
            backBtn.type = 'button';
            backBtn.setAttribute('aria-label', t('aria_go_back'));
            backBtn.addEventListener('click', () => {
                triggerHaptic('light');
                closeModal(modal);
            });
            spacer.replaceWith(backBtn);
        }
    }
    
    modal.classList.add('visible');
    const fobs = modal.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (fobs.length) { ctx.firstFocusable = fobs[0]; ctx.lastFocusable = fobs[fobs.length - 1]; setTimeout(() => (focusEl || fobs[0]).focus(), 100); }
    modalStack.push(ctx); ui.appContainer.setAttribute('inert', '');
}

export function closeModal(modal: HTMLElement, suppressCallbacks = false) {
    const idx = modalStack.findIndex(c => c.element === modal); if (idx === -1) return;
    const [ctx] = modalStack.splice(idx, 1); modal.classList.remove('visible');
    if (modalStack.length === 0) ui.appContainer.removeAttribute('inert');
    
    const header = modal.querySelector('.modal-header');
    const backBtn = header?.querySelector('.modal-back-btn');
    if (header && backBtn) {
        const spacer = document.createElement('div');
        spacer.className = 'modal-header-spacer';
        backBtn.replaceWith(spacer);
    }

    if (!suppressCallbacks) ctx.onClose?.(); 
    ctx.previousFocus?.focus();
}

export function setupManageModal() {
    const lastRenderKey = ui.manageModal.dataset.manageListLastModified;
    if (!state.uiDirtyState.habitListStructure && ui.habitList.children.length > 0 && lastRenderKey === String(state.lastModified)) return;
    // FILTER: Hide logically deleted habits
    const activeHabits = state.habits.filter(h => !h.deletedOn);

    if (activeHabits.length === 0) { 
        ui.habitList.classList.add('hidden'); 
        ui.noHabitsMessage.classList.remove('hidden'); 
        ui.habitList.replaceChildren();
        state.uiDirtyState.habitListStructure = false;
        ui.manageModal.dataset.manageListLastModified = String(state.lastModified);
        return; 
    }
    
    ui.habitList.classList.remove('hidden'); 
    ui.noHabitsMessage.classList.add('hidden');
    
    const items = computeManageHabitItems(activeHabits);
    const today = getTodayUTCIso();

    ui.habitList.replaceChildren(...items.map(item => buildManageHabitListItem(item, today)));
    state.uiDirtyState.habitListStructure = false;
    ui.manageModal.dataset.manageListLastModified = String(state.lastModified);
}

export function showConfirmationModal(text: string, onConfirm: () => void, opts?: ConfirmationModalOptions) {
    if (opts?.allowHtml) ui.confirmModalText.innerHTML = text;
    else setTextContent(ui.confirmModalText, text);
    state.confirmAction = onConfirm;
    state.confirmEditAction = opts?.onEdit || null;
    setTextContent(ui.confirmModal.querySelector('h2'), opts?.title || t('modalConfirmTitle'));
    ui.confirmModalConfirmBtn.className = `btn ${opts?.confirmButtonStyle === 'danger' ? 'btn--danger' : 'btn--primary'}`;
    setTextContent(ui.confirmModalConfirmBtn, opts?.confirmText || t('confirmButton'));
    ui.confirmModalEditBtn.classList.toggle('hidden', !opts?.onEdit);
    if (opts?.editText) setTextContent(ui.confirmModalEditBtn, opts.editText);

    const onCancel = () => {
        state.confirmAction = null;
        state.confirmEditAction = null;
        opts?.onCancel?.(); 
    };

    openModal(ui.confirmModal, undefined, onCancel);
}

export function openNotesModal(habitId: string, date: string, time: TimeOfDay) {
    const h = state.habits.find(x => x.id === habitId); if (!h) return;
    state.editingNoteFor = { habitId, date, time };
    setTextContent(ui.notesModalTitle, getHabitDisplayInfo(h, date).name);
    setTextContent(ui.notesModalSubtitle, `${formatDate(parseUTCIsoDate(date), OPTS_NOTES)} - ${getTimeOfDayName(time)}`);
    ui.notesTextarea.value = getHabitDailyInfoForDate(date)[habitId]?.instances[time]?.note || '';
    openModal(ui.notesModal, ui.notesTextarea, () => state.editingNoteFor = null);
}

export function renderIconPicker() {
    if (!state.editingHabit) return;
    const { color: bg } = state.editingHabit.formData, fg = getContrastColor(bg);
    ui.iconPickerGrid.style.setProperty('--current-habit-bg-color', bg);
    ui.iconPickerGrid.style.setProperty('--current-habit-fg-color', fg);
    ui.iconPickerGrid.replaceChildren(...Object.values(HABIT_ICONS).map(svg => buildIconPickerItem(svg)));
    ui.iconPickerModal.querySelector<HTMLElement>('#change-color-from-picker-btn')!.innerHTML = UI_ICONS.colorPicker;
}

export function renderColorPicker() {
    const cur = state.editingHabit?.formData.color;
    ui.colorPickerGrid.replaceChildren(...MODAL_COLORS.map(c => buildColorSwatch(c, cur === c)));
}

export function renderFrequencyOptions() {
    if (!state.editingHabit) return;
    const f = state.editingHabit.formData.frequency, isD = f.type === 'daily', isS = f.type === 'specific_days_of_week', isI = f.type === 'interval';
    const days = [0,1,2,3,4,5,6]; if (state.activeLanguageCode !== 'pt') days.push(days.shift()!);
    const sel = isS ? new Set(f.days) : new Set();
    const am = isI ? f.amount : 2, un = isI ? f.unit : 'days';

    const root = document.createElement('div');
    root.className = 'form-section frequency-options';

    const dailyRow = document.createElement('div');
    dailyRow.className = 'form-row';
    dailyRow.appendChild(buildFrequencyTypeLabel('daily', isD, t('freqDaily')));

    const specificRow = document.createElement('div');
    specificRow.className = 'form-row form-row--vertical';
    specificRow.appendChild(buildFrequencyTypeLabel('specific_days_of_week', isS, t('freqSpecificDaysOfWeek')));

    const specificDetails = document.createElement('div');
    specificDetails.className = `frequency-details${isS ? ' visible' : ''}`;
    const weekdayPicker = document.createElement('div');
    weekdayPicker.className = 'weekday-picker';
    days.forEach(d => {
        const dayLabel = document.createElement('label');
        const dayInput = document.createElement('input');
        dayInput.type = 'checkbox';
        dayInput.className = 'visually-hidden';
        dayInput.dataset.day = String(d);
        dayInput.checked = sel.has(d);
        const dayBtn = document.createElement('span');
        dayBtn.className = 'weekday-button';
        dayBtn.textContent = t(`weekday${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]}`).charAt(0);
        dayLabel.append(dayInput, dayBtn);
        weekdayPicker.appendChild(dayLabel);
    });
    specificDetails.appendChild(weekdayPicker);
    specificRow.appendChild(specificDetails);

    const intervalRow = document.createElement('div');
    intervalRow.className = 'form-row form-row--vertical';
    intervalRow.appendChild(buildFrequencyTypeLabel('interval', isI, t('freqEvery')));

    const intervalDetails = document.createElement('div');
    intervalDetails.className = `frequency-details${isI ? ' visible' : ''}`;
    const controlGroup = document.createElement('div');
    controlGroup.className = 'interval-control-group';

    const decBtn = document.createElement('button');
    decBtn.type = 'button';
    decBtn.className = 'stepper-btn';
    decBtn.dataset.action = 'interval-decrement';
    decBtn.textContent = '-';

    const amountDisplay = document.createElement('span');
    amountDisplay.className = 'interval-amount-display';
    amountDisplay.textContent = formatInteger(am);

    const incBtn = document.createElement('button');
    incBtn.type = 'button';
    incBtn.className = 'stepper-btn';
    incBtn.dataset.action = 'interval-increment';
    incBtn.textContent = '+';

    const unitBtn = document.createElement('button');
    unitBtn.type = 'button';
    unitBtn.className = 'unit-toggle-btn';
    unitBtn.dataset.action = 'interval-unit-toggle';
    unitBtn.textContent = t(un === 'days' ? 'unitDays' : 'unitWeeks', { count: am });

    controlGroup.append(decBtn, amountDisplay, incBtn, unitBtn);
    intervalDetails.appendChild(controlGroup);
    intervalRow.appendChild(intervalDetails);

    root.append(dailyRow, specificRow, intervalRow);
    ui.frequencyOptionsContainer.replaceChildren(root);
}

export function refreshEditModalUI() {
    if (!state.editingHabit) return;
    renderFrequencyOptions();
    const fd = state.editingHabit.formData;
    ui.habitTimeContainer.replaceChildren(buildTimeSegmentedControl(fd.times));
    const nameIn = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    if (nameIn) { 
        nameIn.placeholder = t('modalEditFormNameLabel');
        nameIn.maxLength = MAX_HABIT_NAME_LENGTH;
        if (fd.nameKey) nameIn.value = t(fd.nameKey); 
    }
    
    let ce = ui.habitConscienceDisplay;
    if (!ce && ui.editHabitForm) { ce = document.createElement('div'); ce.id = 'habit-conscience-display'; ce.className = 'habit-conscience-text'; ui.editHabitForm.querySelector('.habit-identity-section')?.insertAdjacentElement('afterend', ce); }
    if (ce) { const p = fd.philosophy; if (p?.conscienceKey) { setTextContent(ce, t(p.conscienceKey)); ce.style.display = 'block'; } else ce.style.display = 'none'; }
}

export function openEditModal(habit: any, targetDateOverride?: string, onClose?: () => void) {
    const isN = !habit || !habit.id;
    const safe = getSafeDate(targetDateOverride || state.selectedDate);

    let fd: HabitTemplate;
    if (isN) {
        // Para novos hábitos (a partir de template ou customizado), não há risco de mutação
        fd = { icon: HABIT_ICONS.custom, color: _getLeastUsedColor(), times: ['Morning'], goal: { type: 'check' }, frequency: { type: 'daily' }, name: '', subtitleKey: 'customHabitSubtitle', ...habit };
        if (state.pendingHabitTime) {
            fd.times = [state.pendingHabitTime];
        }
    } else {
        // Para edição, cria cópias defensivas para isolar o formulário do estado original
        const scheduleToEdit = getScheduleForDate(habit, safe) || habit.scheduleHistory[0];
        
        const originalFrequency = scheduleToEdit.frequency;
        const newFrequency: Frequency = originalFrequency.type === 'specific_days_of_week' 
            ? { ...originalFrequency, days: [...originalFrequency.days] } 
            : { ...originalFrequency };

        fd = {
            ...(scheduleToEdit as any), // Cast para evitar erro de tipo com name/nameKey
            times: [...scheduleToEdit.times],
            frequency: newFrequency,
            goal: { ...scheduleToEdit.goal }
        };
    }

    state.pendingHabitTime = null;

    state.editingHabit = { isNew: isN, habitId: isN ? undefined : habit.id, originalData: isN ? undefined : habit, formData: fd, targetDate: safe };
    const ni = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    if (ni) {
        ni.maxLength = MAX_HABIT_NAME_LENGTH;
        ni.value = isN ? (fd.nameKey ? t(fd.nameKey) : '') : getHabitDisplayInfo(habit, safe).name;
    }
    fd.icon = sanitizeHabitIcon(fd.icon, '❓');
    const btn = ui.habitIconPickerBtn; btn.innerHTML = sanitizeHabitIcon(fd.icon, '❓'); btn.style.backgroundColor = fd.color; btn.style.color = getContrastColor(fd.color);
    
    const subtitle = isN 
        ? (fd.subtitleKey ? t(fd.subtitleKey) : '') 
        : getHabitDisplayInfo(habit, safe).subtitle;
    if (ui.habitSubtitleDisplay) {
        setTextContent(ui.habitSubtitleDisplay, subtitle);
    }
    
    const overlay = btn.nextElementSibling as HTMLElement;
    if (overlay && overlay.classList.contains('edit-icon-overlay')) {
        overlay.innerHTML = HABIT_ICONS.learnSkill;
    }

    refreshEditModalUI(); openModal(ui.editHabitModal, undefined, onClose);
}

export function renderExploreHabits() {
    ui.exploreHabitList.replaceChildren(...PREDEFINED_HABITS.map((h, i) => buildExploreHabitItem(h, i)));
}

export function renderLanguageFilter() {
    const idx = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode), names = LANGUAGES.map(l => t(l.nameKey));
    if (ui.languageViewport.classList.contains('is-interacting')) return;
    const w = (ui.languageReel.querySelector('.reel-option') as HTMLElement)?.offsetWidth || 95;
    ui.languageReel.style.transform = `translateX(${-idx * w}px)`;
    updateReelRotaryARIA(ui.languageViewport, idx, names, 'language_ariaLabel');
}
