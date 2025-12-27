/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file data/icons.ts
 * @description Repositório de Strings SVG Estáticas (Vectores Otimizados - SOTA).
 * 
 * [ISOMORPHIC CONTEXT]:
 * Este arquivo contém APENAS dados primitivos (strings).
 * É garantido que é seguro para importação em qualquer contexto (Main Thread, Worker, Node.js).
 * 
 * ARQUITETURA (Deep Vectorization & Nano-Optimization):
 * - **Single DOM Node:** Ícones renderizados como um único elemento `<path>`.
 * - **Nano-Optimization:** Remoção agressiva de espaços e uso de sintaxe SVG compacta (ex: `0 01` flags).
 * - **Geometry Concatenation:** Constantes geométricas (`D_...`) reutilizáveis.
 */

// --- BOILERPLATE CONSTANTS ---
const SVG_START = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"';
const STROKE_ATTRS = ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const CLOSE_SVG = '</svg>';

/**
 * Helper Legacy para ícones complexos (ex: ColorPicker com múltiplos fills).
 */
const mkIcon = (content: string) => `${SVG_START}${STROKE_ATTRS}>${content}${CLOSE_SVG}`;

/**
 * Helper Otimizado: Gera um ícone SVG de Path Único.
 * @param d A string de dados de geometria (Path Data).
 */
const mkPath = (d: string) => `${SVG_START}${STROKE_ATTRS}><path d="${d}"/></svg>`;

// --- SHARED GEOMETRIES (Raw Path Data - Nano Optimized) ---

// Caneta/Lápis (Relative Move Optimization)
const D_PEN = 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7m.5-8.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z';

// Página com dobra (Redundant M Removal)
const D_PAGE = 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zv6h6';

// Lixeira (Fixed Handle Position)
const D_TRASH = 'M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2';

// Círculo Outline
const D_CIRCLE_OUTLINE = 'M12 2a10 10 0 100 20 10 10 0 000-20';

// Sol (Symmetric Rays & Bounds Fix)
const D_SUN = 'M12 7a5 5 0 100 10 5 5 0 000-10m0-6v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4';

// Lua (Rounded Coordinates)
const D_MOON = 'M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z';

