// Familia: los tutores (padre, madre…) ven cómo van los niños hoy, su historial y su horario.
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../store/useAuth.js'
import { useUI, toast } from '../store/useUI.js'
import { getFamily, createChild, familyCode, redeemFamilyCode, unlinkChild, getStatus, userSessions } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button, Section, Row, Segmented } from '../components/ui.jsx'
import { SlotList } from '../components/Slots.jsx'
import { PersonHistory } from './History.jsx'

function verdict(p) {
  if (p.missed_today) return ['bad', `${p.missed_today} sin hacer`]
  if (p.open_now) return ['wait', 'Le toca ahora']
  if (p.total_today && p.done_today === p.total_today) return ['ok', 'Todo hecho']
  return ['ok', 'Al día']
}

function CodeSheet({ child, title }) {
  const [code, setCode] = useState(null)
  useEffect(() => { familyCode(child).then(setCode).catch(e => toast(e.message)) }, [child])
  return <>
    <h3>{title}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      La otra persona va a Familia → Añadir → «Tengo un código» y lo escribe. Sirve una sola vez y caduca en 15 minutos.
    </div>
    <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: '.18em', textAlign: 'center', padding: '10px 0' }}>{code?.code || '…'}</div>
  </>
}

function AddSheet({ close, reload, passwords }) {
  const [how, setHow] = useState(passwords ? 'new' : 'code')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const go = async () => {
    try {
      const c = how === 'new' ? await createChild(name.trim(), password) : await redeemFamilyCode(code.trim())
      toast(how === 'new' ? `Perfil de ${c.name} creado` : `Ya ves a ${c.name}`)
      close(); reload()
    } catch (e) { toast(e.message) }
  }
  return <>
    <h3>Añadir a la familia</h3>
    {passwords && <><Segmented options={[{ value: 'new', label: 'Crear perfil' }, { value: 'code', label: 'Tengo un código' }]} value={how} onChange={setHow} />
      <div style={{ height: 12 }} /></>}
    {how === 'new' ? <>
      <div className="muted small" style={{ marginBottom: 12 }}>Crea el perfil de un niño. Entrará en su dispositivo con este nombre y contraseña, y tú serás su tutor.</div>
      <input className="input" placeholder="Nombre" maxLength={40} value={name} onChange={e => setName(e.target.value)} />
      <div style={{ height: 10 }} />
      <input className="input" type="password" autoComplete="new-password" placeholder="Contraseña (10+ caracteres)" value={password} onChange={e => setPassword(e.target.value)} />
    </> : <>
      <div className="muted small" style={{ marginBottom: 12 }}>
        Escribe el código que aparece en el perfil del niño (Ajustes → «Código para un tutor»), o el que te pase el otro tutor.
      </div>
      <input className="input" placeholder="CÓDIGO" maxLength={12} value={code} onChange={e => setCode(e.target.value.toUpperCase())}
        style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
    </>}
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go}>{how === 'new' ? 'Crear perfil' : 'Vincular'}</Button>
  </>
}

export default function Family() {
  const nav = useNavigate()
  const config = useAuth(s => s.config)
  const [data, setData] = useState(null)
  const load = () => getFamily().then(setData).catch(e => toast(e.message))
  useEffect(() => { load() }, [])
  const add = () => useUI.getState().openSheet(close => <AddSheet close={close} reload={load} passwords={!!config?.password_login} />)

  return (
    <>
      <div className="hdr">
        <div><h1>Familia</h1><div className="sub">Cómo van hoy</div></div>
        <Button size="sm" variant="tinted" icon="plus" onClick={add}>Añadir</Button>
      </div>
      {data && !data.children.length && <div className="empty">
        <div className="ico"><Icon name="person" /></div>
        Añade a los niños para ver si han hecho sus sesiones.<br />Puedes crear su perfil o vincular uno que ya tengan.
      </div>}
      <div className="list">
        {data?.children.map(p => {
          const [cls, label] = verdict(p)
          return (
            <button key={p.id} className="card kid" onClick={() => nav('/family/' + p.id)}>
              <div className="top">
                <span className="name">{p.name}</span>
                <span className={'pill ' + cls}>{label}</span>
                <Icon name="chevronRight" className="dim" />
              </div>
              <div className="dots">
                {p.slots.map(s => <span key={s.id} className={s.status}>{s.name} {s.status === 'done' ? '✓' : s.status === 'missed' ? '✗' : s.start}</span>)}
                {!p.slots.length && <span>Sin sesiones hoy</span>}
                <span>🔥 {p.streak}</span>
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}

export function FamilyChild() {
  const { id } = useParams()
  const nav = useNavigate()
  const [status, setStatus] = useState(null)
  const [sessions, setSessions] = useState(null)
  useEffect(() => {
    getStatus(id).then(setStatus).catch(e => toast(e.message))
    userSessions(id).then(setSessions).catch(() => {})
  }, [id])
  const share = () => useUI.getState().openSheet(() => <CodeSheet child={id} title={`Compartir a ${status?.name}`} />)
  const unlink = async () => {
    try { await unlinkChild(id); toast('Ya no eres su tutor'); nav('/family') } catch (e) { toast(e.message) }
  }
  if (!status) return null
  return (
    <>
      <div className="hdr">
        <div><h1>{status.name}</h1><div className="sub">Racha: {status.streak} {status.streak === 1 ? 'día' : 'días'}</div></div>
        <Button size="sm" variant="tinted" icon="chevronLeft" onClick={() => nav('/family')}>Familia</Button>
      </div>
      <section className="sect"><h2 className="sect-t">Hoy</h2><SlotList slots={status.slots} /></section>
      <Section>
        <Row icon="clock" title="Horario" subtitle="Cuándo tiene que cepillarse" accessory="chevron" onClick={() => nav('/schedule/' + id)} />
        <Row icon="person" title="Añadir otro tutor" subtitle="Genera un código para el padre, la madre…" accessory="chevron" onClick={share} />
        <Row icon="xmark" title="Dejar de ser su tutor" danger onClick={unlink} />
      </Section>
      <PersonHistory uid={id} sessions={sessions} />
    </>
  )
}

export { CodeSheet }
