(async () => {
  let MESSAGE_TYPES;
  let toSafeFilename;
  let toSafePath;

  try {
    ({ MESSAGE_TYPES, toSafeFilename, toSafePath } = await import(chrome.runtime.getURL('lib/messaging.js')));
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
    lastScanAt: 0,
    activeJob: null
  };

  setupAuthBridge();

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
      case MESSAGE_TYPES.START_DOWNLOAD_JOB: {
        if (state.activeJob && state.activeJob.status === 'running') {
          sendResponse({
            ok: false,
            message: 'A download batch is already running. Watch the toolbar badge for progress.'
          });
          return false;
        }

        startBackgroundDownloadJob(message?.payload).catch((error) => {
          console.error('Background Plaud download failed', error);
        });

        sendResponse({ ok: true, started: true });
        return false;
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

  async function startBackgroundDownloadJob(payload = {}) {
    if (state.activeJob && state.activeJob.status === 'running') {
      throw new Error('A Plaud download batch is already running. Please wait for it to finish.');
    }

    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) {
      throw new Error('No recordings were queued for download.');
    }

    const settings = sanitizeJobSettings(payload?.settings || {});
    const preparedItems = items.map((item, index) => prepareJobItem(item, index));

    state.activeJob = {
      status: 'running',
      total: preparedItems.length,
      completed: 0
    };

    await sendJobStatusUpdate({
      stage: 'start',
      total: state.activeJob.total,
      completed: state.activeJob.completed,
      message: 'Downloading Plaud recordings…'
    });

    const downloadIds = [];

    try {
      for (let index = 0; index < preparedItems.length; index += 1) {
        const baseItem = preparedItems[index];
        const resolved = await ensureJobDownloadUrl(baseItem);

        const downloadRequest = {
          url: resolved.url,
          filename: resolved.filename,
          extension: resolved.extension,
          conflictAction: resolved.conflictAction,
          subdirectory: settings.downloadSubdir
        };

        const downloadId = await queueBackgroundDownload(downloadRequest);
        downloadIds.push(downloadId);

        if (settings.postDownloadAction !== 'none' && resolved.fileId) {
          await applyPostDownloadAction({
            action: settings.postDownloadAction,
            fileId: resolved.fileId,
            tagId: settings.moveTargetTag
          });
        }

        state.activeJob.completed += 1;

        await sendJobStatusUpdate({
          stage: 'progress',
          total: state.activeJob.total,
          completed: state.activeJob.completed,
          message: `Downloaded ${state.activeJob.completed}/${state.activeJob.total} recording(s)…`
        });
      }

      await sendJobStatusUpdate({
        stage: 'done',
        total: state.activeJob.total,
        completed: state.activeJob.total,
        message: 'All Plaud recordings downloaded.'
      });

      return { downloadIds };
    } catch (error) {
      await sendJobStatusUpdate({
        stage: 'error',
        total: state.activeJob.total,
        completed: state.activeJob.completed,
        message: error?.message || 'Plaud download failed.'
      });

      throw error;
    } finally {
      state.activeJob = null;
    }
  }

  function sanitizeJobSettings(settings = {}) {
    const downloadSubdir = toSafePath(settings.downloadSubdir || '');
    const rawAction = typeof settings.postDownloadAction === 'string' ? settings.postDownloadAction.toLowerCase() : 'none';
    const allowedActions = new Set(['none', 'move', 'trash']);
    const postDownloadAction = allowedActions.has(rawAction) ? rawAction : 'none';
    const moveTargetTag = typeof settings.moveTargetTag === 'string' ? settings.moveTargetTag.trim() : '';

    if (postDownloadAction === 'move' && !moveTargetTag) {
      throw new Error('Set a destination folder ID before moving recordings.');
    }

    return {
      downloadSubdir,
      postDownloadAction,
      moveTargetTag
    };
  }

  function prepareJobItem(rawItem, index) {
    const fallbackName = `audio_${index + 1}`;
    const fileId = typeof rawItem?.fileId === 'string' ? rawItem.fileId.trim() : '';
    const filenameSource = typeof rawItem?.filename === 'string' && rawItem.filename.trim()
      ? rawItem.filename
      : fallbackName;
    const filename = toSafeFilename(filenameSource, fallbackName);
    const url = typeof rawItem?.url === 'string' && rawItem.url.startsWith('http') ? rawItem.url : null;
    const extension = normalizeExtensionCandidate(rawItem?.extension) || 'mp3';
    const conflictAction = rawItem?.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify';

    return {
      index,
      fileId: fileId || null,
      filename,
      url,
      extension,
      conflictAction
    };
  }

  function normalizeExtensionCandidate(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.replace(/^\./, '').toLowerCase();
  }

  async function ensureJobDownloadUrl(item) {
    if (item.url && item.url.startsWith('http')) {
      updateStateItemUrl(item.fileId, item.url);
      return item;
    }

    if (!item.fileId) {
      throw new Error('Missing file identifier. Open the recording and try again.');
    }

    const url = await resolveDownloadUrl(item.fileId);
    const updated = {
      ...item,
      url
    };

    updateStateItemUrl(item.fileId, url);

    return updated;
  }

  function updateStateItemUrl(fileId, url) {
    if (!fileId || !url) {
      return;
    }

    const index = state.audioItems.findIndex((candidate) => candidate.fileId === fileId);
    if (index === -1) {
      return;
    }

    state.audioItems[index] = {
      ...state.audioItems[index],
      url
    };
  }

  async function queueBackgroundDownload(item) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.DOWNLOAD_SINGLE,
        payload: item
      });

      if (!response?.ok || !Array.isArray(response.downloadIds) || !response.downloadIds.length) {
        throw new Error(response?.message || 'Chrome download request failed.');
      }

      return response.downloadIds[0];
    } catch (error) {
      if (error instanceof Error && error.message) {
        throw error;
      }

      throw new Error('Chrome download request failed.');
    }
  }

  async function sendJobStatusUpdate(update) {
    if (!update || typeof update !== 'object') {
      return;
    }

    try {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.JOB_STATUS_UPDATE,
        payload: update
      });
    } catch (error) {
      console.debug('Failed to notify background badge update', error);
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
    ingestCurrentPlaudRows(target);

    if (!exhaustive) {
      return;
    }

    const scroller = await waitForPlaudScroller();
    if (!scroller) {
      return;
    }

    extractPlaudItemsFromVue(scroller, target);
    await traversePlaudScroller(scroller, target);
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
      } else {
        const existing = target.get(candidate.fileId);
        target.set(candidate.fileId, {
          ...existing,
          filename: candidate.filename || existing.filename,
          context: candidate.context || existing.context,
          extension: candidate.extension || existing.extension,
          url: existing.url || candidate.url || null
        });
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

  async function waitForPlaudScroller({ timeoutMs = 5000, pollMs = 100 } = {}) {
    const start = Date.now();
    let scroller = findPlaudScroller();

    while (!scroller && Date.now() - start < timeoutMs) {
      await wait(pollMs);
      scroller = findPlaudScroller();
    }

    return scroller;
  }

  function extractPlaudItemsFromVue(scroller, target) {
    const instance = scroller?.__vueParentComponent;
    if (!instance) {
      return;
    }

    const candidateArrays = [
      instance.props?.items,
      instance.props?.data,
      instance.ctx?.items,
      instance.ctx?.computedItems,
      instance.proxy?.items
    ];

    const source = candidateArrays.find((value) => Array.isArray(value));
    if (!Array.isArray(source) || !source.length) {
      return;
    }

    source.forEach((item, index) => {
      const fileId = resolveFileId(item);
      if (!fileId || target.has(fileId)) {
        return;
      }

      const filename = resolveTitle(item, index);
      const context = resolveContext(item);
      const extension = resolveExtension(item) || 'mp3';

      target.set(fileId, {
        fileId,
        filename,
        context,
        extension,
        url: null
      });
    });
  }

  function resolveFileId(item) {
    if (!item || typeof item !== 'object') {
      return null;
    }

    return (
      normalizeId(item.fileId) ||
      normalizeId(item.file_id) ||
      normalizeId(item.fileID) ||
      normalizeId(item.id) ||
      normalizeId(item.uid) ||
      normalizeId(item.uuid) ||
      normalizeId(item?.record_id) ||
      normalizeId(item?.file?.id) ||
      null
    );
  }

  function normalizeId(value) {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      return value.trim() || null;
    }

    if (typeof value === 'number') {
      return String(value);
    }

    return null;
  }

  function resolveTitle(item, index = 0) {
    if (!item || typeof item !== 'object') {
      return `Recording ${index + 1}`;
    }

    const titleCandidate =
      item.title ||
      item.name ||
      item.noteName ||
      item.fileName ||
      item.displayName ||
      item.created_at ||
      item.updated_at ||
      item?.meta?.title ||
      '';

    if (typeof titleCandidate === 'string' && titleCandidate.trim()) {
      const cleaned = sanitizeText(titleCandidate);
      if (cleaned) {
        return cleaned;
      }
    }

    return `Recording ${index + 1}`;
  }

  function resolveContext(item) {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const pieces = [];

    const createdAt = item.created_at || item.create_time || item.createdAt;
    if (typeof createdAt === 'string' && createdAt.trim()) {
      const cleaned = sanitizeText(createdAt);
      if (cleaned) {
        pieces.push(cleaned);
      }
    }

    const duration = item.duration || item.length || item.audioLength;
    if (typeof duration === 'string' && duration.trim()) {
      const cleaned = sanitizeText(duration);
      if (cleaned) {
        pieces.push(cleaned);
      }
    } else if (typeof duration === 'number' && duration > 0) {
      pieces.push(`${Math.round(duration)}s`);
    }

    const tagLabel = item.tag_name || item.tag || item.folderName || item.category;
    if (typeof tagLabel === 'string' && tagLabel.trim()) {
      const cleaned = sanitizeText(tagLabel);
      if (cleaned) {
        pieces.push(cleaned);
      }
    }

    return pieces.length ? pieces.join(' | ') : null;
  }

  function resolveExtension(item) {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const extension = item.extension || item.file_ext || item.ext || item.suffix;
    if (typeof extension === 'string' && extension.trim()) {
      return extension.replace(/^\./, '').trim().toLowerCase();
    }

    return null;
  }

  async function traversePlaudScroller(scroller, target) {
    if (!scroller) {
      ingestCurrentPlaudRows(target);
      return;
    }

    const originalScrollTop = scroller.scrollTop;
    const idleLimit = 6;
    const settleLimit = 4;
    const maxPasses = 400;
    let idlePasses = 0;
    let settlePasses = 0;
    let lastKnownSize = -1;

    scroller.scrollTo({ top: 0, behavior: 'auto' });
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await wait(200);
    ingestCurrentPlaudRows(target);

    for (let pass = 0; pass < maxPasses; pass += 1) {
      const scrollableDistance = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
      const step = Math.max(Math.floor(scroller.clientHeight * 0.9), 200);
      const nextTop = Math.min((pass + 1) * step, scrollableDistance);

      scroller.scrollTo({ top: nextTop, behavior: 'auto' });
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await wait(250);

      ingestCurrentPlaudRows(target);

      if (target.size > lastKnownSize) {
        lastKnownSize = target.size;
        idlePasses = 0;
      } else if (nextTop >= scrollableDistance) {
        idlePasses += 1;
        if (idlePasses >= idleLimit) {
          break;
        }
      }
    }

    // Final sweep at the bottom in case late loads appear.
    for (let attempt = 0; attempt < idleLimit; attempt += 1) {
      const bottom = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
      scroller.scrollTo({ top: bottom, behavior: 'auto' });
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await wait(250);
      ingestCurrentPlaudRows(target);

      if (target.size === lastKnownSize) {
        settlePasses += 1;
        if (settlePasses >= settleLimit) {
          break;
        }
      } else {
        lastKnownSize = target.size;
        settlePasses = 0;
      }
    }

    scroller.scrollTo({ top: originalScrollTop, behavior: 'auto' });
  }

  function wait(durationMs = 200) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }
})();
