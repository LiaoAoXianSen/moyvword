let state;
let words = [];
let selectedId = null;
let currentView = 'dashboard';
let activeScope = 'book';
let activeFilter = 'all';
let onlineBooks = [];

const DEFAULT_STRIP_APPEARANCE = {
  width: 520,
  opacity: 93,
  textColor: '#243044'
};

function normalizedStripAppearance(settings = {}) {
  const appearance = settings.stripAppearance || {};
  const width = Math.max(300, Math.min(900, Math.round(Number(appearance.width) || DEFAULT_STRIP_APPEARANCE.width)));
  const opacity = Math.max(40, Math.min(100, Math.round(Number(appearance.opacity) || DEFAULT_STRIP_APPEARANCE.opacity)));
  const textColor = /^#[0-9a-fA-F]{6}$/.test(String(appearance.textColor || ''))
    ? String(appearance.textColor).toLowerCase()
    : DEFAULT_STRIP_APPEARANCE.textColor;
  return { width, opacity, textColor };
}

function stripAppearancePatch() {
  return {
    width: Number(byId('stripWidth').value) || DEFAULT_STRIP_APPEARANCE.width,
    opacity: Number(byId('stripOpacity').value) || DEFAULT_STRIP_APPEARANCE.opacity,
    textColor: byId('stripTextColor').value || DEFAULT_STRIP_APPEARANCE.textColor
  };
}

function scheduleStripAppearanceSave(delay = 120) {
  clearTimeout(stripAppearanceSaveTimer);
  stripAppearanceSaveTimer = setTimeout(() => {
    window.moyu.updateSettings({ stripAppearance: stripAppearancePatch() });
  }, delay);
}

let activeDownloadId = null;
let randomPreview = [];
let manualNewWords = [];
const manualNewSelected = new Set();
let manualNewPage = 1;
let manualNewPages = 1;
let manualNewLoading = false;
let manualNewSeq = 0;
let manualNewQueued = false;
let wordRefreshSeq = 0;
let stripAppearanceSaveTimer;
let wordPage = 1;
let wordPages = 1;
let wordTotal = 0;
let wordLetter = '';
let wordLoading = false;
let lookupRecords = [];
const bulkSelected = new Set();
const filterLabels = {
  all: '全部',
  new: '新词',
  wrong: '错词',
  favorite: '已收藏',
  done: '已掌握',
  learning: '短循环',
  loopDue: '短循环复习',
  due: '待复习',
  debt: '重点复习',
  regular: '普通复习'
};
const scopeLabels = {
  book: '当前本单词',
  records: '学习记录'
};

function byId(id) {
  return document.getElementById(id);
}

const localShortcuts = {
  a: 'previous',
  s: 'speak',
  d: 'next',
  f: 'reveal',
  z: 'rate-again',
  x: 'rate-hard',
  c: 'rate-good',
  v: 'rate-easy'
};

