import { bindings, defineConfig, exports } from "cf/config";

// cf CLI project configuration. This file is the source of truth for `cf dev`,
// `cf build` and `cf deploy`.
export default defineConfig({
  worker: {
    name: "durabletorrent",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-11-01",

    env: {
      // Durable Object namespace. `worker` refers back to this Worker.
      TORRENT_SESSION: bindings.durableObject({
        worker: "durabletorrent",
        exportName: "TorrentSession",
      }),

      // Torrent files, verified piece staging objects and final output.
      BLOBS: bindings.r2({ name: "durabletorrent-blobs" }),

      // Operational knobs. Parsed and clamped by the Durable Object.
      MAX_PEERS: bindings.text("6"),
      R2_PART_SIZE: bindings.text("8388608"),
      MAX_WAVE_BYTES: bindings.text("67108864"),
    },

    exports: {
      // SQLite-backed Durable Object. The class is exported from src/index.ts.
      TorrentSession: exports.durableObject({ storage: "sqlite" }),
    },

    observability: { enabled: true },
    workersDev: true,
  },
});
