#!/usr/bin/env node
/**
 * build.js — bundle the app into one self-contained HTML file.
 *
 *   node build.js            ->  dist/margin.html
 *
 * ES modules need a web server; a single file does not. Useful for
 * dropping the app on a tablet, emailing it, or publishing it anywhere
 * that serves static files.
 *
 * The bundler is deliberately simple: every module shares one scope,
 * `export` keywords are stripped, and namespace imports become plain
 * objects. That works because the modules were written with distinct
 * top-level names. If you add a module, keep that true — the build
 * parses its own output and fails loudly if two names collide.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

/** Strip module syntax so several files can share one scope. */
function flatten(src) {
  return src
    .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(const|let|var|function|class|async))/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
}

/** Names a module exports, for building its namespace object. */
function exportsOf(src) {
  return [...src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]);
}

// dependency order: leaves first
const MODULES = [
  'src/cleanup.js',
  'src/tools/pencil.js',
  'src/tools/shapes.js',
  'src/tools/prefs.js',
  'src/ink.js',
  'src/store.js',
  'src/export.js',
  'src/library.js',
  'src/history.js',
  'src/gestures.js',
  'src/tools/lasso.js',
  'src/tools/scratch.js',
  'src/tools/zoombox.js',
];

// modules that main.js imports as a namespace (`import * as X`)
const NAMESPACES = { Ink: 'src/ink.js', Store: 'src/store.js' };

const bodies = MODULES.map((p) => `\n/* ===== ${p} ===== */\n${flatten(read(p))}`).join('\n');

const shims = '\n/* ===== namespace shims ===== */\n' + Object.entries(NAMESPACES)
  .map(([name, path]) => `const ${name} = { ${exportsOf(read(path)).join(', ')} };`)
  .join('\n') + '\n';

const main = `\n/* ===== src/main.js ===== */\n${flatten(read('src/main.js'))}`;
const script = `${bodies}\n${shims}\n${main}`;

// A duplicate top-level name or a missed import is a SyntaxError in the
// bundle. Catch it here rather than as a blank page on a tablet.
try {
  new Function(script);
} catch (err) {
  console.error(`bundle does not parse: ${err.message}`);
  process.exit(1);
}

const css = read('styles/app.css');

// replacement functions, so `$` sequences in the source are not expanded
const html = read('index.html')
  // one file cannot carry a manifest, icons or a service worker
  .replace(/^<link rel="(manifest|apple-touch-icon|icon)"[^>]*>\r?\n/gm, '')
  .replace(/<link rel="stylesheet" href="styles\/app\.css">/, () => `<style>\n${css}\n</style>`)
  .replace(
    /<script type="module" src="src\/main\.js"><\/script>/,
    () => `<script type="module">\n${script}\n</script>`
  );

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'margin.html'), html);

const kb = (html.length / 1024).toFixed(0);
console.log(`dist/margin.html  ${kb} KB`);
