const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memo', {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (folderId) => ipcRenderer.invoke('notes:create', folderId),
  loadNote: (id) => ipcRenderer.invoke('notes:load', id),
  saveNote: (note) => ipcRenderer.invoke('notes:save', note),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  searchNotes: (q) => ipcRenderer.invoke('notes:search', q),
  setNoteFolder: (id, folderId) => ipcRenderer.invoke('notes:set-folder', id, folderId),

  listFolders: () => ipcRenderer.invoke('folders:list'),
  saveFolders: (folders) => ipcRenderer.invoke('folders:save', folders),
  contextMenu: (items) => ipcRenderer.invoke('context:menu', items),

  gptStatus: () => ipcRenderer.invoke('gpt:status'),
  gptSignIn: () => ipcRenderer.invoke('gpt:signin'),
  gptSignOut: () => ipcRenderer.invoke('gpt:signout'),
  gptModels: () => ipcRenderer.invoke('gpt:models'),
  gptSetModel: (slug) => ipcRenderer.invoke('gpt:set-model', slug),
  aiKeyStatus: () => ipcRenderer.invoke('ai:key-status'),
  aiKeySet: (key) => ipcRenderer.invoke('ai:key-set', key),
  aiKeyClear: () => ipcRenderer.invoke('ai:key-clear'),
  aiGenerate: (job) => ipcRenderer.invoke('ai:generate', job),
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  onAi: (cb) => ipcRenderer.on('ai:event', (_e, ev) => cb(ev)),

  exportNote: (payload) => ipcRenderer.invoke('export:note', payload),
  exportPdf: (payload) => ipcRenderer.invoke('export:pdf', payload),
  setTheme: (source) => ipcRenderer.invoke('theme:set', source),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openUpdate: (url) => ipcRenderer.invoke('update:open', url),
  onUpdate: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  appVersion: () => ipcRenderer.invoke('app:version'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  closeReady: () => ipcRenderer.send('app:close-ready'),
});
