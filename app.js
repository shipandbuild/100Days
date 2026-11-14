// My 100 Days: UI and app logic. Runs fully on-device; there are no network calls other than loading the app files.
import * as M from './model.js';
import * as DB from './db.js';

const APP_VERSION = '1.0.0';
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
  tab: 'today', viewDay: 1, viewWeek: 1,
  todayISO: M.localISO(),
  locked: false,
  status: 'Saved on this device',
  dismissed: { backup: false },
  installEvent: null, updateWorker: null, wantReload: false,
};
const todayN = () => (S.challenge ? M.dayNumberFor(S.challenge.start, S.todayISO) : 0);
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
let saveTimer = null;
const dirty = new Set();

function setStatus(text) {
  S.status = text;
  const el = $('#saveStatus');
  if (el) el.textContent = text;
}
function markDirty(kind, key = '') {
  dirty.add(`${kind}:${key}`);
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}
async function flush() {
  clearTimeout(saveTimer);
  if (!dirty.size) return;
  const keys = [...dirty]; dirty.clear();
  try {
    for (const k of keys) {
      const [kind, key] = k.split(':');
      if (kind === 'entry' && S.entries[key]) await DB.put('entries', S.entries[key]);
      else if (kind === 'week' && S.weeks[key]) await DB.put('weeks', S.weeks[key]);
      else if (kind === 'challenge') await DB.put('challenges', S.challenge);
    }
    setStatus('Saved on this device');
  } catch (e) {
    console.error(e);
    setStatus('Not saved');
    toast('Couldn\'t save. Storage may be full or blocked. Back up your diary from Settings.');
  }
}
const saveChallenge = async () => { markDirty('challenge'); await flush(); };

function ensureEntry(day) {
  return S.entries[day] || (S.entries[day] = { challengeId: S.challenge.id, day, checks: {}, diary: '', gratitude: '', tomorrow: '', updatedAt: Date.now() });
}
function ensureWeek(w) {
  return S.weeks[w] || (S.weeks[w] = { challengeId: S.challenge.id, week: w, win: '', hard: '', learn: '', next: '' });
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
  await flush();
  const chs = (await DB.challengesOfProfile(p.id)).sort((a, b) => b.createdAt - a.createdAt);
  let ch = chs[0];
  if (!ch) {
    ch = { id: M.uid(), profileId: p.id, title: 'My 100 Days', start: M.localISO(), goals: [], createdAt: Date.now() };
    await DB.put('challenges', ch);
  }
  const [entries, weeks] = await Promise.all([DB.entriesOfChallenge(ch.id), DB.weeksOfChallenge(ch.id)]);
  S.profile = p; S.challenge = ch;
  S.entries = Object.fromEntries(entries.map((e) => [e.day, e]));
  S.weeks = Object.fromEntries(weeks.map((w) => [w.week, w]));
  S.todayISO = M.localISO();
  S.viewDay = M.clamp(todayN(), 1, M.DAYS);
  S.viewWeek = M.clamp(M.weekOfDay(S.viewDay), 1, M.WEEKS);
  S.tab = 'today';
  S.locked = !!(lock && p.pin);
  S.mode = 'app';
  S.status = 'Saved on this device';
  await DB.setMeta('activeProfile', p.id); S.meta.activeProfile = p.id;
  render();
}

async function createPerson({ name, title, start }) {
  const profile = { id: M.uid(), name, pin: null, createdAt: Date.now() };
  const challenge = { id: M.uid(), profileId: profile.id, title, start, goals: [], createdAt: Date.now() };
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
  try {
    await DB.openDB();
    const activeId = await reloadFromDB();
    if (!S.profiles.length) { S.mode = 'welcome'; render(); }
    else await selectProfile(S.profiles.find((p) => p.id === activeId) || S.profiles[0], { lock: true });
  } catch (e) {
    console.error(e);
    S.mode = 'fatal'; S.fatal = e; render();
    return;
  }
  setupPWA();
}

