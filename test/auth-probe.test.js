import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const AUTH_PROBE_SOURCE = readFileSync(new URL('../extension/lib/auth-probe.js', import.meta.url), 'utf8');

function makeJwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value))
      .toString('base64url');

  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function makeStorage(entries) {
  const map = new Map(Object.entries(entries));

  return {
    get length() {
      return map.size;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    key(index) {
      return Array.from(map.keys())[index] || null;
    }
  };
}

function runAuthProbe({ localStorage = makeStorage({}), sessionStorage = makeStorage({}) } = {}) {
  const messages = [];
  const window = {
    localStorage,
    sessionStorage,
    location: { origin: 'https://web.plaud.ai' },
    atob(value) {
      return Buffer.from(value, 'base64').toString('utf8');
    },
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    }
  };
  const context = {
    window,
    document: {
      cookie: '',
      currentScript: {
        dataset: {
          messageSource: 'test-auth-source'
        }
      }
    }
  };

  vm.runInNewContext(AUTH_PROBE_SOURCE, context);
  return messages.at(-1)?.message || null;
}

describe('auth probe', () => {
  it('prefers the active Plaud workspace token over the user token', () => {
    const userToken = makeJwt({ sub: 'user-1' });
    const workspaceToken = makeJwt({ sub: 'workspace-1' });
    const message = runAuthProbe({
      localStorage: makeStorage({
        pld_tokenstr: JSON.stringify(userToken),
        'pld_user-1:currentWorkspaceId': JSON.stringify('workspace-id-1'),
        'pld_user-1:workspaceList': JSON.stringify([
          {
            workspaceId: 'workspace-id-1',
            workspaceToken: `Bearer ${workspaceToken}`,
            expiresAt: Date.now() + 60_000
          }
        ])
      })
    });

    expect(message).toEqual({
      source: 'test-auth-source',
      token: workspaceToken
    });
  });

  it('falls back to the Plaud user token when the workspace token is expired', () => {
    const userToken = makeJwt({ sub: 'user-1' });
    const workspaceToken = makeJwt({ sub: 'workspace-1' });
    const message = runAuthProbe({
      localStorage: makeStorage({
        pld_tokenstr: JSON.stringify(userToken),
        'pld_user-1:currentWorkspaceId': JSON.stringify('workspace-id-1'),
        'pld_user-1:workspaceList': JSON.stringify([
          {
            workspaceId: 'workspace-id-1',
            workspaceToken,
            expiresAt: Date.now() - 1
          }
        ])
      })
    });

    expect(message).toEqual({
      source: 'test-auth-source',
      token: userToken
    });
  });
});
