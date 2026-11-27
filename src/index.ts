import type { Env } from "./env";
import { FREE_LIMITS, LIMITS } from "./lib/limits";
import { readRequestBodyCapped } from "./lib/http";
import { parseTorrent } from "./bittorrent/torrent";
import {
  parseFilesParam,
  parseRangesParam,
  resolveSelection,
  type SelectionInput,
} from "./bittorrent/selection";
import { torrentObjectKey } from "./storage/keys";
import { parseMagnet } from "./bittorrent/magnet";
import { fetchMetadata } from "./bittorrent/metadata";
import { buildTorrentFromInfo } from "./bittorrent/torrent-builder";
import { normalizeTrackerUrls } from "./bittorrent/tracker-url";
import { makePeerId } from "./lib/peer-id";
import { estimateR2Storage, PRICING_AS_OF } from "./lib/pricing";
import { UI_HTML } from "./ui";

export { TorrentSession } from "./do/TorrentSession";

interface TorrentStatus {
  id: string;
  name: string;
  status: string;
  outputKey: string | null;
  manifestKey: string | null;
  progress: number;
  verifiedBytes: number;
  wantedBytes: number;
  lastError: string | null;
  usage?: { storedBytes: number };
  estimatedCost?: { total: number };
}

interface MagnetRequest {
  magnet?: string;
  trackers?: string[] | string;
  files?: number[];
  ranges?: Array<{ start: number; end: number }>;
  autostart?: boolean;
  freeOnly?: boolean;
}

interface ListedObject {
  key: string;
  size: number;
  uploaded: string;
  etag: string;
  contentType: string | null;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};

const ALLOWED_PREFIXES = ["downloads/", "staging/", "torrents/"] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(UI_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/api" || url.pathname === "/api/") {
      return json(apiDescription(env));
    }

    if (
      url.pathname.startsWith("/api/") &&
      env.API_TOKEN &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !authorized(request, env)
    ) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      if (request.method === "POST" && url.pathname === "/api/torrents/inspect") {
        return await inspectTorrent(request);
      }

      if (request.method === "POST" && url.pathname === "/api/torrents") {
        return await createTorrent(request, env, url);
      }

      if (request.method === "POST" && url.pathname === "/api/magnets/inspect") {
        return await inspectMagnet(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/magnets") {
        return await createMagnet(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/files") {
        return await listFiles(request, env, url);
      }

      if (url.pathname === "/api/files/object") {
        if (request.method === "GET") return await serveR2Object(env, url);
        if (request.method === "DELETE") return await deleteR2Object(env, url);
        return json({ error: "method not allowed" }, 405);
      }

      if (request.method === "GET" && url.pathname === "/api/cost") {
        return await r2Cost(env);
      }

      if (request.method === "DELETE" && url.pathname === "/api/all") {
        return await deleteAll(env);
      }

      const route = parseTorrentRoute(url.pathname);
      if (!route) return json({ error: "not found" }, 404);

      const stub = env.TORRENT_SESSION.getByName(route.id);

      if (request.method === "GET" && !route.action) {
        const suffix = url.searchParams.get("bits") === "1" ? "?bits=1" : "";
        return await stub.fetch(`https://do.internal/status${suffix}`);
      }

      if (request.method === "GET" && route.action === "download") {
        return await downloadObject(stub, env);
      }

      if (request.method === "GET" && route.action === "manifest") {
        return await downloadManifest(stub, env);
      }

      if (request.method === "POST" && route.action === "start") {
        return await stub.fetch("https://do.internal/start", { method: "POST" });
      }

      if (request.method === "POST" && route.action === "pause") {
        return await stub.fetch("https://do.internal/pause", { method: "POST" });
      }

      if (request.method === "POST" && route.action === "tick") {
        return await stub.fetch("https://do.internal/tick", { method: "POST" });
      }

      if (request.method === "POST" && route.action === "trackers") {
        const body = await request.text();
        if (!body) return json({ error: "expected a JSON body with tracker URLs" }, 400);
        return await stub.fetch("https://do.internal/trackers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
      }

      if (request.method === "POST" && route.action === "cleanup") {
        return await stub.fetch("https://do.internal/cleanup", { method: "POST" });
      }

      if (request.method === "DELETE" && !route.action) {
        return await stub.fetch("https://do.internal/", { method: "DELETE" });
      }

      return json({ error: "method not allowed" }, 405);
    } catch (error) {
      console.error("worker request failed", error);
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 400);
    }
  },
} satisfies ExportedHandler<Env>;

