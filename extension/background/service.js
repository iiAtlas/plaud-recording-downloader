import { MESSAGE_TYPES, toSafeFilename, toSafePath } from '../lib/messaging.js';

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
      const downloadIds = Array.isArray(message?.payload?.downloadIds) ? message.payload.downloadIds : [];

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

function triggerDownload(item) {
  const { url, filename, extension, conflictAction = 'uniquify', subdirectory } = item || {};

  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return Promise.reject(new Error('Invalid download URL.'));
  }

  const safeFilename = toSafeFilename(filename, 'audio');
  const resolvedExtension = normalizeExtension(extension) || inferExtension(url) || 'mp3';
  const safeSubdir = toSafePath(subdirectory || '');
  const downloadFilename = safeSubdir
    ? `${safeSubdir}/${safeFilename}.${resolvedExtension}`
    : `${safeFilename}.${resolvedExtension}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename: downloadFilename,
        conflictAction
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
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
  const message = typeof payload.message === 'string' && payload.message.trim()
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

  const uniqueIds = Array.from(new Set(ids)).filter((candidate) => Number.isInteger(candidate) && candidate >= 0);

  await Promise.all(
    uniqueIds.map((downloadId) => new Promise((resolve) => {
      chrome.downloads.cancel(downloadId, () => {
        if (chrome.runtime.lastError) {
          console.debug('Failed to cancel download', downloadId, chrome.runtime.lastError.message);
        }
        resolve();
      });
    }))
  );
}
