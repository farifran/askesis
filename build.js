
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
 * 4. Servidor de Desenvolvimento com suporte a SPA, Service Workers E Mock de API Serverless.
 * 
 * ARQUITETURA CRÍTICA:
 * - Multi-Entry Bundling: Separa 'bundle' (UI Main Thread) e 'sync-worker' (Worker Thread).
 * - Injection: Define variáveis de ambiente (NODE_ENV) em tempo de build.
 * - API Proxy/Mock: Intercepta requisições /api/ localmente para simular Vercel Functions.
 */

const esbuild = require('esbuild');
const fs = require('fs/promises'); // API de sistema de arquivos baseada em Promises
const fsSync = require('fs'); // [2025-02-23] API síncrona para watch e checks rápidos
const path = require('path'); 
const http = require('http');
const { handleApiSync, handleApiAnalyze } = require('./scripts/dev-api-mock.js');

const isProduction = process.env.NODE_ENV === 'production';
const outdir = 'public';

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
                     if (fsSync.statSync(file).isDirectory()) {
                        await fs.cp(file, destPath, { recursive: true });
                    } else {
                        await fs.copyFile(file, destPath);
                    }
                }
                console.log(` - Atualizado: ${file}`);
            } catch (err) {
                 console.error(` - Falha ao processar ${file}:`, err);
            }
        }
    };

    pathsToWatch.forEach(p => {
        if (!fsSync.existsSync(p)) return;

        fsSync.watch(p, { recursive: ['icons', 'locales'].includes(p) }, (eventType, filename) => {
            if (!filename) return;

            let sourcePath;
            try {
                 const stats = fsSync.statSync(p);
                if (stats.isDirectory()) {
                    sourcePath = path.join(p, filename);
                } else {
                    sourcePath = p;
                }
            } catch (e) {
                sourcePath = path.join(p, filename);
            }
            
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
};

async function startDevServer() {
    esbuildOptions.plugins = [watchLoggerPlugin];
    const ctx = await esbuild.context(esbuildOptions);
    await ctx.watch();

    const devServer = http.createServer(async (req, res) => {
        // API Mocking
        if (req.url.startsWith('/api/sync')) {
            return handleApiSync(req, res);
        }
        if (req.url.startsWith('/api/analyze')) {
            return handleApiAnalyze(req, res);
        }

        // Static File Serving
        const url = req.url === '/' ? '/index.html' : req.url;
        const filePath = path.join(outdir, url);
        const extname = String(path.extname(filePath)).toLowerCase();
        const contentType = mimeTypes[extname] || 'application/octet-stream';

        try {
            const content = await fs.readFile(filePath);
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                // SPA Fallback to index.html
                try {
                    const content = await fs.readFile(path.join(outdir, 'index.html'));
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(content, 'utf-8');
                } catch (fallbackError) {
                    res.writeHead(500);
                    res.end(`Sorry, check with the site admin for error: ${fallbackError.code} ..\n`);
                }
            } else {
                res.writeHead(500);
                res.end(`Sorry, check with the site admin for error: ${error.code} ..\n`);
            }
        }
    });

    const DEV_PORT = 8000;
    devServer.listen(DEV_PORT, () => {
        console.log(`\n🚀 Servidor Dev iniciado em http://localhost:${DEV_PORT}`);
        console.log(`✨ API Mock ativa em /api/*`);
        watchStaticFiles();
    });

    const handleExit = async () => {
        console.log('\nEncerrando...');
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
