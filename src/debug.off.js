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
