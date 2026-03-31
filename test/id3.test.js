import { describe, expect, it } from 'vitest';
import { stripId3, writeId3Tag } from '../extension/lib/id3.js';

function toArrayBuffer(bytes) {
  return new Uint8Array(bytes).buffer;
}

function fromArrayBuffer(buffer) {
  return Array.from(new Uint8Array(buffer));
}

describe('id3 helpers', () => {
  it('stripId3 returns original buffer when no tag exists', () => {
    const source = toArrayBuffer([0x01, 0x02, 0x03, 0x04]);
    const stripped = stripId3(source);
    expect(fromArrayBuffer(stripped)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('stripId3 removes bytes for an ID3v2 tag', () => {
    // Header declares 4 bytes of tag body.
    const withTag = toArrayBuffer([
      0x49,
      0x44,
      0x33,
      0x03,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x04,
      0xaa,
      0xbb,
      0xcc,
      0xdd,
      0x11,
      0x22
    ]);
    const stripped = stripId3(withTag);
    expect(fromArrayBuffer(stripped)).toEqual([0x11, 0x22]);
  });

  it('writeId3Tag throws for non-ArrayBuffer input', () => {
    expect(() => writeId3Tag('not-a-buffer', [])).toThrow(TypeError);
  });

  it('writeId3Tag returns stripped audio when no valid frames are provided', () => {
    const withTag = toArrayBuffer([
      0x49,
      0x44,
      0x33,
      0x03,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0xff,
      0x33,
      0x44
    ]);
    const output = writeId3Tag(withTag, [{ id: 'COMM', value: 'ignored' }]);
    expect(fromArrayBuffer(output)).toEqual([0x33, 0x44]);
  });

  it('writeId3Tag writes a basic text frame', () => {
    const audio = toArrayBuffer([0x10, 0x20, 0x30]);
    const output = new Uint8Array(writeId3Tag(audio, [{ id: 'TIT2', value: 'Hello' }]));

    expect(String.fromCharCode(output[0], output[1], output[2])).toBe('ID3');
    expect(String.fromCharCode(output[10], output[11], output[12], output[13])).toBe('TIT2');
    expect(Array.from(output.slice(-3))).toEqual([0x10, 0x20, 0x30]);
  });

  it('writeId3Tag writes TXXX user text frames', () => {
    const audio = toArrayBuffer([0x77]);
    const output = new Uint8Array(
      writeId3Tag(audio, [{ id: 'TXXX', description: 'plaud.file_id', value: 'abc123' }])
    );

    expect(String.fromCharCode(output[0], output[1], output[2])).toBe('ID3');
    expect(String.fromCharCode(output[10], output[11], output[12], output[13])).toBe('TXXX');
    expect(output[14]).toBe(0x00);
    expect(Array.from(output.slice(-1))).toEqual([0x77]);
  });

  it('writeId3Tag embeds all Plaud metadata frame types', () => {
    const audio = toArrayBuffer([0xff, 0xfb]);
    const frames = [
      { id: 'TDRC', value: '2025-10-11T11:25:11' },
      { id: 'TXXX', description: 'Plaud-Recorded-Local', value: '2025-10-11T11:25:11-04:00' },
      { id: 'TXXX', description: 'Plaud-Start-Time-UTC', value: '2025-10-11T15:25:11.000Z' },
      { id: 'TXXX', description: 'Plaud-End-Time-UTC', value: '2025-10-11T15:25:36.000Z' },
      { id: 'TLEN', value: '25000' },
      { id: 'TXXX', description: 'Plaud-Timezone-Offset', value: '-04:00' },
      { id: 'TXXX', description: 'Plaud-Timezone-Hours', value: '-4' },
      { id: 'TXXX', description: 'Plaud-Timezone-Minutes', value: '0' }
    ];

    const output = new Uint8Array(writeId3Tag(audio, frames));

    expect(String.fromCharCode(output[0], output[1], output[2])).toBe('ID3');

    const tagStr = new TextDecoder('latin1').decode(output);
    expect(tagStr).toContain('TDRC');
    expect(tagStr).toContain('TLEN');

    // Count TXXX frame headers by scanning for the 4-byte ASCII sequence
    // at 10-byte frame header boundaries (avoid false positives in UTF-16 body)
    let txxxCount = 0;
    for (let i = 10; i < output.length - 13; i++) {
      if (output[i] === 0x54 && output[i + 1] === 0x58 && output[i + 2] === 0x58 && output[i + 3] === 0x58) {
        const frameSize = (output[i + 4] << 24) | (output[i + 5] << 16) | (output[i + 6] << 8) | output[i + 7];
        if (frameSize > 0 && frameSize < 1000) {
          txxxCount++;
          i += 9 + frameSize;
        }
      }
    }
    expect(txxxCount).toBe(6);

    expect(Array.from(output.slice(-2))).toEqual([0xff, 0xfb]);
  });

  it('writeId3Tag replaces existing tags before writing Plaud metadata', () => {
    // Audio with an existing ID3v2 tag (4 bytes of tag body)
    const existingTag = toArrayBuffer([
      0x49, 0x44, 0x33, 0x03, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x04,
      0xaa, 0xbb, 0xcc, 0xdd,
      0xff, 0xfb
    ]);

    const frames = [
      { id: 'TDRC', value: '2025-01-01T00:00:00' },
      { id: 'TXXX', description: 'Plaud-Start-Time-UTC', value: '2025-01-01T00:00:00.000Z' }
    ];

    const output = new Uint8Array(writeId3Tag(existingTag, frames));

    expect(String.fromCharCode(output[0], output[1], output[2])).toBe('ID3');
    expect(Array.from(output.slice(-2))).toEqual([0xff, 0xfb]);

    // Old tag body bytes should not appear in output
    const bytes = Array.from(output);
    const hasFourByteSequence = bytes.some(
      (_, i) => bytes[i] === 0xaa && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xcc && bytes[i + 3] === 0xdd
    );
    expect(hasFourByteSequence).toBe(false);
  });
});
