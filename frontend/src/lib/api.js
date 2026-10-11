// Llamadas a la API y ceremonias WebAuthn (adaptado de openGym, lib/api.js).

export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)
export const bio = () => (IS_APPLE ? 'Face ID / Touch ID' : IS_ANDROID ? 'la huella o la cara' : 'la huella, la cara o el PIN')
export const webauthnOK = () => typeof window.PublicKeyCredential !== 'undefined'

export async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status, data })
  return data
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })

const bufToB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uToBuf = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer

function toCreationOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  o.user.id = b64uToBuf(o.user.id)
  ;(o.excludeCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function toRequestOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  ;(o.allowCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function credToJSON(cred) {
  const r = cred.response
  const out = {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    authenticatorAttachment: cred.authenticatorAttachment || null,
    response: { clientDataJSON: bufToB64u(r.clientDataJSON) }
  }
  if (r.attestationObject) {
    out.response.attestationObject = bufToB64u(r.attestationObject)
    out.response.transports = r.getTransports ? r.getTransports() : ['internal']
  }
  if (r.authenticatorData) {
    out.response.authenticatorData = bufToB64u(r.authenticatorData)
    out.response.signature = bufToB64u(r.signature)
    out.response.userHandle = r.userHandle ? bufToB64u(r.userHandle) : null
  }
  return out
}

// Cancelar el diálogo de la passkey no es un error que haya que enseñar.
export const cancelled = e => e?.name === 'NotAllowedError' || e?.name === 'AbortError'

export async function passkeyRegister(name, code) {
  const { cid, options } = await post('/api/register/options', { name, code: code || '' })
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) })
  return (await post('/api/register/verify', { cid, credential: credToJSON(cred) })).user
}
export async function passkeyLogin() {
  const { cid, options } = await post('/api/login/options')
  const cred = await navigator.credentials.get({ publicKey: toRequestOptions(options) })
  return (await post('/api/login/verify', { cid, credential: credToJSON(cred) })).user
}
export const passwordLogin = async (name, password) => (await post('/api/login/password', { name, password })).user
export const passwordRegister = async (name, password, code) => (await post('/api/register/password', { name, password, code: code || '' })).user
export const logout = () => post('/api/logout')
export const logoutAll = () => post('/api/logout/all')

export const listSessions = async () => (await api('/api/sessions')).sessions
export const saveSession = async s => (await post('/api/sessions', s)).session
export const deleteSession = id => api('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' })

export const adminUsers = async () => (await api('/api/admin/users')).users
export const adminInvites = () => api('/api/admin/invites')
export const createInvite = async note => (await post('/api/admin/invites', { note })).invite
export const revokeInvite = code => api('/api/admin/invites/' + encodeURIComponent(code), { method: 'DELETE' })

// Perfil, horarios y estado (el estado lo calcula el servidor en la zona horaria de cada uno).
const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) })
const enc = encodeURIComponent
export const patchMe = async body => (await api('/api/me', { method: 'PATCH', body: JSON.stringify(body) })).user
export const getStatus = async (id, days = 0) => (await api(`/api/users/${enc(id)}/status?days=${days}`)).status
export const getSchedule = id => api(`/api/users/${enc(id)}/schedule`)
export const putSchedule = async (id, schedule) => (await put(`/api/users/${enc(id)}/schedule`, { schedule })).schedule
export const userSessions = async id => (await api(`/api/users/${enc(id)}/sessions`)).sessions

// Familia
export const getFamily = () => api('/api/family')
export const createChild = async (name, password) => (await post('/api/family/children', { name, password })).child
export const familyCode = child => post('/api/family/code', child ? { child } : {})
export const redeemFamilyCode = async code => (await post('/api/family/redeem', { code })).child
export const unlinkChild = id => api(`/api/family/children/${enc(id)}`, { method: 'DELETE' })

// Claves de API
export const listKeys = async () => (await api('/api/keys')).keys
export const createKey = name => post('/api/keys', { name })
export const deleteKey = id => api(`/api/keys/${enc(id)}`, { method: 'DELETE' })
