// My 100 Days: UI and app logic. Runs fully on-device; there are no network calls other than loading the app files.
import * as M from './model.js';
import * as DB from './db.js';

const APP_VERSION = '1.2.0';
const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------------------------------------------ tiny DOM helper (text is always set as text, never HTML) */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'data-focus') el.dataset.focus = v;
    else if (k === 'for') el.htmlFor = v;
    else if (k in el && !k.includes('-')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

/* ------------------------------------------------------------------ state */
const S = {
  mode: 'boot',            // boot | welcome | app | fatal
  profiles: [], profile: null, challenge: null,
  entries: {}, weeks: {}, meta: {},
  attempts: [], tab: 'today', viewDay: 1, viewWeek: 1, reviewMode: 'week',   // reviewMode: 'week' | 'insights'
  locked: false,
  status: 'Saved on this device',
  dismissed: { backup: false, rescue: null, why: null, review: null },
  installEvent: null, updateWorker: null, wantReload: false,
};
// Always read the clock fresh. Never cache "today": an installed app can stay open for days.
let lastSeenISO = M.localISO();   // the date we last drew the screen for (see checkDayRollover)
const todayN = () => (S.challenge ? M.dayNumberFor(S.challenge.start, M.localISO()) : 0);
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/* ------------------------------------------------------------------ toast, dialogs */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/** Show the shared <dialog>. `build(dlg, close)` fills it; resolves with the value passed to close(), or null if dismissed. */
function openDialog(build) {
  return new Promise((resolve) => {
    const dlg = $('#dlg');
    dlg.replaceChildren();
    let value = null;
    const close = (v) => { value = v === undefined ? null : v; if (dlg.open) dlg.close(); };
    dlg.onclose = () => { dlg.onclose = null; dlg.onclick = null; resolve(value); };
    dlg.onclick = (e) => { if (e.target === dlg) close(null); };
    build(dlg, close);
    dlg.showModal();
  });
}

function askText({ title, label, value = '', placeholder = '', type = 'text', inputmode, maxLength = 60, okText = 'Save', hint, pattern, patternMsg }) {
  return openDialog((dlg, close) => {
    const err = h('p', { class: 'err', role: 'alert' });
    const input = h('input', { type, value, placeholder, maxLength, inputmode, autocomplete: 'off', 'aria-label': label || title, spellcheck: false });
    dlg.append(h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) { err.textContent = 'Please enter something.'; return; }
        if (pattern && !pattern.test(v)) { err.textContent = patternMsg || 'That doesn\'t look right.'; return; }
        close(v);
      },
    },
      h('h3', null, title),
      hint ? h('p', null, hint) : null,
      h('div', { class: 'field' }, label ? h('label', null, label) : null, input),
      err,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, okText)),
    ));
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

function confirmBox({ title, message, okText = 'OK', danger = false }) {
  return openDialog((dlg, close) => {
    dlg.append(
      h('h3', null, title), h('p', null, message),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => close(true) }, okText)),
    );
  }).then((v) => v === true);
}

/* ------------------------------------------------------------------ autosave (state updates instantly, disk write is debounced) */
let saveTimer = null, inflight = 0, saveFailing = false;
let rev = 0;   // bumped by every local change, so a slow background refresh can tell it has gone stale
const dirty = new Set();

function setStatus(text) {
  S.status = text;
  const el = $('#saveStatus');
  if (el) el.textContent = text;
}
function markDirty(kind, key = '') {
  rev++;
  dirty.add(`${kind}:${key}`);
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}
async function flush() {
  clearTimeout(saveTimer);
  if (!dirty.size) return;
  const keys = [...dirty]; dirty.clear();
  inflight++;
  try {
    for (const k of keys) {
      const [kind, key] = k.split(':');
      if (kind === 'entry' && S.entries[key]) await saveEntryMerged(+key);
      else if (kind === 'week' && S.weeks[key]) await saveWeekMerged(+key);
      else if (kind === 'challenge') await DB.put('challenges', S.challenge);
    }
    saveFailing = false;
    if (!dirty.size) setStatus('Saved on this device');
  } catch (e) {
    console.error(e);
    keys.forEach((k) => dirty.add(k));            // keep the unsaved changes and try again shortly
    setStatus('Not saved');
    if (!saveFailing) toast('Couldn\'t save. Storage may be full or blocked. Retrying, and you can back up from Settings.');
    saveFailing = true;
    clearTimeout(saveTimer); saveTimer = setTimeout(flush, 5000);
  } finally { inflight--; }
}
const saveChallenge = async () => { markDirty('challenge'); await flush(); };

function ensureEntry(day) {
  return S.entries[day] || (S.entries[day] = { challengeId: S.challenge.id, day, checks: {}, diary: '', gratitude: '', tomorrow: '', updatedAt: Date.now() });
}
function ensureWeek(w) {
  return S.weeks[w] || (S.weeks[w] = { challengeId: S.challenge.id, week: w, win: '', hard: '', learn: '', next: '' });
}

/* Field-level saving. If another window changed the same day meanwhile, writing this window's whole copy would undo it.
   So we remember exactly which fields/checkboxes THIS window changed, and on save re-read the latest record and apply only those. */
const touchedEntries = {};   // day  -> { fields: Set, checks: Map(goalId -> bool) }
const touchedWeeks = {};     // week -> Set(fields)
const newTouch = () => ({ fields: new Set(), checks: new Map() });
function touchField(day, f) { (touchedEntries[day] || (touchedEntries[day] = newTouch())).fields.add(f); }
function touchCheck(day, id, v) { (touchedEntries[day] || (touchedEntries[day] = newTouch())).checks.set(id, v); }
function touchWeek(w, f) { (touchedWeeks[w] || (touchedWeeks[w] = new Set())).add(f); }

async function saveEntryMerged(day) {
  const mine = S.entries[day];
  const t = touchedEntries[day]; delete touchedEntries[day];          // take ownership; put back if the write fails
  try {
    const latest = t ? await DB.get('entries', [mine.challengeId, day]) : null;
    let out = mine;
    if (latest) {
      out = { ...latest, checks: { ...latest.checks } };
      for (const f of t.fields) out[f] = mine[f];
      for (const [id, v] of t.checks) { if (v) out.checks[id] = true; else delete out.checks[id]; }
      out.updatedAt = Date.now();
    }
    await DB.put('entries', out);
    const sameAsMine = out.diary === mine.diary && out.gratitude === mine.gratitude && out.tomorrow === mine.tomorrow &&
      JSON.stringify(Object.keys(out.checks).sort()) === JSON.stringify(Object.keys(mine.checks).sort());
    if (!sameAsMine) needsRefresh = true;                             // another window had changes we don't show yet
  } catch (e) {
    if (t) { const cur = touchedEntries[day] || (touchedEntries[day] = newTouch()); t.fields.forEach((f) => cur.fields.add(f)); t.checks.forEach((v, id) => { if (!cur.checks.has(id)) cur.checks.set(id, v); }); }
    throw e;
  }
}
async function saveWeekMerged(w) {
  const mine = S.weeks[w];
  const t = touchedWeeks[w]; delete touchedWeeks[w];
  try {
    const latest = t ? await DB.get('weeks', [mine.challengeId, w]) : null;
    let out = mine;
    if (latest) { out = { ...latest }; for (const f of t) out[f] = mine[f]; }
    await DB.put('weeks', out);
    if (['win', 'hard', 'learn', 'next'].some((f) => out[f] !== mine[f])) needsRefresh = true;
  } catch (e) {
    if (t) { const cur = touchedWeeks[w] || (touchedWeeks[w] = new Set()); t.forEach((f) => cur.add(f)); }
    throw e;
  }
}

/** Goals and profiles are small and edited by discrete actions: adopt the latest copy first, then apply the change to it. */
async function mutateChallenge(fn) {
  rev++;
  const latest = await DB.get('challenges', S.challenge.id);
  if (latest) S.challenge = latest;
  fn(S.challenge);
  await saveChallenge();
}
async function mutateProfile(fn) {
  rev++;
  const latest = await DB.get('profiles', S.profile.id);
  if (latest) { S.profile = latest; S.profiles = S.profiles.map((x) => (x.id === latest.id ? latest : x)); }
  fn(S.profile);
  await DB.put('profiles', S.profile);
}

