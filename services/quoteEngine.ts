
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/quoteEngine.ts
 * @description Motor de Recomendação Contextual para Citações Estoicas (The Stoic Oracle).
 * 
 * ARQUITETURA:
 * Sistema de pontuação ponderada (Weighted Scoring System).
 * O objetivo é entregar o "remédio" correto para o estado atual da alma do usuário.
 * 
 * V7.2 UPDATES [2025-05-14] - ROBUST SAGE:
 * - Crash Guard: Validação estrita de datas para evitar seeds NaN.
 * - True Urgency: Implementação real do estado 'urgency' para noites improdutivas (foco em Tempo/Ação).
 * - Case Insensitive: Normalização de tags da IA.
 * - Historical Determinism: O passado é imutável (seed fixa para datas anteriores a hoje).
 */

import { state, Habit, StoicVirtue, GovernanceSphere } from '../state';
import { Quote } from '../data/quotes';
import { calculateDaySummary, getEffectiveScheduleForHabitOnDate, calculateHabitStreak } from './selectors';
import { toUTCIsoDateString, parseUTCIsoDate, getTodayUTCIso } from '../utils';

// --- TUNING CONSTANTS (The Soul of the Algorithm) ---
const WEIGHTS = {
    AI_MATCH: 50,        // Máxima prioridade: O usuário falou sobre isso explicitamente.
    SPHERE_MATCH: 40,    // Alta prioridade: O "Remédio" específico para a área negligenciada.
    RECOVERY: 35,        // Encorajamento após falha.
    PERFORMANCE: 30,     // Reação ao estado geral.
    MOMENTUM: 25,        // Boost para consistência.
    TIME_OF_DAY: 15,     // Contexto temporal.
    VIRTUE_ALIGN: 10,    // Reforço de identidade.
    
    // Penalties
    RECENTLY_SHOWN: -100 
};

// HYSTERESIS CONSTANTS
const MIN_DISPLAY_DURATION = 20 * 60 * 1000; // 20 minutes stickiness
const TRIUMPH_ENTER = 0.80; 
const TRIUMPH_EXIT = 0.70;  
const STRUGGLE_ENTER = 0.25; // > 25% snoozed is explicit struggle
const STRUGGLE_EXIT = 0.15;  

// CONSTANTS FOR HISTORY
const HISTORY_LOOKBACK = 10;
const HISTORY_GOOD_THRESHOLD = 0.5; // Consideramos um dia "bom" se > 50% feito

type PerformanceState = 'neutral' | 'struggle' | 'urgency' | 'triumph' | 'defeat';

// --- TYPES ---

interface ContextVector {
    timeOfDay: 'morning' | 'afternoon' | 'evening';
    dominantVirtues: Set<StoicVirtue>;
    neglectedSphere: GovernanceSphere | null; 
    isRecovery: boolean; 
    performanceState: PerformanceState;
    momentumState: 'building' | 'unbroken' | 'broken' | 'none';
    aiThemes: Set<string>;
    lastShownId?: string;
    isMajorShift?: boolean; 
}

// --- HELPERS ---

function _getTimeOfDay(): 'morning' | 'afternoon' | 'evening' {
    const hour = new Date().getHours();
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
}

function _stringHash(str: string): number {
    let hash = 5381;
    let i = str.length;
    while(i) {
        hash = (hash * 33) ^ str.charCodeAt(--i);
    }
    return hash >>> 0; 
}

/**
 * Analisa a consistência dos últimos 10 dias.
 * @returns Score de 0.0 a 1.0 (1.0 = Perfeito, 0.0 = Desastre)
 * Retorna 1.0 (Benefício da Dúvida) se não houver histórico.
 */
function _analyzeRecentHistory(todayISO: string): number {
    const today = parseUTCIsoDate(todayISO);
    let validDays = 0;
    let successfulDays = 0;

    // Loop reverso começando de ONTEM (i=1) até 10 dias atrás.
    for (let i = 1; i <= HISTORY_LOOKBACK; i++) {
        const pastDate = new Date(today);
        pastDate.setUTCDate(today.getUTCDate() - i);
        const pastISO = toUTCIsoDateString(pastDate);

        // calculateDaySummary já usa caches internos eficientemente
        const summary = calculateDaySummary(pastISO);

        if (summary.total > 0) {
            validDays++;
            // Critério de Sucesso do Dia: > 50% de conclusão
            if ((summary.completed / summary.total) >= HISTORY_GOOD_THRESHOLD) {
                successfulDays++;
            }
        }
    }

    if (validDays === 0) return 1.0;

    return successfulDays / validDays;
}

