import { BitField } from "./bitfield";
import { pieceLengthAt, type TorrentFile, type TorrentMeta } from "./torrent";

export interface SelectionInput {
  /** Zero-based file indices. Ignored when `ranges` is non-empty. */
  files?: number[];
  /** Byte ranges in the concatenated torrent payload. `end` is exclusive. */
  ranges?: Array<{ start: number; end: number }>;
}

export interface SelectionRange {
  start: number;
  length: number;
}

export interface ResolvedSelection {
  ranges: SelectionRange[];
  wantedPieces: BitField;
  /** Bytes actually transferred (whole pieces that overlap the selection). */
  wantedBytes: number;
  /** Bytes written to R2 (the selection with boundary pieces trimmed). */
  outputBytes: number;
}

/**
 * Turn a user selection into byte ranges plus the set of pieces that must be
 * downloaded.
 *
 * BitTorrent pieces are atomic for verification, so a selected byte range that
 * starts or ends inside a piece still requires the whole piece. Finalization
 * trims those boundary bytes back out before writing the output object.
 */
export function resolveSelection(meta: TorrentMeta, input: SelectionInput = {}): ResolvedSelection {
  const ranges = normalizeRanges(meta, input);

  const wantedPieces = new BitField(meta.pieceCount);
  let wantedBytes = 0;
  let outputBytes = 0;

  for (const range of ranges) {
    outputBytes += range.length;
    const firstPiece = Math.floor(range.start / meta.pieceLength);
    const lastPiece = Math.floor((range.start + range.length - 1) / meta.pieceLength);
    for (let index = firstPiece; index <= lastPiece; index++) {
      if (!wantedPieces.get(index)) {
        wantedPieces.set(index);
        wantedBytes += pieceLengthAt(meta, index);
      }
    }
  }

  if (wantedPieces.hasNone() || outputBytes === 0) {
    throw new Error("selection is empty");
  }

  return { ranges, wantedPieces, wantedBytes, outputBytes };
}

function normalizeRanges(meta: TorrentMeta, input: SelectionInput): SelectionRange[] {
  if (input.ranges && input.ranges.length > 0) {
    const ranges = input.ranges.map((range, i) => {
      if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end <= range.start ||
        range.end > meta.totalLength
      ) {
        throw new Error(`ranges[${i}] is outside the torrent or has an invalid span`);
      }
      return { start: range.start, length: range.end - range.start };
    });
    return mergeRanges(ranges);
  }

  let files: TorrentFile[];
  if (input.files && input.files.length > 0) {
    files = input.files.map((index) => {
      const file = meta.files[index];
      if (!file) throw new Error(`files[${index}] does not exist`);
      return file;
    });
    files.sort((a, b) => a.offset - b.offset);
  } else {
    // Default to all non-padding files. BEP 47 padding exists only to align
    // files on disk and is not user content.
    files = meta.files.filter((file) => !file.padding && file.length > 0);
    if (files.length === 0) files = meta.files.filter((file) => file.length > 0);
  }

  const ranges = files
    .filter((file) => file.length > 0)
    .map((file) => ({ start: file.offset, length: file.length }));
  if (ranges.length === 0) throw new Error("selection contains no non-empty files");
  return mergeRanges(ranges);
}

function mergeRanges(ranges: SelectionRange[]): SelectionRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: SelectionRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && last.start + last.length === range.start) {
      last.length += range.length;
    } else if (last && range.start < last.start + last.length) {
      const end = Math.max(last.start + last.length, range.start + range.length);
      last.length = end - last.start;
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/** Parse the `files=0,2,5` query-string form. */
export function parseFilesParam(value: string | null): number[] | undefined {
  if (!value) return undefined;
  const files = value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 0);
  return files.length > 0 ? [...new Set(files)] : undefined;
}

/** Parse the `ranges=0-1023,2048-4095` query-string form. */
export function parseRangesParam(value: string | null): SelectionInput["ranges"] {
  if (!value) return undefined;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const part of value.split(",")) {
    const match = /^(\d+)-(\d+)$/.exec(part.trim());
    if (!match) continue;
    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2], 10);
    if (Number.isInteger(start) && Number.isInteger(end) && end > start) {
      ranges.push({ start, end });
    }
  }
  return ranges.length > 0 ? ranges : undefined;
}
