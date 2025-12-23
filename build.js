
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
 * 4. Servidor de Desenvolvimento com suporte a SPA e Service Workers.
 * 
 * ARQUITETURA CRÍTICA:
 * - Multi-Entry Bundling: Separa 'bundle' (UI Main Thread) e 'sync-worker' (Worker Thread).
 *   Isso é obrigatório para que o `new Worker('./sync-worker.js')` funcione no browser.
 * - Injection: Define variáveis de ambiente (NODE_ENV) em tempo de build.
 */

const esbuild = require('esbuild');
const fs = require('fs/promises'); // API de sistema de arquivos baseada em Promises
const fsSync = require('fs'); // [2025-02-23] API síncrona para watch e checks rápidos
const path = require('path'); 

const isProduction = process.env.NODE_ENV === 'production';
const outdir = 'public';

async function copyStaticFiles() {
    console.log('Copiando arquivos estáticos...');
    await fs.copyFile('index.html', path.join(outdir, 'index.html'));
    await fs.copyFile('manifest.json', path.join(outdir, 'manifest.json'));
    
    // Versionamento Dinâmico do Service Worker
    // Lê o sw.js original e injeta um timestamp no CACHE_NAME para forçar a atualização do cache no navegador.
    try {
        const swContent = await fs.readFile('sw.js', 'utf-8');
        
        // CRITICAL LOGIC [CACHE BUSTING]:
        // DO NOT REFACTOR: Esta Regex depende estritamente da sintaxe `const CACHE_NAME = '...'` no sw.js.
        // Qualquer alteração de formatação no sw.js pode quebrar essa injeção, impedindo a atualização do PWA.
        const versionRegex = /const\s+CACHE_NAME\s*=\s*['"][^'"]+['"];/;
        
        if (versionRegex.test(swContent)) {
            const versionedSw = swContent.replace(
                versionRegex, 
                `const CACHE_NAME = 'habit-tracker-v${Date.now()}';`
            );
            await fs.writeFile(path.join(outdir, 'sw.js'), versionedSw);
        } else {
            // [2025-02-23] ROBUSTEZ: Alerta se o padrão de cache não for encontrado, evitando cache estagnado silencioso.
            console.warn('⚠️ AVISO: Padrão CACHE_NAME não encontrado em sw.js. O versionamento automático falhou.');
            await fs.copyFile('sw.js', path.join(outdir, 'sw.js'));
        }
    } catch (e) {
        console.error('Erro ao processar sw.js:', e);
        // Fallback para cópia simples em caso de erro de leitura/escrita
        await fs.copyFile('sw.js', path.join(outdir, 'sw.js'));
    }

    // Copia diretórios recursivamente se existirem
    try {
        await fs.cp('icons', path.join(outdir, 'icons'), { recursive: true });
        await fs.cp('locales', path.join(outdir, 'locales'), { recursive: true });
    } catch (err) {
        console.warn('Aviso ao copiar diretórios de assets:', err.message);
    }
    
    console.log('Arquivos estáticos copiados.');
}

/**
 * MELHORIA DE DX [2024-12-23]: Adiciona um watcher para arquivos estáticos no modo de desenvolvimento.
 * Isso garante que mudanças em arquivos como index.html ou assets sejam automaticamente
 * copiadas para o diretório de saída sem a necessidade de reiniciar o servidor.
 */
function watchStaticFiles() {
    const pathsToWatch = [
        'index.html',
        'manifest.json',
        'sw.js',
        'icons',
        'locales'
    ];

    console.log('Observando arquivos estáticos para mudanças...');

    pathsToWatch.forEach(p => {
        // [2025-02-23] ROBUSTEZ: Verifica existência antes de assistir para evitar crash imediato.
        if (!fsSync.existsSync(p)) {
            return;
        }

        // PERFORMANCE: Debounce para evitar múltiplas cópias em salvamentos rápidos ou eventos duplicados do SO.
        let debounceTimeout;
        try {
            fsSync.watch(p, { recursive: ['icons', 'locales'].includes(p) }, (eventType, filename) => {
                if (debounceTimeout) clearTimeout(debounceTimeout);
                debounceTimeout = setTimeout(() => {
                    console.log(`Mudança detectada em '${p}${filename ? '/' + filename : ''}'. Recopiando arquivos estáticos...`);
                    copyStaticFiles().catch(err => console.error('Falha ao recopiar arquivos estáticos:', err));
                }, 100); // Debounce de 100ms
            });
        } catch (err) {
            console.warn(`Aviso: Não foi possível iniciar watch para ${p}.`, err.message);
        }
    });
}

