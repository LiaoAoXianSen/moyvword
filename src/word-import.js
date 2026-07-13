const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function normalizeRecord(row) {
  if (!row) return null;
  if (typeof row === 'string') {
    const word = row.trim();
    return word ? { word } : null;
  }
  const values = Object.values(row).map((value) => String(value || '').trim());
  const word = values[0];
  if (!word) return null;
  return {
    word,
    phonetic: values[1] || '',
    meaning: values[2] || values[1] || '',
    sentence: values[3] || ''
  };
}

function importWordsFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.csv') {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.split(','))
      .map((parts) => normalizeRecord({
        word: parts[0],
        phonetic: parts[1],
        meaning: parts[2],
        sentence: parts.slice(3).join(',')
      }))
      .filter(Boolean);
  }

  const book = XLSX.readFile(filePath);
  const sheet = book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1 })
    .map((row) => normalizeRecord({
      word: row[0],
      phonetic: row[1],
      meaning: row[2],
      sentence: row[3]
    }))
    .filter(Boolean);
}

module.exports = { importWordsFromFile };
