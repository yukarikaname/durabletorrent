/**
 * Minimal bencode (BEP 3) codec.
 *
 * Only the subset needed by .torrent files and HTTP tracker responses is
 * implemented: integers, byte strings, lists and dictionaries. Byte strings are
 * kept as Uint8Array because `pieces` and `info_hash` are binary.
 *
 * The decoder records the raw byte span of the top-level `info` value so the
 * caller can compute the info hash without re-encoding (re-encoding can change
 * the hash if the original torrent used non-canonical key ordering).
 */

export type BencodeDict = Map<string, BencodeValue>;
export type BencodeValue = number | Uint8Array | BencodeValue[] | BencodeDict;

export interface BencodeDecodeOptions {
  maxDepth?: number;
  maxValues?: number;
  /** Record the byte span of the top-level `info` dictionary. */
  captureInfoSpan?: boolean;
  /** Allow bytes after the first value (used for BEP 9 metadata messages). */
  allowTrailing?: boolean;
}

export interface BencodeDecodeResult {
  value: BencodeValue;
  infoSpan?: { start: number; end: number };
  consumed: number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_VALUES = 2_000_000;

class BencodeDecoder {
  private pos = 0;
  private values = 0;
  private readonly end: number;
  private readonly maxDepth: number;
  private readonly maxValues: number;
  private readonly captureInfoSpan: boolean;
  private readonly allowTrailing: boolean;
  private infoStart = -1;
  private infoEnd = -1;

  constructor(
    private readonly input: Uint8Array,
    options: BencodeDecodeOptions,
  ) {
    this.end = input.length;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxValues = options.maxValues ?? DEFAULT_MAX_VALUES;
    this.captureInfoSpan = options.captureInfoSpan ?? false;
    this.allowTrailing = options.allowTrailing ?? false;
  }

  decode(): BencodeDecodeResult {
    if (this.end === 0) throw new Error("empty bencode input");
    const value = this.parseValue(0);
    if (this.pos !== this.end && !this.allowTrailing) {
      throw new Error(`trailing bytes after bencode value at offset ${this.pos}`);
    }
    const result: BencodeDecodeResult = { value, consumed: this.pos };
    if (this.infoStart >= 0 && this.infoEnd > this.infoStart) {
      result.infoSpan = { start: this.infoStart, end: this.infoEnd };
    }
    return result;
  }

  private parseValue(depth: number): BencodeValue {
    if (depth > this.maxDepth) throw new Error("bencode nesting is too deep");
    if (this.pos >= this.end) throw new Error("unexpected end of bencode input");
    if (++this.values > this.maxValues) throw new Error("bencode value limit exceeded");

    const first = this.input[this.pos];
    switch (first) {
      case 0x69: // 'i'
        return this.parseInt();
      case 0x6c: // 'l'
        return this.parseList(depth);
      case 0x64: // 'd'
        return this.parseDict(depth);
      default:
        if (first >= 0x30 && first <= 0x39) return this.parseString();
        throw new Error(`invalid bencode token 0x${first.toString(16)} at offset ${this.pos}`);
    }
  }

