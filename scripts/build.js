'use strict';
// Autor: Mateusz Bartoszewicz
// Buduje stronę tablicy: web/ -> public/ (jeden pakiet JS z podziałem na części, CSS i index.html).
// Uruchomienie: npm run build. Bot serwuje katalog public/ (w Dockerze budowany w osobnym etapie obrazu).
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

async function build({ outdir = path.join(ROOT, 'public'), minify = true, sourcemap = false, quiet = false } = {}) {
  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });
  const common = { absWorkingDir: ROOT, outdir, minify, sourcemap, legalComments: 'none', logLevel: quiet ? 'silent' : 'info', target: ['es2020', 'chrome90', 'safari14'] };
  await esbuild.build({
    ...common,
    entryPoints: { app: 'web/src/main.js' },
    bundle: true,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunk-[hash]',
    // Strona pracuje tylko w przeglądarce; zmienne środowiskowe nie mają tu czego szukać.
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await esbuild.build({ ...common, entryPoints: { app: 'web/app.css' }, bundle: true });
  fs.copyFileSync(path.join(ROOT, 'web', 'index.html'), path.join(outdir, 'index.html'));
  return outdir;
}

module.exports = { build };

if (require.main === module) {
  build().catch((err) => { console.error(err.message || err); process.exit(1); });
}
