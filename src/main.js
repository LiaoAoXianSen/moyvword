const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, dialog, crashReporter, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { importWordsFromFile } = require('./word-import');
const { WORD_BOOK_CATALOG, downloadWordBook } = require('./online-wordbooks');

let stripWindow;
let mainWindow;
let tray;
let store;
let lastRatingAt = 0;
let lastActionAt = 0;
let lastActionName = '';
let stripPositionSaveTimer;
let shortcutFailures = [];
let stripExpanded = false;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
crashReporter.start({
  productName: 'moyu-vocab-strip',
  companyName: 'local',
  submitURL: '',
  uploadToServer: false,
  compress: false
});

function logError(scope, error) {
  const message = error && error.stack ? error.stack : String(error);
  const line = `[${new Date().toISOString()}] ${scope}\n${message}\n\n`;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(path.join(app.getPath('userData'), 'moyu-vocab-error.log'), line, 'utf8');
  } catch {
    // Last-resort guard: never let logging create a second crash.
  }
}

process.on('uncaughtException', (error) => {
  logError('uncaughtException', error);
});

process.on('unhandledRejection', (error) => {
  logError('unhandledRejection', error);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

function projectDataDir() {
  if (!app.isPackaged) return path.join(__dirname, '..', 'data');
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    || (process.env.PORTABLE_EXECUTABLE_FILE ? path.dirname(process.env.PORTABLE_EXECUTABLE_FILE) : '')
    || path.dirname(app.getPath('exe'));
  const baseDir = ['dist', 'release'].includes(path.basename(portableDir).toLowerCase())
    ? path.dirname(portableDir)
    : portableDir;
  return path.join(baseDir, 'data');
}

function legacyUserDataDir() {
  return path.join(app.getPath('appData'), 'moyu-vocab-strip');
}

const shortcuts = [
  ['Alt+A', 'previous'],
  ['Alt+S', 'speak'],
  ['Alt+D', 'next'],
  ['Alt+Z', 'rate-again'],
  ['Alt+X', 'rate-hard'],
  ['Alt+C', 'rate-good'],
  ['Alt+V', 'rate-easy'],
  ['Alt+Q', 'boss'],
  ['Alt+W', 'lookup'],
  ['Alt+E', 'main'],
  ['Alt+R', 'dismiss'],
  ['Alt+F', 'reveal']
];

function createAppIcon() {
  const icoPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
  if (fs.existsSync(icoPath)) return nativeImage.createFromPath(icoPath);
  if (fs.existsSync(svgPath)) return nativeImage.createFromPath(svgPath);
  return nativeImage.createEmpty();
}

function secureWindow(window, expectedFile) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const expectedUrl = `file://${expectedFile.replace(/\\/g, '/')}`;
    if (url !== expectedUrl) event.preventDefault();
  });
}

function stripAppearance() {
  const appearance = store && store.getState().settings.stripAppearance;
  const width = Math.max(360, Math.min(900, Math.round(Number(appearance && appearance.width) || 520)));
  return { width };
}

function stripHeight(expanded = stripExpanded) {
  return expanded ? 132 : 34;
}

function applyStripAppearance() {
  if (!stripWindow || stripWindow.isDestroyed() || !store) return;
  const { width } = stripAppearance();
  const height = stripHeight();
  stripWindow.setSize(width, height, false);
  const [x, y] = stripWindow.getPosition();
  const area = screen.getPrimaryDisplay().workArea;
  const nextX = Math.max(area.x, Math.min(x, area.x + area.width - width));
  const nextY = Math.max(area.y, Math.min(y, area.y + area.height - height));
  if (nextX !== x || nextY !== y) stripWindow.setPosition(nextX, nextY);
}

