/**
 * Bindings available to the Worker and its Durable Object.
 *
 * `API_TOKEN` is optional. When set (for example with `cf secrets` or
 * `wrangler secret put`), every /api request must send
 * `Authorization: Bearer <token>`.
 */
export interface Env {
  TORRENT_SESSION: DurableObjectNamespace;
  BLOBS: R2Bucket;

  /** String because Worker vars are strings; parsed and clamped in the DO. */
  MAX_PEERS?: string;
  R2_PART_SIZE?: string;
  MAX_WAVE_BYTES?: string;

  API_TOKEN?: string;
}
