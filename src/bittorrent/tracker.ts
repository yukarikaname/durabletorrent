import {
  asBytes,
  asDict,
  asList,
  asNumber,
  asText,
  decodeBencodeValue,
  type BencodeValue,
} from "./bencode";
import { percentEncodeBytes, utf8String } from "../lib/bytes";
import { fetchWithTimeout, readStreamCapped } from "../lib/http";
import { LIMITS } from "../lib/limits";

export interface TrackerPeer {
  host: string;
  port: number;
}

export interface AnnounceRequest {
  trackerUrl: string;
  infoHash: Uint8Array;
  peerId: Uint8Array;
  port: number;
  uploaded: number;
  downloaded: number;
  left: number;
  event?: "started" | "stopped" | "completed";
  numwant?: number;
  key?: string;
  timeoutMs?: number;
}

export interface AnnounceResponse {
  interval: number;
  minInterval?: number;
  peers: TrackerPeer[];
  complete?: number;
  incomplete?: number;
  warning?: string;
}

export class TrackerError extends Error {
  constructor(
    message: string,
    readonly failureReason?: string,
  ) {
    super(message);
    this.name = "TrackerError";
  }
}

/**
 * Announce to one HTTP/HTTPS tracker using the compact peer format (BEP 23).
 *
 * UDP trackers, scrape, tiers with failover semantics, and IPv6 compact peers
 * are intentionally out of scope.
 */
export async function announceTracker(request: AnnounceRequest): Promise<AnnounceResponse> {
  const url = buildAnnounceUrl(request);
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        accept: "*/*",
        "user-agent": "durabletorrent/0.1 (+https://developers.cloudflare.com/workers/)",
      },
      redirect: "follow",
    },
    request.timeoutMs ?? 10_000,
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TrackerError(`tracker returned HTTP ${response.status}`);
  }

  const declared = response.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > LIMITS.maxTrackerResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TrackerError("tracker response is too large");
  }

  const body = await readStreamCapped(
    response.body,
    LIMITS.maxTrackerResponseBytes,
    "tracker response",
  );
  return parseTrackerResponse(body);
}

export function buildAnnounceUrl(request: AnnounceRequest): string {
  let base = request.trackerUrl;
  if (!base.includes("?")) base += "?";
  else if (!/[?&]$/.test(base)) base += "&";

  const params = [
    `info_hash=${percentEncodeBytes(request.infoHash)}`,
    `peer_id=${percentEncodeBytes(request.peerId)}`,
    `port=${request.port}`,
    `uploaded=${Math.max(0, Math.trunc(request.uploaded))}`,
    `downloaded=${Math.max(0, Math.trunc(request.downloaded))}`,
    `left=${Math.max(0, Math.trunc(request.left))}`,
    "compact=1",
    "no_peer_id=1",
    `numwant=${request.numwant ?? 50}`,
  ];
  if (request.event) params.push(`event=${request.event}`);
  if (request.key) params.push(`key=${encodeURIComponent(request.key)}`);

  return base + params.join("&");
}

/** Parse a bencoded tracker response. Exported for the self-test. */
export function parseTrackerResponse(body: Uint8Array): AnnounceResponse {
  let value: BencodeValue;
  try {
    value = decodeBencodeValue(body);
  } catch (error) {
    throw new TrackerError(`invalid tracker bencode: ${(error as Error).message}`);
  }

  const root = asDict(value);
  if (!root) throw new TrackerError("tracker response root is not a dictionary");

  const failure = asText(root.get("failure reason"));
  if (failure) throw new TrackerError(`tracker failure: ${failure}`, failure);

  const warning = asText(root.get("warning message"));
  const interval = clampInterval(asNumber(root.get("interval")) ?? 1800);
  const minIntervalRaw = asNumber(root.get("min interval"));
  const complete = asNumber(root.get("complete"));
  const incomplete = asNumber(root.get("incomplete"));

  const peers: TrackerPeer[] = [];
  const compact = asBytes(root.get("peers"));
  if (compact) {
    peers.push(...parseCompactPeers(compact));
  } else {
    const list = asList(root.get("peers"));
    if (list) {
      for (const entry of list) {
        const dict = asDict(entry);
        if (!dict) continue;
        const ipBytes = asBytes(dict.get("ip"));
        const host = asText(dict.get("ip")) ?? (ipBytes ? utf8String(ipBytes) : undefined);
        const port = asNumber(dict.get("port"));
        if (host && port && isPlausiblePeer(host, port)) peers.push({ host, port });
      }
    }
  }

  return {
    interval,
    minInterval: minIntervalRaw ? clampInterval(minIntervalRaw) : undefined,
    peers: dedupePeers(peers),
    complete,
    incomplete,
    warning,
  };
}

export function parseCompactPeers(bytes: Uint8Array): TrackerPeer[] {
  if (bytes.length % 6 !== 0) {
    throw new TrackerError("compact peers field length is not a multiple of 6");
  }
  const out: TrackerPeer[] = [];
  for (let i = 0; i < bytes.length; i += 6) {
    const host = `${bytes[i]}.${bytes[i + 1]}.${bytes[i + 2]}.${bytes[i + 3]}`;
    const port = (bytes[i + 4] << 8) | bytes[i + 5];
    if (isPlausiblePeer(host, port)) out.push({ host, port });
  }
  return out;
}

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return 1800;
  return Math.max(60, Math.min(86_400, Math.trunc(value)));
}

function dedupePeers(peers: TrackerPeer[]): TrackerPeer[] {
  const seen = new Set<string>();
  const out: TrackerPeer[] = [];
  for (const peer of peers) {
    const key = `${peer.host}:${peer.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(peer);
  }
  return out;
}

/**
 * Reject loopback/private/link-local/multicast peers before asking the runtime
 * to open a socket. The runtime blocks most of these anyway, but filtering
 * early avoids burning connection slots and makes logs cleaner.
 */
export function isPlausiblePeer(host: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  if (!host || host.length > 253) return false;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && octets[2] === 100) return false;
    if (a === 203 && b === 0 && octets[2] === 113) return false;
    if (a >= 224) return false;
    return true;
  }

  // IPv6 literals are not emitted by the compact IPv4 path; non-compact
  // trackers occasionally return hostnames. Accept syntactically valid names.
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
    host,
  );
}

/** Exported for tests. */