function createStripWindow() {
  const position = resolveStripPosition();
  const { width } = stripAppearance();
  stripWindow = new BrowserWindow({
    width,
    height: stripHeight(false),
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: createAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  const stripFile = path.join(__dirname, 'strip.html');
  secureWindow(stripWindow, stripFile);
  stripWindow.loadFile(stripFile);
  stripWindow.webContents.on('render-process-gone', (_event, details) => {
    logError('strip render-process-gone', JSON.stringify(details));
  });
  stripWindow.once('ready-to-show', () => stripWindow.show());
  stripWindow.on('moved', scheduleStripPositionSave);
  stripWindow.on('close', saveStripPositionNow);
  stripWindow.on('closed', () => {
    stripWindow = null;
  });
}

function resolveStripPosition() {
  const fallback = { x: 340, y: 22 };
  const saved = store && store.getState().settings.stripPosition;
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return fallback;
  const { width } = stripAppearance();
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(saved.y, area.y + area.height - stripHeight(false)))
  };
}

function scheduleStripPositionSave() {
  if (!stripWindow || stripWindow.isDestroyed()) return;
  clearTimeout(stripPositionSaveTimer);
  stripPositionSaveTimer = setTimeout(saveStripPositionNow, 300);
}

function saveStripPositionNow() {
  clearTimeout(stripPositionSaveTimer);
  stripPositionSaveTimer = null;
  if (!stripWindow || stripWindow.isDestroyed() || !store) return;
  const [x, y] = stripWindow.getPosition();
  store.updateSettings({ stripPosition: { x, y } });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 920,
    minHeight: 560,
    show: false,
    icon: createAppIcon(),
    title: '摸鱼单词v59版本',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.setMenu(null);

  const appFile = path.join(__dirname, 'app.html');
  secureWindow(mainWindow, appFile);
  mainWindow.loadFile(appFile);
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logError('main render-process-gone', JSON.stringify(details));
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function focusExistingApp() {
  createMainWindow();
  if (stripWindow && !stripWindow.isDestroyed()) stripWindow.showInactive();
  dialog.showMessageBox(mainWindow || stripWindow, {
    type: 'info',
    title: '摸鱼单词v59版本',
    message: '摸鱼单词v59版本已经打开',
    detail: '已为你显示正在运行的窗口。',
    buttons: ['知道了']
  }).catch(() => {});
}

function openLookup() {
  const current = store && store.getState().word;
  const sendLookup = () => mainWindow && mainWindow.webContents.send('lookup-current', current ? current.word : '');
  createMainWindow();
  if (mainWindow && mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', sendLookup);
  else sendLookup();
}

async function lookupOnlineWord(query) {
  const term = String(query || '').trim().toLowerCase();
  if (!/^[a-z][a-z'’-]*$/i.test(term)) throw new Error('请输入英文单词。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`, {
      signal: controller.signal
    });
    if (!response.ok) throw new Error(response.status === 404 ? '没有找到这个单词。' : '在线词典暂时不可用。');
    const entries = await response.json();
    const entry = Array.isArray(entries) ? entries[0] : null;
    if (!entry || !entry.word) throw new Error('没有找到这个单词。');
    const phonetic = entry.phonetic || (entry.phonetics || []).find((item) => item && item.text)?.text || '';
    const definitions = (entry.meanings || []).flatMap((meaning) => (meaning.definitions || []).slice(0, 2)
      .map((definition) => `${meaning.partOfSpeech || ''} ${definition.definition || ''}`.trim()))
      .filter(Boolean);
    const example = (entry.meanings || []).flatMap((meaning) => meaning.definitions || [])
      .map((definition) => definition.example)
      .find(Boolean) || '';
    return {
      word: entry.word,
      phonetic,
      meaning: definitions.join('；') || '暂无释义',
      sentence: example
    };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('在线词典响应超时，请稍后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function openOnlineLookup() {
  const current = store && store.getState().word;
  if (!current || !current.word) return;
  shell.openExternal(`https://dict.youdao.com/result?word=${encodeURIComponent(current.word)}&lang=en`).catch((error) => {
    logError('openOnlineLookup', error);
  });
}

function showStripContextMenu() {
  const current = store && store.getState().word;
  Menu.buildFromTemplate([
    { label: '已掌握(以后不再出现)', click: () => perform('dismiss'), enabled: !!current },
    { label: current && current.favorite ? '取消收藏单词' : '收藏该单词', click: () => perform('favorite'), enabled: !!current },
    { label: '在线查找', click: openOnlineLookup, enabled: !!current },
    { type: 'separator' },
    { label: '显示主窗口', click: createMainWindow },
    { label: stripWindow && stripWindow.isVisible() ? '隐藏横条' : '显示横条', click: () => perform('boss') },
    { type: 'separator' },
    { label: '退出App', click: () => app.quit() }
  ]).popup({ window: stripWindow || mainWindow || undefined });
}

function broadcastState() {
  try {
    const state = store.getState();
    state.settings.shortcutFailures = shortcutFailures.slice();
    if (stripWindow && !stripWindow.isDestroyed()) stripWindow.webContents.send('state', state);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state', state);
  } catch (error) {
    logError('broadcastState', error);
  }
}

function perform(action) {
  try {
    const now = Date.now();
    if (action === lastActionName && now - lastActionAt < 80) return;
    lastActionName = action;
    lastActionAt = now;
    if (action.startsWith('rate-')) {
      const t = now;
      if (t - lastRatingAt < 90) return;
      lastRatingAt = t;
    }
    switch (action) {
      case 'reveal':
        store.reveal();
        break;
      case 'rate-again':
        store.rate('again');
        break;
      case 'rate-hard':
        store.rate('hard');
        break;
      case 'rate-good':
        store.rate('good');
        break;
      case 'rate-easy':
        store.rate('easy');
        break;
      case 'previous':
        store.previous();
        break;
      case 'next':
      case 'skip':
        store.skip();
        break;
      case 'favorite':
        store.toggleFavorite();
        break;
      case 'dismiss':
        store.dismissCurrent();
        break;
      case 'boss':
        if (stripWindow) stripWindow.isVisible() ? stripWindow.hide() : stripWindow.showInactive();
        break;
      case 'speak':
        if (stripWindow && !stripWindow.isDestroyed()) stripWindow.webContents.send('speak-current');
        break;
      case 'lookup':
        openLookup();
        break;
      case 'main':
        createMainWindow();
        break;
      default:
        break;
    }
  } catch (error) {
    logError(`perform:${action}`, error);
  }
  broadcastState();
}

function registerShortcuts() {
  shortcutFailures = [];
  shortcuts.forEach(([accelerator, action]) => {
    const registered = globalShortcut.register(accelerator, () => perform(action));
    if (!registered) shortcutFailures.push(accelerator);
  });
}

function createTray() {
  tray = new Tray(createAppIcon());
  tray.setToolTip('摸鱼单词v59版本');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示横条', click: () => stripWindow && stripWindow.showInactive() },
    { label: '隐藏横条', click: () => stripWindow && stripWindow.hide() },
    { label: '打开管理面板', click: createMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', () => {
    if (!stripWindow) return;
    stripWindow.isVisible() ? stripWindow.hide() : stripWindow.showInactive();
  });
}

if (hasSingleInstanceLock) {
  app.on('second-instance', focusExistingApp);

  app.whenReady().then(async () => {
    store = await createStore({
      primaryDir: projectDataDir(),
      mirrorDir: legacyUserDataDir()
    });
    createStripWindow();
    createTray();
    registerShortcuts();
    createMainWindow();
  }).catch((error) => {
    logError('app.whenReady', error);
    dialog.showErrorBox('摸鱼单词v59版本无法启动', '学习数据无法读取，已保留数据库与备份文件。请从备份恢复后重试。');
    app.quit();
  });
}

app.on('render-process-gone', (_event, webContents, details) => {
  logError(`app render-process-gone:${webContents && webContents.getURL ? webContents.getURL() : ''}`, JSON.stringify(details));
});

app.on('child-process-gone', (_event, details) => {
  logError('child-process-gone', JSON.stringify(details));
});

app.on('will-quit', () => {
  saveStripPositionNow();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

ipcMain.handle('state:get', () => {
  const state = store.getState();
  state.settings.shortcutFailures = shortcutFailures.slice();
  return state;
});
ipcMain.handle('action', (_event, action) => {
  perform(action);
  return store.getState();
});
ipcMain.handle('settings:update', (_event, patch) => {
  store.updateSettings(patch);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'stripAppearance')) applyStripAppearance();
  broadcastState();
  return store.getState();
});
ipcMain.handle('settings:choose-backup-directory', async () => {
  const current = store.getState().settings.backupDirectory;
  const result = await dialog.showOpenDialog(mainWindow || stripWindow, {
    title: '选择自动备份目录',
    defaultPath: current || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return store.getState();
  store.updateSettings({ backupDirectory: result.filePaths[0] });
  broadcastState();
  return store.getState();
});
ipcMain.handle('words:list', (_event, query, options) => store.listWords(query, options));
ipcMain.handle('lookup:search', async (_event, query) => {
  const term = String(query || '').trim();
  if (!term) throw new Error('请输入要搜索的单词。');
  const local = store.listWords(term, { scope: 'book', page: 1, pageSize: 8 });
  if (local.total) return { source: 'book', items: local.items, total: local.total };
  return { source: 'online', items: [await lookupOnlineWord(term)], total: 1 };
});
ipcMain.handle('lookup:save', (_event, record, addToPlan) => {
  const word = store.addWord(record || {});
  let added = 0;
  if (addToPlan) {
    const result = word.status === 'new'
      ? store.addNewWordsToPlan([word.id], 'lookup_new')
      : store.addReviewWordsToPlan([word.id]);
    added = result.added || 0;
  }
  broadcastState();
  return { word, added };
});
ipcMain.handle('words:new-list', (_event, query) => store.listNewWords(query));
ipcMain.handle('plan:sample-new', (_event, count, query) => store.sampleNewWords(count, query));
ipcMain.handle('plan:add-new', (_event, ids) => {
  const result = store.addNewWordsToPlan(ids);
  broadcastState();
  return result;
});
ipcMain.handle('plan:add-review-words', (_event, ids) => {
  const result = store.addReviewWordsToPlan(ids);
  broadcastState();
  return result;
});
ipcMain.handle('plan:add-due-reviews', (_event, count) => {
  const result = store.addDueReviews(count);
  broadcastState();
  return result;
});
ipcMain.handle('plan:get', () => store.getPlan());
ipcMain.handle('today-review:start', () => {
  const result = store.startTodayReview();
  broadcastState();
  return result;
});
ipcMain.handle('books:list', () => store.listBooks());
ipcMain.handle('books:add', (_event, name) => {
  const book = store.addBook(name);
  broadcastState();
  return book;
});
ipcMain.handle('books:rename', (_event, id, name) => {
  const book = store.renameBook(id, name);
  broadcastState();
  return book;
});
ipcMain.handle('books:delete', (_event, id) => {
  const result = store.deleteBook(id);
  broadcastState();
  return result;
});
ipcMain.handle('books:set-active', (_event, id) => {
  const books = store.setActiveBook(id);
  broadcastState();
  return books;
});
ipcMain.handle('online-books:catalog', () => WORD_BOOK_CATALOG.map(({ id, name, source }) => ({ id, name, source })));
ipcMain.handle('online-books:download', async (event, id) => {
  const sendProgress = (progress) => {
    try {
      event.sender.send('online-books:progress', { bookId: id, ...progress });
    } catch (error) {
      logError('online-books:progress', error);
    }
  };
  const { book, records, source } = await downloadWordBook(id, sendProgress);
  sendProgress({ stage: 'import', label: '写入本地词库...', percent: 92 });
  const existing = store.listBooks().find((item) => item.name === book.name);
  if (existing) store.setActiveBook(existing.id);
  else store.addBook(book.name);
  const result = store.importWords(records);
  broadcastState();
  sendProgress({ stage: 'done', label: '导入完成', percent: 100 });
  return { ...result, bookName: book.name, source };
});
ipcMain.handle('word:add', (_event, record) => {
  const word = store.addWord(record);
  broadcastState();
  return word;
});
ipcMain.handle('word:update', (_event, id, patch) => {
  const word = store.updateWord(id, patch);
  broadcastState();
  return word;
});
ipcMain.handle('word:delete', (_event, id) => {
  store.deleteWord(id);
  broadcastState();
});
ipcMain.handle('words:bulk', (_event, ids, action, options) => {
  const result = store.bulkWords(ids, action, options);
  broadcastState();
  return result;
});
ipcMain.handle('word:set-current', (_event, id) => {
  const word = store.setCurrentWord(id);
  broadcastState();
  return word;
});
ipcMain.handle('window:move', (_event, delta) => {
  if (!stripWindow) return;
  const [x, y] = stripWindow.getPosition();
  stripWindow.setPosition(x + delta.x, y + delta.y);
});
ipcMain.handle('window:strip-size', (_event, expanded) => {
  if (!stripWindow) return;
  stripExpanded = Boolean(expanded);
  applyStripAppearance();
});
ipcMain.handle('window:context-menu', () => {
  showStripContextMenu();
});
ipcMain.handle('window:main', () => {
  createMainWindow();
});
ipcMain.handle('import:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow || stripWindow, {
    title: '导入单词本',
    properties: ['openFile'],
    filters: [
      { name: 'Word books', extensions: ['txt', 'xlsx', 'xls', 'csv'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return store.getState();
  const words = importWordsFromFile(result.filePaths[0]);
  const imported = store.importWords(words);
  broadcastState();
  return { state: store.getState(), imported };
});
ipcMain.handle('backup:save', async () => {
  const defaultName = `摸鱼单词v59版本备份-${new Date().toISOString().slice(0, 10)}.sqlite`;
  const backupDirectory = store.getState().settings.backupDirectory || app.getPath('documents');
  const result = await dialog.showSaveDialog(mainWindow || stripWindow, {
    title: '备份学习数据',
    defaultPath: path.join(backupDirectory, defaultName),
    filters: [{ name: 'SQLite backup', extensions: ['sqlite'] }]
  });
  if (result.canceled || !result.filePath) return null;
  store.updateSettings({ backupDirectory: path.dirname(result.filePath) });
  broadcastState();
  return store.backupTo(result.filePath);
});
ipcMain.handle('snapshots:list', () => store.listSnapshots());
ipcMain.handle('snapshots:create', (_event, options = {}) => {
  const snapshot = store.createSnapshot({
    kind: 'manual',
    label: options && options.label ? options.label : '手动恢复点',
    force: !!(options && options.force)
  });
  broadcastState();
  return snapshot;
});
ipcMain.handle('snapshots:restore', async (_event, id) => {
  const snapshotId = String(id || '').trim();
  if (!snapshotId) throw new Error('请选择要恢复的恢复点。');
  const items = store.listSnapshots();
  const target = items.find((item) => item.id === snapshotId || item.fileName === snapshotId || item.fileName === `${snapshotId}.sqlite`);
  const label = target
    ? `${target.label || target.kind || '恢复点'}（${new Date(target.createdAt).toLocaleString()}）`
    : snapshotId;
  const confirm = await dialog.showMessageBox(mainWindow || stripWindow, {
    type: 'warning',
    title: '恢复学习数据',
    message: '确定恢复到这个恢复点吗？',
    detail: `将用「${label}」覆盖当前学习数据。恢复前会自动再保存一份「恢复前」快照，便于反悔。`,
    buttons: ['取消', '确认恢复'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (confirm.response !== 1) return { canceled: true };
  const result = store.restoreSnapshot(snapshotId);
  broadcastState();
  return result;
});
