// Runs inside the page being clipped (after vendor/Readability.js). Returns what the chosen kind of clip should hold.
// Pictures are returned as web addresses; the extension fetches copies of them so the note keeps them for good.
(() => {
  const abs = u => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const meta = (...names) => {
    for (const n of names) { const m = document.querySelector(`meta[property="${n}"],meta[name="${n}"]`); if (m?.content?.trim()) return m.content.trim(); }
    return '';
  };
  const isPdf = () => document.contentType === 'application/pdf' || /\.pdf($|[?#])/i.test(location.pathname);
  const selection = () => { const s = getSelection(); return s && s.rangeCount && !s.isCollapsed && s.toString().trim() ? s : null; };

  // Sizes of the pictures as the page shows them, so icons and tracking dots can be left out.
  const shown = new Map();
  for (const im of document.images) { const k = im.currentSrc || im.src; if (k) shown.set(k, Math.max(im.naturalWidth || 0, im.width || 0)); }

  /** Make a copied piece of page safe to move: real picture addresses, full links, no scripts or page furniture. */
  function tidy(root, { dropSmall = false, keepImages = true, prepOnly = false } = {}) {
    if (!prepOnly) root.querySelectorAll('script,style,noscript,iframe,template,form,button,input,select,textarea,dialog,[hidden],[aria-hidden="true"],link,meta').forEach(x => x.remove());
    // <picture> and lazy-loaded pictures: keep one plain <img> with the best address.
    for (const p of root.querySelectorAll('picture')) {
      const img = p.querySelector('img');
      if (!img) { p.remove(); continue; }
      if (!img.getAttribute('src') || /^data:image\/(gif|svg)/.test(img.getAttribute('src'))) {
        const s = [...p.querySelectorAll('source[srcset]')].pop();
        if (s) img.setAttribute('data-best', s.getAttribute('srcset'));
      }
      p.replaceWith(img);
    }
    for (const img of [...root.querySelectorAll('img')]) {
      if (!keepImages) { img.remove(); continue; }
      const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || img.getAttribute('data-url');
      const set = img.getAttribute('data-best') || img.getAttribute('srcset') || img.getAttribute('data-srcset');
      let src = img.getAttribute('src') || '';
      if (lazy && (!src || /^data:/.test(src) || /blank|spacer|placeholder|lazy/i.test(src))) src = lazy;
      if (set) { // take the widest picture offered
        const best = set.split(',').map(s => s.trim().split(/\s+/)).map(([u, w]) => [u, parseFloat(w) || 1]).sort((a, b) => b[1] - a[1])[0];
        if (best?.[0] && (!src || /^data:/.test(src) || best[1] > 1)) src = best[0];
      }
      src = /^data:/.test(src) ? src : abs(src);
      ['srcset', 'data-srcset', 'data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-best', 'loading', 'sizes', 'width', 'height', 'style'].forEach(a => img.removeAttribute(a));
      const w = shown.get(src);
      if (!src || (dropSmall && w !== undefined && w > 0 && w < 40)) { img.remove(); continue; }
      img.setAttribute('src', src);
    }
    for (const a of root.querySelectorAll('a[href]')) { const h = a.getAttribute('href'); if (!h.startsWith('#')) a.setAttribute('href', abs(h)); }
    if (!prepOnly) for (const el of root.querySelectorAll('[class],[id]')) { el.removeAttribute('class'); el.removeAttribute('id'); }
    return root;
  }
  const imagesIn = root => [...new Set([...root.querySelectorAll('img[src]')].map(i => i.getAttribute('src')).filter(u => /^(https?:|data:image\/)/.test(u)))].slice(0, 80);
  const words = t => (t.match(/\S+/g) || []).length;

  /** Copy the page with hidden parts left out (they are only knowable on the live page). */
  function visibleClone(node) {
    const mark = [];
    const all = node.querySelectorAll('*');
    if (all.length < 30000) for (const el of all) {
      if (el.closest('svg')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') { el.setAttribute('data-steward-hide', ''); mark.push(el); }
    }
    const c = node.cloneNode(true);
    mark.forEach(el => el.removeAttribute('data-steward-hide'));
    c.querySelectorAll('[data-steward-hide]').forEach(x => x.remove());
    return c;
  }

  function article(keepImages) {
    let r = null;
    try {
      const doc = document.cloneNode(true);
      // Readability can't see lazy pictures; give them their real addresses first.
      tidy(doc.body || doc.documentElement, { prepOnly: true });
      r = new Readability(doc, { keepClasses: false, charThreshold: 300 }).parse();
    } catch (e) { console.warn('Steward Clipper', e); }
    let root;
    if (r?.content) { root = document.createElement('div'); root.innerHTML = r.content; }
    else root = visibleClone(document.querySelector('article,main,[role=main]') || document.body);
    tidy(root, { dropSmall: true, keepImages });
    if (!keepImages) for (const el of root.querySelectorAll('figure')) if (!el.textContent.trim()) el.remove();
    return { title: r?.title || '', byline: r?.byline || '', html: root.innerHTML, text: root.textContent, images: imagesIn(root) };
  }

  function selected() {
    const s = selection(); if (!s) return null;
    const root = document.createElement('div');
    for (let i = 0; i < s.rangeCount; i++) {
      const r = s.getRangeAt(i), frag = r.cloneContents();
      // A selection inside one list item, table cell etc. keeps its surroundings so it still reads right.
      const anc = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
      if (anc && /^(UL|OL|TABLE|TBODY|TR|THEAD)$/.test(anc.tagName)) { const w = anc.closest('ul,ol,table').cloneNode(false); w.append(frag); root.append(w); }
      else if (anc && /^(PRE|CODE|BLOCKQUOTE|H[1-6])$/.test(anc.tagName)) { const w = anc.cloneNode(false); w.append(frag); root.append(w); }
      else { const d = document.createElement('div'); d.append(frag); root.append(d); }
    }
    tidy(root, { keepImages: true });
    return { html: root.innerHTML, text: root.textContent, images: imagesIn(root) };
  }

  function info() {
    const ogImage = meta('og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
    const icon = document.querySelector('link[rel~="apple-touch-icon"],link[rel~="icon"],link[rel="shortcut icon"]');
    const s = selection();
    return {
      url: location.href, title: meta('og:title') || document.title || location.hostname,
      description: meta('og:description', 'description', 'twitter:description'),
      siteName: meta('og:site_name', 'application-name') || location.hostname.replace(/^www\./, ''),
      image: ogImage ? abs(ogImage) : '', icon: icon ? abs(icon.getAttribute('href')) : abs('/favicon.ico'),
      hasSelection: !!s, selectionWords: s ? words(s.toString()) : 0, isPdf: isPdf(),
    };
  }

  globalThis.__stewardExtract = mode => {
    const base = info();
    if (mode === 'info') return base;
    if (mode === 'article' || mode === 'text') {
      const a = article(mode === 'article');
      return { ...base, title: a.title || base.title, byline: a.byline, html: a.html, images: a.images, words: words(a.text), snippet: a.text.replace(/\s+/g, ' ').trim().slice(0, 280) };
    }
    if (mode === 'selection') {
      const s = selected(); if (!s) return { ...base, error: 'Nothing is selected on the page.' };
      return { ...base, html: s.html, images: s.images, words: words(s.text), snippet: s.text.replace(/\s+/g, ' ').trim().slice(0, 280) };
    }
    if (mode === 'page') {
      const root = tidy(visibleClone(document.body), { keepImages: true });
      root.querySelectorAll('svg').forEach(x => x.remove());
      return { ...base, html: root.innerHTML, images: imagesIn(root), words: words(root.textContent), snippet: root.textContent.replace(/\s+/g, ' ').trim().slice(0, 280) };
    }
    return base;
  };
})();
