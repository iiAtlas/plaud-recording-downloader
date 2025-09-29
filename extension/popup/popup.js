import { MESSAGE_TYPES, sendMessageToActiveTab, toSafeFilename } from '../lib/messaging.js';

const state = {
  audioItems: []
};

const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const refreshBtn = document.getElementById('refresh');
const downloadAllBtn = document.getElementById('download-all');
const template = document.getElementById('audio-item-template');

document.addEventListener('DOMContentLoaded', () => {
  refreshBtn.addEventListener('click', handleRefreshClick);
  downloadAllBtn.addEventListener('click', handleDownloadAllClick);

  refreshAudioList();
});

async function handleRefreshClick() {
  await refreshAudioList();
}

async function handleDownloadAllClick() {
  if (!state.audioItems.length) {
    setStatus('No audio to download yet. Try rescanning.', true);
    return;
  }

  toggleControls(false);
  setStatus('Resolving download links…');

  try {
    const resolvedItems = [];

    for (let index = 0; index < state.audioItems.length; index += 1) {
      const item = state.audioItems[index];
      const resolved = await ensureDownloadUrl(item, index);

      resolvedItems.push({
        ...resolved,
        filename: toSafeFilename(resolved.filename, `audio_${index + 1}`)
      });
    }

    const response = await sendToBackground({
      type: MESSAGE_TYPES.DOWNLOAD_AUDIO_BATCH,
      payload: resolvedItems
    });

    if (!response?.ok) {
      throw new Error(response?.message || 'Download failed.');
    }

    setStatus(`Started ${response.downloadIds.length} download(s).`);
  } catch (error) {
    setStatus(error.message, true);
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
      setStatus('No audio found yet. Navigate to a supported page and rescan.');
    } else {
      setStatus(`Found ${state.audioItems.length} item(s).`);
    }
  } catch (error) {
    setStatus(error.message, true);
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
  toggleControls(false);
  setStatus(`Resolving link for ${item.filename || `audio_${index + 1}`}`);

  try {
    const resolved = await ensureDownloadUrl(item, index);

    const response = await sendToBackground({
      type: MESSAGE_TYPES.DOWNLOAD_SINGLE,
      payload: {
        ...resolved,
        filename: toSafeFilename(resolved.filename, `audio_${index + 1}`)
      }
    });

    if (!response?.ok) {
      throw new Error(response?.message || 'Download failed.');
    }

    setStatus('Download requested. Check your browser downloads list.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    toggleControls(true);
  }
}

async function ensureDownloadUrl(item, index) {
  if (item.url && item.url.startsWith('http')) {
    return item;
  }

  if (!item.fileId) {
    throw new Error('Missing file identifier. Open the recording once or refresh the page.');
  }

  const response = await sendMessageToActiveTab({
    type: MESSAGE_TYPES.RESOLVE_AUDIO_URL,
    payload: { fileId: item.fileId }
  });

  if (!response?.ok || typeof response.url !== 'string') {
    throw new Error(response?.message || 'Failed to fetch download link from Plaud.');
  }

  const updated = {
    ...item,
    url: response.url
  };

  state.audioItems[index] = updated;

  return updated;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('status--error', isError);
}

function toggleControls(isEnabled) {
  refreshBtn.disabled = !isEnabled;
  downloadAllBtn.disabled = !isEnabled;
}

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}