export const HABIT_ICONS = {
    read: mkPath('M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2zM22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z'),
    meditate: mkPath('M8.2 16.2c-1.3-1.3-2.2-3-2.2-4.9C6 9.4 7.1 7.8 8.8 6.8M15.8 16.2c1.3-1.3 2.2-3 2.2-4.9 0-1.9-1.1-3.5-2.8-4.5M12 13a3 3 0 100-6 3 3 0 000 6zM12 21a9 9 0 009-9M3 12a9 9 0 019-9'),
    water: mkPath('M12 22a7 7 0 007-7c0-2.3-1.3-4.9-3.4-7.4C13.8 5.1 12 2.8 12 2.8s-1.8 2.3-3.6 4.8C6.3 10.1 5 12.7 5 15a7 7 0 007 7z'),
    exercise: mkPath('M22 12h-4l-3 9L9 3l-3 9H2'),
    stretch: mkPath('M12 4a1 1 0 100 2 1 1 0 000-2M9 20l3-6 3 6M6 12l6-2 6 2'),
    journal: mkPath(D_PAGE + 'M16 13H8M16 17H8'),
    language: mkPath('M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z'),
    organize: mkPath('M21 16V8a2 2 0 00-1-1.7l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.7l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.3 7 12 12 20.7 7M12 22.1V12'),
    walk: mkPath('M14.9 14.3c.3-.5.3-1.1 0-1.6l-4-6c-.6-1-1.8-1.2-2.8-.6-.9.6-1.2 1.8-.6 2.8l4 6c.6 1 1.8 1.2 2.8.6.2-.1.3-.3.4-.4zM12 12l-2-2M10.1 18.7c.3-.5.3-1.1 0-1.6l-4-6c-.6-1-1.8-1.2-2.8-.6-.9.6-1.2 1.8-.6 2.8l4 6c.6 1 1.8 1.2 2.8.6.2-.1.3-.3.4-.4z'),
    planDay: mkPath('M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9zM13 2v7h7M9 15h6M9 19h6'),
    creativeHobby: mkPath('M12 2.7l.3 1.2.1.4H22l-1.6 1.1-.3.2.1.4 1.6 2.5-1.6 1.1-.3.2.1.4.3 1.2-1.6-1.2-.3-.2-.3.2-1.6 1.2.3-1.2.1-.4-.3-.2-1.6-1.2 1.6-2.5.1-.4-.3-.2L12 2.7zM2 12l1.6 1.1.3.2.1.4-1.6 2.5 1.6 1.1.3.2.1.4-.3 1.2 1.6-1.2.3-.2.3.2 1.6 1.2-.3-1.2.1-.4-.3-.2-1.6-1.2 1.6-2.5.1-.4-.3-.2L2 12z'),
    gratitude: mkPath('M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 00-7.8 7.8l1.1 1.1L12 21.2l7.8-7.8 1.1-1.1a5.5 5.5 0 000-7.8z'),
    eatFruit: mkPath('M20.9 14.4a9 9 0 11-11.2-11.2M13 2a6 6 0 00-6 6 3 3 0 003 3h0a3 3 0 003-3A6 6 0 0013 2Z'),
    talkFriend: mkPath('M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z'),
    screenBreak: mkPath('M9.9 4.2A9.8 9.8 0 0112 3c7 0 11 8 11 8a17.8 17.8 0 01-3.2 4.2M1 12s4-8 11-8c.9 0 1.8.1 2.6.4M4.2 19.8A9.8 9.8 0 0112 21c7 0 11-8 11-8a17.8 17.8 0 00-3.2-4.2M12 15a3 3 0 110-6 3 3 0 010 6zM1 1l22 22'),
    instrument: mkPath('M9 18V5l12-2v13M6 21a3 3 0 100-6 3 3 0 000 6M18 19a3 3 0 100-6 3 3 0 000 6'),
    plants: mkPath('M7 20h10M12 4v16M10 4c-2.5 1.5-4 4-4 7M14 4c2.5 1.5 4 4 4 7'),
    finances: mkPath('M18 20V10M12 20V4M6 20V14'),
    tea: mkPath('M18 8h1a4 4 0 010 8h-1M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8zm4-6v2m4-2v2m4-2v2'),
    podcast: mkPath('M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8'),
    emails: mkPath('M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.5-6.9A2 2 0 0016.8 4H7.2a2 2 0 00-1.8 1.1z'),
    skincare: mkPath('M10 3L8 8l-5 2 5 2 2 5 2-5 5-2-5-2-2-5zM18 13l-2 5-2-5-5-2 5-5-2-2-5-2-5 5-2-5 5-2z'),
    sunlight: mkPath(D_SUN),
    disconnect: mkPath('M1 1l22 22M16.7 11.1A10.9 10.9 0 0119 12.6M5 12.6a10.9 10.9 0 015.2-2.4M10.7 5.1A16 16 0 0122.6 9M1.4 9a15.9 15.9 0 014.7-2.9M8.5 16.1a6 6 0 017 0M12 20h.01'),
    draw: mkPath('M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.6 7.6M11 13a2 2 0 100-4 2 2 0 000 4'),
    familyTime: mkPath('M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8'),
    news: mkPath('M4 22h16a2 2 0 002-2V4a2 2 0 00-2-2H8a2 2 0 00-2 2v16a2 2 0 01-2 2Zm0 0a2 2 0 01-2-2v-9c0-1.1.9-2 2-2h2M18 14h-8M15 18h-5M10 6h8v4h-8V6Z'),
    cookHealthy: mkPath('M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2M7 2v20M21 15V2v0a5 5 0 00-5 5v6c0 1.1.9 2 2 2h3'),
    learnSkill: mkPath('M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.8-3.8a6 6 0 01-7.9 7.9l-6.9 6.9a2.1 2.1 0 01-3-3l6.9-6.9a6 6 0 017.9-7.9l-3.8 3.8z'),
    photography: mkPath('M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8'),
    yoga: mkPath('M12 6a2 2 0 100-4 2 2 0 000 4M15 22v-4a2 2 0 00-2-2h-2a2 2 0 00-2 2v4M9 13l-2-2M15 13l2-2'),
    reflectDay: mkPath(D_MOON),
    custom: mkPath('M12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2z'),
} as const;

