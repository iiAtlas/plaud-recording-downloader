import {
  DOWNLOAD_CHECKPOINT_STORAGE_KEY,
  MESSAGE_TYPES,
  normalizeBatchSize,
  toSafeFilename,
  toSafePath
} from '../lib/messaging.js';
import { writeId3Tag } from '../lib/id3.js';

const CHECKPOINT_VERSION = 1;

const runtimeState = {
  activeJob: null,
  downloadWaiters: new Map()
};

chrome.runtime.onInstalled.addListener(() => {
  const extensionName = chrome.i18n?.getMessage('appName') || 'Plaud Recording Downloader';
  console.info(`${extensionName} installed.`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return undefined;
  }

  switch (message.type) {
    case MESSAGE_TYPES.START_DOWNLOAD_JOB: {
      startDownloadJob(message?.payload, { resume: false })
        .then(() => sendResponse({ ok: true, started: true }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));

      return true;
    }
    case MESSAGE_TYPES.RESUME_DOWNLOAD_JOB: {
      startDownloadJob(message?.payload, { resume: true })
        .then(() => sendResponse({ ok: true, started: true }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));

      return true;
    }
    case MESSAGE_TYPES.STOP_DOWNLOAD_JOB: {
      stopActiveDownloadJob()
        .then(() => sendResponse({ ok: true, stopped: true }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));

      return true;
    }
    case MESSAGE_TYPES.CANCEL_DOWNLOAD_JOB: {
      cancelBulkDownloadJob()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));

      return true;
    }
    case MESSAGE_TYPES.GET_DOWNLOAD_CHECKPOINT: {
      getCheckpointForUi()
        .then((checkpoint) => sendResponse({ ok: true, checkpoint }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));

      return true;
    }
    case MESSAGE_TYPES.DOWNLOAD_AUDIO_BATCH: {
      const items = Array.isArray(message.payload) ? message.payload : [];

      queueDownloads(items)
        .then((downloadIds) => sendResponse({ ok: true, downloadIds }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));

      return true; // asynchronous response
    }
    case MESSAGE_TYPES.DOWNLOAD_SINGLE: {
      const item = message.payload;

      queueDownloads(item ? [item] : [])
        .then((downloadIds) => sendResponse({ ok: true, downloadIds }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));

      return true;
    }
    case MESSAGE_TYPES.CANCEL_DOWNLOADS: {
      const downloadIds = Array.isArray(message?.payload?.downloadIds)
        ? message.payload.downloadIds
        : [];

      cancelDownloadIds(downloadIds)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));

      return true;
    }
    case MESSAGE_TYPES.JOB_STATUS_UPDATE: {
      try {
        publishJobStatus(message.payload);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, message: error.message });
      }

      return false;
    }
    default:
      return undefined;
  }
});

const downloadObjectUrls = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || typeof delta.id !== 'number') {
    return;
  }

  if (!delta.state || typeof delta.state.current !== 'string') {
    return;
  }

  const { id } = delta;
  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') {
    return;
  }

  const objectUrl = downloadObjectUrls.get(id);
  if (objectUrl) {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      console.debug('Failed to revoke object URL for download', error);
    }
    downloadObjectUrls.delete(id);
  }

  resolveDownloadWaiters(id, state);
});

async function queueDownloads(items) {
  if (!items.length) {
    throw new Error('Nothing to download.');
  }

  const results = [];

  for (const item of items) {
    const downloadId = await triggerDownload(item);
    results.push(downloadId);
  }

  return results;
}

