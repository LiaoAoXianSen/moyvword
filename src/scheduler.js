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

// Cross-day intervals (days). Only the first formal rating of the day writes these.
// Same-day reinforcement stays in store.js. Model sketch (Momo-like dual track):
//   Δ ≈ -S * ln(R*) with R*≈0.9, then grade constraints:
//   again: short floor (~1d for weak cards)
//   hard:  >= again, but may also be 1d when stability is still tiny
//   good:  dynamic long jump
// UI may later preview "今日 / N天后"; this module only owns N.
const DYNAMIC_MAX_DAYS = 3650;
const TARGET_RETENTION = 0.9;
const LEGACY_GOOD_STEPS = [1, 3, 7, 15, 30, 60, 90, 120, 180, 365];

function wordStaticDifficulty(current) {
  return clamp(Number(current.wordDifficulty) || estimateWordDifficulty(current.word) || 5, 1, 10);
}

function nextGoodStepIndex(current, grade) {
  const prev = String(current.longTermGrade || '');
  const existing = Math.max(0, Math.min(LEGACY_GOOD_STEPS.length - 1, Math.floor(Number(current.goodStepIndex) || 0)));
  if (grade !== 'good' && grade !== 'easy') return 0;
  if (current.status === 'new' || !current.reviewCount) return 0;
  if (prev === 'again' || prev === 'hard' || !prev) return 0;
  if (prev === 'good' || prev === 'easy') {
    return Math.min(LEGACY_GOOD_STEPS.length - 1, existing + 1);
  }
  return existing;
}

function fsrsScheduledDays(card, t) {
  if (!card) return 0;
  const scheduled = Math.round(Number(card.scheduled_days) || 0);
  if (scheduled > 0) return scheduled;
  const dueTime = card.due instanceof Date ? card.due.getTime() : Number(new Date(card.due).getTime());
  if (Number.isFinite(dueTime) && dueTime > t) {
    return Math.round((dueTime - t) / DAY);
  }
  return 0;
}

// Ideal spacing from stability: Δ = -S * ln(R*).
function daysFromStability(stability) {
  const s = Math.max(0.05, Number(stability) || 0);
  return Math.max(1, Math.round(-s * Math.log(TARGET_RETENTION)));
}

function isWeakCard(current) {
  const stability = Math.max(0, Number(current.stability) || 0);
  const reviews = Math.max(0, Number(current.reviewCount) || 0);
  return current.status === 'new' || reviews <= 0 || stability < 2.5;
}

function fallbackIntervalDays(current, grade) {
  const d = wordStaticDifficulty(current);
  const stability = Math.max(0, Number(current.stability) || 0);
  const weak = isWeakCard(current);

  if (grade === 'again') {
    // Forgotten: brand-new/weak cards return next day; slightly known cards can wait a bit longer.
    if (weak || d >= 7) return 1;
    if (d >= 4.5) return 2;
    return Math.min(3, Math.max(1, Math.round(daysFromStability(Math.max(stability, 1)) * 0.35)));
  }

  if (grade === 'hard') {
    // Uncertain should be >= again. On weak/new cards both often land on 1 day
    // (Momo-style "今日 / 1天后"); once stability grows, hard stretches further.
    if (weak) return 1;
    if (d >= 7.5) return 2;
    if (d >= 4.5) return Math.max(2, Math.min(5, daysFromStability(Math.max(stability, 2))));
    return Math.max(3, Math.min(11, daysFromStability(Math.max(stability, 3))));
  }

  if (grade === 'easy') return DYNAMIC_MAX_DAYS;

  // Good fallback: bend legacy steps by difficulty + stability so mature cards diverge.
  const step = nextGoodStepIndex(current, 'good');
  const legacy = LEGACY_GOOD_STEPS[step] || 7;
  const difficultyFactor = clamp(1 + (5 - d) * 0.08, 0.72, 1.28);
  const fromS = daysFromStability(Math.max(stability, legacy * 0.8));
  return Math.max(1, Math.round(Math.max(legacy, fromS, stability * 1.25) * difficultyFactor));
}

