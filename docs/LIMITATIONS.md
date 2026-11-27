# Limitations and known gotchas

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
- **Staging is deleted automatically after completion.** The completed task keeps the output, manifest and source torrent; staging cleanup is a separate resumable alarm. If cleanup fails, it retries, and `POST /api/torrents/:infoHash/cleanup` is available manually.
- **One R2 PUT per verified piece.** Torrents with 16–256 KiB pieces create many Class A operations. This is simple and resumable, but not the cheapest design for very large torrents.
- **Staging read amplification:** finalization reads overlapping pieces through R2 range GETs; a piece may be read more than once if selected ranges are fragmented.
- **Large task deletion** can take many R2 list/delete calls (1000 keys per call) and may exceed a request's practical time.
- **Delete all** discovers task IDs from R2 keys (`torrents/`, `downloads/`, `staging/`). A task whose torrent object was manually deleted and that has no remaining R2 keys cannot be discovered without a global task index.
- **DO SQLite init is O(wanted pieces).** 50,000 piece rows is the PoC cap and can take noticeable CPU.
- **Free plan CPU is 10 ms.** Use Workers Paid for real torrent parsing and SHA-1 verification; the deployed config does not request a custom CPU limit because the Free plan rejects it.
- **Alarm wall clock is 15 minutes.** Waves are capped at 8 minutes and finalization at 6 minutes.
- **DO eviction:** in-memory claims/bitfields are lost; SQLite rebuilds them at the next wave. A TCP socket keeps a DO alive for up to 15 minutes.
- **`cf` CLI 1.0 RC** requires Node 22.23+/24.22+/26.12+ and cannot build under Bun. `cf` command names may change.

### UI / security

- The UI is same-origin and stores the admin token in `localStorage`. That is convenient for a PoC, not a hardened admin console.
- There is one shared admin token, not per-user accounts. Anyone with the token can change everything.
- If `API_TOKEN` is unset, mutations are open to anyone with the URL.
- Tracker URLs and peer endpoints are user/tracker supplied. The runtime blocks private/Cloudflare IPs and the code filters obvious private ranges, but this is not a substitute for an allowlist in a public deployment.
- Torrent filenames are sanitized for R2 keys, but the manifest preserves the original path strings for display.

### Legal

BitTorrent is a legitimate protocol. Download only content you have the rights to. This PoC intentionally does not upload/seed, but that does not remove legal or network-policy obligations.

---

