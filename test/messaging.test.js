import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sendMessageToActiveTab,
  toSafeFilename,
  toSafePath,
  toSafePathSegment
} from '../extension/lib/messaging.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('throws when there is no active tab', async () => {
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        sendMessage: vi.fn()
      }
    });

    await expect(sendMessageToActiveTab({ type: 'test' })).rejects.toMatchObject({
      code: 'plaud-dashboard-unavailable'
    });
  });

  it('throws when active tab URL is not supported', async () => {
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com' }]),
        sendMessage: vi.fn()
      }
    });

    await expect(sendMessageToActiveTab({ type: 'test' })).rejects.toMatchObject({
      code: 'plaud-dashboard-unavailable'
    });
  });
});
