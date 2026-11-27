import { readU32 } from "../lib/bytes";
import { LIMITS } from "../lib/limits";
import { BitField } from "./bitfield";
import { MessageId } from "./peer-frames";
import { PeerWire } from "./peer-wire";

export interface ClaimedPiece {
  index: number;
  length: number;
}

export type CommitResult = "ok" | "hash-mismatch" | "storage-error";

/**
 * The downloader talks to the Durable Object through this small interface so
 * that the wire logic stays independent from SQLite/R2 details.
 */
export interface PeerDownloadHooks {
  /** Claim a piece, optionally constrained by the peer's bitfield. */
  claim(has: ((index: number) => boolean) | null): ClaimedPiece | null;
  /** Give a claimed piece back after a choke/abort. */
  release(index: number): void;
  /** Verify, stage to R2 and persist the piece. */
  commit(index: number, data: Uint8Array, peer: string): Promise<CommitResult>;
  /** True when the current wave should stop (deadline/byte budget/pause). */
  expired(): boolean;
  /** Report a peer that repeatedly serves corrupt data. */
  badPeer(peer: string, reason: string): void;
  log(message: string): void;
}

export interface PeerDownloadOptions {
  host: string;
  port: number;
  infoHash: Uint8Array;
  peerId: Uint8Array;
  pieceCount: number;
  deadline: number;
  hooks: PeerDownloadHooks;
}

export interface PeerDownloadStats {
  peer: string;
  downloaded: number;
  verifiedPieces: number;
  badPieces: number;
  error?: string;
}

interface CurrentPiece {
  index: number;
  length: number;
  buffer: Uint8Array;
  blockSize: number;
  blocks: number;
  received: number;
  nextBlock: number;
  outstanding: number;
  seen: Uint8Array;
}

class PeerPieces {
  private bits: BitField | null = null;

  constructor(private readonly pieceCount: number) {}

  setBitfield(bytes: Uint8Array): void {
    // Some clients include padding bits/bytes. BitField truncates to the exact
    // piece count, but a short field is a protocol error.
    this.bits = new BitField(this.pieceCount, bytes);
  }

  have(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pieceCount) return;
    // Without a bitfield we assume the peer has everything. A `have` message
    // does not let us infer the rest, so leave the optimistic assumption alone.
    this.bits?.set(index);
  }

  predicate(): ((index: number) => boolean) | null {
    if (!this.bits) return null;
    const bits = this.bits;
    return (index: number) => bits.get(index);
  }
}

/**
 * Download verified pieces from a single peer until the wave deadline, the
 * peer runs out of useful pieces, or an error occurs.
 *
 * This function never throws: errors are reported in the returned stats so a
 * wave can continue with the other five peers.
 */
export async function runPeerDownload(options: PeerDownloadOptions): Promise<PeerDownloadStats> {
  const peer = `${options.host}:${options.port}`;
  const stats: PeerDownloadStats = {
    peer,
    downloaded: 0,
    verifiedPieces: 0,
    badPieces: 0,
  };

  let wire: PeerWire | undefined;
  let current: CurrentPiece | null = null;
  const peerPieces = new PeerPieces(options.pieceCount);

  try {
    const connection = await PeerWire.connectAndHandshake({
      host: options.host,
      port: options.port,
      infoHash: options.infoHash,
      peerId: options.peerId,
    });
    wire = connection.wire;
    await wire.sendInterested();

    let unchoked = false;
    let unchokeDeadline = Date.now() + LIMITS.unchokeTimeoutMs;

    while (!options.hooks.expired() && Date.now() < options.deadline) {
      if (!current && unchoked) {
        const claim = options.hooks.claim(peerPieces.predicate());
        if (!claim) {
          // The peer has nothing we still need (or the shared queue is empty).
          break;
        }
        current = {
          index: claim.index,
          length: claim.length,
          buffer: new Uint8Array(claim.length),
          blockSize: LIMITS.blockSize,
          blocks: Math.ceil(claim.length / LIMITS.blockSize),
          received: 0,
          nextBlock: 0,
          outstanding: 0,
          seen: new Uint8Array(Math.ceil(claim.length / LIMITS.blockSize)),
        };
      }

      if (current && unchoked) {
        while (current.outstanding < LIMITS.pipelineDepth && current.nextBlock < current.blocks) {
          const begin = current.nextBlock * LIMITS.blockSize;
          const length = Math.min(LIMITS.blockSize, current.length - begin);
          await wire.sendRequest(current.index, begin, length);
          current.nextBlock++;
          current.outstanding++;
        }
      }

      const idleDeadline = unchoked ? Date.now() + LIMITS.idleTimeoutMs : unchokeDeadline;
      const readDeadline = Math.min(options.deadline, idleDeadline);
      const message = await wire.nextMessage(readDeadline);

      switch (message.id) {
        case MessageId.Choke: {
          unchoked = false;
          if (current) {
            options.hooks.release(current.index);
            current = null;
          }
          unchokeDeadline = Date.now() + LIMITS.unchokeTimeoutMs;
          break;
        }

        case MessageId.Unchoke: {
          unchoked = true;
          break;
        }

        case MessageId.Have: {
          if (message.payload.length >= 4) peerPieces.have(readU32(message.payload, 0));
          break;
        }

        case MessageId.Bitfield: {
          peerPieces.setBitfield(message.payload);
          break;
        }

        case MessageId.Piece: {
          if (!current) break;
          if (message.payload.length < 8) break;

          const index = readU32(message.payload, 0);
          const begin = readU32(message.payload, 4);
          const block = message.payload.subarray(8);

          if (index !== current.index) break;
          if (begin % LIMITS.blockSize !== 0) break;
          if (block.length === 0 || block.length > LIMITS.blockSize) break;
          if (begin + block.length > current.length) break;

          const blockIndex = begin / LIMITS.blockSize;
          if (blockIndex >= current.blocks || current.seen[blockIndex]) break;

          current.buffer.set(block, begin);
          current.seen[blockIndex] = 1;
          current.received++;
          current.outstanding = Math.max(0, current.outstanding - 1);
          stats.downloaded += block.length;

          if (current.received === current.blocks) {
            const completed = current;
            current = null;
            const result = await options.hooks.commit(completed.index, completed.buffer, peer);

            if (result === "ok") {
              stats.verifiedPieces++;
            } else if (result === "hash-mismatch") {
              stats.badPieces++;
              if (stats.badPieces >= LIMITS.maxBadPiecesPerPeer) {
                options.hooks.badPeer(peer, "repeated piece hash mismatches");
                throw new Error("peer sent too many corrupt pieces");
              }
            } else {
              options.hooks.log(`R2 staging failed for piece ${completed.index}; peer ${peer} is not at fault`);
            }
          }
          break;
        }

        // Messages related to uploading or extensions we did not negotiate.
        case MessageId.Request:
        case MessageId.Cancel:
        case MessageId.Port:
        case MessageId.Interested:
        case MessageId.NotInterested:
        case MessageId.Extended:
          break;

        default:
          // Unknown message IDs are ignored for forward compatibility.
          break;
      }
    }
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (current) options.hooks.release(current.index);
    await wire?.close();
  }

  return stats;
}