function isTextInput(target) {
  return target
    && (target.isContentEditable
      || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

window.addEventListener('keydown', (event) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
  if (isTextInput(event.target)) return;
  const action = localShortcuts[String(event.key || '').toLowerCase()];
  if (!action) return;
  event.preventDefault();
  window.moyu.action(action);
});

function debounce(fn, delay = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function currentNavKey() {
  if (currentView === 'manager') return activeScope === 'records' ? 'records' : 'words';
  return currentView;
}

function applyView() {
  byId('dashboardView').hidden = currentView !== 'dashboard';
  byId('managerView').hidden = currentView !== 'manager';
  byId('bookManagerView').hidden = currentView !== 'bookManager';
  const navKey = currentNavKey();
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.nav === navKey);
  });
  document.querySelectorAll('[data-word-filter]').forEach((button) => {
    const active = button.dataset.wordFilter === activeFilter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const scopeLabel = scopeLabels[activeScope] || scopeLabels.book;
  const filterLabel = activeFilter === 'all' ? '' : ` · ${filterLabels[activeFilter] || '全部'}`;
  const activeBookName = state && state.stats && state.stats.activeBook ? state.stats.activeBook.name : '当前本';
  byId('wordManagerTitle').textContent = `词库管理 · ${scopeLabel}${filterLabel}`;
  const isRecords = activeScope === 'records';
  byId('planToolbarHint').textContent = isRecords
    ? '学习记录只追加复习；新词请到当前本单词选择'
    : `${activeBookName}：勾选新词手动加入，或随机挑选`;
  byId('managerRandomCount').hidden = isRecords;
  byId('managerRandomCount').disabled = isRecords;
  byId('managerRandomNew').hidden = isRecords;
  byId('managerRandomNew').disabled = isRecords;
  byId('addSelectedToPlan').textContent = isRecords ? '所选加入今日复习' : '手动加入所选';
  renderBulkBooks();
  renderBulkSelection();
}

function switchToManager(filter = activeFilter, scope = activeScope) {
  activeScope = scope;
  activeFilter = filter;
  currentView = 'manager';
  selectedId = null;
  wordPage = 1;
  wordLetter = '';
  applyView();
  refreshWords(false);
}

function setProgress(id, completed, target) {
  const percent = target > 0 ? Math.max(0, Math.min(100, Math.round((completed / target) * 100))) : 0;
  byId(id).style.width = `${percent}%`;
}

function totalPlanCapacityLeft(plan) {
  if (plan && plan.remainingCapacity !== undefined) {
    return Math.max(0, Math.floor(Number(plan.remainingCapacity) || 0));
  }
  const planTarget = plan && plan.target !== undefined ? Number(plan.target) : undefined;
  const settingsTarget = state && state.settings ? Number(state.settings.dailyNew) : 0;
  const dailyTarget = Math.max(0, Math.floor(Number.isFinite(planTarget) ? planTarget : settingsTarget || 0));
  const completed = Math.max(0, Number(plan && plan.newWords && plan.newWords.completed) || 0)
    + Math.max(0, Number(plan && plan.reviews && plan.reviews.completed) || 0);
  const active = Math.max(0, Number(plan && plan.active) || 0);
  return Math.max(0, dailyTarget - completed - active);
}

function suggestedNewWordCount(plan) {
  const remainingTarget = totalPlanCapacityLeft(plan);
  const available = Math.max(0, Number(plan && plan.availableNew) || 0);
  if (remainingTarget > 0) {
    return Math.max(1, Math.min(200, available ? Math.min(remainingTarget, available) : remainingTarget));
  }
  const dailyTarget = Math.max(1, Number(state && state.settings && state.settings.dailyNew) || 50);
  const fallbackExtra = Math.min(10, available || dailyTarget);
  return Math.max(1, Math.min(200, fallbackExtra || dailyTarget));
}

function setSuggestedCountInput(id, value) {
  const input = byId(id);
  if (!input || document.activeElement === input) return;
  input.value = String(value);
}

function renderTodayReviewAction(review = {}) {
  const button = byId('startTodayReview');
  if (!button) return;
  const active = !!review.active;
  const available = active || !!review.canStart;
  button.disabled = !available;
  button.classList.toggle('is-active', active);
  if (active) {
    button.textContent = review.remainingCards ? `继续今日回顾 · ${review.remainingCards}` : '继续今日回顾';
  } else if (review.finishedAt && review.total) {
    button.textContent = `再复习一轮 · ${review.total}`;
  } else if (review.total) {
    button.textContent = `复习今日已学 · ${review.total}`;
  } else {
    button.textContent = '复习今日已学';
  }
  button.title = available ? '' : '背完今日计划后可用';
}

function isReadyWord(word) {
  return (word.due || 0) <= Date.now()
    || (word.status === 'learning' && (word.buriedUntil || 0) > Date.now() && (word.loopCardsLeft || 0) <= 0);
}

function renderStudyBoard(stats) {
  const plan = stats.dailyPlan;
  const review = stats.todayReview || {};
  const debt = stats.debt;
  const stages = stats.learningStages;
  const remainingToday = plan.newWords.remaining + plan.reviews.remaining;
  byId('planWindow').textContent = `学习窗口 ${plan.window.total}/${plan.window.size}`;
  byId('planOverview').textContent = review.active
    ? `今日回顾进行中 · ${review.remainingCards || 0}/${review.total || review.remainingCards || 0}`
    : remainingToday
    ? `今日计划内 ${remainingToday}`
    : (review.canStart ? '今日计划已完成，可开始回顾' : '今日计划已完成');
  renderTodayReviewAction(review);
  byId('newPlanText').textContent = `${plan.newWords.completed}/${plan.newWords.target}`;
  byId('newPlanHint').textContent = plan.newWords.remaining
    ? `计划内新词剩余 ${plan.newWords.remaining}`
    : `当前本可加入 ${plan.availableNew || 0} 个新词`;
  setProgress('newPlanProgress', plan.newWords.completed, plan.newWords.target);
  byId('reviewPlanText').textContent = `${plan.reviews.completed}/${plan.reviews.target}`;
  byId('reviewPlanHint').textContent = plan.reviews.remaining
    ? `计划内复习剩余 ${plan.reviews.remaining}`
    : `待复习池剩余 ${plan.remainingDuePool || 0}`;
  setProgress('reviewPlanProgress', plan.reviews.completed, plan.reviews.target);
  byId('loopPlanText').textContent = `${plan.shortLoops.due}/${plan.shortLoops.active}`;
  byId('loopPlanHint').textContent = plan.shortLoops.active ? `其中 ${plan.shortLoops.due} 个已到期` : '当前没有短循环';
  setProgress('loopPlanProgress', plan.shortLoops.due, Math.max(1, plan.shortLoops.active));
  byId('stageNewCount').textContent = `待学 ${stages.new}`;
  byId('nextDueLabel').textContent = `下一批：${debt.nextDueLabel}`;
  byId('urgentDebtCount').textContent = debt.urgent;
  byId('regularDebtCount').textContent = debt.regular;
  byId('loopDebtCount').textContent = debt.loops;

  const stageTotal = stages.stages.reduce((sum, item) => sum + item.count, 0);
  byId('stageList').replaceChildren(...stages.stages.map((stage) => {
    const row = document.createElement('div');
    row.className = 'stage-row';
    const label = document.createElement('span');
    label.textContent = stage.label;
    const count = document.createElement('strong');
    count.textContent = String(stage.count);
    const progress = document.createElement('span');
    progress.className = 'stage-bar';
    const fill = document.createElement('i');
    fill.style.width = `${stageTotal ? Math.round((stage.count / stageTotal) * 100) : 0}%`;
    progress.append(fill);
    row.append(label, count, progress);
    return row;
  }));
  renderStudySummary(stats.studySummary);
}

function shortDate(date) {
  const value = String(date || '');
  return value.length >= 10 ? `${value.slice(5, 7)}/${value.slice(8, 10)}` : value || '--';
}

function renderStudySummary(summary = {}) {
  const history = Array.isArray(summary.history) ? summary.history.slice(-7) : [];
  const forecast = Array.isArray(summary.forecast) ? summary.forecast.slice(0, 7) : [];
  const maxActions = Math.max(1, ...history.map((item) => Number(item.actions) || 0));
  const forecastTotal = forecast.reduce((total, item) => total + (Number(item.due) || 0), 0);
  byId('studyStreak').textContent = `连续 ${Number(summary.streak) || 0} 天`;
  byId('forecastTotal').textContent = `未来 7 天待复习 ${forecastTotal}`;

  byId('studyHistory').replaceChildren(...history.map((item) => {
    const day = document.createElement('div');
    day.className = 'study-day';
    day.title = `${shortDate(item.date)}：新词 ${item.newLearned || 0}，复习 ${item.reviewed || 0}`;
    const bar = document.createElement('i');
    bar.style.height = `${Math.round(((Number(item.actions) || 0) / maxActions) * 100)}%`;
    const count = document.createElement('strong');
    count.textContent = String(item.actions || 0);
    const label = document.createElement('span');
    label.textContent = shortDate(item.date);
    day.append(bar, count, label);
    return day;
  }));

  byId('studyForecast').replaceChildren(...forecast.map((item) => {
    const day = document.createElement('div');
    day.className = `forecast-day${item.due ? ' is-due' : ''}`;
    const label = document.createElement('span');
    label.textContent = shortDate(item.date);
    const count = document.createElement('strong');
    count.textContent = String(item.due || 0);
    day.append(label, count);
    return day;
  }));
}

function renderBookProgress() {
  const books = state && Array.isArray(state.books) ? state.books : [];
  const active = books.find((book) => book.active);
  byId('bookProgressSummary').textContent = active
    ? `当前：${active.name}`
    : '按已开启单词统计';
  byId('bookProgressList').replaceChildren(...books.map((book) => {
    const learned = Number.isFinite(book.learned) ? book.learned : Math.max(0, book.total - book.fresh);
    const percent = Number.isFinite(book.progress)
      ? book.progress
      : (book.total ? Math.round((learned / book.total) * 100) : 0);
    const today = book.today || {};
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `book-progress-row${book.active ? ' is-active' : ''}`;
    row.dataset.bookId = book.id;
    row.setAttribute('aria-pressed', String(!!book.active));
    const name = document.createElement('strong');
    name.textContent = book.name;
    const stat = document.createElement('span');
    stat.textContent = `${learned}/${book.total} 已学习 · ${book.mastered || 0} 掌握`;
    const detail = document.createElement('span');
    detail.className = 'book-progress-detail';
    detail.textContent = `今日 新 ${today.newLearned || 0} · 复 ${today.reviewed || 0} · 到期 ${book.due || 0}`;
    const track = document.createElement('span');
    track.className = 'book-progress-track';
    const fill = document.createElement('i');
    fill.style.width = `${percent}%`;
    track.append(fill);
    const percentLabel = document.createElement('em');
    percentLabel.textContent = `${percent}%`;
    row.append(name, stat, detail, track, percentLabel);
    return row;
  }));
}

function renderBookControls() {
  const books = state && Array.isArray(state.books) ? state.books : [];
  const active = books.find((book) => book.active);
  byId('bookManagerDelete').disabled = !active;
  byId('bookManagerRename').disabled = !active;
}

function renderBookManagement() {
  const books = state && Array.isArray(state.books) ? state.books : [];
  const active = books.find((book) => book.active);
  const select = byId('activeBookSelect');
  const previousValue = select.value;
  select.replaceChildren(...books.map((book) => {
    const option = document.createElement('option');
    option.value = book.id;
    option.textContent = book.name;
    return option;
  }));
  select.value = active ? active.id : previousValue;
  select.disabled = books.length < 2;
  byId('activeBookManagerTitle').textContent = active ? active.name : '未选择单词本';
  byId('activeBookManagerMeta').textContent = active
    ? `${active.total} 个单词 · ${active.fresh} 个未学 · ${active.due} 个到期 · 已学习 ${active.progress}%`
    : '新建或导入一个单词本后即可开始选择新词。';
  byId('otherBooksCount').textContent = `${Math.max(0, books.length - (active ? 1 : 0))} 个可切换`;
  byId('bookManagerList').replaceChildren(...books.filter((book) => !book.active).map((book) => {
    const row = document.createElement('article');
    row.className = 'book-manager-row';
    row.dataset.bookId = book.id;
    const title = document.createElement('strong');
    title.textContent = book.name;
    const meta = document.createElement('span');
    meta.textContent = `${book.total} 词 · ${book.fresh} 未学 · ${book.due} 到期 · ${book.progress}%`;
    const actions = document.createElement('div');
    actions.className = 'book-manager-actions';
    const switchButton = document.createElement('button');
    switchButton.type = 'button';
    switchButton.dataset.bookAction = 'switch';
    switchButton.textContent = '切换到此本';
    actions.append(switchButton);
    row.append(title, meta, actions);
    return row;
  }));
}

function render(nextState) {
  state = nextState;
  const { stats, word, settings } = state;

  byId('dueCount').textContent = stats.due;
  byId('wrongCount').textContent = stats.wrong;
  byId('learningCount').textContent = stats.learning;
  byId('reviewDebt').textContent = stats.reviewDebt;
  byId('freshCount').textContent = stats.fresh;
  byId('totalCount').textContent = stats.total;
  byId('activeBookName').textContent = stats.activeBook ? stats.activeBook.name : '默认单词本';
  renderStudyBoard(stats);
  renderBookProgress();
  renderBookControls();
  renderBookManagement();
  renderBulkBooks();
  applyView();
  byId('dailyNew').value = settings.dailyNew;
  byId('learningWindowSize').value = settings.learningWindowSize || 15;
  byId('answerFirst').checked = settings.answerFirst;
  byId('autoSpeak').checked = Boolean(settings.autoSpeak);
  byId('audioVolume').value = String(settings.audioVolume ?? 80);
  byId('audioVolumeValue').value = `${settings.audioVolume ?? 80}%`;
  const stripAppearance = normalizedStripAppearance(settings);
  byId('stripWidth').value = String(stripAppearance.width);
  byId('stripWidthValue').value = `${stripAppearance.width}px`;
  byId('stripOpacity').value = String(stripAppearance.opacity);
  byId('stripOpacityValue').value = `${stripAppearance.opacity}%`;
  byId('stripTextColor').value = stripAppearance.textColor;
  setSuggestedCountInput('managerRandomCount', suggestedNewWordCount(stats.dailyPlan));
  byId('todayPlan').textContent = `本词本：新词 ${stats.dailyPlan.newWords.completed}/${stats.dailyPlan.newWords.target}，复习 ${stats.dailyPlan.reviews.completed}/${stats.dailyPlan.reviews.target}，短循环 ${stats.dailyPlan.shortLoops.due}/${stats.dailyPlan.shortLoops.active}。${stats.planText}；下一次复习：${stats.nextDueLabel}`;
  byId('storagePath').textContent = state.storage ? `主数据：${state.storage.path}` : '';
  byId('storageMirrorPath').textContent = state.storage && state.storage.mirrorPath ? `C盘兜底：${state.storage.mirrorPath}` : '';
  byId('backupDirectoryPath').textContent = state.storage && state.storage.backupDirectory ? `自定义备份：${state.storage.backupDirectory}` : '自定义备份：未选择';
  renderSnapshots(state);

  const warning = byId('shortcutWarning');
  const failures = settings.shortcutFailures || [];
  warning.hidden = failures.length === 0;
  warning.textContent = failures.length ? `以下快捷键注册失败，可能被其他软件占用：${failures.join('、')}` : '';
  byId('shortcuts').replaceChildren(...state.shortcuts.map(([keys, label]) => {
    const row = document.createElement('div');
    const labelNode = document.createElement('span');
    const keysNode = document.createElement('strong');
    labelNode.textContent = label;
    keysNode.textContent = keys;
    row.append(labelNode, keysNode);
    return row;
  }));

  if (!word) {
    byId('currentWord').textContent = '没有单词';
    const review = stats.todayReview || {};
    byId('currentMeta').textContent = review.active
      ? `今日回顾进行中 · 剩余 ${review.remainingCards || 0} 张`
      : stats.dailyPlan && stats.dailyPlan.complete
        ? (review.canStart ? '今日计划已完成，可以开始回顾。' : '今日目标已完成。')
        : '先从当前单词本选择新词，或等待到期复习进入计划。';
    byId('currentAnswer').textContent = '';
    return;
  }

  const review = stats.todayReview || {};
  byId('currentWord').textContent = word.word;
  byId('currentMeta').textContent = word.queueLabel === '今日回顾'
    ? `今日回顾 · 剩余 ${review.remainingCards || 0} 张 · ${word.stageLabel} · ${word.phonetic || '无音标'} · ${word.favorite ? '已收藏' : '未收藏'}`
    : `${word.queueLabel} · ${word.stageLabel} · 保持 ${word.retention}% · 顽固 ${word.stubbornness} · 逾期 ${word.overdueRatio} · ${word.phonetic || '无音标'} · 下次：${word.dueLabel} · ${word.favorite ? '已收藏' : '未收藏'}`;
  const answer = byId('currentAnswer');
  if (state.revealed) {
    const meaning = document.createElement('strong');
    meaning.textContent = word.meaning || '暂无释义';
    const sentence = document.createElement('div');
    sentence.textContent = word.sentence || '暂无例句';
    answer.replaceChildren(meaning, sentence);
  } else {
    answer.textContent = '答案未显示。横条里按 Alt+F，或者点击下方按钮。';
  }
}

function filteredWords() {
  return words.filter((word) => {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'new') return word.status === 'new';
    if (activeFilter === 'wrong') return word.wrongCount > 0 || word.hardCount > 0 || word.lapseCount > 0;
    if (activeFilter === 'favorite') return word.favorite;
    if (activeFilter === 'done') return word.status === 'done';
    if (activeFilter === 'learning') return word.status === 'learning';
    if (activeFilter === 'loopDue') return word.status === 'learning' && isReadyWord(word);
    if (activeFilter === 'due') return word.status !== 'new' && word.status !== 'done' && isReadyWord(word);
    if (activeFilter === 'regular') {
      return word.status !== 'new' && word.status !== 'done' && isReadyWord(word)
        && word.status !== 'learning' && word.stubbornness < 4 && word.overdueRatio < 1;
    }
    if (activeFilter === 'debt') {
      return word.status !== 'new' && word.status !== 'done' && isReadyWord(word)
        && (word.status === 'learning' || word.stubbornness >= 4 || word.overdueRatio >= 1);
    }
    return true;
  });
}

