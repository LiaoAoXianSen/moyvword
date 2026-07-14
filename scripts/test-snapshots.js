const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/store');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-snap-'));
  const primaryDir = path.join(root, 'primary');
  const mirrorDir = path.join(root, 'mirror');
  fs.mkdirSync(primaryDir, { recursive: true });
  fs.mkdirSync(mirrorDir, { recursive: true });

  const store = await createStore({ primaryDir, mirrorDir });
  const state1 = store.getState();
  const wordCount1 = state1.stats ? state1.stats.totalWords || (state1.words && state1.words.length) : null;
  // Prefer words from list if available
  const wordsBefore = store.listWords ? store.listWords('', { limit: 5 }) : null;

  // Daily snapshot should exist after createStore
  let snaps = store.listSnapshots();
  if (!snaps.some((s) => s.kind === 'daily')) {
    throw new Error('expected daily snapshot after startup');
  }
  console.log('daily snapshot ok', snaps[0].id);

  // Second daily create on same day must reuse, not duplicate
  const dailyAgain = store.createSnapshot({ kind: 'daily', label: '每日自动恢复点' });
  snaps = store.listSnapshots().filter((s) => s.kind === 'daily');
  if (snaps.length !== 1) throw new Error(`expected 1 daily snapshot, got ${snaps.length}`);
  if (dailyAgain.id !== snaps[0].id) throw new Error('daily dedupe returned wrong snapshot');
  console.log('daily dedupe ok');

  // Mutate settings to make restore detectable
  store.updateSettings({ dailyNew: 77 });
  if (store.getState().settings.dailyNew !== 77) throw new Error('settings not updated');

  const manual = store.createSnapshot({ kind: 'manual', label: '测试恢复点' });
  if (!manual || manual.kind !== 'manual') throw new Error('manual snapshot failed');
  console.log('manual snapshot ok', manual.id);

  // Change again after manual snapshot
  store.updateSettings({ dailyNew: 12 });
  if (store.getState().settings.dailyNew !== 12) throw new Error('second settings update failed');

  const restored = store.restoreSnapshot(manual.id);
  if (!restored || !restored.restored) throw new Error('restore returned empty');
  if (store.getState().settings.dailyNew !== 77) {
    throw new Error(`expected dailyNew 77 after restore, got ${store.getState().settings.dailyNew}`);
  }
  console.log('restore ok to', restored.restored.id);

  snaps = store.listSnapshots();
  if (!snaps.some((s) => s.kind === 'pre-restore')) {
    throw new Error('expected pre-restore safety snapshot');
  }
  console.log('pre-restore snapshot ok');

  // storage state includes snapshots
  const storage = store.getState().storage;
  if (!storage || !Array.isArray(storage.snapshots) || !storage.snapshotsDir) {
    throw new Error('getState.storage missing snapshots');
  }
  console.log('storage.snapshots', storage.snapshots.length, 'dir', storage.snapshotsDir);

  // cleanup
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('ALL SNAPSHOT TESTS PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
