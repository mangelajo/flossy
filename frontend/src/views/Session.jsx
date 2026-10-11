// Sesión guiada: la cámara manda fotogramas al servicio de visión (/ws), que responde con lo que
// ve y con el estado de la sesión (zona pedida, progreso, si estás en ella). La barra de cada
// zona solo sube mientras el sistema confirma que estás haciendo lo pedido en esa zona.
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { saveSession } from '../lib/api.js'
import { toast } from '../store/useUI.js'
import { fmtTime, BRUSH_GOAL, FLOSS_GOAL } from '../lib/stats.js'
import { say, beep, openCamera, startStream, stopStream } from '../lib/camera.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

export const ZONES = [['sup-izq', '↖ izq'], ['sup-front', '↑'], ['sup-der', '↗ der'],
                      ['inf-izq', '↙ izq'], ['inf-front', '↓'], ['inf-der', '↘ der']]
const PER_ZONE = { brush: BRUSH_GOAL / 6, floss: FLOSS_GOAL / 6 }
const MODE_TITLE = { both: 'Cepillado + seda', brush: 'Cepillado', floss: 'Seda dental' }

export function ZoneGrid({ kind, progress, coach }) {
  return (
    <div className={`zones ${kind}`}>
      {ZONES.map(([z, label]) => {
        const p = progress?.[z] || 0
        const target = coach && !coach.done && coach.activity === kind && coach.zone === z
        const cls = !target ? '' : coach.status === 'ok' ? ' ok' : ['wrong_zone', 'wrong_activity'].includes(coach.status) ? ' warn' : ' target'
        return (
          <div key={z} className={'zone' + (p >= 1 ? ' full' : '') + cls}>
            <i style={{ transform: `scaleX(${p})` }} /><span>{p >= 1 ? '✓' : label}</span>
          </div>
        )
      })}
    </div>
  )
}

function statusLine(c) {
  if (c.done) return ['ok', '¡Completado! 🎉']
  switch (c.status) {
    case 'ok': return ['ok', '✓ Muy bien, sigue así']
    case 'wrong_zone': return ['warn', `Parece que estás en ${c.guess_name ?? 'otra zona'}`]
    case 'wrong_activity': return ['warn', c.activity === 'brush' ? 'Ahora toca el cepillo' : 'Ahora toca la seda']
    case 'checking': return ['', 'Comprobando…']
    default: return ['warn', 'Empieza cuando quieras']
  }
}

