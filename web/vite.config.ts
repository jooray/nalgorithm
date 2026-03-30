import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  root: '.',
  base: process.env.VITE_BASE ?? '/',
  resolve: {
    alias: {
      nalgorithm: resolve(__dirname, '../lib/src')
    }
  },
  server: {
    port: 3000,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})
