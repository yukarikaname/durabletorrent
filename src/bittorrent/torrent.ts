import { asBytes, asDict, asList, asNumber, asText, decodeBencode, type BencodeDict } from "./bencode";
import { utf8String, toHex } from "../lib/bytes";
import { LIMITS } from "../lib/limits";
import { sha1Bytes } from "../lib/hash";

export interface TorrentFile {
  index: number;
  /** Path relative to the torrent root. */
  path: string;
  /** Byte offset in the concatenated torrent payload. */
  offset: number;
  length: number;
  /** BEP 47 padding file: content is not user data. */
  padding: boolean;
}

export interface TorrentMeta {
  raw: Uint8Array;
  infoHash: Uint8Array;
  infoHashHex: string;
  name: string;
  pieceLength: number;
  /** Concatenated 20-byte SHA-1 hashes, one per piece. */
  pieces: Uint8Array;
  pieceCount: number;
  totalLength: number;
  files: TorrentFile[];
  trackers: string[];
  isPrivate: boolean;
  comment?: string;
  createdBy?: string;
}

/**
 * Parse a .torrent file. Throws on malformed or unsupported input.
 *
 * `info_hash` is SHA-1 over the raw bytes of the top-level `info` dictionary,
 * which is why the bencode decoder captures the raw span instead of us
 * re-encoding the dictionary.
 */
export async function parseTorrent(raw: Uint8Array): Promise<TorrentMeta> {
  if (raw.length > LIMITS.maxTorrentBytes) {
    throw new Error(`torrent is larger than ${LIMITS.maxTorrentBytes} bytes`);
  }

  const decoded = decodeBencode(raw, { captureInfoSpan: true });
  const root = asDict(decoded.value);
  if (!root) throw new Error("torrent root must be a dictionary");

  const info = asDict(root.get("info"));
  if (!info) throw new Error("torrent is missing the info dictionary");
  if (!decoded.infoSpan) throw new Error("could not locate the raw info dictionary");

  const infoHash = await sha1Bytes(raw.subarray(decoded.infoSpan.start, decoded.infoSpan.end));
  if (infoHash.length !== 20) throw new Error("unexpected info hash length");

  const pieceLength = asNumber(info.get("piece length"));
  if (!pieceLength || !Number.isInteger(pieceLength) || pieceLength <= 0) {
    throw new Error("invalid info.piece length");
  }
  if (pieceLength > LIMITS.maxPieceLength) {
    throw new Error(
      `piece length ${pieceLength} exceeds the PoC limit of ${LIMITS.maxPieceLength} bytes`,
    );
  }

  const pieces = asBytes(info.get("pieces"));
  if (!pieces || pieces.length === 0 || pieces.length % 20 !== 0) {
    throw new Error("info.pieces must be a non-empty multiple of 20 bytes");
  }
  const pieceCount = pieces.length / 20;
  if (pieceCount > LIMITS.maxPieces) {
    throw new Error(`torrent has ${pieceCount} pieces, limit is ${LIMITS.maxPieces}`);
  }

  const name = sanitizeName(asText(info.get("name.utf-8")) ?? asText(info.get("name")) ?? "unnamed");
  const files = parseFiles(info, name);
  const totalLength = files.reduce((sum, file) => sum + file.length, 0);
  if (totalLength <= 0) throw new Error("torrent contains no payload bytes");

  const expectedPieces = Math.ceil(totalLength / pieceLength);
  if (expectedPieces !== pieceCount) {
    throw new Error(
      `piece count mismatch: metadata says ${pieceCount}, total length ${totalLength} requires ${expectedPieces}`,
    );
  }

  return {
    raw,
    infoHash,
    infoHashHex: toHex(infoHash),
    name,
    pieceLength,
    pieces,
    pieceCount,
    totalLength,
    files,
    trackers: parseTrackers(root),
    isPrivate: asNumber(info.get("private")) === 1,
    comment: asText(root.get("comment")),
    createdBy: asText(root.get("created by")),
  };
}

function parseFiles(info: BencodeDict, rootName: string): TorrentFile[] {
  const list = asList(info.get("files"));

  // Single-file torrent.
  if (!list) {
    const length = asNumber(info.get("length"));
    if (!length || length <= 0) throw new Error("single-file torrent is missing info.length");
    return [{ index: 0, path: rootName, offset: 0, length, padding: false }];
  }

  if (list.length === 0) throw new Error("multi-file torrent has an empty files list");
  if (list.length > LIMITS.maxFiles) {
    throw new Error(`torrent has ${list.length} files, limit is ${LIMITS.maxFiles}`);
  }

  const files: TorrentFile[] = [];
  let offset = 0;
  for (let i = 0; i < list.length; i++) {
    const entry = asDict(list[i]);
    if (!entry) throw new Error(`files[${i}] is not a dictionary`);
    const length = asNumber(entry.get("length"));
    if (length === undefined || !Number.isInteger(length) || length < 0) {
      throw new Error(`files[${i}] has an invalid length`);
    }
    const pathParts = asList(entry.get("path"));
    if (!pathParts || pathParts.length === 0) throw new Error(`files[${i}] has no path`);

    const safeParts = pathParts.map((part, partIndex) => {
      const bytes = asBytes(part);
      if (!bytes) throw new Error(`files[${i}].path[${partIndex}] is not a byte string`);
      return sanitizeComponent(utf8String(bytes));
    });

    const attr = asText(entry.get("attr")) ?? "";
    files.push({
      index: i,
      path: [rootName, ...safeParts].join("/"),
      offset,
      length,
      padding: attr.includes("p"),
    });
    offset += length;
  }
  return files;
}

function parseTrackers(root: BencodeDict): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      if (!parsed.hostname) return;
    } catch {
      return;
    }
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };

  // announce-list is a list of tiers (list of lists). Flatten while preserving
  // tier order, which is the best signal of tracker preference we have.
  const tiers = asList(root.get("announce-list"));
  if (tiers) {
    for (const tier of tiers) {
      const tierList = asList(tier);
      if (!tierList) continue;
      for (const entry of tierList) add(asText(entry));
    }
  }

  add(asText(root.get("announce")));
  return out;
}

export function pieceLengthAt(meta: Pick<TorrentMeta, "pieceLength" | "totalLength">, index: number): number {
  const start = index * meta.pieceLength;
  return Math.min(meta.pieceLength, meta.totalLength - start);
}

export function pieceHashAt(meta: Pick<TorrentMeta, "pieces">, index: number): Uint8Array {
  return meta.pieces.subarray(index * 20, index * 20 + 20);
}

function sanitizeComponent(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return "_";
  return cleaned;
}

export function sanitizeName(value: string): string {
  return sanitizeComponent(value) || "unnamed";
}
