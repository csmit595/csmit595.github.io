// Web Push from the Google helper: sends Steward's reminders straight to the phone and the Mac (no Google Calendar).
// Standard Web Push (RFC 8291 message encryption, RFC 8292 "VAPID" sender identity), written for Apps Script, which
// has no WebCrypto: the maths comes from the audited @noble libraries, bundled in by build.sh.
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';

// Apps Script has no TextEncoder, atob, btoa or URL, so the few bits needed are written out here.
const utf8 = s => Uint8Array.from(unescape(encodeURIComponent(s)), c => c.charCodeAt(0));
const enc = { encode: utf8 };
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
export function b64u(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '') + (i + 2 < bytes.length ? B64[n & 63] : '');
  }
  return out;
}
export function unb64u(str) {
  const s = String(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), out = [];
  let n = 0, bits = 0;
  for (const c of s) { const v = B64.indexOf(c); if (v < 0) throw new Error('bad base64'); n = (n << 6) | v; bits += 6; if (bits >= 8) { bits -= 8; out.push((n >> bits) & 255); } }
  return Uint8Array.from(out);
}

/** A new sender key pair. The secret half stays in the helper's own settings; the public half goes to Drive for the devices. */
export function newKeys() {
  const sk = p256.utils.randomSecretKey();
  return { secret: b64u(sk), public: b64u(p256.getPublicKey(sk, false)) };
}

/** RFC 8291 (aes128gcm): encrypt a message so only the device that subscribed can read it. */
export function encrypt(sub, text, salt = p256.utils.randomSecretKey().slice(0, 16), asSecret = p256.utils.randomSecretKey()) {
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  if (uaPublic.length !== 65 || auth.length !== 16) throw new Error('bad device keys');
  const asPublic = p256.getPublicKey(asSecret, false);
  const shared = p256.getSharedSecret(asSecret, uaPublic, true).slice(1); // the x coordinate
  const ikm = hkdf(sha256, shared, auth, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = hkdf(sha256, ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(sha256, ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const body = gcm(cek, nonce).encrypt(cat(enc.encode(text), Uint8Array.of(2))); // 2 = last (only) record
  const rs = 4096;
  return cat(salt, Uint8Array.of(rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length), asPublic, body);
}

/** RFC 8292: a signed note saying the message comes from Steward's own sender key. */
export function vapid(endpoint, keys, now = Date.now()) {
  const aud = /^https:\/\/[^/]+/.exec(endpoint)?.[0];
  if (!aud) throw new Error('not a push address');
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'https://csmit595.github.io/steward/' })));
  const sig = p256.sign(enc.encode(`${head}.${claims}`), unb64u(keys.secret), { prehash: true, format: 'compact' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.public}`;
}

/** Everything needed to send one message: url, headers and the encrypted body. */
export function request(sub, keys, message, ttl = 3600) {
  return {
    url: sub.endpoint,
    headers: { Authorization: vapid(sub.endpoint, keys), TTL: String(ttl), Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' },
    body: encrypt(sub, JSON.stringify(message)),
  };
}
