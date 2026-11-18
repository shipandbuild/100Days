// Pure logic for My 100 Days. No DOM, no IndexedDB: everything here is unit-testable in Node.
//
// Data model (all stored locally in IndexedDB, see db.js):
//   Profile   { id, name, pin: null | {salt, hash}, createdAt }
//   Challenge { id, profileId, title, start: 'YYYY-MM-DD', goals: [Goal], createdAt, why?: string, celebrated?: [milestone day numbers] }
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

/* ---------- habit helpers: streak rescue, hard stretches, milestones, weekly review ---------- */

export const WHY_MAX = 300;
export const MILESTONES = [7, 21, 50, 100];
export const MIN_RESCUE_RUN = 2;   // a streak this long (before the missed day) is worth rescuing

/** Yesterday is unfinished but a run of complete days led up to it: offer to finish it and bring the streak back. */
export function rescueInfo(ch, entries, todayN) {
  if (todayN < 2 || todayN > DAYS) return null;
  const y = todayN - 1;
  const s = dayStatus(ch, entries, y);
  if (s.total === 0 || s.complete) return null;
  let run = 0;
  for (let n = y - 1; n >= 1 && dayStatus(ch, entries, n).complete; n--) run++;
  return run >= MIN_RESCUE_RUN ? { day: y, done: s.done, total: s.total, run } : null;
}

/** The last two days both had goals and neither was finished: time to remind someone why they started. */
export function hardStretch(ch, entries, todayN) {
  if (todayN < 3 || todayN > DAYS) return false;
  return [todayN - 1, todayN - 2].every((n) => {
    const s = dayStatus(ch, entries, n);
    return s.total > 0 && !s.complete;
  });
}

/** The most recent finished week, if its review is still empty. */
export function reviewDue(weeks, todayN) {
  if (todayN < 7) return null;
  const w = todayN >= DAYS ? WEEKS : Math.floor(todayN / 7);
  const wk = weeks[w];
  const blank = !wk || ['win', 'hard', 'learn', 'next'].every((k) => !String(wk[k] || '').trim());
  return blank ? w : null;
}

/** A milestone day that has been reached but not yet celebrated. Older uncelebrated ones are folded into `mark`
 *  so opening the app on day 60 celebrates day 50 once, not 7, 21 and 50 one after another. */
export function dueMilestone(ch, entries, todayN) {
  const reached = MILESTONES.filter((m) => m <= Math.min(todayN, DAYS));
  const seen = new Set(ch.celebrated || []);
  const fresh = reached.filter((m) => !seen.has(m));
  if (!fresh.length) return null;
  const milestone = Math.max(...fresh);
  const stats = computeStats(ch, entries, milestone);   // the numbers as they stood on that day
  if (stats.done === 0) return null;               // nothing checked off yet, nothing to celebrate
  return { milestone, mark: reached, stats };
}

/* ---------- insights (all computed from data already on the device) ---------- */

/** Days whose outcome is settled: everything before today (today is still in progress), or all 100 once finished. */
export const settledDays = (todayN) => clamp(todayN > DAYS ? DAYS : todayN - 1, 0, DAYS);

/** Monday = 0 ... Sunday = 6 */
export const weekdayOf = (iso) => (new Date(utcMs(iso)).getUTCDay() + 6) % 7;

/** Weekday-by-week grid. level: -1 not yet, 0 nothing, 1 under half, 2 half or more, 3 everything. */
export function heatmap(ch, entries, todayN) {
  const offset = weekdayOf(ch.start);
  const cols = Math.ceil((offset + DAYS) / 7);
  const cells = [];
  for (let n = 1; n <= DAYS; n++) {
    const idx = offset + n - 1;
    const s = dayStatus(ch, entries, n);
    let level;
    if (n > todayN) level = -1;
    else if (s.total === 0 || s.done === 0) level = 0;
    else if (s.complete) level = 3;
    else level = s.done / s.total >= 0.5 ? 2 : 1;
    cells.push({ day: n, row: idx % 7, col: Math.floor(idx / 7), level, done: s.done, total: s.total });
  }
  return { cols, offset, cells };
}

/** Completion by weekday over settled days. best/worst are only named when there is a real gap and enough data. */
export function weekdayStats(ch, entries, todayN) {
  const settled = settledDays(todayN);
  const rows = Array.from({ length: 7 }, () => ({ due: 0, done: 0, days: 0, pct: null }));
  for (let n = 1; n <= settled; n++) {
    const s = dayStatus(ch, entries, n);
    if (!s.total) continue;
    const r = rows[weekdayOf(dateOfDay(ch.start, n))];
    r.due += s.total; r.done += s.done; r.days++;
  }
  rows.forEach((r) => { r.pct = r.due ? Math.round((r.done / r.due) * 100) : null; });
  let best = null, worst = null;
  if (settled >= 14) {
    const ok = rows.map((r, i) => [r, i]).filter(([r]) => r.days >= 2);
    if (ok.length >= 2) {
      best = ok.reduce((a, b) => (b[0].pct > a[0].pct ? b : a))[1];
      worst = ok.reduce((a, b) => (b[0].pct < a[0].pct ? b : a))[1];
      if (rows[best].pct - rows[worst].pct < 10) best = worst = null;
    }
  }
  return { rows, best, worst, settled };
}

