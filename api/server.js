/* flossy-api — cuentas (passkeys + contraseña) y registro de sesiones de cepillado/seda.
   Sin framework, almacenamiento en ficheros JSON, cookie de sesión firmada.

   La autenticación está adaptada de openGym (https://github.com/DuarteSantos8/openGym,
   AGPL-3.0): mismo formato de cookie, CSRF, almacén de challenges WebAuthn, throttle de
   intentos y módulos password.js / rate-limit.js / durable.js / verify-error.js.
   El servicio de visión (vision/app.py) verifica esta misma cookie con el mismo secreto. */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { verifyError } from './verify-error.js';
import { hashPassword, verifyPassword, needsRehash, passwordProblem, passwordLength, nameKey, BusyError, MIN_LENGTH, MAX_LENGTH } from './password.js';
import { createBackoff, createWindow } from './rate-limit.js';
import { atomicWrite } from './durable.js';
import { cleanSchedule, personStatus, validTz, DEFAULT_SCHEDULE } from './schedule.js';

const flag = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));
const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'flossy';
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = flag(process.env.INVITE_ONLY, false);
// Una instalación familiar nueva: el primer perfil que se crea es el admin.
const FIRST_USER_ADMIN = flag(process.env.FIRST_USER_ADMIN, true);
// Contraseña además de passkeys: activada por defecto porque no todos los dispositivos de los
// niños (tablets viejas, navegadores sin passkeys) pueden crear una passkey.
const PASSWORD_LOGIN = flag(process.env.PASSWORD_LOGIN, true);
const TRUST_PROXY = flag(process.env.TRUST_PROXY, false);
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 180) || 180);
const MAX_BODY = 256 * 1024;
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';
const COOKIE = SECURE ? '__Host-flossysid' : 'flossysid';

fs.mkdirSync(DATA, { recursive: true });

/* ---------- secreto + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const dbFile = path.join(DATA, 'db.json');
function loadDb() {
  let raw;
  try { raw = fs.readFileSync(dbFile, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  try { return JSON.parse(raw); } catch (err) {
    // Nunca arrancar vacío sobre un db.json dañado: se perderían todas las cuentas al guardar.
    try { return JSON.parse(fs.readFileSync(dbFile + '.bak', 'utf8')); }
    catch { console.error(`db.json ilegible (${err.message}) y sin db.json.bak válido; restaura una copia.`); process.exit(1); }
  }
}
const db = loadDb();
db.users ||= []; db.creds ||= []; db.invites ||= []; db.keys ||= [];
function saveDb() {
  const text = JSON.stringify(db, null, 2);
  atomicWrite(dbFile, text, 0o600);
  try { atomicWrite(dbFile + '.bak', text, 0o600); } catch (e) { console.error('db.json.bak', e.message); }
}
const isAdmin = u => !!u && (u.admin === true || ADMIN_UIDS.includes(u.id));
const publicUser = u => ({
  id: u.id, name: u.name, admin: isAdmin(u), created: u.created, tz: u.tz || null,
  guardians: (u.guardians || []).map(g => db.users.find(x => x.id === g)?.name).filter(Boolean),
  children: childrenOf(u).length
});
const userById = id => db.users.find(u => u.id === id) || null;
const childrenOf = u => db.users.filter(c => (c.guardians || []).includes(u.id));
// Puede ver (estado, historial) a otra persona: ella misma o uno de sus tutores.
const canView = (viewer, target) => viewer.id === target.id || (target.guardians || []).includes(viewer.id);
// Puede cambiarle el horario: sus tutores, o ella misma si nadie la tutela.
const canEditSchedule = (viewer, target) => (target.guardians || []).includes(viewer.id) || (viewer.id === target.id && !(target.guardians || []).length);
function claimFirstAdmin(user) { if (FIRST_USER_ADMIN && db.users.length === 0) user.admin = true; }

/* ---------- sesiones de cepillado (un fichero por usuario) ---------- */
const sessionsFile = uid => path.join(DATA, 'sessions-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readSessions(uid) {
  try { return JSON.parse(fs.readFileSync(sessionsFile(uid), 'utf8')); } catch { return []; }
}
const writeSessions = (uid, list) => atomicWrite(sessionsFile(uid), JSON.stringify(list), 0o600);

