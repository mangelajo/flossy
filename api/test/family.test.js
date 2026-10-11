import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const srv = await startServer();
const mama = await srv.signup('Mamá');
const papa = await srv.signup('Papá');
const extrano = await srv.signup('Extraño');

// Una franja que dura todo el día (en UTC, la zona de un perfil sin tz): siempre "open".
const ALL_DAY = { name: 'Todo el día', start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6], mode: 'brush' };

test('un tutor crea el perfil de un niño, que entra con su contraseña', async () => {
  const r = await mama.post('/api/family/children', { name: 'Lucía', password: 'lucia-contraseña-1' });
  assert.equal(r.status, 200);
  mama.lucia = r.body.child.id;
  assert.deepEqual(r.body.child.guardians, ['Mamá']);
  const lucia = srv.client();
  assert.equal((await lucia.post('/api/login/password', { name: 'Lucía', password: 'lucia-contraseña-1' })).status, 200);
  const fam = (await mama.get('/api/family')).body;
  assert.deepEqual(fam.children.map(c => c.name), ['Lucía']);
});

test('el otro tutor se vincula con un código, que solo sirve una vez', async () => {
  const { body: { code } } = await mama.post('/api/family/code', { child: mama.lucia });
  assert.match(code, /^[A-Z0-9]{6,}$/);
  const r = await papa.post('/api/family/redeem', { code: code.toLowerCase() });
  assert.equal(r.status, 200);
  assert.equal(r.body.child.name, 'Lucía');
  assert.equal((await extrano.post('/api/family/redeem', { code })).status, 400);
  assert.deepEqual((await papa.get('/api/family')).body.children.map(c => c.name), ['Lucía']);
});

test('el niño puede generar su propio código para un tutor', async () => {
  const pablo = await srv.signup('Pablo');
  const { body: { code } } = await pablo.post('/api/family/code', {});
  assert.equal((await mama.post('/api/family/redeem', { code })).body.child.name, 'Pablo');
  mama.pablo = pablo.user.id;
});

test('solo sus tutores ven el estado, el horario y las sesiones de un niño', async () => {
  for (const p of ['status', 'schedule', 'sessions']) {
    assert.equal((await mama.get(`/api/users/${mama.lucia}/${p}`)).status, 200, p);
    assert.equal((await extrano.get(`/api/users/${mama.lucia}/${p}`)).status, 404, p);
  }
});

test('los tutores cambian el horario del niño; el niño ya no', async () => {
  const r = await papa.put(`/api/users/${mama.lucia}/schedule`, { schedule: [ALL_DAY] });
  assert.equal(r.status, 200);
  assert.equal(r.body.schedule[0].id, 'todo-el-dia');
  const lucia = srv.client();
  await lucia.post('/api/login/password', { name: 'Lucía', password: 'lucia-contraseña-1' });
  assert.equal((await lucia.get(`/api/users/${mama.lucia}/schedule`)).body.editable, false);
  assert.equal((await lucia.put(`/api/users/${mama.lucia}/schedule`, { schedule: [] })).status, 403);
  assert.equal((await papa.put(`/api/users/${mama.lucia}/schedule`, { schedule: [{ ...ALL_DAY, start: '25:00' }] })).status, 400);
});

test('un adulto sin tutores gestiona su propio horario', async () => {
  const me = mama.user.id;
  assert.equal((await mama.get(`/api/users/${me}/schedule`)).body.editable, true);
  assert.equal((await mama.put(`/api/users/${me}/schedule`, { schedule: [ALL_DAY] })).status, 200);
});

test('un tutor marca a mano una sesión de hoy, y puede deshacerlo', async () => {
  const before = (await mama.get(`/api/users/${mama.lucia}/status`)).body.status;
  assert.equal(before.can_mark, true);
  assert.equal(before.slots[0].status, 'open');

  const marked = await mama.post(`/api/users/${mama.lucia}/slots/todo-el-dia/done`);
  assert.equal(marked.status, 200);
  assert.deepEqual([marked.body.status.slots[0].status, marked.body.status.slots[0].manual], ['done', true]);
  const sessions = (await mama.get(`/api/users/${mama.lucia}/sessions`)).body.sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].manual, true);
  assert.equal(sessions[0].by, mama.user.id);

  // marcar otra vez no duplica
  await papa.post(`/api/users/${mama.lucia}/slots/todo-el-dia/done`);
  assert.equal((await mama.get(`/api/users/${mama.lucia}/sessions`)).body.sessions.length, 1);

  const undone = await papa.del(`/api/users/${mama.lucia}/slots/todo-el-dia/done`);
  assert.equal(undone.body.status.slots[0].status, 'open');
  assert.equal((await mama.get(`/api/users/${mama.lucia}/sessions`)).body.sessions.length, 0);
});