async function triggerDownload(item) {
  const {
    url,
    filename,
    extension,
    conflictAction = 'uniquify',
    subdirectory,
    includeMetadata,
    metadata
  } = item || {};

  if (typeof url !== 'string' || (!url.startsWith('http') && !url.startsWith('https'))) {
    throw new Error('Invalid download URL.');
  }

  const safeFilename = toSafeFilename(filename, 'audio');
  const resolvedExtension = normalizeExtension(extension) || inferExtension(url) || 'mp3';
  const safeSubdir = toSafePath(subdirectory || '');
  const downloadFilename = safeSubdir
    ? `${safeSubdir}/${safeFilename}.${resolvedExtension}`
    : `${safeFilename}.${resolvedExtension}`;

  let downloadSource = url;
  let objectUrl = null;

  if (includeMetadata && metadata && shouldEmbedMetadata(resolvedExtension)) {
    try {
      const processed = await buildTaggedObjectUrl(url, resolvedExtension, metadata);
      if (processed?.url) {
        downloadSource = processed.url;
        objectUrl = processed.objectUrl || null;
      }
    } catch (error) {
      console.warn('Failed to embed Plaud metadata into recording', error);
    }
  }

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: downloadSource,
        filename: downloadFilename,
        conflictAction
      },
      (downloadId) => {
        if (objectUrl && (downloadId === undefined || downloadId === null)) {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch (cleanupError) {
            console.debug('Failed to revoke object URL after download failure', cleanupError);
          }
        }

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (objectUrl && typeof downloadId === 'number') {
          downloadObjectUrls.set(downloadId, objectUrl);
        }

        resolve(downloadId);
      }
    );
  });
}

async function startDownloadJob(payload = {}, { resume = false } = {}) {
  if (runtimeState.activeJob && runtimeState.activeJob.status === 'running') {
    throw new Error('A Plaud download batch is already running. Watch the toolbar badge for progress.');
  }

  if (runtimeState.activeJob && runtimeState.activeJob.status === 'cancelling') {
    throw new Error('A Plaud download batch is stopping. Please wait and retry.');
  }

  const tabId = toValidTabId(payload?.tabId);
  if (tabId === null) {
    throw new Error('Open the Plaud dashboard tab and try again.');
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    throw new Error('No recordings were queued for download.');
  }

  const settings = sanitizeJobSettings(payload?.settings || {});
  const preparedItems = items.map((item, index) => prepareJobItem(item, index));
  const checkpoint = await getStoredCheckpoint();
  const completedKeys = new Set();

  let jobId = generateJobId();

  if (resume) {
    if (!checkpoint) {
      throw new Error('No paused download batch was found. Start a new download.');
    }

    if (payload?.checkpointId && checkpoint.id && payload.checkpointId !== checkpoint.id) {
      throw new Error('Saved batch does not match. Run a fresh scan and retry.');
    }

    jobId = checkpoint.id || jobId;
    (checkpoint.completedKeys || []).forEach((key) => {
      if (typeof key === 'string' && key) {
        completedKeys.add(key);
      }
    });
  }

  const pendingItems = preparedItems.filter((item) => !completedKeys.has(item.key));
  const completed = preparedItems.length - pendingItems.length;

  if (!pendingItems.length) {
    await clearStoredCheckpoint();
    throw new Error('Saved batch is already complete. Start a new download.');
  }

  if (settings.includeMetadata) {
    await attachMetadataFromTab(tabId, pendingItems);
  }

  const job = {
    id: jobId,
    createdAt: checkpoint?.createdAt || Date.now(),
    status: 'running',
    tabId,
    total: preparedItems.length,
    completed,
    settings,
    pendingItems,
    completedKeys,
    downloadIds: [],
    activeDownloadIds: new Set(),
    cancelRequested: false,
    cancellationNotified: false,
    discardCheckpointOnCancel: false
  };

  runtimeState.activeJob = job;
  await upsertCheckpoint(job, { status: 'running', lastError: '' });

  publishJobStatus({
    stage: 'start',
    total: job.total,
    completed: job.completed,
    message: `Downloading Plaud recordings in batches of ${job.settings.batchSize}…`
  });

  executeActiveJob(job).catch((error) => {
    console.error('Background Plaud download failed', error);
  });
}

