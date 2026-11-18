// On-device dictation: listens to the microphone, cuts the speech into phrases at natural pauses, and turns each
// phrase into words with Steward's own speech model (js/whisper-worker.js). Needs no signal once the model is on
// the device. Same callbacks as Chrome's dictation in dictate.js, plus onStatus(text) for "writing it down…".

export const RATE = 16000;
const FRAME = 480; // 30 ms at 16 kHz

/**
 * Splits a stream of 16 kHz audio into spoken phrases. Feed it audio with push(); it calls onPhrase(Float32Array)
 * for each phrase, onSpeech(true/false) when speech starts or a phrase ends. flush() ends the phrase in progress.
 */
export class Segmenter {
  constructor({ onPhrase, onSpeech = () => {} }) {
    this.onPhrase = onPhrase; this.onSpeech = onSpeech;
    this.pending = new Float32Array(0);
    this.noise = 0.004;       // running level of the room when no one is talking
    this.pre = [];            // the last few quiet frames, so the first sound of a word is not cut off
    this.frames = null;       // frames of the phrase being heard (null = not in a phrase)
    this.run = 0;             // loud frames in a row (to start a phrase)
    this.quiet = 0;           // quiet frames in a row (to end one)
    this.voiced = 0;          // loud frames in this phrase
    this.lastSpeech = 0;      // samples since the last loud frame
    this.total = 0;
  }
  push(samples) {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending); all.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) this.frame(all.subarray(i, i + FRAME).slice());
    this.pending = all.slice(i);
  }
  frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    const loud = rms > Math.max(0.01, this.noise * 3);
    this.total += f.length;
    if (!this.frames) {
      if (!loud) this.noise = this.noise * 0.95 + Math.min(rms, this.noise * 4) * 0.05;
      this.pre.push(f); if (this.pre.length > 10) this.pre.shift();
      this.run = loud ? this.run + 1 : 0;
      if (this.run >= 3) { // ~90 ms of sound: a phrase has started
        this.frames = this.pre.slice(); this.pre = []; this.voiced = this.run; this.quiet = 0; this.run = 0;
        this.onSpeech(true);
      }
      this.lastSpeech += f.length;
      return;
    }
    this.frames.push(f);
    if (loud) { this.voiced++; this.quiet = 0; this.lastSpeech = 0; } else { this.quiet++; this.lastSpeech += f.length; }
    const secs = this.frames.length * FRAME / RATE;
    // End the phrase after a pause: 0.8 s normally, 0.35 s once it is long (keeps each piece short and quick),
    // and always before Whisper's 30-second limit.
    if (this.quiet >= 27 || (secs > 12 && this.quiet >= 12) || secs >= 25) this.end();
  }
  end() {
    const fr = this.frames; this.frames = null;
    if (!fr) return;
    const keep = Math.max(0, fr.length - Math.max(0, this.quiet - 7)); // leave ~200 ms of the pause
    const voiced = this.voiced; this.quiet = 0; this.voiced = 0;
    this.onSpeech(false);
    if (voiced < 8) return; // under ~a quarter second of sound: a bump or a breath, not words
    const out = new Float32Array(keep * FRAME);
    for (let i = 0; i < keep; i++) out.set(fr[i], i * FRAME);
    this.onPhrase(out);
  }
  flush() { if (this.frames) this.end(); }
  /** Seconds since anyone last spoke. */
  get silentFor() { return this.lastSpeech / RATE; }
}

/** Turns audio at any rate into 16 kHz (averaging when going down, so it stays clear). */
export function makeResampler(from) {
  if (from === RATE) return x => x;
  const step = from / RATE;
  let pos = 0, carry = new Float32Array(0);
  return input => {
    const x = new Float32Array(carry.length + input.length); x.set(carry); x.set(input, carry.length);
    const out = [];
    while (pos + step <= x.length) {
      const a = Math.floor(pos), b = Math.min(x.length, Math.floor(pos + step));
      let s = 0; for (let i = a; i < b; i++) s += x[i];
      out.push(b > a ? s / (b - a) : x[a]);
      pos += step;
    }
    const used = Math.floor(pos);
    carry = x.slice(used); pos -= used;
    return Float32Array.from(out);
  };
}

// What Whisper sometimes "hears" in noise or silence.
const PHANTOM = /^(?:thank you\.?|thanks for watching!?|thank you for watching\.?|you\.?|bye\.?|okay\.?|\.+|so\.?)$/i;
const SPOKEN_CMD = '(?:period|full stop|comma|question mark|exclamation (?:point|mark)|semicolon|colon|(?:new|next) line|(?:new|next) paragraph)';
/**
 * Clean Whisper's words so they read like Chrome's: drop sounds in brackets ("[BLANK_AUDIO]", "(wind blowing)"),
 * drop phantom phrases from very short pieces, and take off Whisper's own punctuation around spoken punctuation
 * ("Friday. Period." → "Friday period") so dictate.js turns it into exactly one mark.
 */
