import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { readdirSync } from 'fs'
import { createHash } from 'node:crypto'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string
}

/**
 * Build identity: the package version plus a build stamp.
 *
 * The stamp matters — releasing the same version twice (a hotfix, a rebuild
 * with different content) still has to look like a new build to clients, or
 * they will never reload.
 */
const APP_VERSION = `${pkg.version}+${Date.now().toString(36)}-${createHash('sha256').update(readFileSync(resolve(__dirname, 'src/app.ts'))).digest('hex').slice(0, 8)}`

/**
 * Emits `version.json` for the running app to poll, and substitutes the
 * version into the service worker (which is copied verbatim from `public/`
 * and so is never touched by the bundler's define pass).
 */
function versionPlugin(): Plugin {
  return {
    name: 'nalgorithm-version',
    apply: 'build',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist')

      writeFileSync(
        resolve(outDir, 'version.json'),
        JSON.stringify({ version: APP_VERSION, builtAt: new Date().toISOString() }, null, 2)
      )

      const swPath = resolve(outDir, 'sw.js')
      try {
        const files = readdirSync(resolve(outDir, 'assets')).filter((f) => /\.(js|css)$/.test(f) || /^inter-latin-wght.*\.woff2$/.test(f))
        const sw = readFileSync(swPath, 'utf-8').replace(/__APP_VERSION__/g, APP_VERSION)
          .replace('__SHELL_ASSETS__', JSON.stringify(files.map((f) => `assets/${f}`).concat(['icon-192.png', 'icon-512.png'])))
        writeFileSync(swPath, sw)
      } catch {
        // No service worker in this build — nothing to stamp.
      }

      console.log(`  nalgorithm version ${APP_VERSION}`)
    },
  }
}

export default defineConfig({
  root: '.',
  base: process.env.VITE_BASE ?? '/',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [versionPlugin()],
  resolve: {
    alias: {
      nalgorithm: resolve(__dirname, '../lib/src'),
    },
  },
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