function _getDominantVirtues(habits: Habit[], dateISO: string): Set<StoicVirtue> {
    const counts: Record<string, number> = {};
    
    habits.forEach(h => {
        const schedule = getEffectiveScheduleForHabitOnDate(h, dateISO);
        if (schedule.length > 0 && h.philosophy) {
            const v = h.philosophy.virtue;
            counts[v] = (counts[v] || 0) + 1;
        }
    });

    let max = 0;
    Object.values(counts).forEach(c => { if (c > max) max = c; });
    
    const dominant = new Set<StoicVirtue>();
    if (max > 0) {
        Object.entries(counts).forEach(([virtue, count]) => {
            if (count === max) dominant.add(virtue as StoicVirtue);
        });
    }
    return dominant;
}

function _getNeglectedSphere(habits: Habit[], dateISO: string): GovernanceSphere | null {
    const sphereStats: Record<string, { total: number, done: number }> = {};
    const dailyData = state.dailyData[dateISO] || {};

    habits.forEach(h => {
        const schedule = getEffectiveScheduleForHabitOnDate(h, dateISO);
        if (schedule.length > 0 && h.philosophy) {
            const sph = h.philosophy.sphere;
            if (!sphereStats[sph]) sphereStats[sph] = { total: 0, done: 0 };
            
            schedule.forEach(time => {
                sphereStats[sph].total++;
                const status = dailyData[h.id]?.instances[time]?.status;
                if (status === 'completed') sphereStats[sph].done++;
            });
        }
    });

    let worstRatio = 1.0;
    let worstSphere: GovernanceSphere | null = null;

    Object.entries(sphereStats).forEach(([sphere, stats]) => {
        if (stats.total > 0) {
            const ratio = stats.done / stats.total;
            if (ratio < 1 && ratio <= worstRatio) {
                worstRatio = ratio;
                worstSphere = sphere as GovernanceSphere;
            }
        }
    });

    return (worstRatio < 0.5) ? worstSphere : null;
}

function _checkRecovery(dateISO: string): boolean {
    const todaySummary = calculateDaySummary(dateISO);
    
    if (todaySummary.total > 0 && (todaySummary.completed / todaySummary.total) < 0.2) {
        return false;
    }

    const todayDate = parseUTCIsoDate(dateISO);
    const yesterdayDate = new Date(todayDate.getTime() - 86400000);
    const yesterdayISO = toUTCIsoDateString(yesterdayDate);
    
    const yesterdaySummary = calculateDaySummary(yesterdayISO);
    
    // Recovery: Ontem foi um dia ATIVO (com hábitos) e falho.
    if (yesterdaySummary.total > 0 && 
        (yesterdaySummary.completed / yesterdaySummary.total) < 0.4 &&
        todaySummary.completed > 0) {
        return true;
    }
    
    return false;
}

function _getMomentumState(habits: Habit[], dateISO: string): 'building' | 'unbroken' | 'broken' | 'none' {
    let maxStreak = 0;
    for (const h of habits) {
        const streak = calculateHabitStreak(h, dateISO);
        if (streak > maxStreak) maxStreak = streak;
    }
    if (maxStreak > 10) return 'unbroken'; 
    if (maxStreak > 3) return 'building'; 
    return 'none';
}

function _getPerformanceStateWithHysteresis(
    dateISO: string, 
    lastContextHash?: string
): PerformanceState {
    const summary = calculateDaySummary(dateISO);
    const timeOfDay = _getTimeOfDay();
    
    if (summary.total === 0) return 'neutral';

    const completionRate = summary.completed / summary.total;
    const snoozeRate = summary.snoozed / summary.total;
    
    // 1. TRIUMPH (Explicit Success)
    if (completionRate >= TRIUMPH_ENTER) return 'triumph'; 

    // 2. STRUGGLE (Explicit Difficulty)
    if (snoozeRate > STRUGGLE_ENTER) return 'struggle';
    
    // 3. URGENCY (Evening + Low Progress) - CORREÇÃO v7.2
    const isToday = dateISO === getTodayUTCIso();
    if (isToday && timeOfDay === 'evening' && completionRate < 0.1 && snoozeRate < 0.1) {
        return 'urgency'; 
    }
    
    // 4. DEFEAT (Trend Analysis)
    if (completionRate < 0.2 && snoozeRate < 0.2) {
        const historyConsistency = _analyzeRecentHistory(dateISO);
        if (historyConsistency < 0.4) {
            return 'defeat';
        }
        return 'neutral';
    }
    
    // Hysteresis
    let previousState: PerformanceState = 'neutral';
    if (lastContextHash && lastContextHash.includes('-')) {
        const parts = lastContextHash.split('-');
        if (parts[4]) previousState = parts[4] as PerformanceState;
    }

    if (previousState === 'triumph' && completionRate >= TRIUMPH_EXIT) return 'triumph';
    if (previousState === 'struggle' && snoozeRate > STRUGGLE_EXIT) return 'struggle';

    return 'neutral';
}

