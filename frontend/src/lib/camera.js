// Cámara -> servicio de visión (/ws), compartido por la sesión guiada y las grabaciones.
// Un solo fotograma en vuelo: el siguiente sale cuando llega la respuesta del anterior, así la
// latencia no se acumula aunque el servidor vaya más lento que la cámara.
export const SEND_WIDTH = 480, JPEG_Q = 0.7

export function say(text) {
  if (!window.speechSynthesis) return
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'es-ES'; u.rate = 1.05
  speechSynthesis.speak(u)
}

let audio = null
export function beep(freq = 880, ms = 120) {
  try {
    audio ??= new AudioContext()
    const o = audio.createOscillator(), g = audio.createGain()
    o.frequency.value = freq; g.gain.value = 0.15
    o.connect(g).connect(audio.destination)
    o.start(); o.stop(audio.currentTime + ms / 1000)
  } catch { /* sin audio no pasa nada */ }
}

/** Abre la cámara frontal. Lanza un Error con un mensaje para el usuario. */
export async function openCamera() {
  const video = document.createElement('video')
  video.playsInline = true; video.muted = true
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
    await video.play()
  } catch (e) {
    throw new Error(e.name === 'NotAllowedError' ? 'Necesito permiso para usar la cámara.' : 'No se pudo abrir la cámara: ' + e.message)
  }
  return video
}

/** Para todo lo que haya abierto startStream (idempotente). */
export function stopStream(rt) {
  rt.running = false
  rt.ws?.close()
  rt.video?.srcObject?.getTracks().forEach(t => t.stop())
  rt.wake?.release?.().catch(() => {})
  if (rt.video) rt.video.srcObject = null
}

/**
 * Manda fotogramas de rt.video al servidor y pinta el vídeo (en espejo) con la boca y las manos
 * detectadas en `canvas`. onMessage(msg) recibe cada respuesta; si devuelve false no se manda
 * el siguiente fotograma. onClose(event) solo se llama si la conexión se cae sin stopStream.
 */
export async function startStream(rt, canvas, { onOpen, onMessage, onError, onClose }) {
  const video = rt.video
  const grab = document.createElement('canvas')
  grab.width = canvas.width = SEND_WIDTH
  grab.height = canvas.height = Math.round(video.videoHeight * SEND_WIDTH / video.videoWidth)
  Object.assign(rt, { running: true, inFlight: false, last: null })
  try { rt.wake = await navigator.wakeLock?.request('screen') } catch { /* opcional */ }

  const ws = rt.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.binaryType = 'arraybuffer'
  const send = () => {
    if (!rt.running || rt.inFlight || ws.readyState !== 1) return
    grab.getContext('2d').drawImage(video, 0, 0, grab.width, grab.height)
    grab.toBlob(b => {
      if (!b || !rt.running) return
      rt.inFlight = true
      b.arrayBuffer().then(buf => ws.readyState === 1 && ws.send(buf))
    }, 'image/jpeg', JPEG_Q)
  }
  ws.onopen = () => { onOpen(ws); send() }
  ws.onclose = e => {
    if (!rt.running) return
    stopStream(rt)
    onClose(e)
  }
  ws.onmessage = e => {
    const msg = JSON.parse(e.data)
    if (msg.error && !msg.state) { onError(msg.error); return }
    rt.inFlight = false
    rt.last = msg
    if (onMessage(msg) !== false) send()
  }

  // El vídeo se pinta en local a la frecuencia de la pantalla; los overlays, cuando llega respuesta.
  const ctx = canvas.getContext('2d')
  const draw = () => {
    if (!rt.running) return
    const W = canvas.width, H = canvas.height
    ctx.save()
    ctx.translate(W, 0); ctx.scale(-1, 1)  // espejo
    ctx.drawImage(video, 0, 0, W, H)
    const m = rt.last
    if (m?.mouth) {
      ctx.strokeStyle = 'rgba(10,132,255,.8)'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(m.mouth.c[0] * W, m.mouth.c[1] * H, m.mouth.r * W, 0, 2 * Math.PI); ctx.stroke()
    }
    if (m?.hands) {
      ctx.fillStyle = '#30d158'
      for (const hand of m.hands) for (const [x, y] of hand) ctx.fillRect(x * W - 2, y * H - 2, 4, 4)
    }
    ctx.restore()
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)
}
