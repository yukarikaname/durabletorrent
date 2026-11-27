/**
 * Hard limits chosen for the PoC. They are deliberately conservative because a
 * single isolate has 128 MB of memory and an alarm handler has a 15 minute wall
 * clock budget.
 *
 * Values can be overridden through Worker vars where noted in config.ts.
 */
export const LIMITS = {
  /** Refuse .torrent files larger than this before parsing. */
  maxTorrentBytes: 8 * 1024 * 1024,

  /** Refuse torrents with more pieces than this (keeps SQLite init bounded). */
  maxPieces: 50_000,

  /** Refuse torrents with more file entries than this (keeps files_json bounded). */
  maxFiles: 10_000,

  /**
   * A complete piece must be buffered in memory before SHA-1 verification.
   * 6 peers x 4 MiB = 24 MiB of piece buffers, leaving room for runtime overhead.
   */
  maxPieceLength: 4 * 1024 * 1024,

  /** Cloudflare Workers allow at most 6 simultaneous outbound connection attempts. */
  maxPeers: 6,

  /** One alarm wave is capped well below the 15 minute alarm wall clock limit. */
  maxWaveMs: 8 * 60 * 1000,

  /** One wave stops after this many verified payload bytes. */
  maxWaveBytes: 64 * 1024 * 1024,

  /** Blocks requested ahead per peer (16 KiB each => 128 KiB in flight). */
  pipelineDepth: 8,

  /** Standard BitTorrent block size. */
  blockSize: 16 * 1024,

  /** A single peer message larger than this is considered hostile/broken. */
  maxPeerMessageBytes: 4 * 1024 * 1024 + 13,

  connectTimeoutMs: 15_000,
  handshakeTimeoutMs: 20_000,
  unchokeTimeoutMs: 30_000,
  idleTimeoutMs: 90_000,

  /** Drop a peer after this many failed hash verifications. */
  maxBadPiecesPerPeer: 2,

  /** Stop asking for a piece after this many failed attempts. */
  maxPieceAttempts: 5,

  /** R2 multipart parts must be at least 5 MiB (except the final part). */
  minR2PartSize: 5 * 1024 * 1024,
  defaultR2PartSize: 8 * 1024 * 1024,

  /** Finalization is split across alarms to stay under the alarm wall clock. */
  maxFinalizeMs: 6 * 60 * 1000,
  maxFinalizePartsPerAlarm: 64,

  /** R2 multipart supports part numbers 1..10000. */
  maxR2Parts: 10_000,

  /** Peer table housekeeping. */
  maxPeersInTable: 400,
  peerBanMs: 30 * 60 * 1000,

  /** Cap on tracker HTTP response body. */
  maxTrackerResponseBytes: 2 * 1024 * 1024,
} as const;

export const PEER_ID_PREFIX = "-CF0001-";
export const FAKE_LISTEN_PORT = 6881;