/* ------------------------------------------------------------------ PIN (casual privacy lock, not encryption) */
const pinSupported = () => !!(globalThis.crypto && crypto.subtle);
async function hashPin(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const checkPin = async (profile, pin) => !!profile.pin && (await hashPin(pin, profile.pin.salt)) === profile.pin.hash;
async function makePin(pin) {
  const salt = M.uid();
  return { salt, hash: await hashPin(pin, salt) };
}

/* ------------------------------------------------------------------ loading data */
async function selectProfile(p, { lock = false } = {}) {
  rev++;
  await flush();
  dirty.clear(); clearTimeout(saveTimer);   // never carry unsaved keys of the previous person into the next one
  const chs = await DB.challengesOfProfile(p.id);
  let ch = M.currentChallenge(chs);
  S.attempts = chs.filter((c) => c.endedAt).sort((a, b) => (a.attempt || 1) - (b.attempt || 1));
  if (!ch) {
    ch = { id: M.uid(), profileId: p.id, title: 'My 100 Days', start: M.localISO(), goals: [], createdAt: Date.now(), why: '', celebrated: [] };
    await DB.put('challenges', ch);
  }
  const [entries, weeks] = await Promise.all([DB.entriesOfChallenge(ch.id), DB.weeksOfChallenge(ch.id)]);
  S.profile = p; S.challenge = ch;
  S.entries = Object.fromEntries(entries.map((e) => [e.day, e]));
  S.weeks = Object.fromEntries(weeks.map((w) => [w.week, w]));
  lastSeenISO = M.localISO();
  S.viewDay = M.clamp(todayN(), 1, M.DAYS);
  S.viewWeek = M.clamp(M.weekOfDay(S.viewDay), 1, M.WEEKS);
  S.tab = 'today'; S.reviewMode = 'week';
  S.dismissed.rescue = S.dismissed.why = S.dismissed.review = null;   // these are keyed by day/week number, so never carry them to another person
  S.locked = !!(lock && p.pin);
  S.mode = 'app';
  S.status = 'Saved on this device';
  await DB.setMeta('activeProfile', p.id); S.meta.activeProfile = p.id;
  render();
}

async function createPerson({ name, title, start, why = '' }) {
  const profile = { id: M.uid(), name, pin: null, createdAt: Date.now() };
  const challenge = { id: M.uid(), profileId: profile.id, title, start, goals: [], createdAt: Date.now(), why: why.slice(0, M.WHY_MAX), celebrated: [] };
  await DB.addRecords({ profile, challenge, entries: [], weeks: [] });
  S.profiles.push(profile);
  return profile;
}

async function reloadFromDB() {
  S.profiles = (await DB.getAll('profiles')).sort((a, b) => a.createdAt - b.createdAt);
  S.meta.lastBackup = await DB.getMeta('lastBackup');
  S.meta.reminderTime = await DB.getMeta('reminderTime');
  S.meta.dismissIosHint = await DB.getMeta('dismissIosHint');
  return DB.getMeta('activeProfile');
}

async function boot() {
  try { await DB.openDB(); }
  catch (e) { console.error(e); S.mode = 'fatal'; S.fatal = e; render(); return; }    // storage itself is unavailable
  try {
    const activeId = await reloadFromDB();
    if (!S.profiles.length) { S.mode = 'welcome'; render(); }
    else await selectProfile(S.profiles.find((p) => p.id === activeId) || S.profiles[0], { lock: true });
  } catch (e) { console.error(e); showCrash(e); }
  setupPWA();   // always register, so even a broken version can be replaced by a fixed one
}

/* ------------------------------------------------------------------ rendering */
// Safety net: if drawing ever throws (e.g. unexpected data), show a recovery screen instead of a blank page.
function render() {
  try { renderNow(); } catch (e) { console.error(e); showCrash(e); }
}
function showCrash(e) {
  $('#nav').hidden = true;
  $('#root').replaceChildren(h('div', { class: 'welcome' },
    h('h1', null, 'Something went wrong'),
    h('p', { class: 'muted' }, 'The app hit an unexpected problem. Your saved data is still on this device. You can save a copy of it, then reload.'),
    h('p', { class: 'tiny muted' }, String((e && e.message) || e)),
    h('div', { class: 'save-row', style: 'justify-content:flex-start;flex-wrap:wrap' },
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload'),
      h('button', { class: 'btn', onclick: backupNow }, 'Save a copy of my data'))));
}

function renderNow() {
  const root = $('#root'), nav = $('#nav');
  const focusId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : null;
  if (S.mode === 'fatal') { nav.hidden = true; root.replaceChildren(fatalView()); return; }
  if (S.mode === 'welcome') { nav.hidden = true; root.replaceChildren(welcomeView()); return; }
  if (S.mode !== 'app') return;
  if (S.locked) { nav.hidden = true; root.replaceChildren(lockView()); return; }
  nav.hidden = false;
  const views = { today: todayView, calendar: calendarView, goals: goalsView, review: reviewTab, settings: settingsView };
  root.replaceChildren(headerView(), bannersView(), heroView(), views[S.tab]());
  renderNav();
  scheduleCelebrate();
  if (focusId) {
    const el = root.querySelector(`[data-focus="${CSS.escape(focusId)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

const ICONS = {
  today: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  goals: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  review: '<path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4z"/><path d="M9 9h6M9 13h6"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
};
const TABS = [['today', 'Today'], ['calendar', 'Calendar'], ['goals', 'Goals'], ['review', 'Review'], ['settings', 'Settings']];
function renderNav() {
  const inner = h('div', { class: 'inner' }, TABS.map(([id, label]) => {
    const b = h('button', { class: 'tab', 'aria-current': S.tab === id ? 'page' : null, onclick: () => go(id) });
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg>`; // static markup only
    b.append(label);
    return b;
  }));
  $('#nav').replaceChildren(inner);
}
// Tapping the Today tab always lands on today; the calendar passes keepDay to open the specific day you tapped.
function go(tab, { keepDay = false } = {}) {
  flush();
  if (tab === 'today' && !keepDay) S.viewDay = M.clamp(todayN(), 1, M.DAYS);
  S.tab = tab; render(); window.scrollTo(0, 0);
}

function headerView() {
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      h('div', { class: 'mark', 'aria-hidden': 'true' }, '100'),
      h('div', { style: 'min-width:0' }, h('h1', null, S.challenge.title), h('div', { class: 'sub' }, 'A little progress, every day.'))),
    h('button', { class: 'chip', onclick: openProfiles, 'aria-label': `Switch person. Current: ${S.profile.name}` },
      h('span', { class: 'avatar' }, initial(S.profile.name)), h('span', { class: 'name' }, S.profile.name)),
  );
}
const initial = (name) => (name.trim()[0] || '?').toUpperCase();

function heroView() {
  const ch = S.challenge, tn = todayN(), st = M.computeStats(ch, S.entries, tn);
  const big = tn < 1 ? `Starts in ${1 - tn} day${tn === 0 ? '' : 's'}` : tn > M.DAYS ? 'Challenge complete' : `Day ${tn} of ${M.DAYS}`;
  const range = `${M.formatISO(ch.start)} – ${M.formatISO(M.dateOfDay(ch.start, M.DAYS))}`;
  const pct = M.clamp(tn, 0, M.DAYS);
  return h('section', { class: 'hero' },
    h('div', { class: 'eyebrow' }, ch.attempt > 1 ? `Your journey · Attempt ${ch.attempt}` : 'Your journey'),
    h('h2', null, big),
    h('p', null, range),
    h('div', { class: 'track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': M.DAYS, 'aria-valuenow': pct, 'aria-label': 'Days elapsed' }, h('div', { class: 'fill', style: `width:${pct}%` })),
    h('div', { class: 'stats' },
      stat(st.streak, 'day streak'), stat(st.best, 'best streak'), stat(st.due ? st.pct + '%' : '–', 'check-ins')),
  );
}
const stat = (n, label) => h('div', { class: 'stat' }, h('b', null, n), h('span', null, label));

function bannersView() {
  const wrap = h('div', null);
  if (S.updateWorker) {
    wrap.append(h('div', { class: 'banner' }, h('p', null, 'A new version is ready.'),
      h('button', { class: 'btn small primary', onclick: applyUpdate }, 'Refresh')));
  }
  if (S.installEvent) {
    wrap.append(h('div', { class: 'banner' }, h('p', null, 'Install this app on your phone for quick access and offline use.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: promptInstall }, 'Install'),
        h('button', { class: 'btn small', onclick: () => { S.installEvent = null; render(); } }, 'Not now'))));
  } else if (isIOS() && !isStandalone() && !S.meta.dismissIosHint) {
    wrap.append(h('div', { class: 'banner' }, h('p', null, 'To install: tap the Share button, then “Add to Home Screen”. Installed apps keep their data safest on iPhone.'),
      h('button', { class: 'btn small', onclick: async () => { S.meta.dismissIosHint = true; await DB.setMeta('dismissIosHint', true); render(); } }, 'Got it')));
  }
  const hasData = Object.keys(S.entries).length > 0;
  const stale = !S.meta.lastBackup || Date.now() - S.meta.lastBackup > 7 * 864e5;
  if (hasData && stale && !S.dismissed.backup) {
    wrap.append(h('div', { class: 'banner' },
      h('p', null, S.meta.lastBackup ? 'It\'s been a week since your last backup.' : 'Your diary lives only on this phone. Save a backup copy so it can\'t be lost.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: backupNow }, 'Back up'),
        h('button', { class: 'btn small', onclick: () => { S.dismissed.backup = true; render(); } }, 'Later'))));
  }
  return wrap;
}