async function setCurrentBook(bookId) {
  if (!bookId || (state && state.stats && state.stats.activeBook && state.stats.activeBook.id === bookId)) return;
  await window.moyu.setActiveBook(bookId);
  const nextState = await window.moyu.getState();
  render(nextState);
  await refreshWords(false);
}

function renderBulkBooks() {
  const select = byId('bulkBook');
  const tools = byId('bulkBookTools');
  if (!select || !state) return;
  const activeId = state.stats.activeBook && state.stats.activeBook.id;
  const targetBooks = state.books.filter((book) => book.id !== activeId);
  const canUseBookTools = activeScope === 'book' && targetBooks.length > 0;
  if (tools) {
    tools.dataset.available = canUseBookTools ? 'true' : 'false';
    if (!canUseBookTools) tools.hidden = true;
  }
  if (!canUseBookTools) {
    select.replaceChildren();
    select.disabled = true;
    return;
  }
  const currentValue = select.value;
  select.replaceChildren(...targetBooks.map((book) => {
    const option = document.createElement('option');
    option.value = book.id;
    option.textContent = book.name;
    return option;
  }));
  select.disabled = false;
  select.value = targetBooks.some((book) => book.id === currentValue)
    ? currentValue
    : targetBooks[0].id;
}

function renderOnlineBooks() {
  byId('onlineBookList').replaceChildren(...onlineBooks.map((book) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'online-book-row';
    button.dataset.id = book.id;
    const name = document.createElement('strong');
    name.textContent = book.name;
    const source = document.createElement('span');
    source.textContent = book.source;
    button.append(name, source);
    return button;
  }));
}

