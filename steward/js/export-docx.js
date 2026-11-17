// Builds a real Word (.docx) file from a document: title page, body, true Word footnotes, page numbers, bibliography.
const load = () => window.docx ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('vendor/docx/docx.js', document.baseURI).href; s.onload = res; s.onerror = () => rej(new Error('offline')); document.head.append(s); });
const FONT = 'Times New Roman';

export async function toDocx(doc, { meta, notes, bib }) {
  await load();
  const D = window.docx;
  const size = Math.round(meta.fontSize * 2), line = Math.round(meta.spacing * 240);
  const numOf = new Map(notes.map(n => [n.id, n.n]));
  let listSeq = 0;

  // inline content -> runs
  const runs = (node, f = {}) => {
    const out = [];
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { if (c.data) out.push(new D.TextRun({ text: c.data.replace(/\s+/g, ' '), font: FONT, size: f.size || size, bold: f.bold, italics: f.italics, underline: f.underline ? {} : undefined, superScript: f.sup, subScript: f.sub, strike: f.strike })); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (t === 'SUP' && c.classList.contains('fn')) { const n = numOf.get(c.dataset.fn); if (n) out.push(new D.FootnoteReferenceRun(n)); continue; }
      if (t === 'BR') { if (c.nextSibling) out.push(new D.TextRun({ break: 1 })); continue; }
      const g = { ...f };
      if (t === 'B' || t === 'STRONG') g.bold = true; else if (t === 'I' || t === 'EM') g.italics = true; else if (t === 'U') g.underline = true;
      else if (t === 'SUP') g.sup = true; else if (t === 'SUB') g.sub = true; else if (t === 'S' || t === 'STRIKE') g.strike = true;
      const st = c.getAttribute('style') || '';
      if (/font-weight:\s*(bold|[6-9]00)/.test(st)) g.bold = true; if (/font-style:\s*italic/.test(st)) g.italics = true; if (/text-decoration[^;]*underline/.test(st)) g.underline = true;
      out.push(...runs(c, g));
    }
    return out;
  };
  const fromHtml = (html, f) => { const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html'); return runs(d.body, f); };
  const align = el => { const a = (el.getAttribute?.('style') || '').match(/text-align:\s*(\w+)/)?.[1] || el.getAttribute?.('align'); return a === 'center' ? D.AlignmentType.CENTER : a === 'right' ? D.AlignmentType.RIGHT : undefined; };
  const BLOCK = /^(P|DIV|H1|H2|H3|H4|BLOCKQUOTE|UL|OL|TABLE|HR|LI|SECTION)$/;
  const hasBlocks = el => [...el.children].some(c => BLOCK.test(c.tagName));
  const para = (el, opts = {}) => new D.Paragraph({ children: runs(el, opts.fmt), alignment: opts.alignment ?? align(el), spacing: { line: opts.line ?? line, lineRule: 'auto', before: opts.before, after: opts.after }, indent: opts.indent ?? { firstLine: 720 }, keepNext: opts.keepNext, bullet: opts.bullet, numbering: opts.numbering });

  const blocks = (parent, ctx = {}) => {
    const out = []; let loose = null;
    const flush = () => { if (loose && loose.textContent.trim()) out.push(para(loose, ctx.quote ? { line: 240, indent: { left: 720 }, after: 240 } : {})); loose = null; };
    for (const c of [...parent.childNodes]) {
      if (c.nodeType === 3 || (c.nodeType === 1 && !BLOCK.test(c.tagName))) { if (c.nodeType === 3 && !c.data.trim() && !loose) continue; loose ||= parent.ownerDocument.createElement('span'); loose.append(c.cloneNode(true)); continue; }
      if (c.nodeType !== 1) continue;
      flush();
      const t = c.tagName;
      if (t === 'H1') out.push(para(c, { alignment: D.AlignmentType.CENTER, indent: {}, keepNext: true, fmt: { bold: true } }));
      else if (t === 'H2') out.push(para(c, { alignment: D.AlignmentType.CENTER, indent: {}, keepNext: true }));
      else if (t === 'H3' || t === 'H4') out.push(para(c, { indent: {}, keepNext: true, fmt: { bold: true } }));
      else if (t === 'BLOCKQUOTE') { if (hasBlocks(c)) out.push(...blocks(c, { quote: true })); else out.push(para(c, { line: 240, indent: { left: 720 }, before: 240, after: 240 })); }
      else if (t === 'UL' || t === 'OL') {
        const inst = ++listSeq, level = ctx.level || 0;
        for (const li of c.children) {
          if (li.tagName !== 'LI') continue;
          const inline = li.cloneNode(true); inline.querySelectorAll('ul,ol').forEach(x => x.remove());
          out.push(para(inline, { indent: { left: 720 * (level + 2) - 360, hanging: 360 }, ...(t === 'UL' ? { bullet: { level } } : { numbering: { reference: 'numbers', level, instance: inst } }) }));
          for (const sub of li.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') { const holder = parent.ownerDocument.createElement('div'); holder.append(sub.cloneNode(true)); out.push(...blocks(holder, { level: level + 1 })); }
        }
      }
      else if (t === 'TABLE') {
        const rows = [...c.querySelectorAll('tr')].map(tr => new D.TableRow({ children: [...tr.children].map(td => new D.TableCell({ children: [new D.Paragraph({ children: runs(td, td.tagName === 'TH' ? { bold: true } : {}), spacing: { line: 240, lineRule: 'auto' } })], margins: { top: 60, bottom: 60, left: 100, right: 100 } })) }));
        if (rows.length) out.push(new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } }), new D.Paragraph({ children: [], spacing: { line: 240 } }));
      }
      else if (t === 'HR') { if (c.classList.contains('pagebreak')) out.push(new D.Paragraph({ children: [new D.PageBreak()] })); }
      else if (hasBlocks(c)) out.push(...blocks(c, ctx));
      else if (ctx.quote) out.push(para(c, { line: 240, indent: { left: 720 }, after: 240 }));
      else out.push(para(c));
    }
    flush();
    return out;
  };

  const dom = new DOMParser().parseFromString(`<body>${doc.body || ''}</body>`, 'text/html');
  const body = blocks(dom.body);
  if (!meta.titlePage && doc.title) body.unshift(new D.Paragraph({ children: [new D.TextRun({ text: doc.title, bold: true, font: FONT, size })], alignment: D.AlignmentType.CENTER, spacing: { line, lineRule: 'auto', after: 240 } }));
  if (bib.length) {
    body.push(new D.Paragraph({ children: [new D.TextRun({ text: 'Bibliography', bold: true, font: FONT, size })], alignment: D.AlignmentType.CENTER, pageBreakBefore: true, spacing: { line, lineRule: 'auto', after: 480 } }));
    for (const b of bib) body.push(new D.Paragraph({ children: fromHtml(b), indent: { left: 720, hanging: 720 }, spacing: { line: 240, lineRule: 'auto', after: 240 } }));
  }
  const footnotes = {};
  for (const n of notes) footnotes[n.n] = { children: [new D.Paragraph({ children: [new D.TextRun({ text: ' ', font: FONT, size: 20 }), ...fromHtml(n.html, { size: 20 })], indent: { firstLine: 720 }, spacing: { line: 240, lineRule: 'auto', after: 200 } })] };

  const margin = { top: 1440, right: 1440, bottom: 1440, left: 1440 };
  const pageNo = () => new D.Paragraph({ alignment: meta.pageNum === 'top' ? D.AlignmentType.RIGHT : D.AlignmentType.CENTER, children: [new D.TextRun({ children: [D.PageNumber.CURRENT], font: FONT, size: 24 })] });
  const sections = [];
  if (meta.titlePage) {
    const c = (text, opts = {}) => new D.Paragraph({ alignment: D.AlignmentType.CENTER, spacing: { line: 480, lineRule: 'auto', before: opts.before }, children: [new D.TextRun({ text, font: FONT, size: 24, bold: opts.bold })] });
    sections.push({ properties: { page: { margin, size: { width: 12240, height: 15840 } } }, children: [c(doc.title || 'Untitled', { bold: true, before: 3400 }), ...(meta.subtitle ? [c(meta.subtitle)] : []), ...[meta.author, meta.course, meta.professor, meta.date].filter(Boolean).map((t, i) => c(t, i === 0 ? { before: 3200 } : {}))] });
  }
  sections.push({
    properties: { page: { margin, size: { width: 12240, height: 15840 }, pageNumbers: { start: 1, formatType: D.NumberFormat.DECIMAL } } },
    ...(meta.pageNum === 'top' ? { headers: { default: new D.Header({ children: [pageNo()] }) } } : meta.pageNum === 'none' ? {} : { footers: { default: new D.Footer({ children: [pageNo()] }) } }),
    children: body.length ? body : [new D.Paragraph({ children: [] })],
  });
  const file = new D.Document({
    creator: meta.author || 'Steward', title: doc.title || 'Document',
    styles: { default: { document: { run: { font: FONT, size }, paragraph: { spacing: { line, lineRule: 'auto' } } } } },
    numbering: { config: [{ reference: 'numbers', levels: [0, 1, 2, 3].map(level => ({ level, format: D.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: D.AlignmentType.START })) }] },
    footnotes, sections,
  });
  return D.Packer.toBlob(file);
}
