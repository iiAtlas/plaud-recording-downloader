/**
 * Minimal ID3v2.3 writer for browser use.
 * Supports plain text frames (T***), including TXXX user text frames.
 */

const ID3_HEADER_SIZE = 10;
const FRAME_HEADER_SIZE = 10;
const TEXT_ENCODING_UTF16 = 0x01;
const UTF16_BOM = [0xff, 0xfe];

/**
 * Remove any existing ID3 tag from the provided ArrayBuffer.
 * Returns a new ArrayBuffer without the tag bytes.
 */
export function stripId3(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < ID3_HEADER_SIZE) {
    return arrayBuffer;
  }

  const bytes = new Uint8Array(arrayBuffer);
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return arrayBuffer;
  }

  const tagSize =
    ID3_HEADER_SIZE +
    ((bytes[6] & 0x7f) << 21) +
    ((bytes[7] & 0x7f) << 14) +
    ((bytes[8] & 0x7f) << 7) +
    (bytes[9] & 0x7f);

  if (tagSize >= arrayBuffer.byteLength) {
    return arrayBuffer;
  }

  return arrayBuffer.slice(tagSize);
}

/**
 * Attach a fresh ID3 tag with the provided text frames.
 * Frame specs support regular text frames (id starts with T) and
 * TXXX user text frames { id: 'TXXX', description, value }.
 */
export function writeId3Tag(arrayBuffer, frameSpecs = []) {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new TypeError('Expected ArrayBuffer audio payload.');
  }

  const sanitizedAudio = stripId3(arrayBuffer);
  const frames = frameSpecs
    .map((spec) => buildFrame(spec))
    .filter((frame) => frame && frame.length > 0);

  if (!frames.length) {
    return sanitizedAudio;
  }

  const frameBytesTotal = frames.reduce((sum, frame) => sum + frame.length, 0);
  const tagSize = frameBytesTotal;

  const header = new Uint8Array(ID3_HEADER_SIZE);
  header.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00], 0); // ID3, v2.3.0, no flags

  const syncSafe = toSyncSafe(tagSize);
  header.set(syncSafe, 6);

  const audioBytes = new Uint8Array(sanitizedAudio);
  const output = new Uint8Array(ID3_HEADER_SIZE + frameBytesTotal + audioBytes.length);

  let offset = 0;
  output.set(header, offset);
  offset += header.length;

  frames.forEach((frame) => {
    output.set(frame, offset);
    offset += frame.length;
  });

  output.set(audioBytes, offset);

  return output.buffer;
}

function buildFrame(spec) {
  if (!spec || typeof spec !== 'object') {
    return null;
  }

  const id = typeof spec.id === 'string' ? spec.id.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{4}$/.test(id)) {
    return null;
  }

  if (id === 'TXXX') {
    const description = typeof spec.description === 'string' ? spec.description : '';
    const value =
      typeof spec.value === 'string' || typeof spec.value === 'number'
        ? String(spec.value)
        : '';
    return createUserTextFrame(description, value);
  }

  if (id.startsWith('T')) {
    const value =
      typeof spec.value === 'string' || typeof spec.value === 'number'
        ? String(spec.value)
        : '';
    return createTextFrame(id, value);
  }

  return null;
}

function createTextFrame(id, value) {
  const body = new Uint8Array(1 + utf16Length(value));
  body[0] = TEXT_ENCODING_UTF16;
  body.set(encodeUtf16(value), 1);
  return wrapFrame(id, body);
}

function createUserTextFrame(description, value) {
  const descriptionBytes = encodeUtf16(description);
  const valueBytes = encodeUtf16(value);
  const terminator = new Uint8Array([0x00, 0x00]);

  const bodyLength = 1 + descriptionBytes.length + terminator.length + valueBytes.length;
  const body = new Uint8Array(bodyLength);

  let offset = 0;
  body[offset] = TEXT_ENCODING_UTF16;
  offset += 1;

  body.set(descriptionBytes, offset);
  offset += descriptionBytes.length;

  body.set(terminator, offset);
  offset += terminator.length;

  body.set(valueBytes, offset);

  return wrapFrame('TXXX', body);
}

function wrapFrame(id, body) {
  const frame = new Uint8Array(FRAME_HEADER_SIZE + body.length);
  frame.set(encodeAscii(id), 0);

  const size = body.length;
  frame[4] = (size >>> 24) & 0xff;
  frame[5] = (size >>> 16) & 0xff;
  frame[6] = (size >>> 8) & 0xff;
  frame[7] = size & 0xff;
  frame[8] = 0x00;
  frame[9] = 0x00;
  frame.set(body, FRAME_HEADER_SIZE);

  return frame;
}

function encodeAscii(value) {
  const buffer = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    buffer[index] = value.charCodeAt(index) & 0xff;
  }
  return buffer;
}

function encodeUtf16(value) {
  const input = typeof value === 'string' ? value : '';
  const buffer = new Uint8Array(UTF16_BOM.length + input.length * 2);
  buffer.set(UTF16_BOM, 0);

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    const offset = UTF16_BOM.length + index * 2;
    buffer[offset] = code & 0xff;
    buffer[offset + 1] = (code >> 8) & 0xff;
  }

  return buffer;
}

function utf16Length(value) {
  return UTF16_BOM.length + (typeof value === 'string' ? value.length * 2 : 0);
}

function toSyncSafe(value) {
  const max = 0x0fffffff;
  const safeValue = Math.max(0, Math.min(max, value));
  return [
    (safeValue >> 21) & 0x7f,
    (safeValue >> 14) & 0x7f,
    (safeValue >> 7) & 0x7f,
    safeValue & 0x7f
  ];
}
