// Pure logic for My 100 Days. No DOM, no IndexedDB: everything here is unit-testable in Node.
//
// Data model (all stored locally in IndexedDB, see db.js):
//   Profile   { id, name, pin: null | {salt, hash}, createdAt }
//   Challenge { id, profileId, title, start: 'YYYY-MM-DD', goals: [Goal], createdAt }
//   Goal      { id, name, from: dayNumber, to: dayNumber|null }   // applies to days from <= n < to
//   Entry     { challengeId, day, checks: {goalId: true}, diary, gratitude, tomorrow, updatedAt }
//   Week      { challengeId, week, win, hard, learn, next }
//
// Goals carry their own active range, so adding or removing a goal never rewrites past days.

export const DAYS = 100;
export const WEEKS = Math.ceil(DAYS / 7);
export const MAX_ACTIVE_GOALS = 12;
export const BACKUP_VERSION = 2;

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* ---------- dates (all calendar math is done on YYYY-MM-DD strings via UTC, so DST never shifts a day) ---------- */

export function localISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function utcMs(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function isValidISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utcMs(s)) &&
    new Date(utcMs(s)).toISOString().slice(0, 10) === s;
}

/** Day number of `todayISO` within a challenge starting `startISO`. Can be <= 0 (not started) or > 100 (finished). */
export function dayNumberFor(startISO, todayISO = localISO()) {
  return Math.round((utcMs(todayISO) - utcMs(startISO)) / 864e5) + 1;
}

export function dateOfDay(startISO, n) {
  return new Date(utcMs(startISO) + (n - 1) * 864e5).toISOString().slice(0, 10);
}

