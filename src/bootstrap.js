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