function wordSummary(word) {
  return `${word.queueLabel} · ${word.dueLabel} · 顽固 ${word.stubbornness}`;
}

function renderWordList(preserveScroll = false) {
  const visibleWords = filteredWords();
  const activeBookName = state && state.stats && state.stats.activeBook ? state.stats.activeBook.name : '当前单词本';
  byId('wordCountHint').textContent = activeScope === 'records'
    ? `共 ${wordTotal} 条学习记录，当前第 ${wordPage}/${wordPages} 页。`
    : `${activeBookName} 共 ${wordTotal} 个单词，当前第 ${wordPage}/${wordPages} 页。`;
  const list = byId('wordList');
  const scrollTop = preserveScroll ? list.scrollTop : 0;
  list.replaceChildren(...visibleWords.map((word) => {
    const button = document.createElement('div');
    button.className = `word-row${word.id === selectedId ? ' is-selected' : ''}`;
    button.dataset.id = word.id;
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = bulkSelected.has(word.id);
    checkbox.setAttribute('aria-label', `选择 ${word.word}`);
    const title = document.createElement('strong');
    title.textContent = word.word;
    const detail = document.createElement('span');
    detail.textContent = activeScope === 'records'
      ? `${word.meaning || '暂无释义'} · ${word.queueLabel} · 下次 ${word.dueLabel} · 顽固 ${word.stubbornness}`
      : (word.meaning || wordSummary(word));
    const body = document.createElement('span');
    body.className = 'word-row-body';
    body.append(title, detail);
    button.append(checkbox, body);
    return button;
  }));
  if (preserveScroll) list.scrollTop = scrollTop;
  renderBulkSelection();
  byId('wordPageStatus').textContent = wordTotal
    ? `已加载 ${words.length} / ${wordTotal} 个，继续滚动加载`
    : '没有匹配的单词';
}

function renderWordLetterSelect() {
  const alphabet = ['全部', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];
  const select = byId('wordLetterSelect');
  select.replaceChildren(...alphabet.map((letter) => {
    const option = document.createElement('option');
    option.value = letter === '全部' ? '' : letter;
    option.textContent = letter === '#' ? '# 其他' : letter;
    return option;
  }));
  select.value = wordLetter;
}

function fillForm(word) {
  selectedId = word ? word.id : null;
  byId('editingId').value = word ? word.id : '';
  byId('editWord').value = word ? word.word : '';
  byId('editPhonetic').value = word ? word.phonetic || '' : '';
  byId('editMeaning').value = word ? word.meaning || '' : '';
  byId('editSentence').value = word ? word.sentence || '' : '';
  byId('deleteWord').disabled = !word;
  byId('setCurrent').disabled = !word;
  renderWordList();
}

async function refreshWords(keepSelection = true) {
  const requestId = ++wordRefreshSeq;
  const scope = activeScope;
  const query = byId('wordSearch').value;
  const result = await window.moyu.listWords(query, {
    scope,
    filter: activeFilter,
    letter: wordLetter,
    page: wordPage,
    pageSize: 50
  });
  if (requestId !== wordRefreshSeq) return;
  words = result.items;
  wordPage = result.page;
  wordPages = result.pages;
  wordTotal = result.total;
  renderWordLetterSelect();
  const knownIds = new Set(words.map((word) => word.id));
  [...bulkSelected].forEach((id) => {
    if (!knownIds.has(id)) bulkSelected.delete(id);
  });
  const visibleWords = filteredWords();
  const selected = keepSelection && visibleWords.find((word) => word.id === selectedId);
  fillForm(selected || visibleWords[0] || null);
}

async function loadMoreWords() {
  if (wordLoading || wordPage >= wordPages || !wordTotal) return;
  wordLoading = true;
  const requestId = wordRefreshSeq;
  try {
    const result = await window.moyu.listWords(byId('wordSearch').value, {
      scope: activeScope,
      filter: activeFilter,
      letter: wordLetter,
      page: wordPage + 1,
      pageSize: 50
    });
    if (requestId !== wordRefreshSeq) return;
    const loaded = new Set(words.map((word) => word.id));
    words.push(...result.items.filter((word) => !loaded.has(word.id)));
    wordPage = result.page;
    wordPages = result.pages;
    wordTotal = result.total;
    renderWordList(true);
  } finally {
    wordLoading = false;
  }
}

function formRecord() {
  return {
    word: byId('editWord').value,
    phonetic: byId('editPhonetic').value,
    meaning: byId('editMeaning').value,
    sentence: byId('editSentence').value
  };
}

function showNotice(message, isError = false) {
  const notice = byId('formNotice');
  notice.textContent = message;
  notice.classList.toggle('is-error', isError);
}

function renderLookupResults(result) {
  lookupRecords = Array.isArray(result && result.items) ? result.items : [];
  const isLocal = result && result.source === 'book';
  byId('lookupNotice').textContent = lookupRecords.length
    ? (isLocal ? `当前词本找到 ${result.total} 个匹配词。` : '当前词本没有匹配词，以下为在线词典结果。')
    : '没有找到匹配词。';
  byId('lookupResults').replaceChildren(...lookupRecords.map((record, index) => {
    const row = document.createElement('article');
    row.className = 'lookup-result';
    const head = document.createElement('div');
    head.className = 'lookup-result-head';
    const word = document.createElement('strong');
    word.textContent = record.word;
    const phonetic = document.createElement('span');
    phonetic.textContent = record.phonetic || '无音标';
    head.append(word, phonetic);
    const meaning = document.createElement('p');
    meaning.textContent = record.meaning || '暂无释义';
    const sentence = document.createElement('p');
    sentence.textContent = record.sentence || '';
    const actions = document.createElement('div');
    actions.className = 'lookup-result-actions';
    if (!isLocal) {
      const addToBook = document.createElement('button');
      addToBook.type = 'button';
      addToBook.dataset.lookupAction = 'book';
      addToBook.dataset.index = String(index);
      addToBook.textContent = '加入当前词本';
      actions.append(addToBook);
    }
    const addToPlan = document.createElement('button');
    addToPlan.type = 'button';
    addToPlan.dataset.lookupAction = 'plan';
    addToPlan.dataset.index = String(index);
    addToPlan.textContent = '加入今日记忆';
    actions.append(addToPlan);
    row.append(head, meaning);
    if (record.sentence) row.append(sentence);
    row.append(actions);
    return row;
  }));
}

