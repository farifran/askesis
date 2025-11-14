// ANÁLISE DO ARQUIVO: 0% concluído. Todos os arquivos precisam ser revisados. Quando um arquivo atingir 100%, não será mais necessário revisá-lo.
// build.js
// Este script é responsável por compilar e empacotar os arquivos da aplicação
// para produção. Ele utiliza 'esbuild' para uma compilação rápida e eficiente.
const esbuild = require('esbuild');
const fs = require('fs/promises'); // API de sistema de arquivos baseada em Promises do Node.js
const path = require('path'); // Módulo para lidar com caminhos de arquivo

// OTIMIZAÇÃO DE BUILD [2024-11-09]: Adicionado suporte para builds de produção.
// O script agora verifica a variável de ambiente `process.env.NODE_ENV`. Se for 'production',
// ele habilita a minificação e desativa os source maps, resultando em arquivos menores e mais
// performáticos para o usuário final, sem comprometer a depuração em desenvolvimento.
const isProduction = process.env.NODE_ENV === 'production';

// Define o diretório de saída para os arquivos compilados.
// Este é o diretório que será servido em produção (ex: pelo Vercel).
const outdir = 'public';

// OTIMIZAÇÃO DE DESENVOLVIMENTO [2024-11-11]: A função de cópia de arquivos estáticos foi
// extraída para ser reutilizada tanto no build inicial quanto no modo de observação, se necessário.
async function copyStaticFiles() {
    console.log('Copiando arquivos estáticos...');
    await fs.copyFile('index.html', path.join(outdir, 'index.html'));
    await fs.copyFile('manifest.json', path.join(outdir, 'manifest.json'));
    await fs.copyFile('sw.js', path.join(outdir, 'sw.js'));
    await fs.cp('icons', path.join(outdir, 'icons'), { recursive: true });
    await fs.cp('locales', path.join(outdir, 'locales'), { recursive: true });
    console.log('Arquivos estáticos copiados.');
}

async function build() {
    try {
        console.log(`Iniciando build de ${isProduction ? 'produção' : 'desenvolvimento'}...`);
        // --- 1. Limpeza e Preparação do Diretório de Saída ---
        console.log(`Limpando diretório de saída: ${outdir}...`);
        await fs.rm(outdir, { recursive: true, force: true });
        await fs.mkdir(outdir, { recursive: true });
        console.log('Diretório de saída preparado.');

        // --- 2. Cópia de Arquivos Estáticos ---
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
            // --- Build de Desenvolvimento: Modo de Observação (Watch) ---
            console.log('Configurando esbuild em modo de observação para desenvolvimento...');
            const ctx = await esbuild.context(esbuildOptions);
            await ctx.watch();
            console.log('Observação ativada. Compilando o build inicial...');
            console.log('Pronto! Observando por mudanças de arquivo. Pressione Ctrl+C para sair.');
        }

    } catch (e) {
        // Em caso de falha, exibe o erro e encerra o processo com um código de erro.
        console.error('O build falhou:', e);
        process.exit(1);
    }
}

// Executa a função de build.
build();