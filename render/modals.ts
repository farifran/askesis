/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file render/modals.ts
 * @description Motor de Renderização de Modais e Diálogos (UI Overlay Layer).
 */

import { state, Habit, HabitTemplate, Frequency, PredefinedHabit, TimeOfDay, STREAK_CONSOLIDATED, TIMES_OF_DAY, FREQUENCIES, LANGUAGES, getHabitDailyInfoForDate } from '../state';
import { PREDEFINED_HABITS } from '../data/predefinedHabits';
import { getScheduleForDate, calculateHabitStreak, getHabitDisplayInfo } from '../services/selectors';
import { ui } from './ui';
import { t, compareStrings, formatDate, formatInteger, getTimeOfDayName } from '../i18n';
import { HABIT_ICONS, UI_ICONS, getTimeOfDayIcon } from './icons';
import { setTextContent, updateReelRotaryARIA } from './dom';
import { escapeHTML, getContrastColor, parseUTCIsoDate, getTodayUTCIso, getSafeDate } from '../utils';

interface ModalContext { element: HTMLElement; previousFocus: HTMLElement | null; onClose?: () => void; firstFocusable?: HTMLElement; lastFocusable?: HTMLElement; }
const modalStack: ModalContext[] = [];
const OPTS_NOTES = { day: 'numeric', month: 'long', timeZone: 'UTC' } as const;
const COLORS = ['#e74c3c', '#f1c40f', '#3498db', '#2ecc71', '#9b59b6', '#1abc9c', '#34495e', '#e67e22', '#e84393', '#7f8c8d'];

function _getLeastUsedColor(): string {
    const counts = new Map(COLORS.map(c => [c, 0]));
    state.habits.forEach(h => { if (!h.graduatedOn && counts.has(h.color)) counts.set(h.color, counts.get(h.color)! + 1); });
    let min = Math.min(...counts.values());
    const candidates = COLORS.filter(c => counts.get(c) === min);
    return candidates[state.habits.length % candidates.length];
}

export function initModalEngine() {
    document.addEventListener('keydown', e => {
        const ctx = modalStack[modalStack.length - 1]; if (!ctx) return;
        if (e.key === 'Escape') closeModal(ctx.element);
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
        if (e.target === ctx.element || (e.target as HTMLElement).closest('.modal-close-btn')) closeModal(ctx.element);
    });
}

export function openModal(modal: HTMLElement, focusEl?: HTMLElement, onClose?: () => void) {
    const ctx: ModalContext = { element: modal, previousFocus: document.activeElement as HTMLElement, onClose };
    modal.classList.add('visible');
    const fobs = modal.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (fobs.length) { ctx.firstFocusable = fobs[0]; ctx.lastFocusable = fobs[fobs.length - 1]; setTimeout(() => (focusEl || fobs[0]).focus(), 100); }
    modalStack.push(ctx); ui.appContainer.setAttribute('inert', '');
}

export function closeModal(modal: HTMLElement) {
    const idx = modalStack.findIndex(c => c.element === modal); if (idx === -1) return;
    const [ctx] = modalStack.splice(idx, 1); modal.classList.remove('visible');
    if (modalStack.length === 0) ui.appContainer.removeAttribute('inert');
    ctx.onClose?.(); ctx.previousFocus?.focus();
}

