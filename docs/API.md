# API and setup

HTTP API, public read-only access, admin token, free-only safeguards, cf deployment and self-test.

## UI and HTTP API

`GET /` serves **DurableTorrent**, a single-page UI built around a live piece map:

- Drag a `.torrent` file or a magnet link onto the drop zone.
- Inspect a `.torrent` or resolve a magnet's metadata first, then choose exactly which files to download.
- Paste a magnet link; extra trackers can be supplied if the magnet has none.
- Watch verified pieces fill the map in amber, along with peers, speed, time left, trackers, bytes and storage.
- Use the **Free-only safeguards** toggle (on by default) to keep one task and the R2 bucket inside conservative free-tier caps.
- The main panel estimates how large a file can be for a given keep time; at download time a notice shows the latest free-tier pickup date and files are deleted automatically then.
- Add HTTP(S) trackers to a running task.
- Download the completed output or its manifest.
- Staging is merged into the output and deleted automatically; a manual "Clean staging" action is available for older tasks.
- Browse/delete individual R2 objects, or use "Delete all" to remove every task and object.
- In free mode, see a GB-month quota bar, the latest pickup time, and an estimate of how much another file could be downloaded for a chosen keep time; otherwise see a rough cost estimate.
- Optional admin token stored in `localStorage`; readers can browse without it.
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
POST   /api/magnets/inspect           resolve magnet metadata and return its file list
GET    /api/torrents/:infoHash        status + usage + estimatedCost
GET    /api/torrents/:infoHash?bits=1 status + hex verified bitfield
POST   /api/torrents/:infoHash/start
POST   /api/torrents/:infoHash/pause
POST   /api/torrents/:infoHash/tick   run one scheduler cycle (debug)
POST   /api/torrents/:infoHash/trackers  { "urls": ["https://..."] }
POST   /api/torrents/:infoHash/cleanup   delete staging for a completed transfer
POST   /api/torrents/:infoHash/expire    delete the output and manifest now
GET    /api/torrents/:infoHash/download
GET    /api/torrents/:infoHash/manifest
DELETE /api/torrents/:infoHash        delete the session and its R2 objects
DELETE /api/all                       delete every task and every R2 object
GET    /api/files?all=1&prefix=       list R2 objects (max 10,000 per call)
GET    /api/files/object?key=...      stream one R2 object
DELETE /api/files/object?key=...      delete one R2 object
GET    /api/cost                      R2 object count, bytes, storage estimate
GET    /health
GET    /api                            API description
```

### Read-only public access

Reads are public:

- the UI at `/`
- `GET /api`, `GET /api/torrents/:id`, `GET /api/torrents/:id?bits=1`
- `GET /api/torrents/:id/download`, `GET /api/torrents/:id/manifest`
- `GET /api/files`, `GET /api/files/object`, `GET /api/cost`

Every mutation requires an admin token:

```text
Authorization: Bearer <API_TOKEN>
```

That covers all `POST` routes (create torrent, magnet, start, pause, tick,
trackers, cleanup, inspect) and all `DELETE` routes (task, R2 object, delete all).
`GET /api` reports the current mode in `auth.mutations` (`admin-token` or `open`).

The UI's **Admin token for changes** box stores the token in `localStorage` and
attaches the header. Read-only visitors see the piece map, status, files and
downloads, but the start/pause/delete/tracker controls are disabled. If
`API_TOKEN` is not configured, mutations are open.

### Free-only safeguards

The UI toggle is on by default, and the Worker also defaults `freeOnly` to true
when the flag is absent. It applies conservative caps:

| Resource | Free-only cap |
|---|---|
| Output per task | 2 GiB |
| Selected pieces per task | 4,096 |
| Total pieces in the torrent | 20,000 |
| Piece length | 2 MiB |
| Peers per wave | 4 |
| Verified bytes per wave | 4 MiB |
| R2 bucket usage before a new task | 9 GiB safety budget |
| Automatic retention | 1–720 hours, default 720; free allowance caps it |

**R2 is billed in GB-month, not by instantaneous GB or by the hour.** Cloudflare
calculates a GB-month from the average of the **daily peak** storage over the
billing period. This PoC therefore uses a conservative daily-peak estimate:

```text
gbMonth for one object = sizeGB × billableDays / 30
billableDays = max(1, ceil(ageHours / 24))
```

Any part of a day counts as a full day. A 200 GB object kept for one hour is
therefore estimated at `200 × 1 / 30 = 6.67 GB-month`, not `200 / 720`. It leaves
about 3.33 GB-month of the 10 GB-month free allowance; keeping it a second day
would exceed the free allowance.

Retention is automatic. The UI shows a quota notice when a transfer is created:

> Free tier: take the file before **date**. It will be deleted automatically at
> that time.

For a queued/downloading task it shows an estimate based on the selected output
size and current bucket usage. The Durable Object computes the exact deadline
when finalization completes:

- `freeTotalDays = 1 + floor(remainingGbMonth × 30 / outputGB)`
- `expires_at = completion + min(720h, freeTotalDays × 24h)`

The main panel also has a **R2 free allowance estimate** calculator: enter a
file size in GB and a keep time in days; it shows the GB-month used, the maximum
size for that duration, and the maximum days for that size. The size input
increments in 10 GB steps.

`expires_at` is stored on the task. A completed-task alarm deletes the output and
manifest at that time and keeps the small `.torrent` + task metadata. The UI then
shows “Files expired and were deleted.” This bounds a short-lived large object
instead of relying on a background billing system.

The UI shows a quota bar instead of the itemised cost table:

- projected GB-month at the requested keep time, against the 10 GB-month free
  allowance;
- room for another download kept for that many days;
- how many days the free allowance lasts at the current size;
- how long the current bucket can stay at this pace.

This is a safety policy, not a billing guarantee. Cloudflare's free allowances
are account-wide and include Workers requests, Durable Object requests/duration,
SQLite rows, and R2 Class A/B operations; there is no global ledger in this PoC.
The R2 storage check and expiry are the concrete quotas enforced per task. The
2 GiB output cap is deliberately lower than the billing example because staging
and the final output coexist; a 200 GB task needs `freeOnly=0` and is **not**
guaranteed to stay inside the free allowance with this staging design. Turn the
toggle off (or send `freeOnly=0`) to bypass the per-task caps; doing so requires
the admin token.

---

## Setup with `cf`

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

The Worker, Durable Object and R2 bucket are named `durabletorrent`,
`TorrentSession`, and `durabletorrent-blobs` in `cloudflare.config.ts`.

### Deploy from GitHub

`.github/workflows/deploy.yml` deploys on every push to `main`:

1. `npm ci`
2. `npm run typecheck`
3. `npx cf deploy`

It expects the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The token only needs Workers Scripts Write, Workers R2
Storage Write and Workers CI Write on the account. The repository is private.

### Type generation / typecheck

```bash
npx cf workers types
npm run typecheck
```

### Admin token

```bash
npx cf workers secrets update API_TOKEN --text '<your-token>' --worker durabletorrent
```

This is the Worker's admin token, not the `CLOUDFLARE_API_TOKEN` used by
GitHub Actions. Setting it makes the deployment read-only for everyone without
the token.

`cf` command names can change during the 1.0 RC; run `npx cf cli search "..."` or `npx cf --help` if a command differs.

---

## Self-test

Pure modules can be tested without workerd:

```bash
bun run scripts/selftest.ts
```

It covers bencode, torrent parsing, info hash, file/range selection, bitfield order, tracker compact peers, announce URL encoding, handshake/message framing, BEP 10 bit, piece queue, SHA-1, output-range trimming, and the cost helper.

Current result: **99 assertions passed**.

### Real download check

The deployed instance downloaded the first **8,388,607 bytes** of the official
Debian 13.8.0 amd64 netinst ISO via its torrent (32 of 3,032 pieces, 8 MiB
selection). The SHA-256 of the R2 output matched the same range fetched from
`cdimage.debian.org`. It completed in three scheduler waves. Staging was then
deleted automatically, leaving the torrent, 8 MiB output and manifest:
about **8.06 MiB** of R2 storage and a list-price estimate of roughly
**$0.00054**. The specific test task was later removed by the `DELETE /api/all`
check; the measurements above are from that run.

No copyrighted content was downloaded for testing; the Debian ISO is a
freely redistributable image.

---

