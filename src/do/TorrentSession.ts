import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  bytesEqual,
  clamp,
  exactArrayBuffer,
  parsePositiveInt,
  toHex,
  toUint8Array,
} from "../lib/bytes";
import { sha1Bytes } from "../lib/hash";
import { FAKE_LISTEN_PORT, FREE_LIMITS, LIMITS } from "../lib/limits";
import { parseTorrent, pieceLengthAt, type TorrentFile, type TorrentMeta } from "../bittorrent/torrent";
import {
  resolveSelection,
  type ResolvedSelection,
  type SelectionInput,
  type SelectionRange,
} from "../bittorrent/selection";
import { BitField } from "../bittorrent/bitfield";
import { PieceQueue } from "../bittorrent/piece-queue";
import {
  runPeerDownload,
  type ClaimedPiece,
  type CommitResult,
  type PeerDownloadHooks,
  type PeerDownloadStats,
} from "../bittorrent/peer-download";
import { announceTracker } from "../bittorrent/tracker";
import { normalizeTrackerUrls } from "../bittorrent/tracker-url";
import { estimateTaskCost } from "../lib/pricing";
import { makePeerId } from "../lib/peer-id";
import {
  manifestObjectKey,
  outputObjectKey,
  stagingPieceKey,
  stagingPrefix,
  torrentObjectKey,
} from "../storage/keys";
import {
  buildOutputRanges,
  MissingStagedPieceError,
  OutputReader,
  type OutputRange,
} from "../storage/output";
import {
  ensureSchema,
  getTask,
  queryAll,
  queryOne,
  type PeerRow,
  type PieceRow,
  type SqlRowValue,
  type TaskRow,
  type TaskStatus,
  type TrackerRow,
} from "./schema";

const MAX_R2_PART_SIZE = 64 * 1024 * 1024;
const MIN_WAVE_BYTES = 8 * 1024 * 1024;
const MAX_WAVE_BYTES = 256 * 1024 * 1024;

interface InitRequest {
  id: string;
  torrentKey: string;
  selection?: SelectionInput;
  autostart?: boolean;
  extraTrackers?: string[] | string;
  freeOnly?: boolean;
}

interface StoredSelection {
  input: SelectionInput;
  ranges: SelectionRange[];
  wantedBytes: number;
  outputBytes: number;
}

interface WaveState {
  bits: BitField;
  verifiedBytes: number;
  verifiedPieces: number;
  verifiedThisWave: number;
  bytesThisWave: number;
  peerCount: number;
  note: string | null;
}

/**
 * One Durable Object == one torrent session. The object owns:
 *  - the SQLite state machine and piece bitfield,
 *  - the alarm-driven download waves (at most 6 outbound TCP peers),
 *  - R2 staging of verified pieces,
 *  - the resumable R2 multipart assembly.
 *
 * It never accepts inbound connections and never unchokes a peer, so it cannot
 * seed. `uploaded` is always reported as 0 to trackers.
 */
