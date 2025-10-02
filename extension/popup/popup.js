import {
  MESSAGE_TYPES,
  PLAUD_DASHBOARD_URL,
  sendMessageToActiveTab,
  toSafeFilename,
  toSafePath
} from '../lib/messaging.js';

const state = {
  audioItems: [],
  settings: {
    downloadSubdir: '',
    postDownloadAction: 'none',
    moveTargetTag: ''
  },
  job: null,
  progressHideTimeoutId: null
};

const statusEl = document.getElementById('status');
const statusMessageEl = document.getElementById('status-message');
const openDashboardBtn = document.getElementById('open-dashboard');
const listEl = document.getElementById('list');
const refreshBtn = document.getElementById('refresh');
const downloadAllBtn = document.getElementById('download-all');
const downloadSubdirInput = document.getElementById('download-subdir');
const postDownloadActionSelect = document.getElementById('post-download-action');
const moveTagGroup = document.getElementById('move-target-group');
const moveTagInput = document.getElementById('move-tag-id');
const template = document.getElementById('audio-item-template');
const jobProgressEl = document.getElementById('job-progress');
const jobProgressBarEl = document.getElementById('job-progress-bar');
const jobProgressLabelEl = document.getElementById('job-progress-label');
const downloadAllDefaultLabel = downloadAllBtn ? downloadAllBtn.textContent : 'Download all';
const downloadAllStopLabel = 'Stop';

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== 'string') {
    return;
  }

  if (message.type === MESSAGE_TYPES.JOB_STATUS_UPDATE) {
    handleJobStatusUpdate(message.payload);
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  await hydrateSettings();
  refreshBtn.addEventListener('click', handleRefreshClick);
  downloadAllBtn.addEventListener('click', handleDownloadAllClick);
  downloadSubdirInput.addEventListener('change', handleDownloadPathChange);
  downloadSubdirInput.addEventListener('blur', handleDownloadPathChange);
  postDownloadActionSelect.addEventListener('change', handlePostDownloadActionChange);
  moveTagInput.addEventListener('change', handleMoveTagChange);
  moveTagInput.addEventListener('blur', handleMoveTagChange);
  if (openDashboardBtn) {
    openDashboardBtn.addEventListener('click', handleOpenDashboardClick);
  }

  setStatus('Press "Scan" to search for audio on this page.');
  updateDownloadAllButton();
});

async function handleRefreshClick() {
  await refreshAudioList();
}

async function handleDownloadAllClick() {
  if (isJobRunning() || isJobCancelling()) {
    await stopBackgroundDownload();
    return;
  }

  if (!validatePostDownloadSettings()) {
    return;
  }

  if (!state.audioItems.length) {
    setStatus('No audio to download yet. Run a scan first.', true);
    return;
  }

  toggleControls(false);
  setStatus('Starting background download…');

  try {
    await startBackgroundDownload(state.audioItems);
  } catch (error) {
    setStatus(error.message, true, { showOpenDashboard: shouldOfferPlaudShortcut(error) });
    toggleControls(true);
    resetJobState();
  }
}

async function refreshAudioList() {
  toggleControls(false);
  setStatus('Scanning for audio…');

  try {
    const response = await sendMessageToActiveTab({
      type: MESSAGE_TYPES.REQUEST_AUDIO_SCAN
    });

    if (!response?.ok) {
      throw new Error(response?.message || 'Scan failed.');
    }

    state.audioItems = Array.isArray(response.items) ? response.items : [];

    renderList();

    if (!state.audioItems.length) {
      setStatus('No audio found yet. Navigate to a supported page and try again.');
    } else {
      setStatus(`Found ${state.audioItems.length} item(s).`);
    }
  } catch (error) {
    setStatus(error.message, true, { showOpenDashboard: shouldOfferPlaudShortcut(error) });
  } finally {
    toggleControls(true);
  }
}

function renderList() {
  listEl.innerHTML = '';

  if (!state.audioItems.length) {
    return;
  }

  state.audioItems.forEach((item, index) => {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector('.audio-card');
    const titleEl = fragment.querySelector('.audio-card__title');
    const contextEl = fragment.querySelector('.audio-card__context');
    const button = fragment.querySelector('button');

    const friendlyName = item.filename || `Audio ${index + 1}`;
    titleEl.textContent = friendlyName;
    contextEl.textContent = item.context
      ? `From: ${item.context}`
      : item.fileId
        ? `ID: ${item.fileId}`
        : '';

    if (!item.fileId && !item.url) {
      button.disabled = true;
      button.textContent = 'Need file ID';
      button.title = 'Open the recording once so the page exposes its file identifier.';
    } else {
      button.addEventListener('click', () => downloadSingle(item, index));
    }

    listEl.appendChild(fragment);
  });
}

