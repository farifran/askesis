const esbuild = require('esbuild');
const fs = require('fs/promises');
const path = require('path');

const outdir = 'public';

async function build() {
    try {
        // Ensure the output directory exists and is clean
        await fs.rm(outdir, { recursive: true, force: true });
        await fs.mkdir(outdir, { recursive: true });

        // Copy static HTML file, which will be served alongside the bundles
        await fs.copyFile('index.html', path.join(outdir, 'index.html'));
        await fs.copyFile('service-worker.js', path.join(outdir, 'service-worker.js'));


        // Copy the new locales directory for i18n JSON files
        await fs.cp('locales', path.join(outdir, 'locales'), { recursive: true });
        
        // Build the TypeScript/React code and CSS.
        // esbuild will automatically handle the CSS import from index.tsx 
        // and create a separate CSS bundle.
        await esbuild.build({
            entryPoints: ['index.tsx'],
            bundle: true,
            outdir: outdir,
            entryNames: 'bundle', // Creates public/bundle.js and public/bundle.css
            format: 'esm',
            platform: 'browser',
            sourcemap: true,
        });

        console.log('Build successful!');
    } catch (e) {
        console.error('Build failed:', e);
        process.exit(1);
    }
}

build();