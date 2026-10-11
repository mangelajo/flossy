import { describe, it, expect } from 'vitest'
import { brushed, flossed, fmtTime, BRUSH_GOAL, FLOSS_GOAL } from './stats.js'

describe('objetivos', () => {
  it('una sesión cuenta desde el 80 % del objetivo, igual que en la API', () => {
    expect(brushed({ brush_s: BRUSH_GOAL * 0.8 })).toBe(true)
    expect(brushed({ brush_s: BRUSH_GOAL * 0.8 - 1 })).toBe(false)
    expect(flossed({ floss_s: FLOSS_GOAL * 0.8 })).toBe(true)
    expect(flossed({ floss_s: 0 })).toBe(false)
  })
})

describe('fmtTime', () => {
  it('minutos y segundos con dos cifras', () => {
    expect(fmtTime(0)).toBe('0:00')
    expect(fmtTime(65)).toBe('1:05')
    expect(fmtTime(120)).toBe('2:00')
    expect(fmtTime(59.6)).toBe('1:00')    // se redondea antes de separar: nunca 0:60
    expect(fmtTime(113.7)).toBe('1:54')
  })
})
