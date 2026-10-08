/* InkEditor
 * A real <textarea> handles input (Korean IME, undo, selection, clipboard) with
 * transparent text. Underneath it, a mirror renders every character as its own
 * span with a little ink jitter, like a typewriter. New letters appear as
 * they are typed, without animation, so nothing blinks or moves.
 * Edits are diffed and patched into the mirror, so typing stays O(edit).
 *
 * The spans are grouped into one block per text line (each ending with its
 * own "\n" span; a block's trailing newline adds no extra line). An edit
 * rebuilds only the lines it touches, so the browser re-lays out those lines
 * instead of the whole note as one giant run of inline boxes. */
(function () {
  const STAMP_RE = /\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]/g;
  const BOLD_RE = /\*\*(?=\S)(.+?)(?<=\S)\*\*/g;
  const TX = '\u2063'; // invisible: marks a line the transcriber typed
  const AI = '\u2064'; // invisible: marks a line Claude typed
  const INK_CLASSES = ['stamp', 'mk', 'h', 'b', 'box', 'done', 'quote', 'tx', 'ai'];
  const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

  class InkEditor {
    constructor(textarea, mirror) {
      this.ta = textarea;
      this.mirror = mirror;
      this.text = '';
      this.spans = [];
      this.lastEdit = null;
      this.listeners = new Set();
      this.hitEls = [];
      this.lines = [];  // one block per text line; the last one holds the sentinel

      this.sentinel = document.createElement('span');
      this.sentinel.className = 'sentinel';
      this.sentinel.textContent = '​';
      this.lines = [this.newLine()];
      this.lines[0].appendChild(this.sentinel);
      mirror.replaceChildren(this.lines[0]);

      textarea.addEventListener('input', () => this.sync());
    }

    onChange(fn) { this.listeners.add(fn); }

    get value() { return this.text; }

    newLine() {
      const el = document.createElement('div');
      el.className = 'ln';
      return el;
    }

    /* Blocks for the spans of text[a, b), split after each newline. `b` is
     * either just past a "\n" or the end of the text, so this makes exactly
     * one block per line in the range. */
    buildLines(a, b) {
      const out = [this.newLine()];
      for (let i = a; i < b; i++) {
        out[out.length - 1].appendChild(this.spans[i]);
        if (this.text.charCodeAt(i) === 10 && i < b - 1) out.push(this.newLine());
      }
      return out;
    }

    setText(text) {
      this.ta.value = text;
      this.text = text;
      this.spans = this.makeSpans(text, '');
      this.lines = this.buildLines(0, text.length);
      // Text ending in "\n" has one more (empty) line after it.
      if (text.endsWith('\n')) this.lines.push(this.newLine());
      this.lines[this.lines.length - 1].appendChild(this.sentinel);
      const frag = document.createDocumentFragment();
      this.lines.forEach((el) => frag.appendChild(el));
      this.mirror.replaceChildren(frag);
      this.recolor(0, text.length);
      this.lastEdit = null;
      this.ta.scrollTop = 0;
    }

    makeSpans(str, cls) {
      const out = new Array(str.length);
      for (let i = 0; i < str.length; i++) {
        const el = document.createElement('span');
        const code = str.charCodeAt(i);
        if (isHigh(code) && i + 1 < str.length && isLow(str.charCodeAt(i + 1))) {
          // Keep surrogate pairs whole; the low half gets an empty span so
          // span indices still line up with textarea offsets.
          el.textContent = str[i] + str[i + 1];
          out[i] = el;
          out[i + 1] = document.createElement('span');
          i++;
        } else {
          el.textContent = str[i];
          out[i] = el;
        }
        const ch = str[i];
        if (ch !== '\n' && ch !== ' ' && ch !== '\t') {
          // Uneven ink and a hair of misalignment, fixed per character.
          const dy = (Math.random() - 0.5) * 1.1;
          const dx = (Math.random() - 0.5) * 0.5;
          const ink = 0.74 + Math.random() * 0.26;
          el.style.cssText = `--dy:${dy.toFixed(2)}px;--dx:${dx.toFixed(2)}px;--ink:${ink.toFixed(2)}`;
          if (cls) el.className = cls;
        }
      }
      return out;
    }

    sync() {
      const next = this.ta.value;
      const prev = this.text;
      if (next === prev) return;

      const min = Math.min(prev.length, next.length);
      let p = 0;
      while (p < min && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
      if (p > 0 && isHigh(prev.charCodeAt(p - 1))) p--;
      let s = 0;
      while (s < min - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
      if (s > 0 && isLow(next.charCodeAt(next.length - s))) s--;

      const removed = prev.length - p - s;
      const inserted = next.slice(p, next.length - s);

      const fresh = this.makeSpans(inserted, '');
      // A replaced letter (Hangul composing ㅎ → 하 → 한, or retyping one)
      // keeps the ink it already had, so it doesn't flicker as it changes.
      if (removed === inserted.length) {
        for (let i = 0; i < fresh.length; i++) {
          const was = this.spans[p + i];
          if (was?.style.cssText && fresh[i].style.cssText) fresh[i].style.cssText = was.style.cssText;
        }
      }

      this.spans = this.spans.slice(0, p).concat(fresh, this.spans.slice(p + removed));
      this.text = next;

      // Lines L0..L1 of the old text become L0..L0+k of the new one.
      let L0 = 0;
      for (let i = 0; i < p; i++) if (prev.charCodeAt(i) === 10) L0++;
      let L1 = L0;
      for (let i = p; i < p + removed; i++) if (prev.charCodeAt(i) === 10) L1++;
      const a = p === 0 ? 0 : next.lastIndexOf('\n', p - 1) + 1;
      const nl = next.indexOf('\n', p + inserted.length);
      const b = nl === -1 ? next.length : nl + 1;
      const freshLines = this.buildLines(a, b);
      // The edit reached the end and left a trailing "\n": add the empty last line.
      if (nl === -1 && next.endsWith('\n')) freshLines.push(this.newLine());
      const old = this.lines.slice(L0, L1 + 1);
      const after = this.lines[L1 + 1] || null;
      if (!after) freshLines[freshLines.length - 1].appendChild(this.sentinel);
      old.forEach((el) => el.remove());
      const frag = document.createDocumentFragment();
      freshLines.forEach((el) => frag.appendChild(el));
      this.mirror.insertBefore(frag, after);
      this.lines = this.lines.slice(0, L0).concat(freshLines, this.lines.slice(L1 + 1));

      this.recolor(p, p + inserted.length);
      this.lastEdit = {
        type: inserted.length && !removed ? 'insert' : !inserted.length ? 'delete' : 'replace',
        index: p,
        removedText: prev.slice(p, p + removed),
        inserted,
        removed,
      };
      this.ta.scrollTop = 0;
      this.listeners.forEach((fn) => fn(this.lastEdit));
    }

    /* Per-line ink, re-applied to every line an edit touches:
     *   [12:34]           red ribbon (timestamps)
     *   # / ## / ###      heading weight, faded markers
     *   **bold**          bold, faded markers
     *   - [x] item        struck through
     *   > quote           softer ink
     *   ⁣ line start  transcript ink · ⁤ line start  Claude's ink
     * Only weight/colour/opacity change, never glyph widths, so the mirror
     * stays aligned with the textarea. */
    recolor(a, b) {
      const t = this.text;
      let start = t.lastIndexOf('\n', Math.max(0, a - 1)) + 1;
      let end = t.indexOf('\n', b);
      if (end === -1) end = t.length;
      while (start <= end) {
        let lineEnd = t.indexOf('\n', start);
        if (lineEnd === -1 || lineEnd > end) lineEnd = end;
        this.decorateLine(start, lineEnd);
        start = lineEnd + 1;
      }
    }

    decorateLine(start, end) {
      const spans = this.spans;
      for (let i = start; i < end; i++) spans[i]?.classList.remove(...INK_CLASSES);
      const line = this.text.slice(start, end);
      const add = (cls, from, to) => { for (let i = from; i < to; i++) spans[start + i]?.classList.add(cls); };

      let off = 0;
      if (line[0] === TX) { add('tx', 0, line.length); off = 1; }
      else if (line[0] === AI) { add('ai', 0, line.length); off = 1; }
      const rest = line.slice(off);

      let m;
      if ((m = rest.match(/^(#{1,3}) /))) {
        add('mk', off, off + m[0].length);
        add('h', off + m[0].length, line.length);
      } else if ((m = rest.match(/^> /))) {
        add('mk', off, off + 2);
        add('quote', off + 2, line.length);
      } else if ((m = rest.match(/^(\s*[-*•] )\[([ xX])\]/))) {
        const box = off + m[1].length;
        add('box', box, box + 3);
        if (m[2] !== ' ') add('done', box + 3, line.length);
      }

      BOLD_RE.lastIndex = 0;
      while ((m = BOLD_RE.exec(line))) {
        add('mk', m.index, m.index + 2);
        add('b', m.index + 2, m.index + m[0].length - 2);
        add('mk', m.index + m[0].length - 2, m.index + m[0].length);
      }
      STAMP_RE.lastIndex = 0;
      while ((m = STAMP_RE.exec(line))) add('stamp', m.index, m.index + m[0].length);
    }

    /* A single named highlight over [a, b) — e.g. the line being played back. */
    mark(name, a = 0, b = 0) {
      this.marks = this.marks || {};
      for (const el of this.marks[name] || []) el.classList.remove(name);
      const list = [];
      for (let i = a; i < b; i++) {
        const el = this.spans[i];
        if (el) { el.classList.add(name); list.push(el); }
      }
      this.marks[name] = list;
    }

    /* Highlight search matches: ranges are [offset, length]; `cur` is the focused one. */
    setHits(ranges, cur = -1) {
      for (const el of this.hitEls) el.classList.remove('hit', 'hit-now');
      this.hitEls = [];
      ranges.forEach(([a, len], k) => {
        for (let i = a; i < a + len; i++) {
          const el = this.spans[i];
          if (!el) continue;
          el.classList.add('hit');
          if (k === cur) el.classList.add('hit-now');
          this.hitEls.push(el);
        }
      });
    }

    /* Viewport coordinates of the caret at a text offset. */
    caretRect(index = this.ta.selectionEnd) {
      const t = this.text;
      if (index > 0 && t[index - 1] !== '\n') {
        const r = this.spans[index - 1].getBoundingClientRect();
        return { x: r.right, top: r.top, bottom: r.bottom };
      }
      const r = (this.spans[index] || this.sentinel).getBoundingClientRect();
      return { x: r.left, top: r.top, bottom: r.bottom };
    }

    /* A timestamp under the given offset, in seconds, or null. */
    stampAt(index) {
      const t = this.text;
      const start = t.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
      let end = t.indexOf('\n', index);
      if (end === -1) end = t.length;
      const line = t.slice(start, end);
      STAMP_RE.lastIndex = 0;
      let m;
      while ((m = STAMP_RE.exec(line))) {
        const a = start + m.index;
        if (index >= a && index <= a + m[0].length) {
          const parts = m[0].slice(1, -1).split(':').map(Number);
          return parts.reduce((acc, n) => acc * 60 + n, 0);
        }
      }
      return null;
    }

    insert(str) {
      this.ta.focus();
      // execCommand keeps the native undo stack intact.
      if (!document.execCommand('insertText', false, str)) {
        this.ta.setRangeText(str, this.ta.selectionStart, this.ta.selectionEnd, 'end');
        this.sync();
      }
    }
  }

  InkEditor.TX = TX;
  InkEditor.AI = AI;
  window.InkEditor = InkEditor;
})();