/* ------------------------------------------------------------------ rendering */
function render() {
  const root = $('#root'), nav = $('#nav');
  const focusId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : null;
  if (S.mode === 'fatal') { nav.hidden = true; root.replaceChildren(fatalView()); return; }
  if (S.mode === 'welcome') { nav.hidden = true; root.replaceChildren(welcomeView()); return; }
  if (S.mode !== 'app') return;
  if (S.locked) { nav.hidden = true; root.replaceChildren(lockView()); return; }
  nav.hidden = false;
  const views = { today: todayView, calendar: calendarView, goals: goalsView, review: reviewView, settings: settingsView };
  root.replaceChildren(headerView(), bannersView(), heroView(), views[S.tab]());
  renderNav();
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
    h('div', { class: 'eyebrow' }, 'Your journey'),
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
      oninput: (e) => { const en = ensureEntry(n); en[key] = e.target.value; en.updatedAt = Date.now(); markDirty('entry', n); },
    }));

  const diary = h('section', { class: 'panel' },
    h('h3', null, 'Your daily diary'),
    field('diary', 'How was today? What happened?', 'diary', 5, 'Write freely. A few honest lines are enough…'),
    field('gratitude', 'One thing I\'m grateful for', 'gratitude', 2, 'Today, I\'m grateful for…'),
    field('tomorrow', 'Tomorrow, I want to…', 'tomorrow', 2, 'One small intention for tomorrow…'),
    h('p', { class: 'tiny muted', id: 'saveStatus', 'aria-live': 'polite' }, S.status),
  );
  return h('div', null, nav, goalsPanel, diary);
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
        g.name = v; await saveChallenge(); render(); toast('Goal updated');
      },
    }, input,
      h('button', { type: 'submit', class: 'btn small' }, 'Save'),
      h('button', {
        type: 'button', class: 'btn small danger',
        onclick: async () => {
          const ok = await confirmBox({ title: `Stop “${g.name}”?`, message: tn >= 1 ? 'It will stop from today onward. Earlier days keep it, so your history stays intact.' : 'It will be removed.', okText: 'Stop goal', danger: true });
          if (!ok) return;
          M.retireGoal(ch, g.id, tn); await saveChallenge(); render(); toast('Goal stopped');
        },
      }, 'Remove'));
  });

  const nameInput = h('input', { type: 'text', maxLength: 70, placeholder: 'e.g. Walk for 30 minutes', 'aria-label': 'New goal' });
  const past1 = h('input', { type: 'checkbox', id: 'includePast' });
  const showPastOpt = tn > 1 && tn <= M.DAYS;
  const addForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return toast('Type a goal first');
      if (active.length >= M.MAX_ACTIVE_GOALS) return toast(`You can have up to ${M.MAX_ACTIVE_GOALS} goals`);
      M.addGoal(ch, name, tn, showPastOpt && past1.checked);
      await saveChallenge(); render(); toast('Goal added');
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
    h('textarea', { id: 'wk-' + key, placeholder, value: wk[key] || '', disabled: future, oninput: (e) => { ensureWeek(w)[key] = e.target.value; markDirty('week', w); } }));
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

/* ----- Settings */
function settingsView() {
  const ch = S.challenge, p = S.profile;
  const titleIn = h('input', { type: 'text', id: 'titleIn', value: ch.title, maxLength: 60, placeholder: 'My 100-day challenge' });
  const startIn = h('input', { type: 'date', id: 'startIn', value: ch.start });
  const timeIn = h('input', { type: 'time', id: 'timeIn', value: S.meta.reminderTime || '21:00' });
  const persistNote = h('span', { class: 'tiny muted' }, 'Checking…');
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((v) => { persistNote.textContent = v ? 'Protected: the browser won\'t clear it to free space.' : 'Not locked in. Install to your home screen and back up regularly.'; });
  } else persistNote.textContent = 'Not available in this browser.';

  const challenge = h('section', { class: 'panel' }, h('h3', null, 'Challenge'),
    h('div', { class: 'field' }, h('label', { for: 'titleIn' }, 'Challenge name'), titleIn),
    h('div', { class: 'field' }, h('label', { for: 'startIn' }, 'Start date'), startIn),
    h('div', { class: 'save-row' }, h('span', { class: 'tiny muted' }, `Length: ${M.DAYS} days`),
      h('button', {
        class: 'btn primary', onclick: async () => {
          const title = titleIn.value.trim() || 'My 100 Days', start = startIn.value;
          if (!M.isValidISO(start)) return toast('Choose a start date');
          if (start !== ch.start && Object.keys(S.entries).length) {
            const ok = await confirmBox({ title: 'Change the start date?', message: 'Your diary entries stay attached to their day numbers, so their dates will shift with the new start date.', okText: 'Change date' });
            if (!ok) return;
          }
          ch.title = title; ch.start = start; await saveChallenge();
          S.viewDay = M.clamp(todayN(), 1, M.DAYS); render(); toast('Settings saved');
        },
      }, 'Save')));

  const reminder = h('section', { class: 'panel' }, h('h3', null, 'Daily reminder'),
    h('p', { class: 'tiny muted' }, 'Adds a repeating event with an alert to your phone\'s Calendar for the days you have left. It works on iPhone and Android, and nothing is sent anywhere. You can edit or delete it in your Calendar app.'),
    h('div', { class: 'field' }, h('label', { for: 'timeIn' }, 'Remind me at'), timeIn),
    h('div', { class: 'save-row' }, h('span'), h('button', { class: 'btn primary', onclick: async () => { S.meta.reminderTime = timeIn.value || '21:00'; await DB.setMeta('reminderTime', S.meta.reminderTime); addReminder(); } }, 'Add to calendar')));

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

  return h('div', null, challenge, reminder, backup, people, about);
}

