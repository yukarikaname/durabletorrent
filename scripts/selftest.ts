/**
 * Dependency-free self test. Run with:
 *   bun run scripts/selftest.ts
 *
 * It covers the pure protocol/storage-math modules. The Durable Object and TCP
 * path need `cf dev` / `wrangler dev` because they depend on workerd bindings.
 */
import { asciiBytes, bytesEqual, concatBytes, fromHex, readU32, toHex } from "../src/lib/bytes";
import { sha1Bytes, sha1Hex } from "../src/lib/hash";
import {
  asDict,
  decodeBencode,
  encodeBencode,
  type BencodeValue,
} from "../src/bittorrent/bencode";
import { BitField } from "../src/bittorrent/bitfield";
import { parseTorrent, pieceLengthAt } from "../src/bittorrent/torrent";
import { resolveSelection } from "../src/bittorrent/selection";
import { parseMagnet, decodeBase32 } from "../src/bittorrent/magnet";
import { buildTorrentFromInfo } from "../src/bittorrent/torrent-builder";
import {
  buildAnnounceUrl,
  isPlausiblePeer,
  parseCompactPeers,
  parseTrackerResponse,
} from "../src/bittorrent/tracker";
import {
  buildHandshake,
  buildRequest,
  MessageId,
  parseFrame,
  parseHandshake,
  supportsExtendedProtocol,
} from "../src/bittorrent/peer-frames";
import { PieceQueue } from "../src/bittorrent/piece-queue";
import { OutputReader, buildOutputRanges } from "../src/storage/output";
import { estimateR2Storage, estimateTaskCost, freeRetentionHours } from "../src/lib/pricing";

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  passed++;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
  passed++;
}

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