async function executeActiveJob(job) {
  try {
    for (let index = 0; index < job.pendingItems.length; index += job.settings.batchSize) {
      if (shouldAbortJob(job)) {
        await finalizeCancelledJob(job);
        return;
      }

      const batch = job.pendingItems.slice(index, index + job.settings.batchSize);
      const queuedBatch = [];

      for (const item of batch) {
        if (shouldAbortJob(job)) {
          await finalizeCancelledJob(job);
          return;
        }

        const resolved = await ensureJobDownloadUrl(job.tabId, item);
        const downloadId = await triggerDownload({
          url: resolved.url,
          filename: resolved.filename,
          extension: resolved.extension,
          conflictAction: resolved.conflictAction,
          subdirectory: job.settings.downloadSubdir,
          includeMetadata: job.settings.includeMetadata && !!resolved.metadata,
          metadata: resolved.metadata || null
        });

        queuedBatch.push({ item: resolved, downloadId });
        job.downloadIds.push(downloadId);
        job.activeDownloadIds.add(downloadId);
      }

      for (const queued of queuedBatch) {
        const finalState = await waitForDownloadTerminalState(queued.downloadId);
        job.activeDownloadIds.delete(queued.downloadId);

        if (shouldAbortJob(job)) {
          await finalizeCancelledJob(job);
          return;
        }

        if (finalState !== 'complete') {
          throw new Error(`Download interrupted for "${queued.item.filename}".`);
        }

        if (job.settings.postDownloadAction !== 'none' && queued.item.fileId) {
          await applyPostDownloadActionInTab(job.tabId, {
            action: job.settings.postDownloadAction,
            fileId: queued.item.fileId,
            tagId: job.settings.moveTargetTag
          });
        }

        job.completed += 1;
        job.completedKeys.add(queued.item.key);

        await upsertCheckpoint(job, { status: 'running', lastError: '' });
        publishJobStatus({
          stage: 'progress',
          total: job.total,
          completed: job.completed,
          message: `Downloaded ${job.completed}/${job.total} recording(s)…`
        });
      }
    }

    publishJobStatus({
      stage: 'done',
      total: job.total,
      completed: job.total,
      message: 'All Plaud recordings downloaded.'
    });
    await clearStoredCheckpoint();
  } catch (error) {
    if (shouldAbortJob(job)) {
      await finalizeCancelledJob(job);
      return;
    }

    const message = error?.message || 'Plaud download failed.';
    await upsertCheckpoint(job, { status: 'paused', lastError: message });
    publishJobStatus({
      stage: 'error',
      total: job.total,
      completed: job.completed,
      message
    });
  } finally {
    if (runtimeState.activeJob && runtimeState.activeJob.id === job.id) {
      runtimeState.activeJob = null;
    }
  }
}

async function stopActiveDownloadJob() {
  const job = runtimeState.activeJob;
  if (!job || job.status !== 'running') {
    return;
  }

  if (job.cancelRequested) {
    return;
  }

  job.cancelRequested = true;
  job.status = 'cancelling';

  publishJobStatus({
    stage: 'cancelling',
    total: job.total,
    completed: job.completed,
    message: 'Stopping Plaud downloads…'
  });

  await cancelDownloadIds(Array.from(job.activeDownloadIds));
}

async function cancelBulkDownloadJob() {
  const job = runtimeState.activeJob;
  if (job) {
    job.discardCheckpointOnCancel = true;
    if (!job.cancelRequested) {
      job.cancelRequested = true;
      job.status = 'cancelling';
      publishJobStatus({
        stage: 'cancelling',
        total: job.total,
        completed: job.completed,
        message: 'Cancelling Plaud bulk download…'
      });
      await cancelDownloadIds(Array.from(job.activeDownloadIds));
    }

    return { cancelled: true, cleared: true };
  }

  const checkpoint = await getStoredCheckpoint();
  if (checkpoint) {
    await clearStoredCheckpoint();
    return { cancelled: false, cleared: true };
  }

  return { cancelled: false, cleared: false };
}

async function finalizeCancelledJob(job) {
  if (job.cancellationNotified) {
    return;
  }

  job.cancellationNotified = true;
  job.status = 'cancelled';

  await cancelDownloadIds(Array.from(job.activeDownloadIds));

  if (job.discardCheckpointOnCancel) {
    await clearStoredCheckpoint();
  } else {
    await upsertCheckpoint(job, { status: 'cancelled', lastError: '' });
  }

  publishJobStatus({
    stage: 'cancelled',
    total: job.total,
    completed: job.completed,
    message: job.discardCheckpointOnCancel
      ? `Cancelled and cleared after ${job.completed}/${job.total} recording(s).`
      : `Cancelled after ${job.completed}/${job.total} recording(s).`
  });
}