async function downloadSingle(item, index = 0) {
  if (!validatePostDownloadSettings()) {
    return;
  }

  toggleControls(false);
  setStatus(`Starting background download for ${item.filename || `audio_${index + 1}`}`);

  try {
    await startBackgroundDownload([item]);
  } catch (error) {
    setStatus(error.message, true, { showOpenDashboard: shouldOfferPlaudShortcut(error) });
    toggleControls(true);
    resetJobState();
  }
}

async function hydrateSettings() {
  try {
    const stored = await chrome.storage.sync.get({
      downloadSubdir: '',
      postDownloadAction: 'none',
      moveTargetTag: ''
    });
    const sanitized = toSafePath(stored.downloadSubdir || '');
    const action =
      typeof stored.postDownloadAction === 'string' ? stored.postDownloadAction : 'none';
    const tagId = typeof stored.moveTargetTag === 'string' ? stored.moveTargetTag : '';

    state.settings.downloadSubdir = sanitized;
    state.settings.postDownloadAction = action;
    state.settings.moveTargetTag = tagId.trim();

    downloadSubdirInput.value = sanitized;
    postDownloadActionSelect.value = state.settings.postDownloadAction;
    moveTagInput.value = state.settings.moveTargetTag;
    updateMoveTagVisibility();
  } catch (error) {
    console.warn('Failed to load downloader settings', error);
    state.settings.downloadSubdir = '';
    state.settings.postDownloadAction = 'none';
    state.settings.moveTargetTag = '';
    downloadSubdirInput.value = '';
    postDownloadActionSelect.value = 'none';
    moveTagInput.value = '';
    updateMoveTagVisibility();
  }
}

async function handleDownloadPathChange() {
  const rawValue = downloadSubdirInput.value;
  const sanitized = toSafePath(rawValue);

  state.settings.downloadSubdir = sanitized;
  downloadSubdirInput.value = sanitized;

  try {
    await chrome.storage.sync.set({ downloadSubdir: sanitized });
    if (sanitized) {
      setStatus(`Downloads will be saved in Downloads/${sanitized}.`);
    } else {
      setStatus('Downloads will use the default Downloads folder.');
    }
  } catch (error) {
    setStatus('Failed to save download location.', true);
    console.error('Failed to persist download subdirectory', error);
  }
}

async function handlePostDownloadActionChange() {
  const newAction = postDownloadActionSelect.value || 'none';
  state.settings.postDownloadAction = newAction;
  updateMoveTagVisibility();

  try {
    await chrome.storage.sync.set({ postDownloadAction: newAction });
    setStatus(`Post-download action set to "${postDownloadActionLabel(newAction)}".`);
  } catch (error) {
    setStatus('Failed to update post-download action.', true);
    console.error('Failed to persist post-download action', error);
  }
}

async function handleMoveTagChange() {
  const sanitized = moveTagInput.value.trim();
  state.settings.moveTargetTag = sanitized;

  try {
    await chrome.storage.sync.set({ moveTargetTag: sanitized });
    if (sanitized) {
      setStatus(`Move destination set to tag ${sanitized}.`);
    }
  } catch (error) {
    setStatus('Failed to save move destination.', true);
    console.error('Failed to persist move target tag', error);
  }
}

function updateMoveTagVisibility() {
  if (state.settings.postDownloadAction === 'move') {
    moveTagGroup.removeAttribute('hidden');
  } else {
    moveTagGroup.setAttribute('hidden', '');
  }
}

function postDownloadActionLabel(value) {
  switch (value) {
    case 'move':
      return 'Move to folder';
    case 'trash':
      return 'Move to trash';
    default:
      return 'Do nothing';
  }
}

function validatePostDownloadSettings() {
  if (state.settings.postDownloadAction === 'move' && !state.settings.moveTargetTag) {
    setStatus('Set a destination folder ID before moving recordings.', true);
    moveTagInput.focus();
    return false;
  }

  return true;
}

function setStatus(message, isError = false, options = {}) {
  if (statusMessageEl) {
    statusMessageEl.textContent = message;
  } else {
    statusEl.textContent = message;
  }

  statusEl.classList.toggle('status--error', isError);
  toggleDashboardShortcut(Boolean(options.showOpenDashboard));
}

function toggleControls(isEnabled) {
  const jobStatus = state.job?.status || null;
  const allowRefresh = isEnabled && jobStatus !== 'running' && jobStatus !== 'cancelling';
  refreshBtn.disabled = !allowRefresh;

  if (!downloadAllBtn) {
    return;
  }

  if (jobStatus === 'running') {
    downloadAllBtn.disabled = false;
  } else if (jobStatus === 'cancelling') {
    downloadAllBtn.disabled = true;
  } else {
    downloadAllBtn.disabled = !isEnabled;
  }

  updateDownloadAllButton();
}

