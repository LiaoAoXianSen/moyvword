let lookupRecords = [];

function byId(id) {
  return document.getElementById(id);
}

function focusSearch(select = false) {
  const input = byId('lookupInput');
  setTimeout(() => {
    input.focus();
    if (select) input.select();
  }, 0);
}

function planButtonFor(record, index) {
  const button = document.createElement('button');
  button.type = 'button';
  if (record.inTodayPlan) {
    button.textContent = '已加入';
    button.disabled = true;
  } else if (record.status === 'done') {
    button.textContent = '已掌握';
    button.disabled = true;
  } else if (record.hasLearningRecord || (record.status && record.status !== 'new')) {
    button.dataset.lookupAction = 'plan';
    button.dataset.index = String(index);
    button.textContent = '加入今日复习';
  } else {
    button.dataset.lookupAction = 'plan';
    button.dataset.index = String(index);
    button.textContent = '加入今日记忆';
  }
  return button;
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
    actions.append(planButtonFor(record, index));
    row.append(head, meaning);
    if (record.sentence) row.append(sentence);
    row.append(actions);
    return row;
  }));
}

async function searchLookup(query = byId('lookupInput').value) {
  const term = String(query || '').trim();
  if (!term) {
    focusSearch();
    return;
  }
  byId('lookupInput').value = term;
  byId('lookupNotice').textContent = '正在搜索...';
  byId('lookupResults').replaceChildren();
  try {
    renderLookupResults(await window.moyu.lookupWord(term));
  } catch (error) {
    lookupRecords = [];
    byId('lookupNotice').textContent = error.message || '搜索失败，请稍后重试。';
  } finally {
    focusSearch(true);
  }
}

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
  const planLabel = record.hasLearningRecord || (record.status && record.status !== 'new')
    ? '今日复习'
    : '今日记忆';
  button.disabled = true;
  try {
    const result = await window.moyu.saveLookupWord(record, addToPlan);
    renderLookupResults({ source: 'book', items: [result.word], total: 1 });
    byId('lookupNotice').textContent = addToPlan
      ? (result.added ? `已加入当前词本和${planLabel}。` : `已在当前词本中，未重复加入${planLabel}。`)
      : '已加入当前词本。';
  } catch (error) {
    byId('lookupNotice').textContent = error.message || '添加失败。';
    button.disabled = false;
  } finally {
    focusSearch();
  }
});

window.moyu.onLookupCurrent((query) => {
  const term = String(query || '').trim();
  byId('lookupInput').value = term;
  byId('lookupResults').replaceChildren();
  lookupRecords = [];
  byId('lookupNotice').textContent = term ? '正在搜索...' : '输入单词开始查询。';
  if (term) searchLookup(term);
  else focusSearch();
});

focusSearch();
