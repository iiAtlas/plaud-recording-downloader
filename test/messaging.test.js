import { describe, expect, it } from 'vitest';
import { toSafeFilename, toSafePath, toSafePathSegment } from '../extension/lib/messaging.js';

describe('messaging filename/path sanitizers', () => {
  it('normalizes filenames and collapses whitespace', () => {
    expect(toSafeFilename('  My: bad/file*name?.mp3  ')).toBe('My_bad_file_name_mp3');
    expect(toSafeFilename('')).toBe('audio');
    expect(toSafeFilename('   ', 'fallback_name')).toBe('fallback_name');
  });

  it('normalizes path segments', () => {
    expect(toSafePathSegment('  Folder Name  ')).toBe('Folder-Name');
    expect(toSafePathSegment('a:b*c?d')).toBe('a-b-c-d');
    expect(toSafePathSegment(null)).toBe('');
  });

  it('normalizes full paths across slash styles', () => {
    expect(toSafePath('  folder one\\sub/final name  ')).toBe('folder-one/sub/final-name');
    expect(toSafePath('///bad***//path??//')).toBe('bad/path');
    expect(toSafePath(null)).toBe('');
  });
});