async function searchLookup(query = byId('lookupInput').value) {
  const term = String(query || '').trim();
  if (!term) return;
  byId('lookupNotice').textContent = '正在搜索...';
  byId('lookupResults').replaceChildren();
  try {
    renderLookupResults(await window.moyu.lookupWord(term));
  } catch (error) {
    lookupRecords = [];
    byId('lookupNotice').textContent = error.message || '搜索失败，请稍后重试。';
  }
}

function openLookupDialog(query = '') {
  const dialog = byId('lookupDialog');
  if (!dialog.open) dialog.showModal();
  byId('lookupInput').value = query;
  byId('lookupNotice').textContent = query ? '正在搜索...' : '优先搜索当前词本；未命中时查询在线词典。';
  byId('lookupResults').replaceChildren();
  lookupRecords = [];
  if (query) searchLookup(query);
  else byId('lookupInput').focus();
}

function resetDownloadProgress() {
  activeDownloadId = null;
  const progress = byId('downloadProgress');
  const bar = byId('downloadProgressBar');
  progress.hidden = true;
  progress.classList.remove('is-indeterminate', 'is-error');
  progress.removeAttribute('aria-valuenow');
  bar.style.width = '0%';
}

function setDownloadProgress(progress) {
  if (activeDownloadId && progress.bookId && progress.bookId !== activeDownloadId) return;
  const progressEl = byId('downloadProgress');
  const bar = byId('downloadProgressBar');
  progressEl.hidden = false;
  progressEl.classList.toggle('is-error', !!progress.error);
  const hasPercent = Number.isFinite(progress.percent);
  progressEl.classList.toggle('is-indeterminate', !hasPercent);
  if (hasPercent) {
    const percent = Math.max(0, Math.min(100, progress.percent));
    bar.style.width = `${percent}%`;
    progressEl.setAttribute('aria-valuenow', String(Math.round(percent)));
  } else {
    bar.style.width = '36%';
    progressEl.removeAttribute('aria-valuenow');
  }
  if (progress.label) byId('downloadNotice').textContent = progress.label;
}

function renderRandomPreview(list) {
  randomPreview = Array.isArray(list) ? list : [];
  byId('confirmRandomNew').disabled = randomPreview.length === 0;
  byId('randomPreviewList').replaceChildren(...randomPreview.map((word) => {
    const row = document.createElement('label');
    row.className = 'random-preview-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.value = word.id;
    const text = document.createElement('span');
    text.textContent = `${word.word} · ${word.meaning || '暂无释义'}`;
    row.append(checkbox, text);
    return row;
  }));
}

function selectedRandomPreviewIds() {
  return [...byId('randomPreviewList').querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

function renderManualNewList() {
  const list = byId('manualNewList');
  list.replaceChildren(...manualNewWords.map((word) => {
    const row = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = word.id;
    checkbox.checked = manualNewSelected.has(word.id);
    const text = document.createElement('span');
    text.textContent = `${word.word} · ${word.meaning || '暂无释义'}`;
    row.append(checkbox, text);
    return row;
  }));
  const count = manualNewSelected.size;
  byId('manualNewCount').textContent = count ? `已选择 ${count} 个新词` : '未选择';
  byId('confirmManualNew').disabled = count === 0;
}

async function loadManualNewWords(reset = true) {
  if (manualNewLoading) {
    if (reset) manualNewQueued = true;
    return;
  }
  manualNewLoading = true;
  manualNewQueued = false;
  const seq = ++manualNewSeq;
  const page = reset ? 1 : manualNewPage + 1;
  const query = byId('manualNewSearch').value;
  try {
    const result = await window.moyu.listWords(query, {
      scope: 'book',
      filter: 'new',
      page,
      pageSize: 50
    });
    if (seq !== manualNewSeq || query !== byId('manualNewSearch').value) return;
    if (reset) manualNewWords = result.items;
    else {
      const loaded = new Set(manualNewWords.map((word) => word.id));
      manualNewWords.push(...result.items.filter((word) => !loaded.has(word.id)));
    }
    manualNewPage = result.page;
    manualNewPages = result.pages;
    renderManualNewList();
  } finally {
    manualNewLoading = false;
    if (manualNewQueued) loadManualNewWords(true);
  }
}

async function loadMoreManualNewWords() {
  if (manualNewLoading || manualNewPage >= manualNewPages) return;
  await loadManualNewWords(false);
}

const debouncedLoadManualNewWords = debounce(() => loadManualNewWords(true), 220);
const debouncedRefreshWords = debounce(() => refreshWords(false), 220);

function showManualNewPicker(show) {
  byId('continueNewBlock').hidden = show;
  byId('manualNewBlock').hidden = !show;
  if (!show) {
    byId('manualNewSearch').value = '';
    manualNewWords = [];
    manualNewPage = 1;
    manualNewPages = 1;
    manualNewSelected.clear();
  }
}

function configureContinueDialog(plan, mode = 'auto') {
  const reviewBlock = byId('continueReviewBlock');
  const newBlock = byId('continueNewBlock');
  const dueLeft = Number(plan && plan.remainingDuePool) || 0;
  const newLeft = Number(plan && plan.availableNew) || 0;
  setSuggestedCountInput('randomNewCount', suggestedNewWordCount(plan));
  byId('continueSummary').textContent = dueLeft
    ? `还有 ${dueLeft} 个到期复习未加入今日计划。`
    : (newLeft ? '随机挑选一些新词加入今日计划。' : '当前没有额外复习或新词。');
  const showReview = mode !== 'new' && dueLeft > 0;
  reviewBlock.hidden = !showReview;
  newBlock.hidden = showReview || newLeft <= 0;
  byId('manualNewBlock').hidden = true;
  manualNewWords = [];
  manualNewSelected.clear();
  byId('previewRandomNew').disabled = newBlock.hidden;
  if (!showReview && newLeft > 0) renderRandomPreview([]);
}

async function refreshAfterPlanChange(message) {
  const nextState = await window.moyu.getState();
  render(nextState);
  await refreshWords(false);
  if (message) showNotice(message);
}

async function previewRandomNew(count) {
  const list = await window.moyu.sampleNewWords(count, byId('wordSearch').value);
  renderRandomPreview(list);
  if (!list.length) byId('continueSummary').textContent = totalPlanCapacityLeft(state && state.stats && state.stats.dailyPlan) <= 0
    ? '今日目标名额已用完。'
    : '当前单词本没有可随机加入的新词。';
}

function selectedBulkIds() {
  return [...bulkSelected].filter((id) => words.some((word) => word.id === id));
}

function renderBulkSelection() {
  const count = selectedBulkIds().length;
  const visible = filteredWords();
  const visibleSelected = visible.filter((word) => bulkSelected.has(word.id)).length;
  const tools = byId('bulkBookTools');
  const bookTargetAvailable = tools && tools.dataset.available === 'true';
  if (tools) tools.hidden = !(bookTargetAvailable && count > 0);
  const bookToolsReady = !!(bookTargetAvailable && count > 0 && byId('bulkBook').value);
  byId('bulkCount').textContent = count ? `已选择 ${count} 个` : '未选择';
  byId('selectVisible').textContent = visible.length && visibleSelected === visible.length
    ? `取消当前列表 (${visibleSelected}/${visible.length})`
    : `全选当前列表 (${visibleSelected}/${visible.length})`;
  document.querySelectorAll('[data-bulk-action]').forEach((button) => {
    const crossBook = button.dataset.bulkAction === 'attach-book' || button.dataset.bulkAction === 'move-book';
    button.disabled = count === 0 || (crossBook && !bookToolsReady);
  });
  byId('clearSelection').disabled = count === 0;
  byId('addSelectedToPlan').disabled = count === 0;
}

async function runBulkAction(action) {
  const ids = selectedBulkIds();
  if (!ids.length) return;
  const labels = {
    delete: '删除',
    'mark-done': '标记为已掌握',
    'mark-new': '重置背诵进度',
    favorite: '批量收藏',
    unfavorite: '取消收藏',
    'attach-book': '复制到其他单词本',
    'move-book': '移动到其他单词本'
  };
  const targetBookId = byId('bulkBook').value;
  if ((action === 'attach-book' || action === 'move-book') && !targetBookId) {
    showNotice('没有可用的其他单词本。', true);
    return;
  }
  if (action === 'delete' && !confirm(`彻底删除 ${ids.length} 个单词？单词内容、归属和学习记录都会删除。`)) return;
  if (action === 'mark-new' && !confirm(`重置 ${ids.length} 个单词的背诵进度？单词内容和单词本归属会保留。`)) return;
  if (action === 'move-book' && !confirm(`${labels[action]}：${ids.length} 个单词？学习记录会保留。`)) return;
  try {
    const result = await window.moyu.bulkWords(ids, action, { bookId: targetBookId });
    if (action === 'delete' || action === 'move-book') bulkSelected.clear();
    const nextState = await window.moyu.getState();
    render(nextState);
    await refreshWords(false);
    showNotice(`${labels[action]}完成：${result.affected} 个。`);
  } catch (error) {
    showNotice(error.message || '批量操作失败。', true);
  }
}

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => window.moyu.action(button.dataset.action));
});