export class TorrentSession extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private busy = false;
  private stopRequested = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ensureSchema(this.sql);
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      // Count every DO request for the cost estimate. Until /init has created
      // the singleton task row this is a no-op.
      this.sql.exec(
        "UPDATE task SET do_requests=do_requests+1 WHERE id=(SELECT id FROM task LIMIT 1)",
      );

      const url = new URL(request.url);
      const route = `${request.method.toUpperCase()} ${url.pathname}`;

      switch (route) {
        case "POST /init":
          return await this.handleInit(request);
        case "GET /status":
          return this.handleStatus(url);
        case "POST /start":
          return await this.handleStart();
        case "POST /pause":
          return await this.handlePause();
        case "POST /tick":
          return await this.handleTick();
        case "POST /trackers":
          return await this.handleTrackers(request);
        case "POST /cleanup":
          return await this.handleCleanup();
        case "DELETE /":
          return await this.handleDelete();
        default:
          return json({ error: `unknown route: ${route}` }, 404);
      }
    } catch (error) {
      console.error("torrent session request failed", error);
      return json({ error: messageOf(error) }, 400);
    }
  }

  override async alarm(): Promise<void> {
    if (this.busy) {
      await this.schedule(Date.now() + 1000);
      return;
    }

    this.busy = true;
    this.stopRequested = false;
    const started = Date.now();
    let ran = false;
    try {
      const task = getTask(this.sql);
      if (!task) return;
      if (task.status === "completed") {
        ran = true;
        if (task.staging_cleaned === 0) await this.cleanupStaging(task);
        return;
      }
      if (task.status === "paused" || task.status === "failed") return;
      if (task.status === "queued") return;
      ran = true;
      if (task.status === "finalizing") await this.runFinalize(task);
      else await this.runDownloadWave();
    } catch (error) {
      await this.handleWaveError(error);
    } finally {
      this.busy = false;
      if (ran) {
        this.sql.exec(
          "UPDATE task SET alarm_count=alarm_count+1, wave_duration_ms=wave_duration_ms+? WHERE id=(SELECT id FROM task LIMIT 1)",
          Math.max(0, Date.now() - started),
        );
      }
      await this.ensureAlarm();
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP surface (called only by the Worker through a DO stub)
  // ---------------------------------------------------------------------------

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as InitRequest;
    const id = String(body.id ?? "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(id)) throw new Error("invalid info hash");
    if (body.torrentKey !== torrentObjectKey(id)) {
      throw new Error("torrentKey does not match the advertised info hash");
    }

    const existing = getTask(this.sql);
    if (existing) return json(this.statusJson(existing));

    const object = await this.env.BLOBS.get(body.torrentKey);
    if (!object) throw new Error("torrent object is missing from R2");
    const raw = new Uint8Array(await object.arrayBuffer());
    const meta = await parseTorrent(raw);
    if (meta.infoHashHex !== id) throw new Error("info hash does not match the .torrent");

    const selection = body.selection ?? {};
    const resolved = resolveSelection(meta, selection);
    const maxOutputBytes = LIMITS.maxR2Parts * this.r2PartSize;
    if (resolved.outputBytes > maxOutputBytes) {
      throw new Error(
        `selection is ${resolved.outputBytes} bytes; with ${this.r2PartSize}-byte R2 parts the PoC limit is ${maxOutputBytes} bytes (10000 parts)`,
      );
    }

    const freeOnly = body.freeOnly !== false;
    const wantedPieces = resolved.wantedPieces.count();
    if (freeOnly) {
      if (meta.pieceCount > FREE_LIMITS.maxTotalPieces) {
        throw new Error(
          `free-only mode allows at most ${FREE_LIMITS.maxTotalPieces} total pieces, this torrent has ${meta.pieceCount}`,
        );
      }
      if (wantedPieces > FREE_LIMITS.maxWantedPieces) {
        throw new Error(
          `free-only mode allows at most ${FREE_LIMITS.maxWantedPieces} selected pieces, this selection needs ${wantedPieces}`,
        );
      }
      if (meta.pieceLength > FREE_LIMITS.maxPieceLength) {
        throw new Error(
          `free-only mode allows piece lengths up to ${FREE_LIMITS.maxPieceLength} bytes, this torrent uses ${meta.pieceLength}`,
        );
      }
      if (resolved.outputBytes > FREE_LIMITS.maxOutputBytes) {
        throw new Error(
          `free-only mode allows output up to ${FREE_LIMITS.maxOutputBytes} bytes, this selection is ${resolved.outputBytes}`,
        );
      }
      const bucketUsage = await this.r2UsageBytes();
      // Staging and the final output can coexist until cleanup, so reserve two
      // copies of the output inside the safety budget.
      if (bucketUsage + resolved.outputBytes * 2 + 2048 > FREE_LIMITS.maxBucketBytes) {
        throw new Error(
          `free-only mode keeps this bucket under ${FREE_LIMITS.maxBucketBytes} bytes; current usage is ${bucketUsage}, this output needs about ${resolved.outputBytes * 2} bytes including staging`,
        );
      }
    }

    const peerId = makePeerId();
    const outputName = chooseOutputName(meta, resolved);
    const outputKey = outputObjectKey(id, outputName);
    const manifestKey = manifestObjectKey(id);
    const allTrackers = normalizeTrackerUrls([
      ...meta.trackers,
      ...normalizeTrackerUrls(body.extraTrackers),
    ]);
    const now = Date.now();
    const status: TaskStatus = body.autostart === false ? "queued" : "downloading";
    const verifiedBitmap = new Uint8Array(Math.ceil(meta.pieceCount / 8));
    const selectionJson = JSON.stringify({
      input: selection,
      ranges: resolved.ranges,
      wantedBytes: resolved.wantedBytes,
      outputBytes: resolved.outputBytes,
    } satisfies StoredSelection);

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO task (
          id, info_hash, name, status, free_only, torrent_key, output_key, manifest_key,
          piece_length, piece_count, total_length, wanted_pieces, wanted_bytes, output_bytes,
          verified_pieces, verified_bytes, downloaded_bytes, wanted_bitmap, verified_bitmap,
          selection_json, files_json, trackers_json, peer_id,
          multipart_upload_id, multipart_parts_json, finalize_cursor, finalize_part,
          announcements, wave_count, consecutive_failures, last_error,
          created_at, updated_at, started_at, completed_at,
          torrent_bytes, do_requests, alarm_count, wave_duration_ms,
          r2_put_ops, r2_get_ops, tracker_requests, peer_connections, staging_cleaned
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        exactArrayBuffer(meta.infoHash),
        meta.name,
        status,
        freeOnly ? 1 : 0,
        body.torrentKey,
        outputKey,
        manifestKey,
        meta.pieceLength,
        meta.pieceCount,
        meta.totalLength,
        wantedPieces,
        resolved.wantedBytes,
        resolved.outputBytes,
        0,
        0,
        0,
        exactArrayBuffer(resolved.wantedPieces.toBytes()),
        exactArrayBuffer(verifiedBitmap),
        selectionJson,
        JSON.stringify(meta.files),
        JSON.stringify(allTrackers),
        exactArrayBuffer(peerId),
        null,
        null,
        0,
        1,
        0,
        0,
        0,
        null,
        now,
        now,
        status === "downloading" ? now : null,
        null,
        raw.length,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      );

      this.insertPieces(meta, resolved.wantedPieces);
      allTrackers.forEach((url, tier) => {
        this.sql.exec("INSERT OR IGNORE INTO tracker (url, tier) VALUES (?, ?)", url, tier);
      });
    });

    if (status === "downloading") await this.schedule(now + 100);
    this.sql.exec("UPDATE task SET r2_get_ops=r2_get_ops+1 WHERE id=?", id);
    return json(this.statusJson(getTask(this.sql)!));
  }

  private handleStatus(url: URL): Response {
    const task = getTask(this.sql);
    if (!task) return json({ error: "torrent session not found" }, 404);
    if (task.status === "completed" && task.staging_cleaned === 0) {
      // Old tasks may still have staging objects. Opening the task schedules a
      // one-shot cleanup, the same path new completions use. Do not reset an
      // alarm that is already pending.
      void this.ctx.storage
        .getAlarm()
        .then((alarm) => (alarm === null ? this.schedule(Date.now() + 100) : undefined))
        .catch(() => undefined);
    }
    return json(this.statusJson(task, url.searchParams.get("bits") === "1"));
  }

  private async handleStart(): Promise<Response> {
    const task = getTask(this.sql);
    if (!task) return json({ error: "torrent session not found" }, 404);
    if (task.status === "completed") return json(this.statusJson(task));

    const now = Date.now();
    this.stopRequested = false;
    this.sql.exec(
      "UPDATE task SET status='downloading', consecutive_failures=0, last_error=NULL, started_at=COALESCE(started_at, ?), updated_at=? WHERE id=?",
      now,
      now,
      task.id,
    );
    await this.schedule(now + 100);
    return json(this.statusJson(getTask(this.sql)!));
  }

  private async handlePause(): Promise<Response> {
    const task = getTask(this.sql);
    if (!task) return json({ error: "torrent session not found" }, 404);

    this.stopRequested = true;
    const now = Date.now();
    this.sql.exec("UPDATE task SET status='paused', updated_at=? WHERE id=?", now, task.id);
    await this.ctx.storage.deleteAlarm();
    return json(this.statusJson(getTask(this.sql)!));
  }

  private async handleTrackers(request: Request): Promise<Response> {
    const task = getTask(this.sql);
    if (!task) return json({ error: "torrent session not found" }, 404);

    const body = (await request.json()) as { urls?: string[] | string };
    const urls = normalizeTrackerUrls(body.urls);
    if (urls.length === 0) {
      return json({ error: "provide at least one http(s) tracker URL" }, 400);
    }

    for (const url of urls) {
      this.sql.exec(
        `INSERT INTO tracker (url, tier, next_announce) VALUES (?, 1000, 0)
         ON CONFLICT(url) DO UPDATE SET next_announce=0`,
        url,
      );
    }

    if (task.status === "downloading") await this.schedule(Date.now() + 100);
    return json(this.statusJson(getTask(this.sql)!));
  }

  private async handleCleanup(): Promise<Response> {
    const task = getTask(this.sql);
    if (!task) return json({ error: "torrent session not found" }, 404);
    if (task.status !== "completed") {
      return json({ error: "only a completed transfer can clean staging" }, 409);
    }

    if (task.staging_cleaned === 0) await this.cleanupStaging(task);
    return json(this.statusJson(getTask(this.sql)!));
  }

  private async handleTick(): Promise<Response> {
    if (this.busy) return json({ error: "session is busy" }, 409);
    await this.alarm();
    const task = getTask(this.sql);
    return task ? json(this.statusJson(task)) : json({ error: "torrent session not found" }, 404);
  }

  private async handleDelete(): Promise<Response> {
    if (this.busy) return json({ error: "session is busy" }, 409);
    const task = getTask(this.sql);
    if (!task) {
      await this.ctx.storage.deleteAll();
      ensureSchema(this.sql);
      return json({ deleted: true });
    }

    const cleanupErrors: string[] = [];
    await this.ctx.storage.deleteAlarm().catch(() => undefined);

    if (task.multipart_upload_id && task.output_key) {
      await this.env.BLOBS.resumeMultipartUpload(task.output_key, task.multipart_upload_id)
        .abort()
        .catch((error: unknown) => cleanupErrors.push(`multipart abort: ${messageOf(error)}`));
    }

    try {
      await this.deletePrefix(stagingPrefix(task.id));
    } catch (error) {
      cleanupErrors.push(`staging cleanup: ${messageOf(error)}`);
    }

    const objectKeys = [task.torrent_key, task.output_key, task.manifest_key].filter(
      (key): key is string => Boolean(key),
    );
    if (objectKeys.length > 0) {
      try {
        await this.env.BLOBS.delete(objectKeys);
      } catch (error) {
        cleanupErrors.push(`object cleanup: ${messageOf(error)}`);
      }
    }

    await this.ctx.storage.deleteAll();
    ensureSchema(this.sql);
    return json({ deleted: true, id: task.id, cleanupErrors });
  }

  // ---------------------------------------------------------------------------
  // Download wave
  // ---------------------------------------------------------------------------

  private async runDownloadWave(): Promise<void> {
    const task = getTask(this.sql);
    if (!task || task.status !== "downloading") return;

    this.sql.exec("UPDATE piece SET state='missing', peer=NULL WHERE state='inflight'");

    const progress = this.rebuildProgress(task);
    const verifiedBits = progress.bits;
    let verifiedBytes = progress.verifiedBytes;
    let verifiedPieces = progress.verifiedPieces;

    if (verifiedPieces >= task.wanted_pieces) {
      await this.markFinalizing(task);
      return;
    }

    const missingRows = queryAll<{ idx: number } & Record<string, SqlRowValue>>(
      this.sql,
      "SELECT idx FROM piece WHERE state != 'verified' AND attempts < ? ORDER BY idx",
      LIMITS.maxPieceAttempts,
    );
    if (missingRows.length === 0) {
      const now = Date.now();
      this.sql.exec(
        "UPDATE task SET last_error=?, consecutive_failures=consecutive_failures+1, updated_at=? WHERE id=?",
        "all remaining pieces exceeded the per-piece attempt limit",
        now,
        task.id,
      );
      await this.schedule(now + 15 * 60_000);
      return;
    }

    const waveDeadline = Date.now() + LIMITS.maxWaveMs;
    await this.announceIfNeeded(task, waveDeadline, verifiedBytes);

    const peerRows = queryAll<PeerRow>(
      this.sql,
      "SELECT * FROM peer WHERE banned_until IS NULL OR banned_until < ? ORDER BY COALESCE(last_seen, 0) DESC LIMIT 100",
      Date.now(),
    );
    const freeOnly = task.free_only === 1;
    const peerLimit = freeOnly
      ? Math.min(this.maxPeers, FREE_LIMITS.maxPeers)
      : this.maxPeers;
    const selected = this.selectPeers(peerRows, peerLimit);
    if (selected.length > 0) {
      this.sql.exec(
        "UPDATE task SET peer_connections=peer_connections+? WHERE id=?",
        selected.length,
        task.id,
      );
    }

    if (selected.length === 0) {
      const trackerCount =
        queryOne<{ n: number } & Record<string, SqlRowValue>>(
          this.sql,
          "SELECT COUNT(*) AS n FROM tracker",
        )?.n ?? 0;
      await this.finishWave(task, {
        bits: verifiedBits,
        verifiedBytes,
        verifiedPieces,
        verifiedThisWave: 0,
        bytesThisWave: 0,
        peerCount: 0,
        note:
          trackerCount === 0
            ? "torrent has no HTTP/HTTPS trackers"
            : "no usable peers announced yet",
      });
      return;
    }

    const queue = new PieceQueue(missingRows.map((row) => row.idx));
    const claimed = new Set<number>();
    let bytesThisWave = 0;
    let verifiedThisWave = 0;
    const maxWaveBytes = freeOnly
      ? Math.min(this.maxWaveBytes, FREE_LIMITS.maxWaveBytes)
      : this.maxWaveBytes;

    const hooks: PeerDownloadHooks = {
      claim: (has): ClaimedPiece | null => {
        for (let attempt = 0; attempt < 64; attempt++) {
          const index = queue.take(has);
          if (index === null) return null;
          if (claimed.has(index) || verifiedBits.get(index)) continue;
          claimed.add(index);
          return {
            index,
            length: Math.min(
              task.piece_length,
              task.total_length - index * task.piece_length,
            ),
          };
        }
        return null;
      },

      release: (index: number): void => {
        claimed.delete(index);
        queue.release(index);
      },

      commit: async (index: number, data: Uint8Array, peer: string): Promise<CommitResult> => {
        const row = queryOne<{ hash: ArrayBuffer; attempts: number } & Record<string, SqlRowValue>>(
          this.sql,
          "SELECT hash, attempts FROM piece WHERE idx = ?",
          index,
        );
        if (!row) return "storage-error";

        const expected = toUint8Array(row.hash);
        const actual = await sha1Bytes(data);
        if (!bytesEqual(expected, actual)) {
          const attempts = row.attempts + 1;
          this.sql.exec(
            "UPDATE piece SET state='missing', attempts=?, peer=?, verified_at=NULL WHERE idx=?",
            attempts,
            peer,
            index,
          );
          claimed.delete(index);
          if (attempts < LIMITS.maxPieceAttempts) queue.release(index);
          return "hash-mismatch";
        }

        const key = stagingPieceKey(task.id, index, task.piece_count);
        let stored = false;
        for (let attempt = 0; attempt < 2 && !stored; attempt++) {
          try {
            await this.env.BLOBS.put(key, data, {
              customMetadata: {
                infoHash: task.id,
                piece: String(index),
                sha1: toHex(actual),
              },
            });
            stored = true;
          } catch (error) {
            if (attempt === 0) await sleep(200);
            else console.warn("R2 staging put failed", task.id, index, messageOf(error));
          }
        }

        if (!stored) {
          // A storage failure is not the peer's fault and must not consume the
          // piece's bad-data attempt budget.
          this.sql.exec(
            "UPDATE piece SET state='missing', peer=NULL WHERE idx=?",
            index,
          );
          claimed.delete(index);
          queue.release(index);
          return "storage-error";
        }

        this.sql.exec(
          "UPDATE task SET r2_put_ops=r2_put_ops+1 WHERE id=?",
          task.id,
        );

        const now = Date.now();
        this.sql.exec(
          "UPDATE piece SET state='verified', verified_at=?, peer=? WHERE idx=?",
          now,
          peer,
          index,
        );
        verifiedBits.set(index);
        verifiedBytes += data.length;
        verifiedPieces++;
        verifiedThisWave++;
        bytesThisWave += data.length;
        claimed.delete(index);

        if (verifiedThisWave % 8 === 0) {
          this.flushProgress(task, verifiedBits, verifiedBytes, verifiedPieces, now);
        }
        return "ok";
      },

      expired: (): boolean =>
        this.stopRequested || Date.now() >= waveDeadline || bytesThisWave >= maxWaveBytes,

      badPeer: (peer: string, reason: string): void => {
        this.sql.exec(
          "UPDATE peer SET state='banned', banned_until=?, fail_count=fail_count+1, last_error=? WHERE addr=?",
          Date.now() + LIMITS.peerBanMs,
          reason,
          peer,
        );
      },

      log: (message: string): void => {
        console.log(`[torrent ${task.id}] ${message}`);
      },
    };

    const infoHash = toUint8Array(task.info_hash);
    const peerId = toUint8Array(task.peer_id);
    const results: PeerDownloadStats[] = await Promise.all(
      selected.map((peer) =>
        runPeerDownload({
          host: peer.host,
          port: peer.port,
          infoHash,
          peerId,
          pieceCount: task.piece_count,
          deadline: waveDeadline,
          hooks,
        }),
      ),
    );
    for (const result of results) this.recordPeerResult(result);

    // A peer that was killed mid-piece leaves durable 'inflight' rows behind.
    this.sql.exec("UPDATE piece SET state='missing', peer=NULL WHERE state='inflight'");

    await this.finishWave(task, {
      bits: verifiedBits,
      verifiedBytes,
      verifiedPieces,
      verifiedThisWave,
      bytesThisWave,
      peerCount: selected.length,
      note: verifiedThisWave > 0 ? null : "peers connected but made no progress",
    });
  }

  private async finishWave(task: TaskRow, state: WaveState): Promise<void> {
    const fresh = getTask(this.sql);
    if (!fresh) return;

    const now = Date.now();
    const failures = state.verifiedThisWave > 0 ? 0 : fresh.consecutive_failures + 1;
    this.flushProgress(fresh, state.bits, state.verifiedBytes, state.verifiedPieces, now);
    this.sql.exec(
      "UPDATE task SET wave_count=wave_count+1, consecutive_failures=?, last_error=?, updated_at=? WHERE id=?",
      failures,
      state.note,
      now,
      fresh.id,
    );

    if (fresh.status === "paused" || fresh.status === "completed" || fresh.status === "failed") return;

    if (state.verifiedPieces >= fresh.wanted_pieces) {
      await this.markFinalizing(fresh);
      return;
    }

    if (this.stopRequested) return;

    const delay = state.verifiedThisWave > 0 ? 1000 : backoffMs(failures);
    this.sql.exec(
      "UPDATE task SET status='downloading', updated_at=? WHERE id=? AND status='downloading'",
      now,
      fresh.id,
    );
    await this.schedule(now + delay);
  }

  private async markFinalizing(task: TaskRow): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      "UPDATE task SET status='finalizing', last_error=NULL, updated_at=? WHERE id=? AND status='downloading'",
      now,
      task.id,
    );
    await this.schedule(now + 100);
  }

  // ---------------------------------------------------------------------------
  // Tracker / peer bookkeeping
  // ---------------------------------------------------------------------------

  private async announceIfNeeded(task: TaskRow, deadline: number, verifiedBytes: number): Promise<void> {
    const now = Date.now();
    const due = queryAll<TrackerRow>(
      this.sql,
      "SELECT * FROM tracker WHERE next_announce IS NULL OR next_announce <= ? ORDER BY tier ASC, url ASC LIMIT 8",
      now,
    );
    if (due.length === 0) return;

    let announced = 0;
    let foundPeers = 0;
    for (const tracker of due) {
      if (Date.now() > deadline - 30_000) break;
      const event: "started" | undefined =
        task.announcements === 0 && announced === 0 ? "started" : undefined;
      this.sql.exec(
        "UPDATE task SET tracker_requests=tracker_requests+1 WHERE id=?",
        task.id,
      );
      try {
        const response = await announceTracker({
          trackerUrl: tracker.url,
          infoHash: toUint8Array(task.info_hash),
          peerId: toUint8Array(task.peer_id),
          port: FAKE_LISTEN_PORT,
          uploaded: 0,
          downloaded: verifiedBytes,
          left: Math.max(0, task.wanted_bytes - verifiedBytes),
          event,
          numwant: 50,
          key: task.id.slice(0, 8),
          timeoutMs: 8000,
        });

        // Do not wait a full 30-minute tracker interval if the swarm is empty.
        const effectiveInterval = response.peers.length === 0
          ? Math.min(response.interval * 1000, 5 * 60_000)
          : response.interval * 1000;
        const next = Date.now() + effectiveInterval;
        this.sql.exec(
          "UPDATE tracker SET last_announce=?, next_announce=?, fails=0, last_error=NULL WHERE url=?",
          Date.now(),
          next,
          tracker.url,
        );
        this.addPeers(response.peers);
        announced++;
        foundPeers += response.peers.length;
        if (response.warning) console.warn("tracker warning", tracker.url, response.warning);
        if (foundPeers >= 30) break;
      } catch (error) {
        const fails = tracker.fails + 1;
        const next = Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(fails, 5));
        this.sql.exec(
          "UPDATE tracker SET fails=?, next_announce=?, last_error=? WHERE url=?",
          fails,
          next,
          messageOf(error),
          tracker.url,
        );
      }
    }

    if (announced > 0) {
      this.sql.exec("UPDATE task SET announcements=announcements+? WHERE id=?", announced, task.id);
    }
  }

  private addPeers(peers: Array<{ host: string; port: number }>): void {
    if (peers.length === 0) return;
    const now = Date.now();
    for (const peer of peers) {
      const addr = `${peer.host}:${peer.port}`;
      this.sql.exec(
        `INSERT INTO peer (addr, host, port, state, last_seen)
         VALUES (?, ?, ?, 'known', ?)
         ON CONFLICT(addr) DO UPDATE SET
           host=excluded.host,
           port=excluded.port,
           last_seen=excluded.last_seen,
           state=CASE WHEN state='banned' THEN state ELSE 'known' END`,
        addr,
        peer.host,
        peer.port,
        now,
      );
    }

    const count =
      queryOne<{ n: number } & Record<string, SqlRowValue>>(
        this.sql,
        "SELECT COUNT(*) AS n FROM peer",
      )?.n ?? 0;
    const excess = count - LIMITS.maxPeersInTable;
    if (excess > 0) {
      this.sql.exec(
        "DELETE FROM peer WHERE addr IN (SELECT addr FROM peer ORDER BY COALESCE(last_seen, 0) ASC LIMIT ?)",
        excess,
      );
    }
  }

  private selectPeers(rows: PeerRow[], limit: number): PeerRow[] {
    const now = Date.now();
    const eligible = rows.filter((peer) => !peer.banned_until || peer.banned_until < now);
    shuffle(eligible);
    eligible.sort((a, b) => {
      return (
        a.fail_count - b.fail_count ||
        b.success_count - a.success_count ||
        (b.last_seen ?? 0) - (a.last_seen ?? 0)
      );
    });
    return eligible.slice(0, limit);
  }

  private recordPeerResult(stats: PeerDownloadStats): void {
    const now = Date.now();
    const success = stats.downloaded > 0;
    const failure = !success && Boolean(stats.error);
    const mode = success ? 1 : failure ? 2 : 0;

    this.sql.exec(
      `UPDATE peer SET
         state='idle',
         downloaded=downloaded+?,
         last_seen=?,
         success_count=success_count+?,
         fail_count=CASE WHEN ?=1 THEN 0 WHEN ?=2 THEN fail_count+1 ELSE fail_count END,
         last_error=?,
         banned_until=CASE WHEN ?=2 AND fail_count+1 >= 3 THEN ? ELSE banned_until END
       WHERE addr=?`,
      stats.downloaded,
      now,
      success ? 1 : 0,
      mode,
      mode,
      stats.error ?? null,
      mode,
      now + LIMITS.peerBanMs,
      stats.peer,
    );
  }

  // ---------------------------------------------------------------------------
  // Resumable R2 multipart assembly
  // ---------------------------------------------------------------------------

  private async runFinalize(task: TaskRow): Promise<void> {
    const selection = safeJson<StoredSelection>(task.selection_json);
    if (!selection) throw new Error("stored selection is corrupt");

    const ranges = buildOutputRanges(selection.ranges);
    const reader = new OutputReader(
      this.env.BLOBS,
      task.id,
      task.piece_count,
      task.piece_length,
      task.total_length,
      ranges,
    );
    if (reader.outputBytes !== task.output_bytes) {
      throw new Error("stored output byte count does not match the selection ranges");
    }
    if (task.output_bytes <= 0) throw new Error("nothing to finalize");

    const aggregate =
      queryOne<{ n: number; total: number } & Record<string, SqlRowValue>>(
        this.sql,
        "SELECT COUNT(*) AS n, COALESCE(SUM(length), 0) AS total FROM piece WHERE state='verified'",
      ) ?? null;
    if ((aggregate?.n ?? 0) < task.wanted_pieces) {
      const now = Date.now();
      this.sql.exec(
        "UPDATE task SET status='downloading', last_error=?, updated_at=? WHERE id=?",
        "finalize requested before all wanted pieces were verified",
        now,
        task.id,
      );
      await this.schedule(now + 100);
      return;
    }

    const outputKey =
      task.output_key ?? outputObjectKey(task.id, `${task.name}.bin`);

    let upload: R2MultipartUpload;
    let isNew = false;
    if (task.multipart_upload_id) {
      upload = this.env.BLOBS.resumeMultipartUpload(outputKey, task.multipart_upload_id);
    } else {
      upload = await this.env.BLOBS.createMultipartUpload(outputKey, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { infoHash: task.id, name: task.name },
      });
      isNew = true;
      this.sql.exec(
        "UPDATE task SET output_key=?, multipart_upload_id=?, multipart_parts_json='[]', finalize_cursor=0, finalize_part=1, r2_put_ops=r2_put_ops+1, updated_at=? WHERE id=?",
        outputKey,
        upload.uploadId,
        Date.now(),
        task.id,
      );
    }

    const parts: R2UploadedPart[] = isNew
      ? []
      : parseParts(task.multipart_parts_json);
    let cursor = isNew ? 0 : task.finalize_cursor;
    let partNumber = isNew ? 1 : task.finalize_part;
    if (cursor < 0 || cursor > task.output_bytes || partNumber < 1) {
      throw new Error("stored multipart cursor is invalid");
    }

    const partSize = this.r2PartSize;
    if (partNumber > LIMITS.maxR2Parts) {
      throw new Error(
        `R2 part number ${partNumber} exceeds the ${LIMITS.maxR2Parts}-part limit; increase R2_PART_SIZE`,
      );
    }
    const partBuffer = new Uint8Array(partSize);
    let fill = 0;
    let partsThisAlarm = 0;
    const started = Date.now();

    try {
      while (cursor < task.output_bytes) {
        if (this.stopRequested) {
          await this.schedule(Date.now() + 1000);
          return;
        }
        if (
          Date.now() - started > LIMITS.maxFinalizeMs ||
          partsThisAlarm >= LIMITS.maxFinalizePartsPerAlarm
        ) {
          // The partial part buffer is intentionally discarded. The next run
          // resumes from the last durable part boundary.
          await this.schedule(Date.now() + 200);
          return;
        }

        const absolute = cursor + fill;
        const need = Math.min(partSize - fill, task.output_bytes - absolute);
        if (need <= 0) break;

        const chunk = await reader.read(absolute, need);
        this.sql.exec(
          "UPDATE task SET r2_get_ops=r2_get_ops+1 WHERE id=?",
          task.id,
        );
        partBuffer.set(chunk, fill);
        fill += chunk.length;

        if (fill === partSize || cursor + fill === task.output_bytes) {
          const uploaded = await upload.uploadPart(partNumber, partBuffer.slice(0, fill));
          parts.push({ partNumber: uploaded.partNumber, etag: uploaded.etag });
          cursor += fill;
          partNumber++;
          fill = 0;
          partsThisAlarm++;

          this.sql.exec(
            "UPDATE task SET multipart_parts_json=?, finalize_cursor=?, finalize_part=?, r2_put_ops=r2_put_ops+1, updated_at=? WHERE id=?",
            JSON.stringify(parts),
            cursor,
            partNumber,
            Date.now(),
            task.id,
          );
        }
      }

      const completed = await upload.complete(parts);
      await this.writeManifest(task, ranges, outputKey);
      const now = Date.now();
      this.sql.exec(
        "UPDATE task SET status='completed', completed_at=?, multipart_upload_id=NULL, multipart_parts_json=NULL, finalize_cursor=?, finalize_part=?, last_error=NULL, r2_put_ops=r2_put_ops+2, updated_at=? WHERE id=?",
        now,
        task.output_bytes,
        parts.length + 1,
        now,
        task.id,
      );
      console.log(
        JSON.stringify({
          event: "torrent_completed",
          id: task.id,
          outputKey,
          size: completed.size,
          parts: parts.length,
        }),
      );
    } catch (error) {
      if (error instanceof MissingStagedPieceError) {
        await upload.abort().catch(() => undefined);
        this.sql.exec(
          "UPDATE piece SET state='missing', attempts=attempts+1, peer=NULL WHERE idx=?",
          error.pieceIndex,
        );
        const now = Date.now();
        this.sql.exec(
          "UPDATE task SET status='downloading', multipart_upload_id=NULL, multipart_parts_json=NULL, finalize_cursor=0, finalize_part=1, last_error=?, updated_at=? WHERE id=?",
          `staged piece ${error.pieceIndex} disappeared; re-downloading`,
          now,
          task.id,
        );
        await this.schedule(now + 100);
        return;
      }
      if (isNoSuchUpload(error)) {
        // The upload may have completed before a crash prevented the DB update.
        // Recover from the final object if it exists and has the expected size.
        const existing = await this.env.BLOBS.head(outputKey);
        this.sql.exec("UPDATE task SET r2_get_ops=r2_get_ops+1 WHERE id=?", task.id);
        if (existing && existing.size === task.output_bytes) {
          await this.writeManifest(task, ranges, outputKey);
          const now = Date.now();
          this.sql.exec(
            "UPDATE task SET status='completed', completed_at=?, multipart_upload_id=NULL, multipart_parts_json=NULL, finalize_cursor=?, finalize_part=?, last_error=NULL, r2_put_ops=r2_put_ops+1, updated_at=? WHERE id=?",
            now,
            task.output_bytes,
            parts.length + 1,
            now,
            task.id,
          );
          return;
        }

        const now = Date.now();
        this.sql.exec(
          "UPDATE task SET multipart_upload_id=NULL, multipart_parts_json=NULL, finalize_cursor=0, finalize_part=1, updated_at=? WHERE id=?",
          now,
          task.id,
        );
        await this.schedule(now + 100);
        return;
      }
      throw error;
    }
  }

  private async writeManifest(
    task: TaskRow,
    ranges: OutputRange[],
    outputKey: string,
  ): Promise<void> {
    if (!task.manifest_key) throw new Error("manifest key is missing");
    const files = safeJsonArray<TorrentFile>(task.files_json);

    const manifestFiles = [];
    for (const file of files) {
      const segments = [];
      for (const range of ranges) {
        const start = Math.max(file.offset, range.start);
        const end = Math.min(file.offset + file.length, range.start + range.length);
        if (end > start) {
          segments.push({
            outputOffset: range.outputStart + (start - range.start),
            torrentOffset: start,
            length: end - start,
          });
        }
      }
      if (segments.length > 0) {
        manifestFiles.push({
          index: file.index,
          path: file.path,
          torrentOffset: file.offset,
          length: file.length,
          padding: file.padding,
          segments,
        });
      }
    }

    const manifest = {
      infoHash: task.id,
      name: task.name,
      outputKey,
      outputBytes: task.output_bytes,
      pieceLength: task.piece_length,
      pieceCount: task.piece_count,
      completedAt: new Date().toISOString(),
      ranges: ranges.map((range) => ({
        torrentOffset: range.start,
        length: range.length,
        outputOffset: range.outputStart,
      })),
      files: manifestFiles,
    };

    await this.env.BLOBS.put(task.manifest_key, JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { infoHash: task.id },
    });
  }

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  private insertPieces(meta: TorrentMeta, wanted: BitField): void {
    const indices: number[] = [];
    for (let index = 0; index < meta.pieceCount; index++) {
      if (wanted.get(index)) indices.push(index);
    }

    // workerd's SQLite build has a low bound on bound variables; 30 rows x 3
    // placeholders stays under it and remains fast enough for the 50k-piece cap.
    const batchSize = 30;
    for (let start = 0; start < indices.length; start += batchSize) {
      const batch = indices.slice(start, start + batchSize);
      const placeholders = batch.map(() => "(?, ?, ?, 'missing', 0)").join(", ");
      const bindings: unknown[] = [];
      for (const index of batch) {
        bindings.push(
          index,
          exactArrayBuffer(meta.pieces.slice(index * 20, index * 20 + 20)),
          pieceLengthAt(meta, index),
        );
      }
      this.sql.exec(
        `INSERT INTO piece (idx, hash, length, state, attempts) VALUES ${placeholders}`,
        ...bindings,
      );
    }
  }

  private rebuildProgress(task: TaskRow): {
    bits: BitField;
    verifiedBytes: number;
    verifiedPieces: number;
  } {
    const rows = queryAll<{ idx: number; length: number } & Record<string, SqlRowValue>>(
      this.sql,
      "SELECT idx, length FROM piece WHERE state='verified'",
    );
    const bits = new BitField(task.piece_count);
    let verifiedBytes = 0;
    for (const row of rows) {
      if (row.idx >= 0 && row.idx < task.piece_count) {
        bits.set(row.idx);
        verifiedBytes += row.length;
      }
    }

    if (
      rows.length !== task.verified_pieces ||
      verifiedBytes !== task.verified_bytes ||
      !bytesEqual(toUint8Array(task.verified_bitmap), bits.toBytes())
    ) {
      this.flushProgress(task, bits, verifiedBytes, rows.length, Date.now());
    }

    return { bits, verifiedBytes, verifiedPieces: rows.length };
  }

  private flushProgress(
    task: TaskRow,
    bits: BitField,
    verifiedBytes: number,
    verifiedPieces: number,
    now: number,
  ): void {
    this.sql.exec(
      "UPDATE task SET verified_bitmap=?, verified_bytes=?, downloaded_bytes=?, verified_pieces=?, updated_at=? WHERE id=?",
      exactArrayBuffer(bits.toBytes()),
      verifiedBytes,
      verifiedBytes,
      verifiedPieces,
      now,
      task.id,
    );
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const listed = await this.env.BLOBS.list({ prefix, cursor, limit: 1000 });
      if (listed.objects.length > 0) {
        await this.env.BLOBS.delete(listed.objects.map((object) => object.key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  private async r2UsageBytes(): Promise<number> {
    let total = 0;
    for (const prefix of ["torrents/", "downloads/", "staging/"]) {
      let cursor: string | undefined;
      do {
        const listed = await this.env.BLOBS.list({ prefix, cursor, limit: 1000 });
        for (const object of listed.objects) total += object.size;
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
    return total;
  }

  private async cleanupStaging(task: TaskRow): Promise<void> {
    await this.deletePrefix(stagingPrefix(task.id));
    this.sql.exec(
      "UPDATE task SET staging_cleaned=1, updated_at=? WHERE id=?",
      Date.now(),
      task.id,
    );
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private async schedule(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, Math.trunc(at)));
  }

  private async ensureAlarm(): Promise<void> {
    const task = getTask(this.sql);
    if (!task) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    if (task.status === "completed") {
      if (task.staging_cleaned === 0) {
        await this.schedule(Date.now() + 5 * 60_000);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }

    if (
      task.status === "queued" ||
      task.status === "paused" ||
      task.status === "failed"
    ) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.schedule(Date.now() + 1000);
  }

  private async handleWaveError(error: unknown): Promise<void> {
    console.error("torrent wave failed", error);
    const task = getTask(this.sql);
    if (!task) return;
    const failures = task.consecutive_failures + 1;
    const now = Date.now();
    this.sql.exec(
      "UPDATE task SET last_error=?, consecutive_failures=?, updated_at=? WHERE id=?",
      messageOf(error),
      failures,
      now,
      task.id,
    );
    if (task.status === "downloading" || task.status === "finalizing") {
      await this.schedule(now + backoffMs(failures));
    }
  }

  private statusJson(task: TaskRow, includeBits = false): Record<string, unknown> {
    const verifiedBytes = Math.min(task.verified_bytes, task.wanted_bytes);
    const leftBytes = Math.max(0, task.wanted_bytes - verifiedBytes);
    const peerCount =
      queryOne<{ n: number } & Record<string, SqlRowValue>>(
        this.sql,
        "SELECT COUNT(*) AS n FROM peer WHERE banned_until IS NULL OR banned_until < ?",
        Date.now(),
      )?.n ?? 0;
    const trackers = queryAll<{ url: string } & Record<string, SqlRowValue>>(
      this.sql,
      "SELECT url FROM tracker ORDER BY tier ASC, url ASC",
    ).map((row) => row.url);
    const outputStoredBytes = task.status === "completed" ? task.output_bytes : 0;
    const manifestBytes = task.status === "completed" ? 2048 : 0;
    const selection = safeJson<StoredSelection>(task.selection_json);
    const allFiles = safeJsonArray<TorrentFile>(task.files_json).map((file) => ({
      ...file,
      selected: selection
        ? selection.ranges.some(
            (range) =>
              Math.max(file.offset, range.start) <
              Math.min(file.offset + file.length, range.start + range.length),
          )
        : true,
    }));
    const files = allFiles.slice(0, 1000);

    const usage = {
      torrentBytes: task.torrent_bytes,
      stagingBytes: task.staging_cleaned ? 0 : task.verified_bytes,
      outputBytes: outputStoredBytes,
      doRequests: task.do_requests,
      alarmCount: task.alarm_count,
      waveDurationMs: task.wave_duration_ms,
      r2PutOps: task.r2_put_ops,
      r2GetOps: task.r2_get_ops,
      trackerRequests: task.tracker_requests,
      peerConnections: task.peer_connections,
      wantedPieces: task.wanted_pieces,
      verifiedPieces: task.verified_pieces,
    };
    const estimatedCost = estimateTaskCost(usage);

    return {
      id: task.id,
      infoHash: task.id,
      name: task.name,
      status: task.status,
      freeOnly: task.free_only === 1,
      pieceLength: task.piece_length,
      pieceCount: task.piece_count,
      totalLength: task.total_length,
      wantedPieces: task.wanted_pieces,
      verifiedPieces: task.verified_pieces,
      wantedBytes: task.wanted_bytes,
      verifiedBytes,
      downloadedBytes: task.downloaded_bytes,
      leftBytes,
      outputBytes: task.output_bytes,
      progress: task.wanted_bytes > 0 ? verifiedBytes / task.wanted_bytes : 0,
      peerCount,
      waveCount: task.wave_count,
      announcements: task.announcements,
      consecutiveFailures: task.consecutive_failures,
      lastError: task.last_error,
      outputKey: task.output_key,
      manifestKey: task.manifest_key,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      startedAt: task.started_at,
      completedAt: task.completed_at,
      files,
      fileCount: allFiles.length,
      filesTruncated: allFiles.length > files.length,
      trackers,
      selection,
      usage: {
        ...usage,
        storedBytes: task.torrent_bytes + usage.stagingBytes + outputStoredBytes + manifestBytes,
      },
      estimatedCost,
      pricingAsOf: estimatedCost.pricingAsOf,
      ...(includeBits
        ? { verifiedBitmap: toHex(toUint8Array(task.verified_bitmap)) }
        : {}),
    };
  }

  private get maxPeers(): number {
    return clamp(parsePositiveInt(this.env.MAX_PEERS, LIMITS.maxPeers), 1, LIMITS.maxPeers);
  }

  private get maxWaveBytes(): number {
    return clamp(
      parsePositiveInt(this.env.MAX_WAVE_BYTES, LIMITS.maxWaveBytes),
      MIN_WAVE_BYTES,
      MAX_WAVE_BYTES,
    );
  }

  private get r2PartSize(): number {
    return clamp(
      parsePositiveInt(this.env.R2_PART_SIZE, LIMITS.defaultR2PartSize),
      LIMITS.minR2PartSize,
      MAX_R2_PART_SIZE,
    );
  }
}

// -----------------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------------

function chooseOutputName(meta: TorrentMeta, resolved: ResolvedSelection): string {
  const wholeTorrent =
    resolved.ranges.length === 1 &&
    resolved.ranges[0].start === 0 &&
    resolved.ranges[0].length === meta.totalLength;
  return wholeTorrent && meta.files.length === 1 ? meta.name : `${meta.name}.subset.bin`;
}

function parseParts(value: string | null): R2UploadedPart[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];

  const byNumber = new Map<number, R2UploadedPart>();
  for (const part of parsed) {
    if (
      part &&
      typeof part === "object" &&
      typeof (part as R2UploadedPart).partNumber === "number" &&
      typeof (part as R2UploadedPart).etag === "string"
    ) {
      const uploaded = part as R2UploadedPart;
      byNumber.set(uploaded.partNumber, uploaded);
    }
  }
  return [...byNumber.values()].sort((a, b) => a.partNumber - b.partNumber);
}

function backoffMs(failures: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.min(Math.max(0, failures - 1), 5));
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

function safeJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function safeJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function isNoSuchUpload(error: unknown): boolean {
  const text = messageOf(error);
  return /NoSuchUpload|no such upload|specified upload does not exist/i.test(text);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
