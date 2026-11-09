import { resolveAudioExtension } from './audio-format.js';

export function isMigratedPlaudAccount(payload) {
  return Number(payload?.status) === -1800907;
}

export function isPlaudV4FileId(fileId) {
  return /^(?:of_|f_)/.test(fileId);
}

export function isPlaudV4FolderId(folderId) {
  return /^(?:on_fd_|n_)[\w-]+$/.test(folderId);
}

function toV4FileId(fileId) {
  return /^[\da-f]{32}$/i.test(fileId) ? `of_${fileId}` : fileId;
}

function normalizeRecording(item, index) {
  const startTimeMs = Number(item.created_at_show_ms) || null;
  const durationMs = Number(item.duration_ms) || null;
  const context = [
    startTimeMs && new Date(startTimeMs).toLocaleString(),
    durationMs && `${Math.round(durationMs / 1000)}s`,
    item.parent_folder?.name
  ]
    .filter(Boolean)
    .join(' | ');

  return {
    fileId: item.file_id,
    filename: item.name || `Recording ${index + 1}`,
    context: context || null,
    url: null,
    extension: null,
    metadata: { startTimeMs, durationMs }
  };
}

export function createPlaudV4Client(fetchPlaudApi) {
  async function request(path, init) {
    const { response, payload } = await fetchPlaudApi(`/file-app/v4${path}`, init);
    if (!response.ok || payload?.status !== 0 || !payload.data) {
      throw new Error(
        payload?.msg || payload?.message || `Plaud 4.0 request failed (${response.status}).`
      );
    }
    return payload.data;
  }

  async function* listPages(path, params) {
    const query = new URLSearchParams({ ...params, page_size: '100' });
    const seenCursors = new Set();
    do {
      const { items, next_cursor: cursor } = await request(`${path}?${query}`);
      if (!Array.isArray(items)) {
        throw new Error('Plaud 4.0 returned an invalid recording or folder list.');
      }
      yield items;
      if (!cursor) return;
      if (seenCursors.has(cursor)) {
        throw new Error('Plaud 4.0 repeated a page while scanning.');
      }
      seenCursors.add(cursor);
      query.set('cursor', cursor);
    } while (true);
  }

  async function listRecordings() {
    const recordings = new Map();
    for await (const page of listPages('/recordings/all', {
      sort_by: 'created',
      sort_order: 'desc'
    })) {
      for (const item of page) {
        if (typeof item?.file_id === 'string' && item.file_id && !recordings.has(item.file_id)) {
          recordings.set(item.file_id, normalizeRecording(item, recordings.size));
        }
      }
    }
    return [...recordings.values()];
  }

  function getDetail(fileId) {
    return request(`/files/detail/${encodeURIComponent(toV4FileId(fileId))}`);
  }

  async function resolveAudio(fileId) {
    const { objects, meta } = await getDetail(fileId);
    const audio = objects?.find((item) => item?.object_type === 'AUDIO');
    if (typeof audio?.content_url !== 'string' || !audio.content_url.startsWith('https://')) {
      throw new Error('Plaud 4.0 has no downloadable audio for this recording yet.');
    }
    const url = audio.content_url;
    const extension = resolveAudioExtension({ url, contentType: audio.mime_type });
    return { url, extension, meta };
  }

  async function getMovableNode(fileId) {
    const { node } = await getDetail(fileId);
    const folderId = node?.folder?.folder_id;
    const displayFolderId = node?.display_folder?.folder_id;
    if (!folderId || folderId === displayFolderId) {
      return node;
    }

    const query = new URLSearchParams({ file_id: toV4FileId(fileId) });
    const { flat_items: ancestors } = await request(`/nodes/ancestor-items?${query}`);
    const container = ancestors?.find((item) => item?.node_id === folderId);
    if (container) return container;

    if (displayFolderId) {
      for await (const page of listPages('/folders/children', { node_id: displayFolderId })) {
        const item = page.find((candidate) => candidate?.node_id === folderId);
        if (item) return item;
      }
    }
    throw new Error('Plaud 4.0 could not find the folder containing this recording.');
  }

  async function applyPostDownloadAction(fileId, action, targetFolderId) {
    if (action === 'move' && !isPlaudV4FolderId(targetFolderId)) {
      throw new Error('Enter the destination folder’s Plaud 4.0 node ID before moving recordings.');
    }
    const node = await getMovableNode(fileId);
    if (!node?.node_id || !Number.isSafeInteger(node.version_ms) || node.version_ms <= 0) {
      throw new Error('Plaud 4.0 could not find the recording node and its current version.');
    }
    const items = [{ node_id: node.node_id, origin_version: node.version_ms }];
    const isMove = action === 'move';
    const result = await request(`/nodes/${action}`, {
      method: isMove ? 'POST' : 'DELETE',
      body: JSON.stringify(isMove ? { items, target_node_id: targetFolderId } : { items })
    });
    if (result.failed?.length) {
      const failure = result.failed[0];
      throw new Error(
        failure?.error_message || `Plaud 4.0 rejected the ${action} for this recording.`
      );
    }
  }

  return { listRecordings, resolveAudio, applyPostDownloadAction };
}