async function importActiveBook() {
  const result = await window.moyu.chooseImport();
  if (result && result.state) render(result.state);
  await refreshWords(false);
  switchToManager('all', 'book');
}

async function openDownloadBookDialog() {
  if (!onlineBooks.length) {
    onlineBooks = await window.moyu.getOnlineBookCatalog();
    renderOnlineBooks();
  }
  if (!activeDownloadId) resetDownloadProgress();
  byId('downloadNotice').textContent = '选择一个在线词书，会自动创建或切换到同名单词本。';
  byId('downloadDialog').showModal();
}

byId('favorite').addEventListener('click', () => window.moyu.action('favorite'));
byId('showStrip').addEventListener('click', () => window.moyu.action('boss'));
byId('startTodayReview').addEventListener('click', async () => {
  const button = byId('startTodayReview');
  button.disabled = true;
  try {
    await window.moyu.startTodayReview();
    const nextState = await window.moyu.getState();
    render(nextState);
  } catch (error) {
    byId('planOverview').textContent = error.message || '今日回顾暂时不能开始。';
    renderTodayReviewAction(state && state.stats ? state.stats.todayReview : {});
  }
});
byId('openSettings').addEventListener('click', () => byId('settingsDialog').showModal());
byId('closeSettings').addEventListener('click', () => byId('settingsDialog').close());
byId('openLookup').addEventListener('click', () => openLookupDialog());
byId('closeLookup').addEventListener('click', () => byId('lookupDialog').close());
byId('lookupForm').addEventListener('submit', (event) => {
  event.preventDefault();
  searchLookup();
});
byId('lookupResults').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-lookup-action]');
  if (!button) return;
  const record = lookupRecords[Number(button.dataset.index)];
  if (!record) return;
  const addToPlan = button.dataset.lookupAction === 'plan';
  button.disabled = true;
  try {
    const result = await window.moyu.saveLookupWord(record, addToPlan);
    const nextState = await window.moyu.getState();
    render(nextState);
    await refreshWords(false);
    renderLookupResults({ source: 'book', items: [result.word], total: 1 });
    byId('lookupNotice').textContent = addToPlan
      ? (result.added ? '已加入当前词本和今日记忆。' : '已加入当前词本；今日计划名额已满。')
      : '已加入当前词本。';
  } catch (error) {
    byId('lookupNotice').textContent = error.message || '添加失败。';
    button.disabled = false;
  }
});
byId('closeDownload').addEventListener('click', () => byId('downloadDialog').close());
byId('closeContinue').addEventListener('click', () => {
  byId('continueDialog').close();
});
byId('continueReviewAdd').addEventListener('click', async () => {
  const count = Number(byId('continueReviewCount').value) || 10;
  try {
    const result = await window.moyu.addDueReviews(count);
    byId('continueDialog').close();
    await refreshAfterPlanChange(`已加入 ${result.added} 个到期复习。`);
  } catch (error) {
    byId('continueSummary').textContent = error.message || '加入复习失败。';
  }
});
byId('previewRandomNew').addEventListener('click', async () => {
  if (totalPlanCapacityLeft(state && state.stats && state.stats.dailyPlan) <= 0) {
    byId('continueSummary').textContent = '今日目标名额已用完。';
    renderRandomPreview([]);
    return;
  }
  await previewRandomNew(Math.max(1, Number(byId('randomNewCount').value) || 10));
});
byId('openManualNewPicker').addEventListener('click', async () => {
  if (totalPlanCapacityLeft(state && state.stats && state.stats.dailyPlan) <= 0) {
    byId('continueSummary').textContent = '今日目标名额已用完。';
    return;
  }
  showManualNewPicker(true);
  byId('continueSummary').textContent = '从当前单词本勾选想背的新词。';
  await loadManualNewWords();
  byId('manualNewSearch').focus();
});
byId('backToRandomNew').addEventListener('click', () => {
  showManualNewPicker(false);
  byId('continueSummary').textContent = '随机挑选一些新词加入今日计划。';
});
byId('manualNewSearch').addEventListener('input', () => {
  debouncedLoadManualNewWords();
});
byId('manualNewList').addEventListener('change', (event) => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  if (event.target.checked) manualNewSelected.add(event.target.value);
  else manualNewSelected.delete(event.target.value);
  renderManualNewList();
});
byId('manualNewList').addEventListener('scroll', (event) => {
  const list = event.currentTarget;
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 72) loadMoreManualNewWords();
});
byId('confirmManualNew').addEventListener('click', async () => {
  const ids = [...manualNewSelected];
  if (!ids.length) return;
  if (totalPlanCapacityLeft(state && state.stats && state.stats.dailyPlan) <= 0) {
    byId('continueSummary').textContent = '今日目标名额已用完。';
    return;
  }
  try {
    const result = await window.moyu.addNewWordsToPlan(ids);
    byId('continueDialog').close();
    showManualNewPicker(false);
    await refreshAfterPlanChange(`已加入 ${result.added} 个新词。`);
  } catch (error) {
    byId('continueSummary').textContent = error.message || '加入新词失败。';
  }
});
byId('confirmRandomNew').addEventListener('click', async () => {
  const ids = selectedRandomPreviewIds();
  if (!ids.length) return;
  if (totalPlanCapacityLeft(state && state.stats && state.stats.dailyPlan) <= 0) {
    byId('continueSummary').textContent = '今日目标名额已用完。';
    renderRandomPreview([]);
    return;
  }
  try {
    const result = await window.moyu.addNewWordsToPlan(ids);
    byId('continueDialog').close();
    renderRandomPreview([]);
    await refreshAfterPlanChange(`已加入 ${result.added} 个新词。`);
  } catch (error) {
    byId('continueSummary').textContent = error.message || '加入新词失败。';
  }
});
byId('onlineBookList').addEventListener('click', async (event) => {
  const row = event.target.closest('.online-book-row');
  if (!row || row.disabled) return;
  const buttons = [...document.querySelectorAll('.online-book-row')];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  row.classList.add('is-loading');
  activeDownloadId = row.dataset.id;
  const bookName = row.querySelector('strong') ? row.querySelector('strong').textContent : '词书';
  setDownloadProgress({ bookId: row.dataset.id, label: `准备下载 ${bookName}...`, percent: 2 });
  try {
    const result = await window.moyu.downloadOnlineBook(row.dataset.id);
    const nextState = await window.moyu.getState();
    render(nextState);
    await refreshWords(false);
    switchToManager('all', 'book');
    const source = result.source === 'builtin' ? '使用内置兜底词表' : '在线词表';
    setDownloadProgress({ bookId: row.dataset.id, label: '导入完成', percent: 100 });
    byId('downloadNotice').textContent = `${result.bookName} 已导入：新增 ${result.added}，归并已有 ${result.attached}，解析 ${result.total}（${source}）。`;
  } catch (error) {
    setDownloadProgress({ bookId: row.dataset.id, label: error.message || '下载失败。', percent: 100, error: true });
    byId('downloadNotice').textContent = error.message || '下载失败。';
  } finally {
    activeDownloadId = null;
    row.classList.remove('is-loading');
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
});
byId('dailyNew').addEventListener('change', (event) => {
  window.moyu.updateSettings({ dailyNew: Number(event.target.value) || 20 });
});
byId('learningWindowSize').addEventListener('change', (event) => {
  window.moyu.updateSettings({ learningWindowSize: Number(event.target.value) || 15 });
});
byId('answerFirst').addEventListener('change', (event) => {
  window.moyu.updateSettings({ answerFirst: event.target.checked });
});
byId('autoSpeak').addEventListener('change', (event) => {
  window.moyu.updateSettings({ autoSpeak: event.target.checked });
});
byId('audioVolume').addEventListener('input', (event) => {
  byId('audioVolumeValue').value = `${event.target.value}%`;
});
byId('audioVolume').addEventListener('change', (event) => {
  window.moyu.updateSettings({ audioVolume: Number(event.target.value) });
});
byId('stripWidth').addEventListener('input', (event) => {
  byId('stripWidthValue').value = `${event.target.value}px`;
  scheduleStripAppearanceSave();
});
byId('stripWidth').addEventListener('change', () => {
  scheduleStripAppearanceSave(0);
});
byId('stripOpacity').addEventListener('input', (event) => {
  byId('stripOpacityValue').value = `${event.target.value}%`;
  scheduleStripAppearanceSave();
});
byId('stripOpacity').addEventListener('change', () => {
  scheduleStripAppearanceSave(0);
});
byId('stripTextColor').addEventListener('change', () => {
  window.moyu.updateSettings({ stripAppearance: stripAppearancePatch() });
});
byId('resetStripAppearance').addEventListener('click', async () => {
  const nextState = await window.moyu.updateSettings({ stripAppearance: DEFAULT_STRIP_APPEARANCE });
  render(nextState);
});
byId('chooseBackupDirectory').addEventListener('click', async () => {
  const nextState = await window.moyu.chooseBackupDirectory();
  render(nextState);
});
byId('clearBackupDirectory').addEventListener('click', async () => {
  const nextState = await window.moyu.updateSettings({ backupDirectory: '' });
  render(nextState);
});
byId('createSnapshot').addEventListener('click', async () => {
  const notice = byId('snapshotNotice');
  notice.hidden = false;
  notice.classList.remove('is-error');
  try {
    const label = prompt('恢复点备注（可留空）', '');
    if (label === null) {
      notice.textContent = '已取消。';
      return;
    }
    const snapshot = await window.moyu.createSnapshot({ label: String(label).trim() || '手动恢复点' });
    const nextState = await window.moyu.getState();
    render(nextState);
    notice.textContent = snapshot ? `已创建恢复点：${snapshot.label || snapshot.id}` : '已创建恢复点。';
  } catch (error) {
    notice.textContent = error.message || '创建恢复点失败。';
    notice.classList.add('is-error');
  }
});
byId('snapshotList').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-snapshot-action="restore"]');
  if (!button) return;
  const notice = byId('snapshotNotice');
  notice.hidden = false;
  notice.classList.remove('is-error');
  try {
    const result = await window.moyu.restoreSnapshot(button.dataset.snapshotId);
    if (result && result.canceled) {
      notice.textContent = '已取消恢复。';
      return;
    }
    const nextState = (result && result.state) || await window.moyu.getState();
    render(nextState);
    await refreshWords(false);
    const restored = result && result.restored;
    notice.textContent = restored
      ? `已恢复到：${restored.label || restored.id}`
      : '已恢复学习数据。';
  } catch (error) {
    notice.textContent = error.message || '恢复失败。';
    notice.classList.add('is-error');
  }
});
byId('openDebt').addEventListener('click', () => switchToManager('debt', 'records'));
document.querySelectorAll('[data-debt-filter]').forEach((button) => {
  button.addEventListener('click', () => switchToManager(button.dataset.debtFilter, 'records'));
});

