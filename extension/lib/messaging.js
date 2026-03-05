const PRIMARY_PLAUD_HOST = 'app.plaud.ai';
const SECONDARY_PLAUD_HOST = 'web.plaud.ai';
export const PLAUD_DASHBOARD_URL = `https://${PRIMARY_PLAUD_HOST}/`;

const PLAUD_HOST_PREFIX = 'app';
const DEFAULT_BATCH_SIZE = 25;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 200;
export const DOWNLOAD_CHECKPOINT_STORAGE_KEY = 'plaud-download-checkpoint-v1';

export const MESSAGE_TYPES = Object.freeze({
  REQUEST_AUDIO_SCAN: 'plaud-recording-downloader.audio.scan',
  RESOLVE_AUDIO_URL: 'plaud-recording-downloader.audio.resolve-url',
  DOWNLOAD_AUDIO_BATCH: 'plaud-recording-downloader.audio.download-batch',
  DOWNLOAD_SINGLE: 'plaud-recording-downloader.audio.download-single',
  POST_DOWNLOAD_ACTION: 'plaud-recording-downloader.audio.post-download-action',
  START_DOWNLOAD_JOB: 'plaud-recording-downloader.audio.start-background-job',
  RESUME_DOWNLOAD_JOB: 'plaud-recording-downloader.audio.resume-background-job',
  STOP_DOWNLOAD_JOB: 'plaud-recording-downloader.audio.stop-background-job',
  CANCEL_DOWNLOAD_JOB: 'plaud-recording-downloader.audio.cancel-background-job',
  GET_DOWNLOAD_CHECKPOINT: 'plaud-recording-downloader.audio.get-download-checkpoint',
  CANCEL_DOWNLOADS: 'plaud-recording-downloader.audio.cancel-downloads',
  JOB_STATUS_UPDATE: 'plaud-recording-downloader.audio.job-status-update',
  HEARTBEAT: 'plaud-recording-downloader.extension.heartbeat'
});

/**
 * Sends a runtime message to the active tab in the current window.
 * Throws if there is no active tab (e.g., popup opened on the extensions page).
 */
export async function sendMessageToActiveTab(message) {
  const activeTab = await getActivePlaudTab();

  const maxAttempts = 3;
  const delayMs = 200;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(activeTab.id, message);
    } catch (error) {
      if (isMissingContentScriptError(error)) {
        if (attempt < maxAttempts - 1) {
          await delay(delayMs);
          continue;
        }

        throw createDashboardUnavailableError();
      }

      throw error;
    }
  }
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

export async function getActivePlaudTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab || typeof activeTab.id !== 'number') {
    throw createDashboardUnavailableError();
  }

  const activeUrl = typeof activeTab.url === 'string' ? activeTab.url : '';
  if (!isSupportedPlaudUrl(activeUrl)) {
    throw createDashboardUnavailableError();
  }

  return activeTab;
}

export function normalizeBatchSize(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_BATCH_SIZE;
  }

  const rounded = Math.round(numeric);
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, rounded));
}

function createDashboardUnavailableError() {
  const error = new Error(
    'Open the Plaud dashboard at https://app.plaud.ai or https://web.plaud.ai and try again.'
  );
  error.code = 'plaud-dashboard-unavailable';
  return error;
}

export function isSupportedPlaudUrl(candidate) {
  if (typeof candidate !== 'string' || !candidate) {
    return false;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === PRIMARY_PLAUD_HOST || hostname === SECONDARY_PLAUD_HOST) {
      return true;
    }

    return hostname.endsWith('.plaud.ai') && hostname.startsWith(`${PLAUD_HOST_PREFIX}-`);
  } catch {
    return false;
  }
}

function isMissingContentScriptError(error) {
  if (!error || typeof error.message !== 'string') {
    return false;
  }

  return (
    error.message.includes('Could not establish connection') ||
    error.message.includes('Receiving end does not exist')
  );
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
