// Calendar: Google Calendar events and dated tasks together, in day / 3-day / week / month / agenda views.
import { h, fill, today, addDays, fromYmd, ymd, pad, fmtTime, fmtDate, sanitize } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { sync, isoLocal } from './sync.js';
import { icon, btn, iconBtn, modal, confirmDlg, toast, isMobile } from './ui.js';
import { openTask } from './tasks.js';

let HOUR = 52; // px per hour; taller on phones so short tasks stay readable
let anchor = today();
let savedScroll = null;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const minsOf = d => d.getHours() * 60 + d.getMinutes();

function itemsFor(day, withBlocks = false) {
  const dayStart = fromYmd(day), dayEnd = fromYmd(addDays(day, 1));
  const allDay = [], timed = [];
  for (const e of sync.events) {
    if (e.allDay) { if (e.start <= day && day < e.end) allDay.push({ kind: 'event', e, title: e.title, color: e.color }); continue; }
    const s = new Date(e.start), en = new Date(e.end);
    if (s < dayEnd && en > dayStart) {
      if (en - s >= 864e5) { allDay.push({ kind: 'event', e, title: e.title, color: e.color }); continue; }
      timed.push({ kind: 'event', e, title: e.title, color: e.color, start: s < dayStart ? 0 : minsOf(s), end: en >= dayEnd ? 1440 : minsOf(en) });
    }
  }
  for (const t of M.openTasks()) {
    if (t.due?.date !== day) continue;
    if (t.due.time) { const [H, Mi] = t.due.time.split(':').map(Number); timed.push({ kind: 'task', t, title: t.content, start: H * 60 + Mi, end: Math.min(1440, H * 60 + Mi + (t.duration || 30)) }); }
    else allDay.push({ kind: 'task', t, title: t.content });
  }
  // fixed blocks (devotions, classes, dinner, church) show faintly on the day and week grids
  if (withBlocks) for (const x of M.blocksOn(day)) timed.push({ kind: 'block', b: x.b, title: x.b.name, start: x.start, end: x.end });
  timed.sort((a, b) => a.start - b.start || b.end - a.end);
  return { allDay, timed };
}
function layout(timed) {
  let cluster = [], clusterEnd = -1; const cols = [];
  const flush = () => { const n = Math.max(1, ...cluster.map(i => i.col + 1)); for (const i of cluster) i.cols = n; cluster = []; cols.length = 0; };
  for (const it of timed) {
    if (cluster.length && it.start >= clusterEnd) { flush(); clusterEnd = -1; }
    let c = cols.findIndex(end => end <= it.start);
    if (c < 0) c = cols.length;
    cols[c] = Math.max(it.end, it.start + Math.ceil(24 / HOUR * 60)); /* a short item is still drawn about 22px tall */ it.col = c; cluster.push(it); clusterEnd = Math.max(clusterEnd, cols[c]);
  }
  flush();
  return timed;
}
const open = it => (it.kind === 'task' ? openTask(it.t.id) : it.kind === 'block' ? (location.hash = '#/settings/blocks') : editEvent(it.e));
const chip = it => h('button', { class: 'cchip ' + it.kind, style: it.kind === 'event' ? { background: it.color } : null, title: it.title, onclick: e => { e.stopPropagation(); open(it); } }, it.kind === 'task' && h('span', { class: `dot pri${it.t.priority || 4}` }), it.start != null && h('span', { class: 'ct' }, fmtTime(`${pad(Math.floor(it.start / 60))}:${pad(it.start % 60)}`)), it.title);