/* ----- Today */
function todayView() {
  const ch = S.challenge, n = S.viewDay, tn = todayN();
  const iso = M.dateOfDay(ch.start, n);
  const future = n > tn;
  const entry = S.entries[n] || { checks: {} };
  const goals = M.goalsForDay(ch, n);
  const done = goals.filter((g) => entry.checks[g.id]).length;
  const title = n === tn ? 'Today' : future ? 'Coming up' : n === 1 ? 'The beginning' : n === M.DAYS ? 'The final day' : 'Looking back';
  const jumpTo = M.clamp(tn, 1, M.DAYS);
  const prevTomorrow = n > 1 && S.entries[n - 1] && S.entries[n - 1].tomorrow ? S.entries[n - 1].tomorrow : '';

  const nav = h('section', { class: 'panel' },
    h('div', { class: 'daynav' },
      h('button', { class: 'btn small', disabled: n === 1, onclick: () => gotoDay(n - 1), 'aria-label': 'Previous day' }, '← Prev'),
      h('div', { class: 'center' },
        h('div', { class: 'daynum' }, `Day ${n} of ${M.DAYS}`),
        h('div', { class: 'daytitle' }, title),
        h('div', { class: 'date' }, M.formatISO(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))),
      h('button', { class: 'btn small', disabled: n === M.DAYS, onclick: () => gotoDay(n + 1), 'aria-label': 'Next day' }, 'Next →')),
    n !== jumpTo ? h('div', { class: 'jump' }, h('button', { class: 'btn link', onclick: () => gotoDay(jumpTo) }, tn < 1 ? 'Back to Day 1' : 'Jump to today')) : null,
  );

  const hasAnyGoal = ch.goals.length > 0;
  const list = h('div', { class: 'task-list' }, goals.map((g) => {
    const checked = !!entry.checks[g.id];
    const cb = h('input', {
      type: 'checkbox', checked, disabled: future, 'data-focus': 'goal-' + g.id,
      onchange: () => {
        const en = ensureEntry(n);
        if (cb.checked) en.checks[g.id] = true; else delete en.checks[g.id];
        en.updatedAt = Date.now();
        touchCheck(n, g.id, cb.checked);
        markDirty('entry', n); render();
      },
    });
    return h('label', { class: 'task' + (checked ? ' done' : '') + (future ? ' locked' : '') }, cb, h('span', { class: 'task-name' }, g.name));
  }));

  const goalsPanel = h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Goals for this day'), goals.length ? h('span', { class: 'tiny muted' }, `${done} / ${goals.length} done`) : null),
    goals.length ? list
      : h('div', { class: 'empty' }, hasAnyGoal ? 'No goals were set for this day.' : 'No goals yet. Add your first one to get started.',
        !hasAnyGoal ? h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: () => go('goals') }, 'Add a goal')) : null),
    future ? h('div', { class: 'note' }, tn < 1 ? `Your challenge starts on ${M.formatISO(ch.start)}.` : 'This day hasn\'t arrived yet. You can fill it in once it does.') : null,
    prevTomorrow && !future ? h('div', { class: 'note' }, h('b', null, 'Yesterday you planned:'), h('div', { class: 'quote' }, prevTomorrow)) : null,
  );

  const field = (id, label, key, rows, placeholder) => h('div', { class: 'field' },
    h('label', { for: id }, label),
    h('textarea', {
      id, rows, placeholder, value: entry[key] || '', disabled: future,
      oninput: (e) => { const en = ensureEntry(n); en[key] = e.target.value; en.updatedAt = Date.now(); touchField(n, key); markDirty('entry', n); },
    }));

  const diary = h('section', { class: 'panel' },
    h('h3', null, 'Your daily diary'),
    field('diary', 'How was today? What happened?', 'diary', 5, 'Write freely. A few honest lines are enough…'),
    field('gratitude', 'One thing I\'m grateful for', 'gratitude', 2, 'Today, I\'m grateful for…'),
    field('tomorrow', 'Tomorrow, I want to…', 'tomorrow', 2, 'One small intention for tomorrow…'),
    h('p', { class: 'tiny muted', id: 'saveStatus', 'aria-live': 'polite' }, S.status),
  );
  return h('div', null, habitCards(), nav, goalsPanel, diary);
}
async function gotoDay(n) { await flush(); S.viewDay = M.clamp(n, 1, M.DAYS); render(); window.scrollTo(0, 0); }

/* ----- Calendar */
function calendarView() {
  const ch = S.challenge, tn = todayN();
  const grid = h('div', { class: 'calendar' });
  for (let n = 1; n <= M.DAYS; n++) {
    const s = M.dayStatus(ch, S.entries, n);
    const cls = ['calday'];
    if (n > tn) cls.push('future');
    else if (s.complete) cls.push('complete');
    else if (s.done > 0) cls.push('partial');
    if (n === tn) cls.push('current');
    grid.append(h('button', {
      class: cls.join(' '), 'aria-label': `Day ${n}, ${M.formatISO(M.dateOfDay(ch.start, n))}${s.total ? `, ${s.done} of ${s.total} goals done` : ''}${n === tn ? ', today' : ''}`,
      onclick: () => { S.viewDay = n; go('today', { keepDay: true }); },
    }, n));
  }
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Your 100 days'), h('span', { class: 'tiny muted' }, 'Tap a day to open it')),
    grid,
    h('div', { class: 'legend' }, h('span', null, h('i', { class: 'g' }), 'All goals done'), h('span', null, h('i', { class: 'y' }), 'Some done'), h('span', null, h('i'), 'None / not yet')),
  );
}

/* ----- Goals */
function goalsView() {
  const ch = S.challenge, tn = todayN();
  const active = M.activeGoals(ch, tn), past = M.pastGoals(ch, tn);
  const rows = active.map((g) => {
    const input = h('input', { type: 'text', value: g.name, maxLength: 70, 'aria-label': 'Goal name' });
    return h('form', {
      class: 'manage-row',
      onsubmit: async (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) return toast('Enter a goal name');
        await mutateChallenge((c) => { const t = c.goals.find((x) => x.id === g.id); if (t) t.name = v; });
        render(); toast('Goal updated');
      },
    }, input,
      h('button', { type: 'submit', class: 'btn small' }, 'Save'),
      h('button', {
        type: 'button', class: 'btn small danger',
        onclick: async () => {
          const ok = await confirmBox({ title: `Stop “${g.name}”?`, message: tn >= 1 ? 'It will stop from today onward. Earlier days keep it, so your history stays intact.' : 'It will be removed.', okText: 'Stop goal', danger: true });
          if (!ok) return;
          await mutateChallenge((c) => M.retireGoal(c, g.id, todayN()));
          render(); toast('Goal stopped');
        },
      }, 'Remove'));
  });

  const nameInput = h('input', { type: 'text', maxLength: 70, placeholder: 'e.g. Walk for 30 minutes', 'aria-label': 'New goal' });
  const past1 = h('input', { type: 'checkbox', id: 'includePast' });
  const showPastOpt = tn > 1 && tn <= M.DAYS;
  let adding = false;   // a double-tap must not add the goal twice
  const addForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (adding) return;
      const name = nameInput.value.trim();
      if (!name) return toast('Type a goal first');
      if (active.length >= M.MAX_ACTIVE_GOALS) return toast(`You can have up to ${M.MAX_ACTIVE_GOALS} goals`);
      adding = true; nameInput.value = '';
      const includePast = showPastOpt && past1.checked;
      await mutateChallenge((c) => M.addGoal(c, name, todayN(), includePast));
      render(); toast('Goal added');
    },
  },
    h('div', { class: 'add-row' }, nameInput, h('button', { type: 'submit', class: 'btn primary' }, 'Add')),
    showPastOpt ? h('label', { class: 'check-row', for: 'includePast' }, past1, 'Count it for earlier days too (from Day 1)') : null);

  const panels = [h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'My goals'), h('span', { class: 'tiny muted' }, `${active.length} of ${M.MAX_ACTIVE_GOALS}`)),
    h('p', { class: 'tiny muted', style: 'margin:0 0 12px' }, 'Pick the habits you want to work on. A new goal counts from today, and removing one never changes your past days.'),
    active.length ? h('div', { class: 'manage' }, rows) : h('div', { class: 'empty' }, 'No goals yet. Start with one small habit.'),
    addForm)];
  if (past.length) {
    panels.push(h('section', { class: 'panel' }, h('h3', null, 'Earlier goals'),
      h('p', { class: 'tiny muted' }, 'These stopped, but they still count in the days they were active.'),
      h('div', { style: 'margin-top:8px' }, past.map((g) => h('div', { class: 'past-row' }, h('span', null, g.name), h('span', { class: 'muted' }, `Days ${g.from}–${g.to - 1}`))))));
  }
  return h('div', null, panels);
}

