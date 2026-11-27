/**
 * Small, dependency-free byte helpers.
 *
 * The Worker runtime has no Node Buffer, so every binary conversion in this
 * project is expressed with Uint8Array + TextEncoder/TextDecoder.
 */

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const latin1Decoder = new TextDecoder("latin1");

export function asciiBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x7f) throw new Error("asciiBytes received a non-ASCII character");
    out[i] = code;
  }
  return out;
}

export function asciiString(bytes: Uint8Array): string {
  return latin1Decoder.decode(bytes);
}

export function utf8String(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function utf8Bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function concatBytes(chunks: ArrayLike<Uint8Array>, totalLength?: number): Uint8Array {
  let total = totalLength;
  if (total === undefined) {
    total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  // Not security-critical, but constant-time comparison avoids silly early-exit
  // differences when comparing hashes.
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string must have an even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) throw new Error("invalid hex string");
    out[i] = byte;
  }
  return out;
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

export function u32Bytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

/**
 * SQLite BLOB values can come back as ArrayBuffer or as a typed-array view
 * depending on the runtime version. Normalize both to Uint8Array.
 */
export function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`expected binary value, got ${typeof value}`);
}

/**
 * Copy a view into an exact ArrayBuffer. DO SQLite's documented BLOB binding
 * type is ArrayBuffer; this avoids relying on typed-array view support.
 */
export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/**
 * Percent-encode arbitrary bytes for tracker query strings. The standard
 * `encodeURIComponent` cannot be used because info_hash/peer_id are raw binary.
 */
export function percentEncodeBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += "%" + bytes[i].toString(16).padStart(2, "0").toUpperCase();
  }
  return out;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
