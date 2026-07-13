const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moyu', {
  getState: () => ipcRenderer.invoke('state:get'),
  action: (name) => ipcRenderer.invoke('action', name),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseBackupDirectory: () => ipcRenderer.invoke('settings:choose-backup-directory'),
  chooseImport: () => ipcRenderer.invoke('import:choose'),
  saveBackup: () => ipcRenderer.invoke('backup:save'),
  setStripExpanded: (expanded) => ipcRenderer.invoke('window:strip-size', expanded),
  showContextMenu: () => ipcRenderer.invoke('window:context-menu'),
  listWords: (query, options) => ipcRenderer.invoke('words:list', query, options),
  lookupWord: (query) => ipcRenderer.invoke('lookup:search', query),
  saveLookupWord: (record, addToPlan) => ipcRenderer.invoke('lookup:save', record, addToPlan),
  listNewWords: (query) => ipcRenderer.invoke('words:new-list', query),
  sampleNewWords: (count, query) => ipcRenderer.invoke('plan:sample-new', count, query),
  addNewWordsToPlan: (ids) => ipcRenderer.invoke('plan:add-new', ids),
  addReviewWordsToPlan: (ids) => ipcRenderer.invoke('plan:add-review-words', ids),
  addDueReviews: (count) => ipcRenderer.invoke('plan:add-due-reviews', count),
  getPlan: () => ipcRenderer.invoke('plan:get'),
  listBooks: () => ipcRenderer.invoke('books:list'),
  addBook: (name) => ipcRenderer.invoke('books:add', name),
  renameBook: (id, name) => ipcRenderer.invoke('books:rename', id, name),
  deleteBook: (id) => ipcRenderer.invoke('books:delete', id),
  setActiveBook: (id) => ipcRenderer.invoke('books:set-active', id),
  getOnlineBookCatalog: () => ipcRenderer.invoke('online-books:catalog'),
  downloadOnlineBook: (id) => ipcRenderer.invoke('online-books:download', id),
  addWord: (record) => ipcRenderer.invoke('word:add', record),
  updateWord: (id, patch) => ipcRenderer.invoke('word:update', id, patch),
  deleteWord: (id) => ipcRenderer.invoke('word:delete', id),
  bulkWords: (ids, action, options) => ipcRenderer.invoke('words:bulk', ids, action, options),
  setCurrentWord: (id) => ipcRenderer.invoke('word:set-current', id),
  moveStrip: (delta) => ipcRenderer.invoke('window:move', delta),
  openMain: () => ipcRenderer.invoke('window:main'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
  onLookupCurrent: (callback) => {
    const listener = (_event, query) => callback(query);
    ipcRenderer.on('lookup-current', listener);
    return () => ipcRenderer.removeListener('lookup-current', listener);
  },
  onOnlineBookProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('online-books:progress', listener);
    return () => ipcRenderer.removeListener('online-books:progress', listener);
  },
  onSpeakCurrent: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('speak-current', listener);
    return () => ipcRenderer.removeListener('speak-current', listener);
  }
});
