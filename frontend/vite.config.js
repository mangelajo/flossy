import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// En desarrollo vite sirve la app y reenvía /api a la API (Node) y /ws al servicio de visión
// (Python), igual que hará nginx en producción: todo en el mismo origen, que es lo que piden
// las passkeys y la cookie de sesión.
//   API:    cd api && npm run dev                        (ORIGIN=http://localhost:5173)
//   Visión: cd vision && uv run uvicorn app:app --port 8001
// Para probar desde el móvil hace falta HTTPS: `npm run dev -- --host` detrás de un túnel, o
// directamente docker compose.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', headers: { origin: 'http://localhost:5173' } },
      '/ws': { target: 'ws://127.0.0.1:8001', ws: true }
    }
  }
})
