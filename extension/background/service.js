import { MESSAGE_TYPES, toSafeFilename, toSafePath } from '../lib/messaging.js';
import { writeId3Tag } from '../lib/id3.js';

chrome.runtime.onInstalled.addListener(() => {
  const extensionName = chrome.i18n?.getMessage('appName') || 'Plaud Recording Downloader';
  console.info(`${extensionName} installed.`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return undefined;
  }

  switch (message.type) {
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
        updateJobBadgeStatus(message.payload);
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
  const adjustment = minutes === null ? 0 : (hours >= 0 ? minutes : -minutes);
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
