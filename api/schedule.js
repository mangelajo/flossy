/* Horarios de cepillado: franjas por persona y su estado en un día concreto.

   Una franja (slot) es { id, name, start: "HH:MM", end: "HH:MM", days: [0..6], mode }, con
   días de lunes (0) a domingo (6) y mode "brush" | "floss" | "both". Se cumple si dentro de la
   franja (hora local de la persona) empieza una sesión que llega al objetivo de ese modo.
   Todo se calcula en la zona horaria del usuario (user.tz, la que reporta su navegador). */

export const BRUSH_GOAL = 120;
export const FLOSS_GOAL = 60;
// Igual que en el frontend: una sesión cuenta si llega al 80 % del objetivo.
const brushed = s => s.brush_s >= BRUSH_GOAL * 0.8;
const flossed = s => s.floss_s >= FLOSS_GOAL * 0.8;
const satisfies = (s, mode) => (mode === 'brush' ? brushed(s) : mode === 'floss' ? flossed(s) : brushed(s) && flossed(s));

export const DEFAULT_SCHEDULE = [
  { id: 'manana', name: 'Mañana', start: '07:00', end: '10:00', days: [0, 1, 2, 3, 4, 5, 6], mode: 'brush' },
  { id: 'noche', name: 'Noche', start: '20:00', end: '23:00', days: [0, 1, 2, 3, 4, 5, 6], mode: 'both' }
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function validTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** Limpia una lista de franjas recibida del cliente; lanza Error con un mensaje para el usuario. */
export function cleanSchedule(list) {
  if (!Array.isArray(list) || list.length > 12) throw new Error('el horario tiene que ser una lista de hasta 12 franjas');
  const seen = new Set();
  return list.map((s, i) => {
    const name = String(s?.name ?? '').trim().slice(0, 30) || `Franja ${i + 1}`;
    const start = String(s?.start ?? ''), end = String(s?.end ?? '');
    if (!HHMM.test(start) || !HHMM.test(end)) throw new Error(`«${name}»: las horas van como HH:MM`);
    if (minutes(start) >= minutes(end)) throw new Error(`«${name}»: la hora de fin tiene que ser posterior a la de inicio`);
    const days = [...new Set((Array.isArray(s?.days) ? s.days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) throw new Error(`«${name}»: elige al menos un día`);
    let id = String(s?.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'franja';
    while (seen.has(id)) id += '-' + i;
    seen.add(id);
    return { id, name, start, end, days, mode: ['brush', 'floss', 'both'].includes(s?.mode) ? s.mode : 'both' };
  });
}

/** Fecha (YYYY-MM-DD), minuto del día y día de la semana (0 = lunes) de un instante en una zona. */
export function localParts(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(date).map(p => [p.type, p.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute, weekday };
}

const weekdayOf = isoDate => (new Date(isoDate + 'T12:00:00Z').getUTCDay() + 6) % 7;
export function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Sesiones agrupadas por fecha local: Map "YYYY-MM-DD" -> [{ s, minutes }]. */
export function indexSessions(sessions, tz) {
  const byDate = new Map();
  for (const s of sessions) {
    const at = localParts(new Date(s.started), tz);
    if (!byDate.has(at.date)) byDate.set(at.date, []);
    byDate.get(at.date).push({ s, minutes: at.minutes });
  }
  return byDate;
}

/** Estado de cada franja de un día: done | upcoming | open | missed. Las franjas que terminaron
    antes de `since` (cuando se creó el perfil) no cuentan. */
export function slotsForDay(schedule, byDate, isoDate, today, since = null) {
  const wd = weekdayOf(isoDate);
  const daySessions = byDate.get(isoDate) || [];
  const used = new Set();
  const existed = slot => !since || isoDate > since.date || (isoDate === since.date && minutes(slot.end) >= since.minutes);
  return (schedule || []).filter(slot => slot.days.includes(wd) && existed(slot)).map(slot => {
    const a = minutes(slot.start), b = minutes(slot.end);
    // Cada sesión cuenta para una sola franja (por si se solapan). Para "los dos" se suman las
    // sesiones de la franja: es normal cepillarse y pasar la seda en sesiones separadas.
    const inSlot = daySessions.filter(x => !used.has(x.s.id) && x.minutes >= a && x.minutes <= b);
    let hit = inSlot.find(x => satisfies(x.s, slot.mode));
    if (!hit && slot.mode === 'both' && inSlot.length > 1) {
      const sum = { brush_s: 0, floss_s: 0 };
      for (const x of inSlot) { sum.brush_s += x.s.brush_s || 0; sum.floss_s += x.s.floss_s || 0; }
      if (satisfies(sum, 'both')) {
        inSlot.forEach(x => used.add(x.s.id));
        hit = inSlot[0];
      }
    }
    if (hit) used.add(hit.s.id);
    let status;
    if (hit) status = 'done';
    else if (isoDate < today.date) status = 'missed';
    else if (isoDate > today.date || today.minutes < a) status = 'upcoming';
    else if (today.minutes <= b) status = 'open';
    else status = 'missed';
    return { ...slot, status, session: hit ? hit.s.id : null };
  });
}

/** Resumen de una persona: franjas de hoy, racha y (si days > 0) franjas hechas por día. */
export function personStatus(user, sessions, { days = 0, now = new Date() } = {}) {
  const tz = user.tz || 'UTC';
  const today = localParts(now, tz);
  const schedule = user.schedule || DEFAULT_SCHEDULE;
  const byDate = indexSessions(sessions, tz);
  const since = user.created ? localParts(new Date(user.created), tz) : null;
  const forDay = d => slotsForDay(schedule, byDate, d, today, since);
  const slots = forDay(today.date);
  const count = st => slots.filter(s => s.status === st).length;

  const summary = {};
  for (let i = 0, d = today.date; i < days; i++, d = addDays(d, -1)) {
    const list = forDay(d);
    summary[d] = { total: list.length, done: list.filter(s => s.status === 'done').length };
  }

  // Racha: días seguidos con todas sus franjas hechas. Hoy cuenta solo si ya está completo (si
  // no, aún puede completarse y no rompe nada); un día sin franjas ni suma ni corta.
  let streak = 0;
  for (let i = 0, d = today.date; i < 400 && (!since || d >= since.date); i++, d = addDays(d, -1)) {
    const list = forDay(d);
    if (!list.length) continue;
    if (list.every(s => s.status === 'done')) streak++;
    else if (i > 0) break;
  }

  return {
    id: user.id, name: user.name, tz, date: today.date,
    ok: count('missed') === 0,           // ninguna franja de hoy se ha quedado sin hacer
    open_now: count('open'), missed_today: count('missed'), done_today: count('done'), total_today: slots.length,
    slots: slots.map(({ id, name, start, end, mode, status }) => ({ id, name, start, end, mode, status })),
    streak,
    ...(days ? { days: summary } : {})
  };
}
