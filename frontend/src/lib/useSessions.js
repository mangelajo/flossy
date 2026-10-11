import { useEffect } from 'react'
import { create } from 'zustand'
import { listSessions } from './api.js'

// Historial de sesiones del usuario, cargado una vez y refrescado al volver a una vista.
export const useSessions = create(set => ({
  sessions: null,
  error: null,
  async load() {
    try { set({ sessions: await listSessions(), error: null }) }
    catch (e) { set({ error: e.message }) }
  }
}))

export function useSessionList() {
  const { sessions, error, load } = useSessions()
  useEffect(() => { load() }, [load])
  return { sessions, error, reload: load }
}
