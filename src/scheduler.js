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

function buildFallbackSchedule(current, grade, t) {
  const seenCount = (current.seenCount || 0) + 1;
  const reviewCount = (current.reviewCount || 0) + 1;
  const wrongCount = current.wrongCount || 0;
  const hardCount = current.hardCount || 0;
  const lapseCount = current.lapseCount || 0;
  const baseStage = clampStage(current.memoryStage || 0);
  const currentStability = Math.max(current.stability || 0, 0.02);

  let interval;
  let status = 'review';
  let memoryStage = baseStage;
  let stability = currentStability;
  let difficulty = clamp(current.difficulty || 5, 1, 10);
  let familiarity = current.familiarity || 0;
  let loopCardsLeft = 0;

  if (grade === 'again') {
    interval = 3 * MINUTE;
    status = 'learning';
    memoryStage = 0;
    stability = Math.max(0.02, currentStability * 0.35);
    difficulty = clamp(difficulty + 1.2, 1, 10);
    familiarity = clamp((current.familiarity || 20) * 0.35, 5, 45);
    loopCardsLeft = 2;
  } else if (grade === 'hard') {
    interval = 10 * MINUTE;
    status = 'learning';
    memoryStage = Math.max(0, baseStage - 1);
    stability = Math.max(0.05, currentStability * 0.65);
    difficulty = clamp(difficulty + 0.7, 1, 10);
    familiarity = clamp((current.familiarity || 35) * 0.65, 20, 65);
    loopCardsLeft = 3;
  } else {
    const advance = grade === 'easy' ? 2 : 1;
    memoryStage = clampStage(baseStage + advance);
    const stageDelay = stageInfo(memoryStage).delay;
    const stabilityBoost = grade === 'easy' ? 1.75 : 1.25;
    stability = Math.max(stageDelay / DAY, currentStability * stabilityBoost);
    interval = Math.max(stageDelay, msFromDays(stability));
    difficulty = clamp(difficulty - (grade === 'easy' ? 0.45 : 0.2), 1, 10);
    familiarity = grade === 'easy' ? 95 : 82;
  }

  return {
    ...current,
    status,
    stability,
    difficulty,
    memoryStage,
    interval,
    due: t + interval,
    fsrsState: status === 'learning' ? State.Learning : State.Review,
    fsrsLearningSteps: status === 'learning' ? Math.min(2, (current.fsrsLearningSteps || 0) + 1) : 0,
    seenCount,
    reviewCount,
    familiarity,
    loopCardsLeft,
    buriedUntil: status === 'learning' ? t + interval : 0,
    wrongCount: wrongCount + (grade === 'again' || grade === 'hard' ? 1 : 0),
    hardCount: hardCount + (grade === 'hard' ? 1 : 0),
    lapseCount: lapseCount + (grade === 'again' || grade === 'hard' ? 1 : 0),
    lastReviewedAt: t,
    updatedAt: t
  };
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
  return {
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
    dayLoopDate: '',
    dayLoopDue: 0,
    dayLoopCardsBefore: 0,
    dayLoopPriority: 0,
    dayLoopRemaining: 0,
    wordDifficulty: estimateWordDifficulty(word && word.word),
    ...word
  };
}

function rateWord(word, grade) {
  const t = now();
  const current = normalizeWord(word);
  const fsrsCard = nextFsrsCard(current, grade, t);
  if (!fsrsCard) return buildFallbackSchedule(current, grade, t);
  const dueTime = fsrsCard.due && fsrsCard.due.getTime();
  if (!Number.isFinite(dueTime) || dueTime <= t) return buildFallbackSchedule(current, grade, t);
  const interval = Math.max(0, dueTime - t);
  const next = {
    ...current,
    status: stateToStatus(fsrsCard.state),
    stability: fsrsCard.stability,
    difficulty: fsrsCard.difficulty,
    memoryStage: stageFromStability(fsrsCard.stability || 0),
    interval,
    due: dueTime,
    fsrsState: fsrsCard.state,
    fsrsLearningSteps: fsrsCard.learning_steps,
    seenCount: current.seenCount + 1,
    reviewCount: fsrsCard.reps,
    lastReviewedAt: fsrsCard.last_review ? fsrsCard.last_review.getTime() : t,
    updatedAt: t
  };

  if (grade === 'again') {
    next.wrongCount += 1;
    next.lapseCount += 1;
    next.familiarity = clamp((current.familiarity || 20) * 0.35, 5, 45);
    next.interval = Math.min(next.interval, 3 * MINUTE);
    next.due = t + next.interval;
    next.loopCardsLeft = 2;
    next.buriedUntil = next.due;
    return next;
  }

  if (grade === 'hard') {
    next.wrongCount += 1;
    next.hardCount += 1;
    next.lapseCount += 1;
    next.familiarity = clamp((current.familiarity || 35) * 0.65, 20, 65);
    next.interval = Math.min(next.interval, 15 * MINUTE);
    next.due = t + next.interval;
    next.loopCardsLeft = 3;
    next.buriedUntil = next.due;
    return next;
  }

  next.familiarity = grade === 'easy' ? 95 : 82;
  next.buriedUntil = 0;
  next.loopCardsLeft = 0;
  return next;
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
