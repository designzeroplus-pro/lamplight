const {
  app, BrowserWindow, ipcMain, nativeTheme, shell, dialog,
  systemPreferences, session, Menu, screen, ShareMenu,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const ai = require('./ai');
const chatgpt = require('./chatgpt');
const { previewOf, isNewer } = require('./src/shared');

let win = null;
let readyToClose = false;
let quitting = false;

const notesRoot = () => path.join(app.getPath('userData'), 'notes');
const foldersFile = () => path.join(app.getPath('userData'), 'folders.json');
const FOLDER_ID = /^f-[a-z0-9]{6,24}$/;
const cleanFolderId = (v) => (typeof v === 'string' && FOLDER_ID.test(v) ? v : null);

function noteDir(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{6,64}$/i.test(id)) throw new Error('invalid note id');
  return path.join(notesRoot(), id);
}

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJSON(file, data) {
  // A unique temp name, so two saves of the same file can't trip over each other.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function newId() {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, '');
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

/* ───────────── notes ───────────── */

/* The sidebar list comes from index.json. Each launch only stats the note
 * files and re-reads the ones whose mtime changed, so hundreds of notes
 * don't mean hundreds of JSON parses. */
const indexFile = () => path.join(app.getPath('userData'), 'index.json');
let noteIndex = null; // Map id → { summary, m }

async function statMs(file) {
  try { return (await fs.stat(file)).mtimeMs; } catch { return 0; }
}

async function summarize(id) {
  const dir = path.join(notesRoot(), id);
  const note = await readJSON(path.join(dir, 'note.json'), null);
  if (!note) return null;
  return {
    id: note.id,
    title: note.title || '',
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    folderId: cleanFolderId(note.folderId),
    pinned: !!note.pinned,
    preview: previewOf(note.body),
  };
}

/* Parsed notes for full-text search, re-read only when the file's mtime changes. */
const noteCache = new Map(); // id → { m, note }

async function readNoteCached(id) {
  const file = path.join(notesRoot(), id, 'note.json');
  const m = await statMs(file);
  const hit = noteCache.get(id);
  if (hit && hit.m === m) return hit.note;
  const note = await readJSON(file, null);
  noteCache.set(id, { m, note });
  return note;
}

ipcMain.handle('notes:list', async () => {
  await fs.mkdir(notesRoot(), { recursive: true });
  if (!noteIndex) {
    const saved = await readJSON(indexFile(), {});
    noteIndex = new Map(Object.entries(saved && typeof saved === 'object' ? saved : {}));
  }
  const ids = (await fs.readdir(notesRoot(), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^[a-z0-9-]{6,64}$/i.test(e.name))
    .map((e) => e.name);
  let changed = false;
  await Promise.all(ids.map(async (id) => {
    const dir = path.join(notesRoot(), id);
    const m = String(await statMs(path.join(dir, 'note.json')));
    if (noteIndex.get(id)?.m === m) return;
    noteIndex.set(id, { summary: await summarize(id), m });
    changed = true;
  }));
  const live = new Set(ids);
  for (const id of noteIndex.keys()) if (!live.has(id)) { noteIndex.delete(id); changed = true; }
  if (changed) writeJSON(indexFile(), Object.fromEntries(noteIndex)).catch(() => {});
  return [...noteIndex.values()].map((v) => v.summary).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
});

/* Full-text search across every note. All terms must appear (AND); results
 * carry up to three body snippets with offsets so the editor can jump there. */
ipcMain.handle('notes:search', async (_e, q) => {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return [];
  let dirs = [];
  try { dirs = await fs.readdir(notesRoot(), { withFileTypes: true }); } catch { return []; }
  const live = new Set(dirs.map((d) => d.name));
  for (const id of noteCache.keys()) if (!live.has(id)) noteCache.delete(id);
  const results = [];
  await Promise.all(dirs.filter((d) => d.isDirectory() && /^[a-z0-9-]{6,64}$/i.test(d.name)).map(async (d) => {
    const note = await readNoteCached(d.name);
    if (!note) return;
    const title = note.title || '';
    const body = note.body || '';
    const hay = `${title}\n${note.attendees || ''}\n${body}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return;

    const lower = body.toLowerCase();
    const term = terms[0];
    const snippets = [];
    let count = 0;
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + term.length)) {
      count++;
      if (snippets.length < 3) {
        const a = Math.max(0, i - 28);
        const b = Math.min(body.length, i + term.length + 60);
        snippets.push({
          offset: i,
          length: term.length,
          before: (a > 0 ? '…' : '') + body.slice(a, i).replace(/\s+/g, ' '),
          match: body.slice(i, i + term.length),
          after: body.slice(i + term.length, b).replace(/\s+/g, ' ') + (b < body.length ? '…' : ''),
        });
      }
    }
    const inTitle = title.toLowerCase().includes(term);
    results.push({
      id: note.id,
      title,
      folderId: cleanFolderId(note.folderId),
      updatedAt: note.updatedAt,
      inTitle,
      count,
      snippets,
      score: (inTitle ? 100 : 0) + Math.min(count, 20),
    });
  }));
  return results.sort((x, y) => y.score - x.score || y.updatedAt - x.updatedAt).slice(0, 40);
});

ipcMain.handle('notes:create', async (_e, folderId) => {
  const now = Date.now();
  const note = {
    id: newId(), title: '', attendees: '', body: '', folderId: cleanFolderId(folderId), createdAt: now, updatedAt: now,
  };
  await fs.mkdir(noteDir(note.id), { recursive: true });
  await writeJSON(path.join(noteDir(note.id), 'note.json'), note);
  return note;
});

ipcMain.handle('notes:load', async (_e, id) => {
  const dir = noteDir(id);
  const note = await readJSON(path.join(dir, 'note.json'), null);
  if (!note) return null;
  return note;
});

ipcMain.handle('notes:save', async (_e, note) => {
  const dir = noteDir(note.id);
  await fs.mkdir(dir, { recursive: true });
  const { id, title, attendees, body, folderId, pinned, createdAt } = note;
  await writeJSON(path.join(dir, 'note.json'), {
    id, title: String(title || ''), attendees: String(attendees || ''), body: String(body || ''),
    folderId: cleanFolderId(folderId), pinned: !!pinned, createdAt, updatedAt: Date.now(),
  });
  return true;
});

ipcMain.handle('notes:set-pinned', async (_e, id, pinned) => {
  const file = path.join(noteDir(id), 'note.json');
  const note = await readJSON(file, null);
  if (!note) return false;
  note.pinned = !!pinned;
  await writeJSON(file, note);
  return true;
});

ipcMain.handle('notes:set-folder', async (_e, id, folderId) => {
  const file = path.join(noteDir(id), 'note.json');
  const note = await readJSON(file, null);
  if (!note) return false;
  note.folderId = cleanFolderId(folderId);
  await writeJSON(file, note);
  return true;
});

/* ───────────── folders ───────────── */

ipcMain.handle('folders:list', () => readJSON(foldersFile(), []));

ipcMain.handle('folders:save', async (_e, folders) => {
  const clean = (Array.isArray(folders) ? folders : [])
    .filter((f) => cleanFolderId(f?.id))
    .map((f) => ({
      id: f.id,
      name: String(f.name || '').slice(0, 60) || '새 폴더',
      collapsed: !!f.collapsed,
      createdAt: Number(f.createdAt) || Date.now(),
    }));
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await writeJSON(foldersFile(), clean);
  return true;
});

/* Native context menu. Resolves with the id of the picked item, or null. */
ipcMain.handle('context:menu', (e, items) => new Promise((resolve) => {
  const build = (list) => list.map((it) => {
    if (it.type === 'separator') return { type: 'separator' };
    return {
      label: String(it.label),
      enabled: it.enabled !== false,
      type: it.checked !== undefined ? 'checkbox' : 'normal',
      checked: !!it.checked,
      submenu: it.submenu ? build(it.submenu) : undefined,
      click: it.submenu ? undefined : () => resolve(it.id),
    };
  });
  Menu.buildFromTemplate(build(items)).popup({
    window: BrowserWindow.fromWebContents(e.sender),
    // Closing fires before a click on some versions; let the click win.
    callback: () => setTimeout(() => resolve(null), 120),
  });
}));

/* A native confirmation sheet. Resolves true when the first button is picked. */
ipcMain.handle('dialog:confirm', async (e, { message, detail, confirm }) => {
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
    type: 'warning',
    message: String(message || ''),
    detail: detail ? String(detail) : undefined,
    buttons: [String(confirm || '확인'), '취소'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
});

ipcMain.handle('notes:delete', async (_e, id) => {
  // Move to the macOS Trash so it can be restored.
  await shell.trashItem(noteDir(id));
  return true;
});

/* ───────────── export / theme / lifecycle ───────────── */

ipcMain.handle('export:note', async (_e, { name, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Markdown으로 내보내기',
    defaultPath: path.join(app.getPath('documents'), `${name || '노트'}.md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
});

/* PDF / PNG: the export preview's HTML is laid into print.html (same fonts
 * and document styles), rendered off-screen and cut to the paper itself —
 * each template is a window, a strip or a screen of its own size. */
const TEMPLATES = [
  'lt-lined', 'lt-kraft', 'lt-genko', 'lt-airmail', 'lt-birthday', 'lt-xmas', 'lt-spring', 'lt-autumn',
  'lt-thanks', 'lt-tape', 'lt-crayon', 'lt-wax', 'lt-gold',
  'notepad', 'mail', 'receipt', 'bbs', 'terminal', 'msgbox', 'desktop',
];

// Loads print.html with the document; returns the paper's size in CSS px.
async function layDocument(page, { tpl, title, html }) {
  await page.loadFile(path.join(__dirname, 'src', 'print.html'));
  return page.webContents.executeJavaScript(`(async () => {
    document.title = ${JSON.stringify(String(title || ''))};
    const doc = document.getElementById('doc');
    doc.dataset.template = ${JSON.stringify(tpl)};
    doc.innerHTML = ${JSON.stringify(String(html || ''))};
    await document.fonts.ready;
    const r = doc.getBoundingClientRect();
    const size = { w: Math.ceil(r.width), h: Math.ceil(r.height) + 1 };
    const style = document.createElement('style');
    style.textContent = '@page { size: ' + size.w + 'px ' + size.h + 'px; margin: 0; }';
    document.head.append(style);
    return size;
  })()`);
}

const templateOf = (t) => (TEMPLATES.includes(t) ? t : 'lt-lined');
// Export pages render in their own in-memory session, so nothing they do
// (zoom is remembered per origin) reaches the main window's file:// origin.
const EXPORT_PREFS = { sandbox: true, contextIsolation: true, partition: 'lamplight-export' };

ipcMain.handle('export:pdf', async (_e, { name, title, html, template }) => {
  const tpl = templateOf(template);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'PDF로 내보내기',
    defaultPath: path.join(app.getPath('documents'), `${name || '노트'}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  const page = new BrowserWindow({ show: false, webPreferences: EXPORT_PREFS });
  try {
    await layDocument(page, { tpl, title, html });
    const pdf = await page.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    await fs.writeFile(filePath, pdf);
    shell.showItemInFolder(filePath);
    return filePath;
  } finally {
    page.destroy();
  }
});

/* PNG of the paper alone, at 2× (the square desktop comes out at 1080 × 1080).
 * Rendered offscreen, so the window can be larger than the screen. The scale
 * is CSS zoom on this page only (webContents zoom is remembered per origin). */
async function renderPng(tpl, html) {
  const scale = tpl === 'desktop' ? 1080 / 480 : 2;
  const page = new BrowserWindow({
    show: false,
    width: 2400,
    height: 2400,
    useContentSize: true,
    webPreferences: { ...EXPORT_PREFS, offscreen: true },
  });
  try {
    const box = await layDocument(page, { tpl, html });
    // The paper moves to the top-left corner, then everything is scaled up.
    await page.webContents.executeJavaScript(`
      document.getElementById('doc').style.margin = '0';
      document.documentElement.style.zoom = '${scale}';`);
    const width = Math.round(box.w * scale);
    const height = Math.round((box.h - 1) * scale);
    page.setContentSize(Math.max(2400, width), Math.max(2400, height));
    await new Promise((r) => setTimeout(r, 300)); // let the resized frame paint
    return (await page.webContents.capturePage({ x: 0, y: 0, width, height })).toPNG();
  } finally {
    page.destroy();
  }
}

ipcMain.handle('export:png', async (_e, { name, html, template }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '이미지로 내보내기',
    defaultPath: path.join(app.getPath('pictures'), `${name || '노트'}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, await renderPng(templateOf(template), html));
  shell.showItemInFolder(filePath);
  return filePath;
});

/* 공유: the page as an image in a temporary folder, handed to the macOS
 * share menu (Messages, Mail, AirDrop, …). */
ipcMain.handle('export:share', async (_e, { name, html, template }) => {
  const dir = path.join(app.getPath('temp'), 'Lamplight');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${String(name || '편지').replace(/[\\/:*?"<>|]/g, ' ').trim() || '편지'}.png`);
  await fs.writeFile(file, await renderPng(templateOf(template), html));
  new ShareMenu({ filePaths: [file] }).popup({ browserWindow: win });
  return true;
});

ipcMain.handle('theme:set', (_e, source) => {
  nativeTheme.themeSource = ['dark', 'light', 'system'].includes(source) ? source : 'system';
  return nativeTheme.shouldUseDarkColors;
});

ipcMain.on('app:close-ready', () => {
  readyToClose = true;
  win?.close();
});

function sendMenu(action) {
  win?.webContents.send('menu', action);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '설정…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { label: 'AI 연결 (ChatGPT · Claude)…', click: () => sendMenu('ai-key') },
        { label: '처음 안내 다시 보기', click: () => sendMenu('onboarding') },
        { label: '업데이트 확인…', click: () => sendMenu('check-update') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '파일',
      submenu: [
        { label: '새 노트', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: '새 폴더', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendMenu('new-folder') },
        { label: '내보내기…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export') },
        { type: 'separator' },
        { label: '모든 노트 백업…', click: () => sendMenu('backup') },
        { label: '백업에서 가져오기…', click: () => sendMenu('restore') },
        { type: 'separator' },
        // ⌘⌫ is left to the text field (delete to line start).
        { label: '휴지통으로 이동', accelerator: 'CmdOrCtrl+Alt+Backspace', click: () => sendMenu('delete') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' },
        { role: 'delete' }, { role: 'selectAll' },
        { type: 'separator' },
        {
          label: '찾기',
          submenu: [
            { label: '찾기…', accelerator: 'CmdOrCtrl+F', click: () => sendMenu('find') },
            { label: '다음 찾기', accelerator: 'CmdOrCtrl+G', click: () => sendMenu('find-next') },
            { label: '이전 찾기', accelerator: 'CmdOrCtrl+Shift+G', click: () => sendMenu('find-prev') },
          ],
        },
        { label: '모든 노트 검색…', accelerator: 'CmdOrCtrl+K', click: () => sendMenu('search') },
        { type: 'separator' },
        { label: '지금 시각 적기', accelerator: 'CmdOrCtrl+T', click: () => sendMenu('timestamp') },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '사이드바', accelerator: 'CmdOrCtrl+\\', click: () => sendMenu('sidebar') },
        { label: '램프 켜기 / 끄기', accelerator: 'CmdOrCtrl+L', click: () => sendMenu('lamp') },
        { label: '밤 / 낮 전환', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendMenu('theme') },
        { label: '타자기 소리', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('sound') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* Window size and position survive restarts (if still on a connected screen). */
const windowFile = () => path.join(app.getPath('userData'), 'window.json');

function loadWindowState() {
  try {
    const s = JSON.parse(fsSync.readFileSync(windowFile(), 'utf8'));
    const area = screen.getDisplayMatching(s).workArea;
    const visible = s.x < area.x + area.width - 80 && s.x + s.width > area.x + 80
      && s.y < area.y + area.height - 40 && s.y + s.height > area.y;
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return {};
  }
}

function trackWindowState(w) {
  let timer = null;
  const save = () => {
    if (w.isDestroyed() || w.isFullScreen() || w.isMinimized()) return;
    const b = w.getNormalBounds();
    try { fsSync.writeFileSync(windowFile(), JSON.stringify({ ...b, maximized: w.isMaximized() })); } catch {}
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  w.on('resize', later);
  w.on('move', later);
  w.on('close', save);
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 880,
    ...(Number.isFinite(state.x) ? { x: state.x, y: state.y } : {}),
    minWidth: 860,
    minHeight: 620,
    title: 'Lamplight',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0e0d0c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (state.maximized) win.maximize();
  trackWindowState(win);
  win.once('ready-to-show', () => win.show());

  // Give the renderer a moment to flush unsaved text before closing.
  let closeTimer = null;
  win.on('close', (e) => {
    if (readyToClose) return;
    e.preventDefault();
    sendMenu('flush-and-close');
    clearTimeout(closeTimer);
    const w = win;
    closeTimer = setTimeout(() => { if (!w.isDestroyed()) { readyToClose = true; w.close(); } }, 10000);
  });
  win.on('closed', () => {
    clearTimeout(closeTimer);
    win = null;
    readyToClose = false;
    if (quitting) app.quit();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

ai.register();
chatgpt.register();

/* Updates. macOS only lets a signed app replace itself, and these builds are
 * unsigned, so instead of installing silently we look for a newer release on
 * GitHub and offer the right DMG for this Mac. */
const pkg = require('./package.json');

function repoSlug() {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  const m = String(url).match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function checkForUpdates() {
  const slug = repoSlug();
  if (!slug) return { error: 'no-repo' };
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Lamplight' },
    });
    if (res.status === 404) return { upToDate: true, version: app.getVersion() };
    if (!res.ok) return { error: 'http', status: res.status };
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!latest || !isNewer(latest, app.getVersion())) return { upToDate: true, version: app.getVersion() };
    const dmgs = (rel.assets || []).filter((a) => a.name.endsWith('.dmg'));
    const mine = dmgs.find((a) => (process.arch === 'arm64' ? /arm64/.test(a.name) : !/arm64/.test(a.name))) || dmgs[0];
    const info = { version: latest, page: rel.html_url, download: mine?.browser_download_url || rel.html_url };
    win?.webContents.send('update:available', info);
    return info;
  } catch {
    return { error: 'network' };
  }
}

/* ───────────── backup / restore ─────────────
 * A backup is a folder with lamplight-backup.json (every note and folder, as
 * stored) plus a readable .md copy of each note. Restoring adds the notes and
 * folders that aren't here yet; notes that already exist are left alone. */

const BACKUP_FILE = 'lamplight-backup.json';
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

async function allNotes() {
  let dirs = [];
  try { dirs = await fs.readdir(notesRoot(), { withFileTypes: true }); } catch { return []; }
  const list = await Promise.all(dirs
    .filter((d) => d.isDirectory() && /^[a-z0-9-]{6,64}$/i.test(d.name))
    .map((d) => readJSON(path.join(notesRoot(), d.name, 'note.json'), null)));
  return list.filter(Boolean);
}

function noteAsMarkdown(n) {
  const d = new Date(n.createdAt || Date.now());
  const pad = (x) => String(x).padStart(2, '0');
  const date = `${d.getFullYear()}. ${pad(d.getMonth() + 1)}. ${pad(d.getDate())}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const meta = [date, n.attendees].filter(Boolean).join(' · ');
  return `# ${n.title || '제목 없는 노트'}\n\n${meta}\n\n---\n\n${String(n.body || '').replace(/[\u2063\u2064]/g, '')}\n`;
}

ipcMain.handle('backup:export', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '백업을 저장할 폴더 고르기',
    buttonLabel: '여기에 백업',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths?.[0]) return null;
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  let dir = path.join(filePaths[0], `Lamplight 백업 ${stamp}`);
  for (let i = 2; fsSync.existsSync(dir); i++) dir = path.join(filePaths[0], `Lamplight 백업 ${stamp} (${i})`);

  const notes = await allNotes();
  const folders = await readJSON(foldersFile(), []);
  const mdRoot = path.join(dir, '노트');
  await fs.mkdir(mdRoot, { recursive: true });
  await fs.writeFile(path.join(dir, BACKUP_FILE), JSON.stringify({
    app: 'Lamplight', version: 1, appVersion: app.getVersion(), exportedAt: Date.now(), folders, notes,
  }, null, 2), 'utf8');

  const used = new Set();
  for (const n of notes) {
    const folder = folders.find((f) => f.id === n.folderId);
    const sub = folder ? path.join(mdRoot, safeName(folder.name) || '폴더') : mdRoot;
    const base = safeName(n.title) || '제목 없는 노트';
    let file = path.join(sub, `${base}.md`);
    for (let i = 2; used.has(file); i++) file = path.join(sub, `${base} (${i}).md`);
    used.add(file);
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(file, noteAsMarkdown(n), 'utf8');
  }
  shell.showItemInFolder(path.join(dir, BACKUP_FILE));
  return { path: dir, count: notes.length };
});

ipcMain.handle('backup:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '가져올 백업 고르기',
    buttonLabel: '가져오기',
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'Lamplight 백업', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.[0]) return null;
  const data = await readJSON(filePaths[0], null);
  if (!data || data.app !== 'Lamplight' || !Array.isArray(data.notes)) return { error: 'format' };

  const folders = await readJSON(foldersFile(), []);
  const known = new Set(folders.map((f) => f.id));
  let addedFolders = 0;
  for (const f of Array.isArray(data.folders) ? data.folders : []) {
    if (!cleanFolderId(f?.id) || known.has(f.id)) continue;
    folders.push({
      id: f.id, name: String(f.name || '').slice(0, 60) || '새 폴더', collapsed: !!f.collapsed, createdAt: Number(f.createdAt) || Date.now(),
    });
    known.add(f.id);
    addedFolders++;
  }
  if (addedFolders) {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await writeJSON(foldersFile(), folders);
  }

  let added = 0;
  let skipped = 0;
  for (const n of data.notes) {
    if (typeof n?.id !== 'string' || !/^[a-z0-9-]{6,64}$/i.test(n.id)) { skipped++; continue; }
    const dir = noteDir(n.id);
    if (fsSync.existsSync(path.join(dir, 'note.json'))) { skipped++; continue; }
    await fs.mkdir(dir, { recursive: true });
    const now = Date.now();
    await writeJSON(path.join(dir, 'note.json'), {
      id: n.id,
      title: String(n.title || ''),
      attendees: String(n.attendees || ''),
      body: String(n.body || ''),
      folderId: cleanFolderId(n.folderId),
      pinned: !!n.pinned,
      createdAt: Number(n.createdAt) || now,
      updatedAt: Number(n.updatedAt) || now,
    });
    added++;
  }
  return { added, skipped, folders: addedFolders };
});

ipcMain.handle('update:check', () => checkForUpdates());
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:open', (_e, url) => {
  if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(url);
});

// One Lamplight at a time: a second launch just brings the window forward,
// so two copies never write the same notes.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (!primary) return;
  if (process.platform === 'darwin' && !app.isPackaged) {
    // In development the stock Electron.app would otherwise show its own icon.
    app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'));
  }
  app.setAboutPanelOptions({
    applicationName: 'Lamplight',
    applicationVersion: app.getVersion(),
    copyright: '작은 램프 아래의 글쓰기',
  });
  if (app.isPackaged) {
    setTimeout(checkForUpdates, 8000);
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
  }
  // Only clipboard writes (export → 복사) are needed; everything else is refused.
  const allowed = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
