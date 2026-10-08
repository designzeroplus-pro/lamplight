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

  /* Export templates lay the note out as an old-PC object (doc.css styles
   * each by data-template):
   * - notepad: a Windows 95-style Notepad window;
   * - mail: a "new message" window — to, from, date and subject fields;
   * - receipt: dot-matrix continuous paper; items written as "품목 ··· 값"
   *   get a dotted leader; serial number and barcode come from the note id;
   * - bbs: a blue-screen PC-통신 board post;
   * - terminal: a green-phosphor CRT showing `TYPE POEM.TXT`;
   * - msgbox: a message box with an OK button;
   * - desktop: a teal desktop with one line open in a window (1080 × 1080 image).
   * The note's "# 제목 / 날짜 / ---" head is lifted into each frame's own
   * fields. `meta` is { seed, title, date }; everything from it is escaped. */
  const LEADER_RE = /^(.+?)\s*(?:·{2,}|\.{3,}|…+)\s*(.+)$/;
  const escHtml = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function hash32(seed) {
    let h = 2166136261;
    for (const ch of String(seed ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
    return h;
  }

  // A closing "— 오늘의 내가" as the last paragraph sits on the right.
  function signed(html) {
    const i = html.lastIndexOf('<p>');
    const last = html.slice(i);
    return i >= 0 && /^<p>(?:—|–|-{1,2})\s/.test(last) && !/<\/p>\s*</.test(last)
      ? `${html.slice(0, i)}<p class="sign">${last.slice(3)}` : html;
  }

  // Leading "<h1>title</h1>", the short date line under it, and the rule after.
  function splitHead(html) {
    let rest = html;
    let head = '';
    let date = '';
    let m = rest.match(/^<h1>([\s\S]*?)<\/h1>\n?/);
    if (m) { head = m[1]; rest = rest.slice(m[0].length); }
    m = head && rest.match(/^<p>([^<]{1,40})<\/p>\n?/);
    if (m && /\d/.test(m[1])) { date = m[1]; rest = rest.slice(m[0].length); }
    m = rest.match(/^<hr>\n?/);
    if (m) rest = rest.slice(m[0].length);
    return { head, date, body: rest };
  }

  const menu = (...items) => items.map(([k, key]) => `<span>${k}(<u>${key}</u>)</span>`).join('');
  const win95 = (caption, inner, { bar = '', status = '' } = {}) =>
    `<div class="w95-title"><i class="w95-ico"></i><b>${caption}</b><span class="w95-btns"><i>_</i><i>□</i><i>×</i></span></div>`
    + (bar ? `<div class="w95-menu">${bar}</div>` : '')
    + inner
    + (status ? `<div class="w95-status">${status}</div>` : '');

  function templateHtml(template, md, meta = {}) {
    const html = mdToHtml(md);
    const title = escHtml(meta.title) || '제목 없음';
    const date = escHtml(meta.date);
    const { head, date: noteDate, body } = splitHead(html);
    switch (template) {
      case 'notepad':
        return win95(`${title} - 메모장`, `<div class="w95-field np-text">${html}</div>`, {
          bar: menu(['파일', 'F'], ['편집', 'E'], ['서식', 'O'], ['보기', 'V'], ['도움말', 'H']),
          status: `<span>${date}</span><span>UTF-8</span>`,
        });
      case 'mail': {
        const field = (k, v) => `<p><span>${k}</span><b class="w95-field">${v}</b></p>`;
        const tools = ['보내기', '잘라내기', '복사', '붙여넣기', '첨부'].map((t) => `<i>${t}</i>`).join('');
        return win95(`${head || title} - 새 메시지`, `<div class="ml-tools">${tools}</div>
<div class="ml-head">${field('받는 사람:', '미래의 나')}${field('보낸 사람:', '오늘의 나')}${field('날짜:', noteDate || date)}${field('제목:', head || title)}</div>
<div class="w95-field ml-body">${signed(body)}</div>`, {
          bar: menu(['파일', 'F'], ['편집', 'E'], ['보기', 'V'], ['삽입', 'I'], ['서식', 'O'], ['도구', 'T']),
        });
      }
      case 'receipt': {
        const h = hash32(meta.seed);
        const serial = String(h % 10000).padStart(4, '0');
        let bars = '';
        for (let i = 0, x = h || 1; i < 34; i++) {
          x = (Math.imul(x, 1103515245) + 12345) >>> 0;
          bars += `<i style="width:${1 + (x >>> 16) % 3}px"></i>`;
        }
        const items = html.replace(/<li>(.*?)<\/li>/g, (all, inner) => {
          const m = inner.match(LEADER_RE);
          return m ? `<li class="item"><span>${m[1]}</span><i></i><span>${m[2]}</span></li>` : all;
        });
        return `<header class="rc-head"><b>LAMPLIGHT</b><span>오늘의 영수증</span></header>
${items}
<footer class="rc-foot"><p>오늘도 수고했어요</p><div class="rc-bars">${bars}</div><small>No. ${serial}</small></footer>`;
      }
      case 'bbs':
        return `<div class="bb-bar"><span>LAMPTEL</span><span>[일기장] 나의 하루</span><span>${noteDate || date}</span></div>
<div class="bb-head"><p><em>제  목</em> : ${head || title}</p><p><em>올린이</em> : 나 (lamp)</p><p><em>날  짜</em> : ${noteDate || date}</p></div>
<div class="bb-body">${body}</div>
<div class="bb-bar"><span>다음(N) 이전(P) 답장(RE) 목록(L)</span><span>선택 &gt;</span></div>`;
      case 'terminal':
        return `<div class="tm-screen"><p class="tm-cmd">C:\\LAMP&gt; TYPE POEM.TXT</p>
${head ? `<h1>${head}</h1>` : ''}${noteDate ? `<p class="tm-date">${noteDate}</p>` : ''}
${body}
<p class="tm-cmd">C:\\LAMP&gt; <i class="tm-cursor"></i></p></div>
<div class="tm-bezel"><b>LAMPLIGHT</b><i class="tm-led"></i></div>`;
      case 'msgbox':
        return win95(head || title, `<div class="mb-main"><i class="mb-icon">i</i><div class="mb-text">${signed(body)}</div></div>
<p class="mb-check"><i></i>내일도 이 창 띄우기</p>
<div class="mb-btns"><i class="w95-btn mb-ok">확인</i></div>`);
      case 'desktop': {
        // One line — the first quote, else the first paragraph — sized to fit.
        const line = (body.match(/<blockquote>([\s\S]*?)<\/blockquote>/) || body.match(/<p>([\s\S]*?)<\/p>/) || [])[1] || '';
        const len = line.replace(/<[^>]*>/g, '').length;
        const name = head || title;
        return `<ul class="dt-icons"><li><i class="dt-pc"></i>내 컴퓨터</li><li><i class="dt-doc"></i>일기장.txt</li><li><i class="dt-bin"></i>휴지통</li></ul>
<div class="dt-win">${win95(`${name} - 메모장`, `<div class="w95-field dt-line ${len <= 40 ? 'len-l' : len <= 90 ? 'len-m' : 'len-s'}"><p>${line}</p></div>`)}</div>
<div class="dt-bar"><i class="w95-btn dt-start"><i></i>시작</i><i class="dt-task">${name}</i><span class="dt-clock">${date}</span></div>`;
      }
      default:
        return html;
    }
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

  return { MARKS_RE, previewOf, sortNotes, mdToHtml, templateHtml, ITEM_RE, renumberList, isNewer };
});