byId('wordSearch').addEventListener('input', () => {
  wordPage = 1;
  wordLetter = '';
  debouncedRefreshWords();
});
byId('wordLetterSelect').addEventListener('change', (event) => {
  wordLetter = event.target.value;
  wordPage = 1;
  byId('wordSearch').value = '';
  refreshWords(false);
});
byId('wordList').addEventListener('scroll', (event) => {
  const list = event.currentTarget;
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 72) loadMoreWords();
});
document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.nav === 'dashboard') {
      currentView = 'dashboard';
      applyView();
      return;
    }
    if (button.dataset.nav === 'bookManager') {
      currentView = 'bookManager';
      applyView();
      return;
    }
    if (button.dataset.nav === 'records') {
      switchToManager('all', 'records');
      return;
    }
    if (button.dataset.nav === 'words') switchToManager('all', 'book');
  });
});
document.querySelectorAll('[data-word-filter]').forEach((button) => {
  button.addEventListener('click', () => switchToManager(button.dataset.wordFilter, activeScope));
});
byId('bookProgressList').addEventListener('click', async (event) => {
  const row = event.target.closest('.book-progress-row');
  if (!row || row.classList.contains('is-active')) return;
  await setCurrentBook(row.dataset.bookId);
});
function snapshotKindLabel(kind) {
  if (kind === 'daily') return '每日';
  if (kind === 'manual') return '手动';
  if (kind === 'pre-restore') return '恢复前';
  return kind || '其他';
}

