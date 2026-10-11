import { create } from 'zustand'
import { api, logout as apiLogout, patchMe } from '../lib/api.js'

// Los horarios se evalúan en la zona horaria de cada persona: la del navegador desde el que entra.
function syncTz(user, set) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (user && tz && user.tz !== tz) patchMe({ tz }).then(u => set({ user: u })).catch(() => {})
}

// Quién ha iniciado sesión y la configuración pública del servidor.
export const useAuth = create((set) => ({
  ready: false,
  user: null,
  config: null,

  async boot() {
    const [me, config] = await Promise.all([
      api('/api/me').catch(() => null),
      api('/api/config').catch(() => ({}))
    ])
    set({ user: me?.user || null, config, ready: true })
    syncTz(me?.user, set)
  },
  setUser(user) { set({ user }); syncTz(user, set) },
  async signOut() {
    await apiLogout().catch(() => {})
    set({ user: null })
  }
}))
