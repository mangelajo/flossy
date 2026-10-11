import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../store/useAuth.js'
import { useUI, toast } from '../store/useUI.js'
import { logoutAll, adminUsers, adminInvites, createInvite, revokeInvite, listKeys, createKey, deleteKey } from '../lib/api.js'
import { fmtWhen } from '../lib/stats.js'
import { Section, Row, Button } from '../components/ui.jsx'
import { CodeSheet } from './Family.jsx'

function NewKeySheet({ reload }) {
  const [name, setName] = useState('')
  const [made, setMade] = useState(null)
  const go = async () => {
    try { setMade(await createKey(name.trim() || 'Clave')); reload() } catch (e) { toast(e.message) }
  }
  const base = location.origin
  if (made) return <>
    <h3>Clave «{made.key.name}»</h3>
    <div className="muted small" style={{ marginBottom: 10 }}>Cópiala ahora: no se volverá a mostrar.</div>
    <div className="secret">{made.secret}</div>
    <div style={{ height: 8 }} />
    <Button size="sm" variant="tinted" icon="clipboard" onClick={() => navigator.clipboard?.writeText(made.secret).then(() => toast('Copiada'))}>Copiar</Button>
    <div style={{ height: 14 }} />
    <div className="small muted" style={{ marginBottom: 6 }}>Estado de todos (tú y tus niños):</div>
    <pre className="snippet">{`curl -H "Authorization: Bearer ${made.secret}" \
  ${base}/api/v1/status`}</pre>
    <div className="small muted" style={{ margin: '10px 0 6px' }}>De una persona (nombre o id). <b>ok</b> es false si hoy se ha pasado alguna sesión sin hacer:</div>
    <pre className="snippet">{`curl -H "X-API-Key: ${made.secret}" \
  ${base}/api/v1/status/lucia`}</pre>
  </>
  return <>
    <h3>Nueva clave de API</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>
      Solo lectura. Permite consultar si tú y los niños de los que eres tutor habéis hecho las sesiones,
      por ejemplo desde Home Assistant para apagar la tele si a cierta hora no se ha cepillado.
    </div>
    <input className="input" placeholder="Nombre (p. ej. Home Assistant)" maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go}>Crear clave</Button>
  </>
}

function ApiKeys() {
  const [keys, setKeys] = useState(null)
  const load = () => listKeys().then(setKeys).catch(e => toast(e.message))
  useEffect(() => { load() }, [])
  const add = () => useUI.getState().openSheet(() => <NewKeySheet reload={load} />)
  const remove = async k => { try { await deleteKey(k.id); load(); toast('Clave revocada') } catch (e) { toast(e.message) } }
  return (
    <Section title="Claves de API" footer="Para domótica y scripts: GET /api/v1/status con la cabecera «Authorization: Bearer <clave>». Toca una clave para revocarla.">
      {(keys || []).map(k => <Row key={k.id} icon="key" title={k.name}
        subtitle={`${k.prefix}… · ${k.lastUsed ? 'usada ' + fmtWhen(k.lastUsed + 'Z') : 'sin usar'}`} value="Revocar" onClick={() => remove(k)} />)}
      <Row icon="plusCircle" title="Nueva clave" onClick={add} />
    </Section>
  )
}

function Admin() {
  const [users, setUsers] = useState(null)
  const [inv, setInv] = useState(null)
  const load = () => {
    adminUsers().then(setUsers).catch(e => toast(e.message))
    adminInvites().then(setInv).catch(e => toast(e.message))
  }
  useEffect(load, [])
  const newInvite = async () => {
    try { const i = await createInvite(''); toast(`Código: ${i.code}`); load() } catch (e) { toast(e.message) }
  }
  const revoke = async code => { try { await revokeInvite(code); load() } catch (e) { toast(e.message) } }
  return <>
    <Section title="Perfiles" footer="Cada persona crea su perfil desde su dispositivo (passkey o contraseña).">
      {(users || []).map(u => <Row key={u.id} icon="person" title={u.name + (u.admin ? ' · admin' : '')}
        subtitle={`${u.sessions} sesiones${u.last ? ' · última ' + fmtWhen(u.last) : ''} · ${u.passkeys} passkey${u.passkeys === 1 ? '' : 's'}${u.password ? ' · contraseña' : ''}`} />)}
    </Section>
    <Section title="Invitaciones"
      footer={inv?.invite_only ? 'Para crear un perfil hace falta un código. Toca uno para revocarlo.' : 'Los códigos solo se piden si el servidor tiene INVITE_ONLY=1.'}>
      {(inv?.invites || []).map(i => <Row key={i.code} icon="key" title={i.code} subtitle={i.usedBy ? 'usado' : 'sin usar'}
        value="Revocar" onClick={() => revoke(i.code)} />)}
      <Row icon="plusCircle" title="Nuevo código de invitación" onClick={newInvite} />
    </Section>
  </>
}

export default function Settings() {
  const nav = useNavigate()
  const { user, signOut } = useAuth()
  const everywhere = async () => {
    try { await logoutAll(); toast('Sesión cerrada en todos los dispositivos') } catch (e) { toast(e.message) }
    useAuth.getState().setUser(null)
  }
  return (
    <>
      <div className="hdr"><div><h1>Ajustes</h1><div className="sub">{user.name}</div></div></div>
      <Section title="Cuenta">
        <Row icon="personCircle" title={user.name} subtitle={user.admin ? 'Administrador' : 'Perfil'} />
        <Row icon="signOut" title="Cerrar sesión" onClick={signOut} />
        <Row icon="lock" title="Cerrar sesión en todos los dispositivos" danger onClick={everywhere} />
      </Section>
      <Section title="Horario y familia"
        footer={user.guardians?.length ? `Tus tutores: ${user.guardians.join(', ')}. Ellos ven tu progreso y gestionan tu horario.` : 'Un tutor (padre, madre…) puede ver tu progreso si le das un código.'}>
        <Row icon="clock" title="Mi horario" accessory="chevron" onClick={() => nav('/schedule/me')} />
        <Row icon="person" title="Código para un tutor" subtitle="Para que tu padre o tu madre vean tu progreso"
          accessory="chevron" onClick={() => useUI.getState().openSheet(() => <CodeSheet title="Código para un tutor" />)} />
        <Row icon="house" title="Familia" subtitle="Los niños de los que eres tutor" accessory="chevron" onClick={() => nav('/family')} />
      </Section>
      {user.recorder && <Section title="Entrenamiento"
        footer="Grabaciones guiadas zona a zona para mejorar la detección. Se guardan en el servidor.">
        <Row icon="camera" title="Grabar para entrenar" accessory="chevron" onClick={() => nav('/record')} />
        {user.admin && <Row icon="download" title="Grabaciones" subtitle="Descargar, borrar y quién puede grabar" accessory="chevron" onClick={() => nav('/recordings')} />}
      </Section>}
      <ApiKeys />
      {user.admin && <Admin />}
      <div className="dim small" style={{ textAlign: 'center', marginTop: 20 }}>
        flossy · AGPL-3.0 · basado en openGym
      </div>
    </>
  )
}
