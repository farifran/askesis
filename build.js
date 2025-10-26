// build.js
// Este script é responsável por compilar e empacotar os arquivos da aplicação
// para produção. Ele utiliza 'esbuild' para uma compilação rápida e eficiente.
const esbuild = require('esbuild');
const fs = require('fs/promises'); // API de sistema de arquivos baseada em Promises do Node.js
const path = require('path'); // Módulo para lidar com caminhos de arquivo

// Define o diretório de saída para os arquivos compilados.
// Este é o diretório que será servido em produção (ex: pelo Vercel).
const outdir = 'public';

async function build() {
    try {
        // --- 1. Limpeza e Preparação do Diretório de Saída ---
        // Garante que o diretório de saída esteja limpo antes de cada build.
        // Isso evita que arquivos antigos ou desnecessários permaneçam na versão final.
        console.log(`Cleaning output directory: ${outdir}...`);
        await fs.rm(outdir, { recursive: true, force: true });
        await fs.mkdir(outdir, { recursive: true });
        console.log('Output directory prepared.');

        // --- 2. Cópia de Arquivos Estáticos ---
        // Copia o arquivo HTML principal para o diretório de saída.
        console.log('Copying static assets...');
        await fs.copyFile('index.html', path.join(outdir, 'index.html'));

        // Copia o diretório de internacionalização (i18n) com os arquivos JSON de tradução.
        await fs.cp('locales', path.join(outdir, 'locales'), { recursive: true });
        console.log('Static assets copied.');

        // --- 3. Criação Dinâmica do Service Worker ---
        // Cria o Service Worker do OneSignal diretamente no diretório de saída.
        // Isso resolve problemas de build em plataformas como o Vercel, onde o arquivo
        // fonte pode não estar presente, garantindo que ele sempre exista na versão final.
        console.log('Creating OneSignal service worker (onesignal-sw.js)...');
        const oneSignalSWContent = "importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');";
        await fs.writeFile(path.join(outdir, 'onesignal-sw.js'), oneSignalSWContent);
        console.log('Service worker (onesignal-sw.js) created.');
        
        // --- 4. Compilação do Código TypeScript/CSS com esbuild ---
        // Este é o passo principal, onde o esbuild lê o ponto de entrada da aplicação,
        // resolve todas as importações (TS, TSX, CSS) e as empacota em arquivos otimizados.
        console.log('Building application with esbuild...');
        await esbuild.build({
            entryPoints: ['index.tsx'], // Ponto de entrada principal da aplicação.
            bundle: true,               // Habilita o empacotamento, juntando todos os módulos em um só arquivo.
            outdir: outdir,             // Diretório de saída para os arquivos gerados.
            entryNames: 'bundle',       // Define o nome base para os arquivos de saída (ex: bundle.js, bundle.css).
            format: 'esm',              // Formato de saída como Módulos ES, moderno e compatível com importações dinâmicas.
            platform: 'browser',        // Otimiza a saída para ser executada em navegadores.
            sourcemap: true,            // Gera source maps para facilitar a depuração em produção.
        });
        console.log('Application built successfully.');

        console.log('\nBuild successful!');
    } catch (e) {
        // Em caso de falha, exibe o erro e encerra o processo com um código de erro.
        // Isso é crucial para que os sistemas de CI/CD (como o Vercel) saibam que o build falhou.
        console.error('Build failed:', e);
        process.exit(1);
    }
}

// Executa a função de build.
build();