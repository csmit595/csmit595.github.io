# Steward

Tasks, notes and calendar in one installable web app. Works offline; syncs through the owner's own Google Drive and Google Calendar.

- Open https://csmit595.github.io/steward/ in Chrome and choose "Install".
- No build step: plain HTML, CSS and JavaScript modules.
- No data is stored in this repository. Everything a person enters stays on their device and in their own Google Drive ("Steward" folder).
- 3.5: on the phone, swipe the plus button left to add a task (two quick haptic clicks, and it turns into "Add task"); a tap still starts a note. The plus now shows on Calendar and Settings too.
- 3.4: on the phone the plus button starts a new note; inside a note it adds from the camera, photos or files; notes have a Share button.
- 3.3 was a full quality pass (date reading, sync safety, phone layout); see the commit notes.
- Background sync (3.2): when installed from Chrome (Android, or Mac with Chrome running), the service worker syncs with Drive every so often while Steward is closed — Claude's task changes, phone reminders, and calendar. Chrome decides how often. Changes made with no signal are sent once the connection returns.
