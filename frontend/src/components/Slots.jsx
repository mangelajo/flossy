// Franjas del día con su estado, y calendario de días cumplidos. Compartidos por Inicio,
// Historial y la ficha de cada niño en Familia.
import Icon from './Icon.jsx'

export const MODE_LABEL = { both: 'Cepillado + seda', brush: 'Cepillado', floss: 'Seda' }
const STATUS = {
  done: ['checkCircle', 'var(--green)', 'Hecha'],
  open: ['clock', 'var(--orange)', 'Ahora'],
  upcoming: ['clock', 'var(--label-3)', 'Más tarde'],
  missed: ['xmark', 'var(--red)', 'No hecha']
}

export function SlotList({ slots, onStart }) {
  if (!slots?.length) return <div className="card small muted">Hoy no hay sesiones programadas.</div>
  return (
    <div className="sect-b">
      {slots.map(s => {
        const [icon, color, label] = STATUS[s.status]
        return (
          <div key={s.id} className="lrow">
            <span className="lrow-i" style={{ '--tint': color }}><Icon name={icon} /></span>
            <span className="lrow-m">
              <span className="lrow-t">{s.name} · {s.start}–{s.end}</span>
              <span className="lrow-s">{MODE_LABEL[s.mode]}</span>
            </span>
            {onStart && s.status === 'open'
              ? <button className="btn primary sm" onClick={() => onStart(s)}>Empezar</button>
              : <span className="lrow-v" style={{ color }}>{label}</span>}
          </div>
        )
      })}
    </div>
  )
}

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// days: { "YYYY-MM-DD": { total, done } } del servidor. Semanas de lunes a domingo.
export function Calendar({ days, weeks = 6 }) {
  const today = new Date()
  const start = new Date(today)
  start.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7)
  const cells = []
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i)
    const k = iso(d), info = days?.[k], isToday = k === iso(today)
    let cls = ''
    if (info?.total) cls = info.done === info.total ? ' l2' : info.done ? ' l1' : isToday ? '' : ' miss'
    cells.push(<div key={i} className={'d' + cls + (isToday ? ' today' : '') + (d > today ? ' out' : '')}
      title={info?.total ? `${info.done}/${info.total}` : ''}>{d.getDate()}</div>)
  }
  return <>
    <div className="cal">{['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(h => <div key={h} className="h">{h}</div>)}{cells}</div>
    <div className="dim small" style={{ marginTop: 10, textAlign: 'center' }}>Verde: todas las sesiones del día · claro: algunas · rojo: ninguna</div>
  </>
}
