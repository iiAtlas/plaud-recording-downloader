export const MESSAGE_TYPES = Object.freeze({
  REQUEST_AUDIO_SCAN: 'plaud-recording-downloader.audio.scan',
  RESOLVE_AUDIO_URL: 'plaud-recording-downloader.audio.resolve-url',
  DOWNLOAD_AUDIO_BATCH: 'plaud-recording-downloader.audio.download-batch',
  DOWNLOAD_SINGLE: 'plaud-recording-downloader.audio.download-single',
  POST_DOWNLOAD_ACTION: 'plaud-recording-downloader.audio.post-download-action',
  HEARTBEAT: 'plaud-recording-downloader.extension.heartbeat'
});

/**
 * Sends a runtime message to the active tab in the current window.
 * Throws if there is no active tab (e.g., popup opened on the extensions page).
 */
export async function sendMessageToActiveTab(message) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab || typeof activeTab.id !== 'number') {
    throw new Error('No active tab found. Open the target site before using the downloader.');
  }

  return chrome.tabs.sendMessage(activeTab.id, message);
}

/**
 * Normalizes a filename for download usage by replacing restricted characters.
 */
export function toSafeFilename(candidate, fallback = 'audio') {
  const sanitized = (candidate || fallback)
    .replace(/[^\w\d-_]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_');

  return sanitized || fallback;
}

export function toSafePath(path) {
  if (typeof path !== 'string') {
    return '';
  }

  const segments = path
    .split(/[\\/]+/)
    .map((segment) => toSafePathSegment(segment))
    .filter(Boolean);

  return segments.join('/');
}

export function toSafePathSegment(segment) {
  if (typeof segment !== 'string') {
    return '';
  }

  return segment
    .replace(/[^\w\d-_]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}