/* ----- welcome / lock / fatal */
function welcomeView() {
  const name = h('input', { type: 'text', id: 'wname', maxLength: 30, placeholder: 'Your name', autocomplete: 'given-name' });
  const title = h('input', { type: 'text', id: 'wtitle', maxLength: 60, value: 'My 100 Days' });
  const start = h('input', { type: 'date', id: 'wstart', value: M.localISO() });
  return h('div', { class: 'welcome' },
    h('div', { class: 'mark', 'aria-hidden': 'true' }, '100'),
    h('h1', null, 'Welcome'),
    h('p', { class: 'muted' }, 'A private 100-day journal and habit tracker. Everything stays on this device.'),
    h('form', {
      class: 'panel', style: 'margin-top:18px',
      onsubmit: async (e) => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) { name.focus(); return toast('Please enter your name'); }
        if (!M.isValidISO(start.value)) return toast('Choose a start date');
        const p = await createPerson({ name: n, title: title.value.trim() || 'My 100 Days', start: start.value });
        await selectProfile(p); go('goals'); toast('Add your first goal to begin');
      },
    },
      h('div', { class: 'field', style: 'margin-top:0' }, h('label', { for: 'wname' }, 'Your name'), name),
      h('div', { class: 'field' }, h('label', { for: 'wtitle' }, 'Challenge name'), title),
      h('div', { class: 'field' }, h('label', { for: 'wstart' }, 'Start date'), start),
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
  S.profile.name = name; await DB.put('profiles', S.profile); render();
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
  p.pin = await makePin(a); await DB.put('profiles', p); render(); toast('PIN set');
}

async function removePin() {
  const p = S.profile;
  const cur = await askText({ title: 'Remove PIN', label: 'Enter your current PIN', type: 'password', inputmode: 'numeric', maxLength: 4, okText: 'Remove', pattern: /^\d{4}$/, patternMsg: 'Enter your 4 digits.' });
  if (!cur) return;
  if (!(await checkPin(p, cur))) return toast('That PIN is not right');
  p.pin = null; await DB.put('profiles', p); render(); toast('PIN removed');
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
    const ok = await confirmBox({
      title: 'Restore this backup?',
      message: `This replaces everything on this device with the backup (${data.profiles.length} ${data.profiles.length === 1 ? 'person' : 'people'}). It can't be undone.`,
      okText: 'Restore', danger: true,
    });
    if (!ok) return;
    await flush();
    await DB.restoreAll(data);
    const t = Date.parse(data.exportedAt);
    await DB.setMeta('lastBackup', Number.isNaN(t) ? Date.now() : t);
    const activeId = await reloadFromDB();
    if (!S.profiles.length) { S.mode = 'welcome'; return render(); }
    await selectProfile(S.profiles.find((p) => p.id === activeId) || S.profiles[0], { lock: true });
    toast('Backup restored');
  } catch (e) { console.error(e); toast('Couldn\'t restore that file'); }
}

async function addReminder() {
  const ch = S.challenge, tn = todayN(), time = S.meta.reminderTime || '21:00';
  if (tn > M.DAYS) return toast('Your challenge is finished');
  const fromISO = tn < 1 ? ch.start : S.todayISO;
  const count = tn < 1 ? M.DAYS : M.DAYS - tn + 1;
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const ics = M.buildICS({ title: ch.title, fromISO, time, count, url: /^https?:/.test(location.protocol) ? base : '' });
  const file = new File([ics], 'my-100-days-reminder.ics', { type: 'text/calendar' });
  const res = await deliverFile(file, 'My 100 Days reminder');
  if (res === 'downloaded') toast('Open the downloaded file to add it to your calendar');
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
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); flush(); return; }
  if (S.mode !== 'app') return;
  const iso = M.localISO();
  if (iso !== S.todayISO) { S.todayISO = iso; S.viewDay = M.clamp(todayN(), 1, M.DAYS); S.viewWeek = M.weekOfDay(S.viewDay); }
  if (S.profile && S.profile.pin && !S.locked && hiddenAt && Date.now() - hiddenAt > 60000) S.locked = true;
  hiddenAt = 0;
  const typing = document.activeElement && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName);
  if (!typing || S.locked) render();
});
window.addEventListener('pagehide', () => { flush(); });
$('#restoreFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; handleRestoreFile(f); });

boot();
