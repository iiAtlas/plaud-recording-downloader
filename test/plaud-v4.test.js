import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPES } from '../extension/lib/messaging.js';

const legacyId = '0123456789abcdef0123456789abcdef';
const migratedId = `of_${legacyId}`;
const audioUrl = 'https://plaud-bucket.s3.amazonaws.com/recording?X-Amz-Signature=audio';
const origin = 'https://web.plaud.ai';
const detail = {
  meta: { start_time: 1760000000000, duration: 1500 },
  node: {
    node_id: 'on_f_file',
    folder: { folder_id: 'on_w_wrapper' },
    display_folder: { folder_id: 'n_recordings' }
  },
  objects: [
    { object_type: 'TRANSCRIPT', content_url: 'https://example.com/transcript' },
    { object_type: 'AUDIO', content_url: audioUrl, mime_type: 'audio/ogg' }
  ]
};

const apiResponse = (data) => Response.json({ status: 0, data });

describe('Plaud 4.0 content script', () => {
  let onMessage;
  let fetchImpl;
  let document;

  beforeEach(async () => {
    vi.resetModules();
    onMessage = null;
    fetchImpl = vi.fn();
    let receiveAuth;
    const window = {
      URL,
      location: { origin, href: origin + '/', hostname: 'web.plaud.ai' },
      fetch: fetchImpl,
      addEventListener(_type, listener) {
        receiveAuth = listener;
      }
    };
    document = {
      cookie: '',
      querySelectorAll: vi.fn(() => []),
      createElement: () => ({ dataset: {}, addEventListener() {} }),
      documentElement: {
        appendChild() {
          queueMicrotask(() =>
            receiveAuth({
              source: window,
              origin,
              data: { source: 'plaud-recording-downloader-auth', token: 'test-token' }
            })
          );
        }
      }
    };
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path) => fileURLToPath(new URL(`../extension/${path}`, import.meta.url)),
        onMessage: {
          addListener(listener) {
            onMessage = listener;
          }
        }
      }
    });
    await import('../extension/content/content.js');
    await vi.waitFor(() => expect(onMessage).toBeTypeOf('function'));
  });

  afterEach(() => vi.unstubAllGlobals());

  function send(type, payload) {
    return new Promise((resolve) => onMessage({ type, payload }, {}, resolve));
  }

  it('follows the migration response and scans all cursor pages without using the old DOM', async () => {
    fetchImpl
      .mockResolvedValueOnce(
        Response.json({ status: -302, data: { domain: 'https://api-euc1.plaud.ai' } })
      )
      .mockResolvedValueOnce(Response.json({ status: -1800907 }))
      .mockResolvedValueOnce(
        apiResponse({
          items: [{ file_id: migratedId, name: 'Before migration' }],
          next_cursor: 'cursor/+1'
        })
      )
      .mockResolvedValueOnce(
        apiResponse({
          items: [{ file_id: 'f_new', name: 'New recording' }, { file_id: migratedId }]
        })
      );

    expect(await send(MESSAGE_TYPES.REQUEST_AUDIO_SCAN)).toMatchObject({
      ok: true,
      wholeLibrary: true,
      items: [
        { fileId: migratedId, filename: 'Before migration' },
        { fileId: 'f_new', filename: 'New recording' }
      ]
    });
    const requests = fetchImpl.mock.calls.map(([url]) => new URL(url));
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      '/file/simple/web',
      '/file/simple/web',
      '/file-app/v4/recordings/all',
      '/file-app/v4/recordings/all'
    ]);
    expect(requests[2].hostname).toBe('api-euc1.plaud.ai');
    expect(requests[3].searchParams.get('cursor')).toBe('cursor/+1');
    expect(document.querySelectorAll).not.toHaveBeenCalled();
  });

  it('uses the v4 cookie to scan an empty library without calling the legacy API', async () => {
    document.cookie = 'other=value; version_tag=v4';
    fetchImpl.mockResolvedValueOnce(apiResponse({ items: [] }));
    expect(await send(MESSAGE_TYPES.REQUEST_AUDIO_SCAN)).toMatchObject({
      ok: true,
      wholeLibrary: true,
      items: []
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toContain('/file-app/v4/recordings/all?');
  });

  it('resolves only AUDIO from v4 detail after a legacy download is rejected', async () => {
    fetchImpl
      .mockResolvedValueOnce(Response.json({ status: -1800907 }))
      .mockResolvedValueOnce(apiResponse(detail));
    expect(await send(MESSAGE_TYPES.RESOLVE_AUDIO_URL, { fileId: legacyId })).toMatchObject({
      ok: true,
      url: audioUrl,
      extension: 'ogg',
      metadata: { startTimeMs: 1760000000000, durationMs: 1500 }
    });
    expect(fetchImpl.mock.calls[1][0]).toBe(
      `https://api.plaud.ai/file-app/v4/files/detail/${migratedId}`
    );
  });

  it('continues using the legacy download route when it succeeds', async () => {
    fetchImpl.mockResolvedValueOnce(apiResponse({ temp_url: audioUrl }));
    expect(await send(MESSAGE_TYPES.RESOLVE_AUDIO_URL, { fileId: legacyId })).toEqual({
      ok: true,
      url: audioUrl
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ['move', 'POST', { target_node_id: 'n_destination' }],
    ['trash', 'DELETE', {}]
  ])(
    'uses the wrapper version and checks per-item errors for %s',
    async (action, method, target) => {
      fetchImpl
        .mockResolvedValueOnce(apiResponse(detail))
        .mockResolvedValueOnce(
          apiResponse({ flat_items: [{ node_id: 'on_w_wrapper', version_ms: 123 }] })
        )
        .mockResolvedValueOnce(
          apiResponse({ failed: [{ error_message: 'Node version conflict' }] })
        );

      expect(
        await send(MESSAGE_TYPES.POST_DOWNLOAD_ACTION, {
          fileId: migratedId,
          action,
          tagId: 'n_destination'
        })
      ).toEqual({ ok: false, message: 'Node version conflict' });
      const [url, init] = fetchImpl.mock.calls[2];
      expect(url).toBe(`https://api.plaud.ai/file-app/v4/nodes/${action}`);
      expect(init.method).toBe(method);
      expect(JSON.parse(init.body)).toEqual({
        ...target,
        items: [{ node_id: 'on_w_wrapper', origin_version: 123 }]
      });
    }
  );
});
