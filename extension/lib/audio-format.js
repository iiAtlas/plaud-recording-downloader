const MIME_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm'
};

export function normalizeAudioExtension(value) {
  if (typeof value !== 'string') return null;
  const extension = value.trim().replace(/^\./, '').toLowerCase();
  return Object.hasOwn(MIME_TYPES, extension) ? extension : null;
}

export function audioMimeType(extension) {
  return MIME_TYPES[extension] || 'application/octet-stream';
}

export function audioExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = /\.([a-z0-9]+)$/i.exec(pathname);
    return normalizeAudioExtension(match?.[1]);
  } catch (error) {
    return null;
  }
}

function extensionFromMimeType(value) {
  const mime = (value || '').split(';')[0].trim().toLowerCase();
  return (
    {
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a',
      'video/mp4': 'mp4',
      'audio/aac': 'aac',
      'audio/aacp': 'aac',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/wave': 'wav',
      'audio/ogg': 'ogg',
      'application/ogg': 'ogg',
      'audio/opus': 'opus',
      'audio/flac': 'flac',
      'audio/x-flac': 'flac',
      'audio/webm': 'webm',
      'video/webm': 'webm'
    }[mime] || null
  );
}

function matches(bytes, offset, text) {
  return [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

// A filename or an ID3 tag alone does not prove that the payload is MP3 audio.
export function detectAudioExtension(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let offset = 0;
  if (bytes.length >= 10 && matches(bytes, 0, 'ID3')) {
    if (bytes.slice(6, 10).some((byte) => byte & 0x80)) return null;
    const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    offset = 10 + size;
    // ID3v2.4 can also contain a ten-byte footer.
    if (bytes[3] === 4 && bytes[5] & 0x10) offset += 10;
  }

  if (bytes.length < offset + 4) return null;
  if (matches(bytes, offset + 4, 'ftyp')) {
    return matches(bytes, offset + 8, 'M4A ') || matches(bytes, offset + 8, 'M4B ') ? 'm4a' : 'mp4';
  }
  if (matches(bytes, offset, 'RIFF') && matches(bytes, offset + 8, 'WAVE')) return 'wav';
  if (matches(bytes, offset, 'fLaC')) return 'flac';
  if (matches(bytes, offset, 'OggS')) {
    for (let index = offset + 4; index <= Math.min(bytes.length - 8, offset + 512); index += 1) {
      if (matches(bytes, index, 'OpusHead')) return 'opus';
    }
    return 'ogg';
  }
  if (
    bytes[offset] === 0x1a &&
    bytes[offset + 1] === 0x45 &&
    bytes[offset + 2] === 0xdf &&
    bytes[offset + 3] === 0xa3
  ) {
    return 'webm';
  }
  if (bytes[offset] === 0xff) {
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    // ADTS AAC has a twelve-bit sync word and layer bits set to zero.
    if ((second & 0xf6) === 0xf0 && ((third >> 2) & 0x0f) < 13) return 'aac';
    const version = (second >> 3) & 3;
    const layer = (second >> 1) & 3;
    const bitrate = third >> 4;
    const sampleRate = (third >> 2) & 3;
    if (
      (second & 0xe0) === 0xe0 &&
      version !== 1 &&
      layer === 1 &&
      bitrate > 0 &&
      bitrate < 15 &&
      sampleRate !== 3
    ) {
      return 'mp3';
    }
  }
  return null;
}

export function resolveAudioExtension({ bytes, contentType, url, extension } = {}) {
  const detected = bytes ? detectAudioExtension(bytes) : null;
  const fromUrl = audioExtensionFromUrl(url);
  const fromMime = extensionFromMimeType(contentType);
  // MP4 and Ogg are containers; preserve a compatible, more specific audio extension.
  if (detected === 'mp4' && (fromUrl === 'm4a' || fromMime === 'm4a')) return 'm4a';
  if (detected === 'ogg' && (fromUrl === 'opus' || fromMime === 'opus')) return 'opus';
  if (detected) return detected;
  if (fromMime === 'mp4' && fromUrl === 'm4a') return 'm4a';
  if (fromMime === 'ogg' && fromUrl === 'opus') return 'opus';
  return fromMime || fromUrl || normalizeAudioExtension(extension) || 'bin';
}

// Inspect only a prefix, even when a server ignores Range and sends the full recording.
export async function inspectAudioExtension(url, extension, fetchImpl = fetch) {
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let reader;
  let contentType;
  try {
    const response = await fetchImpl(url, {
      headers: { Range: 'bytes=0-4095' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Audio inspection rejected with status ${response.status}.`);
    contentType = response.headers.get('content-type');
    const bytes = new Uint8Array(4096);
    let length = 0;
    if (response.body) {
      reader = response.body.getReader();
      while (length < bytes.length) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value.subarray(0, bytes.length - length);
        bytes.set(chunk, length);
        length += chunk.length;
      }
    }
    return resolveAudioExtension({ bytes: bytes.subarray(0, length), contentType, url, extension });
  } catch (error) {
    // Downloading can still work when a server disallows the inspection request.
    return resolveAudioExtension({ contentType, url, extension });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
  }
}