export default function Session() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const mode = ['both', 'brush', 'floss'].includes(params.get('mode')) ? params.get('mode') : 'both'
  const [phase, setPhase] = useState('ready')  // ready | running | done
  const [coach, setCoach] = useState(null)
  const [state, setState] = useState('idle')
  const [face, setFace] = useState(true)
  const [error, setError] = useState('')
  const canvasRef = useRef(null)
  const rt = useRef({}).current  // estado del bucle de fotogramas (fuera de React)

  const cleanup = () => stopStream(rt)
  useEffect(() => cleanup, [])

  const persist = async (c, completed) => {
    if (rt.saved || !c) return
    rt.saved = true
    const brush_s = mode === 'floss' ? 0 : BRUSH_GOAL - c.left.brush
    const floss_s = mode === 'brush' ? 0 : FLOSS_GOAL - c.left.floss
    if (brush_s + floss_s < 5) return
    try {
      await saveSession({ started: rt.startedAt, mode, brush_s, floss_s, brush_zones: c.progress.brush, floss_zones: c.progress.floss, completed })
      toast(completed ? '¡Sesión guardada!' : 'Sesión guardada (incompleta)')
    } catch (e) { toast('No se pudo guardar la sesión: ' + e.message) }
  }

  const finish = async completed => {
    const c = rt.coach
    cleanup()
    setPhase('done')
    await persist(c, completed)
  }

  const start = async () => {
    // Voz y sonido se "desbloquean" con el toque del usuario (iOS), antes de cualquier await.
    say('Vamos allá'); beep(660)
    setError('')
    try { rt.video = await openCamera() } catch (e) { setError(e.message); return }
    Object.assign(rt, { step: -1, coach: null, saved: false, startedAt: new Date().toISOString() })
    await startStream(rt, canvasRef.current, {
      onOpen: ws => { ws.send(JSON.stringify({ type: 'start', mode })); setPhase('running') },
      onError: setError,
      onClose: e => {
        setError(e.code === 4401 ? 'Tu sesión ha caducado: vuelve a entrar.' : 'Se ha perdido la conexión con el servidor.')
        persist(rt.coach, false)
        setPhase('ready')
      },
      onMessage: msg => {
        setState(msg.state); setFace(msg.face)
        const c = msg.coach
        if (!c) return
        rt.coach = c
        setCoach(c)
        if (c.step !== rt.step) {
          rt.step = c.step
          beep(c.done ? 1040 : 880, c.done ? 250 : 120)
          say(c.done ? '¡Terminado! Muy bien' : c.text)
        }
        if (c.done) { finish(true); return false }
      }
    })
  }

  const [cls, msg] = coach ? statusLine(coach) : ['', '']
  const left = coach?.left
  return (
    <>
      <div className="hdr">
        <div><h1>{MODE_TITLE[mode]}</h1><div className="sub">{phase === 'done' ? 'Sesión terminada' : 'Ponte delante de la cámara'}</div></div>
        {phase === 'running' && <Button size="sm" variant="tinted" icon="xmark" onClick={() => finish(false)}>Terminar</Button>}
      </div>

      <div className="stage">
        <canvas ref={canvasRef} width="480" height="360" style={{ display: phase === 'running' ? 'block' : 'none' }} />
        {phase !== 'running' && <div className="stage-empty">
          <Icon name={phase === 'done' ? 'checkCircle' : 'camera'} />
          <div>{phase === 'done' ? (coach?.done ? '¡Todo hecho!' : 'Sesión terminada') : 'La cámara se abrirá al empezar'}</div>
        </div>}
        {phase === 'running' && <div className={`badge ${state}`}>
          {!face ? 'No te veo la cara' : { brush: 'Cepillando', floss: 'Seda dental', idle: 'Esperando…' }[state]}
        </div>}
        {phase === 'running' && coach && <div className="guide">
          <div className="count">{coach.done ? '✓' : Math.ceil((1 - coach.progress[coach.activity][coach.zone]) * PER_ZONE[coach.activity])}</div>
          <div className="step">{coach.done ? 'Completado' : `Zona ${coach.step + 1} de ${coach.steps}`}</div>
          <div className="text">{coach.text}</div>
          <div className={`status ${cls}`}>{msg}</div>
        </div>}
      </div>

      {error && <div className="card small" style={{ color: 'var(--red)' }}>{error}</div>}

      <div className="tiles">
        {mode !== 'floss' && <div className="tile">
          <div className="l"><Icon name="brush" /> Cepillado · faltan</div>
          <div className="v">{fmtTime(left ? left.brush : BRUSH_GOAL)}</div>
          <ZoneGrid kind="brush" progress={coach?.progress.brush} coach={coach} />
        </div>}
        {mode !== 'brush' && <div className="tile">
          <div className="l"><Icon name="sparkles" /> Seda · faltan</div>
          <div className="v">{fmtTime(left ? left.floss : FLOSS_GOAL)}</div>
          <ZoneGrid kind="floss" progress={coach?.progress.floss} coach={coach} />
        </div>}
      </div>

      {phase === 'ready' && <Button variant="primary" icon="play" onClick={start}>Empezar</Button>}
      {phase === 'done' && <>
        <Button variant="primary" icon="house" onClick={() => nav('/home')}>Volver al inicio</Button>
        <div style={{ height: 8 }} />
        <Button icon="history" onClick={() => nav('/history')}>Ver historial</Button>
      </>}
      {phase === 'ready' && <div className="dim small" style={{ marginTop: 14, textAlign: 'center' }}>
        La app te irá diciendo cada zona. Su barra sube mientras te ve cepillando en ella.
      </div>}
    </>
  )
}
