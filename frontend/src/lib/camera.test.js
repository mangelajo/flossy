import { describe, it, expect, vi } from 'vitest'
import { say, beep, stopStream } from './camera.js'

describe('say', () => {
  it('habla en español y corta lo que estuviera diciendo', () => {
    const speak = vi.fn(), cancel = vi.fn()
    vi.stubGlobal('speechSynthesis', { speak, cancel })
    vi.stubGlobal('SpeechSynthesisUtterance', function (text) { this.text = text })
    say('Cepilla arriba a tu izquierda')
    expect(cancel).toHaveBeenCalled()
    expect(speak.mock.calls[0][0]).toMatchObject({ text: 'Cepilla arriba a tu izquierda', lang: 'es-ES' })
  })

  it('sin síntesis de voz no rompe nada', () => {
    vi.stubGlobal('speechSynthesis', undefined)
    expect(() => say('hola')).not.toThrow()
  })
})

describe('beep', () => {
  it('sin audio no rompe nada', () => {
    vi.stubGlobal('AudioContext', function () { throw new Error('no audio') })
    expect(() => beep()).not.toThrow()
  })
})

describe('stopStream', () => {
  it('cierra el socket, apaga la cámara y se puede llamar dos veces', () => {
    const stop = vi.fn(), close = vi.fn()
    const rt = { running: true, ws: { close }, video: { srcObject: { getTracks: () => [{ stop }] } } }
    stopStream(rt)
    stopStream(rt)
    expect(rt.running).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalled()
    expect(rt.video.srcObject).toBe(null)
  })
})
