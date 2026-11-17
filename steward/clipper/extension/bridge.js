// Runs inside Steward's own page. Passes clips from the extension to Steward and Steward's answers back.
if (!globalThis.__stewardBridge) {
  globalThis.__stewardBridge = true;
  let ready = false;
  const pending = new Map(); // clip id -> reply function
  const waitingForReady = [];

  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
    const d = e.data;
    if (d.steward === 'ext-ready') {
      // Steward is open and loaded: remember its notebooks and tags for the clipper, then collect waiting clips.
      ready = true;
      if (d.meta) chrome.storage.local.set({ meta: { ...d.meta, at: Date.now() } });
      waitingForReady.splice(0).forEach(f => f());
      chrome.runtime.sendMessage({ type: 'bridge-ready' }).catch(() => {});
    }
    if (d.steward === 'ext-saved' && pending.has(d.id)) { const fs = pending.get(d.id); pending.delete(d.id); fs.forEach(f => f(d)); }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'ping') { reply({ ready }); return; }
    if (msg.type !== 'deliver' || !msg.clip) return;
    const send = () => {
      const id = msg.clip.id, again = pending.has(id);
      let answered = false;
      const answer = r => { if (!answered) { answered = true; clearTimeout(t); reply(r); } };
      const t = setTimeout(() => answer({ ok: false, error: 'Steward took too long to save the clip' }), 90000);
      if (!again) pending.set(id, []);
      pending.get(id).push(d => answer({ ok: !!d.ok, noteId: d.noteId, notebook: d.notebook, error: d.error }));
      if (!again) window.postMessage({ steward: 'ext-clip', clip: msg.clip }, location.origin);
    };
    ready ? send() : waitingForReady.push(send);
    return true;
  });

  // Steward may already be loaded: ask it to say so.
  window.postMessage({ steward: 'ext-ping' }, location.origin);
}
