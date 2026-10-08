/* Lamplight promo film. Every frame is a pure function of time: render.js
 * calls renderAt(t) for t = 0, 1/30, 2/30 … and captures the page, then asks
 * renderAudio() for the soundtrack (the app's own synthesized typewriter). */
(function () {
  const DURATION = 30;
  const { templateHtml } = window.LampShared;
  const $ = (id) => document.getElementById(id);

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const ease = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const ramp = (t, a, b) => ease((t - a) / (b - a));
  // Visible from a to b, fading in and out over f seconds.
  const window_ = (t, a, b, f = 0.4) => Math.min(ramp(t, a, a + f), 1 - ramp(t, b - f, b));

  // A small seeded random, so the typing rhythm is the same on every render.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  /* ───────── 1 · typing ───────── */

  const TITLE = '비 오는 수요일';
  const BODY = '아침엔 커피를 두 잔 마셨다.\n엄마랑 짧게 통화했다.\n우산 없이 걸어도 괜찮은 하루.';
  const keys = [];      // { t, el, ch }
  const sounds = [];    // { t, kind, soft }

  function lay(el, text) {
    const spans = [];
    for (const ch of text) {
      const s = document.createElement('span');
      s.textContent = ch;
      el.append(s);
      spans.push({ el: s, ch });
    }
    return spans;
  }
  const titleSpans = lay($('title'), TITLE);
  const bodySpans = lay($('body'), BODY);
  const caret = document.createElement('i');
  caret.className = 'caret';

  sounds.push({ t: 0.7, kind: 'back' }); // the lamp switch
  let tt = 1.7;
  for (const k of [...titleSpans, { gap: true }, ...bodySpans]) {
    if (k.gap) { sounds.push({ t: tt, kind: 'enter' }); tt += 0.55; continue; }
    keys.push({ t: tt, ...k });
    sounds.push({ t: tt, kind: k.ch === ' ' ? 'space' : k.ch === '\n' ? 'enter' : 'char' });
    tt += k.ch === '\n' ? 0.5 : k.ch === ' ' ? 0.16 + rnd() * 0.06 : 0.1 + rnd() * 0.07;
  }
  const TYPED = tt;

  function lampPower(t) {
    if (t < 0.7) return 0;
    if (t < 1.3) return [0.6, 0.15, 0.85, 0.4, 1][Math.floor((t - 0.7) / 0.12)] ?? 1; // warm-up flicker
    return 1;
  }

  function renderType(t) {
    let last = null;
    for (const k of keys) {
      const on = k.t <= t;
      k.el.classList.toggle('on', on);
      if (on) last = k.el;
    }
    // The caret follows the last letter and blinks while idle.
    const anchor = last || $('title');
    if (caret.previousSibling !== last) (last ? last.after(caret) : $('title').prepend(caret));
    const sinceKey = last ? t - keys.find((k) => k.el === last).t : 1;
    caret.style.opacity = sinceKey < 0.5 || Math.floor(t * 1.8) % 2 === 0 ? 1 : 0;

    // The lamp: darkness with a warm pool of light around the line being typed.
    const p = lampPower(t);
    const r = anchor.getBoundingClientRect();
    const x = Math.min(1500, Math.max(420, r.right + 40));
    const y = r.top + r.height / 2 - 40;
    const reach = 560 + 160 * p;
    $('dark').style.background = `radial-gradient(ellipse ${reach * 1.35}px ${reach}px at ${x}px ${y}px, rgba(8,6,4,${0.92 - 0.9 * p}) 0%, rgba(8,6,4,${0.95 - 0.55 * p}) 55%, rgba(8,6,4,0.96) 100%)`;
    $('warm').style.background = `radial-gradient(ellipse ${reach}px ${reach * 0.7}px at ${x}px ${y}px, rgba(255,170,90,${0.22 * p}), transparent 70%)`;
    // A slow push in on the sheet.
    $('sheet').style.transform = `translateY(${-20 * ramp(t, 0, 11)}px) scale(${1.08 + 0.05 * ramp(t, 0, 11)})`;
  }

  /* ───────── 3 · templates ───────── */

  const NOTE = `# ${TITLE}\n\n2026. 10. 08. (목)\n\n---\n\n${BODY.replace(/\n/g, '\n\n')}`;
  const META = { seed: 'promo', title: TITLE, date: '2026.10.08' };
  const SEQUENCE = [
    ['lt-lined', '줄 노트'], ['lt-genko', '원고지'], ['lt-wax', '실링왁스'], ['lt-birthday', '생일'],
    ['notepad', '윈도우 95 메모장'], ['receipt', '오늘의 영수증'], ['bbs', 'PC통신 게시판'],
    ['tp-slide', '슬라이드'], ['tp-orange', '오렌지 슬라이드'], ['tp-specimen', '타입 포스터'], ['tp-list', '리스트'],
  ];
  const ALL = [
    'lt-lined', 'lt-kraft', 'lt-genko', 'lt-airmail', 'lt-birthday', 'lt-xmas', 'lt-spring', 'lt-autumn', 'lt-thanks',
    'lt-tape', 'lt-crayon', 'lt-wax', 'lt-gold', 'tp-slide', 'tp-orange', 'tp-specimen', 'tp-bold', 'tp-manifesto',
    'tp-list', 'tp-editorial', 'notepad', 'mail', 'receipt', 'bbs', 'terminal', 'msgbox', 'desktop',
  ];
  const TPL_START = 13;
  const TPL_EACH = (23.4 - TPL_START) / SEQUENCE.length;

  const makeDoc = (key) => {
    const doc = document.createElement('article');
    doc.className = 'doc';
    doc.dataset.template = key;
    doc.innerHTML = templateHtml(key, NOTE, META);
    return doc;
  };

  const frames = SEQUENCE.map(([key, name]) => {
    const frame = document.createElement('div');
    frame.className = 'tpl-frame';
    frame.append(makeDoc(key));
    $('stage').append(frame);
    return { frame, name, w: 0, h: 0 };
  });

  const cells = [...ALL, ...ALL.slice(0, 9)].map((key) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const doc = makeDoc(key);
    cell.append(doc);
    $('wall').append(cell);
    return { cell, doc };
  });

  function measure() {
    for (const f of frames) {
      const doc = f.frame.firstElementChild;
      f.w = doc.offsetWidth;
      f.h = doc.offsetHeight;
      f.scale = Math.min(1440 / f.w, 760 / f.h, 1.6);
    }
    for (const c of cells) {
      const s = Math.min(300 / c.doc.offsetWidth, 330 / c.doc.offsetHeight);
      c.doc.style.transform = `translate(${(300 - c.doc.offsetWidth * s) / 2}px, ${(330 - c.doc.offsetHeight * s) / 2}px) scale(${s})`;
    }
  }

  function renderTemplates(t) {
    const i = Math.floor((t - TPL_START) / TPL_EACH);
    frames.forEach((f, j) => {
      const local = (t - TPL_START - j * TPL_EACH) / TPL_EACH; // 0 … 1 while this one is up
      const on = j === i;
      const s = f.scale * (0.96 + 0.05 * clamp01(local));
      f.frame.style.opacity = on ? Math.min(1, local * 6, (1 - local) * 10) : 0;
      f.frame.style.transform = `translate(${-f.w * s / 2}px, ${-f.h * s / 2 + 34}px) scale(${s})`;
    });
    $('tplName').textContent = frames[Math.max(0, Math.min(frames.length - 1, i))].name;
  }

  function renderWall(t) {
    const z = 1.9 - 0.95 * ramp(t, 23.4, 27);
    $('wall').style.transform = `translate(-50%, -50%) scale(${z}) rotate(-4deg)`;
    $('scrim').style.opacity = 0.62 * window_(t, 23.9, 27.3, 0.5);
  }

  /* ───────── captions ───────── */

  const CAPTIONS = [
    [2.2, 10.2, '램프 아래에서, 한 글자씩.', 930],
    [13, 17.6, '다 쓴 메모를', 52],
    [17.6, 23.4, '원하는 모습으로 내보내세요', 52],
    [24, 27.2, '27가지 템플릿 · 이미지 · PDF · 공유', 500],
  ];

  function renderCaption(t) {
    const c = CAPTIONS.find(([a, b]) => t >= a && t < b);
    const el = $('caption');
    if (!c) { el.style.opacity = 0; return; }
    const [a, b, text, top] = c;
    el.textContent = text;
    el.style.top = `${top}px`;
    el.style.opacity = window_(t, a, b, 0.45);
    el.style.transform = `translateY(${10 * (1 - ramp(t, a, a + 0.6))}px)`;
  }

  /* ───────── the film ───────── */

  window.renderAt = function (t, mark = 0) {
    $('marker').style.background = `rgb(${mark & 255}, ${(mark >> 8) & 255}, 128)`;
    $('sType').style.opacity = 1 - ramp(t, 10.2, 10.8);
    $('sTitle').style.opacity = window_(t, 10.4, 13.1, 0.5);
    $('sTpl').style.opacity = window_(t, 12.8, 23.6, 0.35);
    $('sWall').style.opacity = window_(t, 23.3, 27.4, 0.35);
    $('sEnd').style.opacity = ramp(t, 27.1, 27.8);
    for (const [id, a] of [['sTitle', 10.4], ['sEnd', 27.1]]) {
      $(id).querySelector('h2').style.transform = `translateY(${18 * (1 - ramp(t, a + 0.2, a + 1.2))}px)`;
    }
    if (t < 11) renderType(t);
    if (t > 12.5 && t < 24) renderTemplates(t);
    if (t > 23 && t < 28) renderWall(t);
    renderCaption(t);
  };

  // Template cuts get a soft tick; the outro a carriage return and the bell.
  SEQUENCE.forEach((_, j) => sounds.push({ t: TPL_START + j * TPL_EACH + 0.02, kind: 'space', soft: true }));
  sounds.push({ t: 23.45, kind: 'enter', soft: true }, { t: 27.2, kind: 'bell', soft: true });

  /* The soundtrack: the app's TypeSound played into an OfflineAudioContext,
   * each sound scheduled at its moment in the film. Returns a WAV (base64). */
  window.renderAudio = async function () {
    const rate = 44100;
    const oc = new OfflineAudioContext(2, rate * DURATION, rate);
    let now = 0;
    const ctx = new Proxy(oc, {
      get(target, key) {
        if (key === 'currentTime') return now;
        if (key === 'state') return 'running';
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    window.AudioContext = function () { return ctx; };
    const sound = new window.TypeSound();
    sound.volume = 0.75;
    for (const e of sounds.sort((a, b) => a.t - b.t)) { now = e.t; sound.play(e.kind, !!e.soft); }
    const buf = await oc.startRendering();

    // 16-bit PCM WAV.
    const n = buf.length;
    const out = new DataView(new ArrayBuffer(44 + n * 4));
    const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * 4, true);
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    for (let i = 0; i < n; i++) {
      out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
      out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
    }
    let bin = '';
    const bytes = new Uint8Array(out.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  window.promoReady = document.fonts.ready.then(() => { measure(); window.renderAt(0); return { duration: DURATION, typed: TYPED }; });
})();
