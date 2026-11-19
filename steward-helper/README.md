# Steward helper (Google Apps Script)

Runs in the owner's Google account ("Steward helper" project at script.google.com), even when Steward is closed on every device:
- every 10 minutes (`syncSteward`): applies the task changes Claude leaves in `Steward/inbox for Claude` to `steward-tasks.json`.
  Change files that touch notes are left for the app. (Writing was removed in Steward 4.5: a change naming a document or source gets a `report-*.txt` saying so.)
- as a web app (`doPost`), for Steward itself: since Steward 4.0 the app signs in with per-file Drive access only, so it
  cannot open Claude's change files and scans, the notifications folder, or Google Calendar. It asks the helper instead.
  Every request must carry a Google pass issued to the Steward client for this same Google account (checked with
  Google's tokeninfo and Drive `about`). The helper saves its web-app address in Steward's shared settings
  (`helperUrl` in `steward-tasks.json`) so each device finds it.
- every minute (`sendReminders`), since Steward 4.7 also: "Focus session done" when a running focus session reaches its `endsAt`, and "Family time: start the timer?" when a fixed block of a timed identity begins (read from `steward-goals.json`, which only the app writes; one extra look at that file's version each minute). Change files with `identity`, `goal`, `session` or `review` ops, or a task filed under a goal, are left for the app.
- every minute (`sendReminders`): sends reminders that are due to every device listed in `Steward/notifications` by Web Push
  (RFC 8291 encryption, RFC 8292 VAPID; see `push.js`). The sender key's secret half lives only in the script's properties;
  `notifications/key.json` holds the public half. Each device writes `device-<id>.json` and gets a test notification first.
  Until every device has shown its test, the `Steward Reminders` calendar is kept as a backup; after that it is emptied.

Build: `npm i && bash build.sh` (a built copy is kept as `Code.gs`) → paste `out/Code.gs` and `appsscript.json` into the Apps Script project, run `setUp` once
(it sets both timers). Then Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone, and put the
`/exec` address in the script property `webAppUrl`. After changing the code, Deploy → Manage deployments → edit → New version. Test: `node test.mjs` (runs the built script in a bare V8 context shaped like Apps Script).
The Drive and Calendar advanced services in the manifest switch those APIs on for the script's Google project.

The script property `webAppUrl` must hold the web app's real `/exec` address (Deploy → Manage deployments → Web app URL). The helper publishes that address to Steward through the shared settings; it never guesses one. It was set by hand on Nov 18 2026.
