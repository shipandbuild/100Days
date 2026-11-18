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
2. **Bump `VERSION` in `sw.js`** (and `APP_VERSION` in `app.js`, which is only shown in Settings) (e.g. `1.0.1`). This is what tells installed copies to update.
3. Re-upload. Users see a "A new version is ready" banner and tap Refresh. Their data is untouched.

## Reminders

PWAs can't schedule their own notifications without a push server (which would break the "fully private" goal).
Instead, Settings has **Add to calendar**: it creates a repeating daily event with an alert in the phone's own Calendar app for the days remaining. Nothing is sent anywhere.

## Backups (important)

Data lives only on the device, so a lost or wiped phone loses the diary. Settings, then **Back up now** opens the share sheet
(Save to Files / iCloud Drive / Google Drive / email to yourself). The app nags weekly. **Restore from backup** brings it back, and it also
imports the JSON exported by the original single-file tracker as a new person.

## What keeps the habit going (v1.1)
- **Streak rescue:** if yesterday is unfinished after a run of at least 2 complete days, Today offers to open it so you can tick off what you really did.
- **Hard-day reminder:** after two unfinished days in a row, Today shows the "why I started" note (set it in Settings or at welcome, up to 300 characters).
- **Weekly review prompt:** when a week has finished and its review is empty, Today offers to open it. "Later" hides it until the app is reopened.
- **Milestones:** days 7, 21, 50 and 100 get a short celebration once. It can make a share card (PNG) with only the challenge name and three numbers, never diary text or goal names.
- At most two of these cards show at a time.

## Insights (Review tab, "Insights")
Weekday-by-week grid, completion by weekday, completion by goal, last 7 days against the 7 before, and suggestions: a goal missed 3 days running or done on under 40% of the last 14 days offers "Make it smaller" (starts a new goal from today, old history untouched) or "Stop this goal"; a goal done 90%+ over 14 days is called solid. Insights count finished days only. Nothing leaves the device.

## Data model (for Phase 2)

Goals carry `from` and `to` day numbers, so adding or removing a goal never rewrites past days. The schema is versioned
(`DB_VERSION` in `db.js`, `BACKUP_VERSION` in `model.js`). v1.1 added two optional fields to a challenge (`why`, `celebrated`); old backups still restore and new backups still open in v1.0 (the extra fields are ignored); a challenge is a separate record, so multiple challenges per person is a UI change, not a data migration.

## Several windows at once

If the app is open in more than one window (a browser tab plus the installed app, or two tabs), the windows tell each other when data changes and
each save only applies what that window actually changed, so one window can't overwrite another's goals or diary text.

## Known limits

- Backups are plain JSON and include the PIN's hash, so keep backup files private like the diary itself.
- The PIN is a casual lock for shared devices, not encryption. Diary data is stored in plain form on the device.
- Reminders rely on the Calendar app (see above).
- Only one challenge per person is exposed in the UI for now.