async function main(): Promise<void> {
  await test("byte helpers round-trip", () => {
    const bytes = fromHex("00ff10aB");
    assertEqual(toHex(bytes), "00ff10ab", "hex round-trip");
    assert(bytesEqual(asciiBytes("abc"), new Uint8Array([97, 98, 99])), "ascii bytes");
  });

  await test("bitfield uses MSB-first bit order", () => {
    const bits = new BitField(9);
    bits.set(0);
    bits.set(7);
    bits.set(8);
    assertEqual(toHex(bits.toBytes()), "8180", "bitfield bytes");
    assertEqual(bits.count(), 3, "bitfield count");
    assert(bits.get(0) && bits.get(7) && bits.get(8), "bitfield get");
    assert(!bits.get(1), "bitfield unset bit");
    const copy = new BitField(9, bits.toBytes());
    assertEqual(copy.toHex(), "8180", "bitfield from bytes");
  });

  await test("bencode decodes/encodes integers, bytes, lists, dicts", () => {
    const value: BencodeValue = new Map<string, BencodeValue>([
      ["a", 42],
      ["b", asciiBytes("hello")],
      ["c", [1, asciiBytes("x")]],
    ]);
    const encoded = encodeBencode(value);
    assertEqual(
      new TextDecoder().decode(encoded),
      "d1:ai42e1:b5:hello1:cli1e1:xee",
      "canonical bencode output",
    );
    const decoded = decodeBencode(encoded).value;
    assert(decoded instanceof Map, "decoded dictionary");
    assertEqual(decoded.get("a"), 42, "decoded integer");
    assertEqual(new TextDecoder().decode(decoded.get("b") as Uint8Array), "hello", "decoded bytes");
  });

  await test("bencode rejects malformed input", () => {
    let threw = false;
    try {
      decodeBencode(asciiBytes("i12")); // missing 'e'
    } catch {
      threw = true;
    }
    assert(threw, "unterminated integer throws");

    threw = false;
    try {
      decodeBencode(asciiBytes("3:ab")); // truncated string
    } catch {
      threw = true;
    }
    assert(threw, "truncated string throws");

    threw = false;
    try {
      decodeBencode(asciiBytes("d1:ai1e1:ai2ee")); // duplicate key
    } catch {
      threw = true;
    }
    assert(threw, "duplicate dictionary key throws");
  });

  const fixture = await buildFixture();
  await test("torrent parser extracts info hash, files, pieces and trackers", async () => {
    const meta = await parseTorrent(fixture.torrent);
    assertEqual(meta.infoHashHex, fixture.infoHashHex, "info hash");
    assertEqual(meta.name, "test-root", "torrent name");
    assertEqual(meta.pieceLength, 16384, "piece length");
    assertEqual(meta.pieceCount, 5, "piece count");
    assertEqual(meta.totalLength, 70000, "total length");
    assertEqual(meta.files.length, 2, "file count");
    assertEqual(meta.files[0].offset, 0, "file 0 offset");
    assertEqual(meta.files[1].offset, 40000, "file 1 offset");
    assertEqual(meta.files[1].path, "test-root/b.bin", "file 1 path");
    assertEqual(pieceLengthAt(meta, 4), 4464, "last piece length");
    assertEqual(meta.trackers.length, 3, "tracker count");
    assert(meta.trackers[0].startsWith("https://"), "tracker order preserved");
  });

  await test("default selection covers the whole payload", async () => {
    const meta = await parseTorrent(fixture.torrent);
    const selection = resolveSelection(meta, {});
    assertEqual(selection.ranges.length, 1, "merged range count");
    assertEqual(selection.ranges[0].start, 0, "range start");
    assertEqual(selection.ranges[0].length, 70000, "range length");
    assertEqual(selection.wantedPieces.count(), 5, "wanted piece count");
    assertEqual(selection.wantedBytes, 70000, "wanted bytes");
    assertEqual(selection.outputBytes, 70000, "output bytes");
  });

  await test("file selection trims output but keeps boundary pieces", async () => {
    const meta = await parseTorrent(fixture.torrent);
    const selection = resolveSelection(meta, { files: [1] });
    assertEqual(selection.ranges.length, 1, "single range");
    assertEqual(selection.ranges[0].start, 40000, "selected offset");
    assertEqual(selection.outputBytes, 30000, "trimmed output");
    assertEqual(selection.wantedPieces.count(), 3, "boundary pieces");
    assertEqual(selection.wantedBytes, 16384 + 16384 + 4464, "full pieces transferred");
    assert(selection.wantedPieces.get(2), "piece 2 wanted");
    assert(selection.wantedPieces.get(3), "piece 3 wanted");
    assert(selection.wantedPieces.get(4), "piece 4 wanted");
  });

  await test("byte range selection intersects pieces correctly", async () => {
    const meta = await parseTorrent(fixture.torrent);
    const selection = resolveSelection(meta, { ranges: [{ start: 0, end: 10000 }] });
    assertEqual(selection.outputBytes, 10000, "range output");
    assertEqual(selection.wantedBytes, 16384, "whole boundary piece");
    assertEqual(selection.wantedPieces.count(), 1, "one wanted piece");
    assertEqual(selection.wantedPieces.count(), 1, "range piece count");
  });

  await test("magnet parser supports hex and base32 info hashes", () => {
    const base32 = encodeBase32(fromHex(fixture.infoHashHex));
    const fromHexMagnet = parseMagnet(
      `magnet:?xt=urn:btih:${fixture.infoHashHex}&dn=Test&tr=https%3A%2F%2Ftracker.example%2Fannounce&tr=udp%3A%2F%2Fudp.example%3A80`,
    );
    assertEqual(fromHexMagnet.infoHashHex, fixture.infoHashHex, "hex magnet info hash");
    assertEqual(fromHexMagnet.name, "Test", "magnet display name");
    assertEqual(fromHexMagnet.trackers.length, 1, "UDP tracker filtered");
    assert(fromHexMagnet.trackers[0].startsWith("https://"), "HTTP tracker retained");

    const fromBase32Magnet = parseMagnet(`magnet:?xt=urn:btih:${base32}`);
    assertEqual(fromBase32Magnet.infoHashHex, fixture.infoHashHex, "base32 magnet info hash");
    assertEqual(fromBase32Magnet.trackers.length, 0, "magnet without trackers");
    assertEqual(decodeBase32(base32).length, 20, "decoded base32 length");
  });

  await test("torrent builder preserves info bytes and info hash", async () => {
    const built = buildTorrentFromInfo(fixture.infoBytes, [
      "https://tracker.example/announce",
      "http://tracker2.example/a",
    ]);
    const meta = await parseTorrent(built);
    assertEqual(meta.infoHashHex, fixture.infoHashHex, "embedded info hash");
    assertEqual(meta.trackers.length, 2, "embedded tracker count");
  });

  await test("bencode can decode a prefix for BEP 9 metadata messages", () => {
    const input = concatBytes([encodeBencode(42), asciiBytes("tail")]);
    const decoded = decodeBencode(input, { allowTrailing: true });
    assertEqual(decoded.value, 42, "decoded prefix value");
    assertEqual(decoded.consumed, 4, "consumed prefix length");

    let threw = false;
    try {
      decodeBencode(input);
    } catch {
      threw = true;
    }
    assert(threw, "trailing bytes rejected by default");
  });

  await test("tracker compact peers and private address filtering", () => {
    const compact = new Uint8Array([
      1, 2, 3, 4, 0x1a, 0xe1, // 1.2.3.4:6881
      8, 8, 8, 8, 0x00, 0x50, // 8.8.8.8:80
      10, 0, 0, 1, 0x1a, 0xe1, // private, filtered
    ]);
    const peers = parseCompactPeers(compact);
    assertEqual(peers.length, 2, "public peers only");
    assertEqual(peers[0].port, 6881, "first port");
    assertEqual(peers[1].host, "8.8.8.8", "second host");

    const response = new Map<string, BencodeValue>([
      ["interval", 1200],
      ["peers", compact],
    ]);
    const parsed = parseTrackerResponse(encodeBencode(response));
    assertEqual(parsed.interval, 1200, "tracker interval");
    assertEqual(parsed.peers.length, 2, "tracker peer count");

    assert(isPlausiblePeer("1.2.3.4", 6881), "public IPv4 accepted");
    assert(!isPlausiblePeer("127.0.0.1", 6881), "loopback rejected");
    assert(!isPlausiblePeer("192.168.1.2", 6881), "private range rejected");
    assert(!isPlausiblePeer("1.2.3.4", 0), "port zero rejected");
  });

  await test("tracker failure responses throw", () => {
    const response = new Map<string, BencodeValue>([
      ["failure reason", asciiBytes("unregistered torrent")],
    ]);
    let message = "";
    try {
      parseTrackerResponse(encodeBencode(response));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("unregistered torrent"), "failure reason surfaced");
  });

  await test("announce URL percent-encodes binary hashes", () => {
    const url = buildAnnounceUrl({
      trackerUrl: "http://tracker.example/announce?passkey=abc",
      infoHash: new Uint8Array([0x00, 0xff, 0x41]),
      peerId: asciiBytes("-CF0001-123456789012"),
      port: 6881,
      uploaded: 0,
      downloaded: 100,
      left: 900,
      event: "started",
    });
    assert(url.startsWith("http://tracker.example/announce?passkey=abc&"), "existing query preserved");
    assert(url.includes("info_hash=%00%FF%41"), "info hash encoding");
    assert(url.includes("compact=1"), "compact flag");
    assert(url.includes("event=started"), "event flag");
  });

  await test("peer handshake and request frames", () => {
    const infoHash = fromHex("00112233445566778899aabbccddeeff00112233");
    const peerId = asciiBytes("-CF0001-abcdefghijkl");
    const handshake = buildHandshake(infoHash, peerId);
    assertEqual(handshake.length, 68, "handshake length");
    const parsed = parseHandshake(handshake);
    assert(bytesEqual(parsed.infoHash, infoHash), "handshake info hash");
    assert(bytesEqual(parsed.peerId, peerId), "handshake peer id");

    const request = buildRequest(7, 16384, 16384);
    assertEqual(readU32(request, 0), 13, "request message length");
    assertEqual(request.length, 17, "request frame size");
    const frame = parseFrame(request);
    assertEqual(frame.id, MessageId.Request, "request message id");
    assertEqual(frame.payload.length, 12, "request payload length");
    assertEqual((frame.payload[0] << 24) | (frame.payload[1] << 16) | (frame.payload[2] << 8) | frame.payload[3], 7, "piece index");
    assertEqual((frame.payload[4] << 24) | (frame.payload[5] << 16) | (frame.payload[6] << 8) | frame.payload[7], 16384, "block begin");
  });

  await test("BEP 10 extended protocol bit is set only when requested", () => {
    const infoHash = fromHex("00112233445566778899aabbccddeeff00112233");
    const peerId = asciiBytes("-CF0001-abcdefghijkl");
    const plain = parseHandshake(buildHandshake(infoHash, peerId));
    assert(!supportsExtendedProtocol(plain.reserved), "plain handshake has no extension bit");
    const extended = parseHandshake(buildHandshake(infoHash, peerId, { extended: true }));
    assert(supportsExtendedProtocol(extended.reserved), "extended handshake advertises BEP 10");
  });

  await test("piece queue defers pieces a peer does not have", () => {
    const queue = new PieceQueue([1, 2, 3]);
    const first = queue.take(() => false);
    assertEqual(first, null, "all pieces deferred");
    assertEqual(queue.size, 3, "deferred pieces retained");
    const second = queue.take(() => true);
    assert(second !== null, "piece available after rotation");
    queue.release(second!);
    assertEqual(queue.size, 3, "released piece counted");
  });

  await test("sha1 matches a known digest", async () => {
    const digest = await sha1Hex(asciiBytes("abc"));
    assertEqual(digest, "a9993e364706816aba3e25717850c26c9cd0d89d", "SHA-1('abc')");
    const bytes = await sha1Bytes(asciiBytes("abc"));
    assertEqual(bytes.length, 20, "digest length");
  });

  await test("output reader trims byte ranges at piece boundaries", async () => {
    const pieces = [asciiBytes("AAAA"), asciiBytes("BBBB"), asciiBytes("CC")];
    const ranges = buildOutputRanges([
      { start: 2, length: 5 },
      { start: 8, length: 2 },
    ]);
    const reader = new OutputReader(
      fakeBucket(pieces),
      "a".repeat(40),
      3,
      4,
      10,
      ranges,
    );
    assertEqual(reader.outputBytes, 7, "output byte count");

    const out: number[] = [];
    while (out.length < reader.outputBytes) {
      const chunk = await reader.read(out.length, 2);
      out.push(...chunk);
    }
    assertEqual(new TextDecoder().decode(new Uint8Array(out)), "AABBBCC", "trimmed output bytes");
  });

  await test("cost helpers produce units and free-tier hints", () => {
    const estimate = estimateTaskCost({
      torrentBytes: 100_000,
      stagingBytes: 100 * 1024 * 1024,
      outputBytes: 40 * 1024 * 1024,
      doRequests: 20,
      alarmCount: 4,
      waveDurationMs: 120_000,
      r2PutOps: 120,
      r2GetOps: 20,
      trackerRequests: 3,
      peerConnections: 12,
      wantedPieces: 400,
      verifiedPieces: 200,
    });
    assert(estimate.total > 0, "positive cost estimate");
    assert(estimate.units.doGbSeconds > 0, "DO GB-seconds computed");
    assert(estimate.withinFreeTierIfOnlyTask, "small task is likely within free tier");

    const storage = estimateR2Storage(20_000_000_000);
    assert(Math.abs(storage.monthlyCost - 0.3) < 1e-9, "20 GB list price");
    assert(Math.abs(storage.billableMonthlyCost - 0.15) < 1e-9, "billable after 10 GB free");

    assertEqual(freeRetentionHours(3.33, 200_000_000_000, 1), 1, "200 GB / one hour");
    assertEqual(freeRetentionHours(3.33, 200_000_000_000, 48), 24, "200 GB / second day capped");
    assertEqual(freeRetentionHours(6.67, 100_000_000_000, 48), 48, "100 GB / two days fits");
    assertEqual(freeRetentionHours(10, 8_000_000, 24), 24, "small output keeps requested time");
  });

  console.log(`\n${passed} assertions passed.`);
}

