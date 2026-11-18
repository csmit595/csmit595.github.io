// Background sync: runs inside the service worker while Steward is closed (Chrome on Android and on the Mac).
// It does the same sync the open app does: brings this device's copy up to date from Google Drive, applies Claude's
// change files, uploads changes made here, and keeps the "Steward Reminders" calendar right, so the phone buzzes for
// tasks Claude added even if Steward was never opened.
import { loadShim, saveShim } from './lsmirror.js'; // must stay first: provides localStorage to the modules below
import { store } from './store.js';
import { sync } from './sync.js';

async function windows() { return self.clients.matchAll({ type: 'window', includeUncontrolled: true }); }

async function work(reason) {
  const open = await windows();
  // Steward is on screen: let it sync itself (it shows progress and holds the newest edits in memory).
  if (open.some(c => c.visibilityState === 'visible')) { for (const c of open) c.postMessage({ steward: 'sync-now' }); return; }
  if (!(await loadShim())) return; // never set up on this device
  if (!sync.connected() || !sync.staysSignedIn()) return; // without a saved Google pass, signing in needs a tap
  sync.background = true;
  sync.lastSync = Number(JSON.parse(localStorage.getItem('steward.lastSync') || '0')) || 0;
  try {
    await store.init();
    await sync.loadCachedEvents();
    for (let i = 0; i < 3; i++) { sync.again = false; await sync._run(false); if (!sync.again) break; }
    await store.flush();
  } finally {
    localStorage.setItem('steward.bgSync', JSON.stringify({ at: Date.now(), reason, status: sync.status, message: sync.message }));
    await saveShim();
  }
  // A hidden (not closed) Steward window still holds the old copy in memory: tell it to reload when next shown.
  for (const c of open) c.postMessage({ steward: 'reload' });
}

/** Run one background sync; never two at once, and never at the same time as the app starting up. */
export function bgSync(reason) {
  const go = () => work(reason).catch(e => console.warn('background sync', e));
  return navigator.locks ? navigator.locks.request('steward-sync', go) : go();
}