test('el niño no puede marcarse sus sesiones, ni un extraño', async () => {
  const lucia = srv.client();
  await lucia.post('/api/login/password', { name: 'Lucía', password: 'lucia-contraseña-1' });
  assert.equal((await lucia.get(`/api/users/${mama.lucia}/status`)).body.status.can_mark, false);
  assert.equal((await lucia.post(`/api/users/${mama.lucia}/slots/todo-el-dia/done`)).status, 403);
  assert.equal((await extrano.post(`/api/users/${mama.lucia}/slots/todo-el-dia/done`)).status, 404);
});

test('no se marca una franja que no existe ni una que aún no ha empezado', async () => {
  assert.equal((await mama.post(`/api/users/${mama.lucia}/slots/nope/done`)).status, 404);
  const late = { name: 'Tarde', start: '23:58', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6], mode: 'brush' };
  await mama.put(`/api/users/${mama.lucia}/schedule`, { schedule: [ALL_DAY, late] });
  if (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() < 23 * 60 + 58) {
    assert.equal((await mama.post(`/api/users/${mama.lucia}/slots/tarde/done`)).status, 400);
  }
});

test('solo se desmarcan las sesiones marcadas a mano', async () => {
  const lucia = srv.client();
  await lucia.post('/api/login/password', { name: 'Lucía', password: 'lucia-contraseña-1' });
  await lucia.post('/api/sessions', { started: new Date().toISOString(), mode: 'brush', brush_s: 120, floss_s: 0, completed: true });
  const st = (await mama.get(`/api/users/${mama.lucia}/status`)).body.status;
  assert.equal(st.slots[0].status, 'done');
  assert.equal(st.slots[0].manual, false);
  assert.equal((await mama.del(`/api/users/${mama.lucia}/slots/todo-el-dia/done`)).status, 400);
});

test('sesiones: se guardan validadas, las muy cortas no, y cada uno borra las suyas', async () => {
  const c = srv.client();
  await c.post('/api/login/password', { name: 'Extraño', password: 'Extraño-contraseña-larga' });
  assert.equal((await c.post('/api/sessions', { started: new Date().toISOString(), brush_s: 2, floss_s: 1 })).status, 400);
  assert.equal((await c.post('/api/sessions', { started: 'ayer' , brush_s: 100 })).status, 400);
  const { body: { session } } = await c.post('/api/sessions', { started: new Date().toISOString(), mode: 'both', brush_s: 99999, floss_s: 30, manual: true });
  assert.equal(session.brush_s, 3600);            // acotado
  assert.equal(session.manual, undefined);        // un cliente no puede hacerse pasar por "marcada a mano"
  assert.equal((await mama.del('/api/sessions/' + session.id)).status, 404);
  assert.equal((await c.del('/api/sessions/' + session.id)).status, 200);
  assert.equal((await c.get('/api/sessions')).body.sessions.length, 0);
});

test('claves de API: ven a su dueño y a sus niños, por nombre sin tildes, y nada más', async () => {
  const { body } = await mama.post('/api/keys', { name: 'Home Assistant' });
  assert.match(body.secret, /^flossy_/);
  const key = body.secret, api = srv.client();
  const all = await api.call('GET', '/api/v1/status', undefined, { Authorization: `Bearer ${key}` });
  assert.deepEqual(all.body.people.map(p => p.name).sort(), ['Lucía', 'Mamá', 'Pablo']);
  const lucia = await api.call('GET', '/api/v1/status/lucia', undefined, { 'X-API-Key': key });
  assert.equal(lucia.body.name, 'Lucía');
  assert.ok(Array.isArray(lucia.body.slots) && 'ok' in lucia.body && 'streak' in lucia.body);
  assert.equal((await api.call('GET', '/api/v1/status/papá', undefined, { 'X-API-Key': key })).status, 404);
  assert.equal((await api.call('GET', '/api/v1/status', undefined, { Authorization: 'Bearer flossy_falsa' })).status, 401);

  // la lista no enseña el secreto, y revocarla la invalida
  const list = (await mama.get('/api/keys')).body.keys;
  assert.equal(list.length, 1);
  assert.equal(list[0].hash, undefined);
  assert.equal((await papa.del('/api/keys/' + list[0].id)).status, 404);
  await mama.del('/api/keys/' + list[0].id);
  assert.equal((await api.call('GET', '/api/v1/status', undefined, { Authorization: `Bearer ${key}` })).status, 401);
});

test('dejar de ser tutor quita el acceso; con un tutor menos el otro sigue', async () => {
  assert.equal((await papa.del('/api/family/children/' + mama.lucia)).status, 200);
  assert.equal((await papa.get(`/api/users/${mama.lucia}/status`)).status, 404);
  assert.equal((await mama.get(`/api/users/${mama.lucia}/status`)).status, 200);
  assert.equal((await extrano.del('/api/family/children/' + mama.lucia)).status, 404);
});