// -----------------------------------------------------------------------------
// Torrent creation
// -----------------------------------------------------------------------------

async function inspectTorrent(request: Request): Promise<Response> {
  const bytes = await readRequestBodyCapped(request, LIMITS.maxTorrentBytes);
  if (bytes.length === 0) return json({ error: "request body must be a .torrent file" }, 400);

  const meta = await parseTorrent(bytes);
  return json({
    infoHash: meta.infoHashHex,
    name: meta.name,
    pieceLength: meta.pieceLength,
    pieceCount: meta.pieceCount,
    totalLength: meta.totalLength,
    files: meta.files,
    trackers: meta.trackers,
  });
}

async function createTorrent(request: Request, env: Env, url: URL): Promise<Response> {
  const bytes = await readRequestBodyCapped(request, LIMITS.maxTorrentBytes);
  if (bytes.length === 0) return json({ error: "request body must be a .torrent file" }, 400);

  const meta = await parseTorrent(bytes);
  const selection: SelectionInput = {
    files: parseFilesParam(url.searchParams.get("files")),
    ranges: parseRangesParam(url.searchParams.get("ranges")),
  };
  resolveSelection(meta, selection);

  const extraTrackers = normalizeTrackerUrls(url.searchParams.get("trackers"));
  const torrentKey = torrentObjectKey(meta.infoHashHex);
  await env.BLOBS.put(torrentKey, bytes, {
    httpMetadata: { contentType: "application/x-bittorrent" },
    customMetadata: { infoHash: meta.infoHashHex, name: meta.name },
  });

  const stub = env.TORRENT_SESSION.getByName(meta.infoHashHex);
  return await stub.fetch("https://do.internal/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: meta.infoHashHex,
      torrentKey,
      selection,
      autostart: url.searchParams.get("start") !== "0",
      freeOnly: url.searchParams.get("freeOnly") !== "0",
      extraTrackers,
    }),
  });
}

async function createMagnet(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as MagnetRequest;
  const prepared = await prepareMagnet(body, env);
  const { magnet, meta, trackers } = prepared;

  const selection: SelectionInput = {
    files: body.files,
    ranges: body.ranges,
  };
  resolveSelection(meta, selection);

  const torrentKey = torrentObjectKey(meta.infoHashHex);
  const stub = env.TORRENT_SESSION.getByName(meta.infoHashHex);
  const initialized = await stub.fetch("https://do.internal/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: meta.infoHashHex,
      torrentKey,
      selection,
      autostart: body.autostart !== false,
      freeOnly: body.freeOnly !== false,
      extraTrackers: trackers,
    }),
  });

  const text = await initialized.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { error: text };
  }
  if (!initialized.ok) return json(data, initialized.status);

  return json({
    ...data,
    magnet: {
      metadataPeer: prepared.metadataPeer ?? null,
      peersDiscovered: prepared.metadataPeers ?? 0,
      cached: !prepared.fetched,
      trackers,
    },
  });
}

async function inspectMagnet(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as MagnetRequest;
  const prepared = await prepareMagnet(body, env);
  const meta = prepared.meta;
  return json({
    infoHash: meta.infoHashHex,
    name: meta.name,
    pieceLength: meta.pieceLength,
    pieceCount: meta.pieceCount,
    totalLength: meta.totalLength,
    files: meta.files,
    trackers: prepared.trackers,
    source: "magnet",
    cached: !prepared.fetched,
  });
}

