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

  const LINE_GAP = 50;      // caret line bottom sits this far above the rail
  const LAMP_OFFSET = 52;   // lamp rides just to the right of the caret
  const BELL_AT = 0.86;     // ring the margin bell near the end of a line

  const { previewOf, sortNotes, mdToHtml, renumberList } = window.LampShared;
  const sound = new TypeSound();
  const editor = new InkEditor(input, $('mirror'));
  const titleInk = new InkEditor(titleEl, $('titleMirror'));
  const titleMirror = $('titleMirror');
  const lamp = new LampScene({ desk, shade: $('shade'), glow: $('glow'), rail: $('rail'), lamp: lampEl });

  /* ───────── settings ───────── */

  const SETTINGS_KEY = 'lamplight.settings';
  const settings = {
    intensity: 150, spread: 112, reach: 120,
    lampOn: true, theme: 'dark', sound: true, volume: 0.7, sidebar: true, looseCollapsed: false,
    fontSize: 17, railRatio: 60, readingLight: true, soundProfile: 'classic',
    motion: 'system', onboarded: false, aiProvider: 'chatgpt', sortBy: 'updated', paperFont: 'typewriter',
  };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch {}
  const persist = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

  /* 'system' follows macOS: the window's theme source is set to system and
   * the main process reports whether that's dark right now. */
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => body.classList.contains('dark');

  function paintTheme(dark) {
    body.classList.toggle('dark', dark);
    body.classList.toggle('light', !dark);
    lamp.setDark(dark);
  }

  async function applyTheme() {
    if (settings.theme === 'system') {
      paintTheme(await window.memo.setTheme('system'));
    } else {
      const dark = settings.theme !== 'light';
      paintTheme(dark);
      window.memo.setTheme(dark ? 'dark' : 'light');
    }
  }
  darkQuery.addEventListener('change', (e) => { if (settings.theme === 'system') paintTheme(e.matches); });

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

  /* The writing font (fonts.css). Its faces are loaded before switching so
   * the textarea and the mirror change over in the same frame. */
  const PAPER_FONTS = {
    typewriter: null,
    'kopub-batang': 'Lamp KoPub Batang',
    'kopub-dotum': 'Lamp KoPub Dotum',
    lineseed: 'Lamp LINE Seed',
    maruburi: 'Lamp MaruBuri',
  };
  async function applyFont() {
    if (!(settings.paperFont in PAPER_FONTS)) settings.paperFont = 'typewriter';
    const family = PAPER_FONTS[settings.paperFont];
    const want = settings.paperFont;
    if (family) {
      try {
        await Promise.all([
          document.fonts.load(`400 17px "${family}"`, '가A'),
          document.fonts.load(`700 17px "${family}"`, '가A'),
        ]);
      } catch {}
      if (settings.paperFont !== want) return; // picked another one meanwhile
    }
    body.dataset.font = want;
    lastH = 0; // re-lay the rail and follow the caret's new position
    snap = true;
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
  const fullText = () => editor.value;
  const plainText = () => fullText().replace(MARKS_RE, '');
  let dirty = false;
  let saveTimer = null;

  const summary = (n) => ({
    id: n.id,
    title: n.title || '',
    createdAt: n.createdAt,
    updatedAt: n.updatedAt || Date.now(),
    folderId: n.folderId || null,
    pinned: !!n.pinned,
    preview: previewOf(n.body),
  });

  const DEL_ICON = '<svg viewBox="0 0 20 20"><path d="M5 6h10M8 6V4.5h4V6M6.5 6l.7 9.5h5.6l.7-9.5"/></svg>';

  const FOLDER_ICON = '<svg viewBox="0 0 20 20"><path d="M2.8 6.2V15a1.2 1.2 0 0 0 1.2 1.2h12a1.2 1.2 0 0 0 1.2-1.2V8.2A1.2 1.2 0 0 0 16 7H9.6L8 5H4a1.2 1.2 0 0 0-1.2 1.2z"/></svg>';
  const CHEV_ICON = '<svg viewBox="0 0 12 12"><path d="M3.5 4.6 6 7.1l2.5-2.5"/></svg>';
  const PIN_ICON = '<svg viewBox="0 0 12 12"><path d="M4 1h4l-.6 3.4L9.5 6.5v1H6.5V11L6 11.5 5.5 11V7.5h-3v-1l2.1-2.1z"/></svg>';
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
    t.textContent = n.title || '제목 없는 노트';

    const meta = document.createElement('div');
    meta.className = 'note-meta';
    if (n.pinned) {
      const pin = document.createElement('span');
      pin.className = 'pin';
      pin.title = '고정됨';
      pin.innerHTML = PIN_ICON;
      meta.appendChild(pin);
    }
    const d = document.createElement('span');
    d.textContent = fmtListDate(n.updatedAt);
    meta.appendChild(d);

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
    add.title = '이 폴더에 새 노트';
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
    const sorted = sortNotes(notes, settings.sortBy);
    if (!folders.length) {
      sorted.forEach((n) => frag.appendChild(noteItem(n)));
    } else {
      const groups = new Map(folders.map((f) => [f.id, []]));
      const loose = [];
      for (const n of sorted) {
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
    const ok = await window.memo.confirm({
      message: `'${f.name}' 폴더를 삭제할까요?`,
      detail: inside.length ? `안에 있는 노트 ${inside.length}개는 미분류로 옮겨집니다.` : '',
      confirm: '폴더 삭제',
    });
    if (!ok) return;
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
      { id: 'pin', label: n.pinned ? '고정 해제' : '맨 위에 고정' },
      { type: 'separator' },
      { id: 'delete', label: '휴지통으로 이동' },
    ]);
    if (!pick) return;
    if (pick === 'open') openNote(n.id);
    else if (pick === 'pin') pinNote(n.id, !n.pinned);
    else if (pick === 'delete') deleteNote(n.id);
    else if (pick === 'new-folder-move') {
      await newFolder();
      const f = folders[folders.length - 1];
      await moveNote(n.id, f.id);
    } else if (pick.startsWith('move:')) moveNote(n.id, pick.slice(5) || null);
  }

  async function folderMenu(id) {
    const items = [{ id: 'new-note', label: '새 노트' }];
    if (id) items.push({ id: 'rename', label: '이름 변경' }, { type: 'separator' }, { id: 'delete', label: '폴더 삭제' });
    const pick = await window.memo.contextMenu(items);
    if (pick === 'new-note') newNote(id);
    else if (pick === 'rename') renameFolder(id);
    else if (pick === 'delete') deleteFolder(id);
  }

  async function pinNote(id, pinned) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    if (current?.id === id) { await saveNow(); current.pinned = pinned; }
    await window.memo.setNotePinned(id, pinned);
    n.pinned = pinned;
    renderList();
    toast(pinned ? '맨 위에 고정했어요' : '고정을 풀었어요');
  }

  const SORT_LABELS = { updated: '수정한 날짜', created: '만든 날짜', title: '제목' };

  noteList.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const pick = await window.memo.contextMenu([
      { id: 'new-folder', label: '새 폴더' },
      { id: 'new-note', label: '새 노트' },
      { type: 'separator' },
      {
        label: '정렬',
        submenu: Object.entries(SORT_LABELS).map(([v, label]) => ({ id: `sort:${v}`, label, checked: settings.sortBy === v })),
      },
    ]);
    if (pick === 'new-folder') newFolder();
    else if (pick === 'new-note') newNote(null);
    else if (pick?.startsWith('sort:')) {
      settings.sortBy = pick.slice(5);
      persist();
      renderList();
    }
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
    await saveNow();
    const note = preloaded || (await window.memo.loadNote(id));
    if (!note) return;
    current = note;

    titleInk.setText(note.title || '');
    attendeesEl.value = note.attendees || '';
    dateEl.textContent = fmtLongDate(note.createdAt);
    editor.setText(note.body || '');
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
    const n = notes.find((x) => x.id === id);
    const name = n?.title || '제목 없는 노트';
    const ok = await window.memo.confirm({
      message: `'${name}' 노트를 휴지통으로 옮길까요?`,
      detail: 'Finder의 휴지통에서 되살릴 수 있어요.',
      confirm: '휴지통으로 이동',
    });
    if (!ok) return;
    if (current?.id === id) { clearTimeout(saveTimer); dirty = false; }
    await window.memo.deleteNote(id);
    notes = notes.filter((x) => x.id !== id);
    if (current?.id === id) {
      current = null;
      if (notes.length) await openNote(sortNotes(notes, settings.sortBy)[0].id);
      else await newNote();
    } else {
      renderList();
    }
    toast('휴지통으로 옮겼습니다');
  }

  // The note as Markdown: title, date · people, then the body as written.
  function noteMarkdown() {
    const meta = [fmtLongDate(current.createdAt), current.attendees].filter(Boolean).join(' · ');
    return `# ${current.title || '제목 없는 노트'}\n\n${meta}\n\n---\n\n${plainText()}\n`;
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
    // Only this row's title changes; the rest of the list stays as it is.
    const s = notes.find((n) => n.id === current.id);
    if (!s) return;
    s.title = current.title;
    const row = noteList.querySelector(`.note[data-id="${current.id}"] .note-title`);
    if (!row || settings.sortBy === 'title') { renderList(); return; }
    row.textContent = s.title || '제목 없는 노트';
    row.classList.toggle('untitled', !s.title);
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

  /* Ordered lists keep counting (see renumberList in shared.js); the rewrite
   * goes through execCommand so it's one undo step. */
  const ITEM_RE = window.LampShared.ITEM_RE;

  function renumber(at) {
    const r = renumberList(input.value, at, input.selectionStart);
    if (!r) return;
    applyingMarker = true;
    try {
      input.setSelectionRange(r.start, r.end);
      document.execCommand('insertText', false, r.text);
      input.setSelectionRange(r.caret, r.caret);
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

  editor.onChange((edit) => {
    current.body = editor.value;
    scheduleSave();
    updateCounter();
    follow = true;

    if (findOpen()) {
      clearTimeout(findTimer);
      findTimer = setTimeout(() => runFind(false), 120);
    }

    if (!applyingMarker) {
      if (edit.type === 'insert' && edit.inserted === '\n') {
        const nl = edit.index;
        queueMicrotask(() => continueList(nl));
      } else {
        autoMarker = null;
        if (edit.removedText.includes('\n') || edit.inserted.includes('\n')) {
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
    if (a === titleEl) return titleInk.caretRect();
    if (a === attendeesEl) return inputCaret(a);
    return editor.caretRect();
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

    lamp.setReading(settings.readingLight !== false && !follow);
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

  /* ───────── export ─────────
   * Save the note as it is (PDF / Markdown), or have ChatGPT (or Claude)
   * reshape it first — tidy minutes, a report, an email, a one-pager, a to-do
   * list, a talk outline, or anything you ask — preview it, then save. */

  const keySheet = $('keySheet');
  const keyInput = $('keyInput');
  const keyStatusEl = $('keyStatus');
  const exportSheet = $('exportSheet');
  const preview = $('exportPreview');
  let exportAfterKey = false;
  let generating = false;
  let exportKind = 'plain';
  let exportDocs = {};       // kind → markdown (for this note, while the sheet is open)
  let streamBuf = '';
  let renderTimer = null;

  const providerName = (p) => (p === 'chatgpt' ? 'ChatGPT' : 'Claude');

  const KINDS = {
    minutes: '정리된 회의록으로 바꿔 주세요. 구성: "## 개요"(2~3문장), "## 논의 내용"(주제별 목록), "## 결정 사항"(번호 목록), "## 할 일"(체크박스 목록, "담당: 내용 (기한)").',
    report: '보고서로 바꿔 주세요. 구성: 맨 위 한 줄 제목(#), "## 요약", "## 배경", "## 주요 내용", "## 결론 및 다음 단계". 문장은 보고서 문체(~함, ~임)로.',
    email: '업무 이메일 초안으로 바꿔 주세요. 첫 줄은 "**제목:** …", 그다음 인사, 핵심 내용(필요하면 목록), 요청 사항, 맺음말 순서로. 정중하고 간결하게.',
    summary: '한 장 요약으로 바꿔 주세요. 맨 위에 한 줄 결론(굵게), 그 아래 핵심 3~5개 목록, 마지막에 "## 다음 단계" 목록.',
    todo: '할 일 목록으로 바꿔 주세요. 모든 실행 항목을 "- [ ] 담당: 할 일 (기한)" 형식의 체크박스로, 주제별 "##" 소제목으로 묶어 주세요. 담당이나 기한을 모르면 생략.',
    slides: '발표 개요로 바꿔 주세요. 슬라이드마다 "## 1. 제목" 형식의 소제목과 그 아래 핵심 목록 3개 이내. 6~10장.',
  };

  const SYSTEM_EXPORT = `당신은 필기를 깔끔한 문서로 다듬는 편집자입니다. 사용자가 노트(제목, 날짜, 참석자, 본문)를 주고 원하는 결과물 형식을 알려줍니다.
- 한국어로 씁니다(사용자 요청이 다른 언어면 그 언어로).
- 결과는 Markdown으로만 씁니다: # / ## / ### 제목, 목록(- , 1. ), 체크박스(- [ ] ), **굵게**, > 인용, --- 구분선. 표와 HTML은 쓰지 않습니다.
- 노트에 없는 사실은 만들지 않습니다. 모르는 담당자·기한은 비워 둡니다.
- 결과물만 쓰고, 앞뒤 설명이나 인사는 붙이지 않습니다.`;

  function showDoc(md) {
    preview.innerHTML = mdToHtml(md);
  }

  function setKind(kind) {
    exportKind = kind;
    exportSheet.querySelectorAll('.export-opt').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
    $('exportCustom').hidden = kind !== 'custom';
    if (kind === 'plain') { showDoc(exportDocs.plain); setStatus(''); return; }
    if (exportDocs[kind]) { showDoc(exportDocs[kind]); setStatus(`${providerName(settings.aiProvider)}로 만든 결과예요`); return; }
    if (kind === 'custom') { preview.innerHTML = '<p class="hint">원하는 결과물을 적고 "만들기"를 누르세요.</p>'; setStatus(''); $('exportPrompt').focus(); return; }
    generate(kind);
  }

  function setStatus(text, busy = false) {
    $('exportStatus').textContent = text;
    exportSheet.classList.toggle('busy', busy);
    $('exportStop').hidden = !busy;
  }

  async function aiReady() {
    return settings.aiProvider === 'claude'
      ? (await window.memo.aiKeyStatus()).hasKey
      : (await window.memo.gptStatus()).signedIn;
  }

  async function generate(kind) {
    if (generating) return;
    if (!(await aiReady())) {
      exportAfterKey = kind;
      openKeySheet(true);
      return;
    }
    const ask = kind === 'custom' ? $('exportPrompt').value.trim() : KINDS[kind];
    if (!ask) return;
    generating = kind;
    streamBuf = '';
    preview.innerHTML = '<p class="hint">정리하는 중…</p>';
    setStatus(`${providerName(settings.aiProvider)}가 만드는 중…`, true);
    const ok = await window.memo.aiGenerate({
      provider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt',
      system: SYSTEM_EXPORT,
      prompt: `${ask}\n\n--- 노트 ---\n${noteMarkdown()}`,
    });
    if (!ok && generating) generating = false;
  }

  window.memo.onAi((ev) => {
    if (!generating) return;
    if (ev.type === 'delta') {
      streamBuf += ev.text;
      clearTimeout(renderTimer);
      renderTimer = setTimeout(() => showDoc(streamBuf), 60);
    } else if (ev.type === 'done') {
      clearTimeout(renderTimer);
      exportDocs[generating] = streamBuf;
      if (exportKind === generating) showDoc(streamBuf);
      generating = false;
      setStatus(ev.stopReason === 'max_tokens' ? '결과가 길어 중간에 끊겼어요' : `${providerName(settings.aiProvider)}로 만든 결과예요`);
    } else if (ev.type === 'error') {
      generating = false;
      const msg = {
        auth: 'API 키를 확인해 주세요',
        rate: '요청이 많아요 · 잠시 후 다시 시도해 주세요',
        network: '인터넷 연결을 확인해 주세요',
        server: '서버가 응답하지 않아요 · 잠시 후 다시 시도해 주세요',
        aborted: '멈췄어요',
        'gpt-limit': 'ChatGPT 사용 한도에 도달했어요 · 한도가 풀리면 다시 시도해 주세요',
        'gpt-unavailable': '이 계정에서는 ChatGPT 구독으로 쓸 수 없어요 (Plus · Pro 필요)',
        'gpt-login': 'ChatGPT에 다시 로그인해 주세요',
      }[ev.code] || '만들지 못했어요';
      setStatus(msg);
      if (exportKind !== 'plain' && !exportDocs[exportKind]) preview.innerHTML = `<p class="hint">${msg}</p>`;
      if (ev.code === 'auth' || ev.code === 'gpt-login') openKeySheet(false);
    }
  });

  async function openExport() {
    if (!current) return;
    await saveNow();
    exportDocs = { plain: noteMarkdown() };
    exportSheet.hidden = false;
    requestAnimationFrame(() => exportSheet.classList.add('open'));
    const st = settings.aiProvider === 'claude' ? await window.memo.aiKeyStatus() : await window.memo.gptStatus();
    $('exportWho').textContent = settings.aiProvider === 'claude'
      ? (st.hasKey ? 'Claude API로 다듬어요' : 'AI 연결이 필요해요')
      : (st.signedIn ? `ChatGPT · ${st.email || '연결됨'}` : 'ChatGPT 연결이 필요해요');
    setKind('plain');
  }

  function closeExport() {
    if (generating) window.memo.aiCancel();
    exportSheet.classList.remove('open');
    exportSheet.hidden = true;
    input.focus();
  }

  const docName = () => (current.title || '노트').replace(/[\\/:*?"<>|]/g, ' ').trim()
    + (exportKind === 'plain' ? '' : ` - ${exportSheet.querySelector(`.export-opt[data-kind="${exportKind}"] b`)?.textContent || '정리본'}`);
  const currentDoc = () => exportDocs[exportKind];

  exportSheet.querySelectorAll('.export-opt').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
  $('exportRun').addEventListener('click', () => { delete exportDocs.custom; generate('custom'); });
  $('exportPrompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('exportRun').click(); }
  });
  $('exportStop').addEventListener('click', () => window.memo.aiCancel());
  $('exportRedo').addEventListener('click', () => {
    if (exportKind === 'plain' || generating) return;
    delete exportDocs[exportKind];
    generate(exportKind);
  });
  $('exportCopy').addEventListener('click', async () => {
    if (!currentDoc()) return;
    await navigator.clipboard.writeText(currentDoc());
    toast('Markdown으로 복사했어요');
  });
  $('exportMd').addEventListener('click', async () => {
    if (!currentDoc()) return;
    const p = await window.memo.exportNote({ name: docName(), content: currentDoc() });
    if (p) toast('Markdown으로 저장했어요');
  });
  $('exportPdf').addEventListener('click', async () => {
    if (!currentDoc()) return;
    setStatus('PDF를 만드는 중…', true);
    $('exportStop').hidden = true;
    const p = await window.memo.exportPdf({ name: docName(), title: current.title || '노트', html: mdToHtml(currentDoc()) });
    setStatus(p ? 'PDF로 저장했어요' : '');
    if (p) toast('PDF로 저장했어요');
  });
  $('exportClose').addEventListener('click', closeExport);
  exportSheet.addEventListener('mousedown', (e) => { if (e.target === exportSheet) closeExport(); });
  exportSheet.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.activeElement !== $('exportPrompt')) closeExport(); });
  $('exportBtn').addEventListener('click', openExport);

  /* The AI sheet: pick ChatGPT (sign in, plan usage) or Claude (API key). */
  function showProvider(p) {
    for (const btn of $('aiProvider').children) {
      const on = btn.dataset.v === p;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
    }
    keySheet.querySelectorAll('.ai-pane').forEach((el) => el.classList.toggle('on', el.dataset.pane === p));
    $('aiNote').textContent = p === 'chatgpt'
      ? '로그인 정보는 macOS 키체인으로 암호화해 이 Mac에만 저장돼요. 다듬을 때만 노트 내용이 OpenAI로 전송되고, ChatGPT 구독 한도에서 차감돼요.'
      : '키는 macOS 키체인으로 암호화해 이 Mac에만 저장돼요. 다듬을 때만 노트 내용이 Anthropic으로 전송되고, API 사용량만큼 요금이 나가요.';
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
    if (!thenSummarize) exportAfterKey = false;
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
    if (exportAfterKey) { const k = exportAfterKey; exportAfterKey = false; closeKeySheet(); $('exportWho').textContent = `ChatGPT · ${res.email || '연결됨'}`; generate(k); }
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
    if (exportAfterKey) { const k = exportAfterKey; exportAfterKey = false; closeKeySheet(); $('exportWho').textContent = 'Claude API로 다듬어요'; generate(k); } else refreshKey();
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
    $('paletteLabel').textContent = q ? `${items.length}개 노트` : '최근 노트';
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
      t.textContent = it.title || '제목 없는 노트';
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
    // From 'system' this picks the opposite of what's showing, explicitly.
    settings.theme = isDark() ? 'light' : 'dark';
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
      case 'export': return openExport();
      case 'delete': return current && deleteNote(current.id);
      case 'timestamp': {
        const d = new Date();
        input.focus();
        // Bracketed, so the editor and PDF ink it like any other timestamp.
        editor.insert(`[${pad(d.getHours())}:${pad(d.getMinutes())}] `);
        return sound.play('char');
      }
      case 'backup': return backupNotes();
      case 'restore': return restoreNotes();
      case 'ai-key': return openKeySheet(false);
      case 'settings': return openSettings();
      case 'onboarding': return openOnboarding();
      case 'check-update': return checkUpdateNow();
      case 'sidebar': return toggleSidebar();
      case 'lamp': return toggleLamp();
      case 'theme': return toggleTheme();
      case 'sound': return toggleSound();
      case 'flush-and-close':
        try {
          await saveNow();
        } finally {
          window.memo.closeReady();
        }
        return undefined;
      default: return undefined;
    }
  });

  window.addEventListener('blur', () => { saveNow(); });

  /* ───────── backup ───────── */

  async function backupNotes() {
    await saveNow();
    const res = await window.memo.backupExport();
    if (res) toast(`노트 ${res.count}개를 백업했어요`);
  }

  async function restoreNotes() {
    await saveNow();
    const res = await window.memo.backupImport();
    if (!res) return;
    if (res.error) { toast('Lamplight 백업 파일이 아니에요'); return; }
    [notes, folders] = await Promise.all([window.memo.listNotes(), window.memo.listFolders()]);
    renderList();
    toast(res.added
      ? `노트 ${res.added}개를 가져왔어요${res.skipped ? ` · 이미 있는 ${res.skipped}개는 건너뜀` : ''}`
      : '새로 가져올 노트가 없어요 (모두 이미 있어요)', 4000);
  }

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
    $('setTheme').value = settings.theme;
    $('setFamily').value = settings.paperFont;
    $('setFont').value = settings.fontSize;
    $('vFont').textContent = settings.fontSize;
    $('setRail').value = settings.railRatio;
    $('vRail').textContent = `${settings.railRatio}%`;
    $('setReading').checked = settings.readingLight !== false;
    $('setPointer').checked = settings.lightFollowsPointer !== false;
    $('setSound').checked = settings.sound;
    $('setVolume').value = Math.round(settings.volume * 100);
    $('vVolume').textContent = Math.round(settings.volume * 100);
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
  onSetting('setTheme', 'change', (el) => { settings.theme = el.value; applyTheme(); });
  onSetting('setFamily', 'change', (el) => { settings.paperFont = el.value; applyFont(); });
  onSetting('setFont', 'input', (el) => { settings.fontSize = Number(el.value); applyPaper(); });
  onSetting('setRail', 'input', (el) => { settings.railRatio = Number(el.value); applyPaper(); });
  onSetting('setReading', 'change', (el) => { settings.readingLight = el.checked; });
  onSetting('setPointer', 'change', (el) => { settings.lightFollowsPointer = el.checked; });
  onSetting('setSound', 'change', (el) => { settings.sound = el.checked; applySound(); if (el.checked) sound.play('char'); });
  onSetting('setVolume', 'input', (el) => { settings.volume = Number(el.value) / 100; applySound(); });
  $('setVolume').addEventListener('change', () => sound.play('char'));
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
  const LAST_STEP = 1;

  function openOnboarding() {
    openSheet(onboard);
    showStep(0);
    $('obNext').focus();
  }

  function showStep(i) {
    obStep = i;
    onboard.querySelectorAll('.ob-step').forEach((el) => el.classList.toggle('on', Number(el.dataset.step) === i));
    onboard.querySelectorAll('.ob-dots i').forEach((el, k) => el.classList.toggle('on', k === i));
    $('obNext').textContent = i === LAST_STEP ? '시작하기' : '다음';
    $('obSkip').hidden = i === LAST_STEP;
  }

  function finishOnboarding() {
    settings.onboarded = true;
    persist();
    closeSheet(onboard);
  }

  $('obKey').addEventListener('click', () => { finishOnboarding(); openKeySheet(false); });
  $('obNext').addEventListener('click', () => (obStep === LAST_STEP ? finishOnboarding() : showStep(obStep + 1)));
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
    await applyFont();
    applyMotion();
    applySound();
    applySidebar();
    applyKnobs();
    lamp.on = !settings.lampOn; // so applyLamp() runs the warm-up flicker on launch
    lamp.power = 0;
    applyLamp();

    [notes, folders] = await Promise.all([window.memo.listNotes(), window.memo.listFolders()]);
    if (notes.length) await openNote(sortNotes(notes, settings.sortBy)[0].id);
    else await newNote();
    requestAnimationFrame(frame);
    if (!settings.onboarded) setTimeout(openOnboarding, 900);
  }

  document.fonts.ready.then(init);
})();
