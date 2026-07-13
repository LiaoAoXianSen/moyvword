const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

async function createPersistence(paths, fallbackData) {
  const dataPaths = typeof paths === 'string'
    ? { primaryDir: paths, mirrorDir: paths }
    : paths;
  const primaryDir = dataPaths.primaryDir;
  const mirrorDir = dataPaths.mirrorDir || primaryDir;
  const dbPath = path.join(primaryDir, 'moyu-vocab.sqlite');
  const backupPath = `${dbPath}.bak`;
  const tempPath = `${dbPath}.tmp`;
  const mirrorPath = path.join(mirrorDir, 'moyu-vocab.sqlite');
  const mirrorBackupPath = `${mirrorPath}.bak`;
  const backupConfigPath = path.join(mirrorDir, 'backup-config.json');
  const legacyJsonPath = path.join(mirrorDir, 'moyu-vocab-data.json');
  let customBackupDirectory = readBackupDirectory(backupConfigPath);
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
  });

  restorePrimaryIfMissing(dbPath, mirrorPath, customBackupDirectory);

  let db;
  try {
    db = fs.existsSync(dbPath)
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database();
    initSchema(db);
  } catch (error) {
    const restorePath = firstExistingPath([backupPath, mirrorPath, mirrorBackupPath, customBackupPath(customBackupDirectory)]);
    if (!restorePath) throw error;
    db = new SQL.Database(fs.readFileSync(restorePath));
    initSchema(db);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.copyFileSync(restorePath, dbPath);
  }

  function flush() {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, backupPath);
    try {
      fs.writeFileSync(tempPath, Buffer.from(db.export()));
      fs.renameSync(tempPath, dbPath);
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
    mirrorDatabase(dbPath, mirrorPath, mirrorBackupPath);
    mirrorCustomBackup(dbPath, customBackupDirectory);
  }

  function loadData() {
    const initialized = db.exec("SELECT COUNT(*) AS count FROM meta WHERE key = 'settings'");
    const hasSettings = initialized[0] && initialized[0].values[0] && initialized[0].values[0][0] > 0;
    if (!hasSettings) {
      const imported = loadLegacyJson(legacyJsonPath) || fallbackData;
      saveData(imported);
      return imported;
    }

    const version = readJsonValue(db, 'version', 3);
    const settings = readJsonValue(db, 'settings', fallbackData.settings);
    const session = readJsonValue(db, 'session', fallbackData.session);
    const books = readJsonValue(db, 'books', fallbackData.books || []);
    const studyLog = readJsonValue(db, 'studyLog', fallbackData.studyLog || []);
    const ui = readJsonValue(db, 'ui', {
      currentId: fallbackData.currentId,
      history: fallbackData.history,
      revealed: fallbackData.revealed
    });
    const words = loadWords(db);

    return {
      version: Number(version) || 3,
      settings,
      session,
      books,
      studyLog,
      words,
      currentId: ui.currentId || null,
      history: Array.isArray(ui.history) ? ui.history : [],
      revealed: !!ui.revealed
    };
  }

  function saveData(data) {
    customBackupDirectory = normalizeBackupDirectory(data.settings && data.settings.backupDirectory);
    saveBackupDirectory(backupConfigPath, customBackupDirectory);
    writeJsonValue(db, 'version', Number(data.version) || fallbackData.version || 1);
    writeJsonValue(db, 'settings', data.settings || {});
    writeJsonValue(db, 'session', data.session || {});
    writeJsonValue(db, 'books', data.books || []);
    writeJsonValue(db, 'studyLog', data.studyLog || []);
    writeJsonValue(db, 'ui', {
      currentId: data.currentId || null,
      history: Array.isArray(data.history) ? data.history : [],
      revealed: !!data.revealed
    });
    saveWords(db, data.words || []);
    flush();
  }

  function backupTo(targetPath) {
    flush();
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(dbPath, targetPath);
    return targetPath;
  }

  return {
    dbPath,
    mirrorPath,
    getCustomBackupPath: () => customBackupPath(customBackupDirectory),
    loadData,
    saveData,
    backupTo
  };
}

function initSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      meaning TEXT,
      phonetic TEXT,
      sentence TEXT,
      status TEXT NOT NULL,
      due INTEGER NOT NULL DEFAULT 0,
      stability REAL NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 0,
      memory_stage INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      hard_count INTEGER NOT NULL DEFAULT 0,
      lapse_count INTEGER NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      favorite INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_words_due ON words(status, due);
    CREATE INDEX IF NOT EXISTS idx_words_word ON words(word);
    CREATE INDEX IF NOT EXISTS idx_words_stubborn ON words(wrong_count, hard_count, lapse_count);
  `);
  ensureWordColumns(db);
}

function ensureWordColumns(db) {
  const result = db.exec('PRAGMA table_info(words)');
  const columns = new Set(result[0] ? result[0].values.map((row) => row[1]) : []);
  const required = [
    ['meaning', 'TEXT'],
    ['phonetic', 'TEXT'],
    ['sentence', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'new'"],
    ['due', 'INTEGER NOT NULL DEFAULT 0'],
    ['stability', 'REAL NOT NULL DEFAULT 0'],
    ['difficulty', 'REAL NOT NULL DEFAULT 0'],
    ['memory_stage', 'INTEGER NOT NULL DEFAULT 0'],
    ['wrong_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['hard_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['lapse_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['review_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['favorite', 'INTEGER NOT NULL DEFAULT 0'],
    ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['payload', "TEXT NOT NULL DEFAULT '{}'"]
  ];
  required.forEach(([name, ddl]) => {
    if (!columns.has(name)) db.run(`ALTER TABLE words ADD COLUMN ${name} ${ddl}`);
  });
}

function loadLegacyJson(legacyJsonPath) {
  try {
    if (!fs.existsSync(legacyJsonPath)) return null;
    return JSON.parse(fs.readFileSync(legacyJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonValue(db, key, fallback) {
  const stmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  try {
    stmt.bind([key]);
    if (!stmt.step()) return fallback;
    return JSON.parse(stmt.getAsObject().value);
  } catch {
    return fallback;
  } finally {
    stmt.free();
  }
}

function writeJsonValue(db, key, value) {
  const stmt = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  try {
    stmt.run([key, JSON.stringify(value)]);
  } finally {
    stmt.free();
  }
}

function loadWords(db) {
  const result = db.exec('SELECT payload FROM words ORDER BY updated_at, word');
  if (!result[0]) return [];
  return result[0].values
    .map(([payload]) => {
      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function saveWords(db, words) {
  db.run('BEGIN TRANSACTION');
  try {
    db.run('DELETE FROM words');
    const stmt = db.prepare(`
      INSERT INTO words (
        id, word, meaning, phonetic, sentence, status, due, stability, difficulty,
        memory_stage, wrong_count, hard_count, lapse_count, review_count, favorite,
        updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      words.forEach((item) => {
        stmt.run([
          item.id,
          item.word,
          item.meaning || '',
          item.phonetic || '',
          item.sentence || '',
          item.status || 'new',
          item.due || 0,
          item.stability || 0,
          item.difficulty || 0,
          item.memoryStage || 0,
          item.wrongCount || 0,
          item.hardCount || 0,
          item.lapseCount || 0,
          item.reviewCount || 0,
          item.favorite ? 1 : 0,
          item.updatedAt || 0,
          JSON.stringify(item)
        ]);
      });
    } finally {
      stmt.free();
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

function normalizeBackupDirectory(value) {
  const clean = String(value || '').trim();
  return clean || '';
}

function readBackupDirectory(configPath) {
  try {
    if (!fs.existsSync(configPath)) return '';
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return normalizeBackupDirectory(config.backupDirectory);
  } catch {
    return '';
  }
}

function saveBackupDirectory(configPath, backupDirectory) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ backupDirectory }, null, 2), 'utf8');
  } catch {
    // Backup location metadata should never block saving study data.
  }
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function customBackupPath(backupDirectory) {
  return backupDirectory ? path.join(backupDirectory, 'moyu-vocab.sqlite') : '';
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function restorePrimaryIfMissing(dbPath, mirrorPath, customBackupDirectory) {
  if (fs.existsSync(dbPath)) return;
  const restorePath = firstExistingPath([mirrorPath, `${mirrorPath}.bak`, customBackupPath(customBackupDirectory)]);
  if (!restorePath) return;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(restorePath, dbPath);
}

function mirrorDatabase(dbPath, mirrorPath, mirrorBackupPath) {
  if (samePath(dbPath, mirrorPath)) return;
  try {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    if (fs.existsSync(mirrorPath)) fs.copyFileSync(mirrorPath, mirrorBackupPath);
    fs.copyFileSync(dbPath, mirrorPath);
  } catch {
    // The project database is the source of truth; mirror failures are non-fatal.
  }
}

function mirrorCustomBackup(dbPath, backupDirectory) {
  const targetPath = customBackupPath(backupDirectory);
  if (!targetPath || samePath(dbPath, targetPath)) return;
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(dbPath, targetPath);
  } catch {
    // Custom backup is best-effort and should not interrupt study data saves.
  }
}

module.exports = { createPersistence };