/* ----- Weekly review */
function reviewView() {
  const ch = S.challenge, tn = todayN(), w = S.viewWeek;
  const [a, b] = M.weekRange(w);
  const future = a > tn;
  const wk = S.weeks[w] || {};
  const ws = M.weekStats(ch, S.entries, w, tn);
  const field = (key, label, placeholder) => h('div', { class: 'field' },
    h('label', { for: 'wk-' + key }, label),
    h('textarea', { id: 'wk-' + key, placeholder, value: wk[key] || '', disabled: future, oninput: (e) => { ensureWeek(w)[key] = e.target.value; touchWeek(w, key); markDirty('week', w); } }));
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Weekly review'),
      h('div', null,
        h('button', { class: 'btn small', disabled: w === 1, onclick: async () => { await flush(); S.viewWeek--; render(); }, 'aria-label': 'Previous week' }, '←'), ' ',
        h('button', { class: 'btn small', disabled: w === M.WEEKS, onclick: async () => { await flush(); S.viewWeek++; render(); }, 'aria-label': 'Next week' }, '→'))),
    h('div', { class: 'daynum' }, `Week ${w}`),
    h('p', { class: 'tiny muted', style: 'margin:2px 0 0' }, `Days ${a}–${b} · ${M.formatISO(M.dateOfDay(ch.start, a))} – ${M.formatISO(M.dateOfDay(ch.start, b))}`),
    ws.days > 0 && ws.due > 0 ? h('div', { class: 'note' }, `${ws.daysComplete} of ${ws.days} day${ws.days === 1 ? '' : 's'} fully complete · ${ws.pct}% of check-ins done`) : null,
    future ? h('div', { class: 'note' }, 'This week hasn\'t started yet.') : null,
    field('win', 'What went well this week?', 'Celebrate your small wins…'),
    field('hard', 'What felt difficult?', 'What got in the way?'),
    field('learn', 'What did I learn about myself?', 'A lesson, a thought, a discovery…'),
    field('next', 'What will I focus on next week?', 'Choose one or two priorities…'),
    h('p', { class: 'tiny muted', id: 'saveStatus', 'aria-live': 'polite' }, S.status),
  );
}

/* ----- Habit helpers on the Today screen: streak rescue, hard-day reminder, weekly review prompt */
function habitCards() {
  const ch = S.challenge, tn = todayN();
  if (S.viewDay !== tn || tn < 1 || tn > M.DAYS) return null;     // only when looking at today
  const cards = [];
  const stalled = M.stalledInfo(ch, S.entries, tn);
  if (stalled) {
    cards.push(h('div', { class: 'banner habit' },
      h('p', null, h('b', null, `${stalled.run} days without a goal ticked. `), 'Want a fresh start from Day 1? Your current run is saved as an earlier attempt, so nothing is lost.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: startOver }, 'Start over from Day 1'),
        h('button', { class: 'btn small', onclick: keepGoing }, 'Keep going where I was'))));
  }
  const r = M.rescueInfo(ch, S.entries, tn);
  if (r && S.dismissed.rescue !== r.day) {
    cards.push(h('div', { class: 'banner habit' },
      h('p', null, h('b', null, `Day ${r.day} is still open. `), `You did ${r.done} of ${r.total}. If you did the rest, tick it off and your streak is back to ${r.run + 1} days.`),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: () => gotoDay(r.day) }, `Open Day ${r.day}`),
        h('button', { class: 'btn small', onclick: () => { S.dismissed.rescue = r.day; render(); } }, 'Not now'))));
  }
  if (!stalled && M.hardStretch(ch, S.entries, tn) && S.dismissed.why !== tn) {
    cards.push(h('div', { class: 'banner habit' },
      ch.why
        ? h('div', { style: 'flex:1 1 200px' }, h('p', null, h('b', null, 'Two hard days in a row. That happens. '), 'Remember why you started:'), h('div', { class: 'quote' }, ch.why))
        : h('p', null, h('b', null, 'Two hard days in a row. That happens. '), 'Write down why you started, so it\'s here when you need it.'),
      h('div', { class: 'row' },
        ch.why ? null : h('button', { class: 'btn small primary', onclick: editWhy }, 'Write it'),
        h('button', { class: 'btn small', onclick: () => { S.dismissed.why = tn; render(); } }, ch.why ? 'Thanks' : 'Not now'))));
  }
  const w = M.reviewDue(S.weeks, tn);
  if (w && S.dismissed.review !== w) {
    cards.push(h('div', { class: 'banner habit' },
      h('p', null, h('b', null, `Week ${w} is done. `), 'Take two minutes to look back on it.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: () => { S.viewWeek = w; S.reviewMode = 'week'; go('review'); } }, 'Start review'),
        h('button', { class: 'btn small', onclick: () => { S.dismissed.review = w; render(); } }, 'Later'))));
  }
  return cards.length ? h('div', null, cards.slice(0, 2)) : null;     // never stack more than two
}

