
/**
 * @file scripts/dev-api-mock.js
 * @description Mock Serverless API handlers for local development.
 * Simulates the behavior of Vercel Edge Functions (/api/sync, /api/analyze).
 * 
 * [SECURITY AUDIT]:
 * - Added Payload Size Limit (DoS Protection).
 * - Added Mutex for Atomic File I/O (Race Condition Protection).
 * - Added JSON Corruption Auto-healing.
 * - [REFACTOR] Pure Async I/O (No fsSync).
 */

const fs = require('fs/promises');

const MOCK_DB_FILE = '.local-kv.json';
const MAX_PAYLOAD_SIZE = 4 * 1024 * 1024; // 4MB Hard Limit

// --- MUTEX INFRASTRUCTURE ---
// Garante que apenas uma operação de leitura/escrita no arquivo ocorra por vez.
let dbMutex = Promise.resolve();

/**
 * Executa uma operação no DB com garantia de exclusividade (Atomicidade).
 * @param {Function} operation Função assíncrona que recebe o objeto db e retorna o novo estado (ou null para não salvar).
 */
async function withDbAtomic(operation) {
    const previousMutex = dbMutex;
    let releaseLock;
    
    // Cria o próximo bloqueio na cadeia
    dbMutex = new Promise(resolve => releaseLock = resolve);
    
    await previousMutex; // Espera a operação anterior terminar
    
    try {
        let db = {};
        
        // 1. Safe Read (Pure Async)
        try {
            const content = await fs.readFile(MOCK_DB_FILE, 'utf-8');
            if (content.trim()) {
                db = JSON.parse(content);
            }
        } catch (readError) {
            // Ignora erro se o arquivo ainda não existe (ENOENT).
            // Para outros erros (ex: JSON corrompido), loga e reseta o DB (Auto-healing).
            if (readError.code !== 'ENOENT') {
                console.error("⚠️ [MOCK DB] Erro de Leitura/Corrupção. Resetando DB.", readError.message);
            }
        }

        // 2. Operation
        const result = await operation(db);

        // 3. Safe Write (apenas se a operação retornou o objeto DB modificado)
        if (result && typeof result === 'object') {
            await fs.writeFile(MOCK_DB_FILE, JSON.stringify(result, null, 2));
        }
        
        return result;
    } catch (err) {
        console.error("⚠️ [MOCK DB] Critical I/O Error:", err);
        throw err;
    } finally {
        releaseLock(); // Libera para o próximo da fila
    }
}

async function handleApiSync(req, res) {
    if (req.method === 'GET') {
        try {
            const keyHash = req.headers['x-sync-key-hash'];
            if (!keyHash) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Unauthorized' }));
            }

            // Atomic Read
            await withDbAtomic(async (db) => {
                const userData = db[keyHash];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(userData || null));
                return null; // Não salvar nada
            });

        } catch (e) {
            console.error('API Mock Error (GET /api/sync):', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    } else if (req.method === 'POST') {
        let body = '';
        let size = 0;
        let aborted = false;

        req.on('data', chunk => {
            if (aborted) return;
            
            size += chunk.length;
            if (size > MAX_PAYLOAD_SIZE) {
                aborted = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload Too Large' }));
                req.destroy(); // Corta a conexão
                return;
            }
            body += chunk.toString();
        });

        req.on('end', async () => {
            if (aborted) return;

            try {
                const keyHash = req.headers['x-sync-key-hash'];
                if (!keyHash) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Unauthorized' }));
                }

                let payload;
                try {
                    payload = JSON.parse(body);
                } catch (jsonErr) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
                
                // Atomic Read-Modify-Write
                await withDbAtomic(async (db) => {
                    const existingData = db[keyHash];
                    
                    // Optimistic Locking Check (Business Logic)
                    if (existingData && payload.lastModified < existingData.lastModified) {
                        res.writeHead(409, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(existingData));
                        return null; // Conflito: não salvar
                    }
                    
                    if (existingData && payload.lastModified === existingData.lastModified) {
                        res.writeHead(304); // Not Modified
                        res.end();
                        return null; // Idempotente: não salvar
                    }

                    // Update State
                    db[keyHash] = payload;
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                    
                    return db; // Retorna DB para disparar o Write
                });

            } catch (e) {
                if (!res.headersSent) {
                    console.error('API Mock Error (POST /api/sync):', e);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
    } else {
        res.writeHead(405);
        res.end();
    }
}

async function handleApiAnalyze(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
    }
    
    // Mock response for local development (no API Key required)
    const mockResponse = "### Análise Local (Modo Desenvolvimento)\n\n**Estoicismo Simulado:**\n\nVocê está indo bem! A consistência é a chave. Continue praticando seus hábitos diários. Lembre-se: não é o que acontece com você, mas como você reage a isso.";
    
    // Simulate latency
    setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(mockResponse);
    }, 1500);
}

module.exports = {
    handleApiSync,
    handleApiAnalyze
};
