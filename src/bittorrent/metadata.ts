import { asDict, asNumber, decodeBencode, encodeBencode, type BencodeValue } from "./bencode";
import { announceTracker, type TrackerPeer } from "./tracker";
import { PeerWire } from "./peer-wire";
import {
  buildExtendedHandshake,
  buildExtendedMessage,
  MessageId,
  supportsExtendedProtocol,
} from "./peer-frames";
import { bytesEqual, concatBytes } from "../lib/bytes";
import { sha1Bytes } from "../lib/hash";
import { LIMITS } from "../lib/limits";

const UT_METADATA_ID = 1; // The extended message ID we advertise to peers.
const METADATA_PIECE_SIZE = 16 * 1024;
const MAX_METADATA_BYTES = LIMITS.maxTorrentBytes;
const MAX_METADATA_PIECES = Math.ceil(MAX_METADATA_BYTES / METADATA_PIECE_SIZE);
const METADATA_PIPELINE = 4;

export interface MetadataFetchOptions {
  infoHash: Uint8Array;
  trackers: string[];
  peerId: Uint8Array;
  /** Overall budget for tracker announces plus peer attempts. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface MetadataFetchResult {
  /** Raw bencoded `info` dictionary, sha1-verified against the magnet. */
  infoBytes: Uint8Array;
  peerHost: string;
  peerPort: number;
  peerCount: number;
}

interface PeerAttemptOptions extends MetadataFetchOptions {
  host: string;
  port: number;
  deadline: number;
  log: (message: string) => void;
}

/**
 * Resolve a magnet's metadata through BEP 9 (ut_metadata) over TCP.
 *
 * Workers has no UDP/DHT, so discovery comes only from the HTTP(S) trackers in
 * the magnet or supplied by the user. The returned bytes are the exact bencoded
 * `info` dictionary and are verified with SHA-1 against the magnet info hash.
 */