export function formatISO(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

export const weekOfDay = (n) => Math.ceil(n / 7);
export const weekRange = (w) => [(w - 1) * 7 + 1, Math.min(w * 7, DAYS)];

/* ---------- goals & progress ---------- */

export const goalApplies = (g, n) => n >= g.from && (g.to == null || n < g.to);
export const goalsForDay = (ch, n) => ch.goals.filter((g) => goalApplies(g, n));
/** Goals still running as of today (not retired). Past goals are the rest. */
export const activeGoals = (ch, todayN) => {
  const n = clamp(todayN, 1, DAYS + 1);
  return ch.goals.filter((g) => g.to == null || g.to > n);
};
export const pastGoals = (ch, todayN) => {
  const n = clamp(todayN, 1, DAYS + 1);
  return ch.goals.filter((g) => g.to != null && g.to <= n);
};

export function dayStatus(ch, entries, n) {
  const gs = goalsForDay(ch, n);
  const checks = (entries[n] && entries[n].checks) || {};
  const done = gs.filter((g) => checks[g.id]).length;
  return { total: gs.length, done, complete: gs.length > 0 && done === gs.length };
}

/** Overall numbers up to and including today (days that haven't arrived yet don't count against you). */
export function computeStats(ch, entries, todayN) {
  const elapsed = clamp(todayN, 0, DAYS);
  let due = 0, done = 0, daysComplete = 0, best = 0, run = 0;
  const complete = [];
  for (let n = 1; n <= elapsed; n++) {
    const s = dayStatus(ch, entries, n);
    due += s.total; done += s.done;
    complete[n] = s.complete;
    if (s.complete) { daysComplete++; run++; best = Math.max(best, run); } else run = 0;
  }
  // Current streak: consecutive complete days ending today; if today is still pending, it doesn't break the streak.
  let streak = 0;
  let n = elapsed;
  if (n >= 1 && !complete[n]) n--;
  while (n >= 1 && complete[n]) { streak++; n--; }
  return {
    elapsed, due, done, daysComplete, streak, best,
    pct: due ? Math.round((done / due) * 100) : 0,
  };
}

export function weekStats(ch, entries, week, todayN) {
  const [a, b] = weekRange(week);
  const last = Math.min(b, clamp(todayN, 0, DAYS));
  let due = 0, done = 0, daysComplete = 0;
  for (let n = a; n <= last; n++) {
    const s = dayStatus(ch, entries, n);
    due += s.total; done += s.done; if (s.complete) daysComplete++;
  }
  return { days: Math.max(0, last - a + 1), due, done, daysComplete, pct: due ? Math.round((done / due) * 100) : 0 };
}

/** Add a goal. `includePast` backdates it to Day 1; otherwise it starts counting from today. */
export function addGoal(ch, name, todayN, includePast = false) {
  const from = includePast ? 1 : clamp(todayN, 1, DAYS);
  const g = { id: uid(), name, from, to: null };
  ch.goals.push(g);
  return g;
}

/** Stop a goal from today onward, keeping its past days. If it never applied to any day, it is simply deleted. */
export function retireGoal(ch, goalId, todayN) {
  const g = ch.goals.find((x) => x.id === goalId);
  if (!g) return;
  const to = clamp(todayN, 1, DAYS + 1);
  if (todayN < 1 || to <= g.from) ch.goals = ch.goals.filter((x) => x.id !== goalId);
  else g.to = to;
}

/* ---------- backups ---------- */

export function validateBackup(data) {
  const isArr = Array.isArray;
  if (!data || typeof data !== 'object') return 'not an object';
  if (data.app !== 'my100days') return 'unknown format';
  if (!isArr(data.profiles) || !isArr(data.challenges) || !isArr(data.entries) || !isArr(data.weeks)) return 'missing sections';
  if (data.profiles.some((p) => !p || typeof p.id !== 'string' || typeof p.name !== 'string')) return 'bad profile';
  if (data.challenges.some((c) => !c || typeof c.id !== 'string' || typeof c.profileId !== 'string' || !isArr(c.goals) || !isValidISO(c.start))) return 'bad challenge';
  if (data.entries.some((e) => !e || typeof e.challengeId !== 'string' || !Number.isInteger(e.day) || e.day < 1 || e.day > DAYS)) return 'bad entry';
  if (data.weeks.some((w) => !w || typeof w.challengeId !== 'string' || !Number.isInteger(w.week) || w.week < 1 || w.week > WEEKS)) return 'bad week';
  return null;
}

/** Is this the single-challenge JSON exported by the original standalone HTML tracker? */
export function isLegacyBackup(d) {
  return !!d && typeof d === 'object' && Array.isArray(d.goals) && d.days && typeof d.days === 'object' && !d.app;
}

const str = (v, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Convert the original tracker's export into records for the new schema. */
export function convertLegacy(old, profileName) {
  const profileId = uid(), challengeId = uid(), now = Date.now();
  const goals = old.goals
    .filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string')
    .map((g) => ({ id: g.id, name: str(g.name, 70), from: 1, to: null }));
  const start = isValidISO(old.start) ? old.start : localISO();
  const entries = Object.entries(old.days)
    .filter(([n]) => Number.isInteger(+n) && +n >= 1 && +n <= DAYS)
    .map(([n, d]) => ({
      challengeId, day: +n,
      checks: Object.fromEntries(Object.entries((d && d.checks) || {}).filter(([, v]) => v).map(([k]) => [k, true])),
      diary: str(d && d.diary), gratitude: str(d && d.gratitude), tomorrow: str(d && d.tomorrow), updatedAt: now,
    }));
  const weeks = Object.entries(old.weeks || {})
    .filter(([w]) => Number.isInteger(+w) && +w >= 1 && +w <= WEEKS)
    .map(([w, v]) => ({ challengeId, week: +w, win: str(v && v.win), hard: str(v && v.hard), learn: str(v && v.learn), next: str(v && v.next) }));
  return {
    profile: { id: profileId, name: profileName, pin: null, createdAt: now },
    challenge: { id: challengeId, profileId, title: str(old.title, 60) || '100 Days — My Journey', start, goals, createdAt: now },
    entries, weeks,
  };
}

/* ---------- daily reminder (.ics) ---------- */

const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** A recurring daily calendar event with an alarm at the event time. Floating local time, so it follows the phone's timezone. */
export function buildICS({ title, fromISO, time, count, url, now = new Date() }) {
  const [h, m] = time.split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const endMin = h * 60 + m + 15;
  const endH = Math.floor((endMin % 1440) / 60), endM = endMin % 60;
  const ds = fromISO.replace(/-/g, '');
  // A late reminder (e.g. 23:55) ends after midnight, so the end date must roll over to the next day.
  const endDate = endMin >= 1440 ? new Date(utcMs(fromISO) + 864e5).toISOString().slice(0, 10) : fromISO;
  const de = endDate.replace(/-/g, '');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const text = `Open My 100 Days and check in: ${title}`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//My 100 Days//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid()}@my100days`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${ds}T${pad(h)}${pad(m)}00`,
    `DTEND:${de}T${pad(endH)}${pad(endM)}00`,
    `RRULE:FREQ=DAILY;COUNT=${Math.max(1, count)}`,
    `SUMMARY:${icsEscape('My 100 Days check-in')}`,
    `DESCRIPTION:${icsEscape(text + (url ? '\n' + url : ''))}`,
    ...(url ? [`URL:${url}`] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape('Time for your 100 Days check-in')}`, 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}
