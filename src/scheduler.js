const { createEmptyCard, fsrs, Rating, State } = require('ts-fsrs');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const fsrsScheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 3650,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: ['3m', '10m'],
  relearning_steps: ['3m', '10m']
});

const EBBINGHAUS_STEPS = [
  { label: '5分钟', delay: 5 * MINUTE },
  { label: '30分钟', delay: 30 * MINUTE },
  { label: '12小时', delay: 12 * HOUR },
  { label: '1天', delay: DAY },
  { label: '2天', delay: 2 * DAY },
  { label: '4天', delay: 4 * DAY },
  { label: '7天', delay: 7 * DAY },
  { label: '15天', delay: 15 * DAY },
  { label: '30天', delay: 30 * DAY },
  { label: '60天', delay: 60 * DAY }
];

const STABILITY_BANDS = [
  { max: 5 / (24 * 60), label: '短循环' },
  { max: 30 / (24 * 60), label: '半小时' },
  { max: 0.5, label: '半天' },
  { max: 1, label: '1天' },
  { max: 2, label: '2天' },
  { max: 4, label: '4天' },
  { max: 7, label: '7天' },
  { max: 15, label: '15天' },
  { max: 30, label: '30天' },
  { max: Infinity, label: '长期' }
];

function now() {
  return Date.now();
}

