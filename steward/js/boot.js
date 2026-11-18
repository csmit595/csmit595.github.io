// Start-up: wait for any background sync still running, take what it saved, then load the app.
import { hydrate } from './lsmirror.js';

const ready = async () => { try { await hydrate(); } catch (e) { console.warn('hydrate', e); } };
// Wait for a sync in another Steward window or the background to finish, but never for more than 4 seconds: a window
// stuck on something must not stop Steward from opening.
if (navigator.locks) {
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 4000);
  try { await navigator.locks.request('steward-sync', { signal: stop.signal }, ready); }
  catch { await ready(); }
  finally { clearTimeout(timer); }
} else await ready();
await import('./app.js');