function toggleDashboardShortcut(shouldShow) {
  if (!openDashboardBtn) {
    return;
  }

  if (shouldShow) {
    openDashboardBtn.hidden = false;
    openDashboardBtn.disabled = false;
  } else {
    openDashboardBtn.hidden = true;
  }
}

async function handleOpenDashboardClick() {
  try {
    await chrome.tabs.create({ url: PLAUD_DASHBOARD_URL });
    window.close();
  } catch (error) {
    console.error('Failed to open Plaud dashboard tab', error);
  }
}

function shouldOfferPlaudShortcut(error) {
  if (!error) {
    return false;
  }

  if ('code' in error && error.code === 'plaud-dashboard-unavailable') {
    return true;
  }

  const message = String(error.message || '').toLowerCase();
  return message.includes('open the plaud dashboard');
}

function handleJobStatusUpdate(update) {
  const normalized = normalizeJobUpdate(update);
  if (!normalized) {
    return;
  }

  const { stage, total, completed, message } = normalized;
  const isErrorStage = stage === 'error';
  const showDashboardShortcut = isErrorStage && shouldOfferPlaudShortcut({ message });

  setStatus(message, isErrorStage, { showOpenDashboard: showDashboardShortcut });

  if (stage === 'start' || stage === 'progress') {
    state.job = {
      status: 'running',
      total,
      completed
    };
    clearScheduledJobProgressReset();
    renderJobProgress({ stage, total, completed });
    toggleControls(false);
    updateDownloadAllButton();
    return;
  }

  if (stage === 'cancelling') {
    if (state.job) {
      state.job.status = 'cancelling';
      state.job.total = total;
      state.job.completed = completed;
    } else {
      state.job = {
        status: 'cancelling',
        total,
        completed
      };
    }

    renderJobProgress({ stage, total, completed });
    toggleControls(false);
    updateDownloadAllButton();
    return;
  }

  if (stage === 'done') {
    renderJobProgress({ stage, total, completed: total });
    scheduleJobProgressReset();
    state.job = null;
    toggleControls(true);
    updateDownloadAllButton();
    return;
  }

  if (stage === 'error') {
    renderJobProgress({ stage, total, completed });
    scheduleJobProgressReset();
    state.job = null;
    toggleControls(true);
    updateDownloadAllButton();
    return;
  }

  if (stage === 'cancelled') {
    renderJobProgress({ stage, total, completed });
    scheduleJobProgressReset();
    state.job = null;
    toggleControls(true);
    updateDownloadAllButton();
    return;
  }

  if (total > 0) {
    renderJobProgress({ stage, total, completed });
    updateDownloadAllButton();
  }
}

function normalizeJobUpdate(update) {
  if (!update || typeof update !== 'object') {
    return null;
  }

  const stage = typeof update.stage === 'string' ? update.stage : 'progress';
  const rawTotal = Number(update.total);
  const total = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.max(1, Math.round(rawTotal)) : 0;
  const rawCompleted = Number(update.completed);
  const completedBase = Number.isFinite(rawCompleted) ? Math.round(rawCompleted) : 0;
  const completed =
    total > 0 ? Math.min(total, Math.max(0, completedBase)) : Math.max(0, completedBase);
  const message =
    typeof update.message === 'string' && update.message.trim()
      ? update.message.trim()
      : jobMessageFallback(stage, total, completed);

  return {
    stage,
    total,
    completed,
    message
  };
}

function jobMessageFallback(stage, total, completed) {
  switch (stage) {
    case 'start':
      return total > 0 ? `Preparing ${total} Plaud recording(s)…` : 'Downloading Plaud recordings…';
    case 'done':
      return 'All Plaud recordings downloaded.';
    case 'error':
      return total > 0
        ? `Download stopped after ${completed}/${total} recording(s).`
        : 'Plaud download failed.';
    case 'cancelling':
      return 'Stopping Plaud downloads…';
    case 'cancelled':
      return total > 0
        ? `Cancelled after ${completed}/${total} recording(s).`
        : 'Plaud downloads cancelled.';
    default:
      return total > 0
        ? `Downloaded ${completed}/${total} recording(s)…`
        : 'Downloading Plaud recordings…';
  }
}

