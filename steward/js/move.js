// Steward moved from GitHub (csmit595.github.io/steward) to Google's Firebase Hosting (steward-cs.web.app).
// On the old address only, Steward shows a "Steward has moved" screen. "Move" makes one last sync so nothing is lost,
// takes this device off the notification list, then wipes everything Steward kept at the old address (including the
// Google sign-in) and opens the new address. The Google sign-in is NOT revoked: that would also sign out devices that
// have already moved. Your data lives in Google Drive, so the new address picks it all up after you sign in there.
import { h } from './util.js';
import { store } from './store.js';
import { sync } from './sync.js';
import { btn, modal, toast } from './ui.js';

export const NEW_HOME = 'https://steward-cs.web.app/';
export const isOldHome = () => /(^|\.)github\.io$/i.test(location.hostname);

async function wipeAndGo() {
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  try {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    await Promise.all(dbs.map(d => d.name && new Promise(res => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = res; })));
  } catch {}
  location.replace(NEW_HOME);
}

async function move(setLine, button) {
  button.disabled = true;
  try {
    if (sync.connected()) {
      if (!navigator.onLine) throw new Error('No connection. Connect to the internet, then tap Move again.');
      setLine('Saving your last changes to Google Drive…');
      await store.flush().catch(() => {});
      await sync.run(true);
      if (sync.busy) await new Promise(r => { const t = setInterval(() => { if (!sync.busy) { clearInterval(t); r(); } }, 300); });
      if (sync.status !== 'idle') throw new Error('The last sync did not finish (' + (sync.message || sync.status) + '). Nothing was removed. Try Move again in a minute.');
      if (store.isDirty('tasks')) throw new Error('Some task changes have not reached Google Drive yet. Nothing was removed. Try Move again in a minute.');
      if (sync.attWaiting > 0) throw new Error(`${sync.attWaiting} photo or file upload(s) are still waiting. Nothing was removed. Try Move again once you have a good connection.`);
      setLine('Taking this device off the old notification list…');
      try { if (sync.pushInfo().mine) await sync.removeDevice(); } catch {}
    }
    setLine('Clearing the old copy and opening the new address…');
    await wipeAndGo();
  } catch (e) {
    setLine(e.message || String(e));
    button.disabled = false;
  }
}

/** Call once Steward has started. On the old address it shows the move screen; elsewhere it does nothing. */
export function offerMove() {
  if (!isOldHome()) return;
  modal(close => {
    const line = h('p', { class: 'sub' }, '');
    const go = btn('Move to the new address', () => move(t => { line.textContent = t; }, go), 'primary');
    return h('div', { class: 'move-panel' },
      h('h2', null, 'Steward has moved'),
      h('p', null, 'Steward now lives at steward-cs.web.app, on Google instead of GitHub. Your tasks, notes and documents are in your Google Drive, so nothing is lost.'),
      h('p', null, 'Tap Move. Steward saves your last changes to Drive, clears this old copy from this device (including its Google sign-in) and opens the new address. There, install Steward and connect your Google account again.'),
      line,
      h('div', { class: 'row gap wrap' }, go, btn('Not now', () => { close(); toast('Steward will ask again next time you open it.'); }, 'link')));
  });
}