export function setupManageModal() {
    if (state.habits.length === 0) { ui.habitList.classList.add('hidden'); ui.noHabitsMessage.classList.remove('hidden'); return; }
    ui.habitList.classList.remove('hidden'); ui.noHabitsMessage.classList.add('hidden');
    const items = state.habits.map(h => {
        const { name, subtitle } = getHabitDisplayInfo(h);
        const st = h.graduatedOn ? 'graduated' : (h.scheduleHistory[h.scheduleHistory.length-1].endDate ? 'ended' : 'active');
        return { h, st, name, subtitle };
    }).sort((a, b) => {
        const order = { active: 0, graduated: 1, ended: 2 };
        return (order[a.st] - order[b.st]) || compareStrings(a.name, b.name);
    });
    const today = getTodayUTCIso();
    ui.habitList.innerHTML = items.map(({ h, st, name, subtitle }) => `<li class="habit-list-item ${st}" data-habit-id="${h.id}"><span class="habit-main-info"><span class="habit-icon-slot" style="color:${h.color}">${h.icon}</span><div style="display:flex;flex-direction:column"><span class="habit-name">${name}</span>${subtitle ? `<span class="habit-subtitle" style="font-size:11px;color:var(--text-tertiary)">${subtitle}</span>` : ''}</div>${st !== 'active' ? `<span class="habit-name-status">${t(st === 'graduated' ? 'modalStatusGraduated' : 'modalStatusEnded')}</span>` : ''}</span><div class="habit-list-actions">${st === 'active' ? `<button class="edit-habit-btn" aria-label="${t('aria_edit', { name })}">${UI_ICONS.editAction}</button>${calculateHabitStreak(h.id, today) >= STREAK_CONSOLIDATED ? `<button class="graduate-habit-btn" aria-label="${t('aria_graduate', { name })}">${UI_ICONS.graduateAction}</button>` : `<button class="end-habit-btn" aria-label="${t('aria_end', { name })}">${UI_ICONS.endAction}</button>`}` : `<button class="permanent-delete-habit-btn" aria-label="${t('aria_delete_permanent', { name })}">${UI_ICONS.deletePermanentAction}</button>`}</div></li>`).join('');
}

export function showConfirmationModal(text: string, onConfirm: () => void, opts?: any) {
    ui.confirmModalText.innerHTML = text; state.confirmAction = onConfirm; state.confirmEditAction = opts?.onEdit || null;
    setTextContent(ui.confirmModal.querySelector('h2'), opts?.title || t('modalConfirmTitle'));
    ui.confirmModalConfirmBtn.className = `btn ${opts?.confirmButtonStyle === 'danger' ? 'btn--danger' : 'btn--primary'}`;
    setTextContent(ui.confirmModalConfirmBtn, opts?.confirmText || t('confirmButton'));
    ui.confirmModalEditBtn.classList.toggle('hidden', !opts?.onEdit);
    if (opts?.editText) setTextContent(ui.confirmModalEditBtn, opts.editText);
    const cb = ui.confirmModal.querySelector<HTMLElement>('.modal-close-btn')!;
    setTextContent(cb, opts?.cancelText || t('cancelButton')); cb.style.display = opts?.hideCancel ? 'none' : '';
    openModal(ui.confirmModal);
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
    ui.iconPickerGrid.innerHTML = Object.values(HABIT_ICONS).map(svg => `<button type="button" class="icon-picker-item" data-icon-svg="${escapeHTML(svg)}">${svg}</button>`).join('');
    ui.iconPickerModal.querySelector<HTMLElement>('#change-color-from-picker-btn')!.innerHTML = UI_ICONS.colorPicker;
}

export function renderColorPicker() {
    const cur = state.editingHabit?.formData.color;
    ui.colorPickerGrid.innerHTML = COLORS.map(c => `<button type="button" class="color-swatch ${cur === c ? 'selected' : ''}" style="background-color:${c}" data-color="${c}"></button>`).join('');
}

export function renderFrequencyOptions() {
    if (!state.editingHabit) return;
    const f = state.editingHabit.formData.frequency, isD = f.type === 'daily', isS = f.type === 'specific_days_of_week', isI = f.type === 'interval';
    const days = [0,1,2,3,4,5,6]; if (state.activeLanguageCode !== 'pt') days.push(days.shift()!);
    const sel = isS ? new Set(f.days) : new Set();
    const am = isI ? f.amount : 2, un = isI ? f.unit : 'days';

    ui.frequencyOptionsContainer.innerHTML = `<div class="form-section frequency-options"><div class="form-row"><label><input type="radio" name="frequency-type" value="daily" ${isD ? 'checked' : ''}>${t('freqDaily')}</label></div><div class="form-row form-row--vertical"><label><input type="radio" name="frequency-type" value="specific_days_of_week" ${isS ? 'checked' : ''}>${t('freqSpecificDaysOfWeek')}</label><div class="frequency-details ${isS ? 'visible' : ''}"><div class="weekday-picker">${days.map(d => `<label><input type="checkbox" class="visually-hidden" data-day="${d}" ${sel.has(d) ? 'checked' : ''}><span class="weekday-button">${t(`weekday${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]}`).charAt(0)}</span></label>`).join('')}</div></div></div><div class="form-row form-row--vertical"><label><input type="radio" name="frequency-type" value="interval" ${isI ? 'checked' : ''}>${t('freqEvery')}</label><div class="frequency-details ${isI ? 'visible' : ''}"><div class="interval-control-group"><button type="button" class="stepper-btn" data-action="interval-decrement">-</button><span class="interval-amount-display">${formatInteger(am)}</span><button type="button" class="stepper-btn" data-action="interval-increment">+</button><button type="button" class="unit-toggle-btn" data-action="interval-unit-toggle">${t(un === 'days' ? 'unitDays' : 'unitWeeks', { count: am })}</button></div></div></div></div>`;
}

