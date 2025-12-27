
// build.js
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file build.js
 * @description Script de orquestração de build e servidor de desenvolvimento (DevServer).
 * 
 * [BUILD ENVIRONMENT / NODE.JS CONTEXT]:
 * Este código roda no ambiente Node.js (Local ou CI/CD), NÃO no navegador.
 * 
 * RESPONSABILIDADE:
 * 1. Compilação TypeScript -> JavaScript (ESM) usando esbuild.
 * 2. Gestão de Assets Estáticos (HTML, CSS, JSON, SVG).
 * 3. Versionamento Automático do Service Worker (Cache Busting).
 * 4. Servidor de Desenvolvimento com suporte a SPA, Live Reload, Streams e API Mock.
 * 
 * ARQUITETURA CRÍTICA:
 * - Zero-Dependency Live Reload: Usa Server-Sent Events (SSE) nativos para refresh automático.
 * - Streaming I/O: Serve arquivos via pipe() para consumo constante de memória O(1).
 * - Multi-Entry Bundling: Separa 'bundle' (UI Main Thread) e 'sync-worker' (Worker Thread).
 */

const esbuild = require('esbuild');
const fs = require('fs/promises'); // API Async para operações de arquivo atômicas
const fsSync = require('fs'); // API Sync/Stream para Watchers e Servidor
const path = require('path'); 
const http = require('http');
const { handleApiSync, handleApiAnalyze } = require('./scripts/dev-api-mock.js');

const isProduction = process.env.NODE_ENV === 'production';
const outdir = 'public';

// --- LIVE RELOAD SYSTEM (SSE) ---
// Mantém referência a todos os clientes (abas abertas) para notificar mudanças.
const reloadClients = new Set();

function notifyLiveReload() {
    if (reloadClients.size === 0) return;
    console.log('🔄 Enviando sinal de Live Reload...');
    // O formato 'data: ...\n\n' é o protocolo padrão de SSE
    reloadClients.forEach(res => res.write('data: reload\n\n'));
}

// --- SHARED BUILD LOGIC ---

async function copyStaticFiles() {
    console.log('Copiando arquivos estáticos...');
    await fs.copyFile('index.html', path.join(outdir, 'index.html'));
    await fs.copyFile('manifest.json', path.join(outdir, 'manifest.json'));
    
    // Versionamento Dinâmico do Service Worker
    try {
        const swContent = await fs.readFile('sw.js', 'utf-8');
        const versionRegex = /const\s+CACHE_NAME\s*=\s*['"][^'"]+['"];/;
        
        if (versionRegex.test(swContent)) {
            const versionedSw = swContent.replace(
                versionRegex, 
                `const CACHE_NAME = 'habit-tracker-v${Date.now()}';`
            );
            await fs.writeFile(path.join(outdir, 'sw.js'), versionedSw);
        } else {
            console.warn('⚠️ AVISO: Padrão CACHE_NAME não encontrado em sw.js. O versionamento automático falhou.');
            await fs.copyFile('sw.js', path.join(outdir, 'sw.js'));
        }
    } catch (e) {
        console.error('Erro ao processar sw.js:', e);
        await fs.copyFile('sw.js', path.join(outdir, 'sw.js'));
    }

    try {
        await fs.cp('icons', path.join(outdir, 'icons'), { recursive: true });
        await fs.cp('locales', path.join(outdir, 'locales'), { recursive: true });
    } catch (err) {
        console.warn('Aviso ao copiar diretórios de assets:', err.message);
    }
    
    console.log('Arquivos estáticos copiados.');
}

const esbuildOptions = {
    entryPoints: {
        'bundle': 'index.tsx',
        'sync-worker': 'services/sync.worker.ts'
    },
    bundle: true,
    outdir: outdir,
    entryNames: '[name]',
    format: 'esm',
    target: 'es2020', // Alinhado com tsconfig para compatibilidade
    platform: 'browser',
    minify: isProduction,
    sourcemap: !isProduction,
    define: { 
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development') 
    }
};

// --- PRODUCTION BUILD LOGIC ---

