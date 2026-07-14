
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStore } = require('../src/store');
const {
  advanceLive,
  goPrevious,
  goNext,
  returnToLive,
  viewWordId,
  migrateNavigation,
  defaultNavigation
} = require('../src/navigation');

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

// Unit: pure navigation machine
{
  let nav = defaultNavigation();
  nav = advanceLive(nav, 'A');
  nav = advanceLive(nav, 'B');
  nav = advanceLive(nav, 'C');
  assertEq(viewWordId(nav), 'C', 'live at C');
  assertEq(nav.trail.join(','), 'A,B', 'trail after A->B->C');
  nav = goPrevious(nav);
  assertEq(viewWordId(nav), 'B', 'previous to B');
  nav = goPrevious(nav);
  assertEq(viewWordId(nav), 'A', 'previous to A');
  let stepped = goNext(nav);
  assertEq(viewWordId(stepped.nav), 'B', 'next to B');
  stepped = goNext(stepped.nav);
  assert(stepped.atLive, 'next from end returns live');
  assertEq(viewWordId(stepped.nav), 'C', 'live still C');
  // rate-on-history style return should keep trail
  nav = goPrevious(stepped.nav);
  assertEq(viewWordId(nav), 'B', 'back to B');
  nav = returnToLive(nav);
  assertEq(viewWordId(nav), 'C', 'returnToLive C');
  assertEq(nav.trail.join(','), 'A,B', 'trail preserved after return');
  nav = goPrevious(nav);
  assertEq(viewWordId(nav), 'B', 'previous after return still B');
}

// Unit: legacy migrate (old previous left preview flags even if currentId drifted)
{
  const nav = migrateNavigation(null, {
    currentId: 'Q',
    history: ['A', 'B'],
    manualPreviewId: 'C',
    manualReturnId: 'Q'
  });
  assertEq(nav.mode, 'history', 'migrate mode history');
  assertEq(viewWordId(nav), 'C', 'migrate view C');
  assertEq(nav.liveWordId, 'Q', 'migrate live Q');
  assertEq(nav.trail.join(','), 'A,B,C', 'migrate restores preview into trail');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyv-nav-'));
  const store = await createStore({ primaryDir: dir, mirrorDir: path.join(dir, 'mirror') });
  const items = store.listWords('', { scope: 'book', page: 1, pageSize: 50 }).items;
  store.addNewWordsToPlan(items.map((w) => w.id));

  const order = [];
  for (let i = 0; i < 4; i += 1) {
    const word = store.getState().word;
    order.push(word.word);
    store.rate('good');
  }
  const live = store.getState().word.word;
  console.log('study order', order.join('->'), 'live', live);

  store.previous();
  assertEq(store.getState().word.word, order[3], 'store previous once');
  assertEq(store.getState().word.queueLabel, '手动回顾', 'previous is manual review label');

  // stats/getState must not kick us off history
  store.getState();
  assertEq(store.getState().word.word, order[3], 'getState keeps previous word');

  store.previous();
  assertEq(store.getState().word.word, order[2], 'store previous twice');

  store.skip();
  assertEq(store.getState().word.word, order[3], 'next/skip advances in trail first');
  store.skip();
  assertEq(store.getState().word.word, live, 'next/skip then returns to live');

  store.previous();
  assertEq(store.getState().word.word, order[3], 'previous after return');
  store.rate('again'); // browsing rate: no schedule change, return live
  assertEq(store.getState().word.word, live, 'rate on history returns live');
  store.previous();
  assertEq(store.getState().word.word, order[3], 'history preserved after browse-rate');

  // live rate then previous continuity
  const before = store.getState().word.word;
  store.rate('hard');
  const after = store.getState().word && store.getState().word.word;
  store.previous();
  assertEq(store.getState().word.word, before, 'previous after live hard');
  store.skip();
  assertEq(store.getState().word && store.getState().word.word, after, 'skip returns to post-rate live');

  if (process.exitCode) {
    console.error('SOME TESTS FAILED');
    process.exit(1);
  }
  console.log('ALL NAVIGATION TESTS PASSED');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
