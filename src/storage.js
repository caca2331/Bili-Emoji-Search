  function readStoredValue(key, fallbackValue) {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(key, fallbackValue);
      }
    } catch (error) {
      log('GM_getValue failed', error);
    }

    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        return fallbackValue;
      }
      return JSON.parse(raw);
    } catch (error) {
      log('localStorage read failed', error);
      return fallbackValue;
    }
  }

  function writeStoredValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (error) {
      log('GM_setValue failed', error);
    }

    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      log('localStorage write failed', error);
    }
  }

  function loadRecentHistory() {
    const raw = readStoredValue(RECENTS_STORAGE_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }

    return normalizeRecentHistory(raw);
  }

  function getRecentEmojiScore(record, now = Date.now()) {
    if (!record) {
      return 0;
    }

    const baseScore = Math.max(0, Number(record.score) || 0);
    const usedAt = Math.max(0, Number(record.usedAt) || 0);
    if (!baseScore) {
      return 0;
    }

    if (!usedAt) {
      return baseScore;
    }

    const deltaDays = Math.max(0, now - usedAt) / MS_PER_DAY;
    return baseScore * Math.exp(-RECENT_SCORE_LAMBDA * deltaDays);
  }

  function compareRecentHistoryItems(left, right, now = Date.now()) {
    const leftScore = getRecentEmojiScore(left, now);
    const rightScore = getRecentEmojiScore(right, now);

    if (Math.abs(leftScore - rightScore) > 1e-9) {
      return rightScore - leftScore;
    }

    const leftUsedAt = Number(left && left.usedAt) || 0;
    const rightUsedAt = Number(right && right.usedAt) || 0;
    if (leftUsedAt !== rightUsedAt) {
      return rightUsedAt - leftUsedAt;
    }

    return String(left && left.code || '').localeCompare(String(right && right.code || ''));
  }

  function normalizeRecentHistory(history, now = Date.now()) {
    const deduped = new Map();

    for (const item of history) {
      if (!item || typeof item.code !== 'string') {
        continue;
      }

      const code = String(item.code || '').trim();
      if (!code) {
        continue;
      }

      const record = {
        code,
        imageUrl: item.imageUrl || '',
        packageName: item.packageName || '',
        usedAt: Number(item.usedAt) || 0,
        score: Number(item.score) > 0 ? Number(item.score) : 1,
      };

      const existing = deduped.get(code);
      if (!existing) {
        deduped.set(code, record);
        continue;
      }

      const preferred = compareRecentHistoryItems(record, existing, now) < 0 ? record : existing;
      const fallback = preferred === record ? existing : record;

      deduped.set(code, {
        code,
        imageUrl: preferred.imageUrl || fallback.imageUrl || '',
        packageName: preferred.packageName || fallback.packageName || '',
        usedAt: preferred.usedAt,
        score: preferred.score,
      });
    }

    return sortRecentHistory(Array.from(deduped.values()), now).slice(0, MAX_RECENTS);
  }

  function sortRecentHistory(history, now = Date.now()) {
    return history.slice().sort((left, right) => compareRecentHistoryItems(left, right, now));
  }

  function persistRecentHistory(history) {
    writeStoredValue(RECENTS_STORAGE_KEY, normalizeRecentHistory(history));
  }

  function recordRecentEmoji(history, entry, options = {}) {
    const now = Number(options.now) || Date.now();
    const weight = Number(options.weight) > 0 ? Number(options.weight) : RECENT_SCORE_WEIGHT;
    const previous = history.find((item) => item.code === entry.code);
    const nextRecord = {
      code: entry.code,
      imageUrl: entry.imageUrl || (previous && previous.imageUrl) || '',
      packageName: entry.packageName || (previous && previous.packageName) || '',
      usedAt: now,
      score: getRecentEmojiScore(previous, now) + weight,
    };

    const nextHistory = normalizeRecentHistory([
      nextRecord,
      ...history.filter((item) => item.code !== entry.code),
    ], now);

    persistRecentHistory(nextHistory);
    return nextHistory;
  }