export async function fetchMetadata(
  options: MetadataFetchOptions,
): Promise<MetadataFetchResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);

  if (options.trackers.length === 0) {
    throw new Error(
      "magnet has no HTTP(S) tracker; DHT is not available on Workers, so add a tracker URL explicitly",
    );
  }

  const peers = new Map<string, TrackerPeer>();
  const trackerErrors: string[] = [];
  for (const tracker of options.trackers.slice(0, 6)) {
    if (Date.now() > deadline - 15_000) break;
    try {
      const response = await announceTracker({
        trackerUrl: tracker,
        infoHash: options.infoHash,
        peerId: options.peerId,
        port: 6881,
        uploaded: 0,
        downloaded: 0,
        left: 1,
        event: "started",
        numwant: 50,
        timeoutMs: 7000,
      });
      for (const peer of response.peers) {
        peers.set(`${peer.host}:${peer.port}`, peer);
      }
      log(`metadata tracker ${tracker} returned ${response.peers.length} peers`);
      if (peers.size >= 30) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trackerErrors.push(`${tracker}: ${message}`);
      log(`metadata tracker failed: ${tracker}: ${message}`);
    }
  }

  if (peers.size === 0) {
    const detail = trackerErrors.slice(0, 3).join("; ");
    throw new Error(
      `no peers discovered for magnet metadata${detail ? ` (${detail})` : ""}`,
    );
  }

  const candidates = shuffle([...peers.values()]).slice(0, 12);
  const errors: string[] = [];
  let winner: MetadataFetchResult | null = null;
  let resolveWinner: ((result: MetadataFetchResult) => void) | null = null;
  const winnerPromise = new Promise<MetadataFetchResult>((resolve) => {
    resolveWinner = resolve;
  });

  const worker = async (): Promise<void> => {
    while (!winner && Date.now() < deadline) {
      const peer = candidates.pop();
      if (!peer) return;
      try {
        const result = await fetchMetadataFromPeer({
          ...options,
          host: peer.host,
          port: peer.port,
          deadline,
          log,
        });
        if (!winner) {
          winner = { ...result, peerCount: peers.size };
          resolveWinner?.(winner);
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${peer.host}:${peer.port}: ${message}`);
        log(`metadata peer failed ${peer.host}:${peer.port}: ${message}`);
      }
    }
  };

  const all = Promise.allSettled([worker(), worker(), worker()]);
  const first = await Promise.race([winnerPromise, all.then(() => null)]);
  if (first) return first;

  const detail = errors.slice(0, 3).join("; ");
  throw new Error(`could not fetch magnet metadata${detail ? ` (${detail})` : ""}`);
}

async function fetchMetadataFromPeer(options: PeerAttemptOptions): Promise<MetadataFetchResult> {
  const peerDeadline = Math.min(options.deadline, Date.now() + 15_000);
  const connection = await PeerWire.connectAndHandshake({
    host: options.host,
    port: options.port,
    infoHash: options.infoHash,
    peerId: options.peerId,
    extended: true,
    handshakeTimeoutMs: 10_000,
  });
  const wire = connection.wire;

  try {
    if (!supportsExtendedProtocol(connection.handshake.reserved)) {
      throw new Error("peer does not support BEP 10 extended protocol");
    }

    const extendedHandshake = encodeBencode(
      new Map<string, BencodeValue>([
        ["m", new Map<string, BencodeValue>([["ut_metadata", UT_METADATA_ID]])],
      ]),
    );
    await wire.send(buildExtendedHandshake(extendedHandshake));

    let peerMetadataId: number | undefined;
    let metadataSize: number | undefined;
    const handshakeDeadline = Math.min(peerDeadline, Date.now() + 10_000);

    while (peerMetadataId === undefined || metadataSize === undefined) {
      const message = await wire.nextMessage(handshakeDeadline);
      if (message.id !== MessageId.Extended || message.payload.length < 2) continue;
      if (message.payload[0] !== 0) continue;

      const decoded = decodeBencode(message.payload.subarray(1), { allowTrailing: true });
      const dict = asDict(decoded.value);
      if (!dict) continue;
      const mapping = asDict(dict.get("m"));
      const id = asNumber(mapping?.get("ut_metadata"));
      const size = asNumber(dict.get("metadata_size"));
      if (id && size) {
        peerMetadataId = id;
        metadataSize = size;
      }
    }

    if (!metadataSize || metadataSize <= 0 || metadataSize > MAX_METADATA_BYTES) {
      throw new Error(`peer advertised an invalid metadata size: ${metadataSize}`);
    }
    const pieceCount = Math.ceil(metadataSize / METADATA_PIECE_SIZE);
    if (pieceCount > MAX_METADATA_PIECES) throw new Error("metadata piece count is too large");

    const pieces = new Map<number, Uint8Array>();
    let nextPiece = 0;
    let outstanding = 0;

    while (pieces.size < pieceCount) {
      if (Date.now() > peerDeadline) throw new Error("metadata exchange timed out");

      while (nextPiece < pieceCount && outstanding < METADATA_PIPELINE) {
        const request = encodeBencode(
          new Map<string, BencodeValue>([
            ["msg_type", 0],
            ["piece", nextPiece],
          ]),
        );
        await wire.send(buildExtendedMessage(peerMetadataId, request));
        nextPiece++;
        outstanding++;
      }

      if (nextPiece >= pieceCount && outstanding === 0) {
        throw new Error("peer rejected metadata requests");
      }

      const message = await wire.nextMessage(
        Math.min(peerDeadline, Date.now() + 10_000),
      );
      if (message.id !== MessageId.Extended || message.payload.length < 2) continue;
      if (message.payload[0] !== UT_METADATA_ID) continue;

      const decoded = decodeBencode(message.payload.subarray(1), { allowTrailing: true });
      const dict = asDict(decoded.value);
      if (!dict) continue;
      const messageType = asNumber(dict.get("msg_type"));
      const pieceIndex = asNumber(dict.get("piece"));

      if (messageType === 2) {
        // Reject: give the piece back to the pool by failing over to another peer.
        outstanding = Math.max(0, outstanding - 1);
        continue;
      }
      if (messageType !== 1 || pieceIndex === undefined) continue;
      if (pieceIndex < 0 || pieceIndex >= pieceCount) continue;

      const data = message.payload.subarray(1 + decoded.consumed);
      const expectedLength = Math.min(
        METADATA_PIECE_SIZE,
        metadataSize - pieceIndex * METADATA_PIECE_SIZE,
      );
      if (data.length !== expectedLength) continue;

      if (!pieces.has(pieceIndex)) {
        pieces.set(pieceIndex, data.slice());
        outstanding = Math.max(0, outstanding - 1);
      }
    }

    const chunks: Uint8Array[] = [];
    for (let i = 0; i < pieceCount; i++) {
      const piece = pieces.get(i);
      if (!piece) throw new Error(`metadata piece ${i} is missing`);
      chunks.push(piece);
    }
    const infoBytes = concatBytes(chunks);
    if (infoBytes.length !== metadataSize) throw new Error("metadata length mismatch");

    const hash = await sha1Bytes(infoBytes);
    if (!bytesEqual(hash, options.infoHash)) {
      throw new Error("metadata SHA-1 does not match the magnet info hash");
    }

    return {
      infoBytes,
      peerHost: options.host,
      peerPort: options.port,
      peerCount: 0,
    };
  } finally {
    await wire.close();
  }
}

function shuffle<T>(values: T[]): T[] {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = values[i];
    values[i] = values[j];
    values[j] = tmp;
  }
  return values;
}
