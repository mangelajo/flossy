import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSchedule, personStatus, zonedTime, localParts, DEFAULT_SCHEDULE, BRUSH_GOAL, FLOSS_GOAL } from '../schedule.js';

const TZ = 'Europe/Madrid';
// Domingo 11 de octubre de 2026, 22:40 en Madrid (CEST, UTC+2).
const NOW = new Date('2026-10-11T20:40:00Z');
const user = (extra = {}) => ({ id: 'u', name: 'Lucía', tz: TZ, created: '2026-09-01T00:00:00Z', ...extra });
let n = 0;
const session = (iso, brush_s, floss_s, extra = {}) => ({ id: 's' + ++n, started: iso, brush_s, floss_s, ...extra });
const slots = (u, sessions, now = NOW) => Object.fromEntries(personStatus(u, sessions, { now }).slots.map(s => [s.id, s.status]));

/* ---------------- validación del horario ---------------- */

test('cleanSchedule acepta franjas válidas y les pone id y orden de días', () => {
  const [s] = cleanSchedule([{ name: 'Noche', start: '20:00', end: '22:00', days: [6, 0, 0], mode: 'both' }]);
  assert.deepEqual(s, { id: 'noche', name: 'Noche', start: '20:00', end: '22:00', days: [0, 6], mode: 'both' });
});

test('cleanSchedule rechaza horas mal escritas, fin antes del inicio, sin días y más de 12 franjas', () => {
  assert.throws(() => cleanSchedule([{ name: 'X', start: '7:00', end: '09:00', days: [0] }]), /HH:MM/);
  assert.throws(() => cleanSchedule([{ name: 'X', start: '10:00', end: '09:00', days: [0] }]), /posterior/);
  assert.throws(() => cleanSchedule([{ name: 'X', start: '08:00', end: '09:00', days: [] }]), /al menos un día/);
  assert.throws(() => cleanSchedule(Array(13).fill({ start: '08:00', end: '09:00', days: [0] })), /12/);
});

test('cleanSchedule hace ids legibles aunque el nombre lleve tildes o eñes', () => {
  const ids = cleanSchedule([{ name: 'Mañana', start: '07:00', end: '08:00', days: [0] }, { name: 'Todo el día', start: '08:00', end: '09:00', days: [0] }]).map(s => s.id);
  assert.deepEqual(ids, ['manana', 'todo-el-dia']);
});

test('cleanSchedule no repite ids aunque los nombres coincidan, y el modo por defecto es "both"', () => {
  const list = cleanSchedule([{ name: 'Cole', start: '07:00', end: '08:00', days: [0] }, { name: 'Cole', start: '08:00', end: '09:00', days: [1] }]);
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(list[0].mode, 'both');
});

/* ---------------- horas locales ---------------- */

test('zonedTime convierte hora local a UTC, también el día del cambio de hora', () => {
  assert.equal(zonedTime('2026-10-11', '20:00', TZ).toISOString(), '2026-10-11T18:00:00.000Z');  // CEST
  assert.equal(zonedTime('2026-12-01', '20:00', TZ).toISOString(), '2026-12-01T19:00:00.000Z');  // CET
  assert.equal(zonedTime('2026-10-25', '12:00', TZ).toISOString(), '2026-10-25T11:00:00.000Z');  // ya en CET
  const p = localParts(zonedTime('2026-10-11', '07:30', 'America/New_York'), 'America/New_York');
  assert.deepEqual([p.date, p.minutes], ['2026-10-11', 7 * 60 + 30]);
});

/* ---------------- estado de las franjas ---------------- */

test('sin sesiones: la mañana ya pasó (missed) y la noche está abierta', () => {
  assert.deepEqual(slots(user(), []), { manana: 'missed', noche: 'open' });
});

test('una sesión dentro de la franja con el objetivo la cumple; fuera de la franja, no', () => {
  assert.deepEqual(slots(user(), [session('2026-10-11T06:00:00Z', BRUSH_GOAL, 0)]).manana, 'done');      // 08:00
  assert.deepEqual(slots(user(), [session('2026-10-11T09:00:00Z', BRUSH_GOAL, 0)]).manana, 'missed');    // 11:00
});

test('una sesión cuenta si llega al 80 % del objetivo, no menos', () => {
  assert.equal(slots(user(), [session('2026-10-11T06:00:00Z', BRUSH_GOAL * 0.8, 0)]).manana, 'done');
  assert.equal(slots(user(), [session('2026-10-11T06:00:00Z', BRUSH_GOAL * 0.79, 0)]).manana, 'missed');
});

