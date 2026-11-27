import { stagingPieceKey } from "./keys";
import type { SelectionRange } from "../bittorrent/selection";

export interface OutputRange extends SelectionRange {
  /** Offset of this range in the final concatenated output object. */
  outputStart: number;
}

export function buildOutputRanges(ranges: SelectionRange[]): OutputRange[] {
  let cursor = 0;
  return ranges.map((range) => {
    const out: OutputRange = { ...range, outputStart: cursor };
    cursor += range.length;
    return out;
  });
}

export class MissingStagedPieceError extends Error {
  constructor(readonly pieceIndex: number) {
    super(`staged R2 object for piece ${pieceIndex} is missing or truncated`);
    this.name = "MissingStagedPieceError";
  }
}

/**
 * Maps a byte offset in the final output object back to torrent bytes, trims
 * piece boundaries, and reads only the required range from R2.
 *
 * Reads are deliberately range-based so finalization never loads a whole piece
 * or the whole output file into memory.
 */
export class OutputReader {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly infoHashHex: string,
    private readonly pieceCount: number,
    private readonly pieceLength: number,
    private readonly totalLength: number,
    private readonly ranges: OutputRange[],
  ) {}

  get outputBytes(): number {
    const last = this.ranges[this.ranges.length - 1];
    return last ? last.outputStart + last.length : 0;
  }

  async read(outputOffset: number, maxLength: number): Promise<Uint8Array> {
    if (outputOffset < 0 || outputOffset >= this.outputBytes) {
      throw new Error(`output offset ${outputOffset} is outside the output object`);
    }
    if (maxLength <= 0) throw new Error("read length must be positive");

    const range = this.locate(outputOffset);
    const localOffset = outputOffset - range.outputStart;
    const absolute = range.start + localOffset;
    const pieceIndex = Math.floor(absolute / this.pieceLength);
    const offsetInPiece = absolute - pieceIndex * this.pieceLength;
    const pieceSize = Math.min(
      this.pieceLength,
      this.totalLength - pieceIndex * this.pieceLength,
    );

    const take = Math.min(maxLength, range.length - localOffset, pieceSize - offsetInPiece);
    if (take <= 0) throw new Error("computed a non-positive output read length");

    const key = stagingPieceKey(this.infoHashHex, pieceIndex, this.pieceCount);
    const object = await this.bucket.get(key, {
      range: { offset: offsetInPiece, length: take },
    });
    if (!object) throw new MissingStagedPieceError(pieceIndex);

    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== take) throw new MissingStagedPieceError(pieceIndex);
    return bytes;
  }

  private locate(outputOffset: number): OutputRange {
    let low = 0;
    let high = this.ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const range = this.ranges[mid];
      if (outputOffset < range.outputStart) {
        high = mid - 1;
      } else if (outputOffset >= range.outputStart + range.length) {
        low = mid + 1;
      } else {
        return range;
      }
    }
    throw new Error(`output offset ${outputOffset} does not belong to any selection range`);
  }
}
