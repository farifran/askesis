#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FORBIDDEN_FILES = [
  'AUDIT_SMART_MERGE.md',
  'SMART_MERGE_SOLUTIONS.ts',
];

const violations = FORBIDDEN_FILES
  .map((rel) => ({ rel, abs: path.join(ROOT, rel) }))
  .filter((entry) => fs.existsSync(entry.abs));

if (violations.length > 0) {
  console.error('❌ Dead-files guardrail failed: arquivos removidos voltaram ao repositório.');
  violations.forEach((v) => console.error(` - ${v.rel}`));
  process.exit(1);
}

console.log('✅ Dead-files guardrail passed.');
