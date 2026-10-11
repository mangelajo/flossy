import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const srv = await startServer({ INVITE_ONLY: '1' });

test('el primer perfil es administrador y no necesita invitación aunque INVITE_ONLY esté activo', async () => {
  const anon = srv.client();
  assert.deepEqual((await anon.get('/api/config')).body, { invite_only: false, password_login: true, has_users: false });
  const admin = await srv.signup('Ana');
  assert.equal(admin.user.admin, true);
  assert.equal(admin.user.recorder, true);
  assert.equal((await srv.client().get('/api/config')).body.invite_only, true);
});

test('los demás necesitan una invitación válida, y cada invitación sirve una sola vez', async () => {
  const admin = srv.client();
  await admin.post('/api/login/password', { name: 'Ana', password: 'Ana-contraseña-larga' });
  const sinCodigo = await srv.client().post('/api/register/password', { name: 'Pepe', password: 'Pepe-contraseña-larga' });
  assert.equal(sinCodigo.status, 403);
  assert.equal(sinCodigo.body.code, 'invite');

  const { body: { invite } } = await admin.post('/api/admin/invites', { note: '' });
  const pepe = await srv.signup('Pepe', { code: invite.code.toLowerCase() });  // no distingue mayúsculas
  assert.equal(pepe.user.admin, false);
  const repetido = await srv.client().post('/api/register/password', { name: 'Otro', password: 'Otro-contraseña-larga', code: invite.code });
  assert.equal(repetido.status, 403);
});

test('las invitaciones revocadas dejan de valer, y solo un administrador las gestiona', async () => {
  const admin = srv.client();
  await admin.post('/api/login/password', { name: 'Ana', password: 'Ana-contraseña-larga' });
  const { body: { invite } } = await admin.post('/api/admin/invites', {});
  assert.equal((await admin.del('/api/admin/invites/' + invite.code)).status, 200);
  const r = await srv.client().post('/api/register/password', { name: 'Luis', password: 'Luis-contraseña-larga', code: invite.code });
  assert.equal(r.status, 403);

  const pepe = srv.client();
  await pepe.post('/api/login/password', { name: 'Pepe', password: 'Pepe-contraseña-larga' });
  assert.equal((await pepe.post('/api/admin/invites', {})).status, 403);
  assert.equal((await pepe.get('/api/admin/users')).status, 403);
});

test('contraseñas: se entra con la buena, no con una mala, y no se repiten nombres', async () => {
  const ok = srv.client();
  const r = await ok.post('/api/login/password', { name: 'ana', password: 'Ana-contraseña-larga' });  // nombre sin distinguir mayúsculas
  assert.equal(r.status, 200);
  assert.equal((await ok.get('/api/me')).body.user.name, 'Ana');
  assert.equal((await srv.client().post('/api/login/password', { name: 'Ana', password: 'otra-contraseña-mala' })).status, 401);
  const admin = srv.client();
  await admin.post('/api/login/password', { name: 'Ana', password: 'Ana-contraseña-larga' });
  const { body: { invite } } = await admin.post('/api/admin/invites', {});
  const dup = await srv.client().post('/api/register/password', { name: 'ANA', password: 'otra-contraseña-larga', code: invite.code });
  assert.equal(dup.status, 409);
});

test('una contraseña corta no se acepta', async () => {
  const admin = srv.client();
  await admin.post('/api/login/password', { name: 'Ana', password: 'Ana-contraseña-larga' });
  const { body: { invite } } = await admin.post('/api/admin/invites', {});
  const r = await srv.client().post('/api/register/password', { name: 'Corta', password: '123', code: invite.code });
  assert.equal(r.status, 400);
});

test('sin sesión no se accede a los datos', async () => {
  const anon = srv.client();
  assert.equal((await anon.get('/api/me')).status, 401);
  assert.equal((await anon.get('/api/sessions')).status, 401);
  assert.equal((await anon.get('/api/family')).status, 401);
});

test('CSRF: se rechazan escrituras desde otro origen', async () => {
  const c = srv.client();
  await c.post('/api/login/password', { name: 'Ana', password: 'Ana-contraseña-larga' });
  const evil = await c.call('POST', '/api/keys', { name: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const crossSite = await c.call('POST', '/api/keys', { name: 'x' }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
});

test('la cookie va firmada: si se toca, no vale', async () => {
  const c = srv.client();
  await c.post('/api/login/password', { name: 'Ana', password: 'Ana-contraseña-larga' });
  const [name, value] = c.cookie.split('=');
  const [payload, mac] = value.split('.');
  const [uid, exp, sv] = payload.split(':');
  c.cookie = `${name}=${uid}:${Number(exp) + 1}:${sv}.${mac}`;
  assert.equal((await c.get('/api/me')).status, 401);
});

test('cerrar sesión en todas partes invalida las otras cookies', async () => {
  const a = srv.client(), b = srv.client();
  await a.post('/api/login/password', { name: 'Pepe', password: 'Pepe-contraseña-larga' });
  await b.post('/api/login/password', { name: 'Pepe', password: 'Pepe-contraseña-larga' });
  assert.equal((await a.post('/api/logout/all')).status, 200);
  assert.equal((await b.get('/api/me')).status, 401);
});

test('la zona horaria se guarda si es válida', async () => {
  const c = srv.client();
  await c.post('/api/login/password', { name: 'Pepe', password: 'Pepe-contraseña-larga' });
  assert.equal((await c.patch('/api/me', { tz: 'Europe/Madrid' })).body.user.tz, 'Europe/Madrid');
  assert.equal((await c.patch('/api/me', { tz: 'Marte/Olympus' })).status, 400);
});

test('el permiso de grabar lo da un administrador', async () => {
  const admin = srv.client();
  await admin.post('/api/login/password', { name: 'Ana', password: 'Ana-contraseña-larga' });
  const pepe = srv.client();
  await pepe.post('/api/login/password', { name: 'Pepe', password: 'Pepe-contraseña-larga' });
  assert.equal((await pepe.get('/api/me')).body.user.recorder, false);
  const { body: { users } } = await admin.get('/api/admin/users');
  const id = users.find(u => u.name === 'Pepe').id;
  assert.equal((await admin.patch('/api/admin/users/' + id, { recorder: true })).body.user.recorder, true);
  assert.equal((await pepe.get('/api/me')).body.user.recorder, true);
  assert.equal((await pepe.patch('/api/admin/users/' + id, { recorder: false })).status, 403);
});
