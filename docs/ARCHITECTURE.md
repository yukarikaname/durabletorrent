# Architecture

Protocol scope, Durable Object state, alarms, R2 assembly, memory limits, concurrency and cost model.

## What is implemented

### Protocol subset

| Area | Implemented |
|---|---|
| `.torrent` parsing | bencode dictionary/list/integer/byte-string, `announce`, `announce-list`, `info_hash`, `piece length`, `pieces`, single-file and multi-file layouts, BEP 47 padding awareness |
| Tracker | HTTP/HTTPS announce, compact IPv4 peers (BEP 23), non-compact fallback, `started` event, interval/failure backoff |
| Peer handshake | 68-byte handshake, reserved bits, info-hash validation |
| Peer messages | `choke` (0), `unchoke` (1), `interested` (2), `have` (4), `bitfield` (5), `request` (6), `piece` (7), keep-alive; ignores upload-related messages |
| Verification | SHA-1 per piece with Web Crypto; failed pieces are requeued and bad peers are dropped |
| Magnet | BEP 9 `ut_metadata` over BEP 10 extended messages; metadata SHA-1 checked against the magnet info hash |
| Trackers | Add HTTP(S) trackers through the UI/API before or after task creation |

### Not implemented (by design)

UDP trackers, DHT, uTP, PEX, MSE/PE encryption, IPv6 compact peers, Fast Extension, webseeds, rarest-first, endgame mode, seeding/upload, inbound TCP.

Because Workers has no general UDP socket, a magnet link **must** contain at least one HTTP(S) `tr=` tracker, or you must paste a tracker in the UI/API. There is no DHT fallback.

---

## Module map

```
src/
  index.ts                     Worker routes, .torrent/magnet creation, R2 file manager, cost API
  ui.ts                        Inline single-page UI (drag/drop, magnet, files, cost)
  env.ts                       Env bindings
  do/
    TorrentSession.ts          Durable Object: state machine, alarms, peer wave, R2 finalize
    schema.ts                  SQLite schema, row types, query helpers
  bittorrent/
    bencode.ts                 Bencode decoder/encoder (with raw info span + prefix mode)
    torrent.ts                 .torrent metainfo parsing, file offsets, info hash
    selection.ts               File/byte-range selection -> wanted pieces + output ranges
    bitfield.ts                MSB-first BitTorrent bitfield
    peer-frames.ts             Handshake/message framing, BEP 10 helpers
    peer-wire.ts               cloudflare:sockets transport, framed reads, deadlines
    peer-download.ts           Per-peer block pipeline + piece assembly
    piece-queue.ts             Shared, in-memory claim queue for one wave
    tracker.ts                 HTTP(S) announce + compact peer parsing
    tracker-url.ts             Tracker URL normalization
    magnet.ts                  Magnet URI + base32 info hash parsing
    metadata.ts                BEP 9 metadata exchange over TCP
    torrent-builder.ts         Embed raw info bytes into a minimal .torrent
  storage/
    keys.ts                    R2 key layout
    output.ts                  Output-range reader with piece-boundary trimming
  lib/
    bytes.ts, hash.ts, http.ts, limits.ts, peer-id.ts, pricing.ts
scripts/
  selftest.ts                  Pure-module tests (`bun run scripts/selftest.ts`)
```

---

## Durable Object state machine

One Durable Object is one torrent session. The object name is the info hash (hex).

```
             POST /init
                 │
                 ▼
   ┌────────── queued ◄──────────── pause ─────────┐
   │              │                                │
   │           start                               │
   │              ▼                                │
   │        downloading ───────────────────────────┤
   │           │   ▲                               │
   │  all wanted│   │ missing staged piece          │
   │  verified  ▼   │                               │
   │        finalizing ────────────────────────────┘
   │              │
   │              ▼
   └───────── completed
```

- `queued` — task created with `start=0`; no alarm.
- `downloading` — alarms run download waves.
- `finalizing` — all wanted pieces verified; alarms assemble R2 parts.
- `completed` — final object + manifest exist.
- `paused` — status updated, alarm deleted; a running wave stops at the next check.
- `failed` — reserved for unrecoverable failures; the PoC normally keeps retrying with backoff and records `lastError`.

### SQLite tables

`task` is a singleton row:

| Field group | Columns |
|---|---|
| Identity | `id` (info hash hex), `info_hash`, `name`, `torrent_key` |
| Progress | `piece_length`, `piece_count`, `total_length`, `wanted_pieces`, `wanted_bytes`, `output_bytes`, `verified_pieces`, `verified_bytes`, `downloaded_bytes` |
| Bitmaps | `wanted_bitmap`, `verified_bitmap` (BLOB, MSB-first) |
| Metadata | `selection_json`, `files_json`, `trackers_json`, `peer_id` |
| R2 multipart | `output_key`, `manifest_key`, `multipart_upload_id`, `multipart_parts_json`, `finalize_cursor`, `finalize_part` |
| Scheduling | `status`, `wave_count`, `announcements`, `consecutive_failures`, `last_error`, timestamps |
| Cost counters | `torrent_bytes`, `do_requests`, `alarm_count`, `wave_duration_ms`, `r2_put_ops`, `r2_get_ops`, `tracker_requests`, `peer_connections` |

`piece` contains **only wanted pieces**:

```
idx INTEGER PRIMARY KEY, hash BLOB, length INTEGER,
state TEXT ('missing'|'inflight'|'verified'), attempts INTEGER,
peer TEXT, verified_at INTEGER
```

`peer` stores tracker-returned endpoints, failure/success counts, downloaded bytes, and `banned_until`.
`tracker` stores per-URL interval, next announce time, and failures.
`meta` is reserved for schema/version information.

`verified_bitmap` is a cache: at the start of every wave, the DO rebuilds it from `piece.state='verified'`. A crash between an R2 PUT and the SQLite update therefore causes a safe re-download, never a corrupt output.

---

## Alarm scheduling

Each DO has one alarm. It is used as a scheduler, not as a long-lived download loop.

- **One wave at a time.** `alarm()` claims an in-memory `busy` flag. A second alarm or a manual `/tick` is rejected or deferred.
- **Download wave budget:** 8 minutes (`LIMITS.maxWaveMs`), 64 MiB of verified bytes (`MAX_WAVE_BYTES`), max 6 peers.
- **Finalize budget:** 6 minutes or 64 parts per alarm (`LIMITS.maxFinalizeMs`, `maxFinalizePartsPerAlarm`). Progress is persisted after every part; the next alarm resumes.
- **At-least-once semantics:** `alarm()` catches its own errors and schedules a retry with exponential backoff (30 s → 15 min) so the platform's six automatic alarm retries are not exhausted.
- **Watchdog:** `ensureAlarm()` deletes the alarm for terminal/paused/queued tasks and re-arms active tasks if no alarm exists.
- **Crash repair:** at wave start, all `piece.state='inflight'` rows are reset to `missing`, and `verified_*` is rebuilt from the piece table.
- **Pause:** deletes the alarm and sets `paused`. A running wave sees `stopRequested` and exits at the next block/piece boundary; in-flight sockets are closed by the peer loop.

The 15-minute alarm wall clock is respected by staying below 8 minutes per wave and 6 minutes per finalize alarm.

---

## Piece flow, memory limits, and R2 assembly

### Memory model

- At most **6 peers** per wave (`MAX_PEERS`, capped at 6).
- Each peer buffers **one piece** (max 4 MiB). Worst case 24 MiB of piece buffers.
- Pipeline depth is 8 blocks × 16 KiB = 128 KiB outstanding per peer.
- Piece messages are capped at 4 MiB + 13 bytes; the torrent is capped at 8 MiB; the piece count is capped at 50,000; the file count is capped at 10,000.
- A verified piece is uploaded to R2 immediately and the buffer is released.
- Finalization streams 8 MiB parts (one part buffer at a time), not the whole file.

### Per-piece path

1. Claim `(index, length)` from the shared `PieceQueue`, optionally constrained by the peer's bitfield.
2. Mark `piece.state='inflight'`; request blocks with a pipeline of 8.
3. Assemble the complete piece in memory.
4. `crypto.subtle.digest('SHA-1', piece)` and compare with the metainfo hash.
5. On mismatch: `attempts++`, requeue if attempts < 5, and ban a peer after 2 bad pieces.
6. On match: `BLOBS.put('staging/<infoHash>/<index>.piece', piece)`.
7. Update `piece.state='verified'`, the in-memory bitfield, and (every 8 pieces) the task counters.

A storage failure does **not** consume the piece's bad-data attempt budget; it is retried in a later wave.