/** Per active goal: how often it was done, the current run of misses, and the last two weeks of it. */
export function goalStats(ch, entries, todayN) {
  const settled = settledDays(todayN);
  return activeGoals(ch, todayN).map((g) => {
    const days = [];
    for (let n = Math.max(1, g.from); n <= settled && goalApplies(g, n); n++) {
      days.push(!!(entries[n] && entries[n].checks && entries[n].checks[g.id]));
    }
    const count = days.length, done = days.filter(Boolean).length;
    let missRun = 0;
    for (let i = days.length - 1; i >= 0 && !days[i]; i--) missRun++;
    const recent = days.slice(-14);
    const recentDone = recent.filter(Boolean).length;
    return {
      goal: g, count, done, pct: count ? Math.round((done / count) * 100) : null, missRun,
      recentCount: recent.length, recentPct: recent.length ? Math.round((recentDone / recent.length) * 100) : null,
    };
  });
}

/** Gentle nudges. stalled = 3+ misses in a row; struggling = under 40% of the last 14 days; solid = 90%+ of the last 14. */
export function suggestions(stats) {
  const out = [];
  for (const s of stats) {
    if (s.missRun >= 3) out.push({ kind: 'stalled', goal: s.goal, missRun: s.missRun });
    else if (s.recentCount >= 7 && s.recentPct < 40) out.push({ kind: 'struggling', goal: s.goal, pct: s.recentPct });
    else if (s.recentCount >= 14 && s.recentPct >= 90) out.push({ kind: 'solid', goal: s.goal, pct: s.recentPct });
  }
  const order = { stalled: 0, struggling: 1, solid: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, 4);
}

/** Share of check-ins done in the last 7 settled days against the 7 before. Needs two full weeks. */
export function trend(ch, entries, todayN) {
  const settled = settledDays(todayN);
  if (settled < 14) return null;
  const pct = (a, b) => {
    let due = 0, done = 0;
    for (let n = a; n <= b; n++) { const s = dayStatus(ch, entries, n); due += s.total; done += s.done; }
    return due ? Math.round((done / due) * 100) : null;
  };
  const recent = pct(settled - 6, settled), previous = pct(settled - 13, settled - 7);
  return recent == null || previous == null ? null : { recent, previous, delta: recent - previous };
}

/* ---------- backups ---------- */

export function validateBackup(data) {
  const isArr = Array.isArray;
  if (!data || typeof data !== 'object') return 'not an object';
  if (data.app !== 'my100days') return 'unknown format';
  if (!isArr(data.profiles) || !isArr(data.challenges) || !isArr(data.entries) || !isArr(data.weeks)) return 'missing sections';
  if (data.profiles.length === 0) return 'no people in this backup';   // restoring it would wipe the device
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

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const int = (v, lo, hi, fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);

/**
 * Rebuild a backup into clean records before it touches the database. A hand-edited or damaged file can pass
 * validateBackup's structural checks yet still contain things like a null goal that would crash the app on every start.
 * Anything malformed is dropped or repaired, duplicates are removed, and orphaned records are discarded.
 */
export function normalizeBackup(data) {
  const now = Date.now();
  const profiles = [], seenP = new Set();
  for (const p of data.profiles) {
    if (!p || typeof p.id !== 'string' || seenP.has(p.id)) continue;
    seenP.add(p.id);
    const pin = p.pin && typeof p.pin.salt === 'string' && typeof p.pin.hash === 'string' ? { salt: p.pin.salt, hash: p.pin.hash } : null;
    profiles.push({ id: p.id, name: str(p.name, 30).trim() || 'Person', pin, createdAt: num(p.createdAt, now) });
  }
  const challenges = [], seenC = new Set();
  for (const c of data.challenges) {
    if (!c || typeof c.id !== 'string' || seenC.has(c.id) || !seenP.has(c.profileId) || !isValidISO(c.start)) continue;
    seenC.add(c.id);
    const goals = [], seenG = new Set();
    for (const g of Array.isArray(c.goals) ? c.goals : []) {
      if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || seenG.has(g.id)) continue;
      seenG.add(g.id);
      goals.push({ id: g.id, name: str(g.name, 70), from: int(g.from, 1, DAYS + 1, 1), to: g.to == null ? null : int(g.to, 1, DAYS + 1, null) });
    }
    const celebrated = [...new Set((Array.isArray(c.celebrated) ? c.celebrated : []).filter((m) => MILESTONES.includes(m)))].sort((a, b) => a - b);
    challenges.push({ id: c.id, profileId: c.profileId, title: str(c.title, 60).trim() || 'My 100 Days', start: c.start, goals, createdAt: num(c.createdAt, now), why: str(c.why, WHY_MAX).trim(), celebrated });
  }
  const entries = [], seenE = new Set();
  for (const e of data.entries) {
    if (!e || !seenC.has(e.challengeId) || !Number.isInteger(e.day) || e.day < 1 || e.day > DAYS) continue;
    const key = `${e.challengeId}|${e.day}`;
    if (seenE.has(key)) continue;
    seenE.add(key);
    const checks = {};
    if (e.checks && typeof e.checks === 'object' && !Array.isArray(e.checks)) {
      for (const [k, v] of Object.entries(e.checks)) if (v === true) checks[k] = true;
    }
    entries.push({ challengeId: e.challengeId, day: e.day, checks, diary: str(e.diary), gratitude: str(e.gratitude), tomorrow: str(e.tomorrow), updatedAt: num(e.updatedAt, now) });
  }
  const weeks = [], seenW = new Set();
  for (const w of data.weeks) {
    if (!w || !seenC.has(w.challengeId) || !Number.isInteger(w.week) || w.week < 1 || w.week > WEEKS) continue;
    const key = `${w.challengeId}|${w.week}`;
    if (seenW.has(key)) continue;
    seenW.add(key);
    weeks.push({ challengeId: w.challengeId, week: w.week, win: str(w.win), hard: str(w.hard), learn: str(w.learn), next: str(w.next) });
  }
  return { profiles, challenges, entries, weeks };
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