function shouldAbortJob(job) {
  return Boolean(job?.cancelRequested);
}

function sanitizeJobSettings(settings = {}) {
  const downloadSubdir = toSafePath(settings.downloadSubdir || '');
  const batchSize = normalizeBatchSize(settings.batchSize);
  const rawAction =
    typeof settings.postDownloadAction === 'string'
      ? settings.postDownloadAction.toLowerCase()
      : 'none';
  const allowedActions = new Set(['none', 'move', 'trash']);
  const postDownloadAction = allowedActions.has(rawAction) ? rawAction : 'none';
  const moveTargetTag =
    typeof settings.moveTargetTag === 'string' ? settings.moveTargetTag.trim() : '';
  const includeMetadata = Boolean(settings.includeMetadata);

  if (postDownloadAction === 'move' && !moveTargetTag) {
    throw new Error('Set a destination folder ID before moving recordings.');
  }

  return {
    batchSize,
    downloadSubdir,
    postDownloadAction,
    moveTargetTag,
    includeMetadata
  };
}

function prepareJobItem(rawItem, index) {
  const fallbackName = `audio_${index + 1}`;
  const filenameSource =
    typeof rawItem?.filename === 'string' && rawItem.filename.trim() ? rawItem.filename : fallbackName;
  const filename = toSafeFilename(filenameSource, fallbackName);
  const fileId =
    typeof rawItem?.fileId === 'string' && rawItem.fileId.trim() ? rawItem.fileId.trim() : null;
  const url = typeof rawItem?.url === 'string' && rawItem.url.startsWith('http') ? rawItem.url : null;
  const extension = normalizeExtension(rawItem?.extension) || 'mp3';
  const conflictAction = rawItem?.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify';
  const metadata =
    rawItem?.metadata && typeof rawItem.metadata === 'object' ? { ...rawItem.metadata } : null;

  const keyCandidate =
    typeof rawItem?.key === 'string' && rawItem.key.trim() ? rawItem.key.trim() : fileId || url;
  const key = keyCandidate || `name:${filename}`;

  return {
    key,
    fileId,
    url,
    filename,
    extension,
    conflictAction,
    metadata
  };
}

async function ensureJobDownloadUrl(tabId, item) {
  if (item.url && item.url.startsWith('http')) {
    return item;
  }

  if (!item.fileId) {
    throw new Error('Missing file identifier. Open the recording and try again.');
  }

  const response = await sendTabMessage(tabId, MESSAGE_TYPES.RESOLVE_AUDIO_URL, {
    fileId: item.fileId
  });

  if (!response?.ok || typeof response.url !== 'string' || !response.url.startsWith('http')) {
    throw new Error(response?.message || 'Failed to resolve Plaud download URL.');
  }

  return {
    ...item,
    url: response.url
  };
}

async function attachMetadataFromTab(tabId, items) {
  const fileIds = Array.from(
    new Set(
      items
        .map((item) => (typeof item.fileId === 'string' ? item.fileId : null))
        .filter(Boolean)
    )
  );

  if (!fileIds.length) {
    return;
  }

  try {
    const response = await sendTabMessage(tabId, MESSAGE_TYPES.RESOLVE_METADATA, { fileIds });
    if (!response?.ok || !response.metadata) {
      console.warn('Plaud metadata resolution returned empty result');
      return;
    }

    const metadataMap = response.metadata;
    for (const item of items) {
      if (item.fileId && metadataMap[item.fileId]) {
        item.metadata = metadataMap[item.fileId];
      }
    }
  } catch (error) {
    console.warn('Failed to resolve Plaud metadata from tab', error);
  }
}

async function applyPostDownloadActionInTab(tabId, payload) {
  const response = await sendTabMessage(tabId, MESSAGE_TYPES.POST_DOWNLOAD_ACTION, payload);
  if (!response?.ok) {
    throw new Error(response?.message || 'Failed post-download action on Plaud.');
  }
}

