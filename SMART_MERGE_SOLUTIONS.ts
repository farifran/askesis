/**
 * @file SMART_MERGE_SOLUTIONS.ts
 * @description Implementações concretas das soluções para Smart Merge (audit)
 * 
 * Este arquivo contém exemplos de código para as 5 soluções propostas.
 * Destina-se a guiar a implementação na próxima refatoração.
 */

// ================================================================================
// SOLUÇÃO 1: FUZZY MATCHING (Levenshtein Distance)
// ================================================================================

/**
 * Calcula distância de Levenshtein entre duas strings.
 * Impede consolidação acidental de nomes muito diferentes.
 */
export function levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,      // deletion
                dp[i][j - 1] + 1,      // insertion
                dp[i - 1][j - 1] + cost // substitution
            );
        }
    }
    return dp[m][n];
}

/**
 * Valida se dois nomes de hábitos realmente representam o mesmo hábito.
 * Previne consolidação automática de nomes apenas similares.
 */
export function isSimilarHabitName(name1: string, name2: string, threshold = 2): boolean {
    const n1 = name1.trim().toLowerCase();
    const n2 = name2.trim().toLowerCase();

    // Caso 1: Match exato → definitivamente o mesmo
    if (n1 === n2) return true;

    // Caso 2: Muito curto → evitar colisão de genéricos como "Hábito", "Exercício"
    if (n1.length < 5 || n2.length < 5) return false;

    // Caso 3: Distância pequena (edição mínima)
    const distance = levenshteinDistance(n1, n2);
    return distance > 0 && distance <= threshold;
}

// ================================================================================
// SOLUÇÃO 2: VECTOR CLOCKS (CAUSAL ORDERING)
// ================================================================================

/**
 * Relógio Lamport simples: incrementa sequência local a cada evento.
 * Garante ordenação causal mesmo com mudanças de múltiplos clientes.
 */
export interface LamportTimestamp {
    clientId: string;
    sequence: number;
}

export function compareLamportTime(ts1: LamportTimestamp, ts2: LamportTimestamp): -1 | 0 | 1 {
    if (ts1.sequence < ts2.sequence) return -1;
    if (ts1.sequence > ts2.sequence) return 1;
    // Se sequência igual, usar clientId como tiebreaker (consistente)
    return ts1.clientId < ts2.clientId ? -1 : ts1.clientId > ts2.clientId ? 1 : 0;
}

/**
 * Incrementar Lamport clock após evento local.
 */
export function incrementLamportTime(current: LamportTimestamp): LamportTimestamp {
    return {
        ...current,
        sequence: current.sequence + 1
    };
}

/**
 * Sincronizar clocks na chegada de mensagem remota.
 */
export function syncLamportTime(local: LamportTimestamp, remote: LamportTimestamp): LamportTimestamp {
    return {
        ...local,
        sequence: Math.max(local.sequence, remote.sequence) + 1
    };
}

// ================================================================================
// SOLUÇÃO 3: AUDIT LOG DE MERGES
// ================================================================================

export interface MergeAuditLog {
    id: string;
    timestamp: number;
    clientA: string;
    clientB: string;
    habitsDedup: Array<{
        oldId: string;
        newId: string;
        oldName: string;
        newName: string;
        similarity: number;
        verified: boolean; // true se confirmado pelo usuário
    }>;
    dataLost?: Array<{
        habitId: string;
        date: string;
        reason: string;
    }>;
    status: 'success' | 'conflict' | 'rolled_back';
}

/**
 * Registra consolidações de hábitos para auditoria.
 * Permite detectar colisões intencionais ou bugs.
 */
export async function logMergeEvent(event: MergeAuditLog, dbName = 'askesis'): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);

        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(['mergeAuditLogs'], 'readwrite');
            const store = tx.objectStore('mergeAuditLogs');
            store.add(event);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        };

        request.onerror = () => reject(request.error);
    });
}

/**
 * Recuperar histórico de merges para análise.
 */
export async function getMergeHistory(limit = 100, dbName = 'askesis'): Promise<MergeAuditLog[]> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);

        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(['mergeAuditLogs'], 'readonly');
            const store = tx.objectStore('mergeAuditLogs');
            const results: MergeAuditLog[] = [];

            store.openCursor(null, 'prev').onsuccess = (event: any) => {
                const cursor = event.target.result;
                if (cursor && results.length < limit) {
                    results.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };

            tx.onerror = () => reject(tx.error);
        };

        request.onerror = () => reject(request.error);
    });
}

