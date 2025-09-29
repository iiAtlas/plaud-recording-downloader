import { MESSAGE_TYPES, toSafeFilename, toSafePath } from '../lib/messaging.js';

chrome.runtime.onInstalled.addListener(() => {
  console.info('Plaud Recording Downloader installed.');
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
