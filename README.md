# My 100 Days (Phase 1)

A private 100-day challenge tracker and diary. An installable web app (PWA) that runs on iPhone and Android.
All data is stored on the device (IndexedDB). There is no backend, no accounts and no analytics.

There is no build step. The folder is the app: upload it to any static host.

```
index.html  styles.css  app.js  model.js  db.js
sw.js  manifest.webmanifest  icons/
```

## Host it (pick one, all free)

The app must be served over **https** (or `localhost`) for install, offline mode and PIN to work.

- **Netlify Drop**: go to app.netlify.com/drop and drag this folder in. You get an https link in seconds.
- **Cloudflare Pages** or **GitHub Pages**: push the folder to a repo and enable Pages. The app uses relative paths, so it works in a sub-folder (e.g. `you.github.io/100days/`).
- **Try it on your computer first**: `python3 -m http.server 8000` in this folder, then open http://localhost:8000.

## Install on the family's phones

- **iPhone (Safari)**: open the link, tap Share, then **Add to Home Screen**. Use Safari for this step. Install it: an installed app keeps its data much safer than a browser tab.
- **Android (Chrome)**: open the link and tap the **Install** banner (or menu, then Install app).

Each person on a shared device gets their own profile (tap the name at the top right) with an optional 4-digit PIN.

## Shipping an update

1. Change the files.
2. **Bump `VERSION` in `sw.js`** (e.g. `1.0.1`). This is what tells installed copies to update.
3. Re-upload. Users see a "A new version is ready" banner and tap Refresh. Their data is untouched.

## Reminders

PWAs can't schedule their own notifications without a push server (which would break the "fully private" goal).
Instead, Settings has **Add to calendar**: it creates a repeating daily event with an alert in the phone's own Calendar app for the days remaining. Nothing is sent anywhere.

## Backups (important)

Data lives only on the device, so a lost or wiped phone loses the diary. Settings, then **Back up now** opens the share sheet
(Save to Files / iCloud Drive / Google Drive / email to yourself). The app nags weekly. **Restore from backup** brings it back, and it also
imports the JSON exported by the original single-file tracker as a new person.

## Data model (for Phase 2)

Goals carry `from` and `to` day numbers, so adding or removing a goal never rewrites past days. The schema is versioned
(`DB_VERSION` in `db.js`, `BACKUP_VERSION` in `model.js`); a challenge is a separate record, so multiple challenges per person is a UI change, not a data migration.

## Known limits

- The PIN is a casual lock for shared devices, not encryption. Diary data is stored in plain form on the device.
- Reminders rely on the Calendar app (see above).
- Only one challenge per person is exposed in the UI for now.
