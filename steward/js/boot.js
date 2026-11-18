// Start-up: wait for any background sync still running, take what it saved, then load the app.
import { hydrate } from './lsmirror.js';

const ready = async () => { try { await hydrate(); } catch (e) { console.warn('hydrate', e); } };
if (navigator.locks) await navigator.locks.request('steward-sync', ready); else await ready();
await import('./app.js');