// MELHORIA DE DX [2024-12-24]: Plugin customizado para esbuild que fornece feedback detalhado
// sobre o processo de reconstrução no modo de desenvolvimento.
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


async function build() {
    try {
        console.log(`Iniciando build de ${isProduction ? 'produção' : 'desenvolvimento'}...`);
        // --- 1. Limpeza e Preparação do Diretório de Saída ---
        console.log(`Limpando diretório de saída: ${outdir}...`);
        await fs.rm(outdir, { recursive: true, force: true });
        await fs.mkdir(outdir, { recursive: true });
        console.log('Diretório de saída preparado.');

        // --- 2. Cópia Inicial de Arquivos Estáticos ---
        // CRÍTICO: Deve ocorrer antes de iniciar o servidor ou watch.
        // Garante que sw.js exista quando o navegador o solicitar.
        await copyStaticFiles();

        // --- 3. Compilação do Código TypeScript/CSS com esbuild ---
        // ARQUITETURA [2025-02-28]: Configuração multi-entry para suportar Web Worker.
        // 'bundle': A aplicação principal (Main Thread).
        // 'sync-worker': O script do worker isolado (Worker Thread).
        // DO NOT REFACTOR: Unificar esses entryPoints quebrará o carregamento do Worker.
        // NOTA: 'splitting' foi removido para evitar a criação de chunks compartilhados dinâmicos
        // que não seriam cacheados pelo SW estático, garantindo robustez Offline-First.
        const esbuildOptions = {
            entryPoints: {
                'bundle': 'index.tsx',
                'sync-worker': 'services/sync.worker.ts'
            },
            bundle: true,
            outdir: outdir,
            entryNames: '[name]', // Usa a chave do objeto entryPoints como nome do arquivo
            format: 'esm', // Formato de módulo para suportar import/export nativo
            platform: 'browser',
            minify: isProduction,
            sourcemap: !isProduction,
            // CRÍTICO [2025-02-28]: Substitui process.env.NODE_ENV por string literal no tempo de build.
            // Isso previne erros "process is not defined" no navegador ao usar bibliotecas ou código condicional.
            define: { 
                'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development') 
            }
        };
        
        if (isProduction) {
            // --- Build de Produção: Execução única e otimizada ---
            console.log('Compilando aplicação para produção com esbuild...');
            await esbuild.build(esbuildOptions);
            console.log('Aplicação compilada com sucesso.');
            console.log(`\nBuild de produção concluído com sucesso!`);
        } else {
            // --- Build de Desenvolvimento: Modo de Observação (Watch) e Servidor ---
            // Adiciona o plugin de logging apenas no modo de desenvolvimento
            esbuildOptions.plugins = [watchLoggerPlugin];
            
            console.log('Configurando esbuild em modo de observação para desenvolvimento...');
            const ctx = await esbuild.context(esbuildOptions);
            
            // Ativa o watch mode
            await ctx.watch();
            console.log('Observação do código-fonte ativada.');

            // CORREÇÃO CRÍTICA: Inicia um servidor local servindo a pasta 'public'.
            // Isso resolve o erro "ServiceWorker script origin does not match" garantindo
            // que index.html e sw.js sejam servidos da mesma raiz.
            const { host, port } = await ctx.serve({
                servedir: outdir,
                port: 8000, // Porta preferencial, fará fallback se ocupada
                fallback: 'index.html' // Útil para SPA routing
            });

            // Inicia o monitoramento de arquivos estáticos para recópia automática.
            watchStaticFiles();

            console.log(`\n🚀 Servidor de desenvolvimento iniciado!`);
            console.log(`👉 Abra no navegador: http://localhost:${port}`);
            console.log('Pressione Ctrl+C para sair.');

            // [2025-01-15] ROBUSTEZ: Implementação de encerramento gracioso (Graceful Shutdown).
            const handleExit = async () => {
                console.log('\nEncerrando servidor de desenvolvimento...');
                try {
                    await ctx.dispose();
                } catch (err) {
                    console.error('Erro ao descartar contexto do esbuild:', err);
                }
                process.exit(0);
            };

            process.on('SIGINT', handleExit);
            process.on('SIGTERM', handleExit);
        }

    } catch (e) {
        // Em caso de falha, exibe o erro e encerra o processo com um código de erro.
        console.error('O build falhou:', e);
        process.exit(1);
    }
}

// Executa a função de build.
build();
