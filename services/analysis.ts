
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/analysis.ts
 * @description Serviço isolado para análise de contexto diário via IA.
 */

import { state, getHabitDailyInfoForDate, TimeOfDay, LANGUAGES } from '../state';
import { runWorkerTask } from './cloud';
import { apiFetch } from './api';
import { t } from '../i18n';
import { saveState } from './persistence';

const _analysisInFlight = new Map<string, Promise<any>>();

// Helper local para obter nome do idioma (duplicado de habitActions para evitar dependência)
const _getAiLang = () => t(LANGUAGES.find(l => l.code === state.activeLanguageCode)?.nameKey || 'langEnglish');

export async function checkAndAnalyzeDayContext(dateISO: string) {
    // Check cache or inflight requests to avoid redundant calls
    if (state.dailyDiagnoses[dateISO] || _analysisInFlight.has(dateISO)) {
        return _analysisInFlight.get(dateISO);
    }

    const task = async () => {
        let notes = ''; 
        const day = getHabitDailyInfoForDate(dateISO);
        // Collect all notes from the day
        Object.keys(day).forEach(id => Object.keys(day[id].instances).forEach(t => { 
            const n = day[id].instances[t as TimeOfDay]?.note; 
            if (n) notes += `- ${n}\n`; 
        }));
        
        // If no notes or offline, skip analysis
        if (!notes.trim() || !navigator.onLine) return;
        
        try {
            const promptPayload = { 
                notes, 
                themeList: t('aiThemeList'), 
                languageName: _getAiLang(), 
                translations: { 
                    aiPromptQuote: t('aiPromptQuote'), 
                    aiSystemInstructionQuote: t('aiSystemInstructionQuote') 
                } 
            };
            
            // Build prompt in worker to avoid main thread jank
            const { prompt, systemInstruction } = await runWorkerTask<any>('build-quote-analysis-prompt', promptPayload);

            const res = await apiFetch('/api/analyze', { 
                method: 'POST', 
                body: JSON.stringify({ prompt, systemInstruction }) 
            });
            
            const rawText = await res.text();
            const jsonStr = rawText.replace(/```json|```/g, '').trim();
            const json = JSON.parse(jsonStr);
            
            if (json?.analysis) { 
                state.dailyDiagnoses[dateISO] = { 
                    level: json.analysis.determined_level, 
                    themes: json.relevant_themes, 
                    timestamp: Date.now() 
                }; 
                saveState(); 
                
                // Dispatch event to notify listeners (e.g., renderStoicQuote) that data is ready.
                // This decouples the analysis from the UI update logic.
                document.dispatchEvent(new CustomEvent('quote-updated'));
            }
        } catch (e) { 
            console.error("Context analysis failed", e); 
        } finally { 
            _analysisInFlight.delete(dateISO); 
        }
    };
    
    const p = task(); 
    _analysisInFlight.set(dateISO, p); 
    return p;
}
