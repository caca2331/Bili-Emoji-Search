  function createEmojiEntry(rawEntry) {
    const code = String(rawEntry.code || '').trim();
    if (!code) {
      return null;
    }

    return {
      code,
      label: stripCodeBrackets(code),
      imageUrl: rawEntry.imageUrl || '',
      packageName: rawEntry.packageName || '',
      order: Number(rawEntry.order) || 0,
      previewText: rawEntry.previewText || '',
      searchLoose: normalizeSearchText(code),
      searchCompact: compactSearchText(code),
    };
  }

  function buildRecentEntries(registry, recentHistory) {
    const recentEntries = buildAvailableRecentPrefix(registry, recentHistory);
    const output = recentEntries.slice();
    const seenCodes = new Set(recentEntries.map((entry) => entry.code));

    for (const entry of registry) {
      if (seenCodes.has(entry.code)) {
        continue;
      }
      seenCodes.add(entry.code);
      output.push(entry);
    }

    return output;
  }

  function buildAvailableRecentPrefix(registry, recentHistory) {
    const registryMap = new Map(registry.map((entry) => [entry.code, entry]));
    const output = [];
    const sortedHistory = sortRecentHistory(recentHistory);
    const seenCodes = new Set();

    for (const recent of sortedHistory) {
      const registryEntry = registryMap.get(recent.code);
      if (registryEntry && !seenCodes.has(registryEntry.code)) {
        seenCodes.add(registryEntry.code);
        output.push(registryEntry);
      }
    }

    return output;
  }

  function getSubsequenceMatch(haystack, needle) {
    const source = String(haystack || '');
    const query = String(needle || '');

    if (!query) {
      return {
        matched: true,
        start: 0,
        end: -1,
        span: 0,
        gaps: 0,
      };
    }

    let queryIndex = 0;
    let start = -1;
    let end = -1;

    for (let index = 0; index < source.length; index += 1) {
      if (source.charAt(index) !== query.charAt(queryIndex)) {
        continue;
      }

      if (start < 0) {
        start = index;
      }

      queryIndex += 1;
      end = index;

      if (queryIndex === query.length) {
        break;
      }
    }

    if (queryIndex !== query.length) {
      return null;
    }

    const span = end - start + 1;
    return {
      matched: true,
      start,
      end,
      span,
      gaps: Math.max(0, span - query.length),
    };
  }

  function scoreEmojiEntry(entry, rawQuery, matchMeta) {
    const normalizedRawQuery = stripInvisible(normalizePunctuation(rawQuery)).trim();
    const normalizedEntryCode = stripInvisible(normalizePunctuation(entry.code)).trim();
    const compactQuery = compactSearchText(rawQuery);
    const looseQuery = normalizeSearchText(rawQuery);
    const compactCode = entry.searchCompact;
    const looseCode = entry.searchLoose;
    const compactMatch = matchMeta && matchMeta.compact;
    const looseMatch = matchMeta && matchMeta.loose;
    let score = 0;

    if (normalizedEntryCode === normalizedRawQuery) {
      score += 80000;
    }

    if (compactCode === compactQuery) {
      score += 50000;
    } else if (compactCode.startsWith(compactQuery)) {
      score += 30000;
    } else if (looseCode.startsWith(looseQuery)) {
      score += 20000;
    } else if (compactCode.includes(compactQuery)) {
      score += 12000;
    } else if (looseCode.includes(looseQuery)) {
      score += 8000;
    } else if (compactMatch) {
      score += 5000 - compactMatch.gaps * 20 - compactMatch.start * 4;
    } else if (looseMatch) {
      score += 3000 - looseMatch.gaps * 12 - looseMatch.start * 2;
    }

    score -= entry.order;
    return score;
  }

  function searchEmojiEntries(registry, recentHistory, query) {
    const compactQuery = compactSearchText(query);
    const looseQuery = normalizeSearchText(query);
    const now = Date.now();
    const recentScoreMap = new Map();

    for (const entry of recentHistory) {
      const score = getRecentEmojiScore(entry, now);
      const existingScore = recentScoreMap.get(entry.code) || 0;
      if (score > existingScore) {
        recentScoreMap.set(entry.code, score);
      }
    }

    const matches = registry
      .map((entry) => {
        return {
          entry,
          matchMeta: {
            compact: getSubsequenceMatch(entry.searchCompact, compactQuery),
            loose: getSubsequenceMatch(entry.searchLoose, looseQuery),
          },
        };
      })
      .filter((item) => item.matchMeta.compact || item.matchMeta.loose);

    matches.sort((left, right) => {
      const leftRecentScore = recentScoreMap.get(left.entry.code) || 0;
      const rightRecentScore = recentScoreMap.get(right.entry.code) || 0;
      if (Math.abs(leftRecentScore - rightRecentScore) > 1e-9) {
        return rightRecentScore - leftRecentScore;
      }

      const leftScore = scoreEmojiEntry(left.entry, query, left.matchMeta);
      const rightScore = scoreEmojiEntry(right.entry, query, right.matchMeta);

      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      return left.entry.order - right.entry.order;
    });

    return matches.slice(0, SEARCH_RESULT_LIMIT).map((item) => item.entry);
  }
