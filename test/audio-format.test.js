import { describe, expect, it, vi } from 'vitest';
import {
  audioExtensionFromUrl,
  audioMimeType,
  detectAudioExtension,
  inspectAudioExtension,
  resolveAudioExtension
} from '../extension/lib/audio-format.js';
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

describe('audio format detection', () => {
  it.each([
    [m4a, 'm4a'],
    [mp3, 'mp3'],
    [opus, 'opus'],
    [Buffer.from('OggS\0\0\0\0'), 'ogg'],
    [Buffer.from('RIFF\0\0\0\0WAVE'), 'wav'],
    [Buffer.from('fLaC'), 'flac'],
    [Uint8Array.from([0xff, 0xf1, 0x50, 0x80]), 'aac'],
    [Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), 'webm']
  ])('recognizes an audio signature as %s / %s', (bytes, extension) => {
    expect(detectAudioExtension(bytes)).toBe(extension);
  });

  it('verifies the audio after an ID3 tag instead of trusting the tag', () => {
    const frames = [{ id: 'TLEN', value: '1000' }];
    expect(detectAudioExtension(writeId3Tag(mp3.buffer, frames))).toBe('mp3');
    expect(detectAudioExtension(writeId3Tag(m4a.buffer, frames))).toBe('m4a');
    expect(detectAudioExtension(Buffer.from('ID3\x03\0\0\0\0\0\0'))).toBeNull();
  });

  it('rejects malformed ID3 sizes, reserved MPEG headers and unknown data', () => {
    expect(detectAudioExtension(Uint8Array.from([73, 68, 51, 3, 0, 0, 128, 0, 0, 0]))).toBeNull();
    expect(detectAudioExtension(Uint8Array.from([0xff, 0xfb, 0xf0, 0]))).toBeNull();
    expect(detectAudioExtension(Buffer.from('<html>error</html>'))).toBeNull();
  });

  it('lets actual bytes override a misleading MP3 name and MIME type', () => {
    expect(
      resolveAudioExtension({
        bytes: m4a,
        contentType: 'audio/mpeg',
        url: 'https://example.com/audio.mp3',
        extension: 'mp3'
      })
    ).toBe('m4a');
    expect(
      resolveAudioExtension({ bytes: opus, url: 'https://example.com/audio.mp3', extension: 'mp3' })
    ).toBe('opus');
  });

  it('handles opaque signed URLs, MIME parameters and generic binary responses', () => {
    expect(
      resolveAudioExtension({
        contentType: 'audio/mp4; codecs=mp4a.40.2',
        url: 'https://example.com/audio?id=1'
      })
    ).toBe('m4a');
    expect(
      resolveAudioExtension({
        contentType: 'application/octet-stream',
        url: 'https://example.com/audio.M4A?signature=abc',
        extension: 'mp3'
      })
    ).toBe('m4a');
    expect(audioExtensionFromUrl('https://example.com/audio?name=fake.mp3')).toBeNull();
    expect(resolveAudioExtension({ url: 'https://example.com/audio', extension: 'exe' })).toBe(
      'bin'
    );
    expect(audioMimeType('bin')).toBe('application/octet-stream');
  });

  it('preserves compatible M4A and Opus extensions for generic containers', () => {
    const mp4 = Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 0, 0]);
    expect(resolveAudioExtension({ bytes: mp4, url: 'https://example.com/audio.m4a' })).toBe('m4a');
    expect(
      resolveAudioExtension({ contentType: 'audio/ogg', url: 'https://example.com/audio.opus' })
    ).toBe('opus');
  });
});

describe('bounded audio inspection', () => {
  it('times out a stalled inspection and keeps the known source format', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const inspection = inspectAudioExtension('https://example.com/audio.m4a', null, fetchImpl);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await inspection).toBe('m4a');
      expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests only a prefix and cancels a stream when the server ignores Range', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const chunk = new Uint8Array(8192);
              chunk.set(m4a);
              controller.enqueue(chunk);
            },
            cancel
          }),
          { headers: { 'Content-Type': 'audio/mpeg' } }
        )
    );
    expect(await inspectAudioExtension('https://example.com/audio.mp3', 'mp3', fetchImpl)).toBe(
      'm4a'
    );
    expect(fetchImpl.mock.calls[0][1].headers.Range).toBe('bytes=0-4095');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('detects signatures split across stream chunks', async () => {
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(m4a.slice(0, 6));
            controller.enqueue(m4a.slice(6));
            controller.close();
          }
        })
      );
    expect(await inspectAudioExtension('https://example.com/audio.mp3', null, fetchImpl)).toBe(
      'm4a'
    );
  });

  it('keeps known URL extensions when inspection fails, without inventing MP3', async () => {
    const failedFetch = async () => {
      throw new Error('unavailable');
    };
    expect(await inspectAudioExtension('https://example.com/audio.m4a', 'mp3', failedFetch)).toBe(
      'm4a'
    );
    expect(await inspectAudioExtension('https://example.com/audio', null, failedFetch)).toBe('bin');
    expect(
      await inspectAudioExtension(
        'https://example.com/audio.opus',
        null,
        async () => new Response(null, { status: 403 })
      )
    ).toBe('opus');
  });
});
