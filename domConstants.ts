
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
// SINGLE SOURCE OF TRUTH: Define as classes CSS usadas para interatividade.
// Isso garante que se mudarmos o CSS, o TS avisa onde quebrou a lógica.

export const CSS_CLASSES = {
    // Habit Card Components
    HABIT_CARD: 'habit-card',
    HABIT_CONTENT_WRAPPER: 'habit-content-wrapper',
    HABIT_DETAILS: 'habit-details',
    HABIT_GOAL_CONTROLS: 'habit-goal-controls',
    GOAL_VALUE_WRAPPER: 'goal-value-wrapper',
    GOAL_CONTROL_BTN: 'goal-control-btn',
    
    // Actions
    SWIPE_DELETE_BTN: 'swipe-delete-btn',
    SWIPE_NOTE_BTN: 'swipe-note-btn',
    
    // Calendar
    DAY_ITEM: 'day-item',
    DAY_NAME: 'day-name',
    DAY_NUMBER: 'day-number',
    DAY_PROGRESS_RING: 'day-progress-ring',
    
    // Drag & Drop / Layout
    HABIT_GROUP: 'habit-group',
    DROP_ZONE: 'drop-zone', // Usualmente a mesma coisa que habit-group no contexto de drop
    EMPTY_GROUP_PLACEHOLDER: 'empty-group-placeholder',
    DRAG_IMAGE_GHOST: 'drag-image-ghost',
    
    // States
    SELECTED: 'selected',
    TODAY: 'today',
    COMPLETED: 'completed',
    SNOOZED: 'snoozed',
    PENDING: 'pending',
    DRAGGING: 'dragging',
    IS_SWIPING: 'is-swiping',
    IS_OPEN_LEFT: 'is-open-left',
    IS_OPEN_RIGHT: 'is-open-right',
    INVALID_DROP: 'invalid-drop',
    DRAG_OVER: 'drag-over'
} as const;

// Seletores pré-calculados para uso em querySelector/closest
// OTIMIZAÇÃO: Evita concatenação de strings repetitiva em loops de eventos (Hot Paths)
export const DOM_SELECTORS = {
    HABIT_CARD: `.${CSS_CLASSES.HABIT_CARD}`,
    HABIT_CONTENT_WRAPPER: `.${CSS_CLASSES.HABIT_CONTENT_WRAPPER}`,
    GOAL_VALUE_WRAPPER: `.${CSS_CLASSES.GOAL_VALUE_WRAPPER}`,
    GOAL_CONTROL_BTN: `.${CSS_CLASSES.GOAL_CONTROL_BTN}`,
    SWIPE_DELETE_BTN: `.${CSS_CLASSES.SWIPE_DELETE_BTN}`,
    SWIPE_NOTE_BTN: `.${CSS_CLASSES.SWIPE_NOTE_BTN}`,
    HABIT_GOAL_CONTROLS: `.${CSS_CLASSES.HABIT_GOAL_CONTROLS}`,
    DAY_ITEM: `.${CSS_CLASSES.DAY_ITEM}`,
    DROP_ZONE: `.${CSS_CLASSES.DROP_ZONE}`,
    EMPTY_GROUP_PLACEHOLDER: `.${CSS_CLASSES.EMPTY_GROUP_PLACEHOLDER}`
} as const;
