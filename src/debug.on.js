  const BUILD_INFO = Object.freeze({
    version: '1.0.0',
    variant: 'debug',
    debug: true,
  });

  const DEBUG_EVENT_LIMIT = 400;
  const DEBUG_EVENTS = [];

  function describeNode(node) {
    if (!node || typeof node !== 'object') {
      return null;
    }

    if (node === window) {
      return {
        nodeName: 'WINDOW',
      };
    }

    if (node === document) {
      return {
        nodeName: 'DOCUMENT',
      };
    }

    if (typeof Node !== 'undefined' && node.nodeType === Node.TEXT_NODE) {
      return {
        nodeName: '#text',
        text: String(node.nodeValue || '').replace(/\s+/g, ' ').trim().slice(0, 60),
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

    if (node.isContentEditable) {
      output.isContentEditable = true;
    }

    return output;
  }

  function summarizeDebugValue(value, depth = 0) {
    if (value === null || value === undefined) {
      return value;
    }

    if (depth > 2) {
      return '[MaxDepth]';
    }

    const valueType = typeof value;
    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
      return value;
    }

    if (valueType === 'function') {
      return `[Function ${value.name || 'anonymous'}]`;
    }

    if (typeof Event !== 'undefined' && value instanceof Event) {
      return {
        type: value.type,
        key: value.key || '',
        code: value.code || '',
        inputType: value.inputType || '',
        data: value.data || '',
        target: describeNode(value.target),
      };
    }

    if (typeof Error !== 'undefined' && value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: String(value.stack || '').split('\n').slice(0, 3),
      };
    }

    if (typeof Node !== 'undefined' && value instanceof Node) {
      return describeNode(value);
    }

    if (Array.isArray(value)) {
      return value.slice(0, 12).map((item) => summarizeDebugValue(item, depth + 1));
    }

    const output = {};
    const keys = Object.keys(value).slice(0, 16);
    for (const key of keys) {
      try {
        output[key] = summarizeDebugValue(value[key], depth + 1);
      } catch (error) {
        output[key] = '[Unserializable]';
      }
    }
    return output;
  }

  function recordDebugEvent(level, args) {
    DEBUG_EVENTS.push({
      at: new Date().toISOString(),
      level,
      args: args.map((item) => summarizeDebugValue(item)),
    });

    if (DEBUG_EVENTS.length > DEBUG_EVENT_LIMIT) {
      DEBUG_EVENTS.splice(0, DEBUG_EVENTS.length - DEBUG_EVENT_LIMIT);
    }
  }

  function log(...args) {
    console.debug('[bili-emoji-search]', ...args);
    recordDebugEvent('debug', args);
  }

  function logWarn(...args) {
    console.warn('[bili-emoji-search]', ...args);
    recordDebugEvent('warn', args);
  }

  function logError(...args) {
    console.error('[bili-emoji-search]', ...args);
    recordDebugEvent('error', args);
  }

  function getDebugEvents() {
    return DEBUG_EVENTS.slice();
  }

  function clearDebugEvents() {
    DEBUG_EVENTS.length = 0;
  }
