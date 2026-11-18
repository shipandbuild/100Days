// Thin IndexedDB wrapper. Everything stays on the device; nothing here touches the network.
import { DAYS } from './model.js';

const DB_NAME = 'my100days';
const DB_VERSION = 1;
let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB is not available in this browser.'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Future schema changes: bump DB_VERSION and branch on event.oldVersion here.
      db.createObjectStore('profiles', { keyPath: 'id' });
      db.createObjectStore('challenges', { keyPath: 'id' }).createIndex('byProfile', 'profileId');
      db.createObjectStore('entries', { keyPath: ['challengeId', 'day'] });
      db.createObjectStore('weeks', { keyPath: ['challengeId', 'week'] });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is blocked by another tab. Close other tabs of this app and reload.'));
  });
  return dbPromise;
}

// The app registers a listener so other open windows of the app can be told that data changed.
let writeListener = () => {};
export const onWrite = (fn) => { writeListener = fn; };

// Only write transactions use done(), so this fires exactly when something was committed.
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => { try { writeListener(); } catch { /* never let a listener break a save */ } resolve(); };
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
});
const result = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function get(store, key) {
  const db = await openDB();
  return result(db.transaction(store).objectStore(store).get(key));
}
export async function getAll(store) {
  const db = await openDB();
  return result(db.transaction(store).objectStore(store).getAll());
}
export async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return done(tx);
}
/** Read-modify-write in ONE transaction, so two open windows can never both act on the same stale copy.
 *  `fn` receives a copy of the record and may change it; whatever `fn` returns is passed back. Does nothing if the record is gone. */
export async function update(store, key, fn) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  let out;
  const req = os.get(key);
  req.onsuccess = () => {
    if (!req.result) return;
    const copy = structuredClone(req.result);
    out = fn(copy);
    os.put(copy);
  };
  await done(tx);
  return out;
}
export async function putMany(store, values) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  values.forEach((v) => os.put(v));
  return done(tx);
}
export async function del(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export async function challengesOfProfile(profileId) {
  const db = await openDB();
  return result(db.transaction('challenges').objectStore('challenges').index('byProfile').getAll(profileId));
}
export async function entriesOfChallenge(challengeId) {
  const db = await openDB();
  const range = IDBKeyRange.bound([challengeId, 0], [challengeId, DAYS + 1]);
  return result(db.transaction('entries').objectStore('entries').getAll(range));
}
export async function weeksOfChallenge(challengeId) {
  const db = await openDB();
  const range = IDBKeyRange.bound([challengeId, 0], [challengeId, 100]);
  return result(db.transaction('weeks').objectStore('weeks').getAll(range));
}

/** Remove a profile and everything that belongs to it, atomically. */
export async function deleteProfile(profileId) {
  const db = await openDB();
  const chs = await challengesOfProfile(profileId);
  const tx = db.transaction(['profiles', 'challenges', 'entries', 'weeks'], 'readwrite');
  tx.objectStore('profiles').delete(profileId);
  for (const c of chs) {
    tx.objectStore('challenges').delete(c.id);
    tx.objectStore('entries').delete(IDBKeyRange.bound([c.id, 0], [c.id, DAYS + 1]));
    tx.objectStore('weeks').delete(IDBKeyRange.bound([c.id, 0], [c.id, 100]));
  }
  return done(tx);
}

export const getMeta = async (key) => {
  const row = await get('meta', key);
  return row ? row.value : undefined;
};
export const setMeta = (key, value) => put('meta', { key, value });

/* ---------- backup / restore ---------- */

export async function exportAll(backupVersion) {
  const [profiles, challenges, entries, weeks] = await Promise.all(
    ['profiles', 'challenges', 'entries', 'weeks'].map(getAll)
  );
  return { app: 'my100days', version: backupVersion, exportedAt: new Date().toISOString(), profiles, challenges, entries, weeks };
}

/** Replace everything on this device with the backup, in one transaction (all-or-nothing). */
export async function restoreAll(data) {
  const db = await openDB();
  const tx = db.transaction(['profiles', 'challenges', 'entries', 'weeks'], 'readwrite');
  for (const s of ['profiles', 'challenges', 'entries', 'weeks']) tx.objectStore(s).clear();
  data.profiles.forEach((p) => tx.objectStore('profiles').put(p));
  data.challenges.forEach((c) => tx.objectStore('challenges').put(c));
  data.entries.forEach((e) => tx.objectStore('entries').put(e));
  data.weeks.forEach((w) => tx.objectStore('weeks').put(w));
  return done(tx);
}

/** Add records (e.g. a converted legacy backup) without touching existing ones. */
export async function addRecords({ profile, challenge, entries, weeks }) {
  const db = await openDB();
  const tx = db.transaction(['profiles', 'challenges', 'entries', 'weeks'], 'readwrite');
  tx.objectStore('profiles').put(profile);
  tx.objectStore('challenges').put(challenge);
  entries.forEach((e) => tx.objectStore('entries').put(e));
  weeks.forEach((w) => tx.objectStore('weeks').put(w));
  return done(tx);
}