export function refreshEditModalUI() {
    if (!state.editingHabit) return;
    renderFrequencyOptions();
    const fd = state.editingHabit.formData;
    ui.habitTimeContainer.innerHTML = `<div class="segmented-control">${TIMES_OF_DAY.map(t => `<button type="button" class="segmented-control-option ${fd.times.includes(t) ? 'selected' : ''}" data-time="${t}">${getTimeOfDayIcon(t)}${getTimeOfDayName(t)}</button>`).join('')}</div>`;
    const nameIn = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    if (nameIn) { nameIn.placeholder = t('modalEditFormNameLabel'); if (fd.nameKey) nameIn.value = t(fd.nameKey); }
    
    let ce = ui.habitConscienceDisplay;
    if (!ce && ui.editHabitForm) { ce = document.createElement('div'); ce.id = 'habit-conscience-display'; ce.className = 'habit-conscience-text'; ui.editHabitForm.querySelector('.habit-identity-section')?.insertAdjacentElement('afterend', ce); }
    if (ce) { const p = fd.philosophy; if (p?.conscienceKey) { setTextContent(ce, t(p.conscienceKey)); ce.style.display = 'block'; } else ce.style.display = 'none'; }
}

export function openEditModal(habit: any) {
    const isN = !habit || !habit.id, safe = getSafeDate(state.selectedDate);
    const fd = isN ? { icon: HABIT_ICONS.custom, color: _getLeastUsedColor(), times: ['Morning'], goal: { type: 'check' }, frequency: { type: 'daily' }, name: '', subtitleKey: 'customHabitSubtitle', ...habit } : { ...habit, times: [...(getScheduleForDate(habit, safe) || habit.scheduleHistory[0]).times], frequency: { ...(getScheduleForDate(habit, safe) || habit.scheduleHistory[0]).frequency } };
    state.editingHabit = { isNew: isN, habitId: isN ? undefined : habit.id, originalData: isN ? undefined : habit, formData: fd as any, targetDate: safe };
    const ni = ui.editHabitForm.elements.namedItem('habit-name') as HTMLInputElement;
    if (ni) ni.value = isN ? (habit?.nameKey ? t(habit.nameKey) : '') : getHabitDisplayInfo(habit, safe).name;
    const btn = ui.habitIconPickerBtn; btn.innerHTML = fd.icon; btn.style.backgroundColor = fd.color; btn.style.color = getContrastColor(fd.color);
    refreshEditModalUI(); openModal(ui.editHabitModal);
}

export function renderExploreHabits() {
    ui.exploreHabitList.innerHTML = PREDEFINED_HABITS.map((h, i) => `<div class="explore-habit-item" data-index="${i}" role="button" tabindex="0"><div class="explore-habit-icon" style="background-color:${h.color}30;color:${h.color}">${h.icon}</div><div class="explore-habit-details"><div class="name">${t(h.nameKey)}</div></div></div>`).join('');
}

export function renderLanguageFilter() {
    const idx = LANGUAGES.findIndex(l => l.code === state.activeLanguageCode), names = LANGUAGES.map(l => t(l.nameKey));
    if (ui.languageViewport.classList.contains('is-interacting')) return;
    const w = (ui.languageReel.querySelector('.reel-option') as HTMLElement)?.offsetWidth || 95;
    ui.languageReel.style.transform = `translateX(${-idx * w}px)`;
    updateReelRotaryARIA(ui.languageViewport, idx, names, 'language_ariaLabel');
}