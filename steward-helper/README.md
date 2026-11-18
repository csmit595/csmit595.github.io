# Steward helper (Google Apps Script)

Runs in the owner's Google account ("Steward helper" project at script.google.com), even when Steward is closed on every device:
- every 10 minutes (`syncSteward`): applies the task changes Claude leaves in `Steward/inbox for Claude` to `steward-tasks.json`.
  Change files that touch notes or Writing documents are left for the app.
- every minute (`sendReminders`): sends reminders that are due to every device listed in `Steward/notifications` by Web Push
  (RFC 8291 encryption, RFC 8292 VAPID; see `push.js`). The sender key's secret half lives only in the script's properties;
  `notifications/key.json` holds the public half. Each device writes `device-<id>.json` and gets a test notification first.
  Until every device has shown its test, the `Steward Reminders` calendar is kept as a backup; after that it is emptied.

Build: `npm i && bash build.sh` → paste `out/Code.gs` and `appsscript.json` into the Apps Script project, run `setUp` once
(it sets both timers). Test: `node test.mjs` (runs the built script in a bare V8 context shaped like Apps Script).
The Drive and Calendar advanced services in the manifest switch those APIs on for the script's Google project.
