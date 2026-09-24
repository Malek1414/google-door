import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

const DATA_FILE = resolve(__dirname, '../data/berlin-mitte.json')
const CONFIG_FILE = resolve(__dirname, 'config.js')

// Serves data/berlin-mitte.json at /data/berlin-mitte.json in dev and copies it into
// dist/ at build time: the static fallback when /api/entrances is unreachable.
function staticData(): Plugin {
  return {
    name: 'doorway-static-data',
    configureServer(server) {
      server.middlewares.use('/data/berlin-mitte.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(readFileSync(DATA_FILE))
      })
      // config.js is optional in dev: serve an empty config instead of a 404.
      server.middlewares.use('/config.js', (_req, res, next) => {
        if (existsSync(CONFIG_FILE)) return next()
        res.setHeader('Content-Type', 'text/javascript')
        res.end('window.DOORWAY_CONFIG = window.DOORWAY_CONFIG || {}\n')
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'data/berlin-mitte.json', source: readFileSync(DATA_FILE) })
      // config.js carries the Maps key and lives outside dist/, which the build empties.
      // Emit it here so a rebuild can never leave the deployed app without a map.
      if (existsSync(CONFIG_FILE)) {
        this.emitFile({ type: 'asset', fileName: 'config.js', source: readFileSync(CONFIG_FILE) })
      }
    },
  }
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [staticData(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    proxy: {
      '/api': { target: process.env.DOORWAY_API_PROXY ?? 'http://localhost:8080', changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      '/api': { target: process.env.DOORWAY_API_PROXY ?? 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: { target: 'es2020', sourcemap: false },
}))