async function buildProduction() {
    console.log('Compilando aplicação para produção...');
    await esbuild.build(esbuildOptions);
    console.log(`\nBuild de produção concluído!`);
}

// --- DEVELOPMENT SERVER LOGIC ---

function watchStaticFiles() {
    const pathsToWatch = ['index.html', 'manifest.json', 'sw.js', 'icons', 'locales'];
    console.log('Observando arquivos estáticos para mudanças...');

    let changedFiles = new Set();
    let debounceTimeout;

    const processChanges = async () => {
        if (changedFiles.size === 0) return;
        
        const filesToProcess = [...changedFiles];
        changedFiles.clear();

        console.log(`Sincronizando ${filesToProcess.length} arquivo(s) estático(s)...`);

        for (const file of filesToProcess) {
            const destPath = path.join(outdir, path.relative('.', file));
            
            try {
                // Handle deletion
                if (!fsSync.existsSync(file)) {
                    if (fsSync.existsSync(destPath)) {
                        await fs.rm(destPath, { recursive: true, force: true });
                        console.log(` - Deletado: ${destPath}`);
                    }
                    continue;
                }
                
                // Handle copy/update
                const stats = await fs.stat(file);
                if (stats.isDirectory()) {
                    await fs.mkdir(destPath, { recursive: true });
                } else {
                    await fs.mkdir(path.dirname(destPath), { recursive: true });

                    // Isolate sw.js versioning logic
                    if (path.basename(file) === 'sw.js') {
                        const swContent = await fs.readFile(file, 'utf-8');
                        const versionRegex = /const\s+CACHE_NAME\s*=\s*['"][^'"]+['"];/;
                        const versionedSw = swContent.replace(
                            versionRegex, 
                            `const CACHE_NAME = 'habit-tracker-v${Date.now()}';`
                        );
                        await fs.writeFile(destPath, versionedSw);
                    } else {
                        await fs.copyFile(file, destPath);
                    }
                }
                console.log(` - Atualizado: ${file}`);
            } catch (err) {
                 console.error(` - Falha ao processar ${file}:`, err);
            }
        }
        // Dispara o reload APÓS copiar os arquivos
        notifyLiveReload();
    };

    pathsToWatch.forEach(p => {
        if (!fsSync.existsSync(p)) return;

        // OPTIMIZATION: Determina se é diretório UMA VEZ na inicialização.
        // Evita chamadas fs.statSync dentro do callback que falhariam se o arquivo fosse deletado.
        const isDir = fsSync.statSync(p).isDirectory();

        fsSync.watch(p, { recursive: ['icons', 'locales'].includes(p) }, (eventType, filename) => {
            let sourcePath = p;
            
            // Se for diretório e temos um filename, o caminho mudou é sub-arquivo
            if (isDir && filename) {
                sourcePath = path.join(p, filename);
            }
            // Se não for diretório (ex: index.html), o sourcePath é o próprio p.
            
            changedFiles.add(sourcePath);

            if (debounceTimeout) clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(processChanges, 100);
        });
    });
}

const watchLoggerPlugin = {
    name: 'watch-logger',
    setup(build) {
        let startTime;
        build.onStart(() => {
            startTime = Date.now();
            console.log('Iniciando reconstrução do código-fonte...');
        });
        build.onEnd(result => {
            const duration = Date.now() - startTime;
            if (result.errors.length > 0) {
                console.error(`Reconstrução falhou após ${duration}ms.`);
            } else {
                console.log(`✅ Reconstrução do código-fonte concluída em ${duration}ms.`);
                // Dispara reload APÓS o esbuild terminar com sucesso
                notifyLiveReload();
            }
        });
    },
};

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.map': 'application/json', // Source maps
    '.woff2': 'font/woff2',
};

// Client-side script para Live Reload.
// Injetado automaticamente no index.html servido.
const LIVE_RELOAD_SCRIPT = `
<script>
  (function() {
    console.log('🔌 Live Reload conectado');
    const source = new EventSource('/_reload');
    source.onmessage = () => {
        console.log('🔄 Recarregando...');
        location.reload();
    };
    source.onerror = () => {
        // Se o servidor cair, tenta reconectar silenciosamente
        console.log('🔌 Live Reload desconectado. Tentando reconectar...');
    };
  })();
</script>
</body>`;

