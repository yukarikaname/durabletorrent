import { fromHex, toHex } from "../lib/bytes";

export interface MagnetInfo {
  infoHash: Uint8Array;
  infoHashHex: string;
  name?: string;
  trackers: string[];
  length?: number;
}

/**
 * Parse the subset of BEP 9 magnet links this PoC can use.
 *
 * DHT is unavailable on Workers, so a magnet without at least one HTTP(S)
 * `tr=` tracker cannot be resolved. The UI lets the user paste extra trackers
 * before metadata retrieval.
 */
export function parseMagnet(uri: string): MagnetInfo {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new Error("invalid magnet URI");
  }
  if (url.protocol !== "magnet:") throw new Error("expected a magnet: URI");

  let infoHash: Uint8Array | undefined;
  for (const xt of url.searchParams.getAll("xt")) {
    const match = /^urn:btih:(.+)$/i.exec(xt.trim());
    if (!match) continue;
    const value = match[1];
    if (/^[0-9a-f]{40}$/i.test(value)) {
      infoHash = fromHex(value.toLowerCase());
      break;
    }
    if (/^[a-z2-7]{32}$/i.test(value)) {
      infoHash = decodeBase32(value);
      break;
    }
    throw new Error("magnet info hash must be 40 hex characters or 32 base32 characters");
  }
  if (!infoHash || infoHash.length !== 20) {
    throw new Error("magnet URI does not contain a BitTorrent info hash");
  }

  const trackers: string[] = [];
  const seen = new Set<string>();
  for (const value of url.searchParams.getAll("tr")) {
    const tracker = value.trim();
    if (!/^https?:\/\//i.test(tracker)) continue;
    try {
      const parsed = new URL(tracker);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (!parsed.hostname) continue;
    } catch {
      continue;
    }
    if (!seen.has(tracker)) {
      seen.add(tracker);
      trackers.push(tracker);
    }
  }

  const name = url.searchParams.get("dn") ?? undefined;
  const lengthValue = url.searchParams.get("xl");
  const length = lengthValue ? Number.parseInt(lengthValue, 10) : undefined;
  const infoHashHex = toHex(infoHash);

  return {
    infoHash,
    infoHashHex,
    name: name || undefined,
    trackers,
    length: Number.isFinite(length) && length! > 0 ? length : undefined,
  };
}

/** RFC 4648 base32, case-insensitive, padding optional. */
export function decodeBase32(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = value.toUpperCase().replace(/=+$/, "");
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 character: ${char}`);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
  }

  return new Uint8Array(out);
}