async function sendTabMessage(tabId, type, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(
          new Error(
            'Open the Plaud dashboard tab and keep it loaded while the batch runs, then resume.'
          )
        );
        return;
      }
      resolve(response);
    });
  });
}

async function waitForDownloadTerminalState(downloadId) {
  const existing = await getDownloadState(downloadId);
  if (existing === 'complete' || existing === 'interrupted') {
    return existing;
  }

  return new Promise((resolve) => {
    const waiters = runtimeState.downloadWaiters.get(downloadId) || [];
    waiters.push(resolve);
    runtimeState.downloadWaiters.set(downloadId, waiters);
  });
}

function resolveDownloadWaiters(downloadId, state) {
  const waiters = runtimeState.downloadWaiters.get(downloadId);
  if (!waiters || !waiters.length) {
    return;
  }

  runtimeState.downloadWaiters.delete(downloadId);
  waiters.forEach((resolve) => {
    try {
      resolve(state);
    } catch (error) {
      console.debug('Failed to resolve download waiter', error);
    }
  });
}

async function getDownloadState(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (results) => {
      if (chrome.runtime.lastError || !Array.isArray(results) || !results.length) {
        resolve(null);
        return;
      }

      const [download] = results;
      const state = download?.state;
      resolve(typeof state === 'string' ? state : null);
    });
  });
}

function summarizeCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    return null;
  }

  const total = Number(checkpoint.total) || 0;
  const completed = Number(checkpoint.completed) || 0;
  if (total <= 0 || completed >= total) {
    return null;
  }

  return {
    id: checkpoint.id || null,
    total,
    completed,
    status: checkpoint.status || 'paused',
    lastError: checkpoint.lastError || '',
    updatedAt: checkpoint.updatedAt || Date.now()
  };
}

async function upsertCheckpoint(job, { status = 'running', lastError = '' } = {}) {
  const existing = await getStoredCheckpoint();
  const checkpoint = {
    version: CHECKPOINT_VERSION,
    id: job.id,
    createdAt: existing?.id === job.id ? existing.createdAt || job.createdAt : job.createdAt,
    updatedAt: Date.now(),
    status,
    total: job.total,
    completed: job.completed,
    completedKeys: Array.from(job.completedKeys),
    settings: {
      ...job.settings
    },
    lastError
  };

  await chrome.storage.local.set({
    [DOWNLOAD_CHECKPOINT_STORAGE_KEY]: checkpoint
  });
}

async function getStoredCheckpoint() {
  const stored = await chrome.storage.local.get({
    [DOWNLOAD_CHECKPOINT_STORAGE_KEY]: null
  });
  const checkpoint = stored?.[DOWNLOAD_CHECKPOINT_STORAGE_KEY];
  if (!checkpoint || typeof checkpoint !== 'object') {
    return null;
  }

  if (checkpoint.version !== CHECKPOINT_VERSION) {
    return null;
  }

  return checkpoint;
}

async function getCheckpointForUi() {
  if (runtimeState.activeJob && runtimeState.activeJob.status === 'running') {
    return null;
  }

  if (runtimeState.activeJob && runtimeState.activeJob.status === 'cancelling') {
    return null;
  }

  const checkpoint = await getStoredCheckpoint();
  return summarizeCheckpoint(checkpoint);
}

async function clearStoredCheckpoint() {
  await chrome.storage.local.remove(DOWNLOAD_CHECKPOINT_STORAGE_KEY);
}

function toValidTabId(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    return null;
  }

  return numeric;
}

function generateJobId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function inferExtension(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || '';
    const match = pathname.match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i);
    return match ? match[1].toLowerCase() : null;
  } catch (error) {
    console.warn('Failed to infer file extension from URL', error);
    return null;
  }
}

function normalizeExtension(value) {
  if (typeof value !== 'string') {
    return null;
  }

  return value.replace(/^\./, '').toLowerCase();
}

function shouldEmbedMetadata(extension) {
  const normalized = normalizeExtension(extension) || 'mp3';
  return normalized === 'mp3';
}

