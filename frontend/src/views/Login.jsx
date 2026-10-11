// Inicio de sesión y alta de perfil. Mismo planteamiento que openGym: passkey primero,
// contraseña como alternativa (dispositivos sin passkeys, tablets de los niños…).
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../store/useAuth.js'
import { useUI, toast } from '../store/useUI.js'
import { webauthnOK, passkeyLogin, passkeyRegister, passwordLogin, passwordRegister, bio, cancelled } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'

const errorText = (e, fallback) => ({
  invite: 'Ese código de invitación no es válido.',
  'unknown-credential': 'Este servidor no conoce esa passkey. Crea un perfil primero.',
  disabled: 'Esta cuenta está desactivada.',
  'challenge-expired': 'Ha tardado demasiado. Inténtalo otra vez.'
}[e?.data?.code] || e?.message || fallback)

function useFocus() {
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  return ref
}

function RegisterSheet({ close }) {
  const { config, setUser } = useAuth()
  const pwOn = !!config?.password_login
  const inviteOnly = !!config?.invite_only
  const [how, setHow] = useState(webauthnOK() ? 'passkey' : 'password')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useFocus()

  const go = async () => {
    const n = name.trim()
    if (!n) return toast('Escribe un nombre')
    if (inviteOnly && !code.trim()) return toast('Hace falta un código de invitación')
    setBusy(true)
    try {
      const u = how === 'passkey' ? await passkeyRegister(n, code.trim()) : await passwordRegister(n, password, code.trim())
      setUser(u); close()
      toast(`¡Bienvenido/a, ${u.name}!`)
    } catch (e) { if (!cancelled(e)) toast(errorText(e, 'No se pudo crear el perfil')) }
    finally { setBusy(false) }
  }

  return <>
    <h3>Crear perfil</h3>
    {pwOn && webauthnOK() && <>
      <Segmented options={[{ value: 'passkey', label: 'Passkey', icon: 'fingerprint' }, { value: 'password', label: 'Contraseña', icon: 'key' }]}
        value={how} onChange={setHow} />
      <div style={{ height: 12 }} />
    </>}
    <div className="muted small" style={{ marginBottom: 14 }}>
      {how === 'passkey'
        ? `Elige un nombre y confirma con ${bio()}. La passkey se guarda en este dispositivo: no hay contraseña que recordar.`
        : 'Elige un nombre y una contraseña (al menos 10 caracteres). Entrarás con los dos.'}
    </div>
    <input ref={ref} className="input" placeholder="Tu nombre" maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    {how === 'password' && <>
      <div style={{ height: 10 }} />
      <input className="input" type="password" placeholder="Contraseña" autoComplete="new-password" value={password}
        onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
    </>}
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder="Código de invitación" maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
    </>}
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy} onClick={go}>{how === 'passkey' ? 'Crear passkey' : 'Crear perfil'}</Button>
  </>
}

function PasswordSheet({ close }) {
  const setUser = useAuth(s => s.setUser)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useFocus()
  const go = async () => {
    if (!name.trim() || !password) return toast('Escribe tu nombre y tu contraseña')
    setBusy(true)
    try { const u = await passwordLogin(name.trim(), password); setUser(u); close(); toast(`¡Hola, ${u.name}!`) }
    catch (e) { toast(errorText(e, 'No se pudo entrar')) }
    finally { setBusy(false) }
  }
  return <>
    <h3>Entrar con contraseña</h3>
    <input ref={ref} className="input" placeholder="Nombre" autoComplete="username" value={name} onChange={e => setName(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" placeholder="Contraseña" autoComplete="current-password" value={password}
      onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy} onClick={go}>Entrar</Button>
  </>
}

export default function Login() {
  const { config, setUser } = useAuth()
  const pwOn = !!config?.password_login
  const open = Sheet => useUI.getState().openSheet(close => <Sheet close={close} />)
  const signIn = async () => {
    try { const u = await passkeyLogin(); setUser(u); toast(`¡Hola, ${u.name}!`) }
    catch (e) { if (!cancelled(e)) toast(errorText(e, 'No se pudo entrar')) }
  }

  return (
    <div className="narrow" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }}>
      <div style={{ fontSize: 58, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="tooth" /></div>
      <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>flossy</h1>
      <div className="muted" style={{ marginBottom: 34 }}>Cepillado y seda, guiados por la cámara.</div>

      {webauthnOK() && <>
        <Button variant="primary" icon="fingerprint" onClick={signIn}>Entrar con passkey</Button>
        <div style={{ height: 10 }} />
      </>}
      {pwOn && <>
        <Button variant={webauthnOK() ? 'plain' : 'primary'} icon="key" onClick={() => open(PasswordSheet)}>Entrar con contraseña</Button>
        <div style={{ height: 10 }} />
      </>}
      {(webauthnOK() || pwOn) && <Button icon="plusCircle" onClick={() => open(RegisterSheet)}>Crear perfil</Button>}
      {!webauthnOK() && !pwOn && <div className="card small muted" style={{ textAlign: 'start' }}>
        Este navegador no admite passkeys y el servidor no tiene activado el acceso con contraseña.
      </div>}

      <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>
        Cada perfil guarda su propio historial de cepillado.<br />
        {!config?.has_users && 'El primer perfil que crees será el administrador.'}
      </div>
    </div>
  )
}
