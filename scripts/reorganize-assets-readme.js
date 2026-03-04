#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const README_PATH = path.join(ROOT, 'README.md');

const moves = [
  // Hero / idioma
  ['assets/AristotelesPortugues.jpg', 'assets/hero/pt/aristotle-pt.jpg'],
  ['assets/AristotelesIngles.jpg', 'assets/hero/en/aristotle-en.jpg'],
  ['assets/AristotelesEspanol.jpg', 'assets/hero/es/aristotle-es.jpg'],

  // Diagramas por idioma
  ['assets/diagram/system-architecture-flow-pt.png', 'assets/diagram/pt/architecture-user-flow.png'],
  ['assets/diagram/system-integrations-pt.png', 'assets/diagram/pt/integrations-infrastructure.png'],
  ['assets/diagram/system-architecture-flow-en.png', 'assets/diagram/en/architecture-user-flow.png'],
  ['assets/diagram/system-integrations-en.png', 'assets/diagram/en/integrations-infrastructure.png'],
  ['assets/diagram/system-architecture-flow-es.png', 'assets/diagram/es/architecture-user-flow.png'],
  ['assets/diagram/system-integrations-es.png', 'assets/diagram/es/integrations-infrastructure.png'],

  // Screenshots (nomes representativos usados no README)
  ['assets/screenshot/IMG_1084.gif', 'assets/screenshot/shared/app-overview.gif'],
  ['assets/screenshot/IMG_1055.gif', 'assets/screenshot/shared/add-habit-flow.gif'],
  ['assets/screenshot/botao.gif', 'assets/screenshot/shared/add-button-highlight.gif'],
  ['assets/screenshot/IMG_1032.jpeg', 'assets/screenshot/shared/empty-slot-placeholder.jpeg'],
  ['assets/screenshot/IMG_1040.jpeg', 'assets/screenshot/shared/habit-list-overview.jpeg'],
  ['assets/screenshot/IMG_1041.jpeg', 'assets/screenshot/shared/habit-modal.jpeg'],
  ['assets/screenshot/IMG_1023.jpeg', 'assets/screenshot/shared/habits-grid.jpeg'],
  ['assets/screenshot/IMG_1011.jpeg', 'assets/screenshot/shared/today-view.jpeg'],
  ['assets/screenshot/IMG_1035.jpeg', 'assets/screenshot/shared/calendar-overview.jpeg'],
  ['assets/screenshot/IMG_1016.jpeg', 'assets/screenshot/shared/menu-view.jpeg'],
  ['assets/screenshot/app.gif', 'assets/screenshot/shared/app-main-flow.gif'],
  ['assets/screenshot/IMG_1036.jpeg', 'assets/screenshot/shared/habit-details.jpeg'],
  ['assets/screenshot/IMG_1039.jpeg', 'assets/screenshot/shared/ai-entrypoint.jpeg'],
  ['assets/screenshot/IMG_1020.jpeg', 'assets/screenshot/shared/quote-view.jpeg'],
  ['assets/screenshot/IMG_1014.jpeg', 'assets/screenshot/shared/chart-view.jpeg'],
  ['assets/screenshot/IMG_1028.jpeg', 'assets/screenshot/shared/habits-alt-view.jpeg'],
  ['assets/screenshot/IMG_1015.jpeg', 'assets/screenshot/shared/today-alt-view.jpeg'],
  ['assets/screenshot/IMG_1022.jpeg', 'assets/screenshot/shared/habits-list-alt.jpeg'],
  ['assets/screenshot/IMG_1042.jpeg', 'assets/screenshot/shared/settings-gear.jpeg'],
  ['assets/screenshot/IMG_1030.jpeg', 'assets/screenshot/shared/options-view.jpeg'],

  // Capturas sem referência atual no README (arquivadas com nome descritivo)
  ['assets/screenshot/IMG_1012.jpeg', 'assets/screenshot/archive/unused-capture-1012.jpeg'],
  ['assets/screenshot/IMG_1018.jpeg', 'assets/screenshot/archive/unused-capture-1018.jpeg'],
  ['assets/screenshot/IMG_1033.jpeg', 'assets/screenshot/archive/unused-capture-1033.jpeg'],
  ['assets/screenshot/IMG_1080.gif', 'assets/screenshot/archive/unused-capture-1080.gif']
];

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function moveFile(srcRel, dstRel) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(ROOT, dstRel);

  if (!fs.existsSync(src)) {
    if (fs.existsSync(dst)) return { status: 'already-moved', srcRel, dstRel };
    return { status: 'missing', srcRel, dstRel };
  }

  ensureDir(dst);
  fs.renameSync(src, dst);
  return { status: 'moved', srcRel, dstRel };
}

function updateReadme(pathsMap) {
  let content = fs.readFileSync(README_PATH, 'utf8');
  let changes = 0;

  for (const [oldPath, newPath] of pathsMap) {
    if (content.includes(oldPath)) {
      content = content.split(oldPath).join(newPath);
      changes++;
    }
  }

  fs.writeFileSync(README_PATH, content, 'utf8');
  return changes;
}

function cleanupEmptyDirs() {
  const maybeEmptyDirs = [
    'assets/diagram',
    'assets/hero',
    'assets/screenshot'
  ].map(p => path.join(ROOT, p));

  const removeIfEmpty = (dir) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) removeIfEmpty(full);
    }
    const after = fs.readdirSync(dir);
    if (after.length === 0) fs.rmdirSync(dir);
  };

  maybeEmptyDirs.forEach(removeIfEmpty);
}

function main() {
  const results = moves.map(([src, dst]) => moveFile(src, dst));
  const pathPairs = moves.map(([src, dst]) => [src, dst]);
  const readmeChanges = updateReadme(pathPairs);
  cleanupEmptyDirs();

  const moved = results.filter(r => r.status === 'moved').length;
  const missing = results.filter(r => r.status === 'missing').length;
  const already = results.filter(r => r.status === 'already-moved').length;

  console.log(`Assets reorganizados: moved=${moved}, already-moved=${already}, missing=${missing}`);
  console.log(`README atualizado: ${readmeChanges} padrões substituídos.`);

  if (missing > 0) {
    console.log('Arquivos ausentes (não movidos):');
    results.filter(r => r.status === 'missing').forEach(r => {
      console.log(` - ${r.srcRel}`);
    });
  }

  // Verificação final: não deve restar arquivo começando com IMG_ em assets/screenshot
  const screenshotRoot = path.join(ROOT, 'assets', 'screenshot');
  if (fs.existsSync(screenshotRoot)) {
    const stack = [screenshotRoot];
    const leftovers = [];
    while (stack.length > 0) {
      const dir = stack.pop();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/^IMG_\d+\.(jpe?g|gif|png)$/i.test(entry.name)) leftovers.push(path.relative(ROOT, full));
      }
    }

    if (leftovers.length > 0) {
      console.log('⚠️ Ainda restam arquivos IMG_ após reorganização:');
      leftovers.forEach((file) => console.log(` - ${file}`));
    } else {
      console.log('✅ Nenhum arquivo IMG_ restante em assets/screenshot.');
    }
  }
}

main();