async function startDevServer() {
    esbuildOptions.plugins = [watchLoggerPlugin];
    const ctx = await esbuild.context(esbuildOptions);
    await ctx.watch();

    const devServer = http.createServer(async (req, res) => {
        // PERFORMANCE: Headers para prevenir cache agressivo do navegador em ambiente DEV.
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Access-Control-Allow-Origin', '*'); 

        // 1. Live Reload Endpoint (SSE)
        if (req.url === '/_reload') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });
            reloadClients.add(res);
            // Cleanup on client disconnect
            req.on('close', () => reloadClients.delete(res));
            return;
        }

        // 2. API Mocking
        if (req.url.startsWith('/api/sync')) {
            return handleApiSync(req, res);
        }
        if (req.url.startsWith('/api/analyze')) {
            return handleApiAnalyze(req, res);
        }

        // 3. Static File Serving
        let url = req.url.split('?')[0]; 
        if (url === '/') url = '/index.html';
        
        let filePath = path.join(outdir, url);
        let extname = String(path.extname(filePath)).toLowerCase();
        
        const contentType = mimeTypes[extname] || 'application/octet-stream';

        try {
            // Verifica existência
            await fs.access(filePath);

            // SPECIAL HANDLING: Index.html Injection
            // Lemos o HTML para memória para injetar o script de reload antes de enviar
            if (url === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                let html = await fs.readFile(filePath, 'utf-8');
                // Injeta antes do fechamento do body
                html = html.replace('</body>', LIVE_RELOAD_SCRIPT);
                res.end(html);
                return;
            }

            // OPTIMIZATION: Streaming para outros arquivos (JS, CSS, Imagens)
            // Mantém consumo de RAM baixo (O(1)) mesmo servindo bundles grandes.
            res.writeHead(200, { 'Content-Type': contentType });
            const stream = fsSync.createReadStream(filePath);
            stream.pipe(res);

        } catch (error) {
            if (error.code === 'ENOENT') {
                // SPA Fallback -> index.html (com injeção)
                // Se a rota não existe como arquivo, serve o index.html para o router do cliente
                try {
                    const fallbackPath = path.join(outdir, 'index.html');
                    await fs.access(fallbackPath);
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    let html = await fs.readFile(fallbackPath, 'utf-8');
                    html = html.replace('</body>', LIVE_RELOAD_SCRIPT);
                    res.end(html);
                } catch (fallbackError) {
                    res.writeHead(404);
                    res.end(`Not Found: ${url}`);
                }
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${error.code}`);
            }
        }
    });

    const DEV_PORT = 8000;
    devServer.listen(DEV_PORT, () => {
        console.log(`\n🚀 Servidor Dev iniciado em http://localhost:${DEV_PORT}`);
        console.log(`✨ API Mock ativa em /api/*`);
        console.log(`🔌 Live Reload ativo`);
        watchStaticFiles();
    });

    const handleExit = async () => {
        console.log('\nEncerrando...');
        // Fecha conexões SSE graciosamente para evitar erros no browser
        reloadClients.forEach(res => res.end());
        devServer.close();
        await ctx.dispose();
        process.exit(0);
    };
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
}

// --- MAIN ORCHESTRATOR ---

async function runBuild() {
    try {
        console.log(`Iniciando build de ${isProduction ? 'produção' : 'desenvolvimento'}...`);
        console.log(`Limpando diretório de saída: ${outdir}...`);
        await fs.rm(outdir, { recursive: true, force: true });
        await fs.mkdir(outdir, { recursive: true });
        
        await copyStaticFiles();
        
        if (isProduction) {
            await buildProduction();
        } else {
            await startDevServer();
        }

    } catch (e) {
        console.error('O build falhou:', e);
        process.exit(1);
    }
}

runBuild();
