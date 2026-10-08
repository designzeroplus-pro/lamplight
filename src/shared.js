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

  /* Paper templates (keys start with "lt-"): the note on stationery — its
   * title above, the body, the date below — with the paper's own decorations
   * drawn as inline SVG. The note's "# 제목 / 날짜 / ---" head becomes the
   * heading and the date line. */
  const leaf = (fill, vein) => `<path d="M0-30C14-22 18-6 0 30C-18-6-14-22 0-30Z" fill="${fill}"/><path d="M0-26V28" stroke="${vein}" stroke-width="1.2" fill="none"/>`;
  const blossom = (r = 9) => {
    let p = '';
    for (let i = 0; i < 5; i++) p += `<ellipse cx="0" cy="${-r}" rx="${r * 0.62}" ry="${r}" transform="rotate(${i * 72})" fill="#f7c6d0" stroke="#eba3b4" stroke-width=".8"/>`;
    return `${p}<circle r="${r * 0.32}" fill="#e88aa2"/>`;
  };
  const petal = (x, y, a, s = 1) => `<ellipse cx="${x}" cy="${y}" rx="${5 * s}" ry="${8 * s}" transform="rotate(${a} ${x} ${y})" fill="#f6bfcb" opacity=".85"/>`;
  const star = (fill) => `<path d="M0-14L4-4.5 14.5-4.5 6 2 9.5 12.5 0 6 -9.5 12.5 -6 2 -14.5-4.5 -4-4.5Z" fill="${fill}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" paint-order="stroke"/>`;
  const heart = (fill) => `<path d="M0 12C-14 2-16-8-9-12-4-14 0-10 0-6 0-10 4-14 9-12 16-8 14 2 0 12Z" fill="${fill}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" paint-order="stroke"/>`;
  const svg = (cls, w, h, body) => `<svg class="${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${body}</svg>`;

  const PAPER_DECOR = {
    'lt-lined': () => '<i class="lt-holes"></i>',
    'lt-kraft': (m) => svg('lt-stamp', 120, 120, `<g fill="none" stroke="currentColor"><circle cx="60" cy="60" r="54" stroke-width="3"/><circle cx="60" cy="60" r="44" stroke-width="1.5"/></g>
<text x="60" y="56" text-anchor="middle" font-family="Courier Prime, monospace" font-weight="700" font-size="15" letter-spacing="2" fill="currentColor">LAMPLIGHT</text>
<text x="60" y="76" text-anchor="middle" font-family="Courier Prime, monospace" font-size="11" letter-spacing="1" fill="currentColor">${m.date || 'POST'}</text>`),
    'lt-airmail': () => `<div class="lt-avion"><b>PAR AVION</b><span>항공우편 · BY AIR MAIL</span></div>`
      + svg('lt-postage', 76, 92, `<rect x="3" y="3" width="70" height="86" fill="#fff" stroke="#d8d2c6" stroke-width="2" stroke-dasharray="3 3"/><rect x="10" y="10" width="56" height="58" fill="#24324f"/>
<circle cx="38" cy="36" r="16" fill="#ffd98a" opacity=".35"/><circle cx="38" cy="36" r="6" fill="#fff3cf"/><text x="38" y="81" text-anchor="middle" font-family="Courier Prime, monospace" font-size="8" font-weight="700" fill="#24324f">LAMPLIGHT</text>`),
    'lt-birthday': () => {
      let flags = '';
      const colors = ['#f6a5b5', '#ffd27a', '#9fd8c8', '#b8b2f0', '#f6a5b5', '#ffd27a', '#9fd8c8', '#b8b2f0', '#f6a5b5'];
      colors.forEach((c, i) => {
        const x = 18 + i * 60;
        const y = 14 + Math.sin((i / 8) * Math.PI) * 22;
        flags += `<path d="M${x} ${y}L${x + 40} ${y + 2}L${x + 19} ${y + 40}Z" fill="${c}"/>`;
      });
      return svg('lt-bunting', 560, 80, `<path d="M0 10Q280 70 560 10" stroke="#c9a77d" stroke-width="1.5" fill="none"/>${flags}`) + '<p class="lt-title">Happy Birthday</p>';
    },
    'lt-xmas': () => {
      const holly = `<g transform="rotate(-50) translate(0 -22)">${leaf('#2f6b45', '#1d4a2e')}</g><g transform="rotate(40) translate(0 -22)">${leaf('#3a7d52', '#1d4a2e')}</g>
<circle cx="-4" cy="4" r="6" fill="#c0392b"/><circle cx="7" cy="7" r="5.5" fill="#d64a3a"/><circle cx="2" cy="-5" r="5" fill="#b83226"/>`;
      return svg('lt-holly lt-holly-l', 90, 90, `<g transform="translate(46 46)">${holly}</g>`)
        + svg('lt-holly lt-holly-r', 90, 90, `<g transform="translate(44 46) scale(-1 1)">${holly}</g>`)
        + '<p class="lt-title">Merry Christmas</p>';
    },
    'lt-spring': () => svg('lt-branch', 260, 200, `<path d="M258 6C210 20 170 30 120 62 90 82 60 92 22 96" stroke="#7b5a4a" stroke-width="4" fill="none" stroke-linecap="round"/>
<path d="M170 34C176 52 172 66 160 80M112 66C104 80 104 96 112 110" stroke="#7b5a4a" stroke-width="2.5" fill="none" stroke-linecap="round"/>
<g transform="translate(205 26)">${blossom(11)}</g><g transform="translate(150 50) rotate(20)">${blossom(9)}</g><g transform="translate(160 84)">${blossom(8)}</g>
<g transform="translate(96 76) rotate(-15)">${blossom(10)}</g><g transform="translate(112 114)">${blossom(7)}</g><g transform="translate(40 92) rotate(30)">${blossom(8)}</g>`)
      + svg('lt-petals', 560, 760, [petal(80, 300, 30), petal(500, 380, -20, 0.8), petal(60, 560, 60, 0.9), petal(520, 640, 10), petal(300, 720, -40, 0.7), petal(450, 250, 80, 0.7)].join('')),
    'lt-autumn': () => {
      const ginkgo = (c) => `<path d="M0 0L-26-30C-14-40 14-40 26-30Z" fill="${c}"/><path d="M0-36L0 0 2 22" stroke="#9b7a2a" stroke-width="1.6" fill="none"/>`;
      return svg('lt-leaves lt-leaves-t', 200, 150, `<g transform="translate(150 60) rotate(-25)">${leaf('#d9822b', '#9c4f12')}</g><g transform="translate(110 40) rotate(30)">${ginkgo('#f2c14e')}</g><g transform="translate(180 120) rotate(70)">${leaf('#c4542d', '#862f14')}</g>`)
        + svg('lt-leaves lt-leaves-b', 200, 150, `<g transform="translate(40 90) rotate(140)">${leaf('#e0a43a', '#9c6512')}</g><g transform="translate(90 120) rotate(-20)">${ginkgo('#f0b93a')}</g><g transform="translate(28 30) rotate(200)">${leaf('#cf6a2e', '#8a3a12')}</g>`);
    },
    'lt-thanks': () => {
      let ruffle = '';
      for (let i = 0; i < 9; i++) ruffle += `<circle cx="${Math.cos(i * 0.7) * 10}" cy="${-6 + Math.sin(i * 0.7) * 7}" r="9" fill="${i % 2 ? '#e2475a' : '#cf3349'}"/>`;
      return svg('lt-carnation', 140, 210, `<path d="M70 60C72 110 66 150 74 206" stroke="#4f7d43" stroke-width="3.5" fill="none" stroke-linecap="round"/>
<path d="M72 130C50 120 36 104 34 88 52 92 66 108 72 128ZM72 158C92 148 108 136 112 120 94 122 78 138 72 156Z" fill="#5f9150"/>
<path d="M58 66L82 66 78 80 62 80Z" fill="#5f9150"/><g transform="translate(70 46)">${ruffle}<circle cy="-14" r="8" fill="#ef6b7c"/><circle cx="-12" cy="-6" r="7" fill="#ef6b7c"/><circle cx="12" cy="-6" r="7" fill="#ef6b7c"/></g>`)
        + '<p class="lt-title">Thank you</p>';
    },
    'lt-tape': () => '<i class="lt-washi lt-washi-l"></i><i class="lt-washi lt-washi-r"></i>'
      + svg('lt-stickers lt-stickers-t', 110, 70, `<g transform="translate(30 36) rotate(-12)">${star('#ffcf4a')}</g><g transform="translate(80 30) rotate(10) scale(.8)">${heart('#ff8fa3')}</g>`)
      + svg('lt-stickers lt-stickers-b', 120, 80, `<g transform="translate(36 42) rotate(14) scale(1.1)">${heart('#ff8fa3')}</g><g transform="translate(88 34) scale(.75)">${star('#8fd3c7')}</g><g transform="translate(70 66) scale(.55) rotate(20)">${star('#ffcf4a')}</g>`),
    'lt-crayon': () => svg('lt-doodle lt-doodle-sun', 130, 130, `<defs><filter id="crayon" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3"/></filter></defs>
<g filter="url(#crayon)" stroke-linecap="round" fill="none"><circle cx="65" cy="65" r="24" stroke="#f5b82e" stroke-width="7"/><circle cx="65" cy="65" r="12" fill="#ffd45c" stroke="none"/>
${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<path d="M65 28V12" stroke="#f5a623" stroke-width="5" transform="rotate(${a} 65 65)"/>`).join('')}</g>`)
      + svg('lt-doodle lt-doodle-cloud', 150, 80, `<g filter="url(#crayon)" fill="none" stroke="#8cc4e8" stroke-width="5" stroke-linecap="round"><path d="M30 62C10 62 10 38 30 38 30 18 60 14 70 30 80 14 112 18 112 40 134 40 134 62 112 62Z"/></g>`)
      + svg('lt-doodle lt-doodle-hearts', 140, 70, `<g filter="url(#crayon)" fill="none" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M30 56C10 40 8 24 20 18 28 14 30 22 30 26 30 22 34 14 42 18 54 24 50 40 30 56Z" stroke="#f27a8a"/><path d="M96 50C82 38 80 26 89 22 95 19 96 25 96 28 96 25 99 19 105 22 114 26 111 38 96 50Z" stroke="#b892e6"/></g>`),
    'lt-wax': (m) => svg('lt-seal', 96, 96, `<defs><radialGradient id="wax" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#d4473f"/><stop offset=".6" stop-color="#a5221d"/><stop offset="1" stop-color="#7a1512"/></radialGradient></defs>
<path d="M48 4C60 2 66 10 76 12 88 16 90 30 92 40 96 54 90 64 86 74 80 86 66 90 54 92 40 94 28 90 18 82 8 74 4 60 4 48 4 34 10 22 20 14 28 8 38 6 48 4Z" fill="url(#wax)"/>
<circle cx="48" cy="48" r="28" fill="none" stroke="#7a1512" stroke-width="2.5" opacity=".7"/><circle cx="48" cy="48" r="28" fill="none" stroke="#e86a5f" stroke-width="1" opacity=".45" transform="translate(-1 -1)"/>
<text x="48" y="60" text-anchor="middle" font-family="Cormorant Garamond, Gowun Batang, serif" font-style="italic" font-weight="700" font-size="34" fill="#7a1512">${m.initial}</text>
<text x="47" y="59" text-anchor="middle" font-family="Cormorant Garamond, Gowun Batang, serif" font-style="italic" font-weight="700" font-size="34" fill="#e2675c" opacity=".5">${m.initial}</text>`),
    'lt-gold': (m) => {
      const corner = '<path d="M2 40V2H40M8 30C8 16 16 8 30 8M14 22C18 18 20 16 24 14" fill="none" stroke="url(#gold)" stroke-width="1.6"/><circle cx="8" cy="8" r="2.5" fill="url(#gold)"/>';
      const defs = '<defs><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b8892f"/><stop offset=".5" stop-color="#ecd28a"/><stop offset="1" stop-color="#a77a26"/></linearGradient></defs>';
      return ['tl', 'tr', 'bl', 'br'].map((c) => svg(`lt-corner lt-corner-${c}`, 44, 44, defs + corner)).join('')
        + `<div class="lt-monogram"><span>${m.initial}</span></div>`;
    },
  };

  // 원고지: every character in its own square; paragraphs open with an empty square.
  function genko(html) {
    return html.replace(/(<[^>]+>)|([^<]+)/g, (all, tag, text) => {
      if (tag) return tag === '<p>' ? '<p><i></i>' : tag;
      return text.replace(/\n/g, '').match(/&[#a-z0-9]+;|[\s\S]/giu)?.map((c) => `<i>${c === ' ' ? '' : c}</i>`).join('') || '';
    });
  }

  function paperHtml(template, html, meta) {
    const { head, date: noteDate, body } = splitHead(html);
    const heading = head || escHtml(meta.title);
    const when = noteDate || escHtml(meta.date);
    const initial = (heading.replace(/<[^>]*>|&[#a-z0-9]+;/gi, '').trim()[0] || 'L').toUpperCase();
    const decor = (PAPER_DECOR[template] || (() => ''))({ ...meta, date: escHtml(meta.date), initial: escHtml(initial) });
    const line = (cls, text) => (template === 'lt-genko' ? `<p class="${cls}">${genko(text)}</p>` : `<p class="${cls}">${text}</p>`);
    return `${decor}<div class="lt-sheet">${heading ? line('lt-heading', heading) : ''}
<div class="lt-body">${template === 'lt-genko' ? genko(body) : signed(body)}</div>
${when ? line('lt-date', when) : ''}</div>`;
  }

  /* Typographic templates (keys start with "tp-"): posters and slides built
   * from the note's title, date and lines. Text sizes step down with length
   * (sz-1 … sz-4) so a short line fills the page and a long one still fits. */
  const plainLines = (html) => html
    .replace(/<br>/g, '\n')
    .split(/<\/(?:p|li|h[1-3]|blockquote)>/)
    .flatMap((s) => s.replace(/<[^>]*>/g, '').split('\n'))
    .map((s) => s.trim())
    .filter(Boolean);
  const visibleLength = (t) => t.replace(/&[#a-z0-9]+;/gi, '_').length;
  const sizeClass = (t, steps) => {
    const n = visibleLength(t);
    const i = steps.findIndex((max) => n <= max);
    return `sz-${i === -1 ? steps.length + 1 : i + 1}`;
  };
  const lampBadge = svg('tp-badge', 92, 104, `<defs><linearGradient id="badge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5fe3ee"/><stop offset="1" stop-color="#159fb4"/></linearGradient></defs>
<path d="M46 3L88 27V77L46 101L4 77V27Z" fill="url(#badge)" stroke="#0e7f91" stroke-width="2"/><path d="M46 12L80 32V72L46 92L12 72V32Z" fill="none" stroke="#a9f4fa" stroke-width="1.5" opacity=".6"/>
<path d="M30 46H62L58 38H34Z" fill="#0d6f80"/><path d="M46 46V66M38 70H54" stroke="#0d6f80" stroke-width="4" stroke-linecap="round"/><circle cx="46" cy="52" r="4" fill="#fff6cf"/>`);

  function typoHtml(template, html, meta) {
    const { head, date: noteDate, body } = splitHead(html);
    const title = head || escHtml(meta.title) || '제목 없음';
    const when = noteDate || escHtml(meta.date);
    const lines = plainLines(body);
    const first = lines[0] || title;
    const rest = lines.slice(1);
    const day = (String(meta.date || '').match(/(\d{1,2})$/) || [])[1] || '01';
    switch (template) {
      case 'tp-slide':
        return `<header class="tp-bar"><span>LAMPLIGHT</span><span>${when}</span></header>
<p class="tp-num">01</p>
<h2 class="tp-big ${sizeClass(title, [16, 30, 60])}">${title}</h2>
<footer class="tp-bar"><span>${escHtml(meta.date)}</span><span>lamplight</span></footer>`;
      case 'tp-orange': {
        const stack = (lines.length ? lines.slice(0, 3) : [title]).map((l, i) => `<li${i ? ' class="dim"' : ''}>${l}</li>`).join('');
        return `<p class="tp-num">01</p><ul class="tp-stack ${sizeClass(lines.slice(0, 3).join(''), [24, 60])}">${stack}</ul>
<h2 class="tp-big ${sizeClass(title, [10, 24, 50])}">${title}</h2>
<footer class="tp-foot"><span>LAMPLIGHT</span><span class="tp-pill">${when}</span><span>${day}</span></footer>`;
      }
      case 'tp-specimen':
        return `<p class="tp-big ${sizeClass(first, [14, 32, 64, 120])}">${first}</p>
<div class="tp-spec"><p>${title} · ${when}</p><p>가나다라마바사아자차카타파하</p><p>ABCDEFGHIJKLMNOPQRSTUVWXYZ</p><p>abcdefghijklmnopqrstuvwxyz</p><p>1234567890(.,?!”)</p></div>`;
      case 'tp-bold':
        return `<h2 class="tp-big ${sizeClass(title, [8, 16, 32, 60])}">${title}</h2>${lampBadge}<p class="tp-date">${when}</p>`;
      case 'tp-manifesto':
        return `<header class="tp-corners"><span>LAMPLIGHT<br>메모</span><span>${title}</span><span>WRITTEN<br>${when}</span></header>
<p class="tp-num">( ${day} )</p>
<p class="tp-big ${sizeClass(first, [16, 40, 80, 140])}">${first}</p>
<footer class="tp-corners"><span>AN IMPORTANT NOTE</span><span>PUBLISHED IN ${String(meta.date || '').slice(0, 4) || 'LAMPLIGHT'}</span></footer>`;
      case 'tp-list': {
        const items = (lines.length ? lines.slice(0, 7) : [title]);
        const list = items.map((l, i) => `<li>${l.replace(/[.,!?…·]+$/, '')}${i === items.length - 1 ? '.' : ','}</li>`).join('');
        return `<p class="tp-label">${title}</p><ul class="tp-big ${sizeClass(items.join(''), [60, 120, 220])}">${list}</ul>
<div class="tp-note"><b>${title}</b><p>${lines.slice(7).join(' ') || when}</p></div>`;
      }
      case 'tp-editorial':
        return `<p class="tp-big ${sizeClass(title + first, [40, 90, 160])}">${title}<sup>${when}</sup> ${lines.length ? first : ''}</p>
<div class="tp-note">${rest.map((l) => `<p>${l}</p>`).join('') || `<p>${when}</p>`}</div>`;
      default:
        return html;
    }
  }

  function templateHtml(template, md, meta = {}) {
    const html = mdToHtml(md);
    const title = escHtml(meta.title) || '제목 없음';
    const date = escHtml(meta.date);
    if (template.startsWith('lt-')) return paperHtml(template, html, meta);
    if (template.startsWith('tp-')) return typoHtml(template, html, meta);
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
