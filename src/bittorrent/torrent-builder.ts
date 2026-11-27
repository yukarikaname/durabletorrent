import { asciiBytes, concatBytes } from "../lib/bytes";
import { encodeBencode, type BencodeValue } from "./bencode";

/**
 * Wrap a raw bencoded `info` dictionary (obtained via BEP 9) into a minimal
 * .torrent file. The `info` bytes are embedded verbatim, so the info hash is
 * preserved exactly.
 */
export function buildTorrentFromInfo(infoBytes: Uint8Array, trackers: string[]): Uint8Array {
  if (infoBytes.length === 0) throw new Error("cannot build a torrent from empty info bytes");

  const chunks: Uint8Array[] = [asciiBytes("d")];

  if (trackers.length > 0) {
    chunks.push(
      asciiBytes("8:announce"),
      encodeBencode(asciiBytes(trackers[0])),
    );
  }

  const announceList: BencodeValue[] = trackers.map((tracker) => [asciiBytes(tracker)]);
  chunks.push(asciiBytes("13:announce-list"), encodeBencode(announceList));

  chunks.push(asciiBytes("4:info"), infoBytes, asciiBytes("e"));
  return concatBytes(chunks);
}
