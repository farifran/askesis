

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/analysis.ts
 * @description Serviço isolado para análise de contexto diário via IA com quota tracking inteligente.
 * 
 * [SMART QUOTA TRACKING]:
 * - Detecta se as notas mudaram via hash
 * - Se hash for idêntico, reutiliza análise sem consumir quota
 * - Se houver mudança, reanalisa e incrementa contador
 */

import { state, getHabitDailyInfoForDate, TimeOfDay, GEMINI_DAILY_LIMIT } from '../state';
import { runWorkerTask } from './cloud';
import { apiFetch } from './api';
import { t, getAiLanguageName } from '../i18n';
import { logger, getTodayUTCIso } from '../utils';
import { saveState } from './persistence';

const _analysisInFlight = new Map<string, Promise<any>>();

/**
 * Extrai notas do dia e retorna junto com seu hash
 */
function extractNotesAndHash(dateISO: string): { notes: string; hash: string } {
    let notes = ''; 
    const day = getHabitDailyInfoForDate(dateISO);
    Object.keys(day).forEach(id => Object.keys(day[id].instances).forEach(t => { 
        const n = day[id].instances[t as TimeOfDay]?.note; 
        if (n) notes += `- ${n}\n`; 
    }));
    
    // Simples hash: contar caracteres + primeiros 50 chars
    // (suficiente para detectar mudanças reais)
    const hash = notes.length + ':' + notes.substring(0, 50);
    
    return { notes: notes.trim(), hash };
}

/**
 * Verifica se quota está disponível hoje
 */
function checkGeminiQuota(): { allowed: boolean; count: number; remaining: number } {
    const today = getTodayUTCIso();
    
    // Inicializar ou resetar se virou dia
    if (!state.geminiUsageToday || state.geminiUsageToday.resetAt !== today) {
        state.geminiUsageToday = { count: 0, resetAt: today };
        state.aiQuotaExceededToday = false;
        saveState();
    }
    
    const count = state.geminiUsageToday.count;
    const allowed = count < GEMINI_DAILY_LIMIT;
    const remaining = Math.max(0, GEMINI_DAILY_LIMIT - count);
    
    // Se quota foi excedida, marcar no estado
    if (!allowed && !state.aiQuotaExceededToday) {
        state.aiQuotaExceededToday = true;
        saveState();
    }
    
    return { allowed, count, remaining };
}

/**
 * Incrementa contador de quota (apenas quando faz análise real)
 */
function incrementGeminiQuota() {
    const today = getTodayUTCIso();
    
    if (!state.geminiUsageToday || state.geminiUsageToday.resetAt !== today) {
        state.geminiUsageToday = { count: 1, resetAt: today };
    } else {
        state.geminiUsageToday.count++;
    }
    
    saveState();
}

export async function checkAndAnalyzeDayContext(dateISO: string) {
    // 1. Se já tem diagnóstico para este dia, retorna
    if (state.dailyDiagnoses[dateISO] || _analysisInFlight.has(dateISO)) {
        return _analysisInFlight.get(dateISO);
    }

    const task = async () => {
        try {
            const { notes, hash } = extractNotesAndHash(dateISO);
            
            // 2. Se não há notas, não analisa
            if (!notes || !navigator.onLine) return;
            
            // 3. Verificar se notas mudaram desde última análise
            const notesChanged = state.geminiUsageToday?.lastAnalyzedNotesHash !== hash;
            
            if (!notesChanged && state.geminiUsageToday?.lastAnalyzedNotesHash) {
                logger.info(`[Analysis] Notes unchanged for ${dateISO}, skipping reanalysis`);
                // Se já foi analisado com essas notas, diagnostico está em dailyDiagnoses
                // (a função retorna cedo na linha 52)
                return;
            }
            
            // 4. Verificar quota disponível (apenas se vai fazer análise)
            const quota = checkGeminiQuota();
            if (!quota.allowed) {
                logger.warn(`[Analysis] Gemini quota exceeded for today (${quota.count}/${GEMINI_DAILY_LIMIT})`);
                return; // Falha silenciosa ou pode disparar notificação
            }
            
            logger.info(`[Analysis] Analyzing day ${dateISO} (quota: ${quota.count}/${GEMINI_DAILY_LIMIT})`);

            const promptPayload = { 
                notes, 
                themeList: t('aiThemeList'), 
                languageName: getAiLanguageName(), 
                translations: { 
                    aiPromptQuote: t('aiPromptQuote'), 
                    aiSystemInstructionQuote: t('aiSystemInstructionQuote') 
                } 
            };
            
            const { prompt, systemInstruction } = await runWorkerTask<any>('build-quote-analysis-prompt', promptPayload);

            const res = await apiFetch('/api/analyze', { 
                method: 'POST', 
                body: JSON.stringify({ prompt, systemInstruction }) 
            });

            if (!res.ok) {
                throw new Error(`Analyze request failed (${res.status})`);
            }
            
            const rawText = await res.text();
            const jsonStr = rawText.replace(/```json|```/g, '').trim();
            const json = JSON.parse(jsonStr);
            
            if (json?.analysis) { 
                // 5. Salvar análise + registrar hash
                state.dailyDiagnoses[dateISO] = { 
                    level: json.analysis.determined_level, 
                    themes: json.relevant_themes, 
                    timestamp: Date.now() 
                };
                
                // 6. Marcar notas como analisadas
                if (state.geminiUsageToday) {
                    state.geminiUsageToday.lastAnalyzedNotesHash = hash;
                }
                
                // 7. Incrementar quota
                incrementGeminiQuota();
                
                saveState(); 
                logger.info(`[Analysis] Day ${dateISO} analyzed successfully`);
            }
        } catch (e) { 
            logger.error("Context analysis failed", e); 
        } finally { 
            _analysisInFlight.delete(dateISO); 
        }
    };
    
    const p = task(); 
    _analysisInFlight.set(dateISO, p); 
    return p;
}

