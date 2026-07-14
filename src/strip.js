let latestState;
let expanded = false;
let currentAudio;
let lastAutoSpokenWordId = '';

function el(id) {
  return document.getElementById(id);
}

function applyAppearance(settings = {}) {
  const appearance = settings.stripAppearance || {};
  const opacity = Math.max(40, Math.min(100, Math.round(Number(appearance.opacity) || 93))) / 100;
  const textColor = /^#[0-9a-fA-F]{6}$/.test(String(appearance.textColor || ''))
    ? String(appearance.textColor).toLowerCase()
    : '#243044';
  document.documentElement.style.setProperty('--strip-opacity', String(opacity));
  document.documentElement.style.setProperty('--strip-ink-custom', textColor);
}

function setCompactMode(enabled) {
  document.body.classList.toggle('is-compact', enabled);
  const button = el('toggleCompactMode');
  if (!button) return;
  button.textContent = enabled ? '全' : '简';
  button.setAttribute('aria-pressed', String(enabled));
  button.title = enabled ? '切换完整显示' : '切换专注显示';
}

function speakWithSystemVoice(word, volume) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  const englishVoice = window.speechSynthesis.getVoices()
    .find((voice) => String(voice.lang || '').toLowerCase().startsWith('en'));
  if (englishVoice) utterance.voice = englishVoice;
  utterance.lang = englishVoice ? englishVoice.lang : 'en-US';
  utterance.rate = 0.88;
  utterance.volume = volume;
  window.speechSynthesis.speak(utterance);
}

function speakWord(word) {
  const text = String(word && word.word || '').trim();
  if (!text) return;
  const configuredVolume = latestState && latestState.settings ? latestState.settings.audioVolume : 80;
  const volume = Math.max(0, Math.min(1, Number(configuredVolume ?? 80) / 100));
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  let usedFallback = false;
  const useFallback = () => {
    if (usedFallback) return;
    usedFallback = true;
    speakWithSystemVoice(text, volume);
  };
  const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`);
  currentAudio = audio;
  audio.volume = volume;
  audio.addEventListener('error', useFallback, { once: true });
  audio.play().catch(useFallback);
}

function render(state) {
  latestState = state;
  applyAppearance(state.settings || {});
  setCompactMode(Boolean(state.settings && state.settings.stripCompactMode));
  const word = state.word;
  if (!word) {
    el('word').textContent = '没有单词';
    el('phonetic').textContent = '';
    el('quickMeaning').textContent = '导入一个词书开始';
    el('meaning').textContent = '导入一个词书开始';
    el('sentence').textContent = '';
    return;
  }

  el('mode').textContent = `${word.queueLabel} · ${word.stageLabel} · 保持${word.retention}%`;
  el('due').textContent = `下次 ${word.dueLabel}`;
  el('word').textContent = word.word;
  el('phonetic').textContent = word.phonetic || '';

  if (state.settings && state.settings.autoSpeak && word.id !== lastAutoSpokenWordId) {
    lastAutoSpokenWordId = word.id;
    queueMicrotask(() => speakWord(word));
  }

  if (state.revealed) {
    el('quickMeaning').textContent = word.meaning || '暂无释义';
    el('meaning').textContent = word.meaning || '暂无释义，可在面板里编辑';
    el('sentence').textContent = word.sentence || '可在管理面板里补充例句。';
  } else {
    el('quickMeaning').textContent = '点击“答”后显示释义';
    el('meaning').textContent = 'Alt+F 看答案';
    el('sentence').textContent = '先回忆，再评分。';
  }
}

function toggleDetails() {
  expanded = !expanded;
  document.body.classList.toggle('is-expanded', expanded);
  el('toggleDetails').title = expanded ? '收起单词详情' : '展开单词详情';
  window.moyu.setStripExpanded(expanded);
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

window.addEventListener('keydown', (event) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
  const action = localShortcuts[String(event.key || '').toLowerCase()];
  if (!action) return;
  event.preventDefault();
  window.moyu.action(action);
});

document.querySelectorAll('button[data-action]').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    window.moyu.action(button.dataset.action);
  });
});

el('dragRegion').addEventListener('click', (event) => {
  if (event.target.closest('button[data-action]')) return;
  toggleDetails();
});

el('dragRegion').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  event.stopPropagation();
  window.moyu.showContextMenu();
});

el('toggleDetails').addEventListener('click', (event) => {
  event.preventDefault();
});

window.moyu.onState(render);
window.moyu.onSpeakCurrent(() => {
  const word = latestState && latestState.word;
  speakWord(word);
});

window.moyu.getState().then(render);