async function keepGoing() {
  const tn = todayN();
  await mutateChallenge((c) => { c.resetSnooze = tn + M.RESET_AFTER; });
  render();
}
/** Save the current run as an earlier attempt and begin a new Day 1 today, with the same active goals. */
async function startOver() {
  const tn = todayN();
  const ok = await confirmBox({
    title: 'Start over from Day 1?',
    message: `Your current run (up to Day ${M.clamp(tn, 1, M.DAYS)}) is saved as an earlier attempt in Settings, so nothing is lost. A new Day 1 starts today with your current goals. If you added a calendar reminder, add a fresh one from Settings.`,
    okText: 'Start over',
  });
  if (!ok) return;
  try {
    await flush();
    rev++;
    await DB.startOver(S.challenge.id, (old) => M.restartPlan(old, M.dayNumberFor(old.start, M.localISO()), Date.now()));
    await selectProfile(S.profile);                     // loads the new attempt (or the one another window just made)
    toast('Fresh start. Day 1 is today.');
  } catch (e) { console.error(e); toast('Couldn\'t start over'); }
}
async function viewAttempt(c) {
  const rows = await DB.entriesOfChallenge(c.id);
  const entries = Object.fromEntries(rows.map((e) => [e.day, e]));
  const st = M.computeStats(c, entries, c.endedDay);
  openDialog((dlg, close) => dlg.append(
    h('h3', null, `Attempt ${c.attempt || 1}`),
    h('p', { class: 'tiny muted' }, `${M.formatISO(c.start)} – ${M.formatISO(M.dateOfDay(c.start, c.endedDay))}. Ended on Day ${c.endedDay}.`),
    h('div', { class: 'stats' }, stat(st.daysComplete, 'full days'), stat(st.best, 'best streak'), stat(st.due ? st.pct + '%' : '–', 'check-ins')),
    h('div', { style: 'margin-top:12px' }, heatBlock(c, entries, c.endedDay)),
    h('p', { class: 'tiny muted' }, 'Diary notes from this attempt are kept on this device and in your backups.'),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', onclick: () => close(null) }, 'Close'))));
}

async function editWhy() {
  const v = await askText({ title: 'Why did you start?', label: 'In your own words', value: S.challenge.why || '', maxLength: M.WHY_MAX, okText: 'Save', hint: 'You\'ll see this on hard days to help you keep going.' });
  if (v == null) return;
  await mutateChallenge((c) => { c.why = v.slice(0, M.WHY_MAX); });
  render(); toast('Saved');
}

/* ----- Milestone celebration (days 7, 21, 50, 100) with an optional share card that never contains diary text */
const MILESTONE_TEXT = {
  7: ['One week in', 'The hardest part is starting, and you did.'],
  21: ['Three weeks in', 'This is where a routine starts to feel normal.'],
  50: ['Halfway there', 'Fifty days of showing up.'],
  100: ['You did it', 'All 100 days. Take a moment to be proud of that.'],
};
let celebrating = false, celebTimer;
function scheduleCelebrate() { clearTimeout(celebTimer); celebTimer = setTimeout(maybeCelebrate, 600); }
async function maybeCelebrate() {
  if (celebrating || S.mode !== 'app' || S.locked || S.tab !== 'today' || $('#dlg').open || isTyping()) return;
  if (M.stalledInfo(S.challenge, S.entries, todayN())) return;          // no party while the "start over?" offer is showing
  const due = M.dueMilestone(S.challenge, S.entries, todayN());
  if (!due) return;
  celebrating = true;
  try {
    // Claim it in one database transaction, so a second open window can't also celebrate the same milestone.
    rev++;
    const celebrated = await DB.update('challenges', S.challenge.id, (c) => {
      const seen = new Set(c.celebrated || []);
      const fresh = !seen.has(due.milestone);
      due.mark.forEach((m) => seen.add(m));
      c.celebrated = [...seen].sort((a, b) => a - b);
      return { fresh, celebrated: c.celebrated };
    });
    if (!celebrated) return;
    S.challenge.celebrated = celebrated.celebrated;
    const fresh = celebrated.fresh;
    if (fresh) await showMilestone(due);
  } catch (e) { console.error(e); }
  finally { celebrating = false; }
}
function showMilestone(due) {
  const [head, line] = MILESTONE_TEXT[due.milestone];
  const st = due.stats;
  return openDialog((dlg, close) => {
    dlg.append(
      h('h3', null, `Day ${due.milestone}: ${head}`),
      h('p', null, line),
      h('div', { class: 'note' }, `${st.daysComplete} fully complete day${st.daysComplete === 1 ? '' : 's'} · best streak ${st.best} · ${st.pct}% of check-ins done`),
      h('p', { class: 'tiny' }, 'The card shows only your challenge name and these numbers. Nothing from your diary or goals.'),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'Close'),
        h('button', { class: 'btn primary', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; await shareCard(due); b.disabled = false; } }, 'Share a card')));
  });
}
async function shareCard(due) {
  try {
    const blob = await renderCard(due);
    if (!blob) return toast('Couldn\'t make the card');
    const file = new File([blob], `my-100-days-day-${due.milestone}.png`, { type: 'image/png' });
    const res = await deliverFile(file, `Day ${due.milestone} of ${M.DAYS}`);
    if (res === 'downloaded') toast('Card saved to your downloads');
  } catch (e) { console.error(e); toast('Couldn\'t make the card'); }
}
function renderCard(due) {
  const W = 1080, c = document.createElement('canvas'); c.width = W; c.height = W;
  const g = c.getContext('2d');
  if (!g) return Promise.resolve(null);
  const grad = g.createLinearGradient(0, 0, W, W); grad.addColorStop(0, '#4a35a0'); grad.addColorStop(1, '#8f74d6');
  g.fillStyle = grad; g.fillRect(0, 0, W, W);
  const font = (px, w = 700) => `${w} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  let title = S.challenge.title, px = 58;                                   // shrink, then trim, so a long title always fits
  g.font = font(px);
  while (g.measureText(title).width > W - 160 && px > 30) { px -= 2; g.font = font(px); }
  if (g.measureText(title).width > W - 160) { while (title.length > 1 && g.measureText(title + '…').width > W - 160) title = title.slice(0, -1); title = title.trimEnd() + '…'; }
  g.fillText(title, W / 2, 170);
  g.font = font(340, 800); g.fillText(String(due.milestone), W / 2, 540);
  g.font = font(56, 600); g.fillText(`of ${M.DAYS} days`, W / 2, 625);
  const st = due.stats, boxes = [[st.daysComplete, 'full days'], [st.best, 'best streak'], [st.pct + '%', 'check-ins']];
  const bw = 270, gap = 30, x0 = (W - (bw * 3 + gap * 2)) / 2;
  boxes.forEach(([val, label], i) => {
    const x = x0 + i * (bw + gap), y = 720, r = 28, bh = 190;
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + bw, y, x + bw, y + bh, r); g.arcTo(x + bw, y + bh, x, y + bh, r); g.arcTo(x, y + bh, x, y, r); g.arcTo(x, y, x + bw, y, r); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.font = font(78, 800); g.fillText(String(val), x + bw / 2, y + 100);
    g.font = font(34, 600); g.fillText(label, x + bw / 2, y + 150);
  });
  g.globalAlpha = 0.85; g.font = font(40, 700); g.fillText('My 100 Days', W / 2, 1010); g.globalAlpha = 1;
  return new Promise((res) => { try { c.toBlob(res, 'image/png'); } catch { res(null); } });
}

/* ----- Review tab: weekly review + insights */
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_PLURAL = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

function reviewTab() {
  const pick = async (mode) => { await flush(); S.reviewMode = mode; render(); };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Review view' },
    h('button', { class: 'segbtn', 'aria-pressed': S.reviewMode === 'week' ? 'true' : 'false', onclick: () => pick('week') }, 'Weekly review'),
    h('button', { class: 'segbtn', 'aria-pressed': S.reviewMode === 'insights' ? 'true' : 'false', onclick: () => pick('insights') }, 'Insights'));
  return h('div', null, seg, S.reviewMode === 'insights' ? insightsView() : reviewView());
}

async function smallerGoal(g) {
  const v = await askText({ title: 'Make it smaller', label: 'New goal', value: g.name, maxLength: 70, okText: 'Start it', hint: 'This starts a new, smaller goal from today. Your history for the old goal stays exactly as it was.' });
  if (v == null || v === g.name) return;
  await mutateChallenge((c) => { M.retireGoal(c, g.id, todayN()); M.addGoal(c, v, todayN(), false); });
  render(); toast('New goal started');
}
async function stopGoal(g) {
  const ok = await confirmBox({ title: `Stop “${g.name}”?`, message: 'It will stop from today onward. Earlier days keep it, so your history stays intact.', okText: 'Stop goal', danger: true });
  if (!ok) return;
  await mutateChallenge((c) => M.retireGoal(c, g.id, todayN()));
  render(); toast('Goal stopped');
}

/** The weekday-by-week grid plus its legend. Shared by Insights and the earlier-attempt viewer. */
function heatBlock(ch, entries, tn) {
  const hm = M.heatmap(ch, entries, tn);
  const grid = h('div', { class: 'heat', role: 'img', 'aria-label': 'Grid of your 100 days by weekday and week. Darker green means more goals done that day.', style: `grid-template-columns:30px repeat(${hm.cols},minmax(0,1fr))` });
  DAY_SHORT.forEach((d, r) => { if (r % 2 === 0) grid.append(h('span', { class: 'hlabel', style: `grid-row:${r + 1};grid-column:1` }, d)); });
  hm.cells.forEach((c) => grid.append(h('span', {
    class: 'hcell ' + (c.level < 0 ? 'lf' : 'l' + c.level), style: `grid-row:${c.row + 1};grid-column:${c.col + 2}`,
    title: `Day ${c.day}, ${M.formatISO(M.dateOfDay(ch.start, c.day))}${c.total ? `: ${c.done} of ${c.total} goals` : ''}`,
  })));
  return h('div', null, grid,
    h('div', { class: 'legend' }, h('span', null, 'Fewer goals'),
      ['l0', 'l1', 'l2', 'l3'].map((l) => h('span', { class: 'hcell ' + l, 'aria-hidden': 'true' })), h('span', null, 'More')));
}

function insightsView() {
  const ch = S.challenge, tn = todayN(), settled = M.settledDays(tn);
  if (!ch.goals.length || settled < 3) {
    return h('section', { class: 'panel' }, h('h3', null, 'Insights'),
      h('div', { class: 'empty' }, !ch.goals.length ? 'Add a goal and check in for a few days. Patterns will show up here.' : 'Patterns show up after about three days of check-ins. Keep going.'));
  }
  const panels = [];

  const tr = M.trend(ch, S.entries, tn);
  if (tr) {
    const d = tr.delta;
    panels.push(h('section', { class: 'panel' }, h('h3', null, 'Last 7 days'),
      h('p', null, h('b', null, `${tr.recent}%`), ' of check-ins done. ', d > 0 ? `That's up ${d} points from the week before.` : d < 0 ? `That's down ${-d} points from the week before.` : 'Same as the week before.')));
  }

  const stats = M.goalStats(ch, S.entries, tn);
  const sg = tn <= M.DAYS ? M.suggestions(stats) : [];
  if (sg.length) {
    panels.push(h('section', { class: 'panel' }, h('h3', null, 'Worth a look'),
      sg.map((s) => {
        const name = `“${s.goal.name}”`;
        if (s.kind === 'solid') {
          return h('div', { class: 'sug' }, h('div', null, h('b', null, name), ` is solid: done on ${s.pct}% of the last 14 days.`),
            h('p', { class: 'tiny muted' }, 'Ready for something bigger? You could raise the bar or add a new goal.'),
            h('div', { class: 'row' }, h('button', { class: 'btn small primary', onclick: () => go('goals') }, 'Open goals')));
        }
        const what = s.kind === 'stalled' ? `has been missed ${s.missRun} days in a row.` : `was done on only ${s.pct}% of the last 14 days.`;
        return h('div', { class: 'sug' }, h('div', null, h('b', null, name), ' ', what),
          h('p', { class: 'tiny muted' }, 'A smaller version is easier to keep, for example 10 minutes instead of 30. Or you can set it aside for now.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn small primary', onclick: () => smallerGoal(s.goal) }, 'Make it smaller'),
            h('button', { class: 'btn small', onclick: () => stopGoal(s.goal) }, 'Stop this goal')));
      })));
  } else if (tn <= M.DAYS) {
    panels.push(h('section', { class: 'panel' }, h('h3', null, 'Worth a look'), h('p', { class: 'tiny muted' }, 'Nothing to change right now. Keep going.')));
  }

  panels.push(h('section', { class: 'panel' }, h('h3', null, 'Your 100 days'),
    h('p', { class: 'tiny muted' }, 'Each column is a week, Monday to Sunday.'),
    h('div', { style: 'margin-top:10px' }, heatBlock(ch, S.entries, tn))));

  const wd = M.weekdayStats(ch, S.entries, tn);
  panels.push(h('section', { class: 'panel' }, h('h3', null, 'By weekday'),
    h('p', { class: 'tiny' }, wd.best != null
      ? `You're strongest on ${DAY_PLURAL[wd.best]} (${wd.rows[wd.best].pct}%) and ${DAY_PLURAL[wd.worst]} are the hardest (${wd.rows[wd.worst].pct}%).`
      : wd.settled < 14 ? 'Come back after two weeks for a clearer picture.' : 'No clear weekday pattern. You\'re fairly steady across the week.'),
    h('div', { style: 'margin-top:6px' }, wd.rows.map((r, i) => h('div', { class: 'brow' },
      h('span', { class: 'bl' }, DAY_SHORT[i]),
      h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${r.pct || 0}%` })),
      h('span', { class: 'bv' }, r.pct == null ? '–' : r.pct + '%'))))));

  if (stats.length) {
    const ranked = stats.filter((s) => s.count >= 7).sort((a, b) => a.pct - b.pct);
    const spread = ranked.length >= 2 && ranked[ranked.length - 1].pct - ranked[0].pct >= 10;
    panels.push(h('section', { class: 'panel' }, h('h3', null, 'By goal'),
      spread ? h('p', { class: 'tiny' }, `Easiest for you: ${ranked[ranked.length - 1].goal.name}. Hardest: ${ranked[0].goal.name}.`) : null,
      h('div', { style: 'margin-top:6px' }, stats.map((s) => h('div', { class: 'grow' },
        h('div', { class: 'gname' }, s.goal.name),
        h('div', { class: 'brow' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${s.pct || 0}%` })),
          h('span', { class: 'bv wide' }, s.count ? `${s.done}/${s.count} days` : 'new')))))));
  }

  panels.push(h('p', { class: 'tiny muted' }, 'Insights count finished days only, so today never counts against you. Everything is worked out on this device.'));
  return h('div', null, panels);
}