test('"cepillado + seda" se cumple con una sesión de cada en la franja, y no con solo una de ellas', () => {
  const brush = session('2026-10-11T18:10:00Z', BRUSH_GOAL, 0), floss = session('2026-10-11T18:20:00Z', 0, FLOSS_GOAL);
  assert.equal(slots(user(), [brush, floss]).noche, 'done');
  assert.equal(slots(user(), [brush]).noche, 'open');
  assert.equal(slots(user(), [session('2026-10-11T18:10:00Z', BRUSH_GOAL, FLOSS_GOAL)]).noche, 'done');
});

test('una misma sesión no cumple dos franjas que se solapan', () => {
  const sched = [{ id: 'a', name: 'A', start: '19:00', end: '22:00', days: [6], mode: 'brush' },
                 { id: 'b', name: 'B', start: '20:00', end: '23:00', days: [6], mode: 'brush' }];
  const st = slots(user({ schedule: sched }), [session('2026-10-11T18:30:00Z', BRUSH_GOAL, 0)]);
  assert.deepEqual(Object.values(st).sort(), ['done', 'open']);
});

test('las franjas solo cuentan los días de la semana que tienen', () => {
  const weekdays = [{ id: 'cole', name: 'Cole', start: '07:30', end: '09:00', days: [0, 1, 2, 3, 4], mode: 'brush' }];
  assert.deepEqual(slots(user({ schedule: weekdays }), []), {});  // hoy es domingo
});

test('las franjas que terminaron antes de crear el perfil no cuentan', () => {
  const nuevo = user({ created: '2026-10-11T19:00:00Z' });  // 21:00 de hoy
  assert.deepEqual(slots(nuevo, []), { noche: 'open' });
  assert.equal(personStatus(nuevo, [], { now: NOW }).ok, true);
});

test('ok es false si alguna franja de hoy ya pasó sin hacerse', () => {
  assert.equal(personStatus(user(), [], { now: NOW }).ok, false);
  assert.equal(personStatus(user(), [session('2026-10-11T06:00:00Z', BRUSH_GOAL, 0)], { now: NOW }).ok, true);
});

test('las franjas exponen la sesión que las cumple y si fue marcada a mano', () => {
  const s = session('2026-10-11T06:00:00Z', BRUSH_GOAL, 0, { manual: true });
  const manana = personStatus(user(), [s], { now: NOW }).slots.find(x => x.id === 'manana');
  assert.equal(manana.session, s.id);
  assert.equal(manana.manual, true);
});

/* ---------------- racha ---------------- */

const fullDay = d => [session(`${d}T06:00:00Z`, BRUSH_GOAL, 0), session(`${d}T18:30:00Z`, BRUSH_GOAL, FLOSS_GOAL)];

test('la racha cuenta días completos seguidos; hoy suma solo si ya está completo', () => {
  const past = [...fullDay('2026-10-09'), ...fullDay('2026-10-10')];
  assert.equal(personStatus(user(), past, { now: NOW }).streak, 2);                          // hoy a medias: no corta
  assert.equal(personStatus(user(), [...past, ...fullDay('2026-10-11')], { now: NOW }).streak, 3);
});

test('un día incompleto corta la racha', () => {
  const sessions = [...fullDay('2026-10-08'), session('2026-10-09T06:00:00Z', BRUSH_GOAL, 0), ...fullDay('2026-10-10')];
  assert.equal(personStatus(user(), sessions, { now: NOW }).streak, 1);
});

test('los días sin franjas ni suman ni cortan la racha', () => {
  const weekdays = [{ id: 'm', name: 'M', start: '07:00', end: '10:00', days: [0, 1, 2, 3, 4], mode: 'brush' }];
  // jueves 8 y viernes 9 hechos; sábado y domingo sin franjas
  const sessions = [session('2026-10-08T06:00:00Z', BRUSH_GOAL, 0), session('2026-10-09T06:00:00Z', BRUSH_GOAL, 0)];
  assert.equal(personStatus(user({ schedule: weekdays }), sessions, { now: NOW }).streak, 2);
});

test('la racha no mira antes de crear el perfil', () => {
  const st = personStatus(user({ created: '2026-10-10T00:00:00Z' }), fullDay('2026-10-10'), { now: NOW });
  assert.equal(st.streak, 1);
});

test('days resume las franjas hechas de cada día hacia atrás', () => {
  const st = personStatus(user(), fullDay('2026-10-10'), { now: NOW, days: 3 });
  assert.deepEqual(st.days['2026-10-10'], { total: 2, done: 2 });
  assert.deepEqual(st.days['2026-10-09'], { total: 2, done: 0 });
  assert.equal(Object.keys(st.days).length, 3);
});

test('el horario por defecto es mañana (cepillado) y noche (cepillado + seda)', () => {
  assert.deepEqual(DEFAULT_SCHEDULE.map(s => [s.id, s.mode]), [['manana', 'brush'], ['noche', 'both']]);
});
