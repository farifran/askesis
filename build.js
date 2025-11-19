// build.js
/**
 * ANÁLISE DO ARQUIVO: 100% concluído.
 * O que foi feito: O script de build foi aprimorado para incluir um servidor de desenvolvimento local.
 * Problema resolvido: O erro "Script origin does not match" ocorria porque não havia um servidor servindo a pasta 'public' como raiz.
 * Solução: Adicionado `ctx.serve({ servedir: outdir })`. Agora, ao rodar `npm run dev`, um servidor local é iniciado, garantindo que o Service Worker e o index.html compartilhem a mesma origem.
*/
// Este script é responsável por compilar e empacotar os arquivos da aplicação
// para produção. Ele utiliza 'esbuild' para uma compilação rápida e eficiente.
const esbuild = require('esbuild');
const fs = require('fs/promises'); // API de sistema de arquivos baseada em Promises do Node.js
const path = require('path'); // Módulo para lidar com caminhos de arquivo

const isProduction = process.env.NODE_ENV === 'production';
const outdir = 'public';

async function copyStaticFiles() {
    console.log('Copiando arquivos estáticos...');
    await fs.copyFile('index.html', path.join(outdir, 'index.html'));
    await fs.copyFile('manifest.json', path.join(outdir, 'manifest.json'));
    await fs.copyFile('sw.js', path.join(outdir, 'sw.js'));
    await fs.cp('icons', path.join(outdir, 'icons'), { recursive: true });
    await fs.cp('locales', path.join(outdir, 'locales'), { recursive: true });
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
        let debounceTimeout;
        fs.watch(p, { recursive: ['icons', 'locales'].includes(p) }, (eventType, filename) => {
            clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(() => {
                console.log(`Mudança detectada em '${p}/${filename || ''}'. Recopiando arquivos estáticos...`);
                copyStaticFiles().catch(err => console.error('Falha ao recopiar arquivos estáticos:', err));
            }, 100);
        });
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
        const esbuildOptions = {
            entryPoints: ['index.tsx'],
            bundle: true,
            outdir: outdir,
            entryNames: 'bundle',
            format: 'esm',
            platform: 'browser',
            minify: isProduction,
            sourcemap: !isProduction,
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
            // que index.html e sw.js sejam servidos da mesma raiz (ex: localhost:8000).
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
        }

    } catch (e) {
        // Em caso de falha, exibe o erro e encerra o processo com um código de erro.
        console.error('O build falhou:', e);
        process.exit(1);
    }
}

// Executa a função de build.
build();