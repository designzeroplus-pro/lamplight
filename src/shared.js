/* Pure helpers shared by the main process (require), the renderer
 * (window.LampShared) and the tests: note previews, sorting, the small
 * Markdown renderer, ordered-list renumbering and version comparison. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LampShared = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const MARKS_RE = /[⁣⁤]/g;

  // Sidebar preview: plain words, without ink markers or markdown punctuation.
  const previewOf = (text) => String(text || '')
    .replace(MARKS_RE, '')
    .replace(/^#{1,3} |^> /gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  /* Pinned notes first, then by the chosen order. */
  const SORTS = {
    updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    title: (a, b) => (a.title || '￿').localeCompare(b.title || '￿', 'ko') || SORTS.updated(a, b),
  };
  function sortNotes(list, by = 'updated') {
    const cmp = SORTS[by] || SORTS.updated;
    return [...list].sort((a, b) => (!!b.pinned - !!a.pinned) || cmp(a, b));
  }

  /* A small Markdown renderer for the preview and the PDF: headings, lists
   * (nested by indent), checkboxes, quotes, rules, bold/italic/code. Text is
   * escaped first, so nothing in a note or a model answer can inject HTML. */
  function mdToHtml(md) {
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (t) => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g, '<span class="stamp">[$1]</span>');
    const out = [];
    let para = [];
    const stack = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    const closeLists = (depth = -1) => { while (stack.length && stack[stack.length - 1].depth > depth) out.push(`</${stack.pop().type}>`); };
    for (const raw of String(md).replace(/\r/g, '').split('\n')) {
      const line = raw.replace(MARKS_RE, '');
      let m;
      if (!line.trim()) { flushPara(); closeLists(); continue; }
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); closeLists(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
      if (/^\s*(-{3,}|\*{3,}|─{3,}.*)\s*$/.test(line)) { flushPara(); closeLists(); out.push('<hr>'); continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeLists(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
      if ((m = line.match(/^(\s*)([-*•]|\d{1,3}[.)])\s+(.*)$/))) {
        flushPara();
        const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
        const type = /\d/.test(m[2]) ? 'ol' : 'ul';
        closeLists(depth);
        if (!stack.length || stack[stack.length - 1].depth < depth || stack[stack.length - 1].type !== type) {
          if (stack.length && stack[stack.length - 1].depth === depth) out.push(`</${stack.pop().type}>`);
          out.push(`<${type}>`);
          stack.push({ type, depth });
        }
        let text = m[3];
        let box = '';
        const c = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (c) { box = c[1] === ' ' ? '<span class="box">☐</span> ' : '<span class="box on">☑</span> '; text = c[2]; }
        out.push(`<li${c ? ' class="task"' : ''}>${box}${inline(text)}</li>`);
        continue;
      }
      closeLists();
      para.push(line);
    }
    flushPara();
    closeLists();
    return out.join('\n');
  }

  /* Ordered lists keep counting: after an item is added, removed or moved,
   * numbers in the surrounding list are rewritten. Nested levels start at 1;
   * the first top-level item keeps whatever number it has. Returns the range
   * to replace and the new caret, or null when nothing changes. */
  const ITEM_RE = /^(\s*)(?:(\d{1,3})([.)])|([-*•]))(?=\s)/;

  function renumberList(v, at, caret) {
    const lineAt = (i) => v.lastIndexOf('\n', i - 1) + 1;
    let start = lineAt(Math.min(at, v.length));
    let end = v.indexOf('\n', start);
    if (end === -1) end = v.length;
    const isItem = (a, b) => ITEM_RE.test(v.slice(a, b));
    if (!isItem(start, end)) return null;
    while (start > 0) {
      const ps = lineAt(start - 1);
      if (!isItem(ps, start - 1)) break;
      start = ps;
    }
    while (end < v.length) {
      let ne = v.indexOf('\n', end + 1);
      if (ne === -1) ne = v.length;
      if (!isItem(end + 1, ne)) break;
      end = ne;
    }
    const lines = v.slice(start, end).split('\n');
    const minIndent = Math.min(...lines.map((l) => l.match(ITEM_RE)[1].length));
    const counters = new Map();
    let changed = false;
    let caretShift = 0;
    let pos = start;
    const out = lines.map((line) => {
      const m = line.match(ITEM_RE);
      const indent = m[1].length;
      for (const k of [...counters.keys()]) if (k > indent) counters.delete(k);
      let next = line;
      if (m[2]) {
        if (!counters.has(indent)) counters.set(indent, indent > minIndent ? 1 : Number(m[2]));
        const want = String(counters.get(indent));
        counters.set(indent, Number(want) + 1);
        if (want !== m[2]) {
          next = m[1] + want + line.slice(m[1].length + m[2].length);
          if (pos + m[1].length < caret) caretShift += want.length - m[2].length;
          changed = true;
        }
      } else {
        counters.delete(indent);
      }
      pos += line.length + 1;
      return next;
    });
    if (!changed) return null;
    return { start, end, text: out.join('\n'), caret: caret + caretShift };
  }

  function isNewer(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  }

  return { MARKS_RE, previewOf, sortNotes, mdToHtml, ITEM_RE, renumberList, isNewer };
});
