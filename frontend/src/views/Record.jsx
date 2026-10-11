// Grabaciones para entrenar el detector de zonas. La app pide cada zona según un protocolo
// (vision/protocol.py) y el servidor guarda cada fotograma etiquetado con lo que tocaba. No
// mide nada: es material para reentrenar (vision/fetch_recordings.py + zones.py). Como sí se
// cepilla y se pasa la seda, al terminar se guarda también como sesión (cuenta para el horario).
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../store/useAuth.js'
import { useUI, toast } from '../store/useUI.js'
import { listRecordings, deleteRecording, recordingUrl, adminUsers, setRecorder, saveSession } from '../lib/api.js'
import { say, beep, openCamera, startStream, stopStream } from '../lib/camera.js'
import Icon from '../components/Icon.jsx'
import { Button, Section, Row, Segmented, Switch } from '../components/ui.jsx'

// Igual que PROTOCOLS en vision/protocol.py (segundos totales).
const PROTOCOLS = [
  { value: 'cepillado', label: 'Cepillado', secs: 130 },
  { value: 'seda', label: 'Seda', secs: 70 },
  { value: 'completo', label: 'Los dos', secs: 200 },
  { value: 'prueba', label: 'Prueba', secs: 11 }
]
const MODE = { cepillado: 'brush', seda: 'floss', completo: 'both', prueba: 'both' }
const ZONE_IDS = ['sup-izq', 'sup-front', 'sup-der', 'inf-izq', 'inf-front', 'inf-der']
const fmtMB = b => b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.ceil(b / 1e3)} KB`
const fmtStamp = s => s ? `${s.slice(6, 8)}/${s.slice(4, 6)} ${s.slice(9, 11)}:${s.slice(11, 13)}` : ''

export default function Record() {
  const nav = useNavigate()
  const user = useAuth(s => s.user)
  const [protocol, setProtocol] = useState('cepillado')
  const [hand, setHand] = useState('right')
  const [phase, setPhase] = useState('ready')  // ready | running | done
  const [guide, setGuide] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const canvasRef = useRef(null)
  const rt = useRef({}).current
  useEffect(() => () => stopStream(rt), [])

  // Segundos grabados de cada paso (para la sesión): lo transcurrido del paso según el guion.
  const track = g => {
    if (g.activity === 'brush' || g.activity === 'floss') rt.done[g.step] = { activity: g.activity, zone: g.zone, secs: g.duration - g.remaining }
  }
  const persist = async completed => {
    if (rt.saved) return
    rt.saved = true
    const secs = { brush: 0, floss: 0 }, zones = { brush: {}, floss: {} }
    for (const { activity, zone, secs: t } of Object.values(rt.done)) {
      secs[activity] += t
      zones[activity][zone] = Math.min(1, (zones[activity][zone] || 0) + t / 20 * (activity === 'floss' ? 2 : 1))
    }
    if (secs.brush + secs.floss < 5) return
    const full = z => Object.fromEntries(ZONE_IDS.map(id => [id, z[id] || 0]))
    try {
      await saveSession({ started: rt.startedAt, mode: MODE[protocol], brush_s: Math.round(secs.brush), floss_s: Math.round(secs.floss),
        brush_zones: full(zones.brush), floss_zones: full(zones.floss), completed })
      toast('Grabación guardada y contada como sesión')
    } catch (e) { toast('No se pudo guardar la sesión: ' + e.message) }
  }

  const stop = () => {
    rt.ws?.readyState === 1 && rt.ws.send(JSON.stringify({ type: 'stop' }))
    stopStream(rt)
    setResult({ id: rt.guide?.id, frames: rt.guide?.frames, complete: false })
    setPhase('done')
    persist(false)
  }

  const start = async () => {
    say('Prepárate'); beep(660)  // desbloquea voz y sonido con el toque (iOS)
    setError(''); setGuide(null); setResult(null)
    try { rt.video = await openCamera() } catch (e) { setError(e.message); return }
    Object.assign(rt, { step: -1, guide: null, done: {}, saved: false, startedAt: new Date().toISOString() })
    await startStream(rt, canvasRef.current, {
      onOpen: ws => { ws.send(JSON.stringify({ type: 'record', protocol, hand })); setPhase('running') },
      onError: msg => { setError(msg); stopStream(rt); setPhase('ready') },
      onClose: e => {
        setError(e.code === 4401 ? 'Tu sesión ha caducado: vuelve a entrar.' : 'Se ha perdido la conexión: se guarda lo grabado hasta ahora.')
        setResult({ id: rt.guide?.id, frames: rt.guide?.frames, complete: false })
        setPhase('done')
        persist(false)
      },
      onMessage: msg => {
        const g = msg.guide
        if (!g) return
        if (g.done) {
          beep(1040, 250); say('Grabación terminada. ¡Gracias!')
          stopStream(rt)
          setResult({ id: g.id, frames: g.frames, complete: true })
          setPhase('done')
          persist(true)
          return false
        }
        rt.guide = g
        track(g)
        setGuide(g)
        if (g.step !== rt.step) { rt.step = g.step; beep(880); say(g.text) }
      }
    })
  }

  if (!user.recorder) return <div className="empty">Tu perfil no tiene permiso para grabar. Pídeselo a un administrador.</div>
  const proto = PROTOCOLS.find(p => p.value === protocol)
  return (
    <>
      <div className="hdr">
        <div><h1>Grabar para entrenar</h1><div className="sub">{phase === 'running' ? 'Haz lo que te pide la app' : 'Ayuda a mejorar la detección de zonas'}</div></div>
        {phase === 'running'
          ? <Button size="sm" variant="tinted" icon="xmark" onClick={stop}>Parar</Button>
          : <Button size="sm" variant="tinted" icon="chevronLeft" onClick={() => nav(-1)}>Volver</Button>}
      </div>

      <div className="stage">
        <canvas ref={canvasRef} width="480" height="360" style={{ display: phase === 'running' ? 'block' : 'none' }} />
        {phase !== 'running' && <div className="stage-empty">
          <Icon name={phase === 'done' ? 'checkCircle' : 'camera'} />
          <div>{phase === 'done' ? (result?.complete ? 'Grabación completa' : 'Grabación parada') : 'La cámara se abrirá al empezar'}</div>
        </div>}
        {phase === 'running' && guide && <div className="guide">
          <div className="count">{Math.ceil(guide.remaining)}</div>
          <div className="step">Paso {guide.step + 1} de {guide.steps} · quedan {Math.ceil(guide.total_left)} s</div>
          <div className="text">{guide.text}</div>
          <div className="status">{guide.next ? `Después: ${guide.next}` : 'Último paso'}</div>
        </div>}
      </div>

      {error && <div className="card small" style={{ color: 'var(--red)' }}>{error}</div>}

      {phase === 'ready' && <>
        <Segmented options={PROTOCOLS.map(({ value, label }) => ({ value, label }))} value={protocol} onChange={setProtocol} />
        <div style={{ height: 10 }} />
        <Segmented options={[{ value: 'right', label: 'Diestro' }, { value: 'left', label: 'Zurdo' }]} value={hand} onChange={setHand} />
        <div style={{ height: 14 }} />
        <Button variant="primary" icon="play" onClick={start}>Empezar grabación ({Math.round(proto.secs / 6) / 10} min)</Button>
        <div className="dim small" style={{ marginTop: 14, textAlign: 'center' }}>
          La app te dirá en voz alta qué zona hacer y cuándo cambiar. Se guardan los fotogramas de la
          cámara en el servidor para reentrenar el detector; solo los administradores pueden verlos.
          También cuenta como sesión de cepillado o seda.
        </div>
      </>}
      {phase === 'done' && <>
        {result?.frames != null && <div className="card small">Guardados {result.frames} fotogramas{result.complete ? '' : ' (incompleta)'}.</div>}
        <Button variant="primary" icon="reset" onClick={() => setPhase('ready')}>Grabar otra</Button>
        {user.admin && <><div style={{ height: 8 }} /><Button icon="download" onClick={() => nav('/recordings')}>Ver grabaciones</Button></>}
      </>}
    </>
  )
}

function RecordingSheet({ rec, close, reload }) {
  const [sure, setSure] = useState(false)
  const remove = async () => {
    if (!sure) return setSure(true)
    try { await deleteRecording(rec.id); toast('Grabación borrada'); close(); reload() } catch (e) { toast(e.message) }
  }
  return <>
    <h3>{rec.who} · {rec.protocol}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {fmtStamp(rec.started)} · {rec.frames ?? '?'} fotogramas · {fmtMB(rec.bytes)}
      {rec.hand ? ` · ${rec.hand === 'left' ? 'zurdo' : 'diestro'}` : ''}{rec.complete ? '' : ' · incompleta'}
    </div>
    <a className="btn primary" href={recordingUrl(rec.id)} download={rec.id + '.tar'}><Icon name="download" /><span>Descargar (.tar)</span></a>
    <div style={{ height: 8 }} />
    <Button variant="danger" icon="trash" onClick={remove}>{sure ? 'Toca otra vez para borrar' : 'Borrar'}</Button>
  </>
}

/** Administración: grabaciones guardadas y qué perfiles pueden grabar. */
export function Recordings() {
  const nav = useNavigate()
  const [recs, setRecs] = useState(null)
  const [users, setUsers] = useState(null)
  const load = () => {
    listRecordings().then(setRecs).catch(e => toast(e.message))
    adminUsers().then(setUsers).catch(e => toast(e.message))
  }
  useEffect(load, [])
  const toggle = async (u, on) => {
    try { await setRecorder(u.id, on); load() } catch (e) { toast(e.message) }
  }
  const open = rec => useUI.getState().openSheet(close => <RecordingSheet rec={rec} close={close} reload={load} />)
  const total = (recs || []).reduce((n, r) => n + r.bytes, 0)
  return (
    <>
      <div className="hdr">
        <div><h1>Grabaciones</h1><div className="sub">{recs ? `${recs.length} · ${fmtMB(total)}` : 'Para entrenar'}</div></div>
        <Button size="sm" variant="tinted" icon="camera" onClick={() => nav('/record')}>Grabar</Button>
      </div>
      <Section footer="Para entrenar en tu ordenador: uv run fetch_recordings.py https://<servidor> con una clave de API de administrador (descarga las nuevas en vision/data/recordings) y luego uv run zones.py.">
        {(recs || []).map(r => <Row key={r.id} icon={r.complete ? 'checkCircle' : 'timer'}
          title={`${r.who} · ${r.protocol}`} subtitle={`${fmtStamp(r.started)} · ${r.frames ?? '?'} fotogramas · ${fmtMB(r.bytes)}`}
          accessory="chevron" onClick={() => open(r)} />)}
        {recs && !recs.length && <Row icon="info" title="Aún no hay grabaciones" />}
      </Section>
      <Section title="Pueden grabar" footer="Los administradores siempre pueden. La grabación guarda imágenes de la cara: actívalo solo para quien quiera colaborar.">
        {(users || []).map(u => <Row key={u.id} icon="person" title={u.name} subtitle={u.admin ? 'Administrador' : null}>
          <Switch checked={u.recorder} disabled={u.admin} onChange={on => toggle(u, on)} aria-label={`${u.name} puede grabar`} />
        </Row>)}
      </Section>
    </>
  )
}
