(async () => {
  let MESSAGE_TYPES;

  try {
    ({ MESSAGE_TYPES } = await import(chrome.runtime.getURL('lib/messaging.js')));
  } catch (error) {
    console.error('Failed to load messaging helpers', error);
    return;
  }

  const AUTH_MESSAGE_SOURCE = 'plaud-recording-downloader-auth';

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
        handleAudioScanRequest()
          .then((items) => {
            sendResponse({ ok: true, items, lastScanAt: state.lastScanAt });
          })
          .catch((error) => {
            sendResponse({ ok: false, message: error.message });
          });

        return true;
      }
      case MESSAGE_TYPES.RESOLVE_AUDIO_URL: {
        const fileId = message?.payload?.fileId;

        resolveDownloadUrl(fileId)
          .then((url) => sendResponse({ ok: true, url }))
          .catch((error) => sendResponse({ ok: false, message: error.message }));

        return true; // async response
      }
      case MESSAGE_TYPES.POST_DOWNLOAD_ACTION: {
        applyPostDownloadAction(message?.payload)
          .then(() => sendResponse({ ok: true }))
          .catch((error) => sendResponse({ ok: false, message: error.message }));

        return true;
      }
      default:
        return undefined;
    }
  });

  // Perform an initial scan once the page is ready enough.
  if (document.readyState === 'loading') {
    window.addEventListener(
      'DOMContentLoaded',
      () => {
        scanForAudio({ exhaustive: false }).catch(() => {
          /* ignore */
        });
      },
      { once: true }
    );
  } else {
    scanForAudio({ exhaustive: false }).catch(() => {
      /* ignore */
    });
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

  async function applyPostDownloadAction(payload) {
    const action = (payload?.action || 'none').toLowerCase();
    const fileId = payload?.fileId;
    const tagId = payload?.tagId;

    if (!fileId) {
      throw new Error('Missing recording identifier for post-download action.');
    }

    if (action === 'none') {
      return;
    }

    if (action === 'move') {
      if (!tagId) {
        throw new Error('Choose a target folder before moving recordings.');
      }

      await movePlaudFile(fileId, tagId);
      return;
    }

    if (action === 'trash' || action === 'delete') {
      await trashPlaudFile(fileId);
      return;
    }

    throw new Error(`Unsupported post-download action: ${action}`);
  }

  async function movePlaudFile(fileId, tagId) {
    const token = await requestAuthToken().catch(() => null);

    if (!token) {
      throw new Error('Sign in to Plaud before moving recordings.');
    }

    let response;

    try {
      response = await fetch('https://api.plaud.ai/file/update-tags', {
        method: 'POST',
        headers: {
          ...buildApiHeaders(token),
          'content-type': 'application/json;charset=UTF-8'
        },
        credentials: 'include',
        cache: 'no-store',
        body: JSON.stringify({
          file_id_list: [fileId],
          filetag_id: tagId,
          r: Math.random()
        })
      });
    } catch (error) {
      throw new Error('Network error while moving recording on Plaud.');
    }

    if (!response.ok) {
      const payload = await safeJson(response);
      const message = payload?.message || `Plaud API rejected the move request (${response.status}).`;
      throw new Error(message);
    }
  }

  async function trashPlaudFile(fileId) {
    const token = await requestAuthToken().catch(() => null);

    if (!token) {
      throw new Error('Sign in to Plaud before sending recordings to trash.');
    }

    let response;

    try {
      response = await fetch('https://api.plaud.ai/file/trash/', {
        method: 'POST',
        headers: {
          ...buildApiHeaders(token),
          'content-type': 'application/json;charset=UTF-8'
        },
        credentials: 'include',
        cache: 'no-store',
        body: JSON.stringify([fileId])
      });
    } catch (error) {
      throw new Error('Network error while moving recording to trash.');
    }

    if (!response.ok) {
      const payload = await safeJson(response);
      const message = payload?.message || `Plaud API rejected the delete request (${response.status}).`;
      throw new Error(message);
    }
  }

  async function handleMutations() {
    try {
      const updated = await scanForAudio({ exhaustive: false });
      if (updated.length) {
        console.debug('Audio map updated', updated);
      }
    } catch (error) {
      console.debug('Mutation-driven scan failed', error);
    }
  }

  async function handleAudioScanRequest() {
    const items = await scanForAudio({ exhaustive: true });
    return items;
  }

  async function scanForAudio({ exhaustive = false } = {}) {
    const discovered = new Map();
    await collectPlaudListEntries(discovered, { exhaustive });

    state.audioItems = Array.from(discovered.values());
    state.lastScanAt = Date.now();

    return state.audioItems;
  }

  async function collectPlaudListEntries(target, { exhaustive = false } = {}) {
    const scroller = findPlaudScroller();

    if (!exhaustive || !scroller) {
      ingestCurrentPlaudRows(target);
      return;
    }

    const originalScrollTop = scroller.scrollTop;
    const maxIterations = 20;
    let lastSize = -1;
    let stableIterations = 0;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      ingestCurrentPlaudRows(target);

      if (target.size === lastSize) {
        stableIterations += 1;
        if (stableIterations >= 2) {
          break;
        }
      } else {
        stableIterations = 0;
        lastSize = target.size;
      }

      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
      await wait(200);
    }

    ingestCurrentPlaudRows(target);
    scroller.scrollTo({ top: originalScrollTop, behavior: 'auto' });
  }

  function ingestCurrentPlaudRows(target) {
    const rows = document.querySelectorAll('li[data-file-id]');

    for (const row of rows) {
      const candidate = describePlaudRow(row, target.size);
      if (!candidate) {
        continue;
      }

      if (!target.has(candidate.fileId)) {
        target.set(candidate.fileId, candidate);
      }
    }
  }

  function describePlaudRow(row, position = 0) {
    if (!row) {
      return null;
    }

    const fileId = row.dataset?.fileId || row.getAttribute('data-file-id');
    if (!fileId) {
      return null;
    }

    const title = sanitizeText(row.querySelector('.title')?.textContent);
    const timeInfo = sanitizeText(row.querySelector('.time_date')?.textContent);
    const tag = sanitizeText(row.querySelector('.comesTag')?.textContent);

    const contextParts = [];
    if (timeInfo) {
      contextParts.push(timeInfo);
    }
    if (tag) {
      contextParts.push(tag);
    }

    return {
      fileId,
      filename: title || `Recording ${position + 1}`,
      url: null,
      extension: 'mp3',
      context: contextParts.length ? contextParts.join(' | ') : null
    };
  }

  function sanitizeText(value) {
    if (typeof value !== 'string') {
      return '';
    }

    return value.replace(/\s+/g, ' ').trim();
  }

  function findPlaudScroller() {
    return document.querySelector('.vue-recycle-scroller.fileList');
  }

  function wait(durationMs = 200) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  function debounce(fn, wait = 250) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), wait);
    };
  }
})();
