import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TYPES } from '../extension/lib/messaging.js';
import { writeId3Tag } from '../extension/lib/id3.js';

const m4a = Uint8Array.from([
  0,
  0,
  0,
  24,
  ...Buffer.from('ftypM4A '),
  0,
  0,
  0,
  0,
  ...Buffer.from('M4A mp42')
]);
const mp3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
const opus = Uint8Array.from([
  ...Buffer.from('OggS'),
  ...new Uint8Array(24),
  ...Buffer.from('OpusHead')
]);

describe('background download format handling', () => {
  let onMessage;
  let download;
  let createObjectURL;

  beforeEach(async () => {
    vi.resetModules();
    download = vi.fn((_options, callback) => callback(42));
    createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: {
          addListener(listener) {
            onMessage = listener;
          }
        }
      },
      downloads: { onChanged: { addListener() {} }, download }
    });
    await import('../extension/background/service.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function queue(item) {
    return new Promise((resolve) =>
      onMessage({ type: MESSAGE_TYPES.DOWNLOAD_SINGLE, payload: item }, {}, resolve)
    );
  }

  it.each([
    [m4a, 'm4a'],
    [opus, 'opus']
  ])(
    'names non-MP3 audio correctly and leaves its bytes untouched (%s / %s)',
    async (bytes, extension) => {
      const fetchImpl = vi.fn(
        async () => new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg' } })
      );
      vi.stubGlobal('fetch', fetchImpl);
      expect(
        await queue({
          url: 'https://example.com/audio.mp3',
          filename: 'recording',
          extension: 'mp3',
          includeMetadata: true,
          metadata: { durationMs: 1000 }
        })
      ).toEqual({ ok: true, downloadIds: [42] });
      expect(download.mock.calls[0][0]).toMatchObject({
        url: 'https://example.com/audio.mp3',
        filename: `recording.${extension}`
      });
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  );

  it('still embeds metadata in verified MP3 audio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(mp3, { headers: { 'Content-Type': 'application/octet-stream' } })
      )
    );
    await queue({
      url: 'https://example.com/audio',
      filename: 'recording',
      includeMetadata: true,
      metadata: { durationMs: 1000 }
    });
    expect(download.mock.calls[0][0]).toMatchObject({
      url: 'blob:test',
      filename: 'recording.mp3'
    });
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('audio/mpeg');
    const bytes = Buffer.from(await blob.arrayBuffer());
    expect(bytes.subarray(0, 3).toString()).toBe('ID3');
    expect(bytes.subarray(-mp3.length)).toEqual(Buffer.from(mp3));
  });

  it('supports the data URL fallback used by Chrome service workers', async () => {
    createObjectURL.mockRestore();
    // Service workers have URL but do not expose createObjectURL.
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = undefined;
      }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(mp3))
    );
    await queue({
      url: 'https://example.com/audio',
      filename: 'recording',
      includeMetadata: true,
      metadata: { durationMs: 1000 }
    });
    const options = download.mock.calls[0][0];
    expect(options.filename).toBe('recording.mp3');
    expect(options.url).toMatch(/^data:audio\/mpeg;base64,/);
    expect(Buffer.from(options.url.split(',')[1], 'base64').subarray(0, 3).toString()).toBe('ID3');
  });

  it('rechecks the full payload before tagging if the inspection MIME claimed MP3', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { headers: { 'Content-Type': 'audio/mpeg' } }))
        .mockResolvedValueOnce(new Response(m4a, { headers: { 'Content-Type': 'audio/mpeg' } }))
    );
    await queue({
      url: 'https://example.com/audio.mp3',
      filename: 'recording',
      extension: 'mp3',
      includeMetadata: true,
      metadata: { durationMs: 1000 }
    });
    expect(download.mock.calls[0][0]).toMatchObject({
      url: 'https://example.com/audio.mp3',
      filename: 'recording.m4a'
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not treat an ID3 tag on M4A data as proof of MP3 audio', async () => {
    const incorrectlyTagged = writeId3Tag(m4a.buffer, [{ id: 'TLEN', value: '1000' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(incorrectlyTagged))
    );
    await queue({
      url: 'https://example.com/audio.mp3',
      filename: 'recording',
      includeMetadata: true,
      metadata: { durationMs: 1000 }
    });
    expect(download.mock.calls[0][0].filename).toBe('recording.m4a');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('uses the URL extension when probing is unavailable and uses bin when no format is known', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unavailable')));
    await queue({
      url: 'https://example.com/audio.m4a?signature=abc',
      filename: 'recording',
      extension: 'mp3',
      subdirectory: 'plaud'
    });
    await queue({ url: 'https://example.com/audio', filename: 'unknown' });
    expect(download.mock.calls[0][0].filename).toBe('plaud/recording.m4a');
    expect(download.mock.calls[1][0].filename).toBe('unknown.bin');
  });
});