async function prepareMagnet(body: MagnetRequest, env: Env) {
  const magnet = parseMagnet(String(body.magnet ?? ""));
  const trackers = normalizeTrackerUrls([
    ...magnet.trackers,
    ...normalizeTrackerUrls(body.trackers),
  ]);
  if (trackers.length === 0) {
    throw new Error(
      "magnet has no HTTP(S) tracker; DHT is not available on Workers, so add a tracker URL explicitly",
    );
  }

  const torrentKey = torrentObjectKey(magnet.infoHashHex);
  const existing = await env.BLOBS.get(torrentKey);
  if (existing) {
    const torrent = new Uint8Array(await existing.arrayBuffer());
    const meta = await parseTorrent(torrent);
    if (meta.infoHashHex !== magnet.infoHashHex) {
      throw new Error("stored magnet torrent does not match the requested info hash");
    }
    return {
      magnet,
      trackers: normalizeTrackerUrls([...meta.trackers, ...trackers]),
      meta,
      fetched: false,
      metadataPeer: undefined,
      metadataPeers: undefined,
    };
  }

  const metadata = await fetchMetadata({
    infoHash: magnet.infoHash,
    trackers,
    peerId: makePeerId(),
    timeoutMs: 45_000,
    log: (message) => console.log("[magnet]", message),
  });
  const torrent = buildTorrentFromInfo(metadata.infoBytes, trackers);
  const meta = await parseTorrent(torrent);
  if (meta.infoHashHex !== magnet.infoHashHex) {
    throw new Error("magnet metadata does not match the requested info hash");
  }

  await env.BLOBS.put(torrentKey, torrent, {
    httpMetadata: { contentType: "application/x-bittorrent" },
    customMetadata: {
      infoHash: meta.infoHashHex,
      name: meta.name,
      source: "magnet",
    },
  });

  return {
    magnet,
    trackers: normalizeTrackerUrls([...meta.trackers, ...trackers]),
    meta,
    fetched: true,
    metadataPeer: `${metadata.peerHost}:${metadata.peerPort}`,
    metadataPeers: metadata.peerCount,
  };
}

// -----------------------------------------------------------------------------
// Task output
// -----------------------------------------------------------------------------