/* ---------- cookie de sesión firmada: <uid>:<expira>:<versión> ---------- */
const sign = p => p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null; } catch { return null; }
  return payload;
}
const sessionVersion = u => u.sv || 0;
const makeSession = u => sign(`${u.id}:${Date.now() + SESSION_DAYS * 86400000}:${sessionVersion(u)}`);
function cookieValues(req, name) {
  const out = [];
  for (const c of (req.headers.cookie || '').split(';')) {
    const i = c.indexOf('=');
    if (i >= 0 && c.slice(0, i).trim() === name) out.push(c.slice(i + 1).trim());
  }
  return out;
}
function readSession(req) {
  const vals = cookieValues(req, COOKIE);
  // Dos valores distintos con el mismo nombre = alguien ha plantado otra cookie: no adivinar.
  if (!vals.length || vals.some(v => v !== vals[0])) return null;
  const payload = verifySig(vals[0]);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid);
  if (!user || user.disabled || Number(ver) !== sessionVersion(user)) return null;
  return user;
}
const sessionCookie = u => `${COOKIE}=${makeSession(u)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
const clearCookie = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/* ---------- CSRF (ver openGym: Sec-Fetch-Site, o Origin == ORIGIN) ---------- */
const CSRF_EXEMPT = new Set(['POST /api/register/options', 'POST /api/register/verify', 'POST /api/login/options', 'POST /api/login/verify']);
function csrfOk(req, key) {
  if (req.method === 'GET' || req.method === 'HEAD' || CSRF_EXEMPT.has(key)) return true;
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  return !origin || origin.replace(/\/+$/, '') === ORIGIN.replace(/\/+$/, '');
}

/* ---------- challenges WebAuthn (memoria, 5 min) ---------- */
const challenges = new Map();
function putChallenge(data) {
  while (challenges.size >= 20000) challenges.delete(challenges.keys().next().value);
  const cid = crypto.randomBytes(16).toString('base64url');
  challenges.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  return c && c.exp >= Date.now() ? c : null;
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60000).unref();

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function json(res, code, obj, headers) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => { size += d.length; if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(new HttpError(400, 'invalid json')); }
    });
    req.on('error', reject);
  });
}
const text = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v, max) => (Number.isFinite(+v) ? Math.min(Math.max(+v, 0), max) : 0);

/* ---------- throttle de intentos de contraseña ---------- */
const ADDR_FAILS = createBackoff({ free: 20, baseMs: 30000, maxMs: 15 * 60000, forgetMs: 3600000 });
const ACCOUNT_FAILS = createBackoff({ free: 5, baseMs: 60000, maxMs: 3600000, forgetMs: 24 * 3600000 });
const SIGNUPS = createWindow({ max: 10, windowMs: 10 * 60000 });
setInterval(() => { ADDR_FAILS.sweep(); ACCOUNT_FAILS.sweep(); SIGNUPS.sweep(); }, 60000).unref();
function clientAddr(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return String(req.socket?.remoteAddress || 'unknown');
}
const tooMany = (res, secs) => json(res, 429, { error: 'demasiados intentos, prueba más tarde', code: 'locked', retryAfter: secs }, { 'Retry-After': String(secs) });

const hasPassword = u => !!(u && u.pw && typeof u.pw.h === 'string');
const nameTaken = name => db.users.some(u => nameKey(u.name) === nameKey(name));
const WRONG = { error: 'nombre o contraseña incorrectos', code: 'bad-credentials' };
const POLICY_ERRORS = {
  'too-short': `la contraseña necesita al menos ${MIN_LENGTH} caracteres`,
  'too-long': `la contraseña puede tener como mucho ${MAX_LENGTH} caracteres`,
  'too-common': 'esta contraseña es demasiado fácil de adivinar'
};
function inviteOk(code) { return db.invites.find(i => i.code === code && !i.usedBy && !i.revoked) || null; }
function useInvite(user, code) {
  const inv = inviteOk(code);
  if (inv) { user.invitedBy = inv.code; inv.usedBy = user.id; inv.usedAt = user.created; }
}
function requireUser(req, res) {
  const user = readSession(req);
  if (!user) json(res, 401, { error: 'no has iniciado sesión' });
  return user;
}
function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (user && !isAdmin(user)) { json(res, 403, { error: 'solo para administradores' }); return null; }
  return user;
}

function viewable(req, res, id) {
  const user = requireUser(req, res);
  if (!user) return null;
  const target = userById(id);
  if (!target || !canView(user, target)) { json(res, 404, { error: 'no existe' }); return null; }
  return target;
}

/* ---------- códigos de vinculación familiar (memoria, 15 min) y claves de API ---------- */
const linkCodes = new Map();  // code -> { uid, exp }
setInterval(() => { for (const [k, v] of linkCodes) if (v.exp < Date.now()) linkCodes.delete(k); }, 60000).unref();
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const KEY_RATE = createWindow({ max: 120, windowMs: 60000 });
setInterval(() => KEY_RATE.sweep(), 60000).unref();
function apiKeyOwner(req, res) {
  const auth = String(req.headers.authorization || '');
  const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
  const key = secret && db.keys.find(k => k.hash === sha256(secret));
  const owner = key && userById(key.owner);
  if (!owner || owner.disabled) { json(res, 401, { error: 'clave de API no válida' }); return null; }
  const wait = KEY_RATE.take(key.id);
  if (wait) { tooMany(res, wait); return null; }
  // lastUsed con precisión de minutos, para no reescribir db.json en cada consulta.
  const now = new Date().toISOString().slice(0, 16);
  if (key.lastUsed !== now) { key.lastUsed = now; saveDb(); }
  return owner;
}
const keyPeople = owner => [owner, ...childrenOf(owner)];

/* ---------- validación de una sesión de cepillado ---------- */
const ZONES = ['sup-izq', 'sup-front', 'sup-der', 'inf-izq', 'inf-front', 'inf-der'];
function cleanSession(b) {
  const zones = src => Object.fromEntries(ZONES.map(z => [z, num(src?.[z], 1)]));
  const started = new Date(text(b.started));
  if (isNaN(started)) throw new HttpError(400, 'started inválido');
  return {
    id: crypto.randomBytes(9).toString('base64url'),
    started: started.toISOString(),
    ended: new Date().toISOString(),
    mode: ['both', 'brush', 'floss'].includes(b.mode) ? b.mode : 'both',
    brush_s: num(b.brush_s, 3600), floss_s: num(b.floss_s, 3600),
    brush_zones: zones(b.brush_zones), floss_zones: zones(b.floss_zones),
    completed: !!b.completed
  };
}

/* ---------- rutas ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true }),

  'GET /api/config': async (req, res) => json(res, 200, { invite_only: INVITE_ONLY, password_login: PASSWORD_LOGIN, has_users: db.users.length > 0 }),

  'GET /api/me': async (req, res) => {
    const user = requireUser(req, res);
    if (user) json(res, 200, { user: publicUser(user) });
  },

  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'falta el nombre' });
    const code = text(body.code).trim().toUpperCase();
    if (INVITE_ONLY && !inviteOk(code)) return json(res, 403, { error: 'necesitas un código de invitación válido', code: 'invite' });
    { const wait = SIGNUPS.take(clientAddr(req)); if (wait) return tooMany(res, wait); }
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID, userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
    });
    json(res, 200, { cid: putChallenge({ kind: 'register', challenge: options.challenge, name, uid, code }), options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (c?.kind !== 'register') return json(res, 400, { error: 'ha caducado, inténtalo otra vez', code: 'challenge-expired' });
    let v;
    try {
      v = await verifyRegistrationResponse({ response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false });
    } catch (e) { return json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) }); }
    if (!v.verified) return json(res, 400, { error: 'no verificado' });
    const { credential } = v.registrationInfo;
    if (db.creds.some(x => x.id === credential.id)) return json(res, 409, { error: 'esta passkey ya está registrada' });
    if (INVITE_ONLY && !inviteOk(c.code)) return json(res, 403, { error: 'el código de invitación ya no es válido', code: 'invite' });
    const user = { id: c.uid, name: c.name, created: new Date().toISOString() };
    if (INVITE_ONLY) useInvite(user, c.code);
    claimFirstAdmin(user);
    db.users.push(user);
    db.creds.push({
      id: credential.id, userId: user.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0, transports: body.credential?.response?.transports || [],
      created: user.created, lastUsed: user.created
    });
    saveDb();
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred', allowCredentials: [] });
    json(res, 200, { cid: putChallenge({ kind: 'login', challenge: options.challenge }), options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (c?.kind !== 'login') return json(res, 400, { error: 'ha caducado, inténtalo otra vez', code: 'challenge-expired' });
    const cred = db.creds.find(x => x.id === body.credential?.id);
    if (!cred) return json(res, 404, { error: 'passkey desconocida: crea un perfil primero', code: 'unknown-credential' });
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false,
        credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, 'base64url'), counter: cred.counter, transports: cred.transports }
      });
    } catch (e) { return json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) }); }
    if (!v.verified) return json(res, 400, { error: 'no verificado' });
    const user = db.users.find(u => u.id === cred.userId);
    if (!user) return json(res, 500, { error: 'usuario no encontrado' });
    if (user.disabled) return json(res, 403, { error: 'esta cuenta está desactivada', code: 'disabled' });
    cred.counter = v.authenticationInfo.newCounter;
    cred.lastUsed = new Date().toISOString();
    saveDb();
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  ...(PASSWORD_LOGIN ? {
    'POST /api/login/password': async (req, res) => {
      const body = await readBody(req);
      const k = nameKey(text(body.name).slice(0, 300));
      const pw = typeof body.password === 'string' ? body.password : '';
      if (!k || !pw) return json(res, 400, { error: 'faltan nombre y contraseña', code: 'missing' });
      const user = db.users.find(u => hasPassword(u) && nameKey(u.name) === k) || null;
      const key = user ? 'acct:' + user.id : 'id:' + k, addr = 'pw|' + clientAddr(req);
      const wait = ACCOUNT_FAILS.retryAfter(key) || ADDR_FAILS.retryAfter(addr);
      if (wait) return tooMany(res, wait);
      const byName = ACCOUNT_FAILS.attempt(key), byAddr = ADDR_FAILS.attempt(addr);
      let ok;
      try { ok = passwordLength(pw) <= MAX_LENGTH && await verifyPassword(pw, user?.pw?.h); }
      catch (e) { byName.undo(); byAddr.undo(); throw e; }
      if (!ok) return json(res, 401, WRONG);
      ACCOUNT_FAILS.clear(key); byAddr.undo();
      if (user.disabled) return json(res, 403, { error: 'esta cuenta está desactivada', code: 'disabled' });
      if (needsRehash(user.pw.h)) {
        try { user.pw.h = await hashPassword(pw); saveDb(); } catch (e) { if (!(e instanceof BusyError)) throw e; }
      }
      json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
    },

    'POST /api/register/password': async (req, res) => {
      const body = await readBody(req);
      const name = text(body.name).trim().slice(0, 40);
      if (!name) return json(res, 400, { error: 'falta el nombre', code: 'missing' });
      const code = text(body.code).trim().toUpperCase();
      if (INVITE_ONLY && !inviteOk(code)) return json(res, 403, { error: 'necesitas un código de invitación válido', code: 'invite' });
      const problem = passwordProblem(body.password, name);
      if (problem) return json(res, 400, { error: POLICY_ERRORS[problem], code: problem });
      if (nameTaken(name)) return json(res, 409, { error: 'ya hay un perfil con ese nombre', code: 'name-taken' });
      { const wait = SIGNUPS.take(clientAddr(req)); if (wait) return tooMany(res, wait); }
      const h = await hashPassword(body.password);
      if (nameTaken(name)) return json(res, 409, { error: 'ya hay un perfil con ese nombre', code: 'name-taken' });
      const created = new Date().toISOString();
      const user = { id: crypto.randomBytes(12).toString('base64url'), name, created, pw: { h, set: created } };
      if (INVITE_ONLY) useInvite(user, code);
      claimFirstAdmin(user);
      db.users.push(user);
      saveDb();
      json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
    }
  } : {}),

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  // Cerrar sesión en todos los dispositivos: invalida todas las cookies emitidas para la cuenta.
  'POST /api/logout/all': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    user.sv = sessionVersion(user) + 1;
    saveDb();
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  /* --- sesiones de cepillado --- */
  'GET /api/sessions': async (req, res) => {
    const user = requireUser(req, res);
    if (user) json(res, 200, { sessions: readSessions(user.id) });
  },

  'POST /api/sessions': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const s = cleanSession(await readBody(req));
    if (s.brush_s + s.floss_s < 5) return json(res, 400, { error: 'sesión demasiado corta' });
    const list = readSessions(user.id);
    list.push(s);
    writeSessions(user.id, list.slice(-5000));
    json(res, 200, { session: s });
  },

  'DELETE /api/sessions/{id}': async (req, res, id) => {
    const user = requireUser(req, res);
    if (!user) return;
    const list = readSessions(user.id);
    const next = list.filter(s => s.id !== id);
    if (next.length === list.length) return json(res, 404, { error: 'no existe' });
    writeSessions(user.id, next);
    json(res, 200, { ok: true });
  },

  /* --- perfil: zona horaria (la manda el navegador; los horarios se evalúan en ella) --- */
  'PATCH /api/me': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (body.tz !== undefined) {
      if (!validTz(text(body.tz))) return json(res, 400, { error: 'zona horaria desconocida' });
      user.tz = text(body.tz);
    }
    saveDb();
    json(res, 200, { user: publicUser(user) });
  },

  /* --- horario y estado de una persona (ella misma o sus tutores) --- */
  'GET /api/users/{id}/status': async (req, res, id) => {
    const target = viewable(req, res, id);
    if (!target) return;
    const days = Math.min(Math.max(+(req.query.get('days') || 0) || 0, 0), 120);
    json(res, 200, { status: personStatus(target, readSessions(target.id), { days }) });
  },

  'GET /api/users/{id}/schedule': async (req, res, id) => {
    const target = viewable(req, res, id);
    if (!target) return;
    json(res, 200, { schedule: target.schedule || DEFAULT_SCHEDULE, editable: canEditSchedule(readSession(req), target) });
  },

  'PUT /api/users/{id}/schedule': async (req, res, id) => {
    const user = requireUser(req, res);
    if (!user) return;
    const target = userById(id);
    if (!target || !canView(user, target)) return json(res, 404, { error: 'no existe' });
    if (!canEditSchedule(user, target)) return json(res, 403, { error: 'el horario lo gestionan tus tutores' });
    const body = await readBody(req);
    try { target.schedule = cleanSchedule(body.schedule); }
    catch (e) { return json(res, 400, { error: e.message }); }
    saveDb();
    json(res, 200, { schedule: target.schedule });
  },

  'GET /api/users/{id}/sessions': async (req, res, id) => {
    const target = viewable(req, res, id);
    if (target) json(res, 200, { sessions: readSessions(target.id) });
  },

  /* --- familia: tutores (padre, madre…) que ven el estado de los niños --- */
  'GET /api/family': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    json(res, 200, {
      children: childrenOf(user).map(c => ({
        ...personStatus(c, readSessions(c.id)),
        guardians: (c.guardians || []).map(g => userById(g)?.name).filter(Boolean)
      })),
      guardians: (user.guardians || []).map(g => userById(g)?.name).filter(Boolean)
    });
  },

  // Un tutor crea el perfil de un niño: entra con nombre + contraseña en su propio dispositivo.
  'POST /api/family/children': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!PASSWORD_LOGIN) return json(res, 400, { error: 'el servidor no permite contraseñas: crea el perfil desde el dispositivo del niño y vincúlalo con un código' });
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'falta el nombre' });
    const problem = passwordProblem(body.password, name);
    if (problem) return json(res, 400, { error: POLICY_ERRORS[problem], code: problem });
    if (nameTaken(name)) return json(res, 409, { error: 'ya hay un perfil con ese nombre', code: 'name-taken' });
    const h = await hashPassword(body.password);
    if (nameTaken(name)) return json(res, 409, { error: 'ya hay un perfil con ese nombre', code: 'name-taken' });
    const created = new Date().toISOString();
    const child = { id: crypto.randomBytes(12).toString('base64url'), name, created, pw: { h, set: created },
                    guardians: [user.id], ...(user.tz ? { tz: user.tz } : {}) };
    db.users.push(child);
    saveDb();
    json(res, 200, { child: publicUser(child) });
  },

  // Código de un solo uso (15 min) para que otra persona pase a ser tutora de `child`: lo genera
  // el propio niño desde su perfil, o un tutor suyo para compartirlo con el otro progenitor.
  'POST /api/family/code': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const target = body.child ? userById(text(body.child)) : user;
    if (!target || (target.id !== user.id && !(target.guardians || []).includes(user.id))) return json(res, 404, { error: 'no existe' });
    for (const [k, v] of linkCodes) if (v.uid === target.id) linkCodes.delete(k);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from(crypto.randomBytes(8)).map(b => alphabet[b % alphabet.length]).join(''); } while (linkCodes.has(code));
    linkCodes.set(code, { uid: target.id, exp: Date.now() + 15 * 60000 });
    json(res, 200, { code, for: target.name, expires_in: 900 });
  },

  'POST /api/family/redeem': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const addr = 'link|' + clientAddr(req);
    const wait = ADDR_FAILS.retryAfter(addr);
    if (wait) return tooMany(res, wait);
    const code = text((await readBody(req)).code).trim().toUpperCase();
    const link = linkCodes.get(code);
    if (link) linkCodes.delete(code);
    const target = link && link.exp >= Date.now() ? userById(link.uid) : null;
    if (!target) { ADDR_FAILS.fail(addr); return json(res, 400, { error: 'código no válido o caducado' }); }
    if (target.id === user.id) return json(res, 400, { error: 'no puedes ser tutor de ti mismo' });
    target.guardians = [...new Set([...(target.guardians || []), user.id])];
    saveDb();
    json(res, 200, { child: publicUser(target) });
  },

  // Dejar de ser tutor de alguien.
  'DELETE /api/family/children/{id}': async (req, res, id) => {
    const user = requireUser(req, res);
    if (!user) return;
    const child = userById(id);
    if (!child || !(child.guardians || []).includes(user.id)) return json(res, 404, { error: 'no existe' });
    child.guardians = child.guardians.filter(g => g !== user.id);
    saveDb();
    json(res, 200, { ok: true });
  },

  /* --- claves de API (solo lectura) para domótica: ven a su dueño y a sus niños --- */
  'GET /api/keys': async (req, res) => {
    const user = requireUser(req, res);
    if (user) json(res, 200, { keys: db.keys.filter(k => k.owner === user.id).map(({ hash, ...k }) => k) });
  },

  'POST /api/keys': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (db.keys.filter(k => k.owner === user.id).length >= 20) return json(res, 400, { error: 'máximo 20 claves' });
    const name = text((await readBody(req)).name).trim().slice(0, 40) || 'Clave';
    const secret = 'flossy_' + crypto.randomBytes(24).toString('base64url');
    const key = { id: crypto.randomBytes(6).toString('base64url'), name, owner: user.id, prefix: secret.slice(0, 11),
                  created: new Date().toISOString(), lastUsed: null, hash: sha256(secret) };
    db.keys.push(key);
    saveDb();
    const { hash, ...shown } = key;
    json(res, 200, { key: shown, secret });  // el secreto solo se muestra esta vez
  },

  'DELETE /api/keys/{id}': async (req, res, id) => {
    const user = requireUser(req, res);
    if (!user) return;
    const n = db.keys.length;
    db.keys = db.keys.filter(k => !(k.id === id && k.owner === user.id));
    if (db.keys.length === n) return json(res, 404, { error: 'no existe' });
    saveDb();
    json(res, 200, { ok: true });
  },

  /* --- API pública (clave en "Authorization: Bearer flossy_…" o "X-API-Key") --- */
  'GET /api/v1/status': async (req, res) => {
    const owner = apiKeyOwner(req, res);
    if (!owner) return;
    json(res, 200, { generated: new Date().toISOString(), people: keyPeople(owner).map(u => personStatus(u, readSessions(u.id))) });
  },

  'GET /api/v1/status/{who}': async (req, res, who) => {
    const owner = apiKeyOwner(req, res);
    if (!owner) return;
    // Sin distinguir mayúsculas ni tildes: /api/v1/status/lucia encuentra a "Lucía".
    const fold = v => nameKey(v).normalize('NFD').replace(/\p{M}/gu, '');
    const u = keyPeople(owner).find(p => p.id === who || fold(p.name) === fold(who));
    if (!u) return json(res, 404, { error: 'no existe (o esta clave no puede verlo)' });
    json(res, 200, personStatus(u, readSessions(u.id)));
  },

  /* --- admin: perfiles e invitaciones --- */
  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      users: db.users.map(u => {
        const s = readSessions(u.id);
        return { ...publicUser(u), disabled: !!u.disabled, sessions: s.length, last: s.at(-1)?.ended || null,
                 passkeys: db.creds.filter(c => c.userId === u.id).length, password: hasPassword(u) };
      })
    });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { invites: db.invites.filter(i => !i.revoked), invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites': async (req, res) => {
    const user = requireAdmin(req, res);
    if (!user) return;
    const body = await readBody(req);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(crypto.randomBytes(8)).map(b => alphabet[b % alphabet.length]).join('');
    const inv = { code, note: text(body.note).slice(0, 60), created: new Date().toISOString(), by: user.id };
    db.invites.push(inv);
    saveDb();
    json(res, 200, { invite: inv });
  },

  'DELETE /api/admin/invites/{id}': async (req, res, code) => {
    if (!requireAdmin(req, res)) return;
    const inv = db.invites.find(i => i.code === code);
    if (!inv) return json(res, 404, { error: 'no existe' });
    inv.revoked = true;
    saveDb();
    json(res, 200, { ok: true });
  }
};

/* ---------- servidor ---------- */
// Rutas con parámetros: '/api/users/{id}/schedule' -> regex con un grupo por {param}.
const compiled = Object.keys(routes).map(key => {
  const [method, pattern] = key.split(' ');
  const re = new RegExp('^' + pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[a-z]+\\?\}/g, '([^/]+)') + '$');
  return { key, method, re };
});
function route(method, pathname) {
  if (routes[method + ' ' + pathname]) return [method + ' ' + pathname, routes[method + ' ' + pathname], []];
  for (const r of compiled) {
    const m = r.method === method && r.re.exec(pathname);
    if (m) return [r.key, routes[r.key], m.slice(1).map(decodeURIComponent)];
  }
  return [null, null, []];
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const [key, handler, params] = route(req.method, url.pathname);
  if (!handler) return json(res, 404, { error: 'not found' });
  if (!csrfOk(req, key)) return json(res, 403, { error: 'origen no permitido' });
  req.query = url.searchParams;
  try { await handler(req, res, ...params); }
  catch (e) {
    if (res.headersSent) return;
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    if (e instanceof BusyError) return json(res, 503, { error: 'servidor ocupado, inténtalo en unos segundos' });
    console.error(key, e);
    json(res, 500, { error: 'error interno' });
  }
}).listen(PORT, () => console.log(`flossy-api en :${PORT} · origin ${ORIGIN} · rp ${RP_ID} · datos ${DATA}`));