/* ----- Settings */
function settingsView() {
  const ch = S.challenge, p = S.profile;
  const titleIn = h('input', { type: 'text', id: 'titleIn', value: ch.title, maxLength: 60, placeholder: 'My 100-day challenge' });
  const startIn = h('input', { type: 'date', id: 'startIn', value: ch.start });
  const whyIn = h('textarea', { id: 'whyIn', rows: 3, maxLength: M.WHY_MAX, placeholder: 'Why are you doing this? You\'ll see it on hard days.', value: ch.why || '' });
  const timeIn = h('input', { type: 'time', id: 'timeIn', value: S.meta.reminderTime || '21:00' });
  const persistNote = h('span', { class: 'tiny muted' }, 'Checking…');
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((v) => { persistNote.textContent = v ? 'Protected: the browser won\'t clear it to free space.' : 'Not locked in. Install to your home screen and back up regularly.'; });
  } else persistNote.textContent = 'Not available in this browser.';

  const challenge = h('section', { class: 'panel' }, h('h3', null, 'Challenge'),
    h('div', { class: 'field' }, h('label', { for: 'titleIn' }, 'Challenge name'), titleIn),
    h('div', { class: 'field' }, h('label', { for: 'startIn' }, 'Start date'), startIn),
    h('div', { class: 'field' }, h('label', { for: 'whyIn' }, 'Why I started'), whyIn),
    h('div', { class: 'save-row' }, h('span', { class: 'tiny muted' }, `Length: ${M.DAYS} days`),
      h('button', {
        class: 'btn primary', onclick: async () => {
          const title = titleIn.value.trim() || 'My 100 Days', start = startIn.value;
          if (!M.isValidISO(start)) return toast('Choose a start date');
          if (start !== ch.start && Object.keys(S.entries).length) {
            const ok = await confirmBox({ title: 'Change the start date?', message: 'Your diary entries stay attached to their day numbers, so their dates will shift with the new start date.', okText: 'Change date' });
            if (!ok) return;
          }
          const why = whyIn.value.trim().slice(0, M.WHY_MAX);
          await mutateChallenge((c) => { c.title = title; c.start = start; c.why = why; });
          S.viewDay = M.clamp(todayN(), 1, M.DAYS); render(); toast('Settings saved');
        },
      }, 'Save')));

  const onAndroid = /Android/i.test(navigator.userAgent);
  const saveTime = async () => { S.meta.reminderTime = timeIn.value || '21:00'; await DB.setMeta('reminderTime', S.meta.reminderTime); };
  const googleBtn = (primary) => h('button', { class: 'btn' + (primary ? ' primary' : ''), onclick: async () => { await saveTime(); addGoogleReminder(); } }, 'Add to Google Calendar');
  const fileBtn = (primary) => h('button', { class: 'btn' + (primary ? ' primary' : ''), onclick: async () => { await saveTime(); addReminder(); } }, primary ? 'Add to calendar' : 'Download calendar file');
  const reminder = h('section', { class: 'panel' }, h('h3', null, 'Daily reminder'),
    h('p', { class: 'tiny muted' }, onAndroid
      ? 'Opens Google Calendar with a daily event for the days you have left already filled in. Tap Save there. Nothing is sent anywhere, and you can edit or delete the event in Calendar.'
      : 'Adds a repeating event with an alert to your phone\'s Calendar for the days you have left. Nothing is sent anywhere. You can edit or delete it in your Calendar app.'),
    h('div', { class: 'field' }, h('label', { for: 'timeIn' }, 'Remind me at'), timeIn),
    h('div', { class: 'save-row', style: 'justify-content:flex-start;flex-wrap:wrap' }, onAndroid ? [googleBtn(true), fileBtn(false)] : [fileBtn(true), googleBtn(false)]),
    onAndroid ? h('p', { class: 'tiny muted' }, 'Google Calendar may alert you 10 minutes early. To change that, open the event and edit Notifications. The "Download calendar file" button is for calendar apps other than Google Calendar: open the file from your Downloads.') : null);

  const lastB = S.meta.lastBackup ? new Date(S.meta.lastBackup).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  const backup = h('section', { class: 'panel' }, h('h3', null, 'Backup & restore'),
    h('p', { class: 'tiny muted' }, `Last backup: ${lastB}. A backup includes everyone on this device. Save it to Files, iCloud, Google Drive or send it to yourself.`),
    h('div', { class: 'save-row', style: 'justify-content:flex-start;flex-wrap:wrap' },
      h('button', { class: 'btn primary', onclick: backupNow }, 'Back up now'),
      h('button', { class: 'btn', onclick: () => $('#restoreFile').click() }, 'Restore from backup…')));

  const people = h('section', { class: 'panel' }, h('h3', null, `${p.name}'s profile`),
    h('div', { class: 'save-row', style: 'justify-content:flex-start;flex-wrap:wrap' },
      h('button', { class: 'btn', onclick: renamePerson }, 'Rename'),
      pinSupported() ? h('button', { class: 'btn', onclick: setOrChangePin }, p.pin ? 'Change PIN' : 'Set a PIN') : null,
      pinSupported() && p.pin ? h('button', { class: 'btn', onclick: removePin }, 'Remove PIN') : null,
      h('button', { class: 'btn', onclick: addPerson }, 'Add another person'),
      h('button', { class: 'btn danger', disabled: S.profiles.length < 2, onclick: deletePerson, title: S.profiles.length < 2 ? 'You need at least one person' : '' }, 'Delete this person')),
    h('p', { class: 'tiny muted' }, 'A PIN keeps casual snoopers out when a phone or tablet is shared. It locks after a minute away. It is not encryption, so use your phone\'s own lock for real security.'));

  const about = h('section', { class: 'panel' }, h('h3', null, 'About'),
    h('p', { class: 'tiny muted' }, 'My 100 Days stores everything on this device only. There are no accounts, no tracking and no servers holding your diary.'),
    h('p', { class: 'tiny' }, 'Storage: ', persistNote),
    h('p', { class: 'tiny muted' }, `Version ${APP_VERSION}`));

  const attempts = S.attempts.length ? h('section', { class: 'panel' }, h('h3', null, 'Earlier attempts'),
    h('p', { class: 'tiny muted' }, 'Runs you started over from. They stay on this device and in your backups.'),
    S.attempts.map((c) => h('div', { class: 'brow', style: 'justify-content:space-between;flex-wrap:wrap' },
      h('span', null, h('b', null, `Attempt ${c.attempt || 1}`), ` · ${M.formatISO(c.start)} – ${M.formatISO(M.dateOfDay(c.start, c.endedDay))}`),
      h('button', { class: 'btn small', onclick: () => viewAttempt(c) }, 'View')))) : null;

  return h('div', null, challenge, reminder, attempts, backup, people, about);
}

