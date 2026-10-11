import { useEffect, useState } from 'react'
import { useAuth } from '../store/useAuth.js'
import { useUI, toast } from '../store/useUI.js'
import { useSessionList } from '../lib/useSessions.js'
import { deleteSession, getStatus } from '../lib/api.js'
import { fmtTime, fmtWhen, brushed, flossed } from '../lib/stats.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { Calendar } from '../components/Slots.jsx'
import { ZoneGrid } from './Session.jsx'

function SessionSheet({ s, close, onDelete }) {
  return <>
    <h3>{fmtWhen(s.started)}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{s.completed ? 'Completa' : 'Incompleta'}</div>
    {s.mode !== 'floss' && <><div className="small">Cepillado: {fmtTime(s.brush_s)}</div><ZoneGrid kind="brush" progress={s.brush_zones} /><div style={{ height: 12 }} /></>}
    {s.mode !== 'brush' && <><div className="small">Seda: {fmtTime(s.floss_s)}</div><ZoneGrid kind="floss" progress={s.floss_zones} /><div style={{ height: 12 }} /></>}
    {onDelete && <Button variant="danger" icon="trash" onClick={async () => { await onDelete(s); close() }}>Borrar sesión</Button>}
  </>
}

// Calendario + lista de sesiones de una persona. Lo usan el historial propio y la ficha de un niño.
export function PersonHistory({ uid, sessions, onDelete }) {
  const [status, setStatus] = useState(null)
  useEffect(() => { getStatus(uid, 42).then(setStatus).catch(e => toast(e.message)) }, [uid, sessions])
  const open = s => useUI.getState().openSheet(close => <SessionSheet s={s} close={close} onDelete={onDelete} />)
  const list = (sessions || []).slice().reverse().slice(0, 60)
  return <>
    <div className="card"><Calendar days={status?.days} /></div>
    {sessions && !list.length && <div className="empty"><div className="ico"><Icon name="tooth" /></div>Todavía no hay sesiones.</div>}
    <div className="list" style={{ marginTop: 12 }}>
      {list.map(s => (
        <button key={s.id} className="card" style={{ textAlign: 'start', display: 'flex', alignItems: 'center', gap: 12 }} onClick={() => open(s)}>
          <Icon name={s.completed ? 'checkCircle' : 'clock'} style={{ fontSize: 22, color: s.completed ? 'var(--green)' : 'var(--label-3)' }} />
          <div style={{ flex: 1 }}>
            <div>{fmtWhen(s.started)}</div>
            <div className="muted small">
              {s.mode !== 'floss' && <>Cepillo {fmtTime(s.brush_s)}{brushed(s) ? ' ✓' : ''}</>}
              {s.mode === 'both' && ' · '}
              {s.mode !== 'brush' && <>Seda {fmtTime(s.floss_s)}{flossed(s) ? ' ✓' : ''}</>}
            </div>
          </div>
          <Icon name="chevronRight" className="dim" />
        </button>
      ))}
    </div>
  </>
}

export default function History() {
  const user = useAuth(s => s.user)
  const { sessions, error, reload } = useSessionList()
  const remove = async s => {
    try { await deleteSession(s.id); reload(); toast('Sesión borrada') } catch (e) { toast(e.message) }
  }
  return (
    <>
      <div className="hdr"><div><h1>Historial</h1><div className="sub">Últimas 6 semanas</div></div></div>
      {error && <div className="card small" style={{ color: 'var(--red)' }}>{error}</div>}
      <PersonHistory uid={user.id} sessions={sessions} onDelete={remove} />
    </>
  )
}
