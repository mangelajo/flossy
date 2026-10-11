// Cálculos sobre el historial de sesiones (todo en hora local).
export const BRUSH_GOAL = 120
export const FLOSS_GOAL = 60
// Una sesión "cuenta" como cepillado/seda si llega a la mayor parte del objetivo.
export const brushed = s => s.brush_s >= BRUSH_GOAL * 0.8
export const flossed = s => s.floss_s >= FLOSS_GOAL * 0.8

// Se redondea antes de separar minutos y segundos: 59,6 s es 1:00, no 0:60.
export const fmtTime = s => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` }
export const fmtWhen = iso => new Date(iso).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
