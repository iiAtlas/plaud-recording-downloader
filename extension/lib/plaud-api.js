export function createPlaudApiClient({
  defaultBase,
  fetchImpl = fetch,
  urlCtor = URL,
  logger = console
} = {}) {
  let preferredBase = normalizeApiBase(defaultBase, urlCtor) || null;

  async function fetchPlaudApi(path, init, options = {}) {
    const allowRegionalRetry = options?.allowRegionalRetry !== false;
    const initialBase = normalizeApiBase(options?.apiBase || preferredBase || defaultBase, urlCtor);

    let response = await fetchImpl(buildPlaudApiUrl(path, initialBase, defaultBase, urlCtor), init);
    let payload = await safeJson(response);

    if (!allowRegionalRetry) {
      return { response, payload };
    }

    const regionalApiBase = extractRegionalApiBase(payload, urlCtor);
    if (shouldRetryWithRegionalApi(payload, initialBase, regionalApiBase, urlCtor)) {
      logger?.info?.('Retrying Plaud API request with region API', regionalApiBase, path);
      preferredBase = regionalApiBase;
      response = await fetchImpl(buildPlaudApiUrl(path, regionalApiBase, defaultBase, urlCtor), init);
      payload = await safeJson(response);
      return { response, payload };
    }

    if (initialBase) {
      preferredBase = initialBase;
    }

    return { response, payload };
  }

  return {
    fetchPlaudApi
  };
}

export function buildPlaudApiUrl(path, base, fallbackBase, urlCtor = URL) {
  const normalizedBase =
    normalizeApiBase(base || fallbackBase, urlCtor) || normalizeApiBase(fallbackBase, urlCtor) || fallbackBase;
  if (typeof path !== 'string' || !path) {
    return normalizedBase;
  }

  return `${normalizedBase}${path.startsWith('/') ? path : `/${path}`}`;
}

export function shouldRetryWithRegionalApi(payload, currentApiBase, regionalApiBase, urlCtor = URL) {
  if (!isRegionMismatchPayload(payload) || !regionalApiBase) {
    return false;
  }

  return normalizeApiBase(currentApiBase, urlCtor) !== normalizeApiBase(regionalApiBase, urlCtor);
}

export function isRegionMismatchPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  if (Number(payload.status) === -302) {
    return true;
  }

  const message = `${payload.msg || payload.message || ''}`.toLowerCase();
  return message.includes('region mismatch');
}

export function extractRegionalApiBase(payload, urlCtor = URL) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return normalizeApiBase(payload?.data?.domains?.api || payload?.domains?.api, urlCtor);
}

export function normalizeApiBase(candidate, urlCtor = URL) {
  if (typeof candidate !== 'string') {
    return null;
  }

  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new urlCtor(withProtocol);
    if (!url.hostname.endsWith('.plaud.ai')) {
      return null;
    }
    return `${url.protocol}//${url.host}`;
  } catch (error) {
    return null;
  }
}

async function safeJson(response) {
  try {
    return await response.clone().json();
  } catch (error) {
    return null;
  }
}