function longTermIntervalDays(current, grade, fsrsCard, t) {
  const fallback = fallbackIntervalDays(current, grade);
  const fsrsDays = fsrsScheduledDays(fsrsCard, t);
  const stability = Math.max(0, Number((fsrsCard && fsrsCard.stability) || current.stability) || 0);
  const fromStability = daysFromStability(stability);
  let raw = fsrsDays > 0 ? fsrsDays : Math.max(fallback, fromStability > 1 ? fromStability : fallback);

  if (grade === 'again') {
    // Same-day relearning is outside this scheduler. Long-term due stays soon.
    const againDays = clamp(Math.round(Math.min(raw, Math.max(fallback, 1))), 1, 14);
    return againDays;
  }

  if (grade === 'hard') {
    // Always hard >= again. Allow 1-day hard for weak cards; do not force a 2-day floor.
    const againFloor = fallbackIntervalDays(current, 'again');
    const hardRaw = Math.max(raw, fallback, againFloor);
    return clamp(Math.round(hardRaw), 1, 90);
  }

  if (grade === 'easy') {
    return DYNAMIC_MAX_DAYS;
  }

  return clamp(Math.round(Math.max(raw, fallback, 1)), 1, DYNAMIC_MAX_DAYS);
}

function buildFallbackSchedule(current, grade, t) {
  // Kept for old callers/tests: a pure long-term scheduler (no short-term minute intervals).
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
      stability: Math.max(Number(current.stability) || 0, DYNAMIC_MAX_DAYS),
      difficulty: clamp((current.difficulty || d) - 0.8, 1, 10),
      memoryStage: STABILITY_BANDS.length - 1,
      goodStepIndex: LEGACY_GOOD_STEPS.length - 1,
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

  const fsrsCard = nextFsrsCard(current, grade, t);
  const days = longTermIntervalDays(current, grade, fsrsCard, t);
  const interval = msFromDays(days);
  const goodStepIndex = grade === 'good' ? nextGoodStepIndex(current, 'good') : 0;
  let stability = Number(fsrsCard && fsrsCard.stability) || Number(current.stability) || 0;
  let difficulty = clamp(Number(fsrsCard && fsrsCard.difficulty) || Number(current.difficulty) || d, 1, 10);
  let familiarity = Number(current.familiarity) || 0;
  let status = 'review';
  let weakTag = !!current.weakTag;
  let wrongCount = current.wrongCount || 0;
  let hardCount = current.hardCount || 0;
  let lapseCount = current.lapseCount || 0;

  if (grade === 'again') {
    // G1: forgotten. Long-term due is soon; same-day reinforcement is separate.
    stability = Math.max(0.5, Math.min(days, stability || days));
    difficulty = clamp(difficulty + 1.1, 1, 10);
    familiarity = clamp((familiarity || 20) * 0.35, 5, 45);
    status = 'learning';
    weakTag = true;
    wrongCount += 1;
    lapseCount += 1;
  } else if (grade === 'hard') {
    // G2: fuzzy. Keep it weak, but let FSRS/per-word history shape the interval.
    stability = Math.max(days * 0.8, stability || days);
    difficulty = clamp(difficulty + 0.45, 1, 10);
    familiarity = clamp((familiarity || 35) * 0.7 + 10, 20, 70);
    status = 'learning';
    weakTag = true;
    wrongCount += 1;
    hardCount += 1;
    lapseCount += 1;
  } else {
    // G3: recognised. Let FSRS/history make mature cards jump further (e.g. 60+ days).
    stability = Math.max(days, stability || days);
    difficulty = clamp(difficulty - 0.25, 1, 10);
    familiarity = 82;
    status = 'review';
    if ((current.wrongCount || 0) === 0 && (current.hardCount || 0) === 0) weakTag = false;
  }

  const memoryStage = stageFromStability(Math.max(stability, days));
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
