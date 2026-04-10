// ==UserScript==
// @name         Bilibili Emoji Search
// @namespace    https://github.com/caca2331/
// @version      1.0.0
// @description  使用 / 关键词快速搜索并插入 Bilibili 原生表情
// @match        https://*.bilibili.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==


  const BUILD_INFO = Object.freeze({
    version: '1.0.0',
    variant: 'release',
    debug: false,
  });

  function describeNode(node) {
    if (!node || typeof node !== 'object') {
      return null;
    }

    if (typeof Node !== 'undefined' && node.nodeType === Node.TEXT_NODE) {
      return {
        nodeName: '#text',
      };
    }

    const output = {
      nodeName: node.nodeName || '',
    };

    if (node.id) {
      output.id = node.id;
    }

    if (typeof node.className === 'string' && node.className) {
      output.className = node.className;
    }

    return output;
  }

  function log() {}

  function logWarn(...args) {
    console.warn('[bili-emoji-search]', ...args);
  }

  function logError(...args) {
    console.error('[bili-emoji-search]', ...args);
  }

  function getDebugEvents() {
    return [];
  }

  function clearDebugEvents() {}


(function () {
  'use strict';

  const APP_NAMESPACE = 'bili-emoji-search';
  const STYLE_ID = `${APP_NAMESPACE}-style`;
  const INTERNAL_STYLE_ID = `${APP_NAMESPACE}-internal-style`;
  const PANEL_ID = `${APP_NAMESPACE}-panel`;
  const RECENTS_STORAGE_KEY = `${APP_NAMESPACE}:recents:v1`;
  const FORCE_HIDDEN_ATTR = `data-${APP_NAMESPACE}-force-hidden`;
  const SESSION_MAX_DISTANCE = 20;
  const SEARCH_RESULT_LIMIT = 96;
  const MAX_RECENTS = 500;
  const PANEL_MAX_WIDTH = 460;
  const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;
  const HARVEST_WAIT_MS = 120;
  const RECENT_SCORE_LAMBDA = 0.0231;
  const RECENT_SCORE_WEIGHT = 1;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function nextFrame() {
    return new Promise((resolve) => window.requestAnimationFrame(resolve));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function stripInvisible(text) {
    return String(text || '')
      .replace(/\u200b/g, '')
      .replace(/\r/g, '')
      .replace(/\u00a0/g, ' ');
  }

  function stripCodeBrackets(text) {
    return String(text || '').replace(/^\[/, '').replace(/\]$/, '');
  }

  function normalizePunctuation(text) {
    const raw = stripInvisible(text);
    const translated = raw.replace(/[\uFF01-\uFF5E]/g, (char) => {
      return String.fromCharCode(char.charCodeAt(0) - 0xFEE0);
    }).replace(/\u3000/g, ' ');

    return translated.replace(/[。、】【】、：；！？（）《》「」『』“”‘’～—…]/g, (char) => {
      switch (char) {
        case '。':
          return '.';
        case '、':
          return ',';
        case '【':
          return '[';
        case '】':
          return ']';
        case '：':
          return ':';
        case '；':
          return ';';
        case '！':
          return '!';
        case '？':
          return '?';
        case '（':
          return '(';
        case '）':
          return ')';
        case '《':
        case '「':
        case '『':
        case '“':
          return '"';
        case '》':
        case '」':
        case '』':
        case '”':
          return '"';
        case '‘':
          return '\'';
        case '’':
          return '\'';
        case '～':
          return '~';
        case '—':
          return '-';
        case '…':
          return '...';
        default:
          return char;
      }
    });
  }

  function normalizeSearchText(text) {
    return normalizePunctuation(text)
      .replace(/\[/g, ' ')
      .replace(/\]/g, ' ')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function compactSearchText(text) {
    return normalizeSearchText(text).replace(/\s+/g, '');
  }

  function uniqueBy(items, keyFn) {
    const seen = new Set();
    const output = [];

    for (const item of items) {
      const key = keyFn(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push(item);
    }

    return output;
  }

  function getComposedParent(node) {
    if (!node) {
      return null;
    }
    if (node.assignedSlot) {
      return node.assignedSlot;
    }
    if (node.parentNode) {
      return node.parentNode;
    }
    if (node.host) {
      return node.host;
    }
    return null;
  }

  function getComposedChain(node) {
    const chain = [];
    let current = node;

    while (current) {
      chain.push(current);
      current = getComposedParent(current);
    }

    return chain;
  }

  function findInComposedChain(node, matcher) {
    const chain = getComposedChain(node);
    return chain.find((item) => item && matcher(item)) || null;
  }

  function queryDeepAll(root, matcher, maxDepth = 8) {
    const results = [];

    function visit(currentRoot, depth) {
      if (!currentRoot || depth > maxDepth || typeof currentRoot.querySelectorAll !== 'function') {
        return;
      }

      const nodes = currentRoot.querySelectorAll('*');
      for (const node of nodes) {
        if (matcher(node)) {
          results.push(node);
        }
        if (node.shadowRoot) {
          visit(node.shadowRoot, depth + 1);
        }
      }
    }

    visit(root, 0);
    return results;
  }

  function resolveEditorFromNode(node) {
    const chain = getComposedChain(node);
    return (
      chain.find((candidate) => {
        return (
          candidate &&
          candidate.nodeType === Node.ELEMENT_NODE &&
          candidate.isContentEditable &&
          (
            candidate.classList.contains('brt-editor') ||
            candidate.classList.contains('bili-rich-textarea__inner')
          )
        );
      }) || null
    );
  }

  function resolveEditorFromEvent(event) {
    if (typeof event.composedPath === 'function') {
      const path = event.composedPath();
      for (const item of path) {
        const editor = resolveEditorFromNode(item);
        if (editor) {
          return editor;
        }
      }
    }

    return resolveEditorFromNode(event.target);
  }

  function getEditableText(root) {
    if (!root) {
      return '';
    }
    const raw = typeof root.innerText === 'string' ? root.innerText : root.textContent;
    return stripInvisible(raw);
  }

  function getTextSegments(root) {
    const segments = [];

    if (!root || !root.ownerDocument) {
      return segments;
    }

    const walker = root.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      }
    );

    let current = walker.nextNode();
    while (current) {
      if (current.nodeType === Node.TEXT_NODE) {
        segments.push({
          type: 'text',
          node: current,
          length: current.nodeValue.length,
        });
      } else {
        segments.push({
          type: 'br',
          node: current,
          length: 1,
        });
      }
      current = walker.nextNode();
    }

    return segments;
  }

  function measureTextOffset(root, container, offset) {
    const segments = getTextSegments(root);
    let total = 0;

    for (const segment of segments) {
      if (segment.node === container) {
        return total + Math.min(offset, segment.length);
      }
      total += segment.length;
    }

    try {
      const range = root.ownerDocument.createRange();
      range.selectNodeContents(root);
      range.setEnd(container, offset);
      return stripInvisible(range.toString()).length;
    } catch (error) {
      return total;
    }
  }

  function isNodeInsideRoot(root, node) {
    if (!root || !node) {
      return false;
    }

    if (root === node) {
      return true;
    }

    return getComposedChain(node).indexOf(root) >= 0;
  }

  function editorAppearsFocused(root) {
    if (!root || !root.isConnected) {
      return false;
    }

    try {
      if (typeof root.matches === 'function' && root.matches(':focus')) {
        return true;
      }
    } catch (error) {}

    const rootChain = getComposedChain(root);
    const ownerDocument = root.ownerDocument || document;
    const docActive = ownerDocument.activeElement;
    if (docActive && rootChain.indexOf(docActive) >= 0) {
      return true;
    }

    const rootNode = typeof root.getRootNode === 'function' ? root.getRootNode() : null;
    const rootActive = rootNode && rootNode.activeElement ? rootNode.activeElement : null;
    if (rootActive && (rootActive === root || isNodeInsideRoot(root, rootActive) || rootChain.indexOf(rootActive) >= 0)) {
      return true;
    }

    return false;
  }

  function getSelectionCandidates(root) {
    const candidates = [];
    const rootNode = typeof root.getRootNode === 'function' ? root.getRootNode() : null;

    function pushRange(range, source) {
      if (!range || !range.startContainer || !range.endContainer) {
        return;
      }

      candidates.push({
        range,
        source,
      });
    }

    function pushSelection(selection, source) {
      if (!selection || selection.rangeCount === 0) {
        return;
      }

      try {
        pushRange(selection.getRangeAt(0), source);
      } catch (error) {}
    }

    if (rootNode && rootNode !== root.ownerDocument && typeof rootNode.getSelection === 'function') {
      try {
        pushSelection(rootNode.getSelection(), 'root');
      } catch (error) {}
    }

    const selection = window.getSelection();
    if (selection) {
      if (rootNode && typeof ShadowRoot !== 'undefined' && rootNode instanceof ShadowRoot && typeof selection.getComposedRanges === 'function') {
        try {
          const composedRanges = selection.getComposedRanges({
            shadowRoots: [rootNode],
          });
          for (const range of composedRanges) {
            pushRange(range, 'document-composed');
          }
        } catch (error) {}
      }

      pushSelection(selection, 'document');
    }

    return candidates;
  }

  function getSelectionOffsets(root) {
    const candidates = getSelectionCandidates(root);

    for (const candidate of candidates) {
      const range = candidate.range;
      if (!isNodeInsideRoot(root, range.startContainer) || !isNodeInsideRoot(root, range.endContainer)) {
        continue;
      }

      return {
        start: measureTextOffset(root, range.startContainer, range.startOffset),
        end: measureTextOffset(root, range.endContainer, range.endOffset),
        collapsed: typeof range.collapsed === 'boolean'
          ? range.collapsed
          : (
            range.startContainer === range.endContainer &&
            range.startOffset === range.endOffset
          ),
        source: candidate.source,
      };
    }

    if (editorAppearsFocused(root)) {
      const textLength = getEditableText(root).length;
      return {
        start: textLength,
        end: textLength,
        collapsed: true,
        source: 'fallback-end',
        inferred: true,
      };
    }

    return null;
  }

  function resolveTextPosition(root, targetOffset) {
    const segments = getTextSegments(root);
    let remaining = targetOffset;

    for (const segment of segments) {
      if (remaining <= segment.length) {
        if (segment.type === 'text') {
          return {
            container: segment.node,
            offset: remaining,
          };
        }

        const parent = segment.node.parentNode;
        const index = Array.prototype.indexOf.call(parent.childNodes, segment.node);
        return {
          container: parent,
          offset: index + (remaining > 0 ? 1 : 0),
        };
      }

      remaining -= segment.length;
    }

    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      if (last.type === 'text') {
        return {
          container: last.node,
          offset: last.length,
        };
      }
    }

    if (!root.firstChild) {
      const textNode = root.ownerDocument.createTextNode('');
      root.appendChild(textNode);
      return {
        container: textNode,
        offset: 0,
      };
    }

    return {
      container: root,
      offset: root.childNodes.length,
    };
  }

  function dispatchSyntheticInput(target, inputType, data) {
    if (!target) {
      return;
    }

    try {
      target.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType,
        data,
      }));
      return;
    } catch (error) {
      target.dispatchEvent(new Event('input', {
        bubbles: true,
        composed: true,
      }));
    }
  }

  function replaceTextInContentEditable(root, startOffset, endOffset, text) {
    if (!root) {
      return false;
    }

    root.focus();

    const selection = window.getSelection();
    const range = root.ownerDocument.createRange();
    const start = resolveTextPosition(root, startOffset);
    const end = resolveTextPosition(root, endOffset);

    range.setStart(start.container, start.offset);
    range.setEnd(end.container, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);

    let succeeded = false;

    try {
      if (typeof document.execCommand === 'function') {
        succeeded = document.execCommand('insertText', false, text);
      }
    } catch (error) {
      succeeded = false;
    }

    if (!succeeded) {
      range.deleteContents();
      const textNode = root.ownerDocument.createTextNode(text);
      range.insertNode(textNode);
      range.setStart(textNode, text.length);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    log('replace contenteditable text', {
      editor: describeNode(root),
      startOffset,
      endOffset,
      text,
      usedExecCommand: succeeded,
    });
    dispatchSyntheticInput(root, 'insertText', text);
    return true;
  }

  function replaceTextInTextarea(textarea, startOffset, endOffset, text) {
    if (!textarea) {
      return false;
    }

    textarea.focus();
    textarea.setSelectionRange(startOffset, endOffset);
    textarea.setRangeText(text, startOffset, endOffset, 'end');
    log('replace textarea text', {
      editor: describeNode(textarea),
      startOffset,
      endOffset,
      text,
    });
    dispatchSyntheticInput(textarea, 'insertText', text);
    return true;
  }

  function waitFor(predicate, options = {}) {
    const timeoutMs = options.timeoutMs || 4000;
    const intervalMs = options.intervalMs || 50;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      function check() {
        let result = null;

        try {
          result = predicate();
        } catch (error) {
          result = null;
        }

        if (result) {
          resolve(result);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          resolve(null);
          return;
        }

        window.setTimeout(check, intervalMs);
      }

      check();
    });
  }

  function stashInlineStyle(element) {
    if (!element) {
      return () => {};
    }

    const previous = element.getAttribute('style');
    return () => {
      if (previous === null) {
        element.removeAttribute('style');
      } else {
        element.setAttribute('style', previous);
      }
    };
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    return element.getBoundingClientRect().width > 0 || element.getBoundingClientRect().height > 0;
  }

  function forceHiddenElement(element) {
    if (!element) {
      return () => {};
    }

    const previous = element.getAttribute(FORCE_HIDDEN_ATTR);
    const trackedProperties = ['visibility', 'opacity', 'pointer-events'];
    const previousStyles = trackedProperties.map((propertyName) => ({
      propertyName,
      value: element.style.getPropertyValue(propertyName),
      priority: element.style.getPropertyPriority(propertyName),
    }));

    element.setAttribute(FORCE_HIDDEN_ATTR, '1');
    element.style.setProperty('visibility', 'hidden', 'important');
    element.style.setProperty('opacity', '0', 'important');
    element.style.setProperty('pointer-events', 'none', 'important');

    return () => {
      for (const item of previousStyles) {
        if (!item.value) {
          element.style.removeProperty(item.propertyName);
        } else {
          element.style.setProperty(item.propertyName, item.value, item.priority);
        }
      }

      if (previous === null) {
        element.removeAttribute(FORCE_HIDDEN_ATTR);
      } else {
        element.setAttribute(FORCE_HIDDEN_ATTR, previous);
      }
    };
  }


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


  function getAdapterKind(editor) {
    if (!editor) {
      return null;
    }

    if (editor.classList.contains('bili-rich-textarea__inner')) {
      return 'dynamic-publisher';
    }

    if (editor.classList.contains('brt-editor')) {
      return 'comment-box';
    }

    return null;
  }

  function findCommentArea(editor) {
    const chain = getComposedChain(editor).filter((node) => node && node.nodeType === Node.ELEMENT_NODE);

    for (const node of chain) {
      if (node.id === 'comment-area') {
        return node;
      }
    }

    for (const node of chain) {
      if (typeof node.querySelector !== 'function') {
        continue;
      }

      const emojiButton = node.querySelector('button.tool-btn.emoji');
      const emojiPopover = node.querySelector('#emoji-popover');
      if (emojiButton && emojiPopover) {
        return node;
      }
    }

    return null;
  }

  function findCommentContext(editor) {
    const area = findCommentArea(editor);
    if (!area) {
      return null;
    }

    return {
      kind: 'comment-box',
      editor,
      area,
      anchor: area,
      emojiButton: area.querySelector('button.tool-btn.emoji'),
      emojiPopover: area.querySelector('#emoji-popover'),
    };
  }

  function findDynamicPublisherContext(editor) {
    const publishing = editor.closest('.bili-dyn-publishing');
    if (!publishing) {
      return null;
    }

    return {
      kind: 'dynamic-publisher',
      editor,
      area: publishing,
      anchor: publishing.querySelector('.bili-rich-textarea') || editor,
      emojiButton: publishing.querySelector('.bili-dyn-publishing__tools__item.emoji'),
      emojiPanel: publishing.querySelector('.bili-emoji'),
    };
  }

  function getEditorContext(editor) {
    const kind = getAdapterKind(editor);
    if (kind === 'dynamic-publisher') {
      return findDynamicPublisherContext(editor);
    }
    if (kind === 'comment-box') {
      return findCommentContext(editor);
    }
    return null;
  }

  function isEmojiCode(code) {
    return /^\[[^\]]+\]$/.test(stripInvisible(code).trim());
  }

  function resolveCommentPickerPackageName(path) {
    const picker = path.find((node) => {
      return node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BILI-EMOJI-PICKER';
    });

    if (!picker || !picker.shadowRoot) {
      return '';
    }

    const header = picker.shadowRoot.querySelector('#header');
    return stripInvisible((header && header.textContent) || '');
  }

  function resolveCommentNativeEmojiEntry(path) {
    for (const node of path) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const emojiNode = findInComposedChain(node, (candidate) => {
        return candidate && candidate.nodeType === Node.ELEMENT_NODE && candidate.classList && candidate.classList.contains('emoji');
      });

      if (!emojiNode) {
        continue;
      }

      const entry = readEmojiItem(emojiNode, resolveCommentPickerPackageName(path), 0);
      if (entry && isEmojiCode(entry.code)) {
        return entry;
      }
    }

    return null;
  }

  function resolveDynamicNativeEmojiEntry(path) {
    const itemNode = path.find((node) => {
      return node && node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('bili-emoji__list__item');
    });

    if (!itemNode) {
      return null;
    }

    const panel = itemNode.closest('.bili-emoji');
    const activePackageImage = panel && panel.querySelector('.bili-emoji__pkg.active img');
    const packageName = activePackageImage && activePackageImage.alt ? activePackageImage.alt : '';
    const entry = readEmojiItem(itemNode, packageName, 0);

    if (entry && isEmojiCode(entry.code)) {
      return entry;
    }

    return null;
  }

  function resolveNativeEmojiEntryFromClickEvent(event) {
    const path = event && typeof event.composedPath === 'function' ? event.composedPath() : [event && event.target];
    if (!Array.isArray(path) || !path.length) {
      return null;
    }

    return resolveCommentNativeEmojiEntry(path) || resolveDynamicNativeEmojiEntry(path);
  }

  function readEmojiItem(itemNode, packageName, order) {
    const image = itemNode.tagName === 'IMG' ? itemNode : itemNode.querySelector('img');
    const code = (
      (image && image.alt) ||
      itemNode.getAttribute('data-text') ||
      itemNode.getAttribute('title') ||
      stripInvisible(itemNode.innerText || itemNode.textContent)
    ).trim();

    const entry = createEmojiEntry({
      code,
      imageUrl: image ? image.src : '',
      packageName,
      order,
      previewText: image ? '' : code,
    });

    return entry;
  }

  function readEmojiPackagesFromPicker(picker) {
    if (!picker) {
      return [];
    }

    try {
      if (Array.isArray(picker.__packages) && picker.__packages.length) {
        return picker.__packages;
      }
    } catch (error) {
      logWarn('comment registry: reading picker.__packages failed', error);
    }

    return [];
  }

  function buildEntriesFromCommentPackages(packages) {
    const entries = new Map();
    let order = 0;

    for (const pkg of packages) {
      const packageName = stripInvisible((pkg && pkg.text) || '表情');
      const emotes = pkg && Array.isArray(pkg.emote) ? pkg.emote : [];

      for (const emote of emotes) {
        const entry = createEmojiEntry({
          code: emote && emote.text,
          imageUrl: (emote && (emote.gif_url || emote.url)) || '',
          packageName,
          order,
          previewText: '',
        });
        order += 1;

        if (entry && !entries.has(entry.code)) {
          entries.set(entry.code, entry);
        }
      }
    }

    return Array.from(entries.values());
  }

  async function harvestScrollableEmojiList(options) {
    const entries = new Map();
    const scrollContainer = options.scrollContainer;
    const itemProvider = options.itemProvider;
    const packageName = options.packageName;
    let order = options.orderSeed || 0;
    let stableRounds = 0;
    let previousCount = -1;

    for (let round = 0; round < 40; round += 1) {
      const currentItems = itemProvider();

      for (const item of currentItems) {
        const entry = readEmojiItem(item, packageName, order);
        order += 1;
        if (entry && !entries.has(entry.code)) {
          entries.set(entry.code, entry);
        }
      }

      if (entries.size === previousCount) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }

      previousCount = entries.size;

      if (!scrollContainer) {
        if (stableRounds >= 1) {
          break;
        }
      } else if (scrollContainer.scrollTop + scrollContainer.clientHeight < scrollContainer.scrollHeight - 4) {
        scrollContainer.scrollTop = Math.min(
          scrollContainer.scrollTop + scrollContainer.clientHeight,
          scrollContainer.scrollHeight
        );
      } else if (stableRounds >= 2) {
        break;
      }

      await sleep(HARVEST_WAIT_MS);
    }

    return Array.from(entries.values());
  }

  async function waitForPickerItems(rootProvider, options = {}) {
    const timeoutMs = options.timeoutMs || 5000;
    const selector = options.selector || '.emoji img, .emoji span, .emoji';

    return waitFor(() => {
      const root = rootProvider();
      if (!root) {
        return null;
      }

      const items = Array.from(root.querySelectorAll(selector));
      if (!items.length) {
        return null;
      }

      return {
        root,
        items,
      };
    }, {
      timeoutMs,
      intervalMs: 80,
    });
  }

  function isTransientEmojiPanelOpen(panel) {
    if (!panel || !panel.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(panel);
    if (style.display === 'none') {
      return false;
    }

    const rect = panel.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  async function cleanupTransientEmojiUi(options) {
    const button = options && options.button;
    const panel = options && options.panel;
    const label = (options && options.label) || 'emoji-ui';
    const shouldClose = Boolean(options && options.shouldClose);
    if (!shouldClose || !button || !panel) {
      return;
    }

    const openBeforeClose = isTransientEmojiPanelOpen(panel);
    log('emoji ui cleanup:start', {
      label,
      openBeforeClose,
      panel: describeNode(panel),
    });

    if (!openBeforeClose) {
      return;
    }

    button.click();
    await waitFor(() => !isTransientEmojiPanelOpen(panel), {
      timeoutMs: 800,
      intervalMs: 50,
    });

    log('emoji ui cleanup:done', {
      label,
      stillOpen: isTransientEmojiPanelOpen(panel),
    });
  }

  async function collectCommentRegistry(context) {
    if (!context || !context.emojiButton || !context.emojiPopover) {
      logWarn('comment registry skipped: missing context pieces', {
        hasContext: Boolean(context),
        hasEmojiButton: Boolean(context && context.emojiButton),
        hasEmojiPopover: Boolean(context && context.emojiPopover),
      });
      return [];
    }

    const wasOpen = isVisible(context.emojiPopover);
    const restorePopoverStyle = stashInlineStyle(context.emojiPopover);
    const restoreForceHidden = forceHiddenElement(context.emojiPopover);
    async function cleanupCommentPopover() {
      await cleanupTransientEmojiUi({
        button: context.emojiButton,
        panel: context.emojiPopover,
        shouldClose: !wasOpen,
        label: 'comment-popover',
      });
      restoreForceHidden();
      restorePopoverStyle();
    }

    log('collect comment registry:start', {
      wasOpen,
      anchor: describeNode(context.anchor),
      editor: describeNode(context.editor),
    });

    if (!wasOpen) {
      context.emojiButton.click();
      await sleep(HARVEST_WAIT_MS);
    }

    const pickerState = await waitFor(() => {
      const picker = context.emojiPopover.querySelector('bili-emoji-picker');
      if (!picker || !picker.shadowRoot) {
        return null;
      }

      return {
        picker,
        root: picker.shadowRoot,
      };
    }, {
      timeoutMs: 5000,
      intervalMs: 80,
    });

    if (!pickerState) {
      logWarn('collect comment registry: picker not found');
      await cleanupCommentPopover();
      return [];
    }

    const packages = await waitFor(() => {
      const result = readEmojiPackagesFromPicker(pickerState.picker);
      return result.length ? result : null;
    }, {
      timeoutMs: 5000,
      intervalMs: 80,
    });

    if (packages && packages.length) {
      const entries = buildEntriesFromCommentPackages(packages);
      await cleanupCommentPopover();

      log('collect comment registry:done via packages', {
        packages: packages.map((pkg) => stripInvisible((pkg && pkg.text) || '')),
        count: entries.length,
      });
      return entries;
    }

    const pickerRoot = pickerState.root;
    const readyState = await waitForPickerItems(() => pickerRoot);
    if (!readyState) {
      logWarn('collect comment registry: picker items not ready');
      await cleanupCommentPopover();
      return [];
    }

    const header = pickerRoot.querySelector('#header');
    const packageName = stripInvisible(
      (header && header.textContent) || '小黄脸'
    );
    const scrollContainer = pickerRoot.querySelector('#content');

    const entries = await harvestScrollableEmojiList({
      scrollContainer,
      packageName,
      itemProvider() {
        return Array.from(pickerRoot.querySelectorAll('.emoji img, .emoji span, .emoji'));
      },
    });

    await cleanupCommentPopover();

    log('collect comment registry:done', {
      packageName,
      count: entries.length,
    });
    return entries;
  }

  async function collectDynamicRegistry(context) {
    if (!context || !context.emojiButton) {
      logWarn('dynamic registry skipped: missing context pieces', {
        hasContext: Boolean(context),
        hasEmojiButton: Boolean(context && context.emojiButton),
      });
      return [];
    }

    let panel = context.emojiPanel || context.area.querySelector('.bili-emoji');
    const wasOpen = isVisible(panel);
    log('collect dynamic registry:start', {
      wasOpen,
      editor: describeNode(context.editor),
      anchor: describeNode(context.anchor),
    });

    if (!wasOpen) {
      context.emojiButton.click();
      await sleep(HARVEST_WAIT_MS);
      panel = context.area.querySelector('.bili-emoji');
    }

    if (!panel) {
      logWarn('collect dynamic registry: panel not found after open attempt');
      return [];
    }

    const restorePanelStyle = stashInlineStyle(panel);
    const restoreForceHidden = forceHiddenElement(panel);
    async function cleanupDynamicPanel() {
      await cleanupTransientEmojiUi({
        button: context.emojiButton,
        panel,
        shouldClose: !wasOpen,
        label: 'dynamic-panel',
      });
      restoreForceHidden();
      restorePanelStyle();
    }

    const packages = Array.from(panel.querySelectorAll('.bili-emoji__pkg'));
    const registryEntries = new Map();
    let order = 0;

    await waitFor(() => panel.querySelector('.bili-emoji__list__item'), {
      timeoutMs: 5000,
      intervalMs: 80,
    });

    for (const pkg of packages) {
      pkg.click();
      await waitFor(() => panel.querySelector('.bili-emoji__list__item'), {
        timeoutMs: 2000,
        intervalMs: 80,
      });
      await sleep(HARVEST_WAIT_MS);

      const packageImage = pkg.querySelector('img');
      const packageName = packageImage && packageImage.alt ? packageImage.alt : '表情';
      const list = panel.querySelector('.bili-emoji__list');
      const nextButton = panel.querySelector('.bili-emoji__pagi__next');
      const seenSignatures = new Set();

      for (let page = 0; page < 20; page += 1) {
        const pageEntries = await harvestScrollableEmojiList({
          scrollContainer: list,
          packageName,
          orderSeed: order,
          itemProvider() {
            return Array.from(panel.querySelectorAll('.bili-emoji__list__item'));
          },
        });

        order += pageEntries.length;
        for (const entry of pageEntries) {
          if (!registryEntries.has(entry.code)) {
            registryEntries.set(entry.code, entry);
          }
        }

        const signature = pageEntries.slice(0, 8).map((entry) => entry.code).join('|');
        if (!signature || seenSignatures.has(signature)) {
          break;
        }
        seenSignatures.add(signature);

        if (!nextButton) {
          break;
        }

        const beforeSignature = signature;
        nextButton.click();
        await sleep(HARVEST_WAIT_MS);

        const afterSignature = Array.from(panel.querySelectorAll('.bili-emoji__list__item img'))
          .slice(0, 8)
          .map((img) => img.alt)
          .join('|');

        if (!afterSignature || afterSignature === beforeSignature) {
          break;
        }
      }
    }

    await cleanupDynamicPanel();

    log('collect dynamic registry:done', {
      count: registryEntries.size,
      packages: packages.length,
    });
    return Array.from(registryEntries.values());
  }

  async function loadEmojiRegistry(editor, cache) {
    const context = getEditorContext(editor);
    if (!context) {
      logWarn('load emoji registry: no editor context', {
        editor: describeNode(editor),
      });
      return [];
    }

    const cacheKey = context.kind;
    const cached = cache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.loadedAt < REGISTRY_CACHE_TTL_MS && cached.entries.length > 0) {
      log('load emoji registry: cache hit', {
        kind: context.kind,
        count: cached.entries.length,
      });
      return cached.entries;
    }

    let entries = [];
    log('load emoji registry:start', {
      kind: context.kind,
      cacheHit: Boolean(cached),
      cachedCount: cached ? cached.entries.length : 0,
    });
    if (context.kind === 'comment-box') {
      entries = await collectCommentRegistry(context);
    } else if (context.kind === 'dynamic-publisher') {
      entries = await collectDynamicRegistry(context);
    }

    cache.set(cacheKey, {
      loadedAt: now,
      entries,
    });

    log('load emoji registry:done', {
      kind: context.kind,
      count: entries.length,
    });
    return entries;
  }


  function ensureGlobalStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: absolute;
        z-index: 2147483646;
        min-width: 280px;
        max-width: ${PANEL_MAX_WIDTH}px;
        color: #18191c;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(24, 25, 28, 0.08);
        border-radius: 16px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.14);
        backdrop-filter: blur(16px);
        overflow: hidden;
      }

      #${PANEL_ID}.is-hidden {
        display: none;
      }

      #${PANEL_ID} .bes-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px 8px;
      }

      #${PANEL_ID} .bes-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: #18191c;
      }

      #${PANEL_ID} .bes-subtitle {
        color: #61666d;
        font-size: 12px;
      }

      #${PANEL_ID} .bes-body {
        max-height: 320px;
        overflow: auto;
        padding: 0 10px 10px;
      }

      #${PANEL_ID} .bes-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
        gap: 0;
      }

      #${PANEL_ID} .bes-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 8px 6px;
        border: 0;
        border-radius: 12px;
        background: transparent;
        cursor: pointer;
        color: inherit;
        transition: background-color 120ms ease, transform 120ms ease;
      }

      #${PANEL_ID} .bes-item:hover,
      #${PANEL_ID} .bes-item.is-selected {
        background: rgba(0, 161, 214, 0.12);
      }

      #${PANEL_ID} .bes-item:active {
        transform: translateY(1px);
      }

      #${PANEL_ID} .bes-thumb {
        display: grid;
        place-items: center;
        width: 54px;
        height: 54px;
        border-radius: 6px;
        background: rgba(24, 25, 28, 0.05);
        overflow: hidden;
      }

      #${PANEL_ID} .bes-thumb img {
        display: block;
        width: 48px;
        height: 48px;
        object-fit: contain;
      }

      #${PANEL_ID} .bes-thumb span {
        font-size: 18px;
        line-height: 1;
      }

      #${PANEL_ID} .bes-label {
        width: 100%;
        text-align: center;
        font-size: 12px;
        line-height: 1.25;
        color: #18191c;
        word-break: break-word;
      }

      #${PANEL_ID} .bes-empty {
        padding: 24px 16px 28px;
        text-align: center;
        font-size: 13px;
        color: #61666d;
      }
    `;

    document.head.appendChild(style);
  }

  function createOverlay(onSelect) {
    ensureGlobalStyle();

    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.className = 'is-hidden';
    root.innerHTML = `
      <div class="bes-header">
        <h3 class="bes-title"></h3>
        <div class="bes-subtitle"></div>
      </div>
      <div class="bes-body">
        <div class="bes-grid"></div>
        <div class="bes-empty"></div>
      </div>
    `;

    const title = root.querySelector('.bes-title');
    const subtitle = root.querySelector('.bes-subtitle');
    const grid = root.querySelector('.bes-grid');
    const empty = root.querySelector('.bes-empty');

    document.body.appendChild(root);

    return {
      root,
      isInside(target) {
        return root.contains(target);
      },
      hide() {
        root.classList.add('is-hidden');
      },
      show(payload) {
        title.textContent = payload.title;
        subtitle.textContent = payload.subtitle || '';
        grid.textContent = '';

        if (payload.loading) {
          grid.style.display = 'none';
          empty.style.display = 'block';
          empty.textContent = '正在加载表情...';
        } else if (!payload.items.length) {
          grid.style.display = 'none';
          empty.style.display = 'block';
          empty.textContent = payload.emptyMessage;
        } else {
          grid.style.display = 'grid';
          empty.style.display = 'none';

          payload.items.forEach((entry, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `bes-item${index === payload.selectedIndex ? ' is-selected' : ''}`;
            button.dataset.code = entry.code;

            const thumb = document.createElement('div');
            thumb.className = 'bes-thumb';

            if (entry.imageUrl) {
              const image = document.createElement('img');
              image.src = entry.imageUrl;
              image.alt = entry.code;
              thumb.appendChild(image);
            } else {
              const text = document.createElement('span');
              text.textContent = entry.previewText || entry.label.slice(0, 2);
              thumb.appendChild(text);
            }

            const label = document.createElement('div');
            label.className = 'bes-label';
            label.textContent = entry.label;

            button.appendChild(thumb);
            button.appendChild(label);

            button.addEventListener('mousedown', (event) => {
              event.preventDefault();
            });

            button.addEventListener('click', (event) => {
              event.preventDefault();
              onSelect(entry);
            });

            grid.appendChild(button);
          });
        }

        const anchorRect = payload.anchorRect;
        const width = Math.min(PANEL_MAX_WIDTH, Math.max(280, Math.floor(anchorRect.width)));
        const left = clamp(
          anchorRect.left + window.scrollX + (anchorRect.width - width) / 2,
          window.scrollX + 8,
          window.scrollX + window.innerWidth - width - 8
        );
        const top = anchorRect.bottom + window.scrollY + 10;

        root.style.width = `${width}px`;
        root.style.left = `${left}px`;
        root.style.top = `${top}px`;
        root.classList.remove('is-hidden');
      },
    };
  }


  const appState = {
    activeSession: null,
    overlay: null,
    pendingSlashEditors: new WeakMap(),
    registryCache: new Map(),
    recentHistory: loadRecentHistory(),
    sessionIdSeed: 1,
  };
  const SLASH_ACTIVATION_MAX_ATTEMPTS = 12;
  const SLASH_ACTIVATION_INTERVAL_MS = 40;

  function getSessionSnapshot(session) {
    if (!session) {
      return null;
    }

    return {
      id: session.id,
      kind: session.kind,
      slashIndex: session.slashIndex,
      caretIndex: session.caretIndex,
      query: session.query,
      registryCount: session.registry.length,
      resultsCount: session.results.length,
      selectedIndex: session.selectedIndex,
      selectionVisible: Boolean(session.selectionVisible),
      refreshToken: session.refreshToken,
      editor: describeNode(session.editor),
    };
  }

  function exposeDebugApi() {
    if (!BUILD_INFO.debug) {
      return;
    }

    const root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    root.__BILI_EMOJI_SEARCH_DEBUG__ = {
      build: BUILD_INFO,
      getState() {
        return {
          build: BUILD_INFO,
          activeSession: getSessionSnapshot(appState.activeSession),
          recentHistory: appState.recentHistory.slice(),
          registryCache: Array.from(appState.registryCache.entries()).map(([key, value]) => ({
            key,
            loadedAt: value.loadedAt,
            count: value.entries.length,
          })),
          events: getDebugEvents(),
        };
      },
      getEvents() {
        return getDebugEvents();
      },
      clearEvents() {
        clearDebugEvents();
      },
    };
  }

  function clearPendingSlashActivation(editor) {
    const pending = appState.pendingSlashEditors.get(editor);
    if (!pending) {
      return;
    }

    if (pending.timerId) {
      window.clearTimeout(pending.timerId);
    }

    appState.pendingSlashEditors.delete(editor);
  }

  function maybeActivateFromSlash(editor) {
    const offsets = getSelectionOffsets(editor);
    if (!offsets || !offsets.collapsed) {
      return {
        ok: false,
        reason: 'selection-unavailable',
        offsets,
      };
    }

    const text = getEditableText(editor);
    const slashIndex = offsets.end - 1;
    if (slashIndex < 0 || text.charAt(slashIndex) !== '/') {
      return {
        ok: false,
        reason: 'slash-not-found',
        offsets,
        slashIndex,
        caretIndex: offsets.end,
        textTail: text.slice(Math.max(0, offsets.end - 12), offsets.end + 12),
      };
    }

    return {
      ok: true,
      offsets,
      slashIndex,
      caretIndex: offsets.end,
    };
  }

  function scheduleSlashActivation(editor, trigger) {
    if (!editor) {
      return;
    }

    const existing = appState.pendingSlashEditors.get(editor);
    if (existing && existing.timerId) {
      return;
    }

    const pending = existing || {
      armedAt: Date.now(),
      attempts: 0,
      timerId: null,
      trigger,
    };

    pending.trigger = trigger || pending.trigger;
    appState.pendingSlashEditors.set(editor, pending);

    pending.timerId = window.setTimeout(() => {
      pending.timerId = null;
      pending.attempts += 1;

      const activation = maybeActivateFromSlash(editor);
      if (activation.ok) {
        log('slash activation confirmed', {
          editor: describeNode(editor),
          trigger: pending.trigger,
          attempts: pending.attempts,
          slashIndex: activation.slashIndex,
          caretIndex: activation.caretIndex,
        });
        clearPendingSlashActivation(editor);
        activateSession(editor, activation.slashIndex);
        return;
      }

      const shouldRetry =
        pending.attempts < SLASH_ACTIVATION_MAX_ATTEMPTS &&
        Date.now() - pending.armedAt < SLASH_ACTIVATION_MAX_ATTEMPTS * SLASH_ACTIVATION_INTERVAL_MS * 2;

      if (shouldRetry) {
        if (pending.attempts === 1) {
          log('slash activation waiting for caret', {
            editor: describeNode(editor),
            trigger: pending.trigger,
            reason: activation.reason,
          });
        }
        scheduleSlashActivation(editor, pending.trigger);
        return;
      }

      logWarn('slash activation skipped', {
        editor: describeNode(editor),
        trigger: pending.trigger,
        attempts: pending.attempts,
        reason: activation.reason,
        offsets: activation.offsets || null,
        slashIndex: activation.slashIndex,
        caretIndex: activation.caretIndex,
        textTail: activation.textTail,
      });
      clearPendingSlashActivation(editor);
    }, existing ? SLASH_ACTIVATION_INTERVAL_MS : 0);
  }

  function getAnchorRect(editor) {
    const context = getEditorContext(editor);
    const anchor = context && context.anchor ? context.anchor : editor;
    return anchor.getBoundingClientRect();
  }

  function canMaintainSession(session) {
    if (!session || !session.editor || !session.editor.isConnected) {
      return null;
    }

    const offsets = getSelectionOffsets(session.editor);
    if (!offsets || !offsets.collapsed) {
      return null;
    }

    const text = getEditableText(session.editor);
    const caretIndex = offsets.end;

    if (caretIndex < session.slashIndex || caretIndex > session.slashIndex + SESSION_MAX_DISTANCE) {
      return null;
    }

    if (text.charAt(session.slashIndex) !== '/') {
      return null;
    }

    const query = text.slice(session.slashIndex + 1, caretIndex);
    if (query.includes('\n')) {
      return null;
    }

    return {
      text,
      caretIndex,
      query,
    };
  }

  function deactivateSession(reason) {
    const previousSession = appState.activeSession;
    if (previousSession) {
      log('deactivate session', {
        reason: reason || 'unspecified',
        session: getSessionSnapshot(previousSession),
      });
    }

    appState.activeSession = null;
    if (appState.overlay) {
      appState.overlay.hide();
    }
  }

  function renderSession(session, options = {}) {
    const state = canMaintainSession(session);
    if (!state) {
      deactivateSession('renderSession invalid state');
      return;
    }

    session.caretIndex = state.caretIndex;
    session.query = state.query;

    const title = session.query ? '搜索表情' : '最近使用';
    const subtitle = session.query
      ? `/${session.query}`
      : `${session.registryLoadedOnce ? buildAvailableRecentPrefix(session.registry, appState.recentHistory).length : appState.recentHistory.length} 条历史`;

    appState.overlay.show({
      title,
      subtitle,
      items: session.results || [],
      selectedIndex: session.selectionVisible
        ? clamp(session.selectedIndex, 0, Math.max((session.results || []).length - 1, 0))
        : -1,
      loading: Boolean(options.loading),
      emptyMessage: session.query
        ? '没有找到匹配的表情'
        : '还没有最近使用记录，继续输入关键词即可搜索',
      anchorRect: getAnchorRect(session.editor),
    });
  }

  async function refreshSession(options = {}) {
    const session = appState.activeSession;
    if (!session) {
      return;
    }

    const latestState = canMaintainSession(session);
    if (!latestState) {
      deactivateSession('refreshSession invalid state');
      return;
    }

    session.caretIndex = latestState.caretIndex;
    session.query = latestState.query;
    session.refreshToken += 1;
    const token = session.refreshToken;

    if (!session.registryLoadedOnce || options.forceRegistry) {
      if (!session.registryPromise) {
        log('refresh session: load registry', {
          forceRegistry: Boolean(options.forceRegistry),
          session: getSessionSnapshot(session),
        });
        renderSession(session, { loading: true });
        session.registryPromise = loadEmojiRegistry(session.editor, appState.registryCache)
          .catch((error) => {
            logError('refresh session: load registry failed', error);
            return [];
          })
          .then((entries) => {
            session.registry = entries;
            session.registryLoadedOnce = true;
            log('refresh session: registry ready', {
              sessionId: session.id,
              count: entries.length,
            });
            return entries;
          })
          .finally(() => {
            session.registryPromise = null;
          });
      }

      session.registry = await session.registryPromise;
      if (!appState.activeSession || appState.activeSession.id !== session.id || token !== appState.activeSession.refreshToken) {
        log('refresh session: stale registry response ignored', {
          sessionId: session.id,
        });
        return;
      }
    }

    if (!session.query) {
      session.results = buildRecentEntries(session.registry, appState.recentHistory).slice(0, SEARCH_RESULT_LIMIT);
    } else {
      session.results = searchEmojiEntries(session.registry, appState.recentHistory, session.query);
    }

    if (!session.results.length) {
      session.selectedIndex = 0;
    } else {
      session.selectedIndex = clamp(session.selectedIndex, 0, session.results.length - 1);
    }

    log('refresh session: rendered', {
      session: getSessionSnapshot(session),
      query: session.query,
      resultsCount: session.results.length,
    });
    renderSession(session);
  }

  function activateSession(editor, slashIndex) {
    const kind = getAdapterKind(editor);
    if (!kind) {
      return;
    }

    appState.activeSession = {
      id: appState.sessionIdSeed += 1,
      editor,
      kind,
      slashIndex,
      caretIndex: slashIndex + 1,
      query: '',
      registry: [],
      registryLoadedOnce: false,
      registryPromise: null,
      results: [],
      selectedIndex: 0,
      selectionVisible: false,
      refreshToken: 0,
    };

    log('activate session', {
      slashIndex,
      kind,
      editor: describeNode(editor),
    });
    refreshSession({
      forceRegistry: true,
    });
  }

  function insertEmojiCode(editor, startOffset, endOffset, code) {
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      return replaceTextInTextarea(editor, startOffset, endOffset, code);
    }

    return replaceTextInContentEditable(editor, startOffset, endOffset, code);
  }

  function selectEmoji(entry) {
    const session = appState.activeSession;
    if (!session) {
      logWarn('select emoji ignored: no active session', entry);
      return;
    }

    const latestState = canMaintainSession(session);
    if (!latestState) {
      deactivateSession('selectEmoji invalid state');
      return;
    }

    const inserted = insertEmojiCode(session.editor, session.slashIndex, latestState.caretIndex, entry.code);
    log('select emoji', {
      inserted,
      entry,
      session: getSessionSnapshot(session),
    });
    appState.recentHistory = recordRecentEmoji(appState.recentHistory, entry);
    deactivateSession('emoji selected');
  }

  function handleBeforeInput(event) {
    const editor = resolveEditorFromEvent(event);
    if (!editor) {
      return;
    }

    const inputEvent = event;
    if (inputEvent.inputType === 'insertText' && inputEvent.data === '/') {
      clearPendingSlashActivation(editor);
      appState.pendingSlashEditors.set(editor, {
        armedAt: Date.now(),
        attempts: 0,
        timerId: null,
        trigger: 'beforeinput:/',
      });
      log('beforeinput slash detected', {
        editor: describeNode(editor),
        event: inputEvent,
      });
      scheduleSlashActivation(editor, 'beforeinput:/');
      return;
    }

    if (appState.activeSession && appState.activeSession.editor === editor) {
      log('beforeinput refresh', {
        editor: describeNode(editor),
        event: inputEvent,
      });
      window.setTimeout(() => refreshSession(), 0);
    }
  }

  function handleInput(event) {
    const editor = resolveEditorFromEvent(event);
    if (!editor) {
      return;
    }

    const inputEvent = event;
    if (inputEvent.inputType === 'insertText' && inputEvent.data === '/') {
      const pending = appState.pendingSlashEditors.get(editor);
      if (pending) {
        pending.trigger = 'input:/';
      } else {
        appState.pendingSlashEditors.set(editor, {
          armedAt: Date.now(),
          attempts: 0,
          timerId: null,
          trigger: 'input:/',
        });
      }
      log('input slash detected', {
        editor: describeNode(editor),
        event: inputEvent,
      });
      scheduleSlashActivation(editor, 'input:/');
      return;
    }

    const pending = appState.pendingSlashEditors.get(editor);
    if (pending && Date.now() - pending.armedAt < 1000) {
      log('input slash fallback activated', {
        editor: describeNode(editor),
        event: inputEvent,
      });
      scheduleSlashActivation(editor, 'input-fallback');
      return;
    }

    if (appState.activeSession && appState.activeSession.editor === editor) {
      log('input refresh', {
        editor: describeNode(editor),
        event: inputEvent,
      });
      window.setTimeout(() => refreshSession(), 0);
    }
  }

  function handleSelectionChange() {
    if (!appState.activeSession) {
      return;
    }

    log('selectionchange refresh', {
      session: getSessionSnapshot(appState.activeSession),
    });
    window.setTimeout(() => refreshSession(), 0);
  }

  function handlePointerDown(event) {
    if (!appState.activeSession) {
      return;
    }

    if (appState.overlay.isInside(event.target)) {
      return;
    }

    deactivateSession('pointer outside overlay');
  }

  function handleClick(event) {
    const nativeEntry = resolveNativeEmojiEntryFromClickEvent(event);
    if (!nativeEntry) {
      return;
    }

    appState.recentHistory = recordRecentEmoji(appState.recentHistory, nativeEntry, {
      source: 'native-click',
    });
    log('native emoji click', {
      entry: nativeEntry,
    });
  }

  function handleResizeOrScroll() {
    if (!appState.activeSession) {
      return;
    }

    renderSession(appState.activeSession);
  }

  function handleKeyDown(event) {
    const editor = resolveEditorFromEvent(event);
    if (
      editor &&
      event.key === '/' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing
    ) {
      clearPendingSlashActivation(editor);
      appState.pendingSlashEditors.set(editor, {
        armedAt: Date.now(),
        attempts: 0,
        timerId: null,
        trigger: 'keydown:/',
      });
      log('keydown slash fallback armed', {
        editor: describeNode(editor),
        key: event.key,
        code: event.code,
      });
      scheduleSlashActivation(editor, 'keydown:/');
    }

    const session = appState.activeSession;
    if (!session) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      deactivateSession('escape');
      return;
    }

    if (!session.results.length) {
      if (event.key === 'Enter') {
        logWarn('enter ignored: no search results', {
          session: getSessionSnapshot(session),
        });
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      session.selectionVisible = true;
      session.selectedIndex = (session.selectedIndex + 1) % session.results.length;
      log('keydown ArrowDown', {
        session: getSessionSnapshot(session),
      });
      renderSession(session);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      session.selectionVisible = true;
      session.selectedIndex = (session.selectedIndex - 1 + session.results.length) % session.results.length;
      log('keydown ArrowUp', {
        session: getSessionSnapshot(session),
      });
      renderSession(session);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      log('keydown Enter select', {
        session: getSessionSnapshot(session),
        entry: session.results[session.selectedIndex],
      });
      selectEmoji(session.results[session.selectedIndex]);
    }
  }

  function initialize() {
    if (window.__BILI_EMOJI_SEARCH_INITIALIZED__) {
      return;
    }
    window.__BILI_EMOJI_SEARCH_INITIALIZED__ = true;

    exposeDebugApi();
    appState.overlay = createOverlay(selectEmoji);

    document.addEventListener('beforeinput', handleBeforeInput, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('selectionchange', handleSelectionChange, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('click', handleClick, true);
    window.addEventListener('resize', handleResizeOrScroll, true);
    window.addEventListener('scroll', handleResizeOrScroll, true);

    log('initialized', BUILD_INFO);
  }

  initialize();
})();


