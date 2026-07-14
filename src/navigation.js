/**
 * Browse navigation is separate from study scheduling.
 *
 * liveWordId  = the study frontier (what you return to after reviewing history)
 * trail       = words already left behind while studying (browser-style, never pop)
 * mode        = live | history | manual
 * index       = position in trail when mode === 'history'
 * manualWordId= library-picked preview when mode === 'manual'
 *
 * previous/next only move the view. Rating on a live word advances the frontier.
 * Rating/skip while browsing returns to the frontier without destroying trail.
 */

const MAX_TRAIL = 200;

function defaultNavigation(seed = {}) {
  const trail = Array.isArray(seed.trail)
    ? seed.trail.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const mode = seed.mode === 'history' || seed.mode === 'manual' ? seed.mode : 'live';
  let index = Number.isFinite(Number(seed.index)) ? Math.floor(Number(seed.index)) : trail.length;
  if (mode === 'history') {
    if (!trail.length) {
      return {
        mode: 'live',
        liveWordId: seed.liveWordId || null,
        trail: [],
        index: 0,
        manualWordId: ''
      };
    }
    index = Math.max(0, Math.min(trail.length - 1, index));
  } else {
    index = trail.length;
  }
  return {
    mode,
    liveWordId: seed.liveWordId ? String(seed.liveWordId) : null,
    trail,
    index,
    manualWordId: mode === 'manual' && seed.manualWordId ? String(seed.manualWordId) : ''
  };
}

function migrateNavigation(rawNav, legacy = {}) {
  if (rawNav && typeof rawNav === 'object' && (Array.isArray(rawNav.trail) || rawNav.mode || rawNav.liveWordId)) {
    return defaultNavigation(rawNav);
  }

  const history = Array.isArray(legacy.history)
    ? legacy.history.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const currentId = legacy.currentId ? String(legacy.currentId) : null;
  const manualPreviewId = legacy.manualPreviewId ? String(legacy.manualPreviewId) : '';
  const manualReturnId = legacy.manualReturnId ? String(legacy.manualReturnId) : '';

  // Old builds used manualPreviewId + manualReturnId for both "previous" and library preview.
  // Prefer those flags over currentId, because some saves left currentId on the live word.
  if (manualPreviewId) {
    if (manualReturnId && manualReturnId !== manualPreviewId) {
      const trail = history.includes(manualPreviewId)
        ? history.slice()
        : history.concat(manualPreviewId);
      const index = Math.max(0, trail.lastIndexOf(manualPreviewId));
      return defaultNavigation({
        mode: 'history',
        liveWordId: manualReturnId,
        trail,
        index,
        manualWordId: ''
      });
    }
    return defaultNavigation({
      mode: 'manual',
      liveWordId: manualReturnId || (currentId !== manualPreviewId ? currentId : null),
      trail: history,
      index: history.length,
      manualWordId: manualPreviewId
    });
  }

  return defaultNavigation({
    mode: 'live',
    liveWordId: currentId,
    trail: history,
    index: history.length,
    manualWordId: ''
  });
}

function clampTrail(trail) {
  if (trail.length <= MAX_TRAIL) return trail;
  return trail.slice(-MAX_TRAIL);
}

function viewWordId(nav) {
  if (!nav) return null;
  if (nav.mode === 'manual') return nav.manualWordId || null;
  if (nav.mode === 'history') {
    if (!nav.trail.length) return nav.liveWordId || null;
    const index = Math.max(0, Math.min(nav.trail.length - 1, nav.index));
    return nav.trail[index] || null;
  }
  return nav.liveWordId || null;
}

function isBrowsing(nav) {
  return !!nav && (nav.mode === 'history' || nav.mode === 'manual');
}

function appendUnique(trail, wordId) {
  if (!wordId) return trail;
  if (trail[trail.length - 1] === wordId) return trail;
  return clampTrail(trail.concat(wordId));
}

