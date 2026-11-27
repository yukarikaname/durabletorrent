# durabletorrent

A minimal, outbound-only BitTorrent downloader that runs on **Cloudflare Workers + Durable Objects (SQLite) + R2**.

It is a proof of concept, not a production client. It downloads a selected subset of a torrent, verifies pieces with SHA-1, stages verified pieces in R2, and assembles the final object with R2 multipart upload. It **never accepts inbound connections and never unchokes a peer**, so it cannot seed.

```
Browser / curl
      │
      ▼
Cloudflare Worker  ── fetch() ──► HTTP(S) tracker
      │                └────────► R2 (torrent / staging / output / manifest)
      │
      ▼ (DO stub)
Durable Object  ── cloudflare:sockets connect() ──► TCP peers (max 6 per wave)
  SQLite: task, piece, peer, tracker, meta
  Alarm:  one download/finalize wave at a time
```

---

## 1. What is implemented

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

## 2. Module map

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

## 3. Durable Object state machine

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

## 4. Alarm scheduling

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

## 5. Piece flow, memory limits, and R2 assembly

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

If a staged piece is missing or truncated during finalization, the multipart upload is aborted, the piece is marked missing, and the task returns to `downloading`.

Output size is capped at `10,000 × R2_PART_SIZE` (about 80 GiB at 8 MiB parts) by an init-time check.

### Subset semantics

- `files=0,2` downloads only those file indices.
- `ranges=0-1048575,2097152-3145727` downloads byte ranges in the concatenated torrent payload.
- Pieces overlapping a boundary are downloaded and verified whole, then **trimmed** during finalization.
- Multi-file selections are concatenated into one output object. The manifest records each file's torrent offset, output offset, and segments. The PoC does not recreate a directory tree in R2.
- BEP 47 padding files are excluded by default.

---

## 6. Concurrency and the 6-connection rule

Workers limits each invocation to **6 simultaneous outbound connection attempts** (fetch or TCP connect).

- Each wave selects at most 6 peers.
- Tracker announces run before peer connects.
- R2 operations share the same outbound budget; a 7th connection is queued by the runtime.
- Magnet metadata resolution happens in the **Worker**, not the DO: it announces to trackers, then tries up to 3 peers concurrently with a 45 s overall budget.
- Peer sockets are opened inside `fetch()` / `alarm()` and never at module scope.
- A DO socket keeps the object alive for up to 15 minutes per connection; the wave closes all sockets explicitly.

---

## 7. UI and HTTP API

`GET /` serves **DurableTorrent**, a single-page UI built around a live piece map:

- Drag a `.torrent` file or a magnet link onto the drop zone.
- Inspect the torrent, choose files, then start the download.
- Paste a magnet link; extra trackers can be supplied if the magnet has none.
- Watch verified pieces fill the map in amber, along with peers, trackers, bytes and storage.
- Add HTTP(S) trackers to a running task.
- Download the completed output or its manifest.
- Browse/delete R2 objects under `downloads/`, `staging/`, `torrents/`.
- See a rough cost estimate for the task and for R2 storage.
- Optional API token stored in `localStorage`.
- Open `/?task=<infoHash>` to return to a transfer by its info hash.