function _gatherContext(dateISO: string): ContextVector {
    const quoteState = state.quoteState;
    const diagnosis = state.dailyDiagnoses[dateISO];
    
    // ROBUSTEZ v7.2: Normaliza temas para lowercase para garantir match com tags
    const aiThemes = new Set(
        (diagnosis ? diagnosis.themes : []).map(t => t.toLowerCase())
    );
    
    const dominantVirtues = _getDominantVirtues(state.habits, dateISO);
    const neglectedSphere = _getNeglectedSphere(state.habits, dateISO);
    const isRecovery = _checkRecovery(dateISO);
    
    const momentumState = _getMomentumState(state.habits, dateISO);
    const timeOfDay = _getTimeOfDay();
    const performanceState = _getPerformanceStateWithHysteresis(dateISO, quoteState?.lockedContext);

    let isMajorShift = false;
    if (quoteState && quoteState.lockedContext) {
        const parts = quoteState.lockedContext.split('-');
        const oldState = parts[4] as PerformanceState;
        
        if (oldState !== performanceState && (performanceState === 'triumph' || performanceState === 'defeat' || performanceState === 'urgency')) {
            isMajorShift = true;
        }
        if (parts[3] !== timeOfDay) {
            isMajorShift = true;
        }
    } else {
        isMajorShift = true;
    }

    return {
        timeOfDay,
        dominantVirtues,
        neglectedSphere,
        isRecovery,
        performanceState,
        momentumState,
        aiThemes,
        lastShownId: quoteState?.currentId,
        isMajorShift
    };
}

function _scoreQuote(quote: Quote, context: ContextVector): number {
    let score = 1.0; 

    // 0. ANTI-REPETITION (Apenas se for Hoje, para não penalizar a consistência histórica)
    if (context.lastShownId === quote.id) {
        score += WEIGHTS.RECENTLY_SHOWN;
    }

    // 1. AI BOOST
    if (context.aiThemes.size > 0) {
        // As tags do banco já são lowercase. AiThemes agora também é (normalizado em _gatherContext).
        const matches = quote.metadata.tags.filter(tag => context.aiThemes.has(tag));
        score += matches.length * WEIGHTS.AI_MATCH;
    }

    // 2. SPHERE SENSITIVITY
    if (context.neglectedSphere && quote.metadata.sphere === context.neglectedSphere) {
        score += WEIGHTS.SPHERE_MATCH;
    }

    // 3. RECOVERY DETECTED
    if (context.isRecovery) {
        if (quote.metadata.tags.includes('resilience') || 
            quote.metadata.tags.includes('growth') || 
            quote.metadata.tags.includes('hope')) {
            score += WEIGHTS.RECOVERY;
        }
    }

    // 4. TIME OF DAY
    if (context.timeOfDay === 'morning' && quote.metadata.tags.includes('morning')) score += WEIGHTS.TIME_OF_DAY;
    if (context.timeOfDay === 'evening' && (quote.metadata.tags.includes('evening') || quote.metadata.tags.includes('reflection') || quote.metadata.tags.includes('rest'))) score += WEIGHTS.TIME_OF_DAY;

    // 5. VIRTUE RESONANCE
    if (context.dominantVirtues.has(quote.metadata.virtue)) {
        score += WEIGHTS.VIRTUE_ALIGN;
    }

    // 6. PERFORMANCE REACTION
    if (context.performanceState === 'defeat') {
        if (quote.metadata.tags.includes('resilience') || 
            quote.metadata.tags.includes('acceptance') || 
            quote.metadata.tags.includes('fate')) {
            score += WEIGHTS.PERFORMANCE;
        }
    } else if (context.performanceState === 'triumph') {
        if (quote.metadata.tags.includes('humility') || 
            quote.metadata.tags.includes('temperance') || 
            quote.metadata.tags.includes('death')) {
            score += WEIGHTS.PERFORMANCE;
        }
    } else if (context.performanceState === 'struggle') {
        if (quote.metadata.tags.includes('discipline') || 
            quote.metadata.tags.includes('action') || 
            quote.metadata.tags.includes('focus')) {
            score += WEIGHTS.PERFORMANCE;
        }
    } else if (context.performanceState === 'urgency') {
        // CORREÇÃO v7.2: Estado de Urgência explícito
        // Foca em Tempo (memento mori) e Ação imediata
        if (quote.metadata.tags.includes('urgency') || 
            quote.metadata.tags.includes('time') || 
            quote.metadata.tags.includes('action') ||
            quote.metadata.tags.includes('death')) {
            score += WEIGHTS.PERFORMANCE * 1.2; // Boost extra para urgência
        }
    }

    // 7. MOMENTUM CONTEXT
    if (context.momentumState === 'unbroken') {
        if (quote.metadata.tags.includes('consistency') || 
            quote.metadata.tags.includes('habit')) {
            score += WEIGHTS.MOMENTUM;
        }
    }

    return score;
}

