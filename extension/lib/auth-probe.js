(() => {
  const DEFAULT_SOURCE = 'plaud-recording-downloader-auth';

  try {
    const currentScript = document.currentScript;
    const messageSource =
      (currentScript && currentScript.dataset && currentScript.dataset.messageSource) ||
      DEFAULT_SOURCE;
    const targetOrigin = window.location.origin;
    const JWT_REGEX = /eyJ[A-Za-z0-9_\-=]{5,}\.[A-Za-z0-9_\-=]+\.[A-Za-z0-9_\-=]+/;

    const extractJwt = (value) => {
      if (typeof value !== 'string') {
        return null;
      }

      const cleaned = value.replace(/^"|"$/g, '').trim();
      if (!cleaned) {
        return null;
      }

      const bearerSplit = cleaned.match(/Bearer\s+(.+)/i);
      if (bearerSplit && bearerSplit[1]) {
        const bearerToken = bearerSplit[1].trim();
        if (JWT_REGEX.test(bearerToken)) {
          return bearerToken;
        }
      }

      const match = cleaned.match(JWT_REGEX);
      return match ? match[0] : null;
    };

    const parseJsonValue = (value) => {
      if (value == null) {
        return null;
      }

      try {
        return JSON.parse(value);
      } catch (error) {
        return value;
      }
    };

    const extractJwtSubject = (value) => {
      const jwt = extractJwt(value);
      if (!jwt) {
        return null;
      }

      try {
        const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const parsed = JSON.parse(window.atob(payload));
        return parsed?.sub || null;
      } catch (error) {
        return null;
      }
    };

    const getActiveWorkspaceToken = (storage) => {
      if (!storage) {
        return null;
      }

      const now = Date.now();
      const userIds = [];
      const tokenSubject = extractJwtSubject(parseJsonValue(storage.getItem('pld_tokenstr')));
      if (tokenSubject) {
        userIds.push(tokenSubject);
      }

      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const match = /^pld_(.+):currentWorkspaceId$/.exec(key || '');
        if (match?.[1] && !userIds.includes(match[1])) {
          userIds.push(match[1]);
        }
      }

      for (const userId of userIds) {
        const workspaceId = parseJsonValue(storage.getItem(`pld_${userId}:currentWorkspaceId`));
        const workspaceList = parseJsonValue(storage.getItem(`pld_${userId}:workspaceList`));
        if (!workspaceId || !Array.isArray(workspaceList)) {
          continue;
        }

        const workspace = workspaceList.find((item) => item?.workspaceId === workspaceId);
        if (!workspace?.workspaceToken) {
          continue;
        }

        if (workspace.expiresAt && Number(workspace.expiresAt) <= now) {
          continue;
        }

        const workspaceToken = extractJwt(workspace.workspaceToken);
        if (workspaceToken) {
          return workspaceToken;
        }
      }

      return null;
    };

    const searchValue = (candidate, depth = 0) => {
      if (!candidate || depth > 8) {
        return null;
      }

      if (typeof candidate === 'string') {
        const extracted = extractJwt(candidate);
        if (extracted) {
          return extracted;
        }

        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object') {
            return searchValue(parsed, depth + 1);
          }
        } catch (error) {
          const fallback = searchValue(candidate, depth + 1);
          if (fallback) {
            return fallback;
          }
        }

        return null;
      }

      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          const nested = searchValue(item, depth + 1);
          if (nested) {
            return nested;
          }
        }
        return null;
      }

      if (typeof candidate === 'object') {
        for (const key of Object.keys(candidate)) {
          const nested = searchValue(candidate[key], depth + 1);
          if (nested) {
            return nested;
          }
        }
      }

      return null;
    };

    const storages = [window.localStorage, window.sessionStorage];
    let token = null;

    for (const storage of storages) {
      token = getActiveWorkspaceToken(storage);
      if (token) {
        break;
      }
    }

    // Priority keys: Check known Plaud token storage keys first to avoid
    // picking up unrelated JWTs (e.g., frillSsoToken for feedback widget)
    const priorityKeys = ['pld_tokenstr', 'tokenstr', 'token', 'access_token', 'plaud_token', 'auth_token'];

    if (!token) {
      for (const storage of storages) {
        if (!storage) {
          continue;
        }

        // First pass: check priority keys in order
        for (const key of priorityKeys) {
          const rawValue = storage.getItem(key);
          if (rawValue) {
            const extracted = extractJwt(rawValue);
            if (extracted) {
              token = extracted;
              break;
            }
          }
        }

        if (token) {
          break;
        }
      }
    }

    // Fallback: scan all keys if priority keys didn't yield a token
    if (!token) {
      for (const storage of storages) {
        if (!storage) {
          continue;
        }

        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          const rawValue = storage.getItem(key);

          if (!rawValue) {
            continue;
          }

          const directToken = extractJwt(rawValue);
          if (directToken) {
            token = directToken;
            break;
          }

          try {
            const parsed = JSON.parse(rawValue);
            const nested = searchValue(parsed);
            if (nested) {
              token = nested;
              break;
            }
          } catch (error) {
            const fallback = searchValue(rawValue);
            if (fallback) {
              token = fallback;
              break;
            }
          }
        }

        if (token) {
          break;
        }
      }
    }

    if (!token && typeof window.__NUXT__ === 'object') {
      token = searchValue(window.__NUXT__);
    }

    if (!token) {
      const cookieMatch = document.cookie.match(/(?:^|; )(?:(?:token|access_token|jwt)=)([^;]+)/i);
      if (cookieMatch && cookieMatch[1]) {
        const extracted = extractJwt(decodeURIComponent(cookieMatch[1]));
        if (extracted) {
          token = extracted;
        }
      }
    }

    window.postMessage({ source: messageSource, token: token || null }, targetOrigin);
  } catch (error) {
    try {
      window.postMessage({ source: DEFAULT_SOURCE, token: null }, window.location.origin);
    } catch (innerError) {
      // Swallow
    }
  }
})();
