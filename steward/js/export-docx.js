// Builds a real Word (.docx) file from a document: title page, body, true Word footnotes, page numbers, bibliography.
const load = () => window.docx ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('vendor/docx/docx.js', document.baseURI).href; s.onload = res; s.onerror = () => rej(new Error('offline')); document.head.append(s); });
const FONT = 'Times New Roman';

export async function toDocx(doc, { meta, notes, bib }) {
  await load();
  const D = window.docx;
  // BJU manual: set line spacing to an exact number of points (24 for the body, 12 for single-spaced parts), not Word's "double".
  const size = Math.round(meta.fontSize * 2), line = Math.round(meta.fontSize * meta.spacing * 20), one = Math.round(meta.fontSize * 20), EX = 'exact';
  const numOf = new Map(notes.map(n => [n.id, n.n]));
  let listSeq = 0;

  // inline content -> runs
  const runs = (node, f = {}) => {
    const out = [];
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { if (c.data) out.push(new D.TextRun({ text: c.data.replace(/\s+/g, ' '), font: f.font || FONT, size: f.size || size, bold: f.bold, italics: f.italics, underline: f.underline ? {} : undefined, superScript: f.sup, subScript: f.sub, strike: f.strike, smallCaps: f.caps, color: f.color, shading: f.fill ? { type: 'clear', color: 'auto', fill: f.fill } : undefined })); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (t === 'SUP' && c.classList.contains('fn')) { const n = numOf.get(c.dataset.fn); if (n) out.push(new D.FootnoteReferenceRun(n)); continue; }
      if (t === 'BR') { if (c.nextSibling) out.push(new D.TextRun({ break: 1 })); continue; }
      const g = { ...f };
      if (t === 'B' || t === 'STRONG') g.bold = true; else if (t === 'I' || t === 'EM') g.italics = true; else if (t === 'U') g.underline = true;
      else if (t === 'SUP') g.sup = true; else if (t === 'SUB') g.sub = true; else if (t === 'S' || t === 'STRIKE') g.strike = true;
      const st = c.getAttribute('style') || '';
      if (/font-weight:\s*(bold|[6-9]00)/.test(st)) g.bold = true; if (/font-style:\s*italic/.test(st)) g.italics = true; if (/text-decoration[^;]*underline/.test(st)) g.underline = true;
      if (/text-decoration[^;]*line-through/.test(st)) g.strike = true; if (/font-variant[^;]*small-caps/.test(st)) g.caps = true;
      if (/vertical-align:\s*super/.test(st)) g.sup = true; if (/vertical-align:\s*sub/.test(st)) g.sub = true;
      const fam = st.match(/font-family:\s*([^;]+)/)?.[1] || (t === 'FONT' && c.getAttribute('face')); if (fam) g.font = fam.split(',')[0].replace(/["']/g, '').trim();
      const col = hex(st.match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1] || (t === 'FONT' && c.getAttribute('color'))); if (col) g.color = col;
      const bg = hex(st.match(/background(?:-color)?:\s*([^;]+)/)?.[1]); if (bg) g.fill = bg;
      out.push(...runs(c, g));
    }
    return out;
  };
  const hex = v => { if (!v) return null; v = String(v).trim(); let m = v.match(/^#([0-9a-f]{6})$/i); if (m) return m[1].toUpperCase(); m = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i); if (m) return (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase(); m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); return m ? [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, '0')).join('').toUpperCase() : null; };
  const fromHtml = (html, f) => { const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html'); return runs(d.body, f); };
  const align = el => { const a = (el.getAttribute?.('style') || '').match(/text-align:\s*(\w+)/)?.[1] || el.getAttribute?.('align'); return a === 'center' ? D.AlignmentType.CENTER : a === 'right' ? D.AlignmentType.RIGHT : undefined; };
  const BLOCK = /^(P|DIV|H1|H2|H3|H4|BLOCKQUOTE|UL|OL|TABLE|HR|LI|SECTION)$/;
  const hasBlocks = el => [...el.children].some(c => BLOCK.test(c.tagName));
  const para = (el, opts = {}) => new D.Paragraph({ children: runs(el, opts.fmt), alignment: opts.alignment ?? align(el), spacing: { line: opts.line ?? line, lineRule: EX, before: opts.before, after: opts.after }, indent: opts.indent ?? { firstLine: 720 }, keepNext: opts.keepNext, bullet: opts.bullet, numbering: opts.numbering });

  const blocks = (parent, ctx = {}) => {
    const out = []; let loose = null;
    const flush = () => { if (loose && loose.textContent.trim()) out.push(para(loose, ctx.quote ? { line: one, indent: { left: 720 }, after: one } : {})); loose = null; };
    for (const c of [...parent.childNodes]) {
      if (c.nodeType === 3 || (c.nodeType === 1 && !BLOCK.test(c.tagName))) { if (c.nodeType === 3 && !c.data.trim() && !loose) continue; loose ||= parent.ownerDocument.createElement('span'); loose.append(c.cloneNode(true)); continue; }
      if (c.nodeType !== 1) continue;
      flush();
      const t = c.tagName;
      if (t === 'H1') out.push(para(c, { alignment: D.AlignmentType.CENTER, indent: {}, keepNext: true, before: one, fmt: { italics: true } }));
      else if (t === 'H2') out.push(para(c, { alignment: D.AlignmentType.CENTER, indent: {}, keepNext: true, before: one }));
      else if (t === 'H3' || t === 'H4') out.push(para(c, { indent: {}, keepNext: true, before: one, fmt: { italics: true } }));
      else if (t === 'BLOCKQUOTE') { if (hasBlocks(c)) out.push(...blocks(c, { quote: true })); else out.push(para(c, { line: one, indent: { left: 720 }, before: one, after: one })); }
      else if (t === 'UL' || t === 'OL') {
        const inst = ctx.inst || ++listSeq, level = ctx.level || 0, outline = ctx.outline || c.classList.contains('outline');
        for (const li of c.children) {
          if (li.tagName === 'UL' || li.tagName === 'OL') { const holder = parent.ownerDocument.createElement('div'); holder.append(li.cloneNode(true)); out.push(...blocks(holder, { level: level + 1, outline, inst: outline ? inst : undefined })); continue; } // browsers nest lists beside, not inside, the item
          if (li.tagName !== 'LI') continue;
          const inline = li.cloneNode(true); inline.querySelectorAll('ul,ol').forEach(x => x.remove());
          out.push(para(inline, { indent: { left: 720 * (level + 2) - 360, hanging: 360 }, ...(t === 'UL' ? { bullet: { level } } : { numbering: { reference: outline ? 'outline' : 'numbers', level, instance: inst } }) }));
          for (const sub of li.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') { const holder = parent.ownerDocument.createElement('div'); holder.append(sub.cloneNode(true)); out.push(...blocks(holder, { level: level + 1, outline, inst: outline ? inst : undefined })); }
        }
      }
      else if (t === 'TABLE') {
        const rows = [...c.querySelectorAll('tr')].map(tr => new D.TableRow({ children: [...tr.children].map(td => new D.TableCell({ children: [new D.Paragraph({ children: runs(td, td.tagName === 'TH' ? { bold: true } : {}), spacing: { line: one, lineRule: EX } })], margins: { top: 60, bottom: 60, left: 100, right: 100 } })) }));
        if (rows.length) out.push(new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } }), new D.Paragraph({ children: [], spacing: { line: one, lineRule: EX } }));
      }
      else if (t === 'HR') { if (c.classList.contains('pagebreak')) out.push(new D.Paragraph({ children: [new D.PageBreak()] })); }
      else if (hasBlocks(c)) out.push(...blocks(c, ctx));
      else if (ctx.quote) out.push(para(c, { line: one, indent: { left: 720 }, after: one }));
      else out.push(para(c));
    }
    flush();
    return out;
  };

  const dom = new DOMParser().parseFromString(`<body>${doc.body || ''}</body>`, 'text/html');
  const body = blocks(dom.body);
  const heading = (text, extra = {}) => new D.Paragraph({ children: [new D.TextRun({ text, bold: true, font: FONT, size })], alignment: D.AlignmentType.CENTER, spacing: { line: one, lineRule: EX, after: one * 2 }, ...extra });
  if (doc.title) body.unshift(heading(doc.title)); // paper title in bold at the top of page 1, followed by a triple space
  if (bib.length) {
    body.push(heading('Bibliography', { pageBreakBefore: true }));
    for (const b of bib) body.push(new D.Paragraph({ children: fromHtml(b), indent: { left: 720, hanging: 720 }, spacing: { line: one, lineRule: EX, after: one } }));
  }
  const footnotes = {};
  for (const n of notes) footnotes[n.n] = { children: [new D.Paragraph({ children: [new D.TextRun({ text: ' ', font: FONT, size: 20 }), ...fromHtml(n.html, { size: 20 })], indent: { firstLine: 720 }, spacing: { line: 240, lineRule: EX, after: 240 } })] };

  const margin = { top: 1440, right: 1440, bottom: 1440, left: 1440 };
  const pageNo = () => new D.Paragraph({ alignment: meta.pageNum === 'top' ? D.AlignmentType.RIGHT : D.AlignmentType.CENTER, children: [new D.TextRun({ children: [D.PageNumber.CURRENT], font: FONT, size: 24 })] });
  const sections = [];
  if (meta.titlePage) { // BJU title page: 2-inch top margin; title, byline, affiliation and place/date spread down the page
    const c = (text, o = {}) => new D.Paragraph({ alignment: D.AlignmentType.CENTER, spacing: { line: o.line || 480, lineRule: EX, before: o.before }, children: [new D.TextRun({ text, font: FONT, size: 24, bold: o.bold })] });
    const titleLines = Math.max(1, Math.ceil((doc.title || 'Untitled').length / 62));
    const gap = Math.max(900, Math.round((11520 - 240 - titleLines * 240 - 8 * 480) / 3)); // space left on the page, shared between the three gaps
    sections.push({ properties: { page: { margin: { ...margin, top: 2880 }, size: { width: 12240, height: 15840 } } }, children: [
      c(doc.title || 'Untitled', { bold: true, line: 240 }),
      c('by', { before: gap }), c(meta.author || '', { bold: true }),
      c('A Paper Submitted to', { before: gap }), c('the Faculty of BJU Seminary'), c('in Fulfillment of the Requirements for the Degree of'), c(meta.degree || ''),
      c(meta.place || 'Greenville, South Carolina', { before: gap }), c(meta.monthYear || '')] });
  }
  sections.push({
    properties: { page: { margin, size: { width: 12240, height: 15840 }, pageNumbers: { start: 1, formatType: D.NumberFormat.DECIMAL } } },
    ...(meta.pageNum === 'top' ? { headers: { default: new D.Header({ children: [pageNo()] }) } } : meta.pageNum === 'none' ? {} : { footers: { default: new D.Footer({ children: [pageNo()] }) } }),
    children: body.length ? body : [new D.Paragraph({ children: [] })],
  });
  const file = new D.Document({
    creator: meta.author || 'Steward', title: doc.title || 'Document',
    styles: { default: { document: { run: { font: FONT, size }, paragraph: { spacing: { line, lineRule: EX } } } } },
    numbering: { config: [{ reference: 'numbers', levels: [0, 1, 2, 3].map(level => ({ level, format: D.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: D.AlignmentType.START })) },
      { reference: 'outline', levels: [D.LevelFormat.UPPER_ROMAN, D.LevelFormat.UPPER_LETTER, D.LevelFormat.DECIMAL, D.LevelFormat.LOWER_LETTER].map((format, level) => ({ level, format, text: `%${level + 1}.`, alignment: D.AlignmentType.START })) }] },
    footnotes, sections,
  });
  const blob = await D.Packer.toBlob(file);
  // BJU manual: footnotes sit "below text", not at the bottom of the page. Word stores that in settings.xml, which the builder cannot set, so patch the file.
  try {
    if (!window.fflate) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('vendor/fflate/fflate.js', document.baseURI).href; s.onload = res; s.onerror = rej; document.head.append(s); });
    const F = window.fflate, files = F.unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const key = 'word/settings.xml';
    if (files[key]) {
      let xml = F.strFromU8(files[key]);
      if (!xml.includes('<w:footnotePr>')) xml = xml.includes('<w:compat>') ? xml.replace('<w:compat>', '<w:footnotePr><w:pos w:val="beneathText"/></w:footnotePr><w:compat>') : xml.replace('</w:settings>', '<w:footnotePr><w:pos w:val="beneathText"/></w:footnotePr></w:settings>');
      files[key] = F.strToU8(xml);
      return new Blob([F.zipSync(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }
  } catch (e) { console.warn('footnote position not set', e); }
  return blob;
}