// ================================================================================
// SOLUÇÃO 4: CONFIRMAÇÃO EXPLÍCITA DE DEDUPLICAÇÃO
// ================================================================================

export interface PendingMergeConflict {
    winnerHabitId: string;
    winnerName: string;
    loserHabitId: string;
    loserName: string;
    similarity: number;
    reason: 'exact_match' | 'fuzzy_match' | 'name_collision';
    createdAt: number;
    status: 'pending' | 'confirmed' | 'rejected';
}

/**
 * Determina se deduplicação deve pedir confirmação.
 * Regras conservadoras: sempre confirmar se houver dúvida.
 */
export function shouldConfirmDedup(
    winner: { name: string; scheduleHistory: any[] },
    loser: { name: string; scheduleHistory: any[] },
    similarity: number
): boolean {
    // ❌ Nuncaconfirmar match exato normalizado
    if (similarity === 1.0) return false;

    // ✓ Sempre confirmar se fuzzy match
    if (similarity > 0 && similarity < 1.0) return true;

    // ✓ Confirmar se dados muito diferentes
    const scheduleHistoryDiff = Math.abs(
        winner.scheduleHistory.length - loser.scheduleHistory.length
    );
    if (scheduleHistoryDiff > 2) return true;

    return false;
}

/**
 * UI: Pedir confirmação de consolidação ao usuário.
 */
export function createDedupConfirmationUI(conflict: PendingMergeConflict): string {
    return `
    <div class="merge-conflict-modal" data-conflict-id="${conflict.winnerHabitId}">
        <h2>Consolidar Hábitos?</h2>
        <p>Sistema detectou dois hábitos possivelmente iguais:</p>
        
        <div class="conflict-pair">
            <div class="habit">
                <strong>Hábito A:</strong> "${conflict.winnerName}"
            </div>
            <div>➔ Similaridade: ${(conflict.similarity * 100).toFixed(0)}%</div>
            <div class="habit">
                <strong>Hábito B:</strong> "${conflict.loserName}"
            </div>
        </div>
        
        <p class="warning">
            ⚠️ Consolidação irá mesclar históricos. Isto é irreversível.
        </p>
        
        <button class="btn-confirm" data-action="merge">Consolidar</button>
        <button class="btn-cancel" data-action="keep_separate">Manter Separados</button>
    </div>
    `;
}

// ================================================================================
// SOLUÇÃO 5: HASH VALIDATION (CONTENT INTEGRITY)
// ================================================================================

/**
 * Calcula hash SHA-256 do conteúdo de um hábito.
 * Permite detectar se é realmente o mesmo hábito (semanticamente).
 */
export async function computeHabitContentHash(scheduleHistory: any[]): Promise<string> {
    const content = JSON.stringify(scheduleHistory);
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compara hashes para avaliar semelhança de conteúdo.
 * Hash idêntico = conteúdo idêntico (com ~100% certeza).
 */
export async function getContentSimilarity(hash1: string, hash2: string): Promise<number> {
    // Caso 1: Hash exato → 100% similares
    if (hash1 === hash2) return 1.0;

    // Caso 2: Hash diferente → 0% similares (simplificado)
    // Nota: Poderia usar Hamming distance para soft similarity
    return 0.0;
}

/**
 * Versão mais robusta: comparar Hamming distance dos hashes.
 * Detecta modificações menores automaticamente.
 */
export function hammingDistance(hash1: string, hash2: string): number {
    if (hash1.length !== hash2.length) return Math.max(hash1.length, hash2.length);

    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
        if (hash1[i] !== hash2[i]) distance++;
    }
    return distance;
}

export async function getContentSimilarityAdvanced(
    hash1: string,
    hash2: string,
    maxDifferentChars = 4 // Até 4 caracteres diferentes = ainda similares
): Promise<number> {
    if (hash1 === hash2) return 1.0;

    const distance = hammingDistance(hash1, hash2);
    const maxLength = Math.max(hash1.length, hash2.length);

    // Normalizar para 0-1
    return Math.max(0, 1 - distance / maxLength);
}

// ================================================================================
// SOLUÇÃO INTEGRADA: Novo mergeStates com validações
// ================================================================================

/**
 * Enhanced Habit type com content hash.
 */
export interface HabitEnhanced {
    id: string;
    createdOn: string;
    contentHash?: string; // ← Novo
    lamportTime?: LamportTimestamp; // ← Novo
    scheduleHistory: any[];
    // ... resto dos campos
}

