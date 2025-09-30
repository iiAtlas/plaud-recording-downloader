import { MESSAGE_TYPES, PLAUD_DASHBOARD_URL, sendMessageToActiveTab, toSafeFilename, toSafePath } from '../lib/messaging.js';

const state = {
  audioItems: [],
  settings: {
    downloadSubdir: '',
    postDownloadAction: 'none',
    moveTargetTag: ''
  }
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
});

async function handleRefreshClick() {
  await refreshAudioList();
}

async function handleDownloadAllClick() {
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
    setStatus('Downloads running in background. Watch the toolbar badge for progress.');
  } catch (error) {
    setStatus(error.message, true, { showOpenDashboard: shouldOfferPlaudShortcut(error) });
  } finally {
    toggleControls(true);
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
    contextEl.textContent = item.context ? `From: ${item.context}` : item.fileId ? `ID: ${item.fileId}` : '';

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
    setStatus('Download running in background. Watch the toolbar badge for progress.');
  } catch (error) {
    setStatus(error.message, true, { showOpenDashboard: shouldOfferPlaudShortcut(error) });
  } finally {
    toggleControls(true);
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
    const action = typeof stored.postDownloadAction === 'string' ? stored.postDownloadAction : 'none';
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
  refreshBtn.disabled = !isEnabled;
  downloadAllBtn.disabled = !isEnabled;
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

async function startBackgroundDownload(items) {
  const preparedItems = Array.isArray(items) ? items.map((item, index) => prepareItemForJob(item, index)) : [];

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
  const filenameSource = typeof item?.filename === 'string' && item.filename.trim() ? item.filename : fallbackName;
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
