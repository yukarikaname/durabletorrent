/**
 * Rough cost model for the PoC. This is an estimate, not an invoice:
 *  - Cloudflare bills account-wide included allowances, not per task.
 *  - DO duration is billed at 128 MB regardless of actual memory.
 *  - SQLite rows are estimated from the piece/wave shape; exact cursor stats
 *    are not persisted for every query.
 *  - Workers CPU is estimated from verified bytes; network wait time is not CPU.
 *
 * Prices below are Workers Paid / R2 Standard list prices as of 2026-11-27.
 */

export const PRICING_AS_OF = "2026-11-27";

export const PRICING = {
  workers: {
    monthlyBase: 5,
    includedRequests: 10_000_000,
    perMillionRequests: 0.3,
    includedCpuMs: 30_000_000,
    perMillionCpuMs: 0.02,
  },
  durableObjects: {
    includedRequests: 1_000_000,
    perMillionRequests: 0.15,
    includedGbSeconds: 400_000,
    perMillionGbSeconds: 12.5,
    memoryGb: 0.128,
    includedRowsRead: 25_000_000_000,
    perMillionRowsRead: 0.001,
    includedRowsWritten: 50_000_000,
    perMillionRowsWritten: 1.0,
  },
  r2: {
    includedStorageBytes: 10_000_000_000,
    perGbMonth: 0.015,
    includedClassA: 1_000_000,
    perMillionClassA: 4.5,
    includedClassB: 10_000_000,
    perMillionClassB: 0.36,
  },
} as const;

export interface TaskUsageMetrics {
  torrentBytes: number;
  stagingBytes: number;
  outputBytes: number;
  doRequests: number;
  alarmCount: number;
  waveDurationMs: number;
  r2PutOps: number;
  r2GetOps: number;
  trackerRequests: number;
  peerConnections: number;
  wantedPieces: number;
  verifiedPieces: number;
}

export interface CostEstimate {
  /** USD for the resources attributable to this task, excluding the $5 plan base. */
  total: number;
  lines: {
    r2StorageMonthly: number;
    r2ClassA: number;
    r2ClassB: number;
    doRequests: number;
    doDuration: number;
    sqliteReads: number;
    sqliteWrites: number;
    workersRequests: number;
    workersCpu: number;
  };
  units: {
    r2StorageBytes: number;
    r2StorageGb: number;
    r2ClassA: number;
    r2ClassB: number;
    doRequests: number;
    doGbSeconds: number;
    sqliteRowsRead: number;
    sqliteRowsWritten: number;
    workersRequests: number;
    workersCpuMs: number;
  };
  pricingAsOf: string;
  withinFreeTierIfOnlyTask: boolean;
  notes: string[];
}