interface Fixture {
  torrent: Uint8Array;
  infoBytes: Uint8Array;
  infoHashHex: string;
}

async function buildFixture(): Promise<Fixture> {
  const pieceLength = 16384;
  const totalLength = 70000;
  const pieceCount = Math.ceil(totalLength / pieceLength);
  const payload = new Uint8Array(totalLength);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;

  const hashes: Uint8Array[] = [];
  for (let i = 0; i < pieceCount; i++) {
    const start = i * pieceLength;
    const end = Math.min(totalLength, start + pieceLength);
    hashes.push(await sha1Bytes(payload.subarray(start, end)));
  }

  const info = new Map<string, BencodeValue>([
    ["name", asciiBytes("test-root")],
    ["piece length", pieceLength],
    ["pieces", concatBytes(hashes)],
    [
      "files",
      [
        new Map<string, BencodeValue>([
          ["length", 40000],
          ["path", [asciiBytes("a.bin")]],
        ]),
        new Map<string, BencodeValue>([
          ["length", 30000],
          ["path", [asciiBytes("b.bin")]],
        ]),
      ],
    ],
  ]);

  const root = new Map<string, BencodeValue>([
    ["announce", asciiBytes("http://udp-tracker.example/announce")],
    [
      "announce-list",
      [[asciiBytes("https://tracker.example/announce")], [asciiBytes("http://tracker2.example/a")]],
    ],
    ["info", info],
  ]);

  const infoBytes = encodeBencode(info);
  const infoHash = await sha1Bytes(infoBytes);
  assert(asDict(info) !== undefined, "fixture info is a dict");

  return {
    torrent: encodeBencode(root),
    infoBytes,
    infoHashHex: toHex(infoHash),
  };
}

function encodeBase32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(buffer >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 0x1f];
  return out;
}

function fakeBucket(pieces: Uint8Array[]): R2Bucket {
  return {
    async get(key: string, options?: R2GetOptions) {
      const name = key.slice(key.lastIndexOf("/") + 1);
      const index = Number(name.replace(".piece", ""));
      const data = pieces[index];
      if (!data) return null;

      const range = options?.range as { offset?: number; length?: number } | undefined;
      const start = range?.offset ?? 0;
      const length = range?.length ?? data.length;
      const slice = data.slice(start, start + length);
      return {
        async arrayBuffer() {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
        },
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

main().catch((error) => {
  console.error(error);
  throw error;
});
