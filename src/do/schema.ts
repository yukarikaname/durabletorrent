/**
 * SQLite schema for one torrent session (one Durable Object).
 *
 * The `task` table is a singleton row. `piece` only contains *wanted* pieces;
 * pieces outside the selection are never inserted, which keeps a partial
 * download's database small. `verified_bitmap` is a denormalized cache over
 * `piece.state = 'verified'` and is rebuilt from the piece table at the start
 * of every wave.
 */

export type TaskStatus =
  | "queued"
  | "downloading"
  | "finalizing"
  | "completed"
  | "paused"
  | "failed";

export type PieceState = "missing" | "inflight" | "verified";

export type SqlBlob = ArrayBuffer;
export type SqlRowValue = ArrayBuffer | string | number | null;

export interface TaskRow extends Record<string, SqlRowValue> {
  id: string;
  info_hash: ArrayBuffer;
  name: string;
  status: TaskStatus;
  torrent_key: string;
  output_key: string | null;
  manifest_key: string | null;
  piece_length: number;
  piece_count: number;
  total_length: number;
  wanted_pieces: number;
  wanted_bytes: number;
  output_bytes: number;
  verified_pieces: number;
  verified_bytes: number;
  downloaded_bytes: number;
  wanted_bitmap: ArrayBuffer;
  verified_bitmap: ArrayBuffer;
  selection_json: string;
  files_json: string;
  trackers_json: string;
  peer_id: ArrayBuffer;
  multipart_upload_id: string | null;
  multipart_parts_json: string | null;
  finalize_cursor: number;
  finalize_part: number;
  announcements: number;
  wave_count: number;
  consecutive_failures: number;
  last_error: string | null;
  torrent_bytes: number;
  do_requests: number;
  alarm_count: number;
  wave_duration_ms: number;
  r2_put_ops: number;
  r2_get_ops: number;
  tracker_requests: number;
  peer_connections: number;
  staging_cleaned: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface PieceRow extends Record<string, SqlRowValue> {
  idx: number;
  hash: ArrayBuffer;
  length: number;
  state: PieceState;
  attempts: number;
  peer: string | null;
  verified_at: number | null;
}

export interface PeerRow extends Record<string, SqlRowValue> {
  addr: string;
  host: string;
  port: number;
  state: string;
  fail_count: number;
  success_count: number;
  downloaded: number;
  last_seen: number | null;
  last_error: string | null;
  banned_until: number | null;
}

export interface TrackerRow extends Record<string, SqlRowValue> {
  url: string;
  tier: number;
  last_announce: number | null;
  next_announce: number | null;
  fails: number;
  last_error: string | null;
}

export function ensureSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS task (
      id TEXT PRIMARY KEY,
      info_hash BLOB NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      torrent_key TEXT NOT NULL,
      output_key TEXT,
      manifest_key TEXT,
      piece_length INTEGER NOT NULL,
      piece_count INTEGER NOT NULL,
      total_length INTEGER NOT NULL,
      wanted_pieces INTEGER NOT NULL,
      wanted_bytes INTEGER NOT NULL,
      output_bytes INTEGER NOT NULL,
      verified_pieces INTEGER NOT NULL DEFAULT 0,
      verified_bytes INTEGER NOT NULL DEFAULT 0,
      downloaded_bytes INTEGER NOT NULL DEFAULT 0,
      wanted_bitmap BLOB NOT NULL,
      verified_bitmap BLOB NOT NULL,
      selection_json TEXT NOT NULL,
      files_json TEXT NOT NULL,
      trackers_json TEXT NOT NULL,
      peer_id BLOB NOT NULL,
      multipart_upload_id TEXT,
      multipart_parts_json TEXT,
      finalize_cursor INTEGER NOT NULL DEFAULT 0,
      finalize_part INTEGER NOT NULL DEFAULT 1,
      announcements INTEGER NOT NULL DEFAULT 0,
      wave_count INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      torrent_bytes INTEGER NOT NULL DEFAULT 0,
      do_requests INTEGER NOT NULL DEFAULT 0,
      alarm_count INTEGER NOT NULL DEFAULT 0,
      wave_duration_ms INTEGER NOT NULL DEFAULT 0,
      r2_put_ops INTEGER NOT NULL DEFAULT 0,
      r2_get_ops INTEGER NOT NULL DEFAULT 0,
      tracker_requests INTEGER NOT NULL DEFAULT 0,
      peer_connections INTEGER NOT NULL DEFAULT 0,
      staging_cleaned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS piece (
      idx INTEGER PRIMARY KEY,
      hash BLOB NOT NULL,
      length INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'missing',
      attempts INTEGER NOT NULL DEFAULT 0,
      peer TEXT,
      verified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS piece_state_idx ON piece(state);

    CREATE TABLE IF NOT EXISTS peer (
      addr TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'known',
      fail_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      downloaded INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER,
      last_error TEXT,
      banned_until INTEGER
    );

    CREATE TABLE IF NOT EXISTS tracker (
      url TEXT PRIMARY KEY,
      tier INTEGER NOT NULL DEFAULT 0,
      last_announce INTEGER,
      next_announce INTEGER,
      fails INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Forward-compatible migration for databases created by an older build.
  // New deployments get all columns from the CREATE TABLE above.
  const existing = new Set(
    sql
      .exec<{ name: string }>("PRAGMA table_info(task)")
      .toArray()
      .map((row) => String(row.name)),
  );
  const additions: Record<string, string> = {
    torrent_bytes: "INTEGER NOT NULL DEFAULT 0",
    do_requests: "INTEGER NOT NULL DEFAULT 0",
    alarm_count: "INTEGER NOT NULL DEFAULT 0",
    wave_duration_ms: "INTEGER NOT NULL DEFAULT 0",
    r2_put_ops: "INTEGER NOT NULL DEFAULT 0",
    r2_get_ops: "INTEGER NOT NULL DEFAULT 0",
    tracker_requests: "INTEGER NOT NULL DEFAULT 0",
    peer_connections: "INTEGER NOT NULL DEFAULT 0",
    staging_cleaned: "INTEGER NOT NULL DEFAULT 0",
  };
  for (const [column, definition] of Object.entries(additions)) {
    if (!existing.has(column)) {
      sql.exec(`ALTER TABLE task ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function queryAll<T extends Record<string, SqlRowValue>>(
  sql: SqlStorage,
  query: string,
  ...bindings: unknown[]
): T[] {
  return sql.exec<T>(query, ...bindings).toArray();
}

export function queryOne<T extends Record<string, SqlRowValue>>(
  sql: SqlStorage,
  query: string,
  ...bindings: unknown[]
): T | null {
  const rows = queryAll<T>(sql, query, ...bindings);
  return rows.length > 0 ? rows[0] : null;
}

export function getTask(sql: SqlStorage): TaskRow | null {
  return queryOne<TaskRow>(sql, "SELECT * FROM task LIMIT 1");
}