export const UI_ICONS = {
    settings: mkPath('M10.3 4.3c.4-1.8 2.9-1.8 3.4 0a1.7 1.7 0 002.6 1.1c1.5-.9 3.3.8 2.4 2.4a1.7 1.7 0 001.1 2.6c1.8.4 1.8 2.9 0 3.4a1.7 1.7 0 00-1.1 2.6c.9 1.5-.8 3.3-2.4 2.4a1.7 1.7 0 00-2.6 1.1c-.4 1.8-2.9 1.8-3.4 0a1.7 1.7 0 00-2.6-1.1c-1.5.9-3.3-.8-2.4-2.4a1.7 1.7 0 00-1.1-2.6c-1.8-.4-1.8-2.9 0-3.4a1.7 1.7 0 001.1-2.6c-.9-1.5.8-3.3 2.4-2.4a1.7 1.7 0 002.6-1.1zM12 15a3 3 0 100-6 3 3 0 000 6'),
    ai: mkPath('M12 8V4H8M6 8h12a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2M2 14h2M20 14h2M15 13v2M9 13v2'),
    snoozed: mkPath(D_CIRCLE_OUTLINE + 'M12 6v6l4 2'),
    check: mkPath('M20 6 9 17 4 12'),
    swipeNoteHasNote: mkPath(D_PAGE + 'M16 13H8M16 17H8M10 9H8'),
    swipeNote: mkPath(D_PEN),
    swipeDelete: mkPath(D_TRASH + 'M10 11v6M14 11v6'),
    deletePermanentAction: mkPath(D_TRASH),
    editAction: mkPath(D_PEN),
    graduateAction: mkPath('M12 1a7 7 0 100 14 7 7 0 000-14M8.2 13.9L7 23l5-3 5 3-1.2-9.1'),
    endAction: mkPath(D_CIRCLE_OUTLINE + 'M4.9 4.9l14.2 14.2'),
    
    // ColorPicker: Optimized Sector Logic (TopRight, BottomRight, BottomLeft, TopLeft)
    colorPicker: mkIcon('<path d="M12 12V2a10 10 0 0110 10z" fill="var(--color-red)"/><path d="M12 12h10a10 10 0 01-10 10z" fill="var(--accent-blue)"/><path d="M12 12v10a10 10 0 01-10-10z" fill="var(--accent-green)"/><path d="M12 12H2a10 10 0 0110-10z" fill="var(--color-yellow)"/>'),
    
    edit: mkPath('M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z'),
    
    calendar: mkPath('M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2zM16 2v4M8 2v4M3 10h18'),
    
    morning: mkPath('M12 9V7M4.2 10.2l1.4 1.4M19.8 10.2l-1.4 1.4M1 18h2m18 0h2M17 18a5 5 0 00-10 0M2 22h20'),
    afternoon: mkPath(D_SUN),
    evening: mkPath(D_MOON),

    close: mkPath('M18 6 6 18M6 6l12 12'),
    chevronLeft: mkPath('M15 18l-6-6 6-6'),
    chevronRight: mkPath('M9 18l6-6-6-6'),
    spinner: mkPath('M21 12a9 9 0 11-6.2-8.6'),
} as const;

export type HabitIconKey = keyof typeof HABIT_ICONS;
export type UiIconKey = keyof typeof UI_ICONS;
