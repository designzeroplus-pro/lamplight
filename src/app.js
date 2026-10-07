(function () {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const root = document.documentElement;

  const appEl = $('app');
  const desk = $('desk');
  const scroller = $('scroller');
  const paper = $('paper');
  const titleEl = $('title');
  const attendeesEl = $('attendees');
  const dateEl = $('date');
  const input = $('input');
  const lampEl = $('lamp');
  const noteList = $('noteList');
  const counter = $('counter');
  const audio = $('audio');
  const seek = $('seek');
  const wave = $('wave');

  const LINE_GAP = 50;      // caret line bottom sits this far above the rail
  const LAMP_OFFSET = 52;   // lamp rides just to the right of the caret
  const BELL_AT = 0.86;     // ring the margin bell near the end of a line

  const sound = new TypeSound();
  const editor = new InkEditor(input, $('mirror'));
  const titleInk = new InkEditor(titleEl, $('titleMirror'));
  const titleMirror = $('titleMirror');
  const lamp = new LampScene({ desk, shade: $('shade'), glow: $('glow'), rail: $('rail'), lamp: lampEl });
  const recorder = new Recorder();
  const stt = new LiveTranscriber();

  /* ───────── settings ───────── */

  const SETTINGS_KEY = 'lamplight.settings';
  const settings = {
    intensity: 150, spread: 112, reach: 120,
    lampOn: true, theme: 'dark', sound: true, volume: 0.7, sidebar: true, looseCollapsed: false, transcribe: true,
    fontSize: 17, railRatio: 60, readingLight: true, soundProfile: 'classic', sttLocale: 'ko-KR',
    autoSummary: false, motion: 'system', onboarded: false, aiProvider: 'claude', retranscribe: true,
  };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch {}
  const persist = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

  function applyTheme() {
    const dark = settings.theme !== 'light';
    body.classList.toggle('dark', dark);
    body.classList.toggle('light', !dark);
    lamp.setDark(dark);
    window.memo.setTheme(dark ? 'dark' : 'light');
  }

  function applyLamp() {
    lamp.setOn(settings.lampOn);
    $('lampSwitch').classList.toggle('on', settings.lampOn);
  }

  function applySound() {
    sound.enabled = settings.sound;
    sound.setVolume(settings.volume);
    sound.profile = settings.soundProfile;
    body.classList.toggle('muted', !settings.sound);
  }

  // Type size and where the typing line rests on the desk.
  function applyPaper() {
    root.style.setProperty('--type-size', `${settings.fontSize}px`);
    lastH = 0; // re-lay the rail and paper margins next frame
  }

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  function applyMotion() {
    const still = settings.motion === 'on' || (settings.motion === 'system' && motionQuery.matches);
    body.classList.toggle('reduce-motion', still);
    lamp.setStill(still);
  }
  motionQuery.addEventListener('change', applyMotion);

  function applySidebar() {
    appEl.classList.toggle('collapsed', !settings.sidebar);
  }

  const knobs = [
    { id: 'intensity', label: 'vIntensity', unit: '%', map: (v) => ({ intensity: v / 100 }) },
    { id: 'spread', label: 'vSpread', unit: '°', map: (v) => ({ spread: v }) },
    { id: 'reach', label: 'vReach', unit: '%', map: (v) => ({ reach: v / 100 }) },
  ];

  const KNOB_DEFAULTS = { intensity: 150, spread: 112, reach: 120 };

  function fill(el) {
    const p = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--p', `${p}%`);
  }

  function applyKnobs() {
    const p = {};
    for (const k of knobs) {
      const el = $(k.id);
      el.value = settings[k.id];
      fill(el);
      $(k.label).textContent = `${settings[k.id]}${k.unit}`;
      Object.assign(p, k.map(Number(settings[k.id])));
    }
    lamp.setParams(p);
  }

  knobs.forEach((k) => {
    $(k.id).addEventListener('input', (e) => {
      settings[k.id] = Number(e.target.value);
      fill(e.target);
      $(k.label).textContent = `${settings[k.id]}${k.unit}`;
      lamp.setParams(k.map(settings[k.id]));
      persist();
    });
  });

  /* ───────── light popover ───────── */

  const pop = $('lightPop');
  const lightBtn = $('lightBtn');

  function setPopover(open) {
    if (open) {
      const stage = pop.offsetParent.getBoundingClientRect();
      const b = lightBtn.getBoundingClientRect();
      const half = pop.offsetWidth / 2;
      const x = Math.max(half + 12, b.left + b.width / 2 - stage.left);
      pop.style.left = `${x}px`;
    }
    pop.classList.toggle('open', open);
    lightBtn.setAttribute('aria-expanded', String(open));
  }

  lightBtn.addEventListener('click', () => setPopover(!pop.classList.contains('open')));
  document.addEventListener('mousedown', (e) => {
    if (pop.classList.contains('open') && !pop.contains(e.target) && !lightBtn.contains(e.target)) setPopover(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop.classList.contains('open')) setPopover(false);
  });
  $('lightReset').addEventListener('click', () => {
    Object.assign(settings, KNOB_DEFAULTS);
    applyKnobs();
    persist();
  });

  /* ───────── formatting ───────── */

  const pad = (n) => String(n).padStart(2, '0');
  const spaced = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  function fmtTime(secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    const s = Math.floor(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  }

  // Compact clock for the dock, Apple-style: 0:42, 12:05, 1:02:03
  function fmtClock(secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    const s = Math.floor(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  function fmtLongDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}. ${pad(d.getMonth() + 1)}. ${pad(d.getDate())}. (${WEEK[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtListDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return `오늘 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (diff === 1) return '어제';
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
    return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
  }

  /* ───────── toast ───────── */

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ───────── notes ───────── */

  const TX = InkEditor.TX;   // invisible line prefix: typed by the transcriber
  const AI = InkEditor.AI;   // invisible line prefix: typed by Claude
  const MARKS_RE = /[\u2063\u2064]/g;

  let notes = [];
  let folders = [];
  let current = null;
  let fold = null;           // { full } while transcript lines are folded away
  let stampCache = null;     // timestamped lines, for following playback
  const fullText = () => (fold ? fold.full : editor.value);
  const plainText = () => fullText().replace(MARKS_RE, '');
  let dirty = false;
  let saveTimer = null;

  // Sidebar preview: plain words, without ink markers or markdown punctuation.
  const previewOf = (text) => (text || '')
    .replace(MARKS_RE, '')
    .replace(/^#{1,3} |^> /gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  const summary = (n) => ({
    id: n.id,
    title: n.title || '',
    createdAt: n.createdAt,
    updatedAt: n.updatedAt || Date.now(),
    folderId: n.folderId || null,
    preview: previewOf(n.body),
    recordings: (n.recordings || []).length,
  });

  const MIC_ICON = '<svg viewBox="0 0 12 12"><rect x="4" y="1.2" width="4" height="6" rx="2"/><path d="M2.5 6a3.5 3.5 0 0 0 7 0M6 9.5V11"/></svg>';
  const DEL_ICON = '<svg viewBox="0 0 20 20"><path d="M5 6h10M8 6V4.5h4V6M6.5 6l.7 9.5h5.6l.7-9.5"/></svg>';

  const FOLDER_ICON = '<svg viewBox="0 0 20 20"><path d="M2.8 6.2V15a1.2 1.2 0 0 0 1.2 1.2h12a1.2 1.2 0 0 0 1.2-1.2V8.2A1.2 1.2 0 0 0 16 7H9.6L8 5H4a1.2 1.2 0 0 0-1.2 1.2z"/></svg>';
  const CHEV_ICON = '<svg viewBox="0 0 12 12"><path d="M3.5 4.6 6 7.1l2.5-2.5"/></svg>';
  const PLUS_ICON = '<svg viewBox="0 0 20 20"><path d="M10 5v10M5 10h10"/></svg>';
  const NOTE_MIME = 'application/x-lamplight-note';

  let renaming = null;     // folder id being renamed, list re-renders wait for it
  let renderPending = false;

  const folderOf = (n) => (n.folderId && folders.some((f) => f.id === n.folderId) ? n.folderId : null);
  const folderName = (id) => folders.find((f) => f.id === id)?.name || '미분류';

  function noteItem(n) {
    const li = document.createElement('li');
    li.className = 'note' + (current && n.id === current.id ? ' active' : '');
    li.dataset.id = n.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    if (current && n.id === current.id) li.setAttribute('aria-current', 'true');
    li.addEventListener('keydown', (e) => {
      if (e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openNote(n.id); }
    });
    li.draggable = true;

    const t = document.createElement('div');
    t.className = 'note-title' + (n.title ? '' : ' untitled');
    t.textContent = n.title || '제목 없는 회의';

    const meta = document.createElement('div');
    meta.className = 'note-meta';
    const d = document.createElement('span');
    d.textContent = fmtListDate(n.updatedAt);
    meta.appendChild(d);
    if (n.recordings) {
      const mic = document.createElement('span');
      mic.className = 'mic';
      mic.innerHTML = MIC_ICON;
      mic.append(String(n.recordings));
      meta.appendChild(mic);
    }

    const del = document.createElement('button');
    del.className = 'icon note-del';
    del.title = '휴지통으로 이동';
    del.innerHTML = DEL_ICON;
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteNote(n.id); });

    li.append(t, meta);
    if (n.preview) {
      const p = document.createElement('div');
      p.className = 'note-preview';
      p.textContent = n.preview;
      li.appendChild(p);
    }
    li.appendChild(del);
    li.addEventListener('click', () => openNote(n.id));
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); noteMenu(n); });
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(NOTE_MIME, n.id);
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    return li;
  }

  function groupItem(id, name, collapsed, items) {
    const li = document.createElement('li');
    li.className = 'group' + (collapsed ? ' collapsed' : '') + (id ? '' : ' loose');
    li.dataset.folder = id || '';

    const head = document.createElement('div');
    head.className = 'group-head';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(!collapsed));
    head.addEventListener('keydown', (e) => {
      if (e.target === head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleGroup(id, li); }
    });
    head.innerHTML = `<span class="chev">${CHEV_ICON}</span><span class="ficon">${FOLDER_ICON}</span>`;
    const label = document.createElement('span');
    label.className = 'group-name';
    label.textContent = name;
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = items.length || '';
    const add = document.createElement('button');
    add.className = 'icon group-add';
    add.title = '이 폴더에 새 회의록';
    add.innerHTML = PLUS_ICON;
    add.addEventListener('click', (e) => { e.stopPropagation(); newNote(id); });
    head.append(label, count, add);

    head.addEventListener('click', () => toggleGroup(id, li));
    if (id) head.addEventListener('dblclick', (e) => { e.preventDefault(); renameFolder(id); });
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); folderMenu(id); });

    const ul = document.createElement('ul');
    ul.className = 'group-notes';
    if (items.length) items.forEach((n) => ul.appendChild(noteItem(n)));
    else {
      const empty = document.createElement('li');
      empty.className = 'group-empty';
      empty.textContent = '비어 있음';
      ul.appendChild(empty);
    }
    li.append(head, ul);

    // Drop a note anywhere on the group to file it there.
    li.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(NOTE_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      li.classList.add('drop-hover');
    });
    li.addEventListener('dragleave', (e) => { if (!li.contains(e.relatedTarget)) li.classList.remove('drop-hover'); });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      li.classList.remove('drop-hover');
      const noteId = e.dataTransfer.getData(NOTE_MIME);
      if (noteId) moveNote(noteId, id);
    });
    return li;
  }

  function renderList() {
    if (renaming) { renderPending = true; return; }
    const frag = document.createDocumentFragment();
    if (!folders.length) {
      notes.forEach((n) => frag.appendChild(noteItem(n)));
    } else {
      const groups = new Map(folders.map((f) => [f.id, []]));
      const loose = [];
      for (const n of notes) {
        const f = folderOf(n);
        (f ? groups.get(f) : loose).push(n);
      }
      for (const f of folders) frag.appendChild(groupItem(f.id, f.name, f.collapsed, groups.get(f.id)));
      if (loose.length) frag.appendChild(groupItem(null, '미분류', settings.looseCollapsed, loose));
    }
    noteList.replaceChildren(frag);
  }

  /* ───────── folders ───────── */

  const saveFolders = () => window.memo.saveFolders(folders);

  // Toggles in place (no re-render) so a double-click can still reach the same row.
  function toggleGroup(id, li) {
    let collapsed;
    if (id) {
      const f = folders.find((x) => x.id === id);
      if (!f) return;
      collapsed = f.collapsed = !f.collapsed;
      saveFolders();
    } else {
      collapsed = settings.looseCollapsed = !settings.looseCollapsed;
      persist();
    }
    li.classList.toggle('collapsed', collapsed);
    li.querySelector('.group-head')?.setAttribute('aria-expanded', String(!collapsed));
  }

  async function newFolder() {
    const id = `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    folders.push({ id, name: '새 폴더', collapsed: false, createdAt: Date.now() });
    await saveFolders();
    renderList();
    renameFolder(id);
  }

  function renameFolder(id) {
    const f = folders.find((x) => x.id === id);
    const label = noteList.querySelector(`.group[data-folder="${id}"] .group-name`);
    if (!f || !label) return;
    renaming = id;
    const field = document.createElement('input');
    field.className = 'group-rename';
    field.value = f.name;
    field.maxLength = 60;
    field.spellcheck = false;
    label.replaceWith(field);
    field.focus();
    field.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const name = field.value.trim();
      if (commit && name) f.name = name;
      renaming = null;
      saveFolders();
      renderList();
      renderPending = false;
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    field.addEventListener('blur', () => finish(true));
    field.addEventListener('click', (e) => e.stopPropagation());
    field.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  async function deleteFolder(id) {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    const inside = notes.filter((n) => n.folderId === id);
    const msg = inside.length
      ? `'${f.name}' 폴더를 삭제할까요?\n안에 있는 회의록 ${inside.length}개는 미분류로 옮겨집니다.`
      : `'${f.name}' 폴더를 삭제할까요?`;
    if (!window.confirm(msg)) return;
    await Promise.all(inside.map((n) => window.memo.setNoteFolder(n.id, null)));
    inside.forEach((n) => { n.folderId = null; });
    if (current?.folderId === id) current.folderId = null;
    folders = folders.filter((x) => x.id !== id);
    await saveFolders();
    renderList();
    toast('폴더를 삭제했습니다');
  }

  async function moveNote(noteId, folderId) {
    const n = notes.find((x) => x.id === noteId);
    if (!n || (n.folderId || null) === (folderId || null)) return;
    await window.memo.setNoteFolder(noteId, folderId);
    n.folderId = folderId;
    if (current?.id === noteId) current.folderId = folderId;
    const f = folders.find((x) => x.id === folderId);
    if (f?.collapsed) { f.collapsed = false; saveFolders(); }
    renderList();
    toast(`'${folderName(folderId)}'(으)로 옮겼습니다`);
  }

  async function noteMenu(n) {
    const here = folderOf(n);
    const pick = await window.memo.contextMenu([
      { id: 'open', label: '열기' },
      { type: 'separator' },
      {
        label: '폴더로 이동',
        enabled: folders.length > 0,
        submenu: [
          { id: 'move:', label: '미분류', checked: here === null },
          { type: 'separator' },
          ...folders.map((f) => ({ id: `move:${f.id}`, label: f.name, checked: here === f.id })),
        ],
      },
      { id: 'new-folder-move', label: '새 폴더로 이동…' },
      { type: 'separator' },
      { id: 'delete', label: '휴지통으로 이동' },
    ]);
    if (!pick) return;
    if (pick === 'open') openNote(n.id);
    else if (pick === 'delete') deleteNote(n.id);
    else if (pick === 'new-folder-move') {
      await newFolder();
      const f = folders[folders.length - 1];
      await moveNote(n.id, f.id);
    } else if (pick.startsWith('move:')) moveNote(n.id, pick.slice(5) || null);
  }

  async function folderMenu(id) {
    const items = [{ id: 'new-note', label: '새 회의록' }];
    if (id) items.push({ id: 'rename', label: '이름 변경' }, { type: 'separator' }, { id: 'delete', label: '폴더 삭제' });
    const pick = await window.memo.contextMenu(items);
    if (pick === 'new-note') newNote(id);
    else if (pick === 'rename') renameFolder(id);
    else if (pick === 'delete') deleteFolder(id);
  }

  noteList.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const pick = await window.memo.contextMenu([{ id: 'new-folder', label: '새 폴더' }, { id: 'new-note', label: '새 회의록' }]);
    if (pick === 'new-folder') newFolder();
    else if (pick === 'new-note') newNote(null);
  });

  // Dropping on blank sidebar space files the note under 미분류.
  noteList.addEventListener('dragover', (e) => { if (folders.length && e.dataTransfer.types.includes(NOTE_MIME)) e.preventDefault(); });
  noteList.addEventListener('drop', (e) => {
    const noteId = e.dataTransfer.getData(NOTE_MIME);
    if (noteId) moveNote(noteId, null);
  });

  function touchSummary() {
    const i = notes.findIndex((n) => n.id === current.id);
    const s = summary(current);
    if (i >= 0) notes.splice(i, 1);
    notes.unshift(s);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!current || !dirty) return;
    dirty = false;
    current.body = fullText();
    current.updatedAt = Date.now();
    try {
      await window.memo.saveNote(current);
    } catch (err) {
      dirty = true;
      toast('저장하지 못했습니다');
      console.error(err);
      return;
    }
    touchSummary();
    renderList();
  }

  function scheduleSave() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }

  function updateCounter() {
    const text = fullText();
    const chars = text.replace(/[\s\u2063\u2064]/g, '').length;
    const lines = text ? text.split('\n').length : 0;
    counter.textContent = `${spaced(chars)} 자 · ${spaced(lines)} 줄`;
  }

  async function openNote(id, preloaded) {
    if (current && current.id === id) return;
    unfold();
    await saveNow();
    const note = preloaded || (await window.memo.loadNote(id));
    if (!note) return;
    current = note;
    current.recordings = current.recordings || [];

    titleInk.setText(note.title || '');
    attendeesEl.value = note.attendees || '';
    dateEl.textContent = fmtLongDate(note.createdAt);
    editor.setText(note.body || '');
    stampCache = null;

    stopPlayback(true);
    renderRecordings();
    renderList();
    updateCounter();
    closeFind(false);

    snap = true;
    follow = true;
    if (note.title) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else {
      titleEl.focus();
    }
  }

  // New notes land in the folder you're working in unless told otherwise.
  async function newNote(folderId) {
    await saveNow();
    const target = folderId !== undefined ? folderId : current ? folderOf(current) : null;
    const n = await window.memo.createNote(target);
    notes.unshift(summary(n));
    const f = folders.find((x) => x.id === target);
    if (f?.collapsed) { f.collapsed = false; saveFolders(); }
    await openNote(n.id, n);
  }

  async function deleteNote(id) {
    if (recorder.active && recNoteId === id) {
      toast('녹음 중인 회의록은 지울 수 없습니다');
      return;
    }
    const n = notes.find((x) => x.id === id);
    const name = n?.title || '제목 없는 회의';
    if (!window.confirm(`'${name}' 회의록을 휴지통으로 옮길까요?\n녹음 파일도 함께 옮겨집니다.`)) return;
    if (current?.id === id) { clearTimeout(saveTimer); dirty = false; }
    await window.memo.deleteNote(id);
    notes = notes.filter((x) => x.id !== id);
    if (current?.id === id) {
      current = null;
      if (notes.length) await openNote(notes[0].id);
      else await newNote();
    } else {
      renderList();
    }
    toast('휴지통으로 옮겼습니다');
  }

  async function exportNote() {
    if (!current) return;
    await saveNow();
    const lines = [`# ${current.title || '제목 없는 회의'}`, '', `- 일시: ${fmtLongDate(current.createdAt)}`];
    if (current.attendees) lines.push(`- 참석자: ${current.attendees}`);
    if (current.recordings.length) {
      lines.push(`- 녹음: ${current.recordings.map((r) => `${r.file} (${fmtTime(r.duration)})`).join(', ')}`);
    }
    lines.push('', '---', '', plainText(), '');
    const path = await window.memo.exportNote({
      name: (current.title || '회의록').replace(/[\\/:*?"<>|]/g, ' ').trim(),
      content: lines.join('\n'),
    });
    if (path) toast('내보냈습니다');
  }

  // The title is one line: Enter moves on (handled on keydown), pasted line breaks become spaces.
  titleEl.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); return; }
    const data = e.data ?? e.dataTransfer?.getData('text/plain');
    if (data && /[\r\n]/.test(data)) {
      e.preventDefault();
      document.execCommand('insertText', false, data.replace(/[\r\n]+/g, ' '));
    }
  });

  titleEl.addEventListener('input', () => {
    current.title = titleEl.value;
    scheduleSave();
    const s = notes.find((n) => n.id === current.id);
    if (s) { s.title = current.title; renderList(); }
  });
  attendeesEl.addEventListener('input', () => {
    current.attendees = attendeesEl.value;
    scheduleSave();
  });

  /* ───────── typing feel ───────── */

  let bellLine = null;
  let lastUserKey = 0;
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  let follow = true;
  let snap = true;

  /* ───────── list continuation ─────────
   * "1. " / "- " / "- [ ] " lines carry on to the next line on Enter.
   * Enter on a marker we just added (still empty) ends the list instead. */

  const LIST_RE = /^(\s*)(?:(\d{1,3})([.)])(?=\s|$)|([-*•])( \[[ xX]\])?(?=\s))\s?/;
  let autoMarker = null;     // { start, end } of the marker we last inserted
  let applyingMarker = false;
  let autoTyping = false;

  function continueList(nl) {
    const v = input.value;
    if (v[nl] !== '\n' || input.selectionStart !== nl + 1 || input.selectionEnd !== nl + 1) return;
    const lineStart = v.lastIndexOf('\n', nl - 1) + 1;
    const line = v.slice(lineStart, nl);
    const m = line.match(LIST_RE);
    if (!m) { autoMarker = null; return; }

    applyingMarker = true;
    try {
      const empty = !line.slice(m[0].length).trim();
      // An empty bullet always ends the list; an empty number only if we added it
      // (so typing "1." "2." by hand still counts on).
      const fresh = autoMarker && autoMarker.start === lineStart && autoMarker.end >= nl;
      if (empty && (fresh || !m[2])) {
        // Second Enter on a fresh item: drop the marker and the line break.
        input.setSelectionRange(lineStart, nl + 1);
        document.execCommand('insertText', false, '');
        // Chromium can leave the caret before the trailing newline; put it on the emptied line.
        input.setSelectionRange(lineStart, lineStart);
        autoMarker = null;
        return;
      }
      const marker = m[2]
        ? `${m[1]}${Number(m[2]) + 1}${m[3]} `
        : `${m[1]}${m[4]}${m[5] ? ' [ ]' : ''} `;
      document.execCommand('insertText', false, marker);
      autoMarker = { start: nl + 1, end: nl + 1 + marker.length };
    } finally {
      applyingMarker = false;
    }
    renumber(input.selectionStart);
  }

  /* Ordered lists keep counting: after an item is added, removed or moved,
   * numbers in the surrounding list are rewritten (one undo step). Nested
   * levels start at 1; the first top-level item keeps whatever number it has. */
  const ITEM_RE = /^(\s*)(?:(\d{1,3})([.)])|([-*•]))(?=\s)/;

  function renumber(at) {
    const v = input.value;
    const lineAt = (i) => v.lastIndexOf('\n', i - 1) + 1;
    let start = lineAt(Math.min(at, v.length));
    let end = v.indexOf('\n', start);
    if (end === -1) end = v.length;
    const isItem = (a, b) => ITEM_RE.test(v.slice(a, b));
    if (!isItem(start, end)) return;
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
    const block = v.slice(start, end);
    const lines = block.split('\n');
    const minIndent = Math.min(...lines.map((l) => l.match(ITEM_RE)[1].length));
    const counters = new Map();
    let changed = false;
    let caretShift = 0;
    let pos = start;
    const caret = input.selectionStart;
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
    if (!changed) return;
    applyingMarker = true;
    try {
      input.setSelectionRange(start, end);
      document.execCommand('insertText', false, out.join('\n'));
      input.setSelectionRange(caret + caretShift, caret + caretShift);
    } finally {
      applyingMarker = false;
    }
  }

  /* Tab / ⇧Tab: indent or outdent the selected lines (or a list item);
   * elsewhere Tab inserts two spaces instead of leaving the page. */
  function indentLines(out) {
    const v = input.value;
    const s = input.selectionStart;
    const e = input.selectionEnd;
    const start = v.lastIndexOf('\n', s - 1) + 1;
    let end = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
    if (end === -1) end = v.length;
    const lines = v.slice(start, end).split('\n');
    const single = lines.length === 1;
    const bare = (l) => l.replace(MARKS_RE, '');
    if (single && !out && !ITEM_RE.test(bare(lines[0]))) {
      document.execCommand('insertText', false, '  ');
      return;
    }
    let firstDelta = 0;
    let total = 0;
    const next = lines.map((line, i) => {
      const mark = /^[\u2063\u2064]/.test(line) ? line[0] : '';
      const body = line.slice(mark.length);
      let res;
      if (out) {
        const cut = body.startsWith('  ') ? 2 : body.startsWith(' ') || body.startsWith('\t') ? 1 : 0;
        res = mark + body.slice(cut);
      } else {
        res = mark + '  ' + body;
      }
      if (i === 0) firstDelta = res.length - line.length;
      total += res.length - line.length;
      return res;
    });
    if (!total) return;
    input.setSelectionRange(start, end);
    document.execCommand('insertText', false, next.join('\n'));
    if (single) {
      const c = Math.max(start, s + firstDelta);
      input.setSelectionRange(c, c);
    } else {
      input.setSelectionRange(start, end + total);
    }
    renumber(start);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    e.preventDefault();
    indentLines(e.shiftKey);
  });

  // Click a "[ ]" to tick it (and again to untick).
  input.addEventListener('click', (e) => {
    if (e.metaKey || input.readOnly || input.selectionStart !== input.selectionEnd) return;
    const v = input.value;
    const pos = input.selectionStart;
    const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
    const m = v.slice(lineStart, lineStart + 40).match(/^([\u2063\u2064]?\s*[-*•] )\[([ xX])\]/);
    if (!m) return;
    const box = lineStart + m[1].length;
    if (pos < box || pos > box + 3) return;
    input.setSelectionRange(box + 1, box + 2);
    document.execCommand('insertText', false, m[2] === ' ' ? 'x' : ' ');
    input.setSelectionRange(box + 3, box + 3);
    sound.play('back');
  });

  // Copy without the invisible ink markers.
  input.addEventListener('copy', (e) => {
    const sel = input.value.slice(input.selectionStart, input.selectionEnd);
    if (!MARKS_RE.test(sel)) return;
    MARKS_RE.lastIndex = 0;
    e.preventDefault();
    e.clipboardData.setData('text/plain', sel.replace(MARKS_RE, ''));
  });
  input.addEventListener('cut', (e) => {
    const sel = input.value.slice(input.selectionStart, input.selectionEnd);
    if (!MARKS_RE.test(sel)) return;
    MARKS_RE.lastIndex = 0;
    e.preventDefault();
    e.clipboardData.setData('text/plain', sel.replace(MARKS_RE, ''));
    document.execCommand('insertText', false, '');
  });

  /* ───────── fold transcripts ───────── */

  function foldTranscript() {
    if (fold) return unfold();
    const full = editor.value;
    const lines = full.split('\n');
    const kept = lines.filter((l) => !l.startsWith(TX));
    const hidden = lines.length - kept.length;
    if (!hidden) { toast('접을 받아쓰기 내용이 없어요'); return; }
    saveNow();
    fold = { full };
    editor.setText(kept.join('\n'));
    stampCache = null;
    input.readOnly = true;
    body.classList.add('folded');
    $('foldPill').textContent = `받아쓰기 ${hidden}줄 접힘 · 펼치기`;
    toast('받아쓴 내용을 접었어요 · 직접 쓴 글만 보여요');
  }

  function unfold() {
    if (!fold) return;
    const { full } = fold;
    fold = null;
    editor.setText(full);
    stampCache = null;
    input.readOnly = false;
    body.classList.remove('folded');
  }

  $('foldPill').addEventListener('click', () => { unfold(); input.focus(); });
  input.addEventListener('keydown', (e) => {
    if (!fold || e.metaKey || e.ctrlKey) return;
    if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Process') {
      toast('접힌 상태에서는 고칠 수 없어요 · 위의 "펼치기"를 눌러 주세요');
    }
  });

  editor.onChange((edit) => {
    current.body = editor.value;
    scheduleSave();
    updateCounter();
    follow = true;

    if (findOpen()) {
      clearTimeout(findTimer);
      findTimer = setTimeout(() => runFind(false), 120);
    }

    stampCache = null;
    if (!applyingMarker) {
      if (edit.type === 'insert' && edit.inserted === '\n' && !autoTyping) {
        const nl = edit.index;
        queueMicrotask(() => continueList(nl));
      } else {
        autoMarker = null;
        if (!autoTyping && (edit.removedText.includes('\n') || edit.inserted.includes('\n'))) {
          queueMicrotask(() => renumber(input.selectionStart));
        }
      }
    }

    if (edit.type !== 'delete' && !edit.inserted.includes('\n')) {
      const r = editor.caretRect();
      const box = input.getBoundingClientRect();
      const line = Math.round(r.top - box.top);
      if ((r.x - box.left) / box.width > BELL_AT && bellLine !== line) {
        bellLine = line;
        setTimeout(() => sound.play('bell'), 60);
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t === input || t.classList?.contains('typed'))) return;
    lastUserKey = performance.now();
    if (e.metaKey || e.ctrlKey) return;

    let kind = null;
    if (e.key === 'Enter') kind = 'enter';
    else if (e.key === 'Backspace' || e.key === 'Delete') kind = 'back';
    else if (e.code === 'Space') kind = 'space';
    else if (e.key.length === 1 || e.key === 'Process' || e.key === 'Unidentified') kind = 'char';
    if (!kind) return;

    if (kind === 'enter' && t !== input && !e.isComposing) {
      e.preventDefault();
      if (t === titleEl) attendeesEl.focus();
      else { input.focus(); input.setSelectionRange(0, 0); }
    }

    sound.play(kind);
    follow = true;
  }, true);

  // Clicking blank paper puts the caret at the end, like rolling back to the last line.
  paper.addEventListener('mousedown', (e) => {
    if (e.target === paper || e.target.classList.contains('rule')) {
      e.preventDefault();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      follow = true;
    }
  });

  for (const el of [input, titleEl, attendeesEl]) {
    el.addEventListener('focus', () => { follow = true; });
    el.addEventListener('mouseup', () => { follow = true; });
  }
  scroller.addEventListener('wheel', () => { follow = false; }, { passive: true });

  // The beam leans a little toward the pointer while it moves over the desk.
  let pointer = null; // { x, y, t } in desk coordinates
  desk.addEventListener('mousemove', (e) => {
    const r = desk.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  });
  desk.addEventListener('mouseleave', () => { pointer = null; });

  /* ───────── follow playback ─────────
   * While a recording plays, the lamp moves to the [mm:ss] line being heard. */
  let playLine = null;

  function stampLines() {
    if (stampCache) return stampCache;
    const out = [];
    let start = 0;
    for (const line of editor.value.split('\n')) {
      const m = line.match(/\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/);
      if (m) out.push({ secs: m[1].split(':').map(Number).reduce((a, n) => a * 60 + n, 0), start, end: start + line.length });
      start += line.length + 1;
    }
    stampCache = out;
    return out;
  }

  function updatePlayLine() {
    let best = null;
    if (!audio.paused) {
      const t = audio.currentTime + 0.25;
      for (const s of stampLines()) if (s.secs <= t && (!best || s.secs >= best.secs)) best = s;
    }
    if (best?.start === playLine?.start && best?.end === playLine?.end) return;
    playLine = best;
    if (best) { editor.mark('now', best.start, best.end); follow = true; } else editor.mark('now');
  }

  // ⌘-click a [mm:ss] stamp to hear that moment.
  input.addEventListener('click', (e) => {
    if (!e.metaKey) return;
    const secs = editor.stampAt(input.selectionStart);
    if (secs !== null) playFrom(secs);
  });

  /* ───────── caret geometry ───────── */

  const measure = document.createElement('canvas').getContext('2d');

  function inputCaret(el) {
    const cs = getComputedStyle(el);
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    measure.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    const text = el.value || '';
    const w = measure.measureText(text.slice(0, el.selectionEnd ?? text.length)).width;
    const r = el.getBoundingClientRect();
    return { x: r.left + w - el.scrollLeft, top: r.top, bottom: r.bottom - 8 };
  }

  function caretAnchor() {
    const a = document.activeElement;
    if (playLine && !audio.paused && performance.now() - lastUserKey > 2500 && a !== titleEl && a !== attendeesEl) {
      return editor.caretRect(playLine.end);
    }
    if (a === titleEl) return titleInk.caretRect();
    if (a === attendeesEl) return inputCaret(a);
    return editor.caretRect();
  }

  /* ───────── recording ───────── */

  let recNoteId = null;
  let recFile = null;              // Promise<string>: the file being streamed to disk
  let writeChain = Promise.resolve();
  let levels = [];

  async function toggleRecord() {
    if (recorder.active) return stopRecord();
    if (!current) return;
    const granted = await window.memo.requestMic();
    if (!granted) {
      toast('마이크 권한이 필요합니다 · 시스템 설정 › 개인정보 보호 › 마이크', 4200);
      return;
    }
    const noteId = current.id;
    const filePromise = window.memo.beginAudio(noteId, { createdAt: Date.now() });
    writeChain = Promise.resolve();
    // Every second of audio goes to disk right away, in order.
    recorder.onChunk = (blob) => {
      writeChain = writeChain
        .then(async () => window.memo.audioChunk(noteId, await filePromise, new Uint8Array(await blob.arrayBuffer())))
        .catch((err) => console.error('chunk write failed', err));
    };
    try {
      await recorder.start();
    } catch (err) {
      console.error(err);
      recorder.onChunk = null;
      filePromise.then((f) => window.memo.abortAudio(noteId, f)).catch(() => {});
      toast('마이크를 열 수 없습니다');
      return;
    }
    recFile = filePromise;
    recNoteId = noteId;
    levels = [];
    body.classList.add('recording');
    $('recTime').textContent = '0:00';
    sound.play('back');
    if (settings.transcribe) startTranscription();
    else toast('녹음을 시작합니다 · ⌘T 로 타임스탬프');
  }

  async function stopRecord() {
    body.classList.remove('recording');
    lamp.setLevel(0);
    try {
      // Let the recognizer finish its last sentence while the file is written.
      const flushed = stt.stop();
      const res = await recorder.stop();
      recorder.onChunk = null;
      await Promise.all([flushed, writeChain]);
      if (!res) return;
      const bytes = new Uint8Array(await res.blob.arrayBuffer());
      const entry = await window.memo.finishAudio(recNoteId, await recFile, bytes, { createdAt: res.createdAt, duration: res.duration });
      const s = notes.find((n) => n.id === recNoteId);
      if (s) s.recordings += 1;
      if (current?.id === recNoteId) {
        current.recordings.push(entry);
        renderRecordings(entry.file);
      }
      renderList();
      toast(`녹음을 저장했습니다 · ${fmtTime(res.duration)}`);
      const noteId = recNoteId;
      if (settings.retranscribe !== false || settings.autoSummary) {
        (async () => {
          while (typeQueue.length || typing) await sleep(300);
          if (settings.retranscribe !== false) await retranscribe(noteId, entry);
          if (settings.autoSummary && current?.id === noteId && !summarizing) summarize();
        })();
      }
    } catch (err) {
      console.error(err);
      toast('녹음을 저장하지 못했습니다');
    } finally {
      recNoteId = null;
      recFile = null;
    }
  }

  /* ───────── whole-recording transcription ─────────
   * After a meeting, the full recording is transcribed again: decoded to
   * 16 kHz, cut into speech segments by a simple energy detector, each segment
   * brought to a steady level (quiet voices lifted), then recognized one by
   * one. The result goes under its own heading in transcript ink. */
  let retranscribing = false;
  let fileJob = null; // { finals, onProgress }

  window.memo.onSttFile((ev) => {
    if (!fileJob) return;
    if (ev.type === 'final') fileJob.finals.push(ev);
    else if (ev.type === 'progress') fileJob.onProgress(ev.done, ev.total);
    else if (ev.type === 'error') fileJob.error = ev.code;
  });

  function findSpeech(pcm, rate) {
    const hop = Math.round(rate * 0.03);
    const n = Math.floor(pcm.length / hop);
    const rms = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let s = 0;
      for (let i = f * hop; i < (f + 1) * hop; i++) s += pcm[i] * pcm[i];
      rms[f] = Math.sqrt(s / hop);
    }
    const sorted = Array.from(rms).sort((x, y) => x - y);
    const floor = sorted[Math.floor(n * 0.2)] || 0;
    const thr = Math.max(floor * 2.5, 0.003);
    const segs = [];
    let start = -1;
    let quiet = 0;
    for (let f = 0; f < n; f++) {
      if (rms[f] > thr) {
        if (start < 0) start = f;
        quiet = 0;
      } else if (start >= 0 && ++quiet > 23) { // ~0.7 s of quiet ends a segment
        segs.push([start, f - quiet]);
        start = -1;
        quiet = 0;
      }
    }
    if (start >= 0) segs.push([start, n - 1]);
    const out = [];
    for (const [a, b] of segs) {
      let s0 = Math.max(0, a * 0.03 - 0.3);
      const s1 = Math.min(pcm.length / rate, (b + 1) * 0.03 + 0.3);
      if (s1 - s0 < 0.4) continue;
      while (s1 - s0 > 45) { out.push([s0, s0 + 45]); s0 += 45; } // stay well under recognizer limits
      out.push([s0, s1]);
    }
    return out;
  }

  function levelSegments(pcm, rate, segs) {
    for (const [a, b] of segs) {
      const i0 = Math.floor(a * rate);
      const i1 = Math.min(pcm.length, Math.floor(b * rate));
      let s = 0;
      for (let i = i0; i < i1; i++) s += pcm[i] * pcm[i];
      const r = Math.sqrt(s / Math.max(1, i1 - i0));
      const gain = Math.min(12, Math.max(1, 0.1 / Math.max(r, 1e-4)));
      if (gain > 1.01) for (let i = i0; i < i1; i++) pcm[i] = Math.tanh(pcm[i] * gain);
    }
  }

  function toWav(pcm, rate) {
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new Uint8Array(buf);
  }

  async function retranscribe(noteId, rec) {
    if (!rec || retranscribing) return;
    retranscribing = true;
    showCaption('녹음 전체를 다시 받아쓰고 있어요…', true);
    try {
      const bytes = await window.memo.readAudio(noteId, rec.file);
      const ctx = new AudioContext({ sampleRate: 16000 });
      const decoded = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      ctx.close();
      const pcm = new Float32Array(decoded.getChannelData(0));
      const segs = findSpeech(pcm, 16000);
      if (!segs.length) { toast('녹음에서 말소리를 찾지 못했어요'); return; }
      levelSegments(pcm, 16000, segs);
      fileJob = { finals: [], onProgress: (d, t) => showCaption(`녹음 전체를 다시 받아쓰는 중… ${Math.round((d / t) * 100)}%`, true) };
      const res = await window.memo.sttFile({ wav: toWav(pcm, 16000), segments: segs, locale: settings.sttLocale });
      const finals = fileJob.finals;
      if (res.error === 'busy') { toast('이미 다른 녹음을 받아쓰고 있어요'); return; }
      if (fileJob.error === 'denied') { toast('음성 인식 권한이 필요합니다 · 시스템 설정 › 개인정보 보호 및 보안 › 음성 인식', 5200); return; }
      if (!finals.length) { toast('받아 적을 수 있는 말소리가 없었어요 · 마이크 가까이에서 말해 주세요', 5000); return; }

      const recs = current?.id === noteId ? current.recordings : [];
      const idx = recs.findIndex((r) => r.file === rec.file);
      const head = `${TX}──────── 전체 받아쓰기${idx >= 0 ? ` · 녹음 ${idx + 1}` : ''} ────────`;
      const lines = finals.map((f) => `${TX}[${fmtTime(f.start)}] ${f.text}`);
      const block = `\n${head}\n${lines.join('\n')}\n`;
      if (current?.id === noteId) {
        unfold();
        const v = input.value;
        input.setRangeText((v && !v.endsWith('\n') ? '\n' : '') + block, v.length, v.length, 'preserve');
        editor.sync();
        follow = true;
      } else {
        await appendToStoredNote(noteId, block);
      }
      toast(`전체 받아쓰기를 마쳤어요 · ${finals.length}문장`);
    } catch (err) {
      console.error(err);
      toast('전체 받아쓰기를 하지 못했어요');
    } finally {
      fileJob = null;
      retranscribing = false;
      if (!body.classList.contains('transcribing') && !summarizing) hideCaption();
    }
  }

  /* ───────── live transcription ───────── */

  const caption = $('caption');
  const captionText = $('captionText');
  const typeQueue = [];   // [{ noteId, text }]
  let typing = false;

  function showCaption(text, idle = false) {
    const t = text.length > 64 ? `…${text.slice(-64)}` : text;
    captionText.textContent = t;
    caption.classList.toggle('idle', idle);
    caption.classList.add('show');
  }
  const hideCaption = () => caption.classList.remove('show');

  function applyTranscribe() {
    $('sttBtn').classList.toggle('on', settings.transcribe);
    $('sttBtn').title = settings.transcribe ? '실시간 받아쓰기 켜짐' : '실시간 받아쓰기 꺼짐';
  }

  async function startTranscription() {
    try {
      await stt.start(recorder.stream, () => recorder.elapsed(), settings.sttLocale);
    } catch (err) {
      console.error(err);
      toast('받아쓰기를 시작할 수 없습니다');
    }
  }

  async function toggleTranscribe() {
    settings.transcribe = !settings.transcribe;
    applyTranscribe();
    persist();
    if (recorder.active) {
      if (settings.transcribe) startTranscription();
      else await stt.stop();
    }
    toast(settings.transcribe ? '실시간 받아쓰기를 켰습니다' : '실시간 받아쓰기를 껐습니다');
  }

  stt.on('state', (state) => {
    body.classList.toggle('transcribing', state === 'listening' || state === 'starting');
    if (state === 'listening') showCaption('듣고 있어요…', true);
    else if (state === 'flushing') showCaption('마지막 문장을 정리하는 중…', true);
    else if (state === 'idle') hideCaption();
  });
  stt.on('partial', (text) => showCaption(text));
  stt.on('final', (text, at) => {
    showCaption('듣고 있어요…', true);
    const noteId = recNoteId || current?.id;
    if (!noteId) return;
    typeQueue.push({ noteId, text: `${TX}[${fmtTime(at)}] ${text}` });
    pumpTyping();
  });
  stt.on('error', (ev) => {
    body.classList.remove('transcribing');
    hideCaption();
    if (ev.code === 'denied') toast('음성 인식 권한이 필요합니다 · 시스템 설정 › 개인정보 보호 및 보안 › 음성 인식', 5200);
    else if (ev.code === 'missing') toast('받아쓰기 도구가 없습니다 · npm run build:native', 4200);
    else if (ev.code === 'locale' || ev.code === 'unavailable') toast('이 Mac에서 한국어 음성 인식을 쓸 수 없습니다', 4200);
    else toast('받아쓰기를 시작할 수 없습니다');
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Types one character the way a person would: at the caret if it is at the
   * end of the page (so the lamp follows), otherwise appended quietly at the end. */
  function autoType(ch) {
    const end = input.value.length;
    const atEnd = document.activeElement === input && input.selectionStart === end && input.selectionEnd === end;
    autoTyping = true;
    try {
      if (atEnd && document.execCommand('insertText', false, ch)) return;
      input.setRangeText(ch, end, end, 'preserve');
      editor.sync();
    } finally {
      autoTyping = false;
    }
  }

  async function appendToStoredNote(noteId, text) {
    const note = await window.memo.loadNote(noteId);
    if (!note) return;
    const sep = note.body && !note.body.endsWith('\n') ? '\n' : '';
    note.body += sep + text;
    await window.memo.saveNote(note);
    const s = notes.find((n) => n.id === noteId);
    if (s) Object.assign(s, summary(note), { updatedAt: Date.now() });
    renderList();
  }

  // On close there's no time for the typewriter: put the rest down at once.
  async function drainTyping() {
    while (typeQueue.length) {
      const item = typeQueue.shift();
      if (current && current.id === item.noteId) {
        const v = input.value;
        const text = !item.started && !item.raw && v && !v.endsWith('\n') ? `\n${item.text}` : item.text;
        input.setRangeText(text, v.length, v.length, 'preserve');
        editor.sync();
      } else {
        await appendToStoredNote(item.noteId, item.text);
      }
    }
  }

  async function pumpTyping() {
    if (typing) return;
    typing = true;
    try {
      while (typeQueue.length) {
        const item = typeQueue[0];
        if (!current || current.id !== item.noteId) {
          typeQueue.shift();
          await appendToStoredNote(item.noteId, item.text);
          continue;
        }
        unfold(); // never type into the folded view
        if (!item.started) {
          item.started = true;
          const v = input.value;
          if (!item.raw && v && !v.endsWith('\n')) item.text = `\n${item.text}`;
        }
        // Yield to the person: never type over an IME composition or fresh keystrokes.
        if (composing || performance.now() - lastUserKey < 700) { await sleep(150); continue; }
        const ch = item.text[0];
        item.text = item.text.slice(1);
        autoType(ch);
        if (!item.text) typeQueue.shift();
        if (ch === TX || ch === AI) continue; // invisible ink markers: no sound, no pause
        sound.play(ch === '\n' ? 'enter' : ch === ' ' ? 'space' : 'char', true);
        const backlog = typeQueue.reduce((n, q) => n + q.text.length, 0);
        await sleep(ch === '\n' ? 320 : Math.max(12, 46 - backlog / 4));
      }
    } finally {
      typing = false;
    }
  }

  function insertTimestamp() {
    let stamp;
    if (recorder.active && recNoteId === current?.id) stamp = `[${fmtTime(recorder.elapsed())}] `;
    else if (loadedKey && audio.currentTime > 0) stamp = `[${fmtTime(audio.currentTime)}] `;
    else {
      const d = new Date();
      stamp = `(${pad(d.getHours())}:${pad(d.getMinutes())}) `;
    }
    if (document.activeElement !== input) {
      input.focus();
    }
    editor.insert(stamp);
    sound.play('char');
  }

  /* ───────── playback ───────── */

  let loadedKey = null;
  let loadedUrl = null;

  let selectedFile = null;

  function selectedRecording() {
    return current?.recordings.find((r) => r.file === selectedFile) || null;
  }

  function recordingLabel(r, i) {
    const d = new Date(r.createdAt);
    return `녹음 ${i + 1}  ·  ${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}  ·  ${fmtClock(r.duration)}`;
  }

  // Newest recording is selected unless a specific one is asked for.
  function renderRecordings(select) {
    const recs = current?.recordings || [];
    $('dock').classList.toggle('has-recs', recs.length > 0);
    if (!recs.length) { selectedFile = null; return; }
    if (select && recs.some((r) => r.file === select)) selectedFile = select;
    else if (!recs.some((r) => r.file === selectedFile)) selectedFile = recs[recs.length - 1].file;
    syncPlayerIdle();
  }

  async function recordingMenu() {
    const recs = current?.recordings || [];
    if (!recs.length) return;
    const pick = await window.memo.contextMenu([
      ...recs.map((r, i) => ({ id: `sel:${r.file}`, label: recordingLabel(r, i), checked: r.file === selectedFile })).reverse(),
      { type: 'separator' },
      { id: 'retranscribe', label: '이 녹음 전체 다시 받아쓰기' },
      { id: 'reveal', label: 'Finder에서 보기' },
      { id: 'delete', label: '이 녹음 삭제…' },
    ]);
    if (!pick) return;
    if (pick.startsWith('sel:')) {
      if (pick.slice(4) !== selectedFile) {
        stopPlayback(true);
        selectedFile = pick.slice(4);
        syncPlayerIdle();
      }
    } else if (pick === 'retranscribe') {
      retranscribe(current.id, selectedRecording());
    } else if (pick === 'reveal') {
      window.memo.revealAudio(current.id, selectedFile);
    } else if (pick === 'delete') {
      deleteRecording(selectedFile);
    }
  }

  async function deleteRecording(file) {
    const recs = current?.recordings || [];
    const i = recs.findIndex((r) => r.file === file);
    if (i < 0) return;
    if (!window.confirm(`'${recordingLabel(recs[i], i)}'을(를) 삭제할까요?\n녹음 파일은 휴지통으로 옮겨집니다.`)) return;
    if (loadedKey === `${current.id}/${file}`) stopPlayback(true);
    try {
      await window.memo.deleteAudio(current.id, file);
    } catch (err) {
      console.error(err);
      toast('녹음을 삭제하지 못했습니다');
      return;
    }
    recs.splice(i, 1);
    const s = notes.find((n) => n.id === current.id);
    if (s) s.recordings = recs.length;
    if (selectedFile === file) selectedFile = null;
    renderRecordings();
    renderList();
    toast('녹음을 휴지통으로 옮겼습니다');
  }

  function syncPlayerIdle() {
    const recs = current?.recordings || [];
    const idx = recs.findIndex((r) => r.file === selectedFile);
    $('recMenuLabel').textContent = recs.length > 1 ? `녹음 ${idx + 1}/${recs.length}` : '녹음';
    $('playTime').textContent = fmtClock(selectedRecording()?.duration);
    seek.value = 0;
    fill(seek);
  }

  async function loadRecording() {
    const rec = selectedRecording();
    if (!rec) return null;
    const key = `${current.id}/${rec.file}`;
    if (loadedKey === key) return rec;
    stopPlayback(true);
    const bytes = await window.memo.readAudio(current.id, rec.file);
    let blob = new Blob([bytes], { type: 'audio/webm' });
    if (rec.recovered && window.ysFixWebmDuration) blob = await window.ysFixWebmDuration(blob, rec.duration * 1000, { logger: false });
    loadedUrl = URL.createObjectURL(blob);
    audio.src = loadedUrl;
    loadedKey = key;
    await new Promise((r) => {
      if (audio.readyState >= 1) r();
      else audio.addEventListener('loadedmetadata', r, { once: true });
    });
    return rec;
  }

  function duration() {
    return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : selectedRecording()?.duration || 0;
  }

  async function playFrom(secs) {
    if (!(await loadRecording())) {
      toast('재생할 녹음이 없습니다');
      return;
    }
    audio.currentTime = Math.min(secs, Math.max(0, duration() - 0.1));
    audio.play();
  }

  async function togglePlay() {
    if (!(await loadRecording())) return;
    if (audio.paused) audio.play();
    else audio.pause();
  }

  function stopPlayback(unload) {
    audio.pause();
    if (unload) {
      audio.removeAttribute('src');
      audio.load();
      if (loadedUrl) URL.revokeObjectURL(loadedUrl);
      loadedUrl = null;
      loadedKey = null;
      seek.value = 0;
      fill(seek);
    }
  }

  audio.addEventListener('play', () => body.classList.add('playing'));
  audio.addEventListener('pause', () => { body.classList.remove('playing'); updatePlayLine(); });
  audio.addEventListener('ended', () => { body.classList.remove('playing'); updatePlayLine(); });
  audio.addEventListener('timeupdate', () => {
    updatePlayLine();
    const d = duration();
    if (!seeking) seek.value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
    fill(seek);
    $('playTime').textContent = fmtClock(audio.currentTime);
  });

  let seeking = false;
  seek.addEventListener('input', async () => {
    seeking = true;
    if (!(await loadRecording())) return;
    audio.currentTime = (seek.value / 1000) * duration();
    fill(seek);
  });
  seek.addEventListener('change', () => { seeking = false; });
  $('recMenu').addEventListener('click', recordingMenu);
  $('recMenu').addEventListener('contextmenu', (e) => { e.preventDefault(); recordingMenu(); });
  $('playBtn').addEventListener('click', togglePlay);
  $('recBtn').addEventListener('click', toggleRecord);
  $('sttBtn').addEventListener('click', toggleTranscribe);

  /* ───────── level meter ───────── */

  const wctx = wave.getContext('2d');
  function drawWave(level) {
    if (level === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wave.clientWidth;
    const h = wave.clientHeight;
    if (!w) return;
    if (wave.width !== Math.round(w * dpr)) {
      wave.width = Math.round(w * dpr);
      wave.height = Math.round(h * dpr);
    }
    const step = 3;
    const n = Math.floor(w / step);
    levels.push(level);
    if (levels.length > n) levels.splice(0, levels.length - n);
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wctx.clearRect(0, 0, w, h);
    wctx.fillStyle = '#ff6b5e';
    for (let i = 0; i < n; i++) {
      const v = levels[levels.length - n + i] ?? 0;
      const bh = Math.max(2, v * h);
      wctx.globalAlpha = 0.45 + v * 0.55;
      wctx.beginPath();
      wctx.roundRect(i * step, (h - bh) / 2, 1.8, bh, 1);
      wctx.fill();
    }
  }

  /* The engraved title is lit by the lamp when it's on in the dark, otherwise
   * by soft light from the upper left. */
  let titleLight = { x: 0, y: 0 };
  function shadeTitle(deskRect) {
    let lx = -0.35;
    let ly = -0.94;
    if (body.classList.contains('dark') && settings.lampOn) {
      const r = titleMirror.getBoundingClientRect();
      const a = lamp.apex;
      const dx = a.x - (r.left + r.width * 0.35 - deskRect.left);
      const dy = a.y - (r.top + r.height / 2 - deskRect.top);
      const len = Math.hypot(dx, dy) || 1;
      lx = dx / len;
      ly = dy / len;
    }
    if (Math.abs(lx - titleLight.x) + Math.abs(ly - titleLight.y) < 0.03) return;
    titleLight = { x: lx, y: ly };
    titleMirror.style.setProperty('--lx', lx.toFixed(3));
    titleMirror.style.setProperty('--ly', ly.toFixed(3));
  }

  /* ───────── frame loop ───────── */

  let last = performance.now();
  let lastH = 0;
  let lastSecond = -1;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const deskRect = desk.getBoundingClientRect();
    const H = deskRect.height;
    const railY = Math.round(H * (settings.railRatio / 100));
    if (H !== lastH) {
      lastH = H;
      root.style.setProperty('--feed', `${railY}px`);
      root.style.setProperty('--tail', `${Math.round(H - railY + 80)}px`);
      snap = true;
    }

    const paperRect = paper.getBoundingClientRect();
    lamp.setRail(paperRect.left - deskRect.left - 18, paperRect.right - deskRect.left + 18, railY);

    const r = caretAnchor();
    if (r && current) {
      const desired = Math.max(0, r.bottom - deskRect.top + scroller.scrollTop - (railY - LINE_GAP));
      const cur = scroller.scrollTop;
      if (snap) {
        scroller.scrollTop = desired;
        snap = false;
      } else if (follow && Math.abs(desired - cur) > 0.5) {
        const diff = desired - cur;
        let step = diff * (1 - Math.pow(1 - 0.2, dt * 60));
        if (Math.abs(step) < 1) step = Math.sign(diff) * Math.min(1, Math.abs(diff));
        scroller.scrollTop = cur + step;
      }
      lamp.setTarget(r.x - deskRect.left + LAMP_OFFSET);
    }

    let level = null;
    if (recorder.active) {
      level = recorder.level();
      lamp.setLevel(level);
      const sec = Math.floor(recorder.elapsed());
      if (sec !== lastSecond) {
        lastSecond = sec;
        $('recTime').textContent = fmtClock(sec);
        $('recBadgeTime').textContent = fmtTime(sec);
      }
    }
    drawWave(level);
    lamp.setReading(settings.readingLight !== false && (!!fold || (!follow && !playLine)));
    shadeTitle(deskRect);
    // Follow the pointer unless you're typing; reading back follows a bit more.
    const typingNow = performance.now() - lastUserKey < 1500;
    const pointerFresh = pointer && performance.now() - pointer.t < 6000;
    if (settings.lightFollowsPointer !== false && pointerFresh && !typingNow) {
      lamp.lookAt(pointer.x, pointer.y, !follow ? 0.5 : 0.4);
    } else {
      lamp.lookAt(null);
    }
    lamp.frame(dt);
    requestAnimationFrame(frame);
  }

  /* ───────── AI summary ───────── */

  const keySheet = $('keySheet');
  const keyInput = $('keyInput');
  const keyStatusEl = $('keyStatus');
  let summarizing = false;
  let aiNoteId = null;
  let aiStarted = false;
  let summarizeAfterKey = false;

  const providerName = (p) => (p === 'chatgpt' ? 'ChatGPT' : 'Claude');
  let aiProviderNow = 'claude';

  async function summarize() {
    if (summarizing) { window.memo.aiCancel(); return; }
    if (!current) return;
    await saveNow();
    if (plainText().replace(/\s/g, '').length < 10) { toast('요약할 내용이 아직 부족해요'); return; }
    const provider = settings.aiProvider === 'chatgpt' ? 'chatgpt' : 'claude';
    const ready = provider === 'chatgpt'
      ? (await window.memo.gptStatus()).signedIn
      : (await window.memo.aiKeyStatus()).hasKey;
    if (!ready) { openKeySheet(true); return; }

    summarizing = true;
    aiProviderNow = provider;
    aiNoteId = current.id;
    aiStarted = false;
    body.classList.add('summarizing');
    $('aiBtn').title = '요약 멈추기';
    showCaption(`${providerName(provider)}가 회의를 정리하고 있어요…`, true);
    await window.memo.aiSummarize({
      provider,
      title: current.title,
      attendees: current.attendees,
      date: fmtLongDate(current.createdAt),
      body: plainText(),
    });
  }

  function endSummary() {
    summarizing = false;
    body.classList.remove('summarizing');
    $('aiBtn').title = 'AI 요약 (⌘⇧M)';
    if (!body.classList.contains('transcribing')) hideCaption();
  }

  window.memo.onAi((ev) => {
    if (ev.type === 'delta') {
      if (!aiStarted) {
        aiStarted = true;
        // The heading goes down only once Claude actually starts answering.
        typeQueue.push({ noteId: aiNoteId, text: `\n${AI}──────── 회의 요약 · ${providerName(aiProviderNow)} ────────\n${AI}` });
        if (!body.classList.contains('transcribing')) hideCaption();
      }
      typeQueue.push({ noteId: aiNoteId, text: ev.text.replace(/\n/g, `\n${AI}`), raw: true });
      pumpTyping();
    } else if (ev.type === 'done') {
      if (aiStarted) { typeQueue.push({ noteId: aiNoteId, text: '\n', raw: true }); pumpTyping(); }
      endSummary();
      if (ev.stopReason === 'refusal') toast(`${providerName(aiProviderNow)}가 이 내용은 정리하지 않았어요`, 4200);
      else if (ev.stopReason === 'max_tokens') toast('요약이 길어 중간에 끊겼어요');
      else toast('요약을 마쳤어요');
    } else if (ev.type === 'error') {
      endSummary();
      const msg = {
        auth: 'API 키를 확인해 주세요',
        rate: '요청이 많아요 · 잠시 후 다시 시도해 주세요',
        network: '인터넷 연결을 확인해 주세요',
        server: `${providerName(aiProviderNow)} 서버가 응답하지 않아요 · 잠시 후 다시 시도해 주세요`,
        aborted: '요약을 멈췄어요',
        'gpt-limit': 'ChatGPT 사용 한도에 도달했어요 · 한도가 풀리면 다시 시도해 주세요',
        'gpt-unavailable': '이 계정에서는 ChatGPT 구독으로 요약할 수 없어요 (Plus · Pro 필요)',
        'gpt-login': 'ChatGPT에 다시 로그인해 주세요',
      }[ev.code] || '요약하지 못했어요';
      toast(msg, 4600);
      if (ev.code === 'auth' || ev.code === 'gpt-login') openKeySheet(false);
    }
  });

  /* The AI sheet: pick ChatGPT (sign in, plan usage) or Claude (API key). */
  function showProvider(p) {
    for (const btn of $('aiProvider').children) {
      const on = btn.dataset.v === p;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
    }
    keySheet.querySelectorAll('.ai-pane').forEach((el) => el.classList.toggle('on', el.dataset.pane === p));
    $('aiNote').textContent = p === 'chatgpt'
      ? '로그인 정보는 macOS 키체인으로 암호화해 이 Mac에만 저장돼요. 요약할 때만 회의 내용이 OpenAI로 전송되고, ChatGPT 구독 한도에서 차감돼요.'
      : '키는 macOS 키체인으로 암호화해 이 Mac에만 저장돼요. 요약할 때만 회의 내용이 Anthropic으로 전송되고, API 사용량만큼 요금이 나가요.';
    if (p === 'claude') setTimeout(() => keyInput.focus(), 0);
  }

  async function refreshGpt() {
    const pane = keySheet.querySelector('[data-pane="chatgpt"]');
    const st = await window.memo.gptStatus();
    pane.classList.toggle('in', st.signedIn);
    pane.classList.toggle('out', !st.signedIn);
    if (!st.signedIn) return st;
    $('gptEmail').textContent = st.email || st.name || 'ChatGPT 계정';
    const sel = $('gptModel');
    const { models, error } = await window.memo.gptModels();
    sel.replaceChildren();
    if (!models.length) {
      sel.append(new Option(error === 'unavailable' ? '구독으로 쓸 수 있는 모델이 없어요' : '모델을 불러오지 못했어요', ''));
      sel.disabled = true;
      return st;
    }
    sel.disabled = false;
    models.forEach((m) => sel.append(new Option(m.name, m.slug)));
    sel.value = st.model && models.some((m) => m.slug === st.model) ? st.model : models[0].slug;
    if (sel.value !== st.model) window.memo.gptSetModel(sel.value);
    return st;
  }

  async function refreshKey() {
    keyInput.value = '';
    keyStatusEl.classList.remove('bad');
    const st = await window.memo.aiKeyStatus();
    keyStatusEl.textContent = st.source === 'stored' ? `저장된 키 ${st.hint}`
      : st.source === 'env' ? '환경 변수(ANTHROPIC_API_KEY)의 키를 쓰고 있어요'
      : 'Anthropic API 키를 붙여 넣어 주세요';
    $('keyClear').hidden = st.source !== 'stored';
  }

  async function openKeySheet(thenSummarize = false) {
    summarizeAfterKey = thenSummarize;
    keySheet.hidden = false;
    requestAnimationFrame(() => keySheet.classList.add('open'));
    showProvider(settings.aiProvider === 'chatgpt' ? 'chatgpt' : 'claude');
    await Promise.all([refreshGpt(), refreshKey()]);
  }

  function closeKeySheet() {
    keySheet.classList.remove('open');
    keySheet.hidden = true;
    input.focus();
  }

  function useProvider(p) {
    settings.aiProvider = p;
    persist();
    showProvider(p);
  }

  $('aiProvider').addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (v) useProvider(v);
  });

  $('gptLogin').addEventListener('click', async () => {
    const btn = $('gptLogin');
    btn.disabled = true;
    btn.textContent = '브라우저에서 로그인하는 중…';
    $('gptStatus').classList.remove('bad');
    $('gptStatus').textContent = '로그인을 마치면 자동으로 돌아와요.';
    const res = await window.memo.gptSignIn();
    btn.disabled = false;
    btn.textContent = 'ChatGPT로 로그인';
    if (!res.signedIn) {
      $('gptStatus').classList.add('bad');
      $('gptStatus').textContent = {
        denied: '로그인을 취소했어요',
        timeout: '시간이 지나 로그인을 멈췄어요 · 다시 시도해 주세요',
        unavailable: '이 계정은 구독 사용을 허용하지 않았어요 (Plus · Pro 필요)',
      }[res.error] || '로그인하지 못했어요 · 다시 시도해 주세요';
      return;
    }
    useProvider('chatgpt');
    await refreshGpt();
    toast('ChatGPT에 연결했어요');
    if (summarizeAfterKey) { closeKeySheet(); summarize(); }
  });

  $('gptLogout').addEventListener('click', async () => {
    await window.memo.gptSignOut();
    await refreshGpt();
    toast('ChatGPT에서 로그아웃했어요');
  });

  $('gptModel').addEventListener('change', (e) => window.memo.gptSetModel(e.target.value));

  async function saveKey() {
    try {
      await window.memo.aiKeySet(keyInput.value);
    } catch (err) {
      keyStatusEl.classList.add('bad');
      keyStatusEl.textContent = /secure storage/.test(String(err))
        ? '이 Mac에서 안전한 저장소를 쓸 수 없어요'
        : 'sk-ant-로 시작하는 API 키를 붙여 넣어 주세요';
      return;
    }
    useProvider('claude');
    toast('API 키를 저장했어요');
    if (summarizeAfterKey) { closeKeySheet(); summarize(); } else refreshKey();
  }

  $('keySave').addEventListener('click', saveKey);
  $('keyCancel').addEventListener('click', closeKeySheet);
  $('keyClear').addEventListener('click', async () => {
    await window.memo.aiKeyClear();
    toast('저장된 키를 삭제했어요');
    refreshKey();
  });
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveKey(); }
    if (e.key === 'Escape') { e.preventDefault(); closeKeySheet(); }
  });
  keySheet.addEventListener('mousedown', (e) => { if (e.target === keySheet) closeKeySheet(); });
  keySheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeKeySheet(); });
  $('aiBtn').addEventListener('click', summarize);

  /* ───────── find in note (⌘F) ───────── */

  const findBar = $('findBar');
  const findInput = $('findInput');
  let findHits = [];
  let findIdx = -1;
  let findTimer = null;
  const findOpen = () => findBar.classList.contains('open');

  function openFind(query) {
    const sel = input.value.slice(input.selectionStart, input.selectionEnd);
    if (query !== undefined) findInput.value = query;
    else if (sel && !sel.includes('\n') && sel.length < 80) findInput.value = sel;
    findBar.classList.add('open');
    findInput.focus();
    findInput.select();
    runFind(true);
  }

  function closeFind(refocus = true) {
    if (!findOpen()) return;
    findBar.classList.remove('open');
    findHits = [];
    findIdx = -1;
    editor.setHits([]);
    if (refocus) input.focus();
  }

  // `jump`: move to the match nearest the caret and select it.
  function runFind(jump) {
    const q = findInput.value.toLowerCase();
    findHits = [];
    if (q) {
      const text = editor.value.toLowerCase();
      for (let i = text.indexOf(q); i !== -1 && findHits.length < 2000; i = text.indexOf(q, i + q.length)) findHits.push(i);
    }
    if (!findHits.length) findIdx = -1;
    else if (jump || findIdx < 0 || findIdx >= findHits.length) {
      findIdx = findHits.findIndex((i) => i >= input.selectionStart);
      if (findIdx < 0) findIdx = 0;
    }
    paintFind(jump);
  }

  function paintFind(select) {
    const q = findInput.value;
    editor.setHits(findHits.map((i) => [i, q.length]), findIdx);
    $('findCount').textContent = !q ? '' : findHits.length ? `${findIdx + 1}/${findHits.length}` : '없음';
    findBar.classList.toggle('miss', !!q && !findHits.length);
    if (select && findIdx >= 0) {
      const i = findHits[findIdx];
      input.setSelectionRange(i, i + q.length);  // the lamp and scroll follow the selection
      follow = true;
    }
  }

  function stepFind(d) {
    if (!findOpen()) return openFind();
    if (!findHits.length) return;
    findIdx = (findIdx + d + findHits.length) % findHits.length;
    paintFind(true);
  }

  findInput.addEventListener('input', () => runFind(true));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('findNext').addEventListener('click', () => stepFind(1));
  $('findPrev').addEventListener('click', () => stepFind(-1));
  $('findClose').addEventListener('click', () => closeFind());

  /* ───────── search all notes (⌘K) ───────── */

  const palette = $('palette');
  const pInput = $('paletteInput');
  const pList = $('paletteResults');
  let pItems = [];
  let pSel = 0;
  let pToken = 0;
  let pTimer = null;

  function openPalette() {
    palette.hidden = false;
    requestAnimationFrame(() => palette.classList.add('open'));
    pInput.value = '';
    pInput.focus();
    searchPalette();
  }

  function closePalette(refocus = true) {
    if (palette.hidden) return;
    palette.classList.remove('open');
    palette.hidden = true;
    if (refocus) input.focus();
  }

  async function searchPalette() {
    const q = pInput.value.trim();
    const token = ++pToken;
    let items;
    if (!q) {
      items = notes.slice(0, 8).map((n) => ({ ...n, snippets: [] }));
    } else {
      await saveNow(); // so what you just typed is searchable
      items = await window.memo.searchNotes(q);
      if (token !== pToken) return;
    }
    pItems = items;
    pSel = 0;
    $('paletteLabel').textContent = q ? `${items.length}개 회의록` : '최근 회의록';
    palette.querySelector('.palette').classList.toggle('none', !!q && !items.length);
    renderPalette();
  }

  function renderPalette() {
    const frag = document.createDocumentFragment();
    pItems.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'p-item' + (i === pSel ? ' sel' : '');
      li.setAttribute('role', 'option');
      const top = document.createElement('div');
      top.className = 'p-top';
      const t = document.createElement('span');
      t.className = 'p-title' + (it.title ? '' : ' untitled');
      t.textContent = it.title || '제목 없는 회의';
      const meta = document.createElement('span');
      meta.className = 'p-meta';
      const bits = [];
      if (it.folderId && folders.some((f) => f.id === it.folderId)) bits.push(folderName(it.folderId));
      bits.push(fmtListDate(it.updatedAt));
      if (it.count > 1) bits.push(`${it.count}곳`);
      meta.textContent = bits.join(' · ');
      top.append(t, meta);
      li.appendChild(top);
      const sn = it.snippets?.[0];
      if (sn) {
        const p = document.createElement('div');
        p.className = 'p-snip';
        const m = document.createElement('mark');
        m.textContent = sn.match;
        p.append(sn.before, m, sn.after);
        li.appendChild(p);
      }
      li.addEventListener('mousemove', () => { if (pSel !== i) { pSel = i; markSel(); } });
      li.addEventListener('click', () => choosePalette(i));
      frag.appendChild(li);
    });
    pList.replaceChildren(frag);
  }

  function markSel() {
    [...pList.children].forEach((li, i) => li.classList.toggle('sel', i === pSel));
    pList.children[pSel]?.scrollIntoView({ block: 'nearest' });
  }

  async function choosePalette(i) {
    const it = pItems[i];
    if (!it) return;
    const q = pInput.value.trim().split(/\s+/)[0] || '';
    closePalette(false);
    await openNote(it.id);
    const sn = it.snippets?.[0];
    if (sn) {
      input.focus();
      input.setSelectionRange(sn.offset, sn.offset + sn.length);
      follow = true;
      // Keep every match lit so ⌘G walks through them.
      openFind(q);
      input.setSelectionRange(sn.offset, sn.offset + sn.length);
      runFind(true);
    } else if (q) {
      titleEl.focus();
    }
  }

  pInput.addEventListener('input', () => {
    clearTimeout(pTimer);
    pTimer = setTimeout(searchPalette, 110);
  });
  pInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); pSel = Math.min(pItems.length - 1, pSel + 1); markSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pSel = Math.max(0, pSel - 1); markSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); choosePalette(pSel); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  palette.addEventListener('mousedown', (e) => { if (e.target === palette) closePalette(); });
  $('searchBtn').addEventListener('click', openPalette);

  /* ───────── controls & menu ───────── */

  function toggleLamp() {
    settings.lampOn = !settings.lampOn;
    applyLamp();
    persist();
    sound.play('back');
  }
  function toggleTheme() {
    settings.theme = settings.theme === 'light' ? 'dark' : 'light';
    applyTheme();
    persist();
  }
  function toggleSound() {
    settings.sound = !settings.sound;
    applySound();
    persist();
    if (settings.sound) sound.play('char');
  }
  function toggleSidebar() {
    settings.sidebar = !settings.sidebar;
    applySidebar();
    persist();
  }

  $('newNote').addEventListener('click', () => newNote());
  $('newFolder').addEventListener('click', newFolder);
  $('lampSwitch').addEventListener('click', toggleLamp);
  $('themeToggle').addEventListener('click', toggleTheme);
  $('soundToggle').addEventListener('click', toggleSound);
  $('toggleSidebar').addEventListener('click', toggleSidebar);
  $('sidebarHide').addEventListener('click', toggleSidebar);

  window.memo.onMenu(async (action) => {
    switch (action) {
      case 'new': return newNote();
      case 'new-folder': return newFolder();
      case 'search': return palette.hidden ? openPalette() : closePalette();
      case 'find': return openFind();
      case 'find-next': return stepFind(1);
      case 'find-prev': return stepFind(-1);
      case 'export': return exportNote();
      case 'delete': return current && deleteNote(current.id);
      case 'record': return toggleRecord();
      case 'timestamp': return insertTimestamp();
      case 'transcribe': return toggleTranscribe();
      case 'summarize': return summarize();
      case 'fold': return foldTranscript();
      case 'ai-key': return openKeySheet(false);
      case 'settings': return openSettings();
      case 'onboarding': return openOnboarding();
      case 'check-update': return checkUpdateNow();
      case 'play': return togglePlay();
      case 'sidebar': return toggleSidebar();
      case 'lamp': return toggleLamp();
      case 'theme': return toggleTheme();
      case 'sound': return toggleSound();
      case 'flush-and-close':
        try {
          if (recorder.active) await stopRecord();
          await drainTyping();
          await saveNow();
        } finally {
          window.memo.closeReady();
        }
        return undefined;
      default: return undefined;
    }
  });

  window.addEventListener('blur', () => { saveNow(); });

  /* ───────── settings ───────── */

  const settingsSheet = $('settingsSheet');

  function openSheet(el) {
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
  }
  function closeSheet(el) {
    el.classList.remove('open');
    el.hidden = true;
    input.focus();
  }

  function syncSettingsForm() {
    $('setFont').value = settings.fontSize;
    $('vFont').textContent = settings.fontSize;
    $('setRail').value = settings.railRatio;
    $('vRail').textContent = `${settings.railRatio}%`;
    $('setReading').checked = settings.readingLight !== false;
    $('setPointer').checked = settings.lightFollowsPointer !== false;
    $('setSound').checked = settings.sound;
    $('setVolume').value = Math.round(settings.volume * 100);
    $('vVolume').textContent = Math.round(settings.volume * 100);
    $('setLocale').value = settings.sttLocale;
    $('setAutoSummary').checked = !!settings.autoSummary;
    $('setRetranscribe').checked = settings.retranscribe !== false;
    $('setMotion').value = settings.motion;
    for (const b of $('setProfile').children) {
      const on = b.dataset.v === settings.soundProfile;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    ['setFont', 'setRail', 'setVolume'].forEach((id) => fill($(id)));
  }

  function openSettings() {
    syncSettingsForm();
    openSheet(settingsSheet);
  }

  const onSetting = (id, ev, fn) => $(id).addEventListener(ev, (e) => { fn(e.target); syncSettingsForm(); persist(); });
  onSetting('setFont', 'input', (el) => { settings.fontSize = Number(el.value); applyPaper(); });
  onSetting('setRail', 'input', (el) => { settings.railRatio = Number(el.value); applyPaper(); });
  onSetting('setReading', 'change', (el) => { settings.readingLight = el.checked; });
  onSetting('setPointer', 'change', (el) => { settings.lightFollowsPointer = el.checked; });
  onSetting('setSound', 'change', (el) => { settings.sound = el.checked; applySound(); if (el.checked) sound.play('char'); });
  onSetting('setVolume', 'input', (el) => { settings.volume = Number(el.value) / 100; applySound(); });
  $('setVolume').addEventListener('change', () => sound.play('char'));
  onSetting('setLocale', 'change', (el) => { settings.sttLocale = el.value; });
  onSetting('setAutoSummary', 'change', (el) => { settings.autoSummary = el.checked; });
  onSetting('setRetranscribe', 'change', (el) => { settings.retranscribe = el.checked; });
  onSetting('setMotion', 'change', (el) => { settings.motion = el.value; applyMotion(); });
  $('setProfile').addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v) return;
    settings.soundProfile = v;
    applySound();
    syncSettingsForm();
    persist();
    sound.play('char');
    setTimeout(() => sound.play('space'), 160);
  });
  $('setDone').addEventListener('click', () => closeSheet(settingsSheet));
  $('setKey').addEventListener('click', () => { closeSheet(settingsSheet); openKeySheet(false); });
  settingsSheet.addEventListener('mousedown', (e) => { if (e.target === settingsSheet) closeSheet(settingsSheet); });
  settingsSheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(settingsSheet); });

  /* ───────── first run ───────── */

  const onboard = $('onboard');
  let obStep = 0;

  function openOnboarding() {
    openSheet(onboard);
    showStep(0);
    $('obNext').focus();
  }

  function showStep(i) {
    obStep = i;
    onboard.querySelectorAll('.ob-step').forEach((el) => el.classList.toggle('on', Number(el.dataset.step) === i));
    onboard.querySelectorAll('.ob-dots i').forEach((el, k) => el.classList.toggle('on', k === i));
    $('obNext').textContent = i === 2 ? '시작하기' : '다음';
    $('obSkip').hidden = i === 2;
    if (i === 1) refreshPerms();
  }

  const PERM_TEXT = {
    granted: ['허용됨', 'ok'], authorized: ['허용됨', 'ok'],
    denied: ['거부됨 · 시스템 설정에서 바꿀 수 있어요', 'bad'], restricted: ['제한됨', 'bad'],
    'not-determined': ['아직 묻지 않음', ''], notDetermined: ['아직 묻지 않음', ''],
    missing: ['받아쓰기 도구 없음', 'bad'],
  };

  async function refreshPerms() {
    const [mic, speech] = await Promise.all([window.memo.micStatus(), window.memo.sttStatus()]);
    for (const [id, st] of [['obMic', mic], ['obSpeech', speech]]) {
      const [text, cls] = PERM_TEXT[st] || ['확인할 수 없음', ''];
      $(id).textContent = text;
      $(id).className = cls;
    }
    const done = mic === 'granted' && speech === 'authorized';
    $('obAllow').disabled = done;
    $('obAllow').textContent = done ? '모두 허용됐어요' : '권한 허용하기';
  }

  function finishOnboarding() {
    settings.onboarded = true;
    persist();
    closeSheet(onboard);
  }

  $('obAllow').addEventListener('click', async () => {
    $('obAllow').disabled = true;
    $('obAllow').textContent = '확인을 기다리는 중…';
    await window.memo.requestMic();
    await window.memo.sttAuthorize();
    refreshPerms();
  });
  $('obKey').addEventListener('click', () => { finishOnboarding(); openKeySheet(false); });
  $('obNext').addEventListener('click', () => (obStep === 2 ? finishOnboarding() : showStep(obStep + 1)));
  $('obSkip').addEventListener('click', finishOnboarding);
  onboard.addEventListener('keydown', (e) => { if (e.key === 'Escape') finishOnboarding(); });

  /* Paper fibres: short, soft strokes in random directions, drawn once into
   * a seamless tile (strokes crossing an edge are repeated on the far side). */
  function paintFibers() {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.lineCap = 'round';
    const rnd = (a, b) => a + Math.random() * (b - a);
    for (let i = 0; i < 160; i++) {
      const x = rnd(0, S);
      const y = rnd(0, S);
      const len = rnd(4, 15);
      const ang = rnd(0, Math.PI);
      const bend = rnd(-0.3, 0.3);
      const dark = Math.random() < 0.55;
      g.strokeStyle = dark
        ? `rgba(92, 70, 44, ${rnd(0.015, 0.035).toFixed(3)})`
        : `rgba(255, 253, 245, ${rnd(0.08, 0.16).toFixed(3)})`;
      g.lineWidth = rnd(0.3, 0.8);
      const ex = Math.cos(ang) * len;
      const ey = Math.sin(ang) * len;
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) {
          const sx = x + ox;
          const sy = y + oy;
          if (sx + len < 0 || sx - len > S || sy + len < 0 || sy - len > S) continue;
          g.beginPath();
          g.moveTo(sx - ex / 2, sy - ey / 2);
          g.quadraticCurveTo(sx - ey * bend, sy + ex * bend, sx + ex / 2, sy + ey / 2);
          g.stroke();
        }
      }
    }
    // a few tiny inclusions
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(80, 60, 38, ${rnd(0.05, 0.14).toFixed(3)})`;
      g.beginPath();
      g.arc(rnd(0, S), rnd(0, S), rnd(0.4, 1.2), 0, Math.PI * 2);
      g.fill();
    }
    root.style.setProperty('--paper-fibers', `url("${c.toDataURL('image/png')}")`);
  }

  /* ───────── updates ─────────
   * A newer GitHub release shows a small pill; "받기" downloads the DMG for
   * this Mac. Install by opening it and dragging Lamplight onto Applications. */
  let updateInfo = null;

  function showUpdate(info) {
    updateInfo = info;
    $('updateText').textContent = `새 버전 ${info.version}이 나왔어요`;
    $('updatePill').hidden = false;
  }

  async function checkUpdateNow() {
    const res = await window.memo.checkUpdate();
    if (res?.version && !res.upToDate) return showUpdate(res);
    if (res?.upToDate) toast(`최신 버전이에요 (${res.version})`);
    else if (res?.error === 'no-repo') toast('업데이트를 확인할 저장소가 설정되지 않았어요');
    else toast('업데이트를 확인하지 못했어요 · 인터넷 연결을 확인해 주세요');
    return undefined;
  }

  window.memo.onUpdate(showUpdate);
  $('updateGet').addEventListener('click', () => {
    if (updateInfo) window.memo.openUpdate(updateInfo.download);
    $('updatePill').hidden = true;
    toast('받은 DMG를 열어 Lamplight를 Applications로 끌어 놓으면 업데이트돼요', 6000);
  });
  $('updateLater').addEventListener('click', () => { $('updatePill').hidden = true; });

  /* ───────── boot ───────── */

  async function init() {
    paintFibers();
    applyTheme();
    applyPaper();
    applyMotion();
    applySound();
    applySidebar();
    applyKnobs();
    applyTranscribe();
    lamp.on = !settings.lampOn; // so applyLamp() runs the warm-up flicker on launch
    lamp.power = 0;
    applyLamp();

    const recovered = await window.memo.recoverAudio().catch(() => []);
    [notes, folders] = await Promise.all([window.memo.listNotes(), window.memo.listFolders()]);
    if (notes.length) await openNote(notes[0].id);
    else await newNote();
    if (recovered.length) {
      toast(`중단됐던 녹음 ${recovered.length}개를 복구했습니다`, 4200);
    }
    requestAnimationFrame(frame);
    if (!settings.onboarded) setTimeout(openOnboarding, 900);
  }

  document.fonts.ready.then(init);
})();