export function renderCalendar(route, main) {
  // Phones: tall hours for thumbs. Desktop: size hours so about 6 AM to 9 PM fits the window without scrolling.
  HOUR = isMobile() ? 64 : Math.max(40, Math.min(60, Math.floor((window.innerHeight - 210) / 15)));
  let view = settings.get('calView');
  if (isMobile() && view === 'week') view = '3day';
  const n = { day: 1, '3day': 3, week: 7 }[view];
  let from = anchor;
  if (view === 'week') from = addDays(anchor, -((fromYmd(anchor).getDay() - settings.get('weekStart') + 7) % 7));
  if (view === 'month') { const d = fromYmd(anchor); from = ymd(new Date(d.getFullYear(), d.getMonth(), 1)); }
  const shift = dir => { if (view === 'month') { const d = fromYmd(anchor); anchor = ymd(new Date(d.getFullYear(), d.getMonth() + dir, 1)); } else anchor = addDays(anchor, dir * (view === 'agenda' ? 14 : n)); store.emit({}); };
  const a = fromYmd(from);
  const title = view === 'month' ? a.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : view === 'day' ? a.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : a.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const viewSel = h('select', { class: 'field slim', 'aria-label': 'Calendar view', onchange: () => { settings.set('calView', viewSel.value); store.emit({}); } },
    [['day', 'Day'], ['3day', '3 days'], ['week', 'Week'], ['month', 'Month'], ['agenda', 'Agenda']].map(([v, l]) => h('option', { value: v }, l)));
  viewSel.value = view;
  main.className = 'cal';
  main.append(h('header', { class: 'vhead' }, h('div', null, h('h1', null, title)),
    h('div', { class: 'row' }, iconBtn('left', 'Earlier', () => shift(-1)), btn('Today', () => { anchor = today(); store.emit({}); }, 'tiny'), iconBtn('right', 'Later', () => shift(1)), viewSel, btn('New', () => editEvent({ date: anchor }), 'primary', 'plus'))));
  if (!sync.connected()) main.append(h('div', { class: 'banner' }, 'Showing your dated tasks. ', h('a', { href: '#/settings' }, 'Connect Google'), ' to see and edit your Google Calendar here.'));
  const span = view === 'month' ? 42 : view === 'agenda' ? 30 : n;
  sync.ensureRange(fromYmd(addDays(from, -7)), fromYmd(addDays(from, span + 7))).then(ch => { if (ch) store.emit({}); });
  if (view === 'month') return main.append(monthGrid(from));
  if (view === 'agenda') return main.append(agenda(from));
  main.append(timeGrid(from, n));
}

function timeGrid(from, n) {
  const days = Array.from({ length: n }, (_, i) => addDays(from, i)), now = today();
  const data = days.map(d => itemsFor(d, true));
  const head = h('div', { class: 'cg-head' }, h('div', { class: 'gut' }), days.map(d => h('button', { class: 'cg-day' + (d === now ? ' now' : ''), onclick: () => { anchor = d; settings.set('calView', 'day'); store.emit({}); } }, h('span', null, DOW[fromYmd(d).getDay()]), h('b', null, fromYmd(d).getDate()))));
  const allday = h('div', { class: 'cg-allday' }, h('div', { class: 'gut' }, 'all day'), data.map((x, i) => h('div', { class: 'cg-cell', onclick: () => editEvent({ date: days[i], allDay: true }) }, x.allDay.map(chip))));
  const body = h('div', { class: 'cg-body', style: { height: 24 * HOUR + 'px' } },
    h('div', { class: 'gut' }, Array.from({ length: 24 }, (_, hr) => h('div', { class: 'hr', style: { top: hr * HOUR + 'px' } }, hr ? fmtTime(pad(hr) + ':00') : ''))),
    data.map((x, i) => {
      const col = h('div', { class: 'cg-col' + (days[i] === now ? ' now' : ''), onclick: e => { if (e.target !== col) return; const m = Math.floor((e.offsetY / HOUR) * 2) * 30; editEvent({ date: days[i], time: `${pad(Math.floor(m / 60))}:${pad(m % 60)}` }); } },
        layout(x.timed).map(it => h('button', { class: 'cblock ' + it.kind + ((it.end - it.start) / 60 * HOUR < 44 ? ' short' : '') + (it.kind === 'task' ? ` pri${it.t.priority || 4}` : ''), title: it.title,
          style: { top: (it.start / 60) * HOUR + 'px', height: Math.max(22, ((it.end - it.start) / 60) * HOUR - 2) + 'px', left: `calc(${(it.col / it.cols) * 100}% + 1px)`, width: `calc(${100 / it.cols}% - 3px)`, ...(it.kind === 'event' ? { background: it.color } : it.kind === 'task' ? { borderLeftColor: M.COLORS[store.get('projects', it.t.projectId)?.color] || '' } : {}) },
          onclick: e => { e.stopPropagation(); open(it); } }, h('b', null, it.title), h('span', null, fmtTime(`${pad(Math.floor(it.start / 60))}:${pad(it.start % 60)}`)))));
      if (days[i] === now) col.append(h('div', { class: 'nowline', style: { top: (minsOf(new Date()) / 60) * HOUR + 'px' } }));
      return col;
    }));
  const scroll = h('div', { class: 'cg-scroll' }, body);
  const grid = h('div', { class: 'cg', style: { '--n': n } }, head, allday, scroll);
  grid.style.setProperty('--n', n); grid.style.setProperty('--hour', HOUR + 'px');
  requestAnimationFrame(() => { scroll.scrollTop = savedScroll ?? Math.max(0, Math.min(isMobile() ? 7 : 6, new Date().getHours() - 1) * HOUR); scroll.addEventListener('scroll', () => { savedScroll = scroll.scrollTop; }); });
  return grid;
}
function monthGrid(first) {
  const ws = settings.get('weekStart'), now = today(), month = fromYmd(first).getMonth();
  const start = addDays(first, -((fromYmd(first).getDay() - ws + 7) % 7));
  const max = isMobile() ? 2 : 4;
  return h('div', { class: 'cm' }, Array.from({ length: 7 }, (_, i) => h('div', { class: 'cm-dow' }, DOW[(i + ws) % 7])),
    Array.from({ length: 42 }, (_, i) => {
      const d = addDays(start, i), x = itemsFor(d), items = [...x.allDay, ...x.timed];
      return h('div', { class: 'cm-cell' + (fromYmd(d).getMonth() !== month ? ' out' : '') + (d === now ? ' now' : ''), onclick: () => { anchor = d; settings.set('calView', 'day'); store.emit({}); } },
        h('div', { class: 'cm-num' }, fromYmd(d).getDate()), items.slice(0, max).map(chip), items.length > max && h('div', { class: 'cm-more' }, `+${items.length - max} more`));
    }));
}
function agenda(from) {
  const out = h('div', { class: 'agenda' });
  for (let i = 0; i < 30; i++) {
    const d = addDays(from, i), x = itemsFor(d), items = [...x.allDay, ...x.timed];
    if (!items.length && d !== today()) continue;
    out.append(h('section', { class: 'group' }, h('div', { class: 'ghead' }, h('h3', null, fmtDate(d, true))), items.length ? h('div', { class: 'ag-items' }, items.map(chip)) : h('div', { class: 'sub' }, 'Nothing scheduled')));
  }
  if (!out.children.length) out.append(h('div', { class: 'empty' }, h('strong', null, 'Nothing scheduled'), h('p', null, 'in the next 30 days.')));
  return out;
}

