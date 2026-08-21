/* ---------------------------------------------------------------------------
   build.mjs -- src/ to dist/public/.

   Plain Node ESM calling the esbuild and sass JS APIs directly: no bundler
   framework on top of them. Three outputs, one page:

     dist/public/index.html   copy of src/frontend/index.html
     dist/public/wake.js      esbuild IIFE bundle of src/frontend/wake.ts
     dist/public/wake.css     src/styles/entry/wake.scss via sass + postcss

   dist/plugin.js and dist/backend/ are hand-written CommonJS that HFS loads as
   it finds them. Nothing here reads or writes either, and only dist/public/ is
   ever wiped -- dist/storage/ is HFS's live data directory and is likewise off
   limits.

   index.html links wake.css and wake.js by bare filename. That works because
   the page is only ever served as .../index.html; the plugin redirects a
   request for the folder itself there rather than answering it, so there is no
   URL from which those two names resolve one directory too high.

   Usage:
     node build/build.mjs            one-shot build
     node build/build.mjs --dev      readable output, inline sourcemap
     node build/build.mjs --watch    build, then rebuild on any src/ change
   --------------------------------------------------------------------------- */

import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'
import * as sass from 'sass'
import postcss from 'postcss'
import autoprefixer from 'autoprefixer'
import cssnano from 'cssnano'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const PUBLIC = join(ROOT, 'dist', 'public')

const watch = process.argv.includes('--watch')
const dev = watch || process.argv.includes('--dev')

const BANNER = '/* Built from src/ by build/build.mjs -- do not edit. */\n'

function kb(path) {
    return `${(statSync(path).size / 1024).toFixed(1)} kB`
}

async function buildJs() {
    await esbuild.build({
        entryPoints: [join(SRC, 'frontend/wake.ts')],
        outfile: join(PUBLIC, 'wake.js'),
        bundle: true,
        format: 'iife',
        target: 'es2020',
        minify: !dev,
        sourcemap: dev ? 'inline' : false,
        charset: 'utf8',
        banner: { js: BANNER },
    })
}

async function buildCss() {
    const compiled = sass.compile(join(SRC, 'styles/entry/wake.scss'), {
        style: 'expanded',
        loadPaths: [join(SRC, 'styles')],
    })
    const plugins = [autoprefixer()]
    if (!dev) plugins.push(cssnano({ preset: 'default' }))
    const result = await postcss(plugins).process(compiled.css, { from: undefined })
    mkdirSync(PUBLIC, { recursive: true })
    writeFileSync(join(PUBLIC, 'wake.css'), BANNER + result.css + '\n')
}

function copyHtml() {
    mkdirSync(PUBLIC, { recursive: true })
    cpSync(join(SRC, 'frontend/index.html'), join(PUBLIC, 'index.html'))
}

async function once() {
    const t0 = process.hrtime.bigint()
    rmSync(PUBLIC, { recursive: true, force: true })
    copyHtml()
    await Promise.all([buildJs(), buildCss()])
    console.log(`index.html ${kb(join(PUBLIC, 'index.html'))}  wake.js ${kb(join(PUBLIC, 'wake.js'))}  wake.css ${kb(join(PUBLIC, 'wake.css'))}`)
    console.log(`built in ${Number(process.hrtime.bigint() - t0) / 1e6 | 0}ms${dev ? ' (dev)' : ''}`)
}

await once()

if (watch) {
    const { watch: fsWatch } = await import('node:fs')
    let pending
    console.log('watching src/ ...')
    fsWatch(SRC, { recursive: true }, () => {
        clearTimeout(pending)
        pending = setTimeout(() => once().catch(e => console.error(e.message)), 120)
    })
}
