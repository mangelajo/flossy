// Hojas (sheets) y toasts, con la misma forma que el useUI de openGym para que
// components/Modals.jsx y components/Toast.jsx funcionen sin cambios.
import { create } from 'zustand'

const TOAST_MS = 2200
const TOAST_ACTION_MS = 5000
let toastTm = null, toastLeft = 0, toastT0 = 0, toastPaused = false, toastSeq = 0, sheetSeq = 0
const runToast = set => {
  toastPaused = false
  toastT0 = Date.now()
  clearTimeout(toastTm)
  toastTm = setTimeout(() => set({ toastMsg: '', toastAction: null }), toastLeft)
}

export const useUI = create((set, get) => ({
  sheets: [],
  toastMsg: '',
  toastAction: null,

  openSheet(render, { kind = 'sheet', locked = false } = {}) {
    const id = 's' + ++sheetSeq
    set(s => ({ sheets: [...s.sheets, { id, render, kind, locked }] }))
    const close = () => get().closeSheet(id)
    return { id, close, lock: v => set(s => ({ sheets: s.sheets.map(x => x.id === id ? { ...x, locked: v } : x) })) }
  },
  closeSheet(id) { set(s => ({ sheets: s.sheets.filter(x => x.id !== id) })) },
  closeAll() { set({ sheets: [] }) },

  toast(msg, { action, onAction, ms } = {}) {
    const withAction = !!(action && typeof onAction === 'function')
    clearTimeout(toastTm)
    toastLeft = ms || (withAction ? TOAST_ACTION_MS : TOAST_MS)
    toastSeq += 1
    set({ toastMsg: msg, toastAction: withAction ? { label: action, run: onAction, id: toastSeq } : null })
    runToast(set)
  },
  runToastAction() {
    const act = get().toastAction
    if (!act) return
    clearTimeout(toastTm)
    set({ toastMsg: '', toastAction: null })
    act.run()
  },
  pauseToast() {
    if (!get().toastAction || toastPaused) return
    toastPaused = true
    clearTimeout(toastTm)
    toastLeft = Math.max(400, toastLeft - (Date.now() - toastT0))
  },
  resumeToast() {
    if (!toastPaused) return
    toastPaused = false
    if (get().toastMsg) runToast(set)
  }
}))

export const toast = (msg, opts) => useUI.getState().toast(msg, opts)