function estimateWordDifficulty(word) {
  const text = String(word || '').trim().toLowerCase();
  if (!text) return 5;
  const lengthFactor = Math.min(3.5, Math.max(0, text.length - 5) * 0.42);
  const shapeFactor = /[-']/u.test(text) ? 0.7 : 0;
  const rareLetterFactor = (text.match(/[jqxz]/g) || []).length * 0.35;
  return Math.round(clamp(4 + lengthFactor + shapeFactor + rareLetterFactor, 1, 10) * 10) / 10;
}

function clampStage(stage) {
  return Math.max(0, Math.min(stage, EBBINGHAUS_STEPS.length - 1));
}

function stageInfo(stage) {
  return EBBINGHAUS_STEPS[clampStage(stage)];
}

function msFromDays(days) {
  return Math.max(3 * MINUTE, Math.round(days * DAY));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stageFromStability(stability) {
  const index = STABILITY_BANDS.findIndex((band) => stability <= band.max);
  return index === -1 ? STABILITY_BANDS.length - 1 : index;
}

function stateToStatus(state) {
  if (state === State.New) return 'new';
  if (state === State.Learning || state === State.Relearning) return 'learning';
  return 'review';
}

function statusToState(word) {
  if (word.status === 'new' || !word.reviewCount) return State.New;
  if (word.status === 'learning' && word.lapseCount > 0) return State.Relearning;
  if (word.status === 'learning') return State.Learning;
  return State.Review;
}

function toFsrsCard(word) {
  const current = normalizeWord(word);
  const elapsedDays = current.lastReviewedAt ? Math.max(0, Math.round((now() - current.lastReviewedAt) / DAY)) : 0;
  if (!current.reviewCount && current.status === 'new') {
    const card = createEmptyCard(new Date(current.createdAt || now()));
    card.due = new Date(current.due || current.createdAt || now());
    return card;
  }

  return {
    due: new Date(current.due || now()),
    stability: current.stability || 0,
    difficulty: current.difficulty || 0,
    elapsed_days: elapsedDays,
    scheduled_days: Math.max(0, Math.round((current.interval || 0) / DAY)),
    learning_steps: current.fsrsLearningSteps || 0,
    reps: current.reviewCount || 0,
    lapses: current.lapseCount || 0,
    state: statusToState(current),
    last_review: current.lastReviewedAt ? new Date(current.lastReviewedAt) : undefined
  };
}

function ratingForGrade(grade) {
  if (grade === 'again') return Rating.Again;
  if (grade === 'hard') return Rating.Hard;
  if (grade === 'easy') return Rating.Easy;
  return Rating.Good;
}

function safeNumber(value, fallback, min = 0) {
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

// Momo-style cross-day intervals (days). Only first rating of the day uses these.
const MOMO_GOOD_STEPS = [7, 15, 30, 60, 90, 120, 180, 365];
const MOMO_MAX_DAYS = 365;

function wordStaticDifficulty(current) {
  return clamp(Number(current.wordDifficulty) || estimateWordDifficulty(current.word) || 5, 1, 10);
}

function momoAgainDays(current) {
  // G1 forget: 1-3 days; harder words return sooner.
  const d = wordStaticDifficulty(current);
  if (d >= 7.5) return 1;
  if (d >= 4.5) return 2;
  return 3;
}

function momoHardDays(current) {
  // G2 fuzzy: 3-7 days.
  const d = wordStaticDifficulty(current);
  if (d >= 7.5) return 3;
  if (d >= 4.5) return 5;
  return 7;
}

function momoGoodStepIndex(current, grade) {
  const prev = String(current.longTermGrade || '');
  const existing = Math.max(0, Math.min(MOMO_GOOD_STEPS.length - 1, Math.floor(Number(current.goodStepIndex) || 0)));
  if (grade !== 'good' && grade !== 'easy') return 0;
  if (current.status === 'new' || !current.reviewCount) return 0;
  if (prev === 'again' || prev === 'hard' || !prev) return 0;
  if (prev === 'good' || prev === 'easy') {
    return Math.min(MOMO_GOOD_STEPS.length - 1, existing + 1);
  }
  return existing;
}

function momoIntervalDays(current, grade) {
  if (grade === 'again') return momoAgainDays(current);
  if (grade === 'hard') return momoHardDays(current);
  if (grade === 'easy') return MOMO_MAX_DAYS;
  const step = momoGoodStepIndex(current, 'good');
  return MOMO_GOOD_STEPS[step] || 7;
}

function buildFallbackSchedule(current, grade, t) {
  // Kept as a pure Momo long-term scheduler (no short-term minute intervals).
  return rateWord(current, grade, t);
}

function repairedFsrsCard(current, t) {
  const card = toFsrsCard(current);
  card.due = new Date(Math.max(safeNumber(card.due && card.due.getTime(), t), t));
  card.stability = safeNumber(card.stability, 0.1, 0.01);
  card.difficulty = clamp(safeNumber(card.difficulty, 5, 1), 1, 10);
  card.elapsed_days = safeNumber(card.elapsed_days, 0, 0);
  card.scheduled_days = safeNumber(card.scheduled_days, 0, 0);
  card.learning_steps = safeNumber(card.learning_steps, 0, 0);
  card.reps = safeNumber(card.reps, current.reviewCount || 0, 0);
  card.lapses = safeNumber(card.lapses, current.lapseCount || 0, 0);
  if (card.last_review && card.last_review.getTime() > t) card.last_review = new Date(t);
  return card;
}

function nextFsrsCard(current, grade, t) {
  const rating = ratingForGrade(grade);
  try {
    return fsrsScheduler.next(toFsrsCard(current), new Date(t), rating).card;
  } catch {
    try {
      return fsrsScheduler.next(repairedFsrsCard(current, t), new Date(t), rating).card;
    } catch {
      return null;
    }
  }
}

function createWord(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const word = typeof raw === 'string' ? raw : source.word || '';
  const meaning = typeof raw === 'string' ? '' : source.meaning || '';
  const phonetic = typeof raw === 'string' ? '' : source.phonetic || '';
  const sentence = typeof raw === 'string' ? '' : source.sentence || '';
  const cleanWord = String(word || '').trim();
  return {
    id: `${cleanWord.toLowerCase()}-${Date.now()}-${index}`,
    word: cleanWord,
    meaning: String(meaning || '').trim(),
    phonetic: String(phonetic || '').trim(),
    sentence: String(sentence || '').trim(),
    status: 'new',
    interval: 0,
    ease: 2.35,
    memoryStage: 0,
    stability: 0,
    difficulty: 5,
    wordDifficulty: Number.isFinite(Number(source.wordDifficulty)) ? Number(source.wordDifficulty) : estimateWordDifficulty(cleanWord),
    fsrsState: State.New,
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
    favorite: false,
    buriedUntil: 0,
    longTermRatingDate: '',
    longTermGrade: '',
    goodStepIndex: 0,
    weakTag: false,
    masterTag: false,
    dayLoopDate: '',
    dayLoopDue: 0,
    dayLoopCardsBefore: 0,
    dayLoopPriority: 0,
    dayLoopRemaining: 0,
    createdAt: now(),
    updatedAt: now()
  };
}

function normalizeWord(word) {
  const merged = {
    memoryStage: 0,
    stability: 0,
    difficulty: 5,
    fsrsState: State.New,
    fsrsLearningSteps: 0,
    familiarity: 0,
    lapseCount: 0,
    loopCardsLeft: 0,
    interval: 0,
    ease: 2.35,
    wrongCount: 0,
    hardCount: 0,
    seenCount: 0,
    reviewCount: 0,
    lastReviewedAt: 0,
    favorite: false,
    buriedUntil: 0,
    longTermRatingDate: '',
    longTermGrade: '',
    goodStepIndex: 0,
    weakTag: false,
    masterTag: false,
    dayLoopDate: '',
    dayLoopDue: 0,
    dayLoopCardsBefore: 0,
    dayLoopPriority: 0,
    dayLoopRemaining: 0,
    wordDifficulty: estimateWordDifficulty(word && word.word),
    ...word
  };
  if (merged.masterTag || merged.status === 'done') {
    merged.status = 'done';
    merged.masterTag = true;
  }
  return merged;
}

function rateWord(word, grade, at = now()) {
  const t = at;
  const current = normalizeWord(word);
  const seenCount = (current.seenCount || 0) + 1;
  const reviewCount = (current.reviewCount || 0) + 1;
  const d = wordStaticDifficulty(current);

  // G4 熟知: permanent master, stop all future pushes.
  if (grade === 'easy') {
    return {
      ...current,
      status: 'done',
      masterTag: true,
      weakTag: false,
      stability: Math.max(Number(current.stability) || 0, MOMO_MAX_DAYS),
      difficulty: clamp((current.difficulty || d) - 0.8, 1, 10),
      memoryStage: STABILITY_BANDS.length - 1,
      goodStepIndex: MOMO_GOOD_STEPS.length - 1,
      interval: 0,
      due: 0,
      fsrsState: State.Review,
      fsrsLearningSteps: 0,
      familiarity: 100,
      loopCardsLeft: 0,
      buriedUntil: 0,
      seenCount,
      reviewCount,
      lastReviewedAt: t,
      longTermGrade: 'easy',
      updatedAt: t
    };
  }

  const daysRaw = momoIntervalDays(current, grade);
  const days = Math.max(1, Math.min(MOMO_MAX_DAYS, daysRaw));
  const interval = msFromDays(days);
  const goodStepIndex = grade === 'good' ? momoGoodStepIndex(current, 'good') : 0;
  let stability = Number(current.stability) || 0;
  let difficulty = clamp(Number(current.difficulty) || d, 1, 10);
  let familiarity = Number(current.familiarity) || 0;
  let status = 'review';
  let weakTag = !!current.weakTag;
  let wrongCount = current.wrongCount || 0;
  let hardCount = current.hardCount || 0;
  let lapseCount = current.lapseCount || 0;

  if (grade === 'again') {
    // G1: S drops hard, short 1-3d interval, mark weak.
    stability = Math.max(0.5, Math.min(days, (stability || days) * 0.35));
    difficulty = clamp(difficulty + 1.1, 1, 10);
    familiarity = clamp((familiarity || 20) * 0.35, 5, 45);
    status = 'learning';
    weakTag = true;
    wrongCount += 1;
    lapseCount += 1;
  } else if (grade === 'hard') {
    // G2: small S growth, 3-7d.
    stability = Math.max(days * 0.8, (stability || 1) * 0.9 + days * 0.15);
    difficulty = clamp(difficulty + 0.45, 1, 10);
    familiarity = clamp((familiarity || 35) * 0.7 + 10, 20, 70);
    status = 'learning';
    weakTag = true;
    wrongCount += 1;
    hardCount += 1;
    lapseCount += 1;
  } else {
    // G3: steady S growth, exponential step ladder.
    stability = Math.max(days, (stability || 1) * 1.35 + days * 0.25);
    difficulty = clamp(difficulty - 0.25, 1, 10);
    familiarity = 82;
    status = 'review';
    if ((current.wrongCount || 0) === 0 && (current.hardCount || 0) === 0) weakTag = false;
  }

  const memoryStage = stageFromStability(Math.max(stability / 30, days / 30));
  return {
    ...current,
    status,
    masterTag: false,
    weakTag,
    stability,
    difficulty,
    memoryStage,
    goodStepIndex,
    interval,
    due: t + interval,
    fsrsState: status === 'learning' ? State.Learning : State.Review,
    fsrsLearningSteps: 0,
    familiarity,
    loopCardsLeft: 0,
    buriedUntil: 0,
    wrongCount,
    hardCount,
    lapseCount,
    seenCount,
    reviewCount,
    lastReviewedAt: t,
    longTermGrade: grade,
    updatedAt: t
  };
}

function stageText(stage) {
  const safe = clampStage(stage || 0);
  return `${safe + 1}/${STABILITY_BANDS.length} · ${STABILITY_BANDS[safe].label}`;
}

function estimateRetention(word, at = now()) {
  const current = normalizeWord(word);
  if (!current.lastReviewedAt || current.status === 'new') return 0;
  try {
    const retention = fsrsScheduler.get_retrievability(toFsrsCard(current), new Date(at), false);
    if (typeof retention === 'number' && Number.isFinite(retention)) {
      return Math.round(clamp(retention * 100, 1, 99));
    }
  } catch {
    // Fall through to the local approximation if a legacy card cannot be read.
  }
  const elapsedDays = Math.max(0, (at - current.lastReviewedAt) / DAY);
  const stability = Math.max(current.stability || 0.1, 0.1);
  return Math.round(clamp(100 * Math.exp(-elapsedDays / stability), 1, 99));
}

function overdueWeight(word, at = now()) {
  const current = normalizeWord(word);
  if (!current.due || current.status === 'new') return 0;
  const overdue = Math.max(0, at - current.due);
  if (!overdue) return 0;
  const interval = Math.max(current.interval || DAY, 3 * MINUTE);
  return overdue / interval;
}

function stubbornness(word) {
  const current = normalizeWord(word);
  return current.wrongCount * 2 + current.hardCount + current.lapseCount;
}

function dueText(due) {
  const diff = due - now();
  if (!due || diff <= 0) return '现在';
  if (diff < HOUR) return `${Math.ceil(diff / MINUTE)}分钟后`;
  if (diff < DAY) return `${Math.ceil(diff / HOUR)}小时后`;
  return `${Math.ceil(diff / DAY)}天后`;
}

module.exports = {
  DAY,
  EBBINGHAUS_STEPS,
  createWord,
  dueText,
  estimateRetention,
  now,
  normalizeWord,
  overdueWeight,
  rateWord,
  stageText,
  toFsrsCard,
  stubbornness
};