async function buildTaggedObjectUrl(sourceUrl, extension, metadata) {
  const frames = createMetadataFrames(metadata);
  if (!frames.length) {
    return { url: null, objectUrl: null };
  }

  let response;
  try {
    response = await fetch(sourceUrl);
  } catch (error) {
    throw new Error('Failed to fetch audio data for metadata embedding.');
  }

  if (!response.ok) {
    throw new Error(`Audio fetch rejected with status ${response.status}.`);
  }

  let audioBuffer;
  try {
    audioBuffer = await response.arrayBuffer();
  } catch (error) {
    throw new Error('Failed to read Plaud audio response.');
  }

  const taggedBuffer = writeId3Tag(audioBuffer, frames);
  const blob = new globalThis.Blob([taggedBuffer], { type: guessMimeType(extension) });
  const { url, objectUrl } = await createDownloadUrl(blob, extension);

  return { url, objectUrl };
}

function createMetadataFrames(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }

  const frames = [];

  const startTimeMs = toFiniteNumber(metadata.startTimeMs);
  const endTimeMs = toFiniteNumber(metadata.endTimeMs);
  const durationMs = toFiniteNumber(metadata.durationMs);
  const offsetMinutes = computeOffsetMinutes(metadata);
  const offsetString = formatOffsetString(offsetMinutes);

  if (startTimeMs !== null) {
    const recordedLocal = formatRecordedLocal(startTimeMs, offsetMinutes);
    if (recordedLocal) {
      frames.push({ id: 'TDRC', value: recordedLocal });
      frames.push({
        id: 'TXXX',
        description: 'Plaud-Recorded-Local',
        value: offsetString ? `${recordedLocal}${offsetString}` : recordedLocal
      });
    }

    frames.push({
      id: 'TXXX',
      description: 'Plaud-Start-Time-UTC',
      value: new Date(startTimeMs).toISOString()
    });
  }

  if (endTimeMs !== null) {
    frames.push({
      id: 'TXXX',
      description: 'Plaud-End-Time-UTC',
      value: new Date(endTimeMs).toISOString()
    });
  }

  if (durationMs !== null) {
    frames.push({ id: 'TLEN', value: String(Math.round(durationMs)) });
  }

  if (offsetString) {
    frames.push({ id: 'TXXX', description: 'Plaud-Timezone-Offset', value: offsetString });
  }

  const timezoneHours = toFiniteNumber(metadata.timezoneOffsetHours);
  if (timezoneHours !== null) {
    frames.push({
      id: 'TXXX',
      description: 'Plaud-Timezone-Hours',
      value: String(timezoneHours)
    });
  }

  const timezoneMinutes = toFiniteNumber(metadata.timezoneOffsetMinutes);
  if (timezoneMinutes !== null) {
    frames.push({
      id: 'TXXX',
      description: 'Plaud-Timezone-Minutes',
      value: String(timezoneMinutes)
    });
  }

  return frames;
}

function formatRecordedLocal(startTimeMs, offsetMinutes) {
  if (!Number.isFinite(startTimeMs)) {
    return null;
  }

  const offsetMs = Number.isFinite(offsetMinutes) ? offsetMinutes * 60000 : 0;
  const localDate = new Date(startTimeMs + offsetMs);
  return formatDateTime(localDate);
}

function computeOffsetMinutes(metadata) {
  const hours = toFiniteNumber(metadata.timezoneOffsetHours);
  const minutes = toFiniteNumber(metadata.timezoneOffsetMinutes);

  if (hours === null && minutes === null) {
    return null;
  }

  if (hours === null) {
    return minutes;
  }

  const baseMinutes = hours * 60;
  const adjustment = minutes === null ? 0 : hours >= 0 ? minutes : -minutes;
  return Math.round(baseMinutes + adjustment);
}

