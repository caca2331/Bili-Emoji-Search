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