// --- PUBLIC API ---

export function selectBestQuote(quotes: Quote[], dateISO: string): Quote {
    if (!quotes || quotes.length === 0) {
        throw new Error("No quotes provided to engine.");
    }

    // CRASH GUARD v7.2: Previne datas inválidas e fallback para Hoje
    if (!dateISO || isNaN(Date.parse(dateISO))) {
        dateISO = getTodayUTCIso();
    }

    const context = _gatherContext(dateISO);
    
    // STICKINESS CHECK (Only applies to Today)
    const isToday = dateISO === getTodayUTCIso();
    if (isToday && state.quoteState && !context.isMajorShift) {
        const elapsed = Date.now() - state.quoteState.displayedAt;
        if (elapsed < MIN_DISPLAY_DURATION) {
            const current = quotes.find(q => q.id === state.quoteState!.currentId);
            if (current) return current;
        }
    }
    
    const scoredQuotes = quotes.map(q => ({
        quote: q,
        score: _scoreQuote(q, context)
    }));

    scoredQuotes.sort((a, b) => b.score - a.score);

    const topScore = scoredQuotes[0].score;
    // Ligeiro aumento no threshold para garantir qualidade (top 70% das melhores)
    const threshold = topScore > 10 ? topScore * 0.7 : 0;
    let candidates = scoredQuotes.filter(item => item.score >= threshold);
    if (candidates.length > 5) candidates = candidates.slice(0, 5); 
    
    const virtueStr = Array.from(context.dominantVirtues).sort().join('');
    const sphereStr = context.neglectedSphere || 'none';
    
    // Assinatura do contexto para seed
    const signature = `${dateISO}-${context.timeOfDay}-${context.performanceState}-${virtueStr}-${sphereStr}`;
    
    const year = parseInt(dateISO.substring(0, 4), 10);
    const day = parseInt(dateISO.substring(8, 10), 10);
    
    // ROTATION LOGIC v7.1 (Determinismo Histórico):
    // Se for hoje, rotaciona com a hora.
    // Se for passado/futuro, fixa em 12h para que a citação seja sempre a mesma ao revisitar o dia.
    const rotationHour = isToday ? new Date().getHours() : 12;
    
    // Crash Guard: Ensure valid numbers for Math
    const safeYear = isNaN(year) ? 2024 : year;
    const safeDay = isNaN(day) ? 1 : day;

    // NOISE REDUCTION: Removido Date.now() para garantir determinismo puro baseado no hash
    const seed = Math.abs(_stringHash(signature) + (safeYear * safeDay) + rotationHour); 
    const rnd = (seed % 1000) / 1000;
    
    const selectedIndex = Math.floor(rnd * candidates.length);
    const selectedQuote = candidates[selectedIndex].quote;

    // Atualiza estado global apenas se for o dia de hoje
    if (isToday) {
        state.quoteState = {
            currentId: selectedQuote.id,
            displayedAt: Date.now(),
            lockedContext: signature
        };
    }
    
    return selectedQuote;
}