/* ----- welcome / lock / fatal */
function welcomeView() {
  const name = h('input', { type: 'text', id: 'wname', maxLength: 30, placeholder: 'Your name', autocomplete: 'given-name' });
  const title = h('input', { type: 'text', id: 'wtitle', maxLength: 60, value: 'My 100 Days' });
  const start = h('input', { type: 'date', id: 'wstart', value: M.localISO() });
  const why = h('textarea', { id: 'wwhy', rows: 2, maxLength: M.WHY_MAX, placeholder: 'Optional. You\'ll see it on hard days.' });
  let starting = false;   // a double-tap must not create two people
  return h('div', { class: 'welcome' },
    h('div', { class: 'mark', 'aria-hidden': 'true' }, '100'),
    h('h1', null, 'Welcome'),
    h('p', { class: 'muted' }, 'A private 100-day journal and habit tracker. Everything stays on this device.'),
    h('form', {
      class: 'panel', style: 'margin-top:18px',
      onsubmit: async (e) => {
        e.preventDefault();
        if (starting) return;
        const n = name.value.trim();
        if (!n) { name.focus(); return toast('Please enter your name'); }
        if (!M.isValidISO(start.value)) return toast('Choose a start date');
        starting = true;
        try {
          const p = await createPerson({ name: n, title: title.value.trim() || 'My 100 Days', start: start.value, why: why.value.trim() });
          await selectProfile(p); go('goals'); toast('Add your first goal to begin');
        } catch (err) { starting = false; throw err; }
      },
    },
      h('div', { class: 'field', style: 'margin-top:0' }, h('label', { for: 'wname' }, 'Your name'), name),
      h('div', { class: 'field' }, h('label', { for: 'wtitle' }, 'Challenge name'), title),
      h('div', { class: 'field' }, h('label', { for: 'wstart' }, 'Start date'), start),
      h('div', { class: 'field' }, h('label', { for: 'wwhy' }, 'Why are you doing this?'), why),
      h('div', { class: 'save-row' }, h('button', { type: 'button', class: 'btn link', onclick: () => $('#restoreFile').click() }, 'Restore a backup instead'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Start'))));
}

function lockView() {
  const p = S.profile;
  const err = h('p', { class: 'err', role: 'alert' });
  const input = h('input', { type: 'password', inputmode: 'numeric', maxLength: 4, autocomplete: 'off', 'aria-label': 'PIN' });
  const attempt = async () => {
    if (input.value.length < 4) return;
    if (await checkPin(p, input.value)) { S.locked = false; render(); }
    else { err.textContent = 'That PIN is not right.'; input.value = ''; input.focus(); }
  };
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); err.textContent = ''; if (input.value.length === 4) attempt(); });
  setTimeout(() => input.focus(), 50);
  return h('div', { class: 'lock' },
    h('div', { class: 'avatar big' }, initial(p.name)),
    h('h2', null, p.name), h('p', { class: 'muted' }, 'Enter your PIN to continue'),
    input, err,
    h('button', { class: 'btn link', onclick: openProfiles }, 'Switch person'));
}

function fatalView() {
  return h('div', { class: 'welcome' },
    h('h1', null, 'Can\'t open storage'),
    h('p', { class: 'muted' }, 'This app saves your diary in the browser\'s on-device database, but it isn\'t available right now. This can happen in private/incognito windows or when storage is blocked in the browser settings.'),
    h('p', { class: 'tiny muted' }, String((S.fatal && S.fatal.message) || S.fatal || '')));
}

/* ------------------------------------------------------------------ people */
function openProfiles() {
  openDialog((dlg, close) => {
    dlg.append(h('h3', null, 'Who\'s checking in?'),
      h('div', { class: 'plist' }, S.profiles.map((p) => h('button', {
        class: 'pitem', 'aria-current': S.profile && p.id === S.profile.id ? 'true' : null, onclick: () => close({ pick: p.id }),
      }, h('span', { class: 'avatar' }, initial(p.name)), h('span', { class: 'name' }, p.name), p.pin ? h('span', { class: 'tiny muted' }, 'PIN') : null))),
      h('div', { class: 'dlg-actions', style: 'justify-content:space-between' },
        h('button', { class: 'btn', onclick: () => close({ add: true }) }, '+ Add person'),
        h('button', { class: 'btn', onclick: () => close(null) }, 'Close')));
  }).then(async (res) => {
    if (!res) return;
    if (res.add) return addPerson();
    const p = S.profiles.find((x) => x.id === res.pick);
    if (!p) return;
    if (S.profile && p.id === S.profile.id && !S.locked) return;
    await selectProfile(p, { lock: true });
  });
}

async function addPerson() {
  const name = await askText({ title: 'Add a person', label: 'Name', maxLength: 30, okText: 'Add' });
  if (!name) return;
  const p = await createPerson({ name, title: 'My 100 Days', start: M.localISO() });
  await selectProfile(p); go('goals'); toast(`${name} added. Choose some goals to begin.`);
}

async function renamePerson() {
  const name = await askText({ title: 'Rename', label: 'Name', value: S.profile.name, maxLength: 30 });
  if (!name) return;
  await mutateProfile((p) => { p.name = name; }); render();
}

async function setOrChangePin() {
  const p = S.profile;
  if (p.pin) {
    const cur = await askText({ title: 'Current PIN', label: '4-digit PIN', type: 'password', inputmode: 'numeric', maxLength: 4, okText: 'Next', pattern: /^\d{4}$/, patternMsg: 'Enter your 4 digits.' });
    if (!cur) return;
    if (!(await checkPin(p, cur))) return toast('That PIN is not right');
  }
  const rule = { type: 'password', inputmode: 'numeric', maxLength: 4, pattern: /^\d{4}$/, patternMsg: 'Use exactly 4 digits.' };
  const a = await askText({ ...rule, title: 'Choose a PIN', label: '4 digits', okText: 'Next' });
  if (!a) return;
  const b = await askText({ ...rule, title: 'Confirm your PIN', label: 'Enter it again', okText: 'Set PIN' });
  if (!b) return;
  if (a !== b) return toast('The PINs didn\'t match');
  const pin = await makePin(a);
  await mutateProfile((x) => { x.pin = pin; }); render(); toast('PIN set');
}

async function removePin() {
  const p = S.profile;
  const cur = await askText({ title: 'Remove PIN', label: 'Enter your current PIN', type: 'password', inputmode: 'numeric', maxLength: 4, okText: 'Remove', pattern: /^\d{4}$/, patternMsg: 'Enter your 4 digits.' });
  if (!cur) return;
  if (!(await checkPin(p, cur))) return toast('That PIN is not right');
  await mutateProfile((x) => { x.pin = null; }); render(); toast('PIN removed');
}

async function deletePerson() {
  const p = S.profile;
  if (S.profiles.length < 2) return;
  const ok = await confirmBox({ title: `Delete ${p.name}?`, message: `This permanently removes ${p.name}'s goals, diary and reviews from this device. Back up first if you might want them again.`, okText: 'Delete', danger: true });
  if (!ok) return;
  await flush();
  await DB.deleteProfile(p.id);
  S.profiles = S.profiles.filter((x) => x.id !== p.id);
  await selectProfile(S.profiles[0], { lock: true });
  toast('Deleted');
}

/* ------------------------------------------------------------------ backup, restore, reminder */
async function deliverFile(file, title) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; /* otherwise fall back to a download */ }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return 'downloaded';
}

async function backupNow() {
  try {
    await flush();
    const data = await DB.exportAll(M.BACKUP_VERSION);
    const file = new File([JSON.stringify(data, null, 2)], `my-100-days-backup-${M.localISO()}.json`, { type: 'application/json' });
    const res = await deliverFile(file, 'My 100 Days backup');
    if (res === 'cancelled') return;
    S.meta.lastBackup = Date.now(); await DB.setMeta('lastBackup', S.meta.lastBackup);
    toast(res === 'downloaded' ? 'Backup downloaded. Keep the file somewhere safe.' : 'Backup ready');
    render();
  } catch (e) { console.error(e); toast('Couldn\'t create the backup'); }
}

