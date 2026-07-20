
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWord, DAY, rateWord, now } = require('../src/scheduler');
const { createStore } = require('../src/store');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}

function days(word) {
  return Math.round((Number(word.interval) || 0) / DAY);
}

function findPublicWord(store, id) {
  return store.listWords('', { scope: 'book', page: 1, pageSize: 100 }).items.find((word) => word.id === id);
}

// Scheduler: mature words should no longer be forced onto one fixed good ladder.
{
  const t = now();
  const young = {
    ...createWord({ word: 'young', meaning: 'young' }, 1),
    status: 'review',
    stability: 8,
    difficulty: 7.5,
    wordDifficulty: 7.5,
    interval: 8 * DAY,
    due: t - DAY,
    reviewCount: 6,
    lastReviewedAt: t - 8 * DAY,
    longTermGrade: 'good',
    goodStepIndex: 2
  };
  const mature = {
    ...createWord({ word: 'mature', meaning: 'mature' }, 2),
    status: 'review',
    stability: 70,
    difficulty: 3.2,
    wordDifficulty: 3.2,
    interval: 70 * DAY,
    due: t - DAY,
    reviewCount: 18,
    lastReviewedAt: t - 70 * DAY,
    longTermGrade: 'good',
    goodStepIndex: 5
  };
  const youngRated = rateWord(young, 'good', t);
  const matureRated = rateWord(mature, 'good', t);
  assert(days(matureRated) > days(youngRated), `dynamic good interval differs by word (${days(youngRated)}d vs ${days(matureRated)}d)`);
  assert(days(matureRated) >= 30, 'mature recognised word can jump to a long interval');
}

// Weak/new cards: hard may share the 1-day floor with again, but never go shorter.
{
  const t = now();
  const fresh = createWord({ word: 'parasitic', meaning: 'adj. parasitic' }, 3);
  const again = rateWord(fresh, 'again', t);
  const hard = rateWord(fresh, 'hard', t);
  assertEq(days(again), 1, 'new again lands on next-day floor');
  assertEq(days(hard), 1, 'new hard can also be next-day (not forced to 2+)');
  assert(days(hard) >= days(again), 'hard interval is never shorter than again');
}

(async () => {
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyv-schedule-loop-'));
    const store = await createStore({ primaryDir: dir, mirrorDir: path.join(dir, 'mirror') });
    const first = store.listWords('', { scope: 'book', page: 1, pageSize: 1 }).items[0];
    store.addNewWordsToPlan([first.id]);

    assertEq(store.getState().word.id, first.id, 'single planned word is current');
    store.rate('again');
    const afterAgain = findPublicWord(store, first.id);
    assertEq(afterAgain.longTermGrade, 'again', 'first again writes long-term grade');
    const longDue = afterAgain.due;
    const longInterval = afterAgain.interval;
    assert(afterAgain.dayLoopRemaining > 0, 'again enters same-day hidden loop');

    store.rate('good');
    const afterGood1 = findPublicWord(store, first.id);
    assertEq(afterGood1.due, longDue, 'same-day good does not rewrite long-term due');
    assertEq(afterGood1.interval, longInterval, 'same-day good does not rewrite long-term interval');
    assert(afterGood1.dayLoopRemaining > 0, 'same-day good can keep reinforcing before completion');

    store.rate('good');
    const afterGood2 = findPublicWord(store, first.id);
    assertEq(afterGood2.due, longDue, 'second same-day good still keeps long-term due');

    store.rate('good');
    const plan = store.getPlan();
    assert(plan.complete, 'hidden progress completes after enough same-day recognition');
  }

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyv-correction-'));
    const store = await createStore({ primaryDir: dir, mirrorDir: path.join(dir, 'mirror') });
    const items = store.listWords('', { scope: 'book', page: 1, pageSize: 2 }).items;
    store.addNewWordsToPlan(items.map((word) => word.id));

    const first = store.getState().word;
    store.rate('good');
    const second = store.getState().word;
    const goodWord = findPublicWord(store, first.id);
    assertEq(goodWord.longTermGrade, 'good', 'baseline first word rated good');

    store.previous();
    assertEq(store.getState().word.id, first.id, 'previous opens immediate correction word');
    store.previous();
    assertEq(store.getState().word.id, first.id, 'previous cannot continue beyond correction word');
    store.rate('hard');

    const corrected = findPublicWord(store, first.id);
    assertEq(corrected.longTermGrade, 'hard', 'correction re-rates long-term grade');
    assert(corrected.due !== goodWord.due, 'correction recalculates long-term due');
    assertEq(store.getState().word.id, second.id, 'correction returns to original next word');
    store.previous();
    assertEq(store.getState().word.id, second.id, 'correction slot is single-use after re-rate');
  }

  if (process.exitCode) {
    console.error('SOME TESTS FAILED');
    process.exit(1);
  }
  console.log('ALL DYNAMIC SCHEDULING TESTS PASSED');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
