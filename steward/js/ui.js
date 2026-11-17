// Shared interface pieces: icons, dialogs, menus, toasts.
import { h } from './util.js';

const P = {
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  today: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 14v4M10 16h4',
  upcoming: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
  check: 'M20 6 9 17l-5-5',
  done: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
  cal: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.8-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.8H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  menu: 'M3 6h18M3 12h18M3 18h18',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  back: 'M19 12H5M12 19l-7-7 7-7',
  left: 'M15 18l-6-6 6-6', right: 'M9 18l6-6-6-6', down: 'M6 9l6 6 6-6',
  repeat: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  comment: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  sub: 'M6 3v12a3 3 0 0 0 3 3h9M15 15l3 3-3 3',
  pin: 'M12 17v5M5 17h14l-2-4V6h1V3H6v3h1v7z',
  clip: 'M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  mic: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.200l-5-4.9 6.9-1z',
  sync: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.800-3.400L23 10M1 14l4.600 4.400A9 9 0 0 0 20.500 15',
  board: 'M4 3h5v18H4zM10 3h5v12h-5zM16 3h4v8h-4z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  edit: 'M12 20h9M16.5 3.500a2.100 2.100 0 0 1 3 3L7 19l-4 1 1-4z',
  cloudoff: 'M22.600 16.900A5 5 0 0 0 18 10h-1.300A8 8 0 0 0 5 5.300M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.700-.300M1 1l22 22',
};
export function icon(name, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] || P.more); s.append(p);
  return s;
}
export const btn = (label, onclick, cls = '', ic) => h('button', { class: 'btn ' + cls, onclick, type: 'button' }, ic && icon(ic, 16), label);
export const iconBtn = (ic, title, onclick, cls = '') => h('button', { class: 'ibtn ' + cls, title, 'aria-label': title, onclick, type: 'button' }, icon(ic));

const stack = [];
/** Open a dialog. Returns a function that closes it. */
export function modal(build, opts = {}) {
  const root = document.getElementById('modal-root');
  const close = () => { if (!wrap.isConnected) return; wrap.remove(); stack.splice(stack.indexOf(close), 1); opts.onClose?.(); };
  const body = h('div', { class: 'modal-body' });
  const card = h('div', { class: 'modal ' + (opts.cls || ''), role: 'dialog', 'aria-modal': 'true' },
    opts.title && h('div', { class: 'modal-head' }, h('h2', null, opts.title), iconBtn('x', 'Close', close)), body);
  const wrap = h('div', { class: 'modal-wrap', onpointerdown: e => { if (e.target === wrap) close(); } }, card);
  const built = build(close, body);
  if (built) body.append(built);
  root.append(wrap); stack.push(close);
  setTimeout(() => (card.querySelector('[autofocus]') || card.querySelector('input,textarea'))?.focus(), 30);
  return close;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && stack.length) { e.preventDefault(); stack[stack.length - 1](); } });
export const modalOpen = () => stack.length > 0;

export function confirmDlg(message, okLabel = 'Delete', danger = true) {
  return new Promise(res => {
    let answered = false;
    modal(close => h('div', null, h('p', { class: 'dlg-msg' }, message),
      h('div', { class: 'row end' }, btn('Cancel', close), btn(okLabel, () => { answered = true; res(true); close(); }, danger ? 'danger' : 'primary'))),
    { cls: 'small', onClose: () => { if (!answered) res(false); } });
  });
}
export function promptDlg(title, value = '', placeholder = '') {
  return new Promise(res => {
    let answered = false;
    modal(close => {
      const input = h('input', { class: 'field', value, placeholder, autofocus: true });
      const ok = () => { answered = true; res(input.value.trim()); close(); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
      return h('div', null, input, h('div', { class: 'row end' }, btn('Cancel', close), btn('Save', ok, 'primary')));
    }, { title, cls: 'small', onClose: () => { if (!answered) res(null); } });
  });
}
export function toast(msg, action, onAction, ms = 5000) {
  const t = h('div', { class: 'toast' }, h('span', null, msg), action && h('button', { onclick: () => { onAction(); t.remove(); } }, action));
  const box = document.getElementById('toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  box.append(t);
  setTimeout(() => t.remove(), ms);
}
/** Small pop-up menu anchored to an element. items: [{label, icon, onclick, danger}] or '-' */
export function menu(anchor, items) {
  document.querySelector('.popmenu')?.remove();
  const m = h('div', { class: 'popmenu' }, items.filter(Boolean).map(it => it === '-' ? h('hr') :
    h('button', { class: it.danger ? 'danger' : '', onclick: () => { m.remove(); it.onclick(); } }, it.icon && icon(it.icon, 16), it.label)));
  document.body.append(m);
  const r = anchor.getBoundingClientRect(), w = m.offsetWidth, ht = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
  m.style.top = (r.bottom + ht + 8 > window.innerHeight ? Math.max(8, r.top - ht - 4) : r.bottom + 4) + 'px';
  const off = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
  setTimeout(() => document.addEventListener('pointerdown', off, true));
}
export const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