async function handleRestoreFile(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('That file could not be read'); }
  try {
    if (M.isLegacyBackup(data)) {
      const name = await askText({ title: 'Import your earlier tracker', label: 'Whose diary is this?', value: 'Me', maxLength: 30, okText: 'Import', hint: 'This adds it as a new person. Nothing already here is changed.' });
      if (!name) return;
      const rec = M.convertLegacy(data, name);
      await DB.addRecords(rec);
      await reloadFromDB();
      await selectProfile(S.profiles.find((p) => p.id === rec.profile.id), {});
      return toast('Imported');
    }
    const bad = M.validateBackup(data);
    if (bad) return toast('That isn\'t a My 100 Days backup');
    const clean = M.normalizeBackup(data);          // repair or drop anything malformed before it reaches the database
    if (!clean.profiles.length) return toast('That backup has no usable data');
    const ok = await confirmBox({
      title: 'Restore this backup?',
      message: `This replaces everything on this device with the backup (${clean.profiles.length} ${clean.profiles.length === 1 ? 'person' : 'people'}). It can't be undone.`,
      okText: 'Restore', danger: true,
    });
    if (!ok) return;
    await flush();
    await DB.restoreAll(clean);
    const t = Date.parse(data.exportedAt);
    await DB.setMeta('lastBackup', Number.isNaN(t) ? Date.now() : t);
    const activeId = await reloadFromDB();
    if (!S.profiles.length) { S.mode = 'welcome'; return render(); }
    await selectProfile(S.profiles.find((p) => p.id === activeId) || S.profiles[0], { lock: true });
    toast('Backup restored');
  } catch (e) { console.error(e); toast('Couldn\'t restore that file'); }
}

function reminderPlan() {
  const ch = S.challenge, tn = todayN(), time = S.meta.reminderTime || '21:00';
  if (tn > M.DAYS) { toast('Your challenge is finished'); return null; }
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return {
    title: ch.title, time,
    fromISO: tn < 1 ? ch.start : M.localISO(),
    count: tn < 1 ? M.DAYS : M.DAYS - tn + 1,
    url: /^https?:/.test(location.protocol) ? base : '',
  };
}
/** Calendar file (.ics): the share sheet on iPhone; a download elsewhere, which Android doesn't import by itself. */
async function addReminder() {
  const plan = reminderPlan(); if (!plan) return;
  const file = new File([M.buildICS(plan)], 'my-100-days-reminder.ics', { type: 'text/calendar' });
  const res = await deliverFile(file, 'My 100 Days reminder');
  if (res === 'downloaded') toast('Now open the downloaded file to add it to your calendar');
}
/** Opens Google Calendar's new-event screen already filled in. No file involved. */
function addGoogleReminder() {
  const plan = reminderPlan(); if (!plan) return;
  let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* leave it out */ }
  const link = M.googleCalendarURL({ ...plan, tz });
  const w = window.open(link, '_blank', 'noopener');
  if (!w) location.assign(link);                       // pop-up blocked: go there directly
}

/* ------------------------------------------------------------------ PWA: install, updates, storage protection */
async function promptInstall() {
  const ev = S.installEvent; if (!ev) return;
  ev.prompt();
  try { await ev.userChoice; } catch { /* ignore */ }
  S.installEvent = null; render();
}
function applyUpdate() {
  if (!S.updateWorker) return;
  S.wantReload = true;
  flush().then(() => S.updateWorker.postMessage({ type: 'SKIP_WAITING' }));
}

function setupPWA() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (S.wantReload) location.reload(); });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const watch = (sw) => sw && sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' && navigator.serviceWorker.controller) { S.updateWorker = sw; if (S.mode === 'app' && !S.locked) render(); }
    });
    if (reg.waiting && navigator.serviceWorker.controller) S.updateWorker = reg.waiting;
    reg.addEventListener('updatefound', () => watch(reg.installing));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('Service worker not registered', e));
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvent = e; if (S.mode === 'app' && !S.locked) render(); });
window.addEventListener('appinstalled', () => { S.installEvent = null; if (S.mode === 'app') render(); toast('Installed'); });

/* ------------------------------------------------------------------ lifecycle */
const isTyping = () => !!document.activeElement && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName);

/** If the calendar date changed while the app stayed open (past midnight, or a desktop window left open for days),
 *  move "today" forward and redraw. Waits if the person is typing so it never disturbs them. */
function checkDayRollover() {
  if (S.mode !== 'app' || !S.challenge) return;
  const iso = M.localISO();
  if (iso === lastSeenISO || (isTyping() && !S.locked)) return;
  const oldDay = M.clamp(M.dayNumberFor(S.challenge.start, lastSeenISO), 1, M.DAYS);
  lastSeenISO = iso;
  if (S.viewDay === oldDay) {                       // they were looking at "today": follow it
    S.viewDay = M.clamp(todayN(), 1, M.DAYS);
    S.viewWeek = M.clamp(M.weekOfDay(S.viewDay), 1, M.WEEKS);
  }
  render();
}

/* ----- several windows at once (e.g. a browser tab plus the installed app, or two tabs)
   Each window holds its own copy of the data in memory, so a stale window could overwrite what another one saved.
   To prevent that, windows announce every committed write, and a window that is idle re-reads from the database. */
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('my100days') : null;
DB.onWrite(() => { try { if (channel) channel.postMessage('changed'); } catch { /* ignore */ } });
let needsRefresh = false;
if (channel) channel.onmessage = () => { needsRefresh = true; syncExternal(); };

// Key-order-independent JSON, so "did anything actually change?" comparisons are reliable.
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const byDay = (o) => Object.values(o).sort((a, b) => a.day - b.day);
const byWeek = (o) => Object.values(o).sort((a, b) => a.week - b.week);

async function syncExternal() {
  if (!needsRefresh || S.mode === 'boot' || S.mode === 'fatal') return;
  // Never replace what someone is typing or saving; try again once they pause (focusout, dialog close, timer).
  if (dirty.size || inflight || $('#dlg').open || (isTyping() && !S.locked)) return;
  needsRefresh = false;
  const startRev = rev;
  try {
    const before = stable([S.profiles, S.profile, S.challenge, byDay(S.entries), byWeek(S.weeks), S.attempts]);
    const activeId = await reloadFromDB();
    if (rev !== startRev) { needsRefresh = true; return setTimeout(syncExternal, 250); }
    if (!S.profiles.length) { S.mode = 'welcome'; S.profile = null; S.challenge = null; return render(); }
    if (S.mode === 'welcome' || !S.profile) return selectProfile(S.profiles.find((p) => p.id === activeId) || S.profiles[0], { lock: true });
    const p = S.profiles.find((x) => x.id === S.profile.id);
    if (!p) return selectProfile(S.profiles[0], { lock: true });                // this person was deleted elsewhere
    const ch = await DB.get('challenges', S.challenge.id);
    if (!ch || ch.endedAt) return selectProfile(p, { lock: S.locked });          // this attempt was archived in another window
    const attempts = (await DB.challengesOfProfile(p.id)).filter((c) => c.endedAt).sort((a, b) => (a.attempt || 1) - (b.attempt || 1));
    const [entries, weeks] = await Promise.all([DB.entriesOfChallenge(ch.id), DB.weeksOfChallenge(ch.id)]);
    // Something changed here while we were reading: our snapshot is stale, so drop it and look again shortly.
    if (dirty.size || inflight || rev !== startRev) { needsRefresh = true; return setTimeout(syncExternal, 250); }
    if (stable([S.profiles, p, ch, entries, weeks, attempts]) === before) return;        // nothing changed elsewhere: leave the screen alone
    S.profile = p; S.challenge = ch; S.attempts = attempts;
    S.entries = Object.fromEntries(entries.map((e) => [e.day, e]));
    S.weeks = Object.fromEntries(weeks.map((w) => [w.week, w]));
    render();
  } catch (e) { console.error(e); needsRefresh = true; }
}
const wakeUp = () => { checkDayRollover(); syncExternal(); maybeCelebrate(); };

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); flush(); return; }
  if (S.mode !== 'app') return;
  if (S.profile && S.profile.pin && !S.locked && hiddenAt && Date.now() - hiddenAt > 60000) S.locked = true;
  hiddenAt = 0;
  needsRefresh = true;                 // we may have missed changes made while this window was in the background
  checkDayRollover();
  if (!isTyping() || S.locked) render();
  syncExternal();
});
window.addEventListener('focus', () => { needsRefresh = true; wakeUp(); });
window.addEventListener('pageshow', () => { needsRefresh = true; wakeUp(); });
document.addEventListener('focusout', () => setTimeout(wakeUp, 60));
$('#dlg').addEventListener('close', () => setTimeout(wakeUp, 0));
setInterval(wakeUp, 30000);
window.addEventListener('pagehide', () => { flush(); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast('Something went wrong. Please try again.'); });
$('#restoreFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; handleRestoreFile(f); });

boot();
