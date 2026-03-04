#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const args = ['.', '--ext', '.ts,.tsx'];

const localEslint = path.resolve(__dirname, '..', 'node_modules', '.bin', 'eslint');

const run = (cmd, cmdArgs) => spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: false });

let result = run(localEslint, args);

if (result.error && result.error.code === 'ENOENT') {
  console.warn('⚠️ ESLint local não encontrado. Tentando via npm exec...');
  result = run('npm', ['exec', '--yes', 'eslint', '--', ...args]);
}

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
