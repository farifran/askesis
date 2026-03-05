#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git']);
const INCLUDE_EXTENSIONS = new Set(['.ts', '.tsx']);
const EXCLUDE_FILE_SUFFIXES = ['.test.ts', '.test.tsx'];
const EXCLUDE_PATH_PARTS = ['/tests/'];
const DEFAULT_MAX_LINES = 400;

// Temporary exceptions for known large modules under refactor.
// Keep this list small and reduce values over time.
const EXCEPTION_MAX_LINES = {
  'services/habitActions.ts': 1300,
  'services/dataMerge.ts': 900,
  'i18n.ts': 700,
  'state.ts': 700,
  'listeners/modals.ts': 700,
  'utils.ts': 700,
  'render/chart.ts': 700,
  'services/selectors.ts': 700,
  'render.ts': 700,
  'services/cloud.ts': 700,
  'services/migration.ts': 700,
  'render/habits.ts': 700,
  'index.tsx': 700,
  'render/calendar.ts': 700,
};

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(fullPath, out);
      continue;
    }

    const ext = path.extname(entry.name);
    if (!INCLUDE_EXTENSIONS.has(ext)) continue;

    const normalized = fullPath.replace(/\\/g, '/');
    if (EXCLUDE_PATH_PARTS.some((segment) => normalized.includes(segment))) continue;
    if (EXCLUDE_FILE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) continue;

    out.push(fullPath);
  }
  return out;
}

function countLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').length;
}

const files = walk(ROOT);
const violations = [];

for (const abs of files) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const maxAllowed = EXCEPTION_MAX_LINES[rel] || DEFAULT_MAX_LINES;
  const lines = countLines(abs);

  if (lines > maxAllowed) {
    violations.push({ rel, lines, maxAllowed });
  }
}

if (violations.length > 0) {
  console.error('File-size guardrail failed: some files exceed allowed line limits.');
  violations
    .sort((a, b) => b.lines - a.lines)
    .forEach((v) => {
      console.error(` - ${v.rel}: ${v.lines} lines (max ${v.maxAllowed})`);
    });
  process.exit(1);
}

console.log('File-size guardrail passed.');
