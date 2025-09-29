(async () => {
  let MESSAGE_TYPES;

  try {
    ({ MESSAGE_TYPES } = await import(chrome.runtime.getURL('lib/messaging.js')));
  } catch (error) {
    console.error('Failed to load messaging helpers', error);
    return;
  }

  const AUTH_MESSAGE_SOURCE = 'atlas-plaud-auth';

  const authBridge = {
    cachedToken: null,
    pending: [],
    injecting: false,
    timeoutId: null
  };

  const state = {
    audioItems: [],
    lastScanAt: 0
  };

  setupAuthBridge();

  const observer = new MutationObserver(debounce(handleMutations, 1000));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return undefined;
    }

    switch (message.type) {
      case MESSAGE_TYPES.REQUEST_AUDIO_SCAN: {
        const items = scanForAudio();
        sendResponse({
          ok: true,
          items,
          lastScanAt: state.lastScanAt
        });
        return undefined;
      }
      case MESSAGE_TYPES.RESOLVE_AUDIO_URL: {
        const fileId = message?.payload?.fileId;

        resolveDownloadUrl(fileId)
          .then((url) => sendResponse({ ok: true, url }))
          .catch((error) => sendResponse({ ok: false, message: error.message }));

        return true; // async response
      }
      default:
        return undefined;
    }
  });

  // Perform an initial scan once the page is ready enough.
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', scanForAudio, { once: true });
  } else {
    scanForAudio();
  }

  function setupAuthBridge() {
    window.addEventListener('message', handleAuthMessage, false);
    requestAuthToken().catch(() => {
      /* Swallow errors during pre-flight */
    });
  }

  function handleAuthMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== AUTH_MESSAGE_SOURCE) {
      return;
    }

    if (authBridge.timeoutId) {
      clearTimeout(authBridge.timeoutId);
      authBridge.timeoutId = null;
    }

    authBridge.injecting = false;

    const token = typeof data.token === 'string' ? data.token.trim() : '';

    if (token) {
      authBridge.cachedToken = token;
      flushAuthResolvers(token);
    } else {
      flushAuthResolvers(null);
    }
  }

  function requestAuthToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && authBridge.cachedToken) {
      return Promise.resolve(authBridge.cachedToken);
    }

    return new Promise((resolve) => {
      authBridge.pending.push(resolve);

      if (!authBridge.injecting) {
        authBridge.injecting = true;
        injectAuthProbe();

        authBridge.timeoutId = setTimeout(() => {
          authBridge.injecting = false;
          flushAuthResolvers(null);
        }, 2000);
      }
    });
  }

  function flushAuthResolvers(value) {
    const pending = authBridge.pending.splice(0, authBridge.pending.length);
    pending.forEach((resolver) => {
      try {
        resolver(value);
      } catch (error) {
        console.error('Auth resolver failed', error);
      }
    });
  }

  function clearCachedToken() {
    authBridge.cachedToken = null;
  }

  function injectAuthProbe() {
    try {
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = chrome.runtime.getURL('lib/auth-probe.js');
      script.dataset.messageSource = AUTH_MESSAGE_SOURCE;

      const handleCleanup = () => {
        script.removeEventListener('load', handleLoad);
        script.removeEventListener('error', handleError);
        if (script.parentNode) {
          script.parentNode.removeChild(script);
        }
      };

      const handleLoad = () => {
        handleCleanup();
      };

      const handleError = () => {
        handleCleanup();
        flushAuthResolvers(null);
      };

      script.addEventListener('load', handleLoad, { once: true });
      script.addEventListener('error', handleError, { once: true });

      document.documentElement.appendChild(script);
    } catch (error) {
      console.error('Failed to inject Plaud auth probe', error);
      flushAuthResolvers(null);
    }
  }

  async function resolveDownloadUrl(fileId) {
    if (!fileId) {
      throw new Error('Missing recording identifier on this item.');
    }

    return requestPlaudTempUrl(fileId);
  }

  async function requestPlaudTempUrl(fileId, attempt = 0) {
    const token = await requestAuthToken({ forceRefresh: attempt > 0 });

    if (!token) {
      throw new Error('Sign in to Plaud before requesting downloads. Token not found.');
    }

    let response;

    try {
      response = await fetch(`https://api.plaud.ai/file/temp-url/${encodeURIComponent(fileId)}`, {
        method: 'GET',
        headers: buildApiHeaders(token),
        credentials: 'include',
        cache: 'no-store'
      });
    } catch (error) {
      throw new Error('Network error while requesting download link from Plaud.');
    }

    if (response.status === 401 && attempt === 0) {
      clearCachedToken();
      return requestPlaudTempUrl(fileId, attempt + 1);
    }

    if (!response.ok) {
      const fallback = await safeJson(response).catch(() => null);
      const message = fallback?.message || `Plaud API rejected the download request (${response.status}).`;
      throw new Error(message);
    }

    const payload = await safeJson(response);
    const downloadUrl = extractDownloadUrl(payload);

    if (!downloadUrl) {
      console.warn('Plaud temp-url response did not include a direct link', payload);
      throw new Error('Plaud API did not return a usable download URL.');
    }

    return downloadUrl;
  }

  function buildApiHeaders(token) {
    return {
      accept: 'application/json, text/plain, */*',
      'app-platform': 'web',
      authorization: `Bearer ${token.replace(/^Bearer\s+/i, '')}`,
      'edit-from': 'web',
      origin: window.location.origin,
      referer: window.location.href
    };
  }

  function extractDownloadUrl(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const directCandidates = [
      payload.temp_url,
      payload.tempUrl,
      payload.temp_url_opus,
      payload.url,
      payload.downloadUrl
    ];

    for (const candidate of directCandidates) {
      if (typeof candidate === 'string' && candidate.startsWith('http')) {
        return candidate;
      }
    }

    if (payload.data) {
      const data = payload.data;
      const nestedCandidates = Array.isArray(data)
        ? data
        : [data?.temp_url, data?.tempUrl, data?.url, data?.downloadUrl].filter(Boolean);

      for (const candidate of nestedCandidates) {
        if (typeof candidate === 'string' && candidate.startsWith('http')) {
          return candidate;
        }

        if (candidate && typeof candidate === 'object') {
          const nested = extractDownloadUrl(candidate);
          if (nested) {
            return nested;
          }
        }
      }
    }

    return null;
  }

  async function safeJson(response) {
    try {
      return await response.clone().json();
    } catch (error) {
      return null;
    }
  }

  function handleMutations() {
    const updated = scanForAudio();
    if (updated.length) {
      console.debug('Audio map updated', updated);
    }
  }

  function scanForAudio() {
    const discovered = new Map();
    const titleFallback = document.title || 'audio';

    const candidates = [
      ...document.querySelectorAll('audio[src], audio source[src]'),
      ...document.querySelectorAll('a[href$=".mp3"], a[href$=".m4a"], a[href$=".wav"], a[href$=".aac"], a[href*=".mp3?"], a[href*=".m4a?"], a[href*=".wav?"], a[href*=".aac?"]'),
      ...document.querySelectorAll('[data-fileid], [data-file-id], [data-filekey], [data-key], .time_date')
    ];

    for (const node of candidates) {
      const descriptor = describeNode(node, titleFallback);
      if (!descriptor) {
        continue;
      }

      const key = descriptor.fileId || descriptor.url || `${descriptor.filename}-${descriptor.extension || ''}-${discovered.size}`;
      discovered.set(key, descriptor);
    }

    state.audioItems = Array.from(discovered.values());
    state.lastScanAt = Date.now();

    return state.audioItems;
  }

  function describeNode(node, titleFallback) {
    if (!node) {
      return null;
    }

    const url = extractUrl(node);
    const fileId = extractFileIdentifier(node, url);

    if (!url && !fileId) {
      return null;
    }

    const label = node.getAttribute?.('data-title') || node.getAttribute?.('title') || node.textContent;
    const title = sanitizeText(label) || titleFallback;

    return {
      url,
      fileId,
      filename: title,
      extension: inferExtension(url),
      context: buildContext(node)
    };
  }

  function extractUrl(element) {
    if (!element) {
      return null;
    }

    if (element.tagName === 'A') {
      return element.href;
    }

    if (element.tagName === 'AUDIO') {
      return element.currentSrc || element.src;
    }

    if (element.tagName === 'SOURCE') {
      return element.src;
    }

    const dataSrc = element.getAttribute?.('data-src') || element.getAttribute?.('data-href');
    if (dataSrc && dataSrc.startsWith('http')) {
      return dataSrc;
    }

    return null;
  }

  function extractFileIdentifier(node, url) {
    const attributeNames = ['data-fileid', 'data-file-id', 'data-filekey', 'data-file-key', 'data-key', 'data-id', 'data-resource-id'];
    const datasetProps = ['fileId', 'fileid', 'fileKey', 'filekey', 'id', 'resourceId', 'resourceid', 'key'];

    let current = node;

    while (current && current !== document) {
      if (current.dataset) {
        for (const prop of datasetProps) {
          const value = current.dataset[prop];
          if (value) {
            return value;
          }
        }
      }

      for (const attr of attributeNames) {
        if (typeof current.getAttribute === 'function') {
          const attrValue = current.getAttribute(attr);
          if (attrValue) {
            return attrValue;
          }
        }
      }

      current = current.parentElement;
    }

    if (typeof url === 'string') {
      const match = url.match(/([a-f0-9]{24,})/i);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  function sanitizeText(value) {
    if (typeof value !== 'string') {
      return '';
    }

    return value.replace(/\s+/g, ' ').trim();
  }

  function inferExtension(url) {
    if (!url) {
      return null;
    }

    try {
      const parsed = new URL(url, window.location.href);
      const match = parsed.pathname.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
      return match ? match[1].toLowerCase() : null;
    } catch (error) {
      console.warn('Unable to parse url for extension inference', error);
      return null;
    }
  }

  function buildContext(node) {
    try {
      const section = node.closest?.('[data-audio-context], section, article, li');
      if (!section) {
        return null;
      }

      const heading = section.querySelector?.('h1, h2, h3, h4, [data-name], .title');
      return heading ? sanitizeText(heading.textContent) : null;
    } catch (error) {
      return null;
    }
  }

  function debounce(fn, wait = 250) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), wait);
    };
  }
})();
