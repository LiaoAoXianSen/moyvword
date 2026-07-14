const {
  DAY,
  createWord,
  dueText,
  estimateRetention,
  now,
  normalizeWord,
  overdueWeight,
  rateWord,
  stageText,
  stubbornness
} = require('./scheduler');
const { createPersistence } = require('./persistence');

function defaultStripAppearance() {
  return {
    width: 520,
    opacity: 93,
    textColor: '#243044'
  };
}

function normalizeHexColor(value, fallback = '#243044') {
  const clean = String(value || '').trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(clean)) {
    if (clean.length === 4) {
      return `#${clean.slice(1).split('').map((part) => part + part).join('')}`.toLowerCase();
    }
    return clean.toLowerCase();
  }
  return fallback;
}

function normalizeStripAppearance(value, fallback = defaultStripAppearance()) {
  const base = defaultStripAppearance();
  const defaultValue = { ...base, ...(fallback || {}) };
  const input = value && typeof value === 'object' ? value : {};
  const width = Math.max(360, Math.min(900, Math.round(Number(input.width ?? defaultValue.width) || defaultValue.width)));
  const opacity = Math.max(40, Math.min(100, Math.round(Number(input.opacity ?? defaultValue.opacity) || defaultValue.opacity)));
  const textColor = normalizeHexColor(input.textColor ?? defaultValue.textColor, defaultValue.textColor);
  return { width, opacity, textColor };
}

const {
  advanceLive,
  defaultNavigation,
  enterManual,
  goNext,
  goPrevious,
  isBrowsing,
  migrateNavigation,
  removeWord,
  removeWords,
  returnToLive,
  setLive,
  viewWordId
} = require('./navigation');

const seedWords = [
  { word: 'ability', phonetic: "/ə'bɪləti/", meaning: 'n. 能力；才能', sentence: 'The job requires the ability to focus under pressure.' },
  { word: 'spray', phonetic: '/spreɪ/', meaning: 'v. 喷洒；n. 喷雾', sentence: 'A fine spray covered the window.' },
  { word: 'question', phonetic: "/'kwestʃən/", meaning: 'n. 问题；v. 询问', sentence: 'Good questions make learning faster.' },
  { word: 'centigrade', phonetic: "/'sentɪɡreɪd/", meaning: 'adj. 摄氏的', sentence: 'Water freezes at zero degrees centigrade.' },
  { word: 'brief', phonetic: '/briːf/', meaning: 'adj. 简短的；n. 摘要', sentence: 'Keep the answer brief and useful.' }
];

const IN_DAY_AGAIN_INTERVAL = 3 * 60 * 1000;
const IN_DAY_HARD_INTERVAL = 5 * 60 * 1000;
const IN_DAY_AGAIN_REPEATS = 3;
const IN_DAY_HARD_REPEATS = 2;

function defaultData() {
  return {
    version: 8,
    settings: {
      dailyNew: 20,
      learningWindowSize: 15,
      autoReveal: false,
      autoSpeak: true,
      audioVolume: 80,
      userMemoryCoeff: 1,
      answerFirst: false,
      activeBookId: 'default',
      backupDirectory: '',
      stripAppearance: defaultStripAppearance(),
      shortcutFailures: []
    },
    books: [
      { id: 'default', name: '默认单词本', createdAt: now(), updatedAt: now() }
    ],
    words: seedWords.map(createWord),
    studyLog: [],
    currentId: null,
    history: [],
    navigation: defaultNavigation(),
    revealed: false,
    session: {
      newLearned: 0,
      reviewed: 0,
      again: 0,
      date: todayKey(),
      startedAt: now(),
      bookProgress: {},
      windowIds: [],
      windowDate: todayKey(),
      windowBookId: 'default',
      planDate: '',
      planItems: [],
      planCompletionToken: '',
      manualPreviewId: '',
      manualReturnId: '',
      todayReview: {
        date: todayKey(),
        queue: [],
        sourceIds: [],
        attempts: {},
        misses: {},
        hard: {},
        startedAt: 0,
        finishedAt: 0
      }
    }
  };
}

