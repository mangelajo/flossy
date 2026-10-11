import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// En desarrollo vite sirve la app y reenvía /api a la API (Node) y /ws al servicio de visión
// (Python), igual que hará nginx en producción: todo en el mismo origen, que es lo que piden
// las passkeys y la cookie de sesión.
//   API:    cd api && npm run dev                        (ORIGIN=http://localhost:5173)
//   Visión: cd vision && uv run uvicorn app:app --port 8001
// Para probar desde el móvil hace falta HTTPS: `npm run dev -- --host` detrás de un túnel, o
// directamente docker compose.
// Puertos configurables para que los tests de punta a punta (e2e/) corran junto al entorno de
// desarrollo sin pisarlo.
const API_PORT = process.env.FLOSSY_API_PORT || 3000
const VISION_PORT = process.env.FLOSSY_VISION_PORT || 8001
const ORIGIN = process.env.FLOSSY_ORIGIN || 'http://localhost:5173'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, headers: { origin: ORIGIN } },
      '/ws': { target: `ws://127.0.0.1:${VISION_PORT}`, ws: true }
    }
  },
  // Tests (npm test): componentes en jsdom con Testing Library. Los de punta a punta van aparte (e2e/).
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}']
  }
})
