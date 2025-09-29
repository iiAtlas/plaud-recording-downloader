export const MESSAGE_TYPES = Object.freeze({
  REQUEST_AUDIO_SCAN: 'atlas.audio.scan',
  RESOLVE_AUDIO_URL: 'atlas.audio.resolve-url',
  DOWNLOAD_AUDIO_BATCH: 'atlas.audio.download-batch',
  DOWNLOAD_SINGLE: 'atlas.audio.download-single',
  HEARTBEAT: 'atlas.extension.heartbeat'
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