  private parseInt(): number {
    this.pos++; // 'i'
    const start = this.pos;
    while (this.pos < this.end && this.input[this.pos] !== 0x65) this.pos++;
    if (this.pos >= this.end) throw new Error("unterminated bencode integer");
    const text = asciiFromBytes(this.input.subarray(start, this.pos));
    this.pos++; // 'e'

    if (!/^-?(0|[1-9][0-9]*)$/.test(text) || text === "-0") {
      throw new Error(`invalid bencode integer: ${text}`);
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new Error("bencode integer exceeds safe range");
    return value;
  }

  private parseString(): Uint8Array {
    const start = this.pos;
    while (this.pos < this.end && this.input[this.pos] !== 0x3a) {
      const byte = this.input[this.pos];
      if (byte < 0x30 || byte > 0x39) {
        throw new Error(`invalid bencode string length at offset ${this.pos}`);
      }
      this.pos++;
    }
    if (this.pos >= this.end) throw new Error("unterminated bencode string length");
    const lengthText = asciiFromBytes(this.input.subarray(start, this.pos));
    if (lengthText.length > 1 && lengthText.startsWith("0")) {
      throw new Error("bencode string length has a leading zero");
    }
    const length = Number(lengthText);
    this.pos++; // ':'
    if (!Number.isSafeInteger(length) || length < 0 || this.pos + length > this.end) {
      throw new Error("bencode string extends past the end of input");
    }
    const bytes = this.input.subarray(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }

  private parseList(depth: number): BencodeValue[] {
    this.pos++; // 'l'
    const out: BencodeValue[] = [];
    while (true) {
      if (this.pos >= this.end) throw new Error("unterminated bencode list");
      if (this.input[this.pos] === 0x65) {
        this.pos++; // 'e'
        return out;
      }
      out.push(this.parseValue(depth + 1));
    }
  }

  private parseDict(depth: number): BencodeDict {
    this.pos++; // 'd'
    const out: BencodeDict = new Map();
    while (true) {
      if (this.pos >= this.end) throw new Error("unterminated bencode dictionary");
      if (this.input[this.pos] === 0x65) {
        this.pos++; // 'e'
        return out;
      }
      if (this.input[this.pos] < 0x30 || this.input[this.pos] > 0x39) {
        throw new Error(`dictionary key must be a byte string at offset ${this.pos}`);
      }
      const key = decodeUtf8(this.parseString());
      if (out.has(key)) throw new Error(`duplicate bencode dictionary key: ${key}`);

      // The top-level `info` value is the identity of a torrent. Capture its
      // exact bytes before descending, so the hash is independent of our
      // encoder's key ordering.
      const isInfo = this.captureInfoSpan && depth === 0 && key === "info";
      if (isInfo) this.infoStart = this.pos;

      const value = this.parseValue(depth + 1);
      if (isInfo) this.infoEnd = this.pos;
      out.set(key, value);
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

function asciiFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

export function decodeBencode(
  input: Uint8Array,
  options: BencodeDecodeOptions = {},
): BencodeDecodeResult {
  return new BencodeDecoder(input, options).decode();
}

/** Convenience wrapper used by tests and tracker parsing. */
export function decodeBencodeValue(input: Uint8Array): BencodeValue {
  return decodeBencode(input).value;
}

export function encodeBencode(value: BencodeValue): Uint8Array {
  const chunks: Uint8Array[] = [];
  encodeInto(value, chunks);
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function encodeInto(value: BencodeValue, chunks: Uint8Array[]): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("bencode numbers must be safe integers");
    chunks.push(new TextEncoder().encode(`i${value}e`));
    return;
  }

  if (value instanceof Uint8Array) {
    chunks.push(new TextEncoder().encode(`${value.length}:`));
    chunks.push(value);
    return;
  }

  if (Array.isArray(value)) {
    chunks.push(new Uint8Array([0x6c])); // 'l'
    for (const item of value) encodeInto(item, chunks);
    chunks.push(new Uint8Array([0x65])); // 'e'
    return;
  }

  if (value instanceof Map) {
    chunks.push(new Uint8Array([0x64])); // 'd'
    const keys = [...value.keys()].sort((a, b) => {
      const ab = new TextEncoder().encode(a);
      const bb = new TextEncoder().encode(b);
      const len = Math.min(ab.length, bb.length);
      for (let i = 0; i < len; i++) {
        if (ab[i] !== bb[i]) return ab[i] - bb[i];
      }
      return ab.length - bb.length;
    });
    for (const key of keys) {
      const keyBytes = new TextEncoder().encode(key);
      chunks.push(new TextEncoder().encode(`${keyBytes.length}:`));
      chunks.push(keyBytes);
      encodeInto(value.get(key)!, chunks);
    }
    chunks.push(new Uint8Array([0x65])); // 'e'
    return;
  }

  throw new Error(`cannot bencode value of type ${typeof value}`);
}

export function bget(dict: BencodeDict, key: string): BencodeValue | undefined {
  return dict.get(key);
}

export function asDict(value: BencodeValue | undefined): BencodeDict | undefined {
  return value instanceof Map ? value : undefined;
}

export function asBytes(value: BencodeValue | undefined): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

export function asNumber(value: BencodeValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function asList(value: BencodeValue | undefined): BencodeValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asText(value: BencodeValue | undefined): string | undefined {
  const bytes = asBytes(value);
  return bytes ? decodeUtf8(bytes) : undefined;
}