const REPEATS = [['', 'Does not repeat'], ['RRULE:FREQ=DAILY', 'Every day'], ['RRULE:FREQ=WEEKLY', 'Every week'], ['RRULE:FREQ=WEEKLY;INTERVAL=2', 'Every 2 weeks'], ['RRULE:FREQ=MONTHLY', 'Every month'], ['RRULE:FREQ=YEARLY', 'Every year']];
/** Create or edit a calendar event. For a new item you can switch between "Event" (Google Calendar) and "Task". */
export function editEvent(ev) {
  const isNew = !ev.id;
  const canEvent = sync.connected();
  if (ev.id && ev.readOnly) {
    return modal(() => h('div', { class: 'form' }, h('p', { class: 'sub' }, whenText(ev)), ev.location && h('p', null, ev.location), ev.description && h('div', { class: 'ev-desc', html: safe(ev.description) }), h('p', { class: 'sub' }, 'This calendar is read-only.')), { title: ev.title, cls: 'small' });
  }
  modal(close => {
    let kind = canEvent ? 'event' : 'task';
    const cals = sync.calendars().filter(c => ['owner', 'writer'].includes(c.accessRole) && c.summary !== 'Steward Reminders');
    const s0 = ev.start ? (ev.allDay ? fromYmd(ev.start) : new Date(ev.start)) : new Date(`${ev.date || today()}T${ev.time || '09:00'}:00`);
    const e0 = ev.end ? (ev.allDay ? fromYmd(addDays(ev.end, -1)) : new Date(ev.end)) : new Date(s0.getTime() + 3600000);
    const title = h('input', { class: 'field', placeholder: 'Title', value: ev.title || '', autofocus: true });
    const allDay = h('input', { type: 'checkbox', checked: ev.allDay ?? (isNew && !ev.time && !!ev.allDay) });
    const sd = h('input', { type: 'date', class: 'field', value: ymd(s0) }), st = h('input', { type: 'time', class: 'field', value: `${pad(s0.getHours())}:${pad(s0.getMinutes())}` });
    const ed = h('input', { type: 'date', class: 'field', value: ymd(e0) }), et = h('input', { type: 'time', class: 'field', value: `${pad(e0.getHours())}:${pad(e0.getMinutes())}` });
    sd.addEventListener('change', () => { if (ed.value < sd.value) ed.value = sd.value; });
    st.addEventListener('change', () => { if (sd.value === ed.value && et.value <= st.value) { const [H, Mi] = st.value.split(':').map(Number); et.value = `${pad(Math.min(23, H + 1))}:${pad(Mi)}`; } });
    const cal = h('select', { class: 'field' }, cals.map(c => h('option', { value: c.id }, c.summary)));
    cal.value = ev.calId || cals.find(c => c.primary)?.id || cals[0]?.id || '';
    const rep = h('select', { class: 'field' }, REPEATS.map(([v, l]) => h('option', { value: v }, l)));
    const loc = h('input', { class: 'field', placeholder: 'Location', value: ev.location || '' });
    const desc0 = (ev.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    const desc = h('textarea', { class: 'field', rows: 3, placeholder: 'Notes', value: desc0 });
    const evOnly = h('div', { class: 'form' }, h('label', null, 'Ends', h('div', { class: 'row gap' }, ed, et)), h('label', null, 'Calendar', cal), isNew && h('label', null, 'Repeat', rep), h('label', null, 'Location', loc), h('label', null, 'Notes', desc));
    const sync1 = () => { st.hidden = et.hidden = allDay.checked; evOnly.hidden = kind !== 'event'; };
    allDay.addEventListener('change', sync1);
    const tabs = isNew && h('div', { class: 'seg' }, ['event', 'task'].map(k => h('button', { type: 'button', class: k === kind ? 'on' : '', disabled: k === 'event' && !canEvent, onclick: e => { kind = k; tabs.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); sync1(); } }, k === 'event' ? 'Calendar event' : 'Task')));
    sync1();
    let busy = false;
    const save = async () => {
      if (!title.value.trim() || busy) return title.focus();
      if (kind === 'task') { M.addTask({ content: title.value.trim(), due: { date: sd.value, time: allDay.checked ? null : st.value, recur: null } }); toast('Task added'); return close(); }
      busy = true;
      // notes left untouched keep their original formatting (links from invitations and the like)
      const out = { id: ev.id, calId: cal.value, title: title.value.trim(), allDay: allDay.checked, location: loc.value, description: desc.value === desc0 ? (ev.description || '') : desc.value, rrule: isNew ? rep.value : '' };
      if (allDay.checked) { out.start = sd.value; out.end = addDays(ed.value < sd.value ? sd.value : ed.value, 1); }
      else { out.start = new Date(`${sd.value}T${st.value}:00`).toISOString(); let en = new Date(`${ed.value}T${et.value}:00`); if (en <= new Date(out.start)) en = new Date(new Date(out.start).getTime() + 3600000); out.end = en.toISOString(); }
      try {
        if (ev.id && ev.calId && ev.calId !== cal.value) { await sync.deleteEvent(ev); out.id = undefined; }
        await sync.saveEvent(out); toast('Saved to Google Calendar'); close();
      } catch (e) { busy = false; toast(navigator.onLine ? 'Google Calendar would not save that: ' + (e.detail || e.message) : 'You are offline. Calendar events need a connection.'); }
    };
    title.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    return h('div', { class: 'form' }, tabs, title, h('label', { class: 'inline' }, allDay, ' All day'), h('label', null, 'Starts', h('div', { class: 'row gap' }, sd, st)), evOnly,
      ev.recurringEventId && h('p', { class: 'sub' }, 'This is one occurrence of a repeating event. Changes apply to this occurrence only.'),
      h('div', { class: 'row end wrap' },
        ev.id && ev.recurringEventId && btn('Delete all occurrences', async () => { if (await confirmDlg(`Delete every occurrence of "${ev.title}"?`, 'Delete all')) { try { await sync.deleteEvent(ev, true); close(); } catch (e) { toast('Could not delete: ' + (e.detail || e.message)); } } }, 'danger'),
        ev.id && btn(ev.recurringEventId ? 'Delete this one' : 'Delete', async () => {
        if (!(await confirmDlg(`Delete "${ev.title}" from Google Calendar?`))) return;
        try { await sync.deleteEvent(ev, false); close(); } catch (e) { toast('Could not delete: ' + (e.detail || e.message)); }
      }, 'danger'), btn('Cancel', close), btn('Save', save, 'primary')));
  }, { title: isNew ? 'New' : 'Edit event' });
}
const safe = html => sanitize(html);
const whenText = ev => ev.allDay ? fmtDate(ev.start, true) : `${new Date(ev.start).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} to ${new Date(ev.end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
