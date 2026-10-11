// Tests de punta a punta: levantan la API (Node), el servicio de visión (Python) y el frontend
// (vite) con datos temporales, en puertos distintos a los de `make dev`, y los recorren con
// Chromium. La cámara es la falsa de Chrome (un patrón de colores): nunca imágenes reales.
//   npm run e2e        (desde frontend/; hace falta `uv` y los modelos de git LFS)
import { defineConfig, devices } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORTS = { web: 5174, api: 3101, vision: 8101 }
const ORIGIN = `http://localhost:${PORTS.web}`
// Un directorio de datos nuevo por ejecución (las variables se fijan aquí para que el proceso
// principal y los servidores lo compartan).
process.env.FLOSSY_E2E_DATA ||= fs.mkdtempSync(path.join(os.tmpdir(), 'flossy-e2e-'))
const DATA = process.env.FLOSSY_E2E_DATA

export default defineConfig({
  testDir: 'e2e',
  globalTeardown: './e2e/teardown.js',
  fullyParallel: false,
  workers: 1,               // comparten servidor y datos: en orden
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: ORIGIN,
    ...devices['Pixel 7'],
    permissions: ['camera'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'node server.js',
      cwd: '../api',
      url: `http://127.0.0.1:${PORTS.api}/api/health`,
      env: { PORT: String(PORTS.api), DATA_DIR: DATA, ORIGIN, RP_ID: 'localhost', INVITE_ONLY: '1' },
      reuseExistingServer: false
    },
    {
      command: `uv run --no-dev uvicorn app:app --port ${PORTS.vision}`,
      cwd: '../vision',
      url: `http://127.0.0.1:${PORTS.vision}/ws/health`,
      env: { DATA_DIR: DATA, ORIGIN, RECORDINGS_DIR: path.join(DATA, 'recordings') },
      timeout: 120_000,
      reuseExistingServer: false
    },
    {
      command: `npx vite --port ${PORTS.web} --strictPort`,
      url: ORIGIN,
      env: { FLOSSY_API_PORT: String(PORTS.api), FLOSSY_VISION_PORT: String(PORTS.vision), FLOSSY_ORIGIN: ORIGIN },
      reuseExistingServer: false
    }
  ]
})