export function cleanWhisper(text, seconds = 5) {
  let t = String(text).replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || (seconds < 2.5 && PHANTOM.test(t))) return '';
  t = t.replace(new RegExp('[,.!?;:]*\\s*\\b(' + SPOKEN_CMD + ')\\b[,.!?;:]*', 'gi'), ' $1 ');
  return t.replace(/\s+/g, ' ').trim();
}

let worker = null, nextId = 1;
const waiting = new Map();
const progressFns = new Set();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const m = e.data;
    if (m.progress) { progressFns.forEach(f => f(m.progress)); return; }
    const w = waiting.get(m.id); if (!w) return;
    waiting.delete(m.id);
    m.error ? w.reject(new Error(m.error)) : w.resolve(m);
  };
  worker.onerror = e => { for (const w of waiting.values()) w.reject(new Error(e.message || 'speech model failed')); waiting.clear(); worker = null; };
  return worker;
}
const ask = (msg, transfer) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); getWorker().postMessage({ id, ...msg }, transfer || []); });
/** Load the speech model now (so the first phrase is quick). */
export const warmUp = () => ask({ warm: true });
const transcribe = audio => ask({ audio }, [audio.buffer]).then(m => m.text);

/** Start on-device listening. Returns { stop, on }. */
export function deviceListen({ onFinal, onEnd = () => {}, onError = () => {}, onStatus = () => {} } = {}) {
  let stopped = false, ended = false, stream = null, ctx = null, node = null, quietTimer = null;
  let queue = Promise.resolve(), busy = 0, hearing = false, ready = false;
  const status = () => onStatus(!ready ? 'Getting the speech model ready…' : busy ? 'Writing it down…' : hearing ? 'Hearing you…' : '');
  const onProgress = p => { if (!ready) onStatus(`Getting the speech model ready… ${p.pct}%`); };
  progressFns.add(onProgress);
  const seg = new Segmenter({
    onSpeech: on => { hearing = on; status(); },
    onPhrase: audio => {
      const secs = audio.length / RATE;
      busy++; status();
      queue = queue.then(() => transcribe(audio)).then(t => { const c = cleanWhisper(t, secs); if (c) onFinal(c); })
        .catch(e => { if (!stopped) onError('The speech model on this device had a problem: ' + (e?.message || e)); })
        .finally(() => { busy--; status(); });
    },
  });
  const release = () => {
    clearInterval(quietTimer);
    try { node?.disconnect(); } catch {}
    stream?.getTracks().forEach(t => t.stop());
    ctx?.close().catch(() => {});
  };
  const session = {
    get on() { return !stopped; },
    stop() {
      if (stopped) return;
      stopped = true; release(); seg.flush();
      // let the last phrases finish before saying we are done
      queue.finally(() => { if (ended) return; ended = true; progressFns.delete(onProgress); onStatus(''); onEnd(); });
    },
  };
  const fail = msg => { onError(msg); session.stop(); };
  (async () => {
    warmUp().then(() => { ready = true; status(); }).catch(e => fail(/404|Failed to fetch|NetworkError|Could not locate/i.test(String(e?.message)) ? 'The speech model is not on this device yet. Connect to Wi-Fi and open Settings → Speak instead of type → Download the speech model.' : 'The speech model could not start: ' + (e?.message || e)));
    status();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      return fail(e?.name === 'NotAllowedError' ? 'Steward is not allowed to use the microphone. Allow it in Chrome\'s site settings (the icon left of the address), then try again.' : e?.name === 'NotFoundError' ? 'No microphone was found.' : 'The microphone could not start: ' + (e?.message || e));
    }
    if (stopped) { release(); return; }
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
    if (stopped) { release(); return; }
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'steward-mic');
    const toRate = makeResampler(ctx.sampleRate);
    node.port.onmessage = e => { if (!stopped) seg.push(toRate(e.data)); };
    src.connect(node); node.connect(ctx.destination); // its output is silence; connecting keeps Chrome running it
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    // Stop on its own after 30 seconds with nothing said, like Chrome's dictation does.
    quietTimer = setInterval(() => { if (!busy && !hearing && seg.silentFor > 30) session.stop(); }, 1000);
  })().catch(e => fail('Dictation could not start: ' + (e?.message || e)));
  return session;
}