function todayKey() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKeyFromTime(time) {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

  async function createStore(dataPaths) {
  const persistence = await createPersistence(dataPaths, defaultData());
  const loaded = persistence.loadData();
  let data = normalizeData(loaded);
  if (Number(loaded.version || 0) !== data.version) save();
  // Point-in-time recovery: keep one automatic snapshot per calendar day.
  try {
    persistence.ensureDailySnapshot();
  } catch {
    // Snapshot failures must never block app startup.
  }

  function normalizeData(raw) {
    const base = defaultData();
    const normalized = {
      ...base,
      ...raw,
      settings: { ...base.settings, ...(raw.settings || {}) },
      session: { ...base.session, ...(raw.session || {}) },
      books: normalizeBooks(raw.books || base.books),
      words: Array.isArray(raw.words) ? raw.words.map(normalizeWord) : base.words,
      studyLog: Array.isArray(raw.studyLog) ? raw.studyLog.slice(-180) : []
    };
    if (Number(raw.version || 0) < 5 && raw.settings && raw.settings.autoSpeak === false) {
      normalized.settings.autoSpeak = true;
    }
    normalized.version = 8;
    if (!normalized.session.date) normalized.session.date = todayKey();
    if (!normalized.session.bookProgress || typeof normalized.session.bookProgress !== 'object') normalized.session.bookProgress = {};
    if (!Array.isArray(normalized.session.windowIds)) normalized.session.windowIds = [];
    if (!normalized.session.windowDate) normalized.session.windowDate = normalized.session.date;
    if (!normalized.session.windowBookId) normalized.session.windowBookId = normalized.settings.activeBookId;
    if (!Array.isArray(normalized.session.planItems)) normalized.session.planItems = [];
    normalized.session.planItems = normalizePlanItems(normalized.session.planItems);
    if (!normalized.session.planDate) normalized.session.planDate = '';
    if (!normalized.session.planCompletionToken) normalized.session.planCompletionToken = '';
    if (!normalized.session.manualPreviewId) normalized.session.manualPreviewId = '';
    if (!normalized.session.manualReturnId) normalized.session.manualReturnId = '';
    normalized.session.todayReview = normalizeTodayReview(normalized.session.todayReview);
    normalized.settings.learningWindowSize = Math.max(1, Math.min(50, Number(normalized.settings.learningWindowSize) || 15));
    normalized.settings.audioVolume = Math.max(0, Math.min(100, Math.round(Number(normalized.settings.audioVolume) || 0)));
    normalized.settings.userMemoryCoeff = Math.max(0.7, Math.min(1.3, Number(normalized.settings.userMemoryCoeff) || 1));
    normalized.settings.stripAppearance = normalizeStripAppearance(normalized.settings.stripAppearance, base.settings.stripAppearance);
    if (!normalized.settings.activeBookId || !normalized.books.some((book) => book.id === normalized.settings.activeBookId)) {
      normalized.settings.activeBookId = normalized.books[0].id;
    }
    normalized.words = normalized.words.map((word) => normalizeWordBooks(normalizeDailyLoop(word), normalized.settings.activeBookId));
    normalized.navigation = migrateNavigation(raw.navigation || normalized.navigation, {
      currentId: raw.currentId || normalized.currentId,
      history: Array.isArray(raw.history) ? raw.history : normalized.history,
      manualPreviewId: normalized.session.manualPreviewId,
      manualReturnId: normalized.session.manualReturnId
    });
    syncLegacyNavigationFields(normalized);
    return normalized;
  }

  function syncLegacyNavigationFields(target = data) {
    const nav = defaultNavigation(target.navigation);
    target.navigation = nav;
    target.currentId = viewWordId(nav);
    target.history = nav.trail.slice();
    target.session.manualPreviewId = isBrowsing(nav)
      ? (nav.mode === 'manual' ? nav.manualWordId : viewWordId(nav)) || ''
      : '';
    target.session.manualReturnId = isBrowsing(nav) ? (nav.liveWordId || '') : '';
  }

  function applyNavigation(nextNav, options = {}) {
    data.navigation = defaultNavigation(nextNav);
    syncLegacyNavigationFields(data);
    if (options.keepReveal) {
      // preserve current reveal flag
    } else if (options.forceReveal === true) {
      data.revealed = true;
    } else if (options.forceReveal === false) {
      data.revealed = !!data.settings.answerFirst;
    } else {
      data.revealed = !!data.settings.answerFirst;
    }
  }

  function normalizeDailyLoop(word) {
    const today = todayKey();
    if (word.dayLoopDate === today) return word;
    return {
      ...word,
      dayLoopDate: '',
      dayLoopDue: 0,
      dayLoopCardsBefore: 0,
      dayLoopPriority: 0,
      dayLoopRemaining: 0
    };
  }

  function normalizeWordBooks(word, fallbackBookId = 'default') {
    const hasExplicitBookIds = Array.isArray(word.bookIds);
    const bookIds = hasExplicitBookIds ? word.bookIds : [word.bookId || fallbackBookId];
    const cleanBookIds = [...new Set(bookIds.map((id) => String(id || '').trim()).filter(Boolean))];
    const safeBookIds = hasExplicitBookIds ? cleanBookIds : (cleanBookIds.length ? cleanBookIds : [fallbackBookId]);
    return { ...word, bookId: safeBookIds[0] || '', bookIds: safeBookIds };
  }

  function normalizePlanItems(items) {
    const today = todayKey();
    return (Array.isArray(items) ? items : [])
      .map((item, index) => {
        const uncertainDate = String(item.uncertainDate || '');
        return {
          id: String(item.id || `plan-${item.wordId || index}-${item.addedAt || now()}`),
          wordId: String(item.wordId || ''),
          type: item.type === 'new' ? 'new' : 'review',
          source: String(item.source || 'initial_due'),
          status: item.status === 'completed' || item.status === 'cancelled' ? item.status : 'pending',
          addedDate: item.addedDate || today,
          addedAt: Number(item.addedAt) || now(),
          completedAt: Number(item.completedAt) || 0,
          uncertainDate: uncertainDate === today ? uncertainDate : '',
          goodAfterUncertainStreak: 0
        };
      })
      .filter((item) => item.wordId);
  }

  function defaultTodayReview() {
    return {
      date: todayKey(),
      queue: [],
      sourceIds: [],
      attempts: {},
      misses: {},
      hard: {},
      startedAt: 0,
      finishedAt: 0
    };
  }

  function normalizeTodayReview(review) {
    const raw = review && typeof review === 'object' ? review : {};
    const queue = Array.isArray(raw.queue)
      ? raw.queue.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const sourceIds = Array.isArray(raw.sourceIds)
      ? raw.sourceIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const uniqueSourceIds = [];
    const seen = new Set();
    sourceIds.forEach((id) => {
      if (seen.has(id)) return;
      seen.add(id);
      uniqueSourceIds.push(id);
    });
    return {
      ...defaultTodayReview(),
      date: raw.date === todayKey() ? todayKey() : '',
      queue,
      sourceIds: uniqueSourceIds,
      attempts: raw.attempts && typeof raw.attempts === 'object' ? { ...raw.attempts } : {},
      misses: raw.misses && typeof raw.misses === 'object' ? { ...raw.misses } : {},
      hard: raw.hard && typeof raw.hard === 'object' ? { ...raw.hard } : {},
      startedAt: Number(raw.startedAt) || 0,
      finishedAt: Number(raw.finishedAt) || 0
    };
  }

  function hasLearningRecord(word) {
    return word.status !== 'new' || (word.reviewCount || 0) > 0 || (word.lastReviewedAt || 0) > 0;
  }

  function wordInBook(word, bookId) {
    return (word.bookIds || [word.bookId || 'default']).includes(bookId);
  }

  function attachWordToBook(word, bookId) {
    const bookIds = new Set(word.bookIds || [word.bookId || 'default']);
    bookIds.add(bookId);
    return { ...word, bookId: [...bookIds][0], bookIds: [...bookIds], updatedAt: now() };
  }

  function moveWordFromActiveBook(word, targetBookId) {
    const currentBookId = data.settings.activeBookId;
    const bookIds = new Set(word.bookIds || [word.bookId].filter(Boolean));
    bookIds.delete(currentBookId);
    bookIds.add(targetBookId);
    const nextBookIds = [...bookIds].filter(Boolean);
    return { ...word, bookId: nextBookIds[0] || '', bookIds: nextBookIds, updatedAt: now() };
  }

  function pruneEmptyBooks(options = {}) {
    const keepActiveEmpty = !!options.keepActiveEmpty;
    const activeId = data.settings.activeBookId;
    const hasWords = (bookId) => data.words.some((word) => wordInBook(word, bookId));
    let kept = data.books.filter((book) => hasWords(book.id) || (keepActiveEmpty && book.id === activeId));
    if (!kept.length) kept = [{ id: 'default', name: '默认单词本', createdAt: now(), updatedAt: now() }];
    const keptIds = new Set(kept.map((book) => book.id));
    Object.keys(data.session.bookProgress || {}).forEach((bookId) => {
      if (!keptIds.has(bookId)) delete data.session.bookProgress[bookId];
    });
    data.books = kept;
    if (!keptIds.has(data.settings.activeBookId)) data.settings.activeBookId = data.books[0].id;
    if (data.settings.activeBookId !== activeId) resetLearningWindow();
  }

  function normalizeBooks(books) {
    const clean = Array.isArray(books)
      ? books
          .map((book, index) => ({
            id: String(book.id || `book-${index}`).trim(),
            name: String(book.name || '').trim(),
            createdAt: book.createdAt || now(),
            updatedAt: book.updatedAt || now()
          }))
          .filter((book) => book.id && book.name)
      : [];
    if (!clean.length) clean.push({ id: 'default', name: '默认单词本', createdAt: now(), updatedAt: now() });
    return clean;
  }

  function refreshDailySession() {
    const today = todayKey();
    if (data.session.date === today) return;
    data.session = {
      ...data.session,
      date: today,
      newLearned: 0,
      reviewed: 0,
      again: 0,
      startedAt: now(),
      bookProgress: {},
      windowIds: data.session.windowIds || [],
      windowDate: today,
      windowBookId: data.settings.activeBookId,
      planDate: data.session.planDate || '',
      planItems: normalizePlanItems(data.session.planItems || []),
      planCompletionToken: '',
      manualPreviewId: '',
      manualReturnId: '',
      todayReview: defaultTodayReview()
    };
    // Keep trail across days, but always resume at the study frontier.
    applyNavigation(returnToLive(data.navigation, data.navigation && data.navigation.liveWordId), { forceReveal: false });
    save();
  }

  function save() {
    persistence.saveData(data);
  }

  let deferredSaveTimer = 0;
  function saveSoon() {
    clearTimeout(deferredSaveTimer);
    deferredSaveTimer = setTimeout(() => {
      deferredSaveTimer = 0;
      save();
    }, 800);
  }

  function bookProgressFor(bookId) {
    const progress = data.session.bookProgress[bookId];
    return {
      newLearned: Number(progress && progress.newLearned) || 0,
      reviewed: Number(progress && progress.reviewed) || 0,
      again: Number(progress && progress.again) || 0
    };
  }

  function activeBookProgress() {
    return bookProgressFor(data.settings.activeBookId);
  }

  function recordBookProgress(patch) {
    const current = activeBookProgress();
    data.session.bookProgress[data.settings.activeBookId] = { ...current, ...patch };
  }

  function recordStudyEvent(beforeStatus, grade, longTermRating) {
    const date = todayKey();
    const bookId = data.settings.activeBookId;
    let entry = data.studyLog.find((item) => item.date === date && item.bookId === bookId);
    if (!entry) {
      entry = { date, bookId, newLearned: 0, reviewed: 0, again: 0, actions: 0 };
      data.studyLog.push(entry);
    }
    entry.actions += 1;
    if (longTermRating && beforeStatus === 'new') entry.newLearned += 1;
    if (longTermRating && beforeStatus !== 'new') entry.reviewed += 1;
    if (longTermRating && (grade === 'again' || grade === 'hard')) entry.again += 1;
    data.studyLog = data.studyLog.slice(-180);
  }

  function refreshUserMemoryCoeff() {
    const recent = data.studyLog.slice(-30);
    const rated = recent.reduce((sum, entry) => sum + (entry.newLearned || 0) + (entry.reviewed || 0), 0);
    if (rated < 12) return;
    const uncertain = recent.reduce((sum, entry) => sum + (entry.again || 0), 0);
    const accuracy = Math.max(0, Math.min(1, 1 - uncertain / rated));
    const target = Math.max(0.7, Math.min(1.3, 1 + (accuracy - 0.75) * 0.4));
    data.settings.userMemoryCoeff = Number((data.settings.userMemoryCoeff * 0.9 + target * 0.1).toFixed(3));
  }

  function studySummary() {
    const today = startOfToday();
    const activeBookId = data.settings.activeBookId;
    const history = Array.from({ length: 7 }, (_value, index) => {
      const time = today - (6 - index) * DAY;
      const date = dayKeyFromTime(time);
      const entries = data.studyLog.filter((item) => item.date === date && item.bookId === activeBookId);
      return {
        date,
        newLearned: entries.reduce((sum, item) => sum + (item.newLearned || 0), 0),
        reviewed: entries.reduce((sum, item) => sum + (item.reviewed || 0), 0),
        actions: entries.reduce((sum, item) => sum + (item.actions || 0), 0)
      };
    });
    const activeDates = new Set(data.studyLog.filter((item) => (item.actions || 0) > 0).map((item) => item.date));
    let streak = 0;
    for (let offset = 0; offset < 3650; offset += 1) {
      if (!activeDates.has(dayKeyFromTime(today - offset * DAY))) break;
      streak += 1;
    }
    const activeWords = data.words.filter(isReviewableWord);
    const forecast = Array.from({ length: 7 }, (_value, index) => {
      const start = today + index * DAY;
      const end = start + DAY;
      return {
        date: dayKeyFromTime(start),
        due: activeWords.filter((word) => word.status !== 'new' && word.status !== 'done' && (word.due || 0) <= end && (index > 0 ? (word.due || 0) > start : true)).length
      };
    });
    return { streak, history, forecast };
  }

  function activePlanItems() {
    cleanupPlanItems();
    return data.session.planItems.filter((item) => item.status === 'pending' || item.status === 'studying');
  }

  function activePlanWordIds() {
    return new Set(activePlanItems().map((item) => item.wordId));
  }

  function planItemForWord(wordId) {
    return activePlanItems().find((item) => item.wordId === wordId);
  }

  function isPlanItemConsistent(item) {
    const word = findWord(item.wordId);
    if (!word) return false;
    if (item.type === 'review') return isReviewableWord(word);
    if (item.status === 'completed') return hasLearningRecord(word) && word.status !== 'new';
    return word.status !== 'done';
  }

  function makePlanItem(word, type, source) {
    const t = now();
    return {
      id: `plan-${todayKey()}-${word.id}-${t}-${Math.random().toString(36).slice(2, 7)}`,
      wordId: word.id,
      type,
      source,
      status: 'pending',
      addedDate: todayKey(),
      addedAt: t,
      completedAt: 0,
      uncertainDate: '',
      goodAfterUncertainStreak: 0
    };
  }

  function cleanupPlanItems() {
    const before = data.session.planItems.length;
    const known = new Set(data.words.map((word) => word.id));
    const cutoff = now() - 30 * DAY;
    data.session.planItems = normalizePlanItems(data.session.planItems)
      .filter((item) => known.has(item.wordId))
      .filter(isPlanItemConsistent)
      .filter((item) => item.status !== 'cancelled')
      .filter((item) => item.status !== 'completed' || item.completedAt >= cutoff);
    return before !== data.session.planItems.length;
  }

  function completedPlanItemsToday(type) {
    const today = todayKey();
    return data.session.planItems.filter((item) => {
      if (!isPlanItemConsistent(item)) return false;
      if (item.status !== 'completed' || dayKeyFromTime(item.completedAt || 0) !== today) return false;
      return type ? item.type === type : true;
    });
  }

  function todayReviewSourceItems() {
    return completedPlanItemsToday()
      .slice()
      .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
  }

  function todayReviewSourceIds() {
    const ids = [];
    const seen = new Set();
    todayReviewSourceItems().forEach((item) => {
      if (seen.has(item.wordId)) return;
      seen.add(item.wordId);
      ids.push(item.wordId);
    });
    return ids;
  }

  function cleanReviewCounterMap(map, validIds) {
    const clean = {};
    Object.entries(map || {}).forEach(([id, value]) => {
      const key = String(id || '').trim();
      if (!validIds.has(key)) return;
      clean[key] = Math.max(0, Math.floor(Number(value) || 0));
    });
    return clean;
  }

  function todayReviewState() {
    refreshDailySession();
    const review = normalizeTodayReview(data.session.todayReview);
    const sourceIds = todayReviewSourceIds().filter((id) => !!findWord(id));
    const sourceSet = new Set(sourceIds);
    const queue = review.date === todayKey()
      ? review.queue.filter((id) => sourceSet.has(id) && findWord(id))
      : [];
    const attempts = cleanReviewCounterMap(review.attempts, sourceSet);
    const misses = cleanReviewCounterMap(review.misses, sourceSet);
    const hard = cleanReviewCounterMap(review.hard, sourceSet);
    data.session.todayReview = {
      ...review,
      date: todayKey(),
      sourceIds,
      queue,
      attempts,
      misses,
      hard,
      finishedAt: review.finishedAt && queue.length ? 0 : review.finishedAt
    };
    const active = !!(data.session.todayReview.startedAt && !data.session.todayReview.finishedAt && queue.length > 0);
    const remainingWords = new Set(queue).size;
    return {
      date: todayKey(),
      active,
      total: sourceIds.length,
      remainingCards: queue.length,
      remainingWords,
      completed: Math.max(0, sourceIds.length - remainingWords),
      startedAt: data.session.todayReview.startedAt || 0,
      finishedAt: data.session.todayReview.finishedAt || 0,
      canStart: activePlanItems().length === 0 && sourceIds.length > 0,
      misses: Object.values(misses).reduce((sum, value) => sum + value, 0),
      hard: Object.values(hard).reduce((sum, value) => sum + value, 0)
    };
  }

  function isTodayReviewWord(word) {
    if (!word) return false;
    const review = todayReviewState();
    return review.active && data.session.todayReview.queue.includes(word.id);
  }

  function removeFirstReviewOccurrence(queue, wordId) {
    const nextQueue = queue.slice();
    const index = nextQueue.indexOf(wordId);
    if (index !== -1) nextQueue.splice(index, 1);
    return nextQueue;
  }

  function insertTodayReviewRepeats(queue, wordId, count, attempts) {
    const maxAppearances = 8;
    const queuedAppearances = queue.filter((id) => id === wordId).length;
    const allowed = Math.max(0, maxAppearances - attempts - queuedAppearances);
    let nextQueue = queue.slice();
    const repeatCount = Math.min(count, allowed);
    for (let index = 0; index < repeatCount; index += 1) {
      const insertAt = Math.min(nextQueue.length, Math.max(0, (index + 1) * 3 - 1));
      nextQueue = [
        ...nextQueue.slice(0, insertAt),
        wordId,
        ...nextQueue.slice(insertAt)
      ];
    }
    return nextQueue;
  }

  function moveToTodayReviewNext(nextQueue, reviewPatch = {}) {
    const review = normalizeTodayReview(data.session.todayReview);
    const nextWord = findWord(nextQueue[0] || '');
    data.session.todayReview = {
      ...review,
      ...reviewPatch,
      date: todayKey(),
      queue: nextQueue,
      startedAt: reviewPatch.startedAt || review.startedAt || now(),
      finishedAt: nextQueue.length ? 0 : (reviewPatch.finishedAt || now())
    };
    applyNavigation(advanceLive(data.navigation, nextWord ? nextWord.id : null), { forceReveal: false });
    save();
  }

  function startTodayReview() {
    refreshDailySession();
    ensureDailyPlan();
    const state = todayReviewState();
    if (!state.total) throw new Error('今天还没有可回顾的已学单词。');
    if (!state.canStart && !state.active) throw new Error('今日计划还没有完成，先把今天背完。');

    const existing = normalizeTodayReview(data.session.todayReview);
    const sourceIds = todayReviewSourceIds().filter((id) => !!findWord(id));
    const queue = state.active
      ? existing.queue.filter((id) => sourceIds.includes(id) && findWord(id))
      : sourceIds.slice();
    data.session.todayReview = {
      ...defaultTodayReview(),
      date: todayKey(),
      sourceIds,
      queue,
      attempts: state.active ? existing.attempts : {},
      misses: state.active ? existing.misses : {},
      hard: state.active ? existing.hard : {},
      startedAt: state.active ? existing.startedAt : now(),
      finishedAt: 0
    };
    const firstWord = findWord(queue[0] || '');
    setCurrent(firstWord, false, false);
    return todayReviewState();
  }

  function rateTodayReviewWord(word, grade) {
    const review = normalizeTodayReview(data.session.todayReview);
    if (!word || !review.queue.includes(word.id)) return false;
    const wordId = word.id;
    const attempts = cleanReviewCounterMap(review.attempts, new Set(review.sourceIds));
    const misses = cleanReviewCounterMap(review.misses, new Set(review.sourceIds));
    const hard = cleanReviewCounterMap(review.hard, new Set(review.sourceIds));
    attempts[wordId] = Math.max(0, Number(attempts[wordId]) || 0) + 1;

    let nextQueue = removeFirstReviewOccurrence(review.queue, wordId);
    if (grade === 'again') {
      misses[wordId] = Math.max(0, Number(misses[wordId]) || 0) + 1;
      nextQueue = insertTodayReviewRepeats(nextQueue, wordId, 3, attempts[wordId]);
    } else if (grade === 'hard') {
      hard[wordId] = Math.max(0, Number(hard[wordId]) || 0) + 1;
      nextQueue = insertTodayReviewRepeats(nextQueue, wordId, 1, attempts[wordId]);
    } else {
      nextQueue = nextQueue.filter((id) => id !== wordId);
    }

    moveToTodayReviewNext(nextQueue, { attempts, misses, hard });
    return true;
  }

  function skipTodayReviewWord(word) {
    const review = normalizeTodayReview(data.session.todayReview);
    if (!word || !review.queue.includes(word.id)) return false;
    const nextQueue = review.queue.slice();
    const currentIndex = nextQueue.indexOf(word.id);
    if (currentIndex !== -1) {
      const [currentId] = nextQueue.splice(currentIndex, 1);
      nextQueue.push(currentId);
    }
    moveToTodayReviewNext(nextQueue);
    return true;
  }

  function remainingPlanCapacity() {
    const target = Math.max(0, Math.floor(Number(data.settings.dailyNew) || 0));
    const completed = completedPlanItemsToday().length;
    const active = activePlanItems().length;
    return Math.max(0, target - completed - active);
  }

  function dueReviewPool(t = now()) {
    const activeIds = activePlanWordIds();
    return data.words
      .filter((word) => isReviewableWord(word) && isReadyForStudy(word, t) && !activeIds.has(word.id))
      .sort(sortByPriority);
  }

  function availableNewWords(query = '') {
    const activeIds = activePlanWordIds();
    const needle = String(query).trim().toLowerCase();
    return data.words
      .filter((word) => word.status === 'new' && wordInBook(word, data.settings.activeBookId) && !activeIds.has(word.id))
      .filter((word) => {
        if (!needle) return true;
        return [word.word, word.meaning, word.phonetic]
          .some((value) => String(value || '').toLowerCase().includes(needle));
      })
      .sort((a, b) => a.word.localeCompare(b.word, 'en'));
  }

  function ensureDailyPlan() {
    refreshDailySession();
    const cleaned = cleanupPlanItems();
    const today = todayKey();
    if (data.session.planDate === today) {
      if (cleaned) save();
      return false;
    }
    data.session.planDate = today;
    data.session.planCompletionToken = '';

    // Due reviews are all included first; the daily target only limits how many new words fill the remaining capacity.
    dueReviewPool().forEach((word) => {
      data.session.planItems.push(makePlanItem(word, 'review', 'initial_due'));
    });
    const target = Math.max(0, Number(data.settings.dailyNew) || 0);
    const dueCount = activePlanItems().filter((item) => item.type === 'review').length;
    const roomForNew = Math.max(0, target - dueCount);
    const yesterday = dayKeyFromTime(startOfToday() - DAY);
    const yesterdayEntries = data.studyLog.filter((entry) => entry.date === yesterday);
    const yesterdayActions = yesterdayEntries.reduce((sum, entry) => sum + (entry.actions || 0), 0);
    const yesterdayUncertain = yesterdayEntries.reduce((sum, entry) => sum + (entry.again || 0), 0);
    const newQuota = yesterdayActions && yesterdayUncertain / yesterdayActions >= 0.35
      ? Math.floor(roomForNew * 0.5)
      : roomForNew;
    const plannedIds = new Set(activePlanItems().map((item) => item.wordId));
    data.words
      .filter((word) => word.status === 'new' && wordInBook(word, data.settings.activeBookId) && !plannedIds.has(word.id))
      .sort((a, b) => a.word.localeCompare(b.word, 'en'))
      .slice(0, newQuota)
      .forEach((word) => {
      data.session.planItems.push(makePlanItem(word, 'new', 'automatic_new'));
      });
    resetLearningWindow();
    save();
    return true;
  }

  function completePlanItem(wordId) {
    const item = planItemForWord(wordId);
    if (!item) return null;
    item.status = 'completed';
    item.completedAt = now();
    return item;
  }

  function recordPlanItemRating(wordId, grade) {
    const item = planItemForWord(wordId);
    if (!item) return { completed: false, pendingConfirmation: false };
    const today = todayKey();
    if (grade === 'again' || grade === 'hard') {
      item.uncertainDate = today;
      item.goodAfterUncertainStreak = 0;
      return { completed: false, pendingConfirmation: true };
    }
    if (grade !== 'good' && grade !== 'easy') return { completed: false, pendingConfirmation: false };
    completePlanItem(wordId);
    return { completed: true, pendingConfirmation: false };
  }

  function scheduleInDayLoop(word, grade, resetRepeats = false) {
    const t = now();
    const isAgain = grade === 'again';
    const defaultRepeats = isAgain ? IN_DAY_AGAIN_REPEATS : IN_DAY_HARD_REPEATS;
    const existingRepeats = word.dayLoopDate === todayKey() ? Number(word.dayLoopRemaining) || 0 : 0;
    const remaining = resetRepeats || existingRepeats <= 0 ? defaultRepeats : Math.max(0, existingRepeats - 1);
    return {
      ...word,
      dayLoopDate: remaining > 0 ? todayKey() : '',
      dayLoopDue: remaining > 0 ? t + (isAgain ? IN_DAY_AGAIN_INTERVAL : IN_DAY_HARD_INTERVAL) : 0,
      dayLoopCardsBefore: remaining > 0 ? (isAgain ? 2 : 1) : 0,
      dayLoopPriority: remaining > 0 ? (isAgain ? 3 : 2) : 0,
      dayLoopRemaining: remaining,
      updatedAt: t
    };
  }

  function cancelActivePlanItems(wordIds) {
    const ids = new Set(Array.isArray(wordIds) ? wordIds : [wordIds]);
    data.session.planItems.forEach((item) => {
      if (ids.has(item.wordId) && item.status !== 'completed') item.status = 'cancelled';
    });
  }

  function removePlanItems(wordIds) {
    const ids = new Set(Array.isArray(wordIds) ? wordIds : [wordIds]);
    data.session.planItems = data.session.planItems.filter((item) => !ids.has(item.wordId));
  }

  function addWordsToPlan(wordIds, type, source) {
    ensureDailyPlan();
    const ids = new Set((Array.isArray(wordIds) ? wordIds : []).map(String));
    const existing = activePlanWordIds();
    let added = 0;
    if (type === 'new' && source !== 'automatic_new') {
      activePlanItems()
        .filter((item) => ids.has(item.wordId) && item.type === 'new' && item.source === 'automatic_new')
        .forEach((item) => {
          item.source = source;
          added += 1;
        });
    }
    let capacity = remainingPlanCapacity();
    if (capacity <= 0 && type === 'new' && source !== 'automatic_new') {
      const requested = [...ids].filter((id) => !existing.has(id)).length;
      if (requested > 0) {
        const automaticItems = activePlanItems()
          .filter((item) => item.type === 'new' && item.source === 'automatic_new')
          .slice(-requested);
        automaticItems.forEach((item) => { item.status = 'cancelled'; });
        if (automaticItems.length) capacity = remainingPlanCapacity();
      }
    }
    if (capacity <= 0) return { added, plan: planSnapshot() };
    data.words.forEach((word) => {
      if (added >= capacity) return;
      if (!ids.has(word.id) || existing.has(word.id)) return;
      if (type === 'new' && word.status !== 'new') return;
      if (type === 'new' && !wordInBook(word, data.settings.activeBookId)) return;
      if (type === 'review' && !isReviewableWord(word)) return;
      data.session.planItems.push(makePlanItem(word, type, source));
      existing.add(word.id);
      added += 1;
    });
    if (added) {
      resetLearningWindow();
      fillLearningWindow();
      save();
    }
    return { added, plan: planSnapshot() };
  }

  function addDueReviews(count) {
    ensureDailyPlan();
    const amount = Math.max(0, Math.floor(Number(count) || 0));
    const pool = dueReviewPool().slice(0, amount || dueReviewPool().length);
    return addWordsToPlan(pool.map((word) => word.id), 'review', 'manual_review');
  }

  function sampleNewWords(count, query = '') {
    ensureDailyPlan();
    const amount = Math.min(remainingPlanCapacity(), Math.max(0, Math.floor(Number(count) || 0)));
    if (amount <= 0) return [];
    const pool = availableNewWords(query);
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [pool[index], pool[randomIndex]] = [pool[randomIndex], pool[index]];
    }
    return pool.slice(0, amount).map(publicWord);
  }

  function planSnapshot() {
    ensureDailyPlan();
    const items = activePlanItems();
    const activeNew = items.filter((item) => item.type === 'new');
    const activeReview = items.filter((item) => item.type === 'review');
    const completedNew = completedPlanItemsToday('new');
    const completedReview = completedPlanItemsToday('review');
    const completed = completedNew.length + completedReview.length;
    const carried = items.filter((item) => item.addedDate !== todayKey()).length;
    const dueLeft = dueReviewPool().length;
    const availableNew = availableNewWords().length;
    return {
      date: todayKey(),
      target: Number(data.settings.dailyNew) || 0,
      active: items.length,
      completed,
      remainingCapacity: remainingPlanCapacity(),
      complete: items.length === 0,
      carried,
      remainingDuePool: dueLeft,
      availableNew,
      newWords: {
        target: activeNew.length + completedNew.length,
        completed: completedNew.length,
        remaining: activeNew.length
      },
      reviews: {
        target: activeReview.length + completedReview.length,
        completed: completedReview.length,
        remaining: activeReview.length
      }
    };
  }

  function stats() {
    refreshDailySession();
    const t = now();
    const windowWords = fillLearningWindow();
    const todayEnd = startOfToday() + DAY;
    const allReviewWords = data.words.filter(isReviewableWord);
    const dueWords = allReviewWords.filter((word) => isReadyForStudy(word, t));
    const plannedIds = activePlanWordIds();
    const unplannedDueWords = dueWords.filter((word) => !plannedIds.has(word.id));
    const due = dueWords.length;
    const wrong = dueWords.filter((word) => word.wrongCount > 0).length;
    const fresh = availableNewWords().length;
    const learning = data.words.filter(hasActiveDayLoop).length;
    const todayDue = allReviewWords.filter((w) => (w.due || 0) > t && (w.due || 0) <= todayEnd).length;
    const activeFreshTotal = data.words.filter((w) => w.status === 'new' && wordInBook(w, data.settings.activeBookId)).length;
    const bookProgress = activeBookProgress();
    const reviewDebt = unplannedDueWords.length;
    const urgentDebt = unplannedDueWords.filter((word) => word.status === 'learning' || stubbornness(word) >= 4 || overdueWeight(word, t) >= 1);
    const urgentDebtIds = new Set(urgentDebt.map((word) => word.id));
    const regularDebt = unplannedDueWords.filter((word) => !urgentDebtIds.has(word.id));
    const stageDistribution = Array.from({ length: 10 }, (_value, index) => ({
      stage: index,
      label: stageText(index),
      count: allReviewWords.filter((word) => Math.max(0, Math.min(9, word.memoryStage || 0)) === index).length
    }));
    const nextDue = data.words
      .filter((w) => isReviewableWord(w) && (w.due || 0) > t)
      .sort((a, b) => (a.due || 0) - (b.due || 0))[0];
    const plan = planSnapshot();
    return {
      total: data.words.length,
      due,
      wrong,
      fresh,
      learning,
      favorite: data.words.filter((w) => w.favorite).length,
      done: data.words.filter((w) => w.status === 'done').length,
      nextDueLabel: nextDue ? dueText(nextDue.due) : '无',
      todayDue,
      activeNewLeft: fresh,
      dailyNewLeft: Math.max(0, data.settings.dailyNew - plan.active),
      reviewDebt,
      dailyPlan: {
        ...plan,
        shortLoops: { active: learning, due: dueWords.filter(isLoopReady).length },
        window: { total: windowWords.length, size: data.settings.learningWindowSize }
      },
      todayReview: todayReviewState(),
      debt: {
        urgent: urgentDebt.length,
        regular: regularDebt.length,
        loops: unplannedDueWords.filter((word) => word.status === 'learning').length,
        nextDueLabel: nextDue ? dueText(nextDue.due) : '无'
      },
      learningStages: {
        new: activeFreshTotal,
        stages: stageDistribution
      },
      studySummary: studySummary(),
      studyWindow: {
        size: data.settings.learningWindowSize,
        total: windowWords.length,
        new: windowWords.filter((word) => word.status === 'new').length,
        review: windowWords.filter((word) => word.status !== 'new').length
      },
      planText: `今日计划 ${plan.active} 个进行中，待复习池 ${reviewDebt} 个，新词需手动加入`,
      activeBook: data.books.find((book) => book.id === data.settings.activeBookId) || data.books[0]
    };
  }

  function sortByPriority(a, b) {
    if (hasActiveDayLoop(a) && !hasActiveDayLoop(b)) return -1;
    if (hasActiveDayLoop(b) && !hasActiveDayLoop(a)) return 1;
    if (a.status === 'learning' && b.status !== 'learning') return -1;
    if (a.status !== 'learning' && b.status === 'learning') return 1;
    const scoreA = priorityScore(a);
    const scoreB = priorityScore(b);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (a.due || 0) - (b.due || 0);
  }

  function priorityScore(word) {
    if (hasActiveDayLoop(word)) return 20 + (word.dayLoopPriority || 0) * 4;
    const retention = estimateRetention(word);
    const forgottenRisk = word.status === 'new' ? 0 : (100 - retention) / 20;
    const overdue = Math.min(6, overdueWeight(word));
    const stubborn = Math.min(8, stubbornness(word));
    const loop = word.status === 'learning' ? 10 : 0;
    return loop + overdue * 2 + stubborn * 1.4 + forgottenRisk;
  }

  function hasActiveDayLoop(word) {
    return word.dayLoopDate === todayKey() && (word.dayLoopRemaining || 0) > 0;
  }

  function isLoopReady(word, t) {
    return hasActiveDayLoop(word)
      && (word.dayLoopDue || 0) <= t
      && (word.dayLoopCardsBefore || 0) <= 0;
  }

  function tickSmallLoops(excludeId) {
    data.words = data.words.map((word) => {
      if (word.id === excludeId || !hasActiveDayLoop(word) || (word.dayLoopCardsBefore || 0) <= 0) return word;
      return { ...word, dayLoopCardsBefore: word.dayLoopCardsBefore - 1 };
    });
  }

  function canLearnNew() {
    refreshDailySession();
    return activeBookProgress().newLearned < data.settings.dailyNew;
  }

  function isBookWord(word) {
    return wordInBook(word, data.settings.activeBookId);
  }

  function isReviewableWord(word) {
    return word.status !== 'new' && word.status !== 'done';
  }

  function isStudyWord(word) {
    return word && word.status !== 'done' && activePlanWordIds().has(word.id);
  }

  function isActiveWord(word) {
    return isStudyWord(word);
  }

  function isReadyForStudy(word, t) {
    if (hasActiveDayLoop(word)) return isLoopReady(word, t);
    return word.status !== 'new' && (word.due || 0) <= t;
  }

  function resetLearningWindow() {
    data.session.windowIds = [];
    data.session.windowDate = todayKey();
    data.session.windowBookId = data.settings.activeBookId;
  }

  function learningWindow() {
    refreshDailySession();
    ensureDailyPlan();
    if (data.session.windowDate !== todayKey()) resetLearningWindow();

    const validIds = activePlanWordIds();
    data.session.windowIds = [...new Set(data.session.windowIds)].filter((id) => validIds.has(id));
    return data.session.windowIds;
  }

  function fillLearningWindow() {
    const t = now();
    learningWindow();
    const size = data.settings.learningWindowSize;
    const byId = new Map(data.words.map((word) => [word.id, word]));
    const itemByWordId = new Map(activePlanItems().map((item) => [item.wordId, item]));
    const plannedWords = [...itemByWordId.keys()]
      .map((id) => byId.get(id))
      .filter((word) => word && word.status !== 'done');
    const readyReviews = plannedWords
      .filter((word) => word.status !== 'new' && isReadyForStudy(word, t))
      .sort(sortByPriority);
    const newWords = plannedWords
      .filter((word) => word.status === 'new')
      .sort((a, b) => (itemByWordId.get(a.id).addedAt || 0) - (itemByWordId.get(b.id).addedAt || 0));
    const waitingReviews = plannedWords
      .filter((word) => word.status !== 'new' && !hasActiveDayLoop(word) && !isReadyForStudy(word, t))
      .sort((a, b) => (a.due || 0) - (b.due || 0));
    const ids = [];
    [readyReviews, newWords, waitingReviews].forEach((group) => {
      group.forEach((word) => {
        if (ids.length < size && !ids.includes(word.id)) ids.push(word.id);
      });
    });
    data.session.windowIds = ids;
    // Navigation is independent from the learning window. Never clear currentId here.
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function removeFromLearningWindow(id) {
    data.session.windowIds = learningWindow().filter((item) => item !== id);
  }

  function chooseNext(excludeId = null) {
    refreshDailySession();
    const t = now();
    const available = (w) => w.id !== excludeId && isStudyWord(w);
    const windowWords = fillLearningWindow().filter(available);
    const dueWrong = windowWords
      .filter((w) => w.wrongCount > 0 && isReadyForStudy(w, t))
      .sort(sortByPriority);
    if (dueWrong[0]) return dueWrong[0];

    const dueReview = windowWords
      .filter((w) => isReadyForStudy(w, t))
      .sort(sortByPriority);
    if (dueReview[0]) return dueReview[0];

    const fresh = windowWords.find((w) => w.status === 'new');
    if (fresh) return fresh;

    const upcoming = windowWords
      .filter((w) => w.status !== 'new')
      .sort((a, b) => (a.due || 0) - (b.due || 0));
    return upcoming[0] || null;
  }

  function currentWord() {
    data.navigation = defaultNavigation(data.navigation);
    const viewedId = viewWordId(data.navigation);
    let word = viewedId ? data.words.find((w) => w.id === viewedId) : null;

    // Browsing history/manual always shows that word if it still exists.
    if (isBrowsing(data.navigation)) {
      if (word) {
        data.currentId = word.id;
        return word;
      }
      // Stale browse target: drop back to live frontier.
      applyNavigation(returnToLive(data.navigation), { keepReveal: true });
    }

    word = data.navigation.liveWordId
      ? data.words.find((w) => w.id === data.navigation.liveWordId)
      : null;
    const isTodayReview = isTodayReviewWord(word);
    if (!word || (!isStudyWord(word) && !isTodayReview)) {
      const review = todayReviewState();
      word = review.active ? findWord(data.session.todayReview.queue[0]) : chooseNext();
      applyNavigation(setLive(data.navigation, word ? word.id : null), { forceReveal: false });
      saveSoon();
    } else {
      data.currentId = word.id;
    }
    return word || null;
  }

  function setCurrent(word, keepReveal = false, manualPreview = false, deferred = false) {
    if (manualPreview && word) {
      applyNavigation(enterManual(data.navigation, word.id), {
        keepReveal,
        forceReveal: keepReveal ? undefined : false
      });
    } else {
      applyNavigation(advanceLive(data.navigation, word ? word.id : null), {
        keepReveal,
        forceReveal: keepReveal ? undefined : false
      });
    }
    if (keepReveal) {
      // leave data.revealed as-is
    }
    if (deferred) saveSoon();
    else save();
  }

  function publicWord(word) {
    if (!word) return null;
    const isTodayReview = data.session.todayReview
      && data.session.todayReview.date === todayKey()
      && data.session.todayReview.startedAt
      && !data.session.todayReview.finishedAt
      && (data.session.todayReview.queue || []).includes(word.id);
    const queueLabel = data.session.manualPreviewId === word.id
      ? '手动回顾'
      : isTodayReview
      ? '今日回顾'
      : word.status === 'new'
      ? '新词'
      : word.status === 'learning'
          ? '短循环'
          : stubbornness(word) > 0
            ? '错词复习'
          : '到期复习';
    const retention = estimateRetention(word);
    const overdue = overdueWeight(word);
    return {
      ...word,
      dueLabel: dueText(word.due),
      queueLabel,
      stageLabel: stageText(word.memoryStage),
      retention,
      overdueRatio: Number(overdue.toFixed(2)),
      stubbornness: stubbornness(word),
      priority: Number(priorityScore(word).toFixed(2))
    };
  }

  function listWords(query = '', options = {}) {
    const needle = String(query).trim().toLowerCase();
    const scope = options && options.scope === 'records' ? 'records' : 'book';
    const filter = String(options && options.filter || 'all');
    const letter = String(options && options.letter || '').trim().toUpperCase();
    const pageSize = Math.max(10, Math.min(100, Math.floor(Number(options && options.pageSize) || 50)));
    const requestedPage = Math.max(1, Math.floor(Number(options && options.page) || 1));
    const t = now();
    const matchesFilter = (word) => {
      if (filter === 'new') return word.status === 'new';
      if (filter === 'wrong') return word.wrongCount > 0 || word.hardCount > 0 || word.lapseCount > 0;
      if (filter === 'favorite') return word.favorite;
      if (filter === 'done') return word.status === 'done';
      if (filter === 'learning') return word.status === 'learning';
      if (filter === 'loopDue') return word.status === 'learning' && isReadyForStudy(word, t);
      if (filter === 'due') return word.status !== 'new' && word.status !== 'done' && isReadyForStudy(word, t);
      if (filter === 'regular') return word.status !== 'new' && word.status !== 'done' && isReadyForStudy(word, t)
        && word.status !== 'learning' && stubbornness(word) < 4 && overdueWeight(word, t) < 1;
      if (filter === 'debt') return word.status !== 'new' && word.status !== 'done' && isReadyForStudy(word, t)
        && (word.status === 'learning' || stubbornness(word) >= 4 || overdueWeight(word, t) >= 1);
      return true;
    };
    const matching = data.words
      .filter((word) => {
        if (scope === 'records') {
          if (!hasLearningRecord(word)) return false;
        } else if (!isBookWord(word)) return false;
        if (!matchesFilter(word)) return false;
        if (!needle) return true;
        return [word.word, word.meaning, word.phonetic]
          .some((value) => String(value || '').toLowerCase().includes(needle));
      })
      .filter((word) => {
        if (needle || !letter) return true;
        const initial = String(word.word || '').trim().charAt(0).toUpperCase();
        return letter === '#' ? !/[A-Z]/.test(initial) : initial === letter;
      })
      .sort((a, b) => {
        if (scope === 'records') return (a.due || Infinity) - (b.due || Infinity);
        return a.word.localeCompare(b.word, 'en');
      });
    const total = matching.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, pages);
    const start = (page - 1) * pageSize;
    return {
      items: matching.slice(start, start + pageSize).map((word) => publicWord(word)),
      total,
      page,
      pages,
      pageSize
    };
  }

  function listBooks() {
    const t = now();
    const visibleBooks = data.books.filter((book) => {
      if (book.id === data.settings.activeBookId) return true;
      if (data.books.length <= 1) return true;
      return data.words.some((word) => wordInBook(word, book.id));
    });
    return visibleBooks.map((book) => {
      const words = data.words.filter((word) => wordInBook(word, book.id));
      const progress = bookProgressFor(book.id);
      const total = words.length;
      const fresh = words.filter((word) => word.status === 'new').length;
      const due = words.filter((word) => word.status !== 'new' && word.status !== 'done' && isReadyForStudy(word, t)).length;
      const learned = words.filter((word) => word.status !== 'new').length;
      return {
        ...book,
        total,
        fresh,
        due,
        learning: words.filter((word) => word.status === 'learning').length,
        mastered: words.filter((word) => word.status === 'done').length,
        learned,
        progress: total ? Math.round((learned / total) * 100) : 0,
        today: progress,
        active: book.id === data.settings.activeBookId
      };
    });
  }

  function findWord(id) {
    return data.words.find((word) => word.id === id);
  }

  return {
    getState() {
      const word = currentWord();
      return {
        word: publicWord(word),
        revealed: data.revealed,
        settings: data.settings,
        books: listBooks(),
        stats: stats(),
        session: data.session,
        storage: {
          type: 'sqlite',
          path: persistence.dbPath,
          mirrorPath: persistence.mirrorPath,
          backupDirectory: data.settings.backupDirectory || '',
          customBackupPath: persistence.getCustomBackupPath(),
          snapshotsDir: persistence.snapshotsDir,
          snapshots: persistence.listSnapshots().slice(0, 20)
        },
        shortcuts: [
          ['Alt+A', '上一个'],
          ['Alt+S', '发音'],
          ['Alt+D', '下一个'],
          ['Alt+Z', '不认识'],
          ['Alt+X', '模糊'],
          ['Alt+C', '认识'],
          ['Alt+V', '熟知'],
          ['Alt+Q', '老板键'],
          ['Alt+W', '查单词'],
          ['Alt+E', '显示弹窗'],
          ['Alt+R', '不再出现'],
          ['Alt+F', '看答案']
        ]
      };
    },
    reveal() {
      data.revealed = !data.revealed;
      saveSoon();
    },
    startTodayReview() {
      return startTodayReview();
    },
    rate(grade) {
      if (!['again', 'hard', 'good', 'easy'].includes(grade)) return;
      const word = currentWord();
      if (!word) return;
      // Browsing (history/manual) never mutates long-term schedule; just return to live frontier.
      if (isBrowsing(data.navigation)) {
        const review = todayReviewState();
        const live = findWord(data.navigation.liveWordId)
          || (review.active ? findWord(data.session.todayReview.queue[0]) : chooseNext(word.id));
        applyNavigation(returnToLive(data.navigation, live ? live.id : null), { forceReveal: false });
        save();
        return;
      }
      if (isTodayReviewWord(word)) {
        rateTodayReviewWord(word, grade);
        return;
      }
      const beforeStatus = word.status;
      const longTermRating = word.longTermRatingDate !== todayKey();
      let rated;
      if (longTermRating) {
        rated = rateWord(word, grade);
        const nextDay = startOfToday() + DAY;
        const adjustedInterval = Math.max(0, (rated.due || nextDay) - now());
        const difficultyFactor = 5 / Math.max(1, Number(rated.wordDifficulty || word.wordDifficulty) || 5);
        const memoryAdjusted = Math.max(DAY, Math.round(adjustedInterval * data.settings.userMemoryCoeff * difficultyFactor));
        rated = {
          ...rated,
          interval: memoryAdjusted,
          due: now() + memoryAdjusted,
          buriedUntil: 0,
          loopCardsLeft: 0,
          longTermRatingDate: todayKey(),
          longTermGrade: grade
        };
      } else if (grade === 'again' || grade === 'hard') {
        rated = scheduleInDayLoop(word, grade);
      } else {
        rated = {
          ...word,
          dayLoopDate: '',
          dayLoopDue: 0,
          dayLoopCardsBefore: 0,
          dayLoopPriority: 0,
          dayLoopRemaining: 0,
          updatedAt: now()
        };
      }
      const idx = data.words.findIndex((w) => w.id === word.id);
      data.words[idx] = rated;
      if (longTermRating && beforeStatus === 'new') data.session.newLearned += 1;
      if (longTermRating && beforeStatus !== 'new') data.session.reviewed += 1;
      if (longTermRating && (grade === 'again' || grade === 'hard')) data.session.again += 1;
      const progress = activeBookProgress();
      if (longTermRating && beforeStatus === 'new') progress.newLearned += 1;
      if (longTermRating && beforeStatus !== 'new') progress.reviewed += 1;
      if (longTermRating && (grade === 'again' || grade === 'hard')) progress.again += 1;
      recordBookProgress(progress);
      recordStudyEvent(beforeStatus, grade, longTermRating);
      if (longTermRating) refreshUserMemoryCoeff();
      const planResult = recordPlanItemRating(word.id, grade);
      if ((grade === 'again' || grade === 'hard') && planResult.pendingConfirmation) {
        rated = scheduleInDayLoop(rated, grade, true);
        data.words[idx] = rated;
      }
      if (planResult.completed) {
        removeFromLearningWindow(word.id);
      }
      tickSmallLoops(word.id);
      fillLearningWindow();
      setCurrent(chooseNext(word.id));
    },
    skip() {
      const word = currentWord();
      if (isBrowsing(data.navigation)) {
        const stepped = goNext(data.navigation);
        if (!stepped.atLive) {
          applyNavigation(stepped.nav, { forceReveal: true });
          saveSoon();
          return;
        }
        const review = todayReviewState();
        const live = findWord(stepped.nav.liveWordId)
          || (review.active ? findWord(data.session.todayReview.queue[0]) : chooseNext(word && word.id));
        applyNavigation(returnToLive(stepped.nav, live ? live.id : null), { forceReveal: false });
        saveSoon();
        return;
      }
      if (isTodayReviewWord(word)) {
        skipTodayReviewWord(word);
        return;
      }
      const liveId = data.navigation.liveWordId || (word && word.id) || null;
      tickSmallLoops(liveId);
      setCurrent(chooseNext(liveId), false, false, true);
    },
    previous() {
      let nav = defaultNavigation(data.navigation);
      for (let guard = 0; guard < 64; guard += 1) {
        const beforeId = viewWordId(nav);
        const beforeMode = nav.mode;
        const beforeIndex = nav.index;
        const candidate = goPrevious(nav);
        const candidateId = viewWordId(candidate);
        if (
          !candidateId
          || (candidateId === beforeId && candidate.mode === beforeMode && candidate.index === beforeIndex)
        ) {
          return;
        }
        if (findWord(candidateId)) {
          applyNavigation(candidate, { forceReveal: true });
          save();
          return;
        }
        // Skip deleted/missing trail entries without getting stuck.
        nav = removeWord(candidate, candidateId);
      }
    },
    toggleFavorite() {
      const word = currentWord();
      if (!word) return;
      word.favorite = !word.favorite;
      word.updatedAt = now();
      save();
    },
    dismissCurrent() {
      const word = currentWord();
      if (!word) return;
      if (isTodayReviewWord(word)) {
        skipTodayReviewWord(word);
        return;
      }
      const index = data.words.findIndex((item) => item.id === word.id);
      data.words[index] = { ...word, status: 'done', updatedAt: now() };
      cancelActivePlanItems(word.id);
      removeFromLearningWindow(word.id);
      fillLearningWindow();
      setCurrent(chooseNext(word.id));
    },
    updateSettings(patch) {
      const incomingStripAppearance = Object.prototype.hasOwnProperty.call(patch, 'stripAppearance')
        ? normalizeStripAppearance(
          patch.stripAppearance && typeof patch.stripAppearance === 'object'
            ? { ...data.settings.stripAppearance, ...patch.stripAppearance }
            : defaultStripAppearance(),
          data.settings.stripAppearance
        )
        : data.settings.stripAppearance;
      data.settings = { ...data.settings, ...patch };
      data.settings.learningWindowSize = Math.max(1, Math.min(50, Number(data.settings.learningWindowSize) || 15));
      data.settings.audioVolume = Math.max(0, Math.min(100, Math.round(Number(data.settings.audioVolume) || 0)));
      data.settings.backupDirectory = String(data.settings.backupDirectory || '').trim();
      data.settings.stripAppearance = normalizeStripAppearance(incomingStripAppearance, data.settings.stripAppearance);
      if (!data.books.some((book) => book.id === data.settings.activeBookId)) data.settings.activeBookId = data.books[0].id;
      if (Object.prototype.hasOwnProperty.call(patch, 'learningWindowSize')) {
        data.session.windowIds = learningWindow().slice(0, data.settings.learningWindowSize);
        fillLearningWindow();
      }
      save();
    },
    backupTo(targetPath) {
      return persistence.backupTo(targetPath);
    },
    listSnapshots() {
      return persistence.listSnapshots();
    },
    createSnapshot(options = {}) {
      // Flush current memory first so the restore point includes latest study state.
      save();
      return persistence.createSnapshot({
        kind: options.kind || 'manual',
        label: options.label || '手动恢复点',
        force: !!options.force
      });
    },
    restoreSnapshot(id) {
      // Persist current memory first so pre-restore safety snapshot is complete.
      save();
      const result = persistence.restoreSnapshot(id);
      data = normalizeData(result.data || persistence.loadData());
      // Keep restored bytes as-is unless schema normalization changed versioned fields.
      if (Number(result.data && result.data.version) !== data.version) save();
      return {
        restored: result.restored,
        state: this.getState()
      };
    },
    importWords(records) {
      const clean = [];
      let attached = 0;
      records
        .map((record, index) => createWord(record, index))
        .filter((word) => word.word)
        .forEach((word) => {
          const existingIndex = data.words.findIndex((item) => item.word.toLowerCase() === word.word.toLowerCase());
          if (existingIndex === -1) {
            clean.push({ ...word, bookId: data.settings.activeBookId, bookIds: [data.settings.activeBookId] });
            return;
          }
          const existing = data.words[existingIndex];
          if (!wordInBook(existing, data.settings.activeBookId)) attached += 1;
          data.words[existingIndex] = attachWordToBook({
            ...existing,
            meaning: existing.meaning || word.meaning,
            phonetic: existing.phonetic || word.phonetic,
            sentence: existing.sentence || word.sentence
          }, data.settings.activeBookId);
        });
      data.words.push(...clean);
      save();
      return { added: clean.length, attached, total: records.length, activeBookId: data.settings.activeBookId };
    },
    listWords,
    listBooks,
    listNewWords(query = '') {
      return availableNewWords(query).map(publicWord);
    },
    sampleNewWords,
    addNewWordsToPlan(ids, source = 'manual_new') {
      return addWordsToPlan(ids, 'new', source);
    },
    addReviewWordsToPlan(ids) {
      return addWordsToPlan(ids, 'review', 'manual_review');
    },
    addDueReviews,
    getPlan() {
      return planSnapshot();
    },
    addBook(name) {
      const cleanName = String(name || '').trim();
      if (!cleanName) throw new Error('单词本名称不能为空');
      if (data.books.some((book) => book.name === cleanName)) throw new Error('这个单词本已经存在');
      const book = { id: `book-${Date.now()}`, name: cleanName, createdAt: now(), updatedAt: now() };
      data.books.push(book);
      data.settings.activeBookId = book.id;
      resetLearningWindow();
      data.currentId = null;
      save();
      return book;
    },
    renameBook(id, name) {
      const book = data.books.find((item) => item.id === id);
      if (!book) throw new Error('没有找到这个单词本');
      const cleanName = String(name || '').trim();
      if (!cleanName) throw new Error('单词本名称不能为空');
      book.name = cleanName;
      book.updatedAt = now();
      save();
      return book;
    },
    deleteBook(id) {
      const book = data.books.find((item) => item.id === id);
      if (!book) throw new Error('没有找到这个单词本');
      data.books = data.books.filter((item) => item.id !== id);
      data.words = data.words.map((word) => {
        if (!wordInBook(word, id)) return word;
        const bookIds = (word.bookIds || [word.bookId]).filter((bookId) => bookId && bookId !== id);
        return { ...word, bookId: bookIds[0] || '', bookIds, updatedAt: now() };
      });
      delete data.session.bookProgress[id];
      pruneEmptyBooks({ keepActiveEmpty: false });
      if (data.settings.activeBookId === id) {
        data.settings.activeBookId = data.books[0].id;
        resetLearningWindow();
      }
      save();
      return { deleted: book.name, remainingBooks: listBooks() };
    },
    setActiveBook(id) {
      if (!data.books.some((book) => book.id === id)) throw new Error('没有找到这个单词本');
      data.settings.activeBookId = id;
      fillLearningWindow();
      save();
      return listBooks();
    },
    addWord(record) {
      const candidate = createWord(record, data.words.length);
      candidate.bookId = record.bookId || data.settings.activeBookId;
      candidate.bookIds = [candidate.bookId];
      if (!candidate.word) throw new Error('单词不能为空');
      const duplicateIndex = data.words.findIndex((word) => word.word.toLowerCase() === candidate.word.toLowerCase());
      if (duplicateIndex !== -1) {
        data.words[duplicateIndex] = attachWordToBook(data.words[duplicateIndex], candidate.bookId);
        save();
        return publicWord(data.words[duplicateIndex]);
      }
      data.words.push(candidate);
      save();
      return publicWord(candidate);
    },
    updateWord(id, patch) {
      const index = data.words.findIndex((word) => word.id === id);
      if (index === -1) throw new Error('没有找到这个单词');
      const current = data.words[index];
      const word = String(patch.word ?? current.word).trim();
      if (!word) throw new Error('单词不能为空');
      const duplicate = data.words.find((item) => item.id !== id && item.word.toLowerCase() === word.toLowerCase());
      if (duplicate) throw new Error('这个单词已经在词库中了');
      data.words[index] = normalizeWord({
        ...current,
        word,
        phonetic: String(patch.phonetic ?? current.phonetic).trim(),
        meaning: String(patch.meaning ?? current.meaning).trim(),
        sentence: String(patch.sentence ?? current.sentence).trim(),
        updatedAt: now()
      });
      save();
      return publicWord(data.words[index]);
    },
    deleteWord(id) {
      const word = findWord(id);
      if (!word) throw new Error('没有找到这个单词');
      data.words = data.words.filter((item) => item.id !== id);
      cancelActivePlanItems(id);
      applyNavigation(removeWord(data.navigation, id), { keepReveal: true });
      pruneEmptyBooks({ keepActiveEmpty: true });
      save();
    },
    bulkWords(ids, action, options = {}) {
      const idSet = new Set((Array.isArray(ids) ? ids : []).map(String));
      if (!idSet.size) return { affected: 0 };
      const t = now();
      let affected = 0;
      const targetBookId = String(options.bookId || data.settings.activeBookId);
      const targetExists = data.books.some((book) => book.id === targetBookId);
      if ((action === 'attach-book' || action === 'move-book') && !targetExists) throw new Error('没有找到这个单词本');

      if (action === 'delete') {
        const before = data.words.length;
        data.words = data.words.filter((word) => !idSet.has(word.id));
        affected = before - data.words.length;
        cancelActivePlanItems([...idSet]);
        applyNavigation(removeWords(data.navigation, [...idSet]), { keepReveal: true });
        pruneEmptyBooks({ keepActiveEmpty: true });
        save();
        return { affected };
      }

      data.words = data.words.map((word) => {
        if (!idSet.has(word.id)) return word;
        affected += 1;
        if (action === 'mark-done') {
          cancelActivePlanItems(word.id);
          return { ...word, status: 'done', updatedAt: t };
        }
        if (action === 'mark-new') {
          removePlanItems(word.id);
          return {
            ...word,
            status: 'new',
            interval: 0,
            memoryStage: 0,
            stability: 0,
            difficulty: 5,
            wordDifficulty: word.wordDifficulty || 5,
            fsrsLearningSteps: 0,
            familiarity: 0,
            lapseCount: 0,
            loopCardsLeft: 0,
            due: 0,
            wrongCount: 0,
            hardCount: 0,
            seenCount: 0,
            reviewCount: 0,
            lastReviewedAt: 0,
            buriedUntil: 0,
            longTermRatingDate: '',
            dayLoopDate: '',
            dayLoopDue: 0,
            dayLoopCardsBefore: 0,
            dayLoopPriority: 0,
            dayLoopRemaining: 0,
            updatedAt: t
          };
        }
        if (action === 'favorite') return { ...word, favorite: true, updatedAt: t };
        if (action === 'unfavorite') return { ...word, favorite: false, updatedAt: t };
        if (action === 'attach-book') return attachWordToBook(word, targetBookId);
        if (action === 'move-book') return moveWordFromActiveBook(word, targetBookId);
        affected -= 1;
        return word;
      });
      if (action === 'move-book') pruneEmptyBooks({ keepActiveEmpty: false });
      if (action === 'mark-done') {
        const liveId = data.navigation.liveWordId;
        if (liveId && idSet.has(liveId)) {
          applyNavigation(setLive(data.navigation, null), { keepReveal: true });
        }
      } else {
        const viewed = viewWordId(data.navigation);
        if (viewed && !findWord(viewed)) {
          applyNavigation(returnToLive(data.navigation), { keepReveal: true });
        }
      }
      save();
      return { affected };
    },
    setCurrentWord(id) {
      const word = findWord(id);
      if (!word) throw new Error('没有找到这个单词');
      setCurrent(word, false, true);
      return publicWord(word);
    }
  };
}

module.exports = { createStore };