/** Advance the study frontier after a real live rating/skip. */
function advanceLive(nav, nextLiveId) {
  const current = defaultNavigation(nav);
  let trail = current.trail.slice();
  if (current.mode === 'live' && current.liveWordId && current.liveWordId !== nextLiveId) {
    trail = appendUnique(trail, current.liveWordId);
  }
  return {
    mode: 'live',
    liveWordId: nextLiveId || null,
    trail,
    index: trail.length,
    manualWordId: ''
  };
}

/** Jump study frontier without treating current browse view as a study step. */
function setLive(nav, liveWordId) {
  const current = defaultNavigation(nav);
  const trail = current.trail.slice();
  return {
    mode: 'live',
    liveWordId: liveWordId || null,
    trail,
    index: trail.length,
    manualWordId: ''
  };
}

/** Leave history/manual preview and show the study frontier again. */
function returnToLive(nav, liveWordId = undefined) {
  const current = defaultNavigation(nav);
  return {
    mode: 'live',
    liveWordId: liveWordId === undefined ? current.liveWordId : (liveWordId || null),
    trail: current.trail.slice(),
    index: current.trail.length,
    manualWordId: ''
  };
}

function goPrevious(nav) {
  const current = defaultNavigation(nav);
  if (current.mode === 'live' || current.mode === 'manual') {
    if (!current.trail.length) return current;
    return {
      ...current,
      mode: 'history',
      index: current.trail.length - 1,
      manualWordId: ''
    };
  }
  if (!current.trail.length) {
    return returnToLive(current);
  }
  return {
    ...current,
    mode: 'history',
    index: Math.max(0, current.index - 1),
    manualWordId: ''
  };
}

/**
 * Move forward in browse history.
 * Returns { nav, atLive } — when atLive, caller may keep live word or chooseNext.
 */
function goNext(nav) {
  const current = defaultNavigation(nav);
  if (current.mode === 'live') {
    return { nav: current, atLive: true };
  }
  if (current.mode === 'history' && current.index < current.trail.length - 1) {
    return {
      nav: {
        ...current,
        mode: 'history',
        index: current.index + 1,
        manualWordId: ''
      },
      atLive: false
    };
  }
  return { nav: returnToLive(current), atLive: true };
}

function enterManual(nav, wordId) {
  const current = defaultNavigation(nav);
  if (!wordId) return current;
  // If user is already on live frontier, remember it; don't append manual picks into trail.
  return {
    ...current,
    mode: 'manual',
    manualWordId: String(wordId),
    // Keep liveWordId as return target. If live was empty, stay empty.
    index: current.trail.length
  };
}

function removeWord(nav, wordId) {
  const current = defaultNavigation(nav);
  if (!wordId) return current;
  const trail = current.trail.filter((id) => id !== wordId);
  let mode = current.mode;
  let manualWordId = current.manualWordId;
  let liveWordId = current.liveWordId === wordId ? null : current.liveWordId;
  let index = current.index;

  if (manualWordId === wordId) {
    mode = 'live';
    manualWordId = '';
  }
  if (mode === 'history') {
    if (!trail.length) {
      mode = 'live';
      index = 0;
    } else {
      index = Math.max(0, Math.min(trail.length - 1, index > 0 ? index - 1 : 0));
      // If the removed id was the viewed one, index already points at a neighbor.
    }
  } else {
    index = trail.length;
  }

  return {
    mode,
    liveWordId,
    trail,
    index,
    manualWordId
  };
}

function removeWords(nav, wordIds) {
  const idSet = new Set((wordIds || []).map(String));
  let next = defaultNavigation(nav);
  idSet.forEach((id) => {
    next = removeWord(next, id);
  });
  return next;
}

module.exports = {
  MAX_TRAIL,
  defaultNavigation,
  migrateNavigation,
  viewWordId,
  isBrowsing,
  advanceLive,
  setLive,
  returnToLive,
  goPrevious,
  goNext,
  enterManual,
  removeWord,
  removeWords
};