function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function formatOffsetString(totalMinutes) {
  if (!Number.isFinite(totalMinutes)) {
    return null;
  }

  const sign = totalMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(totalMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;

  const pad = (value) => String(value).padStart(2, '0');
  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

function guessMimeType(extension) {
  const normalized = normalizeExtension(extension);
  if (normalized === 'wav') {
    return 'audio/wav';
  }
  if (normalized === 'ogg' || normalized === 'opus') {
    return 'audio/ogg';
  }
  return 'audio/mpeg';
}

async function createDownloadUrl(blob, extension) {
  const urlFactory = globalThis.URL || globalThis.webkitURL;
  if (urlFactory && typeof urlFactory.createObjectURL === 'function') {
    const objectUrl = urlFactory.createObjectURL(blob);
    return { url: objectUrl, objectUrl };
  }

  const dataUrl = await blobToDataUrl(blob, guessMimeType(extension));
  return { url: dataUrl, objectUrl: null };
}

async function blobToDataUrl(blob, mimeType) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks = [];

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    let chunkString = '';
    for (let offset = 0; offset < chunk.length; offset += 1) {
      chunkString += String.fromCharCode(chunk[offset]);
    }
    chunks.push(chunkString);
  }

  const binaryString = chunks.join('');
  const base64 = globalThis.btoa(binaryString);
  const type = mimeType || blob.type || 'application/octet-stream';

  return `data:${type};base64,${base64}`;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function updateJobBadgeStatus(payload) {
  const { text, color, title } = normalizeBadgePayload(payload);

  safeActionCall('setBadgeBackgroundColor', { color });
  safeActionCall('setBadgeText', { text });
  if (title) {
    safeActionCall('setTitle', { title });
  }
}

function publishJobStatus(payload) {
  updateJobBadgeStatus(payload);
  try {
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.JOB_STATUS_UPDATE,
      payload
    });
  } catch (error) {
    console.debug('Failed to publish job status to popup', error);
  }
}

function normalizeBadgePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      text: '',
      color: '#1e88e5',
      title: 'Plaud Recording Downloader'
    };
  }

  const stage = payload.stage;
  const total = Number(payload.total) || 0;
  const completed = Number(payload.completed) || 0;
  const message =
    typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : 'Plaud Recording Downloader';

  let text = '';
  let color = '#1e88e5';

  switch (stage) {
    case 'start': {
      text = formatBadgeCount(total);
      break;
    }
    case 'progress': {
      text = formatBadgeCount(Math.max(total - completed, 0));
      break;
    }
    case 'cancelling': {
      text = formatBadgeCount(Math.max(total - completed, 0));
      color = '#fbc02d';
      break;
    }
    case 'cancelled': {
      text = '';
      break;
    }
    case 'done': {
      text = '';
      break;
    }
    case 'error': {
      text = 'ERR';
      color = '#d32f2f';
      break;
    }
    default: {
      text = formatBadgeCount(total);
      break;
    }
  }

  return {
    text,
    color,
    title: message
  };
}

function formatBadgeCount(count) {
  if (!Number.isFinite(count) || count <= 0) {
    return '';
  }

  if (count > 99) {
    return '99+';
  }

  return String(Math.max(0, Math.floor(count)));
}

function safeActionCall(method, details) {
  if (!chrome.action || typeof chrome.action[method] !== 'function') {
    return;
  }

  try {
    const result = chrome.action[method](details, () => {
      if (chrome.runtime.lastError) {
        console.debug(`Badge ${method} failed`, chrome.runtime.lastError.message);
      }
    });

    if (result && typeof result.then === 'function') {
      result.catch((error) => {
        console.debug(`Badge ${method} failed`, error);
      });
    }
  } catch (error) {
    console.debug(`Badge ${method} failed`, error);
  }
}

async function cancelDownloadIds(ids) {
  if (!Array.isArray(ids) || !ids.length) {
    return;
  }

  const uniqueIds = Array.from(new Set(ids)).filter(
    (candidate) => Number.isInteger(candidate) && candidate >= 0
  );

  await Promise.all(
    uniqueIds.map(
      (downloadId) =>
        new Promise((resolve) => {
          chrome.downloads.cancel(downloadId, () => {
            if (chrome.runtime.lastError) {
              console.debug(
                'Failed to cancel download',
                downloadId,
                chrome.runtime.lastError.message
              );
            }
            resolve();
          });
        })
    )
  );
}
