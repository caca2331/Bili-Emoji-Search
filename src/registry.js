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