/**
 * Versão melhorada de getHabitIdentity com fuzzy matching.
 */
export function getHabitIdentityEnhanced(h: HabitEnhanced): {
    identity: string | null;
    exactMatch: boolean;
} {
    if (!h.scheduleHistory || h.scheduleHistory.length === 0) {
        const deletedRaw = (h.deletedName || '').trim().toLowerCase();
        return {
            identity: deletedRaw.length > 0 ? deletedRaw : null,
            exactMatch: true
        };
    }

    const lastSchedule = h.scheduleHistory.reduce(
        (prev, curr) => (curr.startDate > prev.startDate ? curr : prev),
        h.scheduleHistory[0]
    );

    const raw = lastSchedule.name || lastSchedule.nameKey || '';
    const normalized = raw.trim().toLowerCase();

    return {
        identity: normalized.length > 0 ? normalized : null,
        exactMatch: true // ← Sempre é exato no nível de identidade
    };
}

/**
 * Função para validar se consolidação é segura ANTES de merging.
 */
export async function validateDedupSafety(
    winner: HabitEnhanced,
    loser: HabitEnhanced,
    auditLog: MergeAuditLog[]
): Promise<{
    isSafe: boolean;
    confidence: number;
    warning?: string;
}> {
    const checks = {
        exactNameMatch: winner.scheduleHistory[0]?.name === loser.scheduleHistory[0]?.name,
        similarName: isSimilarHabitName(
            winner.scheduleHistory[0]?.name || '',
            loser.scheduleHistory[0]?.name || '',
            2
        ),
        hashMatch: winner.contentHash === loser.contentHash,
        noPriorCollisions: !auditLog.some(log =>
            log.habitsDedup.some(d => d.oldId === winner.id || d.oldId === loser.id)
        )
    };

    const confidence = Object.values(checks).filter(Boolean).length / Object.keys(checks).length;

    return {
        isSafe: confidence >= 0.75 && (checks.exactNameMatch || checks.hashMatch),
        confidence,
        warning: confidence < 1.0 ? 'Consolidação requer confirmação' : undefined
    };
}

// ================================================================================
// TESTE INTEGRADO
// ================================================================================

/**
 * Exemplo de uso das soluções em conjunto.
 */
export async function demonstrateEnhancedMerge() {
    const winner: HabitEnhanced = {
        id: 'uuid-1',
        createdOn: '2024-01-01',
        scheduleHistory: [
            {
                name: 'Exercício',
                startDate: '2024-01-01',
                times: ['Morning']
                // ...
            }
        ]
    };

    const loser: HabitEnhanced = {
        id: 'uuid-2',
        createdOn: '2024-01-02',
        scheduleHistory: [
            {
                name: 'Exercício',
                startDate: '2024-01-02',
                times: ['Evening']
                // ...
            }
        ]
    };

    // 1. Calcular hashes
    winner.contentHash = await computeHabitContentHash(winner.scheduleHistory);
    loser.contentHash = await computeHabitContentHash(loser.scheduleHistory);

    // 2. Validar segurança
    const auditLog: MergeAuditLog[] = [];
    const safetyCheck = await validateDedupSafety(winner, loser, auditLog);

    console.log('Consolidação segura?', safetyCheck.isSafe);
    console.log('Confiança:', safetyCheck.confidence);

    // 3. Se seguro, prosseguir com merge e log
    if (safetyCheck.isSafe) {
        const mergeEvent: MergeAuditLog = {
            id: 'merge-001',
            timestamp: Date.now(),
            clientA: 'device-a',
            clientB: 'device-b',
            habitsDedup: [
                {
                    oldId: loser.id,
                    newId: winner.id,
                    oldName: loser.scheduleHistory[0].name,
                    newName: winner.scheduleHistory[0].name,
                    similarity: 1.0,
                    verified: true
                }
            ],
            status: 'success'
        };

        await logMergeEvent(mergeEvent);
    } else if (safetyCheck.warning) {
        // Pedir confirmação ao usuário
        const confirmationUI = createDedupConfirmationUI({
            winnerHabitId: winner.id,
            winnerName: winner.scheduleHistory[0].name,
            loserHabitId: loser.id,
            loserName: loser.scheduleHistory[0].name,
            similarity: safetyCheck.confidence,
            reason: 'fuzzy_match',
            createdAt: Date.now(),
            status: 'pending'
        });

        console.log(confirmationUI);
    }
}
