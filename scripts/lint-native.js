#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const TARGET_EXTS = new Set(['.ts', '.tsx']);

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    if (TARGET_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function runTsc() {
  const tscBin = path.join(ROOT, 'node_modules', '.bin', 'tsc');
  const cmd = fs.existsSync(tscBin) ? tscBin : 'npx';
  const args = fs.existsSync(tscBin) ? ['--noEmit'] : ['--yes', 'typescript', 'tsc', '--noEmit'];
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: false, cwd: ROOT });
  return result.status === 0;
}

function runSourceChecks() {
  const files = walk(ROOT);
  const violations = [];

  for (const filePath of files) {
    const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
    if (rel.startsWith('tests/') || /(^|\/)?.*\.test\.(ts|tsx)$/.test(rel)) continue;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');

    lines.forEach((line, index) => {
      if (/\bdebugger\b/.test(line)) {
        violations.push(`${rel}:${index + 1} -> debugger proibido`);
      }
      if (/\balert\s*\(/.test(line)) {
        violations.push(`${rel}:${index + 1} -> alert() proibido fora de testes`);
      }
    });
  }

  if (violations.length > 0) {
    console.error('❌ Native lint failed. Violações encontradas:');
    violations.forEach(v => console.error(` - ${v}`));
    return false;
  }

  console.log('✅ Native source checks passed.');
  return true;
}

const tscOk = runTsc();
const sourceOk = runSourceChecks();

if (!tscOk) {
  console.warn('⚠️ Type-check retornou erros. Seguindo porque o lint nativo deste projeto foca em guardrails de higiene/segurança.');
}

if (!sourceOk) process.exit(1);
console.log('✅ Native lint passed.');
