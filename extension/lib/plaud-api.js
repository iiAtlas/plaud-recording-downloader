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

export function extractPlaudDownloadUrl(payload, urlCtor = URL) {
  const candidates = collectUrlStringCandidates(payload, urlCtor);
  const ranked = candidates
    .map((candidate, index) => ({
      ...candidate,
      index,
      score: scoreDownloadUrlCandidate(candidate, urlCtor)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return ranked[0]?.value || null;
}

export function summarizePlaudPayloadForDebug(payload) {
  if (!payload || typeof payload !== 'object') {
    return { payloadType: typeof payload };
  }

  const data = payload.data;
  const urlLikeValues = collectUrlStringCandidates(payload).map((candidate) => ({
    path: candidate.path,
    value: redactUrlForDebug(candidate.value)
  }));

  return {
    status: payload.status,
    message: payload.message || payload.msg || null,
    topLevelKeys: Object.keys(payload).slice(0, 20),
    dataType: Array.isArray(data) ? 'array' : typeof data,
    dataKeys: data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 20) : [],
    urlLikeValues
  };
}

async function safeJson(response) {
  try {
    return await response.clone().json();
  } catch (error) {
    return null;
  }
}

function collectUrlStringCandidates(value, urlCtor = URL, path = '$', seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') {
    return buildStringUrlCandidates(value, path, urlCtor);
  }

  if (!value || typeof value !== 'object' || depth > 8) {
    return [];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectUrlStringCandidates(item, urlCtor, `${path}[${index}]`, seen, depth + 1)
    );
  }

  return Object.entries(value).flatMap(([key, child]) =>
    collectUrlStringCandidates(child, urlCtor, `${path}.${key}`, seen, depth + 1)
  );
}

function buildStringUrlCandidates(value, path, urlCtor) {
  const key = getPathKey(path);
  const candidates = [];
  const seenValues = new Set();

  for (const candidate of expandStringUrlCandidates(value)) {
    const normalized = normalizeUrlCandidate(candidate, urlCtor);
    if (!normalized || seenValues.has(normalized)) {
      continue;
    }

    seenValues.add(normalized);
    candidates.push({ path, key, value: normalized });
  }

  return candidates;
}

function expandStringUrlCandidates(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const candidates = [trimmed, stripWrappingQuotes(trimmed)];

  try {
    const decoded = decodeURIComponent(trimmed);
    candidates.push(decoded, stripWrappingQuotes(decoded));
  } catch (error) {
    // Keep the original string when it is not URI encoded.
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      candidates.push(parsed.trim());
    }
  } catch (error) {
    // Non-JSON strings are normal for API payload leaves.
  }

  return candidates.filter(Boolean);
}

function stripWrappingQuotes(value) {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

function normalizeUrlCandidate(value, urlCtor) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('//')) {
    try {
      return new urlCtor(`https:${trimmed}`).toString();
    } catch (error) {
      return null;
    }
  }

  return null;
}

function scoreDownloadUrlCandidate(candidate, urlCtor) {
  let url;
  try {
    url = new urlCtor(candidate.value);
  } catch (error) {
    return 0;
  }

  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  const query = url.search.toLowerCase();
  const path = candidate.path.toLowerCase();
  const key = candidate.key.toLowerCase();
  let score = 0;

  if (isKnownDownloadUrlKey(key)) {
    score += 50;
  }

  if (hostname.endsWith('.amazonaws.com')) {
    score += 35;
  }

  if (hostname.includes('plaud-bucket') || pathname.includes('/audiofiles/')) {
    score += 35;
  }

  if (query.includes('x-amz-signature=') || query.includes('x-amz-credential=')) {
    score += 45;
  }

  if (/\.(mp3|m4a|mp4|wav|aac|opus|ogg|flac)(?:$|[?#])/i.test(candidate.value)) {
    score += 35;
  }

  if (path.includes('download') || path.includes('audio') || path.includes('temp_url')) {
    score += 20;
  }

  if (hostname.endsWith('.plaud.ai') && !pathname.includes('download') && !pathname.includes('audio')) {
    score -= 60;
  }

  return score;
}

function isKnownDownloadUrlKey(key) {
  return [
    'temp_url',
    'tempurl',
    'temp_url_opus',
    'url',
    'downloadurl',
    'download_url',
    'audio_url',
    'audiourl',
    'file_url',
    'fileurl',
    'source_url',
    'sourceurl'
  ].includes(key);
}

function getPathKey(path) {
  const match = /\.([^.[]+)(?:\[\d+\])?$/.exec(path);
  return match?.[1] || path;
}

function redactUrlForDebug(value) {
  try {
    const url = new URL(value);
    url.search = url.search ? '?[redacted]' : '';
    url.hash = url.hash ? '#[redacted]' : '';
    return url.toString();
  } catch (error) {
    return '[unparseable-url]';
  }
}
