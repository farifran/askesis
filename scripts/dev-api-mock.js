
/**
 * @file scripts/dev-api-mock.js
 * @description Mock Serverless API handlers for local development.
 * Simulates the behavior of Vercel Edge Functions (/api/sync, /api/analyze).
 */

const fs = require('fs/promises');
const fsSync = require('fs');

const MOCK_DB_FILE = '.local-kv.json';

async function handleApiSync(req, res) {
    if (req.method === 'GET') {
        try {
            // Check for key hash header
            const keyHash = req.headers['x-sync-key-hash'];
            if (!keyHash) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Unauthorized' }));
            }

            if (!fsSync.existsSync(MOCK_DB_FILE)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end('null');
            }
            
            const db = JSON.parse(await fs.readFile(MOCK_DB_FILE, 'utf-8'));
            const userData = db[keyHash];
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(userData || null));
        } catch (e) {
            console.error('API Mock Error (GET /api/sync):', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    } else if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const keyHash = req.headers['x-sync-key-hash'];
                if (!keyHash) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Unauthorized' }));
                }

                const payload = JSON.parse(body);
                
                let db = {};
                if (fsSync.existsSync(MOCK_DB_FILE)) {
                    db = JSON.parse(await fs.readFile(MOCK_DB_FILE, 'utf-8'));
                }
                
                const existingData = db[keyHash];
                
                // Optimistic Locking Check
                if (existingData && payload.lastModified < existingData.lastModified) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(existingData));
                }
                
                if (existingData && payload.lastModified === existingData.lastModified) {
                    res.writeHead(304); // Not Modified
                    return res.end();
                }

                // Save
                db[keyHash] = payload;
                await fs.writeFile(MOCK_DB_FILE, JSON.stringify(db, null, 2));
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                console.error('API Mock Error (POST /api/sync):', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
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
    // Returns a generic positive message to prove integration works.
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
