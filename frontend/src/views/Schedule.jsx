// Editor del horario de una persona (la propia, o la de un niño si eres su tutor).
// Cada cambio se guarda al momento en el servidor.
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../store/useAuth.js'
import { useUI, toast } from '../store/useUI.js'
import { getSchedule, putSchedule } from '../lib/api.js'
import { MODE_LABEL } from '../components/Slots.jsx'
import { Button, Section, Row, Segmented } from '../components/ui.jsx'

const DAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D']
const daysLabel = days => days.length === 7 ? 'Todos los días'
  : days.join() === '0,1,2,3,4' ? 'De lunes a viernes'
  : days.join() === '5,6' ? 'Fines de semana'
  : days.map(d => DAYS[d]).join(' ')

function SlotSheet({ slot, close, onSave, onDelete }) {
  const [s, setS] = useState(slot)
  const set = patch => setS(x => ({ ...x, ...patch }))
  const toggleDay = d => set({ days: s.days.includes(d) ? s.days.filter(x => x !== d) : [...s.days, d].sort() })
  return <>
    <h3>{slot.id ? 'Editar sesión' : 'Nueva sesión'}</h3>
    <input className="input" placeholder="Nombre (Mañana, Noche…)" maxLength={30} value={s.name} onChange={e => set({ name: e.target.value })} />
    <div style={{ height: 12 }} />
    <div className="timerow">
      <label>Desde<input className="input" type="time" value={s.start} onChange={e => set({ start: e.target.value })} /></label>
      <label>Hasta<input className="input" type="time" value={s.end} onChange={e => set({ end: e.target.value })} /></label>
    </div>
    <div style={{ height: 12 }} />
    <div className="daypick">{DAYS.map((d, i) => <button key={i} className={s.days.includes(i) ? 'on' : ''} onClick={() => toggleDay(i)}>{d}</button>)}</div>
    <div style={{ height: 12 }} />
    <Segmented options={[{ value: 'brush', label: 'Cepillado' }, { value: 'floss', label: 'Seda' }, { value: 'both', label: 'Los dos' }]}
      value={s.mode} onChange={mode => set({ mode })} />
    <div style={{ height: 16 }} />
    <Button variant="primary" onClick={async () => { if (await onSave(s)) close() }}>Guardar</Button>
    {slot.id && <><div style={{ height: 8 }} /><Button variant="danger" icon="trash" onClick={async () => { if (await onDelete()) close() }}>Borrar</Button></>}
  </>
}

export default function Schedule() {
  const { id } = useParams()
  const nav = useNavigate()
  const me = useAuth(s => s.user)
  const uid = id === 'me' ? me.id : id
  const [data, setData] = useState(null)
  useEffect(() => { getSchedule(uid).then(setData).catch(e => toast(e.message)) }, [uid])

  const save = async schedule => {
    try { setData({ ...data, schedule: await putSchedule(uid, schedule) }); return true }
    catch (e) { toast(e.message); return false }
  }
  const open = (slot, index) => useUI.getState().openSheet(close => (
    <SlotSheet slot={slot} close={close}
      onSave={s => save(index == null ? [...data.schedule, s] : data.schedule.map((x, i) => i === index ? s : x))}
      onDelete={() => save(data.schedule.filter((_, i) => i !== index))} />
  ))

  if (!data) return null
  const sorted = data.schedule.map((s, i) => [s, i]).sort((a, b) => a[0].start.localeCompare(b[0].start))
  return (
    <>
      <div className="hdr">
        <div><h1>Horario</h1><div className="sub">{id === 'me' ? 'Tus sesiones programadas' : 'Sesiones programadas'}</div></div>
        <Button size="sm" variant="tinted" icon="chevronLeft" onClick={() => nav(-1)}>Volver</Button>
      </div>
      <Section footer={data.editable
        ? 'Una sesión cuenta si la haces completa dentro de su horario. Los días sin sesiones no rompen la racha.'
        : 'Tu horario lo gestionan tus tutores.'}>
        {sorted.map(([s, i]) => <Row key={s.id} icon="clock" title={`${s.name} · ${s.start}–${s.end}`}
          subtitle={`${MODE_LABEL[s.mode]} · ${daysLabel(s.days)}`} accessory={data.editable ? 'chevron' : 'none'}
          onClick={data.editable ? () => open(s, i) : undefined} />)}
        {!sorted.length && <Row icon="info" title="Sin sesiones programadas" />}
        {data.editable && <Row icon="plusCircle" title="Añadir sesión"
          onClick={() => open({ name: '', start: '20:00', end: '22:00', days: [0, 1, 2, 3, 4, 5, 6], mode: 'both' })} />}
      </Section>
    </>
  )
}