function renderJobProgress({ stage, total, completed }) {
  if (!jobProgressEl || !jobProgressBarEl || !jobProgressLabelEl) {
    return;
  }

  if (!total || total <= 0) {
    resetJobProgressUI();
    return;
  }

  const safeCompleted = Math.max(0, Math.min(completed, total));
  const percentage = Math.round((safeCompleted / total) * 100);

  jobProgressEl.hidden = false;
  jobProgressBarEl.style.width = `${percentage}%`;

  if (stage === 'done') {
    jobProgressLabelEl.textContent = `Finished ${total} recording(s).`;
    return;
  }

  if (stage === 'error') {
    jobProgressLabelEl.textContent = `Downloaded ${safeCompleted} of ${total} recording(s) before error.`;
    return;
  }

  if (stage === 'cancelling') {
    jobProgressLabelEl.textContent = `Stopping… ${safeCompleted} of ${total} recording(s) finished.`;
    return;
  }

  if (stage === 'cancelled') {
    jobProgressLabelEl.textContent = `Cancelled after ${safeCompleted} of ${total} recording(s).`;
    return;
  }

  jobProgressLabelEl.textContent = `Downloaded ${safeCompleted} of ${total} recording(s) (${percentage}%).`;
}

function scheduleJobProgressReset() {
  clearScheduledJobProgressReset();
  state.progressHideTimeoutId = window.setTimeout(() => {
    resetJobProgressUI();
    state.progressHideTimeoutId = null;
  }, 3500);
}

function clearScheduledJobProgressReset() {
  if (state.progressHideTimeoutId) {
    window.clearTimeout(state.progressHideTimeoutId);
    state.progressHideTimeoutId = null;
  }
}

function resetJobProgressUI() {
  if (!jobProgressEl || !jobProgressBarEl || !jobProgressLabelEl) {
    return;
  }

  jobProgressEl.hidden = true;
  jobProgressBarEl.style.width = '0%';
  jobProgressLabelEl.textContent = '';
}

function resetJobState() {
  state.job = null;
  clearScheduledJobProgressReset();
  resetJobProgressUI();
  updateDownloadAllButton();
}

function isJobRunning() {
  return Boolean(state.job && state.job.status === 'running');
}

function isJobCancelling() {
  return Boolean(state.job && state.job.status === 'cancelling');
}

function updateDownloadAllButton() {
  if (!downloadAllBtn) {
    return;
  }

  if (isJobCancelling()) {
    downloadAllBtn.textContent = downloadAllStopLabel;
    downloadAllBtn.disabled = true;
    downloadAllBtn.classList.remove('button--primary');
    downloadAllBtn.classList.add('button--danger');
    return;
  }

  if (isJobRunning()) {
    downloadAllBtn.textContent = downloadAllStopLabel;
    downloadAllBtn.disabled = false;
    downloadAllBtn.classList.remove('button--primary');
    downloadAllBtn.classList.add('button--danger');
    return;
  }

  downloadAllBtn.textContent = downloadAllDefaultLabel;
  downloadAllBtn.classList.remove('button--danger');
  if (!downloadAllBtn.classList.contains('button--primary')) {
    downloadAllBtn.classList.add('button--primary');
  }
}

async function stopBackgroundDownload() {
  try {
    const response = await sendMessageToActiveTab({
      type: MESSAGE_TYPES.STOP_DOWNLOAD_JOB
    });

    if (!response?.ok) {
      throw new Error(response?.message || 'Failed to stop downloads.');
    }
  } catch (error) {
    setStatus(error.message || 'Failed to stop downloads.', true);
    if (!isJobRunning() && !isJobCancelling()) {
      toggleControls(true);
    }
  }

  updateDownloadAllButton();
}

async function startBackgroundDownload(items) {
  const preparedItems = Array.isArray(items)
    ? items.map((item, index) => prepareItemForJob(item, index))
    : [];

  if (!preparedItems.length) {
    throw new Error('No recordings were queued for download.');
  }

  const response = await sendMessageToActiveTab({
    type: MESSAGE_TYPES.START_DOWNLOAD_JOB,
    payload: {
      items: preparedItems,
      settings: {
        downloadSubdir: state.settings.downloadSubdir,
        postDownloadAction: state.settings.postDownloadAction,
        moveTargetTag: state.settings.moveTargetTag
      }
    }
  });

  if (!response?.ok) {
    throw new Error(response?.message || 'Failed to start background download.');
  }
}

function prepareItemForJob(item, index) {
  const fallbackName = `audio_${index + 1}`;
  const filenameSource =
    typeof item?.filename === 'string' && item.filename.trim() ? item.filename : fallbackName;
  const fileId = typeof item?.fileId === 'string' ? item.fileId : null;
  const url = typeof item?.url === 'string' && item.url.startsWith('http') ? item.url : null;
  const extension = normalizeExtensionCandidate(item?.extension) || 'mp3';

  return {
    fileId,
    url,
    filename: toSafeFilename(filenameSource, fallbackName),
    extension,
    conflictAction: item?.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify'
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
