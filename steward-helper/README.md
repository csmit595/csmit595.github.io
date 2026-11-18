# Steward helper (Google Apps Script)

Runs every 10 minutes in the owner's Google account ("Steward helper" project at script.google.com), even when Steward is closed on every device:
applies the task changes Claude leaves in `Steward/inbox for Claude` to `steward-tasks.json`, and keeps the `Steward Reminders` calendar right.
Change files that touch notes or Writing documents are left for the app.

Build: `npm i esbuild && bash build.sh` → paste `out/Code.gs` and `appsscript.json` into the Apps Script project, run `setUp` once.
The Drive and Calendar advanced services in the manifest switch those APIs on for the script's Google project.