async function downloadObject(stub: DurableObjectStub, env: Env): Promise<Response> {
  const status = await readStatus(stub);
  if (!status || status.status !== "completed" || !status.outputKey) {
    return json({ error: "torrent is not completed yet", status: status?.status ?? "unknown" }, 409);
  }

  const object = await env.BLOBS.get(status.outputKey);
  if (!object) return json({ error: "completed object is missing from R2" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  headers.set("content-disposition", contentDisposition(status.name));
  return new Response(object.body, { headers });
}

async function downloadManifest(stub: DurableObjectStub, env: Env): Promise<Response> {
  const status = await readStatus(stub);
  if (!status?.manifestKey) {
    return json({ error: "manifest is not available yet", status: status?.status ?? "unknown" }, 409);
  }

  const object = await env.BLOBS.get(status.manifestKey);
  if (!object) return json({ error: "manifest is missing from R2" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  headers.set("content-disposition", `attachment; filename="${status.id}.manifest.json"`);
  return new Response(object.body, { headers });
}

async function readStatus(stub: DurableObjectStub): Promise<TorrentStatus | null> {
  const response = await stub.fetch("https://do.internal/status");
  if (!response.ok) return null;
  return (await response.json()) as TorrentStatus;
}

// -----------------------------------------------------------------------------
// R2 file manager
// -----------------------------------------------------------------------------

async function listFiles(request: Request, env: Env, url: URL): Promise<Response> {
  const prefix = url.searchParams.get("prefix") ?? "";
  if (!prefixAllowed(prefix)) return json({ error: "prefix is not allowed" }, 400);

  const all = url.searchParams.get("all") === "1";
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = all
    ? 1000
    : Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));

  const result = await collectObjects(env, prefix, cursor, limit, all);
  return json({
    prefix,
    objects: result.objects,
    cursor: result.cursor,
    truncated: result.truncated,
    listingCapped: result.listingCapped,
    pageBytes: result.pageBytes,
    totalBytes: all ? result.totalBytes : undefined,
    objectCount: all ? result.objects.length : undefined,
    estimatedStorage: all ? estimateR2Storage(result.totalBytes) : undefined,
  });
}

async function r2Cost(env: Env): Promise<Response> {
  const result = await collectObjects(env, "", undefined, 1000, true);
  return json({
    objectCount: result.objects.length,
    bytes: result.totalBytes,
    listingCapped: result.listingCapped,
    estimatedStorage: estimateR2Storage(result.totalBytes),
    pricingAsOf: PRICING_AS_OF,
    note:
      "R2 storage only. Per-task Workers/DO/SQLite estimates are returned in each task status. " +
      "The 10 GB R2 free allowance is account-wide and is not applied per object.",
  });
}

/**
 * Destructive maintenance endpoint: remove every DurableTorrent task and every
 * R2 object under the three known prefixes.
 *
 * Task IDs are discovered from the union of torrent/download/staging keys, so
 * objects left behind by a failed task are removed too. A task whose torrent
 * object was manually deleted cannot be discovered without a global index.
 */
async function deleteAll(env: Env): Promise<Response> {
  const prefixes = ["torrents/", "downloads/", "staging/"] as const;
  const keys: string[] = [];
  const ids = new Set<string>();

  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const listed = await env.BLOBS.list({ prefix, cursor, limit: 1000 });
      for (const object of listed.objects) {
        keys.push(object.key);
        const match = /^(?:torrents|downloads|staging)\/([0-9a-f]{40})(?:\/|\.torrent$)/.exec(
          object.key,
        );
        if (match) ids.add(match[1]);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  const errors: string[] = [];
  let tasksDeleted = 0;
  for (const id of ids) {
    try {
      await env.TORRENT_SESSION.getByName(id).fetch("https://do.internal/", { method: "DELETE" });
      tasksDeleted++;
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (let offset = 0; offset < keys.length; offset += 1000) {
    try {
      await env.BLOBS.delete(keys.slice(offset, offset + 1000));
    } catch (error) {
      errors.push(`R2 delete: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }

  return json({
    deleted: true,
    tasksDeleted,
    objectsDeleted: keys.length,
    errors: errors.slice(0, 20),
  });
}

async function collectObjects(
  env: Env,
  prefix: string,
  startCursor: string | undefined,
  limit: number,
  all: boolean,
): Promise<{
  objects: ListedObject[];
  cursor: string | null;
  truncated: boolean;
  listingCapped: boolean;
  pageBytes: number;
  totalBytes: number;
}> {
  const objects: ListedObject[] = [];
  let cursor = startCursor;
  let truncated = false;
  let pages = 0;
  let totalBytes = 0;
  let listingCapped = false;

  while (true) {
    const listed = await env.BLOBS.list({
      prefix,
      cursor,
      limit: all ? 1000 : limit,
      include: ["httpMetadata"],
    });

    for (const object of listed.objects) {
      objects.push({
        key: object.key,
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        etag: object.etag,
        contentType: object.httpMetadata?.contentType ?? null,
      });
      totalBytes += object.size;
    }

    truncated = listed.truncated;
    cursor = listed.truncated ? listed.cursor : undefined;
    pages++;

    if (!all) break;
    if (!truncated || pages >= 10 || objects.length >= 10_000) {
      listingCapped = truncated;
      break;
    }
  }

  return {
    objects,
    cursor: cursor ?? null,
    truncated,
    listingCapped,
    pageBytes: totalBytes,
    totalBytes,
  };
}

async function serveR2Object(env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get("key");
  if (!key || !keyAllowed(key)) return json({ error: "key is not allowed" }, 400);

  const object = await env.BLOBS.get(key);
  if (!object) return json({ error: "object not found" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  headers.set("content-disposition", contentDisposition(key.split("/").pop() ?? "object"));
  return new Response(object.body, { headers });
}

async function deleteR2Object(env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get("key");
  if (!key || !keyAllowed(key)) return json({ error: "key is not allowed" }, 400);

  await env.BLOBS.delete(key);
  return json({ deleted: true, key });
}

// -----------------------------------------------------------------------------
// Routing / helpers
// -----------------------------------------------------------------------------

function parseTorrentRoute(
  pathname: string,
):
  | {
      id: string;
      action: "start" | "pause" | "tick" | "download" | "manifest" | "trackers" | "cleanup" | null;
    }
  | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "torrents") return null;
  const id = parts[2];
  if (!/^[0-9a-f]{40}$/.test(id)) return null;

  const action = parts.length === 4 ? parts[3] : null;
  if (
    action &&
    !["start", "pause", "tick", "download", "manifest", "trackers", "cleanup"].includes(action)
  ) {
    return null;
  }
  return {
    id,
    action: action as
      | "start"
      | "pause"
      | "tick"
      | "download"
      | "manifest"
      | "trackers"
      | "cleanup"
      | null,
  };
}

function authorized(request: Request, env: Env): boolean {
  return Boolean(env.API_TOKEN) && request.headers.get("authorization") === `Bearer ${env.API_TOKEN}`;
}

function keyAllowed(key: string): boolean {
  if (key.includes("\u0000")) return false;
  return ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function prefixAllowed(prefix: string): boolean {
  if (prefix === "") return true;
  return ALLOWED_PREFIXES.some((allowed) => allowed.startsWith(prefix));
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function apiDescription(env: Env): Record<string, unknown> {
  return {
    name: "durabletorrent",
    description:
      "Minimal outbound-only BitTorrent downloader on Workers + Durable Objects (SQLite) + R2.",
    auth: {
      reads: "public",
      mutations: env.API_TOKEN ? "admin-token" : "open",
    },
    endpoints: {
      "GET /": "drag-and-drop UI",
      "POST /api/torrents/inspect": "parse a .torrent and return its files without creating a task",
      "POST /api/torrents?files=0,2&ranges=0-1048575&trackers=https://...&start=1":
        "upload a .torrent as the raw request body",
      "POST /api/magnets": "JSON body { magnet, trackers?, files?, ranges? } — resolves BEP 9 metadata",
      "POST /api/magnets/inspect": "resolve magnet metadata and return its files for selection",
      "GET /api/torrents/:infoHash": "task status (includes estimatedCost)",
      "GET /api/torrents/:infoHash?bits=1": "status plus the verified piece bitfield",
      "POST /api/torrents/:infoHash/start": "resume a paused/queued task",
      "POST /api/torrents/:infoHash/pause": "pause scheduling",
      "POST /api/torrents/:infoHash/tick": "run one scheduler cycle immediately (debug)",
      "POST /api/torrents/:infoHash/trackers": "JSON body { urls: [...] } — add HTTP(S) trackers",
      "POST /api/torrents/:infoHash/cleanup": "delete staging objects for a completed transfer",
      "GET /api/torrents/:infoHash/download": "stream the completed R2 object",
      "GET /api/torrents/:infoHash/manifest": "download the JSON manifest",
      "DELETE /api/torrents/:infoHash": "delete the session and its R2 objects",
      "DELETE /api/all": "delete every task and every R2 object (destructive)",
      "GET /api/files?prefix=&cursor=&limit=&all=1": "list R2 objects",
      "GET /api/files/object?key=": "stream one R2 object",
      "DELETE /api/files/object?key=": "delete one R2 object",
      "GET /api/cost": "R2 storage size and estimated monthly list price",
    },
    limits: {
      maxTorrentBytes: LIMITS.maxTorrentBytes,
      maxPieces: LIMITS.maxPieces,
      maxFiles: LIMITS.maxFiles,
      maxPieceLength: LIMITS.maxPieceLength,
      maxPeers: LIMITS.maxPeers,
    },
    freeOnly: FREE_LIMITS,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}
