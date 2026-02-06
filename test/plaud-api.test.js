import { describe, expect, it, vi } from 'vitest';
import {
  buildPlaudApiUrl,
  createPlaudApiClient,
  extractRegionalApiBase,
  isRegionMismatchPayload,
  normalizeApiBase,
  shouldRetryWithRegionalApi
} from '../extension/lib/plaud-api.js';

function makeResponse(payload, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    clone() {
      return {
        async json() {
          return payload;
        }
      };
    }
  };
}

describe('plaud-api helpers', () => {
  it('normalizes plaud api hosts', () => {
    expect(normalizeApiBase('api-apne1.plaud.ai')).toBe('https://api-apne1.plaud.ai');
    expect(normalizeApiBase('https://api.plaud.ai/')).toBe('https://api.plaud.ai');
    expect(normalizeApiBase('https://example.com')).toBeNull();
  });

  it('detects mismatch payload formats', () => {
    expect(isRegionMismatchPayload({ status: -302 })).toBe(true);
    expect(isRegionMismatchPayload({ msg: 'user region mismatch' })).toBe(true);
    expect(isRegionMismatchPayload({ message: 'ok' })).toBe(false);
  });

  it('extracts regional host from nested domains', () => {
    expect(
      extractRegionalApiBase({
        data: { domains: { api: 'https://api-apne1.plaud.ai' } }
      })
    ).toBe('https://api-apne1.plaud.ai');
  });

  it('builds endpoint urls with and without leading slash', () => {
    expect(buildPlaudApiUrl('/file/temp-url/1', 'https://api.plaud.ai', 'https://api.plaud.ai')).toBe(
      'https://api.plaud.ai/file/temp-url/1'
    );
    expect(buildPlaudApiUrl('file/temp-url/1', 'https://api.plaud.ai', 'https://api.plaud.ai')).toBe(
      'https://api.plaud.ai/file/temp-url/1'
    );
  });

  it('only retries when mismatch points to a different valid plaud host', () => {
    const payload = { status: -302, data: { domains: { api: 'https://api-apne1.plaud.ai' } } };
    expect(shouldRetryWithRegionalApi(payload, 'https://api.plaud.ai', 'https://api-apne1.plaud.ai')).toBe(
      true
    );
    expect(shouldRetryWithRegionalApi(payload, 'https://api-apne1.plaud.ai', 'https://api-apne1.plaud.ai')).toBe(
      false
    );
  });
});

describe('createPlaudApiClient', () => {
  it('returns payload without retry on normal success', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(makeResponse({ ok: true }));
    const client = createPlaudApiClient({
      defaultBase: 'https://api.plaud.ai',
      fetchImpl,
      logger: { info: vi.fn() }
    });

    const { payload } = await client.fetchPlaudApi('/file/simple/web', { method: 'GET' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.plaud.ai/file/simple/web');
    expect(payload).toEqual({ ok: true });
  });

  it('retries once on region mismatch using data.domains.api and persists preferred base', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          status: -302,
          msg: 'user region mismatch',
          data: { domains: { api: 'https://api-apne1.plaud.ai' } }
        })
      )
      .mockResolvedValueOnce(makeResponse({ data: { temp_url: 'https://cdn.example/audio.mp3' } }))
      .mockResolvedValueOnce(makeResponse({ ok: true }));
    const client = createPlaudApiClient({
      defaultBase: 'https://api.plaud.ai',
      fetchImpl,
      logger: { info: vi.fn() }
    });

    await client.fetchPlaudApi('/file/temp-url/abc', { method: 'GET' });
    await client.fetchPlaudApi('/file/simple/web', { method: 'GET' });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.plaud.ai/file/temp-url/abc');
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api-apne1.plaud.ai/file/temp-url/abc');
    expect(fetchImpl.mock.calls[2][0]).toBe('https://api-apne1.plaud.ai/file/simple/web');
  });

  it('does not retry when mismatch host is invalid', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse(
          {
            status: -302,
            msg: 'user region mismatch',
            data: { domains: { api: 'https://evil.example.com' } }
          },
          { status: 400, ok: false }
        )
      );
    const client = createPlaudApiClient({
      defaultBase: 'https://api.plaud.ai',
      fetchImpl,
      logger: { info: vi.fn() }
    });

    const { response } = await client.fetchPlaudApi('/file/temp-url/abc', { method: 'GET' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(400);
  });
});
