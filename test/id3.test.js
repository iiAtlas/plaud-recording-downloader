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
});