### R2 multipart rules

R2 multipart requires:

- part numbers 1..10,000;
- **all parts the same size except the final part**;
- a minimum part size of 5 MiB for non-final parts.

A torrent piece is usually much smaller than 5 MiB (and may be 16 KiB), so the PoC does not upload one piece per part. Instead:

1. Each verified piece is staged as a separate R2 object.
2. Finalization walks the selected output ranges in order, reads the required byte range from the corresponding staging objects, and fills a fixed `R2_PART_SIZE` buffer (default **8 MiB**).
3. Every full 8 MiB buffer is uploaded as a multipart part; the last part may be smaller.
4. `finalize_cursor` is the output offset of the next part; `multipart_parts_json` stores uploaded `{partNumber, etag}` values. After a crash, the DO calls `resumeMultipartUpload()` and continues.
5. On completion, a `manifest.json` is written and the task becomes `completed`.
6. A follow-up alarm deletes the staging prefix. The output, manifest and source torrent remain; the cleanup is resumable and can also be triggered with `POST /api/torrents/:infoHash/cleanup`.

If a staged piece is missing or truncated during finalization, the multipart upload is aborted, the piece is marked missing, and the task returns to `downloading`.

Output size is capped at `10,000 × R2_PART_SIZE` (about 80 GiB at 8 MiB parts) by an init-time check.

### Subset semantics

- `files=0,2` downloads only those file indices.
- `ranges=0-1048575,2097152-3145727` downloads byte ranges in the concatenated torrent payload.
- Pieces overlapping a boundary are downloaded and verified whole, then **trimmed** during finalization.
- Multi-file selections are concatenated into one output object. The manifest records each file's torrent offset, output offset, and segments. The PoC does not recreate a directory tree in R2.
- BEP 47 padding files are excluded by default.

---

## Concurrency and the 6-connection rule

Workers limits each invocation to **6 simultaneous outbound connection attempts** (fetch or TCP connect).

- Each wave selects at most 6 peers.
- Tracker announces run before peer connects.
- R2 operations share the same outbound budget; a 7th connection is queued by the runtime.
- Magnet metadata resolution happens in the **Worker**, not the DO: it announces to trackers, then tries up to 3 peers concurrently with a 45 s overall budget.
- Peer sockets are opened inside `fetch()` / `alarm()` and never at module scope.
- A DO socket keeps the object alive for up to 15 minutes per connection; the wave closes all sockets explicitly.

---


## Cost estimate

The status endpoint returns `usage` and `estimatedCost`. The UI renders it. The model is deliberately rough:

- **R2 storage:** `$0.015 / GB-month`, 10 GB free. Per task: the source torrent, staging while downloading, the output and manifest, priced as if retained for one month. Staging is removed after completion.
- **R2 Class A:** `$4.50 / million` (PUT, multipart create/upload/complete); 1 M free.
- **R2 Class B:** `$0.36 / million` (GET); 10 M free.
- **Durable Objects:** `$0.15 / million` requests (1 M free); `$12.50 / million GB-s` duration (400 k GB-s free), billed at 128 MB; SQLite rows read `$0.001 / million` (25 B free) and written `$1.00 / million` (50 M free).
- **Workers:** `$0.30 / million` requests (10 M free); `$0.02 / million` CPU ms (30 M free); **$5/month base is excluded** from per-task totals.

Counters are best-effort: DO requests and alarm wall time are exact; R2 PUT/GET counts are exact for the paths we instrument; SQLite rows and Workers CPU are derived heuristics. The estimate is not a bill. Account-wide free allowances are not applied per task.

`GET /api/cost` sums up to 10,000 R2 objects and returns a storage estimate. `listingCapped` indicates the listing was truncated.

---


## References

- BEP 3 — The BitTorrent Protocol Specification
- BEP 9 — Extension for Peers to Send Metadata Files (`ut_metadata`)
- BEP 10 — Extension Protocol
- BEP 23 — Tracker Returns Compact Peer Lists
- BEP 47 — Padding Files and Extended File Properties
- Cloudflare Docs: Durable Objects SQLite storage, Alarms, TCP sockets, R2 Workers API, R2 multipart, Workers limits, pricing
- Reference implementations consulted: `webtorrent/bittorrent-protocol`, `webtorrent/parse-torrent`, `webtorrent/bencode`

---