export function estimateTaskCost(usage: TaskUsageMetrics): CostEstimate {
  const manifestBytes = usage.outputBytes > 0 ? 2048 : 0;
  const r2StorageBytes = usage.torrentBytes + usage.stagingBytes + usage.outputBytes + manifestBytes;
  const r2StorageGb = r2StorageBytes / 1e9;

  const r2ClassA = usage.r2PutOps + 1; // .torrent PUT happens in the Worker
  const r2ClassB = usage.r2GetOps; // includes the .torrent GET during init

  const doRequests = usage.doRequests + usage.alarmCount;
  const doGbSeconds = (usage.waveDurationMs / 1000) * PRICING.durableObjects.memoryGb;

  // Heuristics. Piece inserts/updates dominate; each alarm also writes the
  // alarm row and a task progress row.
  const sqliteRowsWritten =
    usage.wantedPieces + usage.verifiedPieces * 3 + usage.alarmCount * 6;
  const sqliteRowsRead =
    usage.wantedPieces + usage.verifiedPieces + usage.alarmCount * 12;

  const workersRequests = doRequests + 1;
  const workersCpuMs = Math.max(
    5,
    Math.ceil((usage.stagingBytes + usage.outputBytes) / (2 * 1024 * 1024)) + 5,
  );

  const lines = {
    r2StorageMonthly: r2StorageGb * PRICING.r2.perGbMonth,
    r2ClassA: (r2ClassA / 1e6) * PRICING.r2.perMillionClassA,
    r2ClassB: (r2ClassB / 1e6) * PRICING.r2.perMillionClassB,
    doRequests: (doRequests / 1e6) * PRICING.durableObjects.perMillionRequests,
    doDuration: (doGbSeconds / 1e6) * PRICING.durableObjects.perMillionGbSeconds,
    sqliteReads: (sqliteRowsRead / 1e6) * PRICING.durableObjects.perMillionRowsRead,
    sqliteWrites: (sqliteRowsWritten / 1e6) * PRICING.durableObjects.perMillionRowsWritten,
    workersRequests: (workersRequests / 1e6) * PRICING.workers.perMillionRequests,
    workersCpu: (workersCpuMs / 1e6) * PRICING.workers.perMillionCpuMs,
  };

  const total = Object.values(lines).reduce((sum, value) => sum + value, 0);

  const withinFreeTierIfOnlyTask =
    r2StorageBytes < PRICING.r2.includedStorageBytes &&
    r2ClassA < PRICING.r2.includedClassA &&
    r2ClassB < PRICING.r2.includedClassB &&
    doRequests < PRICING.durableObjects.includedRequests &&
    doGbSeconds < PRICING.durableObjects.includedGbSeconds &&
    sqliteRowsRead < PRICING.durableObjects.includedRowsRead &&
    sqliteRowsWritten < PRICING.durableObjects.includedRowsWritten &&
    workersRequests < PRICING.workers.includedRequests &&
    workersCpuMs < PRICING.workers.includedCpuMs;

  return {
    total,
    lines,
    units: {
      r2StorageBytes,
      r2StorageGb,
      r2ClassA,
      r2ClassB,
      doRequests,
      doGbSeconds,
      sqliteRowsRead,
      sqliteRowsWritten,
      workersRequests,
      workersCpuMs,
    },
    pricingAsOf: PRICING_AS_OF,
    withinFreeTierIfOnlyTask,
    notes: [
      "Excludes the $5/month Workers Paid base and account-wide free allowances.",
      "R2 storage is priced as if the objects were retained for one full month.",
      "DO duration is billed at the full 128 MB allocation, not actual memory use.",
      "SQLite rows are estimated from piece counts and bytes; SQLite storage ($0.20/GB-month, 5 GB free) is excluded because task metadata is small.",
      "Workers CPU is estimated from verified bytes; time spent waiting on network I/O is not CPU time.",
    ],
  };
}

export interface StorageEstimate {
  bytes: number;
  gb: number;
  /** List-price storage cost for this data for one month. */
  monthlyCost: number;
  /** Cost after the 10 GB-month R2 free allowance (account-wide). */
  billableMonthlyCost: number;
  billableBytes: number;
}

export function estimateR2Storage(bytes: number): StorageEstimate {
  const safeBytes = Math.max(0, bytes);
  const gb = safeBytes / 1e9;
  const billableGb = Math.max(0, gb - PRICING.r2.includedStorageBytes / 1e9);
  return {
    bytes: safeBytes,
    gb,
    monthlyCost: gb * PRICING.r2.perGbMonth,
    billableMonthlyCost: billableGb * PRICING.r2.perGbMonth,
    billableBytes: Math.max(0, safeBytes - PRICING.r2.includedStorageBytes),
  };
}

/**
 * Effective retention under the R2 free allowance, using the conservative
 * daily-peak model. `remainingGbMonth` is what is left after the current output
 * has already been counted for one day.
 *
 * A 200 GB object is ~6.67 GB-month for one day; after that day about 3.33
 * GB-month remain, so a second day is not free. The result is in hours.
 */
export function freeRetentionHours(
  remainingGbMonth: number,
  outputBytes: number,
  requestedHours: number,
): number {
  const requested = Math.max(1, Math.floor(requestedHours));
  const outputGb = Math.max(0, outputBytes) / 1e9;
  if (outputGb <= 0) return requested;
  const extraDays = Math.floor((Math.max(0, remainingGbMonth) * 30) / outputGb);
  const freeTotalDays = Math.max(1, 1 + extraDays);
  return Math.min(requested, freeTotalDays * 24);
}