function formatSnapshotTime(value) {
  const date = new Date(Number(value) || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '未知时间';
  return date.toLocaleString();
}

function formatSnapshotSize(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderSnapshots(nextState) {
  const list = byId('snapshotList');
  const dir = byId('snapshotsDirPath');
  if (!list || !dir) return;
  const storage = (nextState && nextState.storage) || {};
  dir.textContent = storage.snapshotsDir ? `恢复点目录：${storage.snapshotsDir}` : '';
  const snapshots = Array.isArray(storage.snapshots) ? storage.snapshots : [];
  if (!snapshots.length) {
    list.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'snapshot-empty';
    empty.textContent = '暂无恢复点。打开软件后会按天自动创建，也可手动创建。';
    list.append(empty);
    return;
  }
  list.replaceChildren(...snapshots.map((item) => {
    const row = document.createElement('div');
    row.className = 'snapshot-row';
    row.dataset.snapshotId = item.id;
    const meta = document.createElement('div');
    meta.className = 'snapshot-meta';
    const title = document.createElement('strong');
    title.textContent = `${snapshotKindLabel(item.kind)} · ${item.label || item.id}`;
    const detail = document.createElement('span');
    detail.textContent = `${formatSnapshotTime(item.createdAt)} · ${formatSnapshotSize(item.size)}`;
    meta.append(title, detail);
    const action = document.createElement('button');
    action.type = 'button';
    action.dataset.snapshotAction = 'restore';
    action.dataset.snapshotId = item.id;
    action.textContent = '恢复';
    row.append(meta, action);
    return row;
  }));
}

async function createBook() {
  const name = prompt('新单词本名称');
  if (!name) return;
  await window.moyu.addBook(name);
  const nextState = await window.moyu.getState();
  render(nextState);
  await refreshWords(false);
}
byId('bookManagerAdd').addEventListener('click', createBook);
byId('bookManagerImport').addEventListener('click', importActiveBook);
byId('bookManagerDownload').addEventListener('click', openDownloadBookDialog);
byId('activeBookSelect').addEventListener('change', async (event) => {
  await setCurrentBook(event.target.value);
});
byId('bookManagerList').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-book-action]');
  const row = event.target.closest('.book-manager-row');
  if (!button || !row) return;
  if (button.dataset.bookAction === 'switch') {
    await setCurrentBook(row.dataset.bookId);
    return;
  }
});
byId('bookManagerRename').addEventListener('click', async () => {
  const active = state.books.find((book) => book.active);
  if (!active) return;
  const name = prompt('单词本名称', active.name);
  if (!name) return;
  await window.moyu.renameBook(active.id, name);
  const nextState = await window.moyu.getState();
  render(nextState);
});
byId('bookManagerBackup').addEventListener('click', async () => {
  const notice = byId('bookActionNotice');
  notice.classList.remove('is-error');
  try {
    const result = await window.moyu.saveBackup();
    notice.textContent = result ? '备份已保存。' : '已取消备份。';
  } catch (error) {
    notice.textContent = error.message || '备份失败。';
    notice.classList.add('is-error');
  }
});
byId('bookManagerDelete').addEventListener('click', async () => {
  const active = state && state.books.find((book) => book.active);
  if (!active || !confirm(`删除单词本「${active.name}」？只移除单词本归属，学习记录和复习计划保留。`)) return;
  const notice = byId('bookActionNotice');
  notice.classList.remove('is-error');
  try {
    const result = await window.moyu.deleteBook(active.id);
    const nextState = await window.moyu.getState();
    render(nextState);
    await refreshWords(false);
    notice.textContent = `已删除 ${result.deleted}。`;
  } catch (error) {
    notice.textContent = error.message || '删除单词本失败。';
    notice.classList.add('is-error');
  }
});
byId('wordList').addEventListener('click', (event) => {
  const row = event.target.closest('.word-row');
  if (!row) return;
  if (event.target.matches('input[type="checkbox"]')) {
    event.target.checked ? bulkSelected.add(row.dataset.id) : bulkSelected.delete(row.dataset.id);
    renderBulkSelection();
    return;
  }
  fillForm(words.find((word) => word.id === row.dataset.id) || null);
  showNotice('');
});
byId('selectVisible').addEventListener('click', () => {
  const visible = filteredWords();
  const allSelected = visible.length && visible.every((word) => bulkSelected.has(word.id));
  visible.forEach((word) => {
    if (allSelected) bulkSelected.delete(word.id);
    else bulkSelected.add(word.id);
  });
  renderWordList();
});
byId('clearSelection').addEventListener('click', () => {
  bulkSelected.clear();
  renderWordList();
});
document.querySelectorAll('[data-bulk-action]').forEach((button) => {
  button.addEventListener('click', () => runBulkAction(button.dataset.bulkAction));
});
byId('addSelectedToPlan').addEventListener('click', async () => {
  const selected = words.filter((word) => bulkSelected.has(word.id));
  const newIds = selected.filter((word) => word.status === 'new').map((word) => word.id);
  const reviewIds = selected.filter((word) => word.status !== 'new' && word.status !== 'done').map((word) => word.id);
  if (!newIds.length && !reviewIds.length) {
    showNotice('所选单词不需要加入今日计划。');
    return;
  }
  if (totalPlanCapacityLeft(state && state.stats && state.stats.dailyPlan) <= 0) {
    showNotice('今日目标名额已用完。');
    return;
  }
  try {
    let added = 0;
    if (reviewIds.length) added += (await window.moyu.addReviewWordsToPlan(reviewIds)).added || 0;
    if (newIds.length) added += (await window.moyu.addNewWordsToPlan(newIds)).added || 0;
    await refreshAfterPlanChange(`已加入今日计划：${added} 个。`);
  } catch (error) {
    showNotice(error.message || '加入今日计划失败。', true);
  }
});
byId('managerRandomNew').addEventListener('click', async () => {
  if (totalPlanCapacityLeft(state && state.stats && state.stats.dailyPlan) <= 0) {
    showNotice('今日目标名额已用完。');
    return;
  }
  configureContinueDialog(state.stats.dailyPlan, 'new');
  byId('continueDialog').showModal();
  await previewRandomNew(Math.max(1, Number(byId('managerRandomCount').value) || 10));
});
byId('newWord').addEventListener('click', () => {
  fillForm(null);
  byId('editWord').focus();
  showNotice('填写单词后保存。');
});
byId('wordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const saved = selectedId
      ? await window.moyu.updateWord(selectedId, formRecord())
      : await window.moyu.addWord(formRecord());
    selectedId = saved.id;
    await refreshWords();
    showNotice('已保存。');
  } catch (error) {
    showNotice(error.message || '保存失败。', true);
  }
});
byId('deleteWord').addEventListener('click', async () => {
  if (!selectedId || !confirm(`删除 ${byId('editWord').value}？`)) return;
  try {
    await window.moyu.deleteWord(selectedId);
    selectedId = null;
    await refreshWords(false);
    showNotice('已删除。');
  } catch (error) {
    showNotice(error.message || '删除失败。', true);
  }
});
byId('setCurrent').addEventListener('click', async () => {
  if (!selectedId) return;
  try {
    await window.moyu.setCurrentWord(selectedId);
    showNotice('横条已切换到这个单词。');
  } catch (error) {
    showNotice(error.message || '切换失败。', true);
  }
});

window.moyu.onState(render);
window.moyu.onLookupCurrent((query) => {
  openLookupDialog(query);
});
window.moyu.onOnlineBookProgress(setDownloadProgress);
window.moyu.getState().then((nextState) => {
  render(nextState);
  refreshWords(false);
  window.moyu.getOnlineBookCatalog().then((books) => {
    onlineBooks = books;
    renderOnlineBooks();
  });
});
