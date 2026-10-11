import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../store/useAuth.js'
import { getStatus } from '../lib/api.js'
import { useSessionList } from '../lib/useSessions.js'
import { fmtWhen } from '../lib/stats.js'
import Icon from '../components/Icon.jsx'
import { Segmented } from '../components/ui.jsx'
import { SlotList, MODE_LABEL } from '../components/Slots.jsx'

const greeting = () => {
  const h = new Date().getHours()
  return h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches'
}

export default function Home() {
  const nav = useNavigate()
  const user = useAuth(s => s.user)
  const { sessions } = useSessionList()
  const [status, setStatus] = useState(null)
  const [mode, setMode] = useState(null)
  useEffect(() => { getStatus(user.id).then(setStatus).catch(() => {}) }, [user.id, sessions])

  // Lo que toca ahora: la franja abierta; si no hay, la siguiente de hoy.
  const open = status?.slots.find(s => s.status === 'open')
  const next = open || status?.slots.find(s => s.status === 'upcoming')
  const chosen = mode || open?.mode || 'both'
  const start = m => nav('/session?mode=' + m)
  const last = sessions?.at(-1)

  return (
    <>
      <div className="hdr"><div><h1>{greeting()}, {user.name}</h1>
        <div className="sub">{open ? `Toca: ${open.name.toLowerCase()}` : next ? `Siguiente: ${next.name} a las ${next.start}` : 'Hoy ya está todo hecho'}</div>
      </div></div>

      <div className="tiles">
        <div className="tile"><div className="l"><Icon name="checkCircle" /> Hoy</div>
          <div className="v">{status ? `${status.done_today}/${status.total_today}` : '—'}</div></div>
        <div className="tile"><div className="l"><Icon name="flame" /> Racha</div>
          <div className="v">{status ? `${status.streak} ${status.streak === 1 ? 'día' : 'días'}` : '—'}</div></div>
      </div>

      <section className="sect">
        <h2 className="sect-t">Sesiones de hoy</h2>
        {status && <SlotList slots={status.slots} onStart={s => start(s.mode)} />}
        <p className="sect-f"><a onClick={() => nav('/schedule/me')}>Cambiar horario</a></p>
      </section>

      <Segmented options={[{ value: 'both', label: 'Todo' }, { value: 'brush', label: 'Cepillo' }, { value: 'floss', label: 'Seda' }]}
        value={chosen} onChange={setMode} />
      <div style={{ height: 12 }} />
      <button className="big-start" onClick={() => start(chosen)}>
        <Icon name="tooth" />
        Empezar {MODE_LABEL[chosen].toLowerCase()}
      </button>

      {last && <div className="dim small" style={{ marginTop: 14, textAlign: 'center' }}>Última sesión: {fmtWhen(last.started)}</div>}
    </>
  )
}