The visual direction follows Anthropic's open-source
[`frontend-design` skill](https://github.com/anthropics/skills/tree/main/skills/frontend-design):
a cool graph-paper field, a serif wordmark and readout numerals, one dark
instrument panel for the piece map, and no card-kit chrome. Everything is
inline; there are no external fonts or build-time UI assets. See
[`docs/DESIGN.md`](docs/DESIGN.md) for the token system and wireframe.

### API

Create from a `.torrent` (raw body):

```bash
curl -X POST --data-binary @example.torrent \
  "https://YOUR-WORKER.workers.dev/api/torrents?files=0,2&trackers=https://tracker.example/announce"
```

Create from a magnet (needs an HTTP(S) tracker):

```bash
curl -X POST https://YOUR-WORKER.workers.dev/api/magnets \
  -H 'content-type: application/json' \
  -d '{
    "magnet": "magnet:?xt=urn:btih:<hash>&tr=https://tracker.example/announce",
    "trackers": ["https://backup.example/announce"]
  }'
```

Other endpoints:

```text
POST   /api/torrents/inspect          parse a .torrent and return its file list
GET    /api/torrents/:infoHash        status + usage + estimatedCost
GET    /api/torrents/:infoHash?bits=1 status + hex verified bitfield
POST   /api/torrents/:infoHash/start
POST   /api/torrents/:infoHash/pause
POST   /api/torrents/:infoHash/tick   run one scheduler cycle (debug)
POST   /api/torrents/:infoHash/trackers  { "urls": ["https://..."] }
GET    /api/torrents/:infoHash/download
GET    /api/torrents/:infoHash/manifest
DELETE /api/torrents/:infoHash        delete the session and its R2 objects
GET    /api/files?all=1&prefix=       list R2 objects (max 10,000 per call)
GET    /api/files/object?key=...      stream one R2 object
DELETE /api/files/object?key=...      delete one R2 object
GET    /api/cost                      R2 object count, bytes, storage estimate
GET    /health
GET    /api                            API description
```

Authentication is optional. Set `API_TOKEN` as a Worker secret; then send:

```text
Authorization: Bearer <token>
```

Browser download links cannot set an Authorization header. For read-only download routes, the Worker also accepts `?token=<token>`. This puts the token in URLs and logs; use it only for the PoC.

---

## 8. Setup with `cf`

Requirements: **Node.js 22.23+, 24.22+, or 26.12+** (the `cf` CLI engine range), a Cloudflare account, Workers Paid (recommended; the free plan's 10 ms CPU limit is too small for torrent parsing).

```bash
brew install node       # macOS; or use nvm/fnm/mise
cd durabletorrent
npm install            # or pnpm / yarn / bun install
npx cf --version       # cf is a devDependency
```

Create the R2 bucket (the bucket name must match `cloudflare.config.ts`):

```bash
npx cf auth login
npx cf r2 buckets create --name durabletorrent-blobs
```

Edit `cloudflare.config.ts` if you change the Worker or bucket name.

### Local development

```bash
npx cf dev
```

Open the local URL. Local Durable Objects and R2 are simulated. The UI is at `/`.

### Deploy

```bash
npx cf auth login
npx cf deploy
```

### Type generation / typecheck

```bash
npx cf workers types
npm run typecheck
```

### Optional API token

```bash
npx cf workers secrets update API_TOKEN --text '<your-token>' --worker durabletorrent
```

`cf` command names can change during the 1.0 RC; run `npx cf cli search "..."` or `npx cf --help` if a command differs.

---

## 9. Self-test

Pure modules can be tested without workerd:

```bash
bun run scripts/selftest.ts
```

It covers bencode, torrent parsing, info hash, file/range selection, bitfield order, tracker compact peers, announce URL encoding, handshake/message framing, BEP 10 bit, piece queue, SHA-1, output-range trimming, and the cost helper.

Current result: **95 assertions passed**.

---

## 10. Cost estimate

The status endpoint returns `usage` and `estimatedCost`. The UI renders it. The model is deliberately rough:

- **R2 storage:** `$0.015 / GB-month`, 10 GB free. Per task: torrent + staging pieces + output + manifest, priced as if retained for one month.
- **R2 Class A:** `$4.50 / million` (PUT, multipart create/upload/complete); 1 M free.
- **R2 Class B:** `$0.36 / million` (GET); 10 M free.
- **Durable Objects:** `$0.15 / million` requests (1 M free); `$12.50 / million GB-s` duration (400 k GB-s free), billed at 128 MB; SQLite rows read `$0.001 / million` (25 B free) and written `$1.00 / million` (50 M free).
- **Workers:** `$0.30 / million` requests (10 M free); `$0.02 / million` CPU ms (30 M free); **$5/month base is excluded** from per-task totals.

Counters are best-effort: DO requests and alarm wall time are exact; R2 PUT/GET counts are exact for the paths we instrument; SQLite rows and Workers CPU are derived heuristics. The estimate is not a bill. Account-wide free allowances are not applied per task.

`GET /api/cost` sums up to 10,000 R2 objects and returns a storage estimate. `listingCapped` indicates the listing was truncated.

---

## 11. Limitations and known gotchas

### Protocol / network

- **No DHT/UDP tracker/uTP.** A magnet without an HTTP(S) tracker cannot be resolved.
- **No MSE/PE encryption.** Some peers require encryption and will be skipped.
- **No IPv6 compact peers.** Only IPv4 compact peers and hostnames are accepted.
- **No Fast Extension / PEX / webseeds / rarest-first / endgame.**
- **No upload/seeding.** The client never sends unchoke, so it cannot serve pieces. Tracker `uploaded` is 0.
- **No partial-piece resume.** A failed piece is downloaded from the beginning.
- **Pause is cooperative.** It takes effect at the next scheduler check; a peer blocked in a socket read can delay it by up to the 90-second idle timeout.
- **No TCP connection reuse across alarms.** Each wave reconnects.
- **Bitfield-less peers** are treated optimistically as having every piece; a missing piece may cause an idle timeout.
- **Tracker compatibility:** private trackers may require cookies, passkeys, or a specific `User-Agent`; `announce-list` tiers are flattened; no scrape.

### Platform / storage

- **R2 part alignment:** one piece is not one part. The 5 MiB minimum and uniform-part rule are handled by staging + 8 MiB finalization parts.
- **R2 parts are capped at 10,000.** Output is rejected at init if it exceeds `10,000 × R2_PART_SIZE` (≈80 GiB at 8 MiB).
- **Staging objects are retained after completion.** Deleting the task removes them; otherwise they keep costing storage. There is no automatic GC.
- **One R2 PUT per verified piece.** Torrents with 16–256 KiB pieces create many Class A operations. This is simple and resumable, but not the cheapest design for very large torrents.
- **Staging read amplification:** finalization reads overlapping pieces through R2 range GETs; a piece may be read more than once if selected ranges are fragmented.
- **Large task deletion** can take many R2 list/delete calls (1000 keys per call) and may exceed a request's practical time.
- **DO SQLite init is O(wanted pieces).** 50,000 piece rows is the PoC cap and can take noticeable CPU.
- **Free plan CPU is 10 ms.** Use Workers Paid for real torrent parsing and SHA-1 verification; the deployed config does not request a custom CPU limit because the Free plan rejects it.
- **Alarm wall clock is 15 minutes.** Waves are capped at 8 minutes and finalization at 6 minutes.
- **DO eviction:** in-memory claims/bitfields are lost; SQLite rebuilds them at the next wave. A TCP socket keeps a DO alive for up to 15 minutes.
- **`cf` CLI 1.0 RC** requires Node 22.23+/24.22+/26.12+ and cannot build under Bun. `cf` command names may change.

### UI / security

- The UI is same-origin and stores the API token in `localStorage`. That is convenient for a PoC, not a hardened admin console.
- The `?token=` download fallback leaks the token into browser history and access logs.
- Tracker URLs and peer endpoints are user/tracker supplied. The runtime blocks private/Cloudflare IPs and the code filters obvious private ranges, but this is not a substitute for an allowlist in a public deployment.
- Torrent filenames are sanitized for R2 keys, but the manifest preserves the original path strings for display.

### Legal

BitTorrent is a legitimate protocol. Download only content you have the rights to. This PoC intentionally does not upload/seed, but that does not remove legal or network-policy obligations.

---

## 12. References

- BEP 3 — The BitTorrent Protocol Specification
- BEP 9 — Extension for Peers to Send Metadata Files (`ut_metadata`)
- BEP 10 — Extension Protocol
- BEP 23 — Tracker Returns Compact Peer Lists
- BEP 47 — Padding Files and Extended File Properties
- Cloudflare Docs: Durable Objects SQLite storage, Alarms, TCP sockets, R2 Workers API, R2 multipart, Workers limits, pricing
- Reference implementations consulted: `webtorrent/bittorrent-protocol`, `webtorrent/parse-torrent`, `webtorrent/bencode`

---

## 13. License

MIT License. Copyright (c) 2026 Yukari Kaname. See [`LICENSE`](LICENSE).

