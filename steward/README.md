# Steward

Tasks, notes and calendar in one installable web app. Works offline; syncs through the owner's own Google Drive and Google Calendar.

- Open https://csmit595.github.io/steward/ in Chrome and choose "Install".
- No build step: plain HTML, CSS and JavaScript modules.
- No data is stored in this repository. Everything a person enters stays on their device and in their own Google Drive ("Steward" folder).
- 4.0: signs in to Google with per-file Drive access only (no warning screen, no Google review needed). Calendar, notifications, and Claude's change files and scans come through the Steward helper's web app.
- 3.9: reminders arrive as Steward's own notifications on the phone and the Mac, even while Steward is closed. The Google helper checks every minute and sends them by Web Push (no Google Calendar). Settings → Reminders turns them on per device; each device gets a test notification first, and the old "Steward Reminders" calendar stays as a backup until every device has shown its test, then it is emptied.
- 3.8: works fully with no signal. The tools (PDF reader, Word tools, page reader, search model) are kept in their own cache that survives updates; every attachment is kept on the device after each sync (Settings → Use with no signal, which also has "Download everything to this device").
- 3.7: updates without reinstalling. Settings → Updates has "Check for updates now" and "Reload Steward fresh" (re-downloads the app, keeps all data); a notice shows after each update; icon links carry a version so Chrome offers to update the installed icon when the artwork changes.
- 3.6: on the phone, swipe a note right to delete it (it goes to the trash); an Undo button shows at the bottom of the screen for 3 seconds.
- 3.5: on the phone, swipe the plus button left to add a task (two quick haptic clicks, and it turns into "Add task"); a tap still starts a note. The plus now shows on Calendar and Settings too.
- 3.4: on the phone the plus button starts a new note; inside a note it adds from the camera, photos or files; notes have a Share button.
- 3.3 was a full quality pass (date reading, sync safety, phone layout); see the commit notes.
- Background sync (3.2): when installed from Chrome (Android, or Mac with Chrome running), the service worker syncs with Drive every so often while Steward is closed — Claude's task changes, phone reminders, and calendar. Chrome decides how often. Changes made with no signal are sent once the connection returns.
