/**
 * Single-file UI served by the Worker.
 *
 * Design direction: a BitTorrent "intake desk" rather than a generic dashboard.
 * The piece map is the one loud element; everything else is quiet, ruled and
 * operational. No card kit, no gradient washes, no all-caps labels. The
 * background is graph paper because the subject is a grid of pieces.
 *
 * The design follows Anthropic's `frontend-design` guidance:
 * https://github.com/anthropics/skills/tree/main/skills/frontend-design
 */
export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DurableTorrent — BitTorrent intake desk</title>
<style>
  :root {
    --paper: #e4e9e4;
    --paper-2: #f2f3ed;
    --ink: #102b2f;
    --ink-2: #48615e;
    --line: #b8c5bd;
    --line-strong: #82968c;
    --signal: #dfa33a;
    --verified: #2f7d64;
    --danger: #a33a31;
    --dark: #0b2024;
    --dark-2: #123238;
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    --sans: "Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif;
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }

  * { box-sizing: border-box; }

  html { background: var(--paper); }

  body {
    margin: 0;
    color: var(--ink);
    font: 14.5px/1.55 var(--sans);
    background-color: var(--paper);
    background-image:
      linear-gradient(to right, rgba(16, 43, 47, .045) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(16, 43, 47, .045) 1px, transparent 1px);
    background-size: 24px 24px;
    -webkit-font-smoothing: antialiased;
  }

  ::selection { background: var(--signal); color: var(--dark); }

  :focus-visible {
    outline: 2px solid var(--signal);
    outline-offset: 2px;
  }

  .shell {
    max-width: 1260px;
    margin: 0 auto;
    padding: 30px 28px 54px;
  }

  .masthead {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 28px;
    border-bottom: 1px solid var(--line-strong);
    padding-bottom: 16px;
  }

  .identity { display: flex; gap: 14px; align-items: flex-start; }

  .glyph {
    display: grid;
    grid-template-columns: repeat(3, 7px);
    grid-template-rows: repeat(3, 7px);
    gap: 2px;
    margin-top: 8px;
  }
  .glyph i { background: var(--ink); }
  .glyph i:nth-child(2),
  .glyph i:nth-child(6),
  .glyph i:nth-child(8) { background: var(--signal); }

  .wordmark {
    font-family: var(--serif);
    font-size: 38px;
    line-height: .95;
    letter-spacing: -.03em;
    font-weight: 600;
  }
  .tagline { margin: 5px 0 0; color: var(--ink-2); font-size: 12.5px; }

  .access { min-width: 240px; }
  .access label { display: block; font-size: 12px; color: var(--ink-2); margin-bottom: 4px; }
  .access-row { display: flex; gap: 6px; }

  .input {
    width: 100%;
    border: 1px solid var(--line-strong);
    background: var(--paper-2);
    color: var(--ink);
    font: inherit;
    padding: 8px 9px;
    border-radius: 0;
  }
  .input:focus { border-color: var(--ink); outline: none; }
  .input.compact { width: auto; }

  .button {
    border: 1px solid var(--ink);
    background: transparent;
    color: var(--ink);
    font: 13px/1.2 var(--sans);
    padding: 8px 12px;
    border-radius: 0;
    cursor: pointer;
  }
  .button:hover { background: rgba(16, 43, 47, .06); }
  .button.primary {
    background: var(--ink);
    color: var(--paper-2);
    border-color: var(--ink);
    box-shadow: inset 0 -3px 0 var(--signal);
  }
  .button.primary:hover { background: var(--dark-2); }
  .button.quiet { border-color: var(--line-strong); color: var(--ink-2); }
  .button.danger { border-color: var(--danger); color: var(--danger); }
  .button.small { padding: 6px 9px; font-size: 12px; }
  .button.wide { width: 100%; margin-top: 8px; }
  .button:disabled { opacity: .5; cursor: wait; }

  .desk {
    display: grid;
    grid-template-columns: 286px minmax(0, 1fr);
    gap: 38px;
    margin-top: 26px;
  }

  .rail {
    border-right: 1px solid var(--line);
    padding-right: 28px;
    position: sticky;
    top: 18px;
    align-self: start;
  }

  .steps {
    list-style: none;
    margin: 0 0 26px;
    padding: 0;
  }
  .step {
    display: flex;
    gap: 11px;
    align-items: baseline;
    padding: 8px 0;
    border-bottom: 1px dotted var(--line);
    color: var(--ink-2);
    font-size: 13px;
  }
  .step:last-child { border-bottom: 0; }
  .step-number {
    font-family: var(--serif);
    font-size: 21px;
    line-height: 1;
    width: 20px;
    color: var(--line-strong);
    font-variant-numeric: lining-nums;
  }
  .step.is-active { color: var(--ink); }
  .step.is-active .step-number { color: var(--signal); }

  h2 {
    font-family: var(--serif);
    font-size: 20px;
    line-height: 1.15;
    font-weight: 600;
    margin: 0 0 10px;
    letter-spacing: -.01em;
  }
  h1 {
    font-family: var(--serif);
    font-size: 30px;
    line-height: 1.1;
    font-weight: 600;
    letter-spacing: -.025em;
    margin: 0;
  }

  .drop {
    border: 1px dashed var(--line-strong);
    padding: 18px 14px;
    text-align: center;
    background: rgba(242, 243, 237, .45);
  }
  .drop.over { border-color: var(--ink); background: rgba(223, 163, 58, .12); }
  .drop p { margin: 0 0 10px; color: var(--ink-2); font-size: 13px; }
  .drop strong { color: var(--ink); font-weight: 600; }
  #file { display: none; }

  .field {
    display: block;
    margin-top: 14px;
    font-size: 12px;
    color: var(--ink-2);
  }
  .field .input, .field textarea { margin-top: 4px; }

  .note {
    color: var(--ink-2);
    font-size: 12px;
    line-height: 1.45;
    margin: 10px 0 0;
    max-width: 62ch;
  }

  .busy { min-height: 18px; margin-top: 10px; color: var(--ink-2); font-size: 12px; }
  .busy:not(:empty)::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 7px;
    background: var(--signal);
    vertical-align: 1px;
  }

  .inspect { margin-top: 26px; border-top: 1px solid var(--line); padding-top: 16px; }
  .hidden { display: none !important; }

  .file-list { max-height: 260px; overflow: auto; border-top: 1px solid var(--line); }
  .file-list label {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 7px 0;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .file-list input { margin-top: 3px; accent-color: var(--ink); }
  .file-path { word-break: break-all; }
  .file-meta { color: var(--ink-2); font-size: 11.5px; }

  .button-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }

  .work { min-width: 0; }

  .transfer { border-top: 2px solid var(--ink); padding-top: 14px; }
  .transfer-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
  }
  .transfer-head .note { margin-top: 5px; }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    color: var(--ink-2);
    white-space: nowrap;
    padding-top: 5px;
  }
  .status-dot { width: 8px; height: 8px; background: var(--line-strong); display: inline-block; }
  .status.downloading .status-dot,
  .status.finalizing .status-dot { background: var(--signal); }
  .status.completed .status-dot { background: var(--verified); }
  .status.paused .status-dot { background: var(--line-strong); }
  .status.failed .status-dot { background: var(--danger); }

  .map-wrap {
    position: relative;
    margin-top: 14px;
    background: var(--dark);
    border: 1px solid var(--ink);
    aspect-ratio: 16 / 7;
    min-height: 210px;
    max-height: 360px;
    overflow: hidden;
  }
  #pieceMap { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

  .map-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(228, 233, 228, .62);
    font-family: var(--serif);
    font-size: 17px;
    pointer-events: none;
  }

  .map-scan {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 90px;
    left: -90px;
    pointer-events: none;
    background: linear-gradient(90deg, transparent, rgba(223, 163, 58, .14), transparent);
    opacity: 0;
  }
  .map-wrap.is-running .map-scan {
    opacity: 1;
    animation: scan 5s linear infinite;
  }
  @keyframes scan {
    from { transform: translateX(0); }
    to { transform: translateX(calc(100vw + 180px)); }
  }

  .map-legend {
    position: absolute;
    right: 9px;
    bottom: 7px;
    display: flex;
    gap: 13px;
    color: rgba(228, 233, 228, .72);
    font-size: 11px;
    pointer-events: none;
  }
  .map-legend span { display: inline-flex; align-items: center; gap: 5px; }
  .swatch { width: 8px; height: 8px; display: inline-block; }
  .swatch.verified { background: var(--signal); }
  .swatch.missing { background: #24454a; border: 1px solid #3f6266; }

  .readout {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border-top: 1px solid var(--line);
    border-left: 1px solid var(--line);
    margin-top: 14px;
  }
  .readout-item {
    border-right: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    padding: 9px 11px;
  }
  .readout-value {
    display: block;
    font-family: var(--serif);
    font-size: 21px;
    line-height: 1.1;
    letter-spacing: -.01em;
    font-variant-numeric: tabular-nums;
  }
  .readout-label { display: block; color: var(--ink-2); font-size: 11.5px; margin-top: 2px; }

  .error {
    border-left: 3px solid var(--danger);
    background: rgba(163, 58, 49, .07);
    color: var(--danger);
    padding: 9px 11px;
    font-size: 12.5px;
    white-space: pre-wrap;
    margin: 12px 0 0;
  }

  .drawer {
    border-top: 1px solid var(--line);
    margin-top: 16px;
    padding-top: 9px;
  }
  .drawer summary {
    cursor: pointer;
    font-family: var(--serif);
    font-size: 16px;
    color: var(--ink);
  }
  .plain-list { margin: 8px 0 0; padding: 0; list-style: none; }
  .plain-list li {
    padding: 5px 0;
    border-bottom: 1px dotted var(--line);
    font-size: 12.5px;
    word-break: break-all;
  }
  .plain-list li:last-child { border-bottom: 0; }
  .muted { color: var(--ink-2); }

  .cost { margin-top: 8px; max-width: 620px; }
  .cost-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    padding: 4px 0;
    border-bottom: 1px dotted var(--line);
    font-size: 12.5px;
  }
  .cost-row.total {
    border-bottom: 0;
    border-top: 1px solid var(--ink);
    margin-top: 5px;
    padding-top: 7px;
    font-weight: 600;
  }
  .cost-row .amount { font-variant-numeric: tabular-nums; text-align: right; }
  .cost-units { margin-top: 8px; color: var(--ink-2); font-size: 11.5px; line-height: 1.5; }

  .storage { margin-top: 34px; border-top: 1px solid var(--line-strong); padding-top: 14px; }
  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .section-head .button-row { margin-top: 0; }

  .table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
  .table th, .table td {
    text-align: left;
    padding: 7px 6px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  .table th { color: var(--ink-2); font-weight: 500; }
  .table td.key { max-width: 430px; word-break: break-all; }
  .table a { color: var(--ink); text-decoration-color: var(--line-strong); }
  .table a:hover { text-decoration-color: var(--ink); }

  .log-section { margin-top: 30px; border-top: 1px solid var(--line-strong); padding-top: 14px; }
  .log {
    margin: 0;
    min-height: 76px;
    max-height: 180px;
    overflow: auto;
    background: var(--dark);
    color: #c9d7cf;
    border: 1px solid var(--ink);
    padding: 10px 11px;
    font: 11.5px/1.55 var(--mono);
    white-space: pre-wrap;
  }
  .log:empty::before { content: "No activity yet."; color: rgba(201, 215, 207, .45); }

  .footer {
    max-width: 1260px;
    margin: 42px auto 0;
    padding: 14px 28px 0;
    border-top: 1px solid var(--line);
    color: var(--ink-2);
    font-size: 11.5px;
  }

  @media (max-width: 860px) {
    .shell { padding: 22px 18px 40px; }
    .masthead { flex-direction: column; gap: 16px; }
    .access { width: 100%; }
    .desk { grid-template-columns: 1fr; gap: 28px; }
    .rail { border-right: 0; border-bottom: 1px solid var(--line); padding: 0 0 20px; position: static; }
    .steps { display: flex; gap: 16px; margin-bottom: 20px; }
    .step { border-bottom: 0; padding: 0; }
    .step-number { font-size: 18px; width: 16px; }
    .readout { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .transfer-head { flex-direction: column; gap: 8px; }
    .map-wrap { aspect-ratio: 4 / 3; }
    .footer { padding-left: 18px; padding-right: 18px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .map-wrap.is-running .map-scan { animation: none; opacity: 0; }
    * { scroll-behavior: auto !important; }
  }
</style>
</head>
<body>
<div class="shell">
  <header class="masthead">
    <div class="identity">
      <div class="glyph" aria-hidden="true">
        <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
      </div>
      <div>
        <div class="wordmark">DurableTorrent</div>
        <p class="tagline">A BitTorrent intake desk for Cloudflare Workers, Durable Objects and R2.</p>
      </div>
    </div>
    <div class="access">
      <label for="token">API token, if the Worker requires one</label>
      <div class="access-row">
        <input id="token" class="input" type="password" autocomplete="off" placeholder="Optional">
        <button id="saveToken" class="button small">Save</button>
      </div>
    </div>
  </header>

  <main class="desk">
    <aside class="rail">
      <ol class="steps" aria-label="Workflow">
        <li class="step is-active" id="stepAdd"><span class="step-number">1</span><span>Start a transfer</span></li>
        <li class="step" id="stepWatch"><span class="step-number">2</span><span>Watch pieces</span></li>
        <li class="step" id="stepGet"><span class="step-number">3</span><span>Retrieve files</span></li>
      </ol>

      <section class="intake">
        <h2>Add a torrent</h2>
        <div id="drop" class="drop">
          <p><strong>Drop a .torrent file</strong> or a magnet link here.</p>
          <button id="browse" class="button">Choose a file</button>
          <input id="file" type="file" accept=".torrent,application/x-bittorrent">
        </div>

        <label class="field" for="magnet">Magnet link
          <input id="magnet" class="input" placeholder="magnet:?xt=urn:btih:...&tr=https://...">
        </label>
        <button id="addMagnet" class="button wide">Resolve magnet</button>

        <label class="field" for="trackers">Trackers to add
          <textarea id="trackers" class="input" rows="2" placeholder="One URL per line, or comma separated"></textarea>
        </label>
        <p class="note">Magnet metadata uses BEP 9 over TCP. Workers has no DHT or UDP tracker support, so a magnet needs an HTTP(S) tracker.</p>
        <div id="busy" class="busy" role="status" aria-live="polite"></div>
      </section>

      <section id="inspect" class="inspect hidden">
        <h2>Choose files</h2>
        <p id="inspectMeta" class="note"></p>
        <div id="fileList" class="file-list"></div>
        <div class="button-row">
          <button id="startSelected" class="button primary">Start download</button>
          <button id="cancelInspect" class="button quiet">Cancel</button>
        </div>
      </section>
    </aside>

    <div class="work">
      <section class="transfer" aria-labelledby="taskName">
        <div class="transfer-head">
          <div>
            <h1 id="taskName">No transfer yet</h1>
            <p id="taskSub" class="note">Drop a torrent or resolve a magnet to begin.</p>
          </div>
          <div id="taskStatus" class="status idle" aria-live="polite">
            <span class="status-dot" aria-hidden="true"></span>
            <span id="statusText">idle</span>
          </div>
        </div>

        <div class="map-wrap" id="mapWrap">
          <canvas id="pieceMap" role="img" aria-label="Verified piece map"></canvas>
          <div class="map-empty" id="mapEmpty">The piece map fills as blocks verify.</div>
          <div class="map-scan" aria-hidden="true"></div>
          <div class="map-legend" aria-hidden="true">
            <span><i class="swatch verified"></i>verified</span>
            <span><i class="swatch missing"></i>missing</span>
          </div>
        </div>

        <div id="stats" class="readout"></div>
        <div id="actions" class="button-row"></div>
        <p id="error" class="error hidden" role="alert"></p>

        <details class="drawer">
          <summary>Files in this torrent</summary>
          <ul id="files" class="plain-list"></ul>
        </details>

        <details class="drawer">
          <summary>Trackers</summary>
          <ul id="trackersList" class="plain-list"></ul>
          <div class="button-row">
            <input id="newTracker" class="input" aria-label="New tracker URL" placeholder="https://tracker.example/announce">
            <button id="addTracker" class="button">Add tracker</button>
          </div>
        </details>

        <details class="drawer" open>
          <summary>Estimated cost</summary>
          <div id="cost" class="cost"></div>
          <p class="note">List prices, not an invoice. Free allowances are account-wide, and the $5 monthly Workers plan base is excluded.</p>
        </details>
      </section>

      <section class="storage">
        <div class="section-head">
          <h2>R2 storage</h2>
          <div class="button-row">
            <select id="filePrefix" class="input compact" aria-label="R2 prefix filter">
              <option value="">All prefixes</option>
              <option value="downloads/">downloads/</option>
              <option value="torrents/">torrents/</option>
              <option value="staging/">staging/</option>
            </select>
            <button id="refreshFiles" class="button">Refresh</button>
          </div>
        </div>
        <p id="storageSummary" class="note"></p>
        <table class="table">
          <thead><tr><th>Object</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
          <tbody id="fileRows"><tr><td colspan="4" class="muted">No data loaded.</td></tr></tbody>
        </table>
      </section>

      <section class="log-section">
        <h2>Activity</h2>
        <pre id="log" class="log"></pre>
      </section>
    </div>
  </main>

  <footer class="footer">DurableTorrent is a proof of concept. Download only content you have the rights to use.</footer>
</div>

<script>
(function () {
  "use strict";

  var state = {
    id: null,
    timer: null,
    pendingFile: null,
    pendingMeta: null,
    lastTask: null,
    token: ""
  };

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function bytes(value) {
    var n = Number(value) || 0;
    var units = ["B", "KiB", "MiB", "GiB", "TiB"];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + " " + units[i];
  }
  function money(value) {
    var n = Number(value) || 0;
    if (n === 0) return "$0.000000";
    if (n < 0.000001) return "<$0.000001";
    return "$" + n.toFixed(6);
  }
  function countLabel(n, singular, plural) {
    return n + " " + (n === 1 ? singular : plural);
  }
  function date(value) {
    if (!value) return "";
    try { return new Date(value).toLocaleString(); } catch (e) { return String(value); }
  }
  function log(message) {
    var line = "[" + new Date().toLocaleTimeString() + "] " + message + "\n";
    $("log").textContent = line + $("log").textContent;
  }
  function setBusy(text) { $("busy").textContent = text || ""; }
  function setError(message) {
    var el = $("error");
    if (!message) { el.textContent = ""; el.classList.add("hidden"); return; }
    el.textContent = message;
    el.classList.remove("hidden");
  }
  function step(id) {
    ["stepAdd", "stepWatch", "stepGet"].forEach(function (key) {
      $(key).classList.toggle("is-active", key === id);
    });
  }

  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (state.token) headers["authorization"] = "Bearer " + state.token;
    var response = await fetch(path, Object.assign({}, options, { headers: headers }));
    var text = await response.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { error: text }; }
    if (!response.ok) {
      if (response.status === 401) log("401: set the API token at the top of the page");
      throw new Error(data && data.error ? data.error : "HTTP " + response.status);
    }
    return data;
  }

  function parseTrackers(value) {
    return String(value || "").split(/[,\s]+/).map(function (v) { return v.trim(); })
      .filter(function (v) { return /^https?:\/\//i.test(v); });
  }

  async function inspectFile(file) {
    if (!file) return;
    state.pendingFile = file;
    setBusy("Reading " + file.name + "...");
    setError("");
    try {
      var meta = await api("/api/torrents/inspect", {
        method: "POST",
        headers: { "content-type": "application/x-bittorrent" },
        body: file
      });
      state.pendingMeta = meta;
      $("inspectMeta").textContent = meta.name + " has " + countLabel(meta.files.length, "file", "files") + " and " +
        meta.pieceCount + " pieces of " + bytes(meta.pieceLength) + ". " + bytes(meta.totalLength) + " total.";
      $("fileList").innerHTML = meta.files.map(function (f) {
        return '<label><input type="checkbox" value="' + f.index + '"' + (f.padding ? "" : " checked") +
          (f.padding ? " disabled" : "") + '>' +
          '<span><span class="file-path">' + esc(f.path) + '</span><br>' +
          '<span class="file-meta">' + bytes(f.length) + (f.padding ? ", padding file" : "") + '</span></span></label>';
      }).join("") || '<p class="note">No files.</p>';
      $("inspect").classList.remove("hidden");
      step("stepAdd");
      $("inspect").scrollIntoView({ behavior: "smooth", block: "nearest" });
      log("read " + meta.name + ", info hash " + meta.infoHash);
    } catch (error) {
      setError(error.message);
      log("could not read the torrent: " + error.message);
    } finally {
      setBusy("");
    }
  }

  async function startSelected() {
    if (!state.pendingFile) return;
    var checked = Array.prototype.slice.call(document.querySelectorAll("#fileList input[type=checkbox]:checked"));
    var files = checked.map(function (cb) { return Number(cb.value); });
    if (files.length === 0) { setError("Choose at least one file."); return; }

    var trackers = parseTrackers($("trackers").value);
    var qs = new URLSearchParams();
    qs.set("files", files.join(","));
    if (trackers.length) qs.set("trackers", trackers.join(","));

    setBusy("Creating the transfer...");
    setError("");
    try {
      var task = await api("/api/torrents?" + qs.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-bittorrent" },
        body: state.pendingFile
      });
      $("inspect").classList.add("hidden");
      setCurrent(task);
      log("created transfer " + task.id);
    } catch (error) {
      setError(error.message);
      log("could not create the transfer: " + error.message);
    } finally {
      setBusy("");
    }
  }

  async function addMagnet() {
    var magnet = $("magnet").value.trim();
    if (!magnet) { setError("Paste a magnet link first."); return; }
    var trackers = parseTrackers($("trackers").value);
    setBusy("Looking for metadata in the swarm. This can take up to about 45 seconds.");
    setError("");
    try {
      var task = await api("/api/magnets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ magnet: magnet, trackers: trackers })
      });
      setCurrent(task);
      log("magnet resolved through " + (task.magnet ? task.magnet.metadataPeer : "a peer"));
    } catch (error) {
      setError(error.message);
      log("magnet failed: " + error.message);
    } finally {
      setBusy("");
    }
  }

  function setCurrent(task) {
    state.id = task.id;
    state.lastTask = task;
    try { history.replaceState(null, "", "?task=" + task.id); } catch (e) {}
    $("mapEmpty").classList.add("hidden");
    step("stepWatch");
    renderTask(task);
    startPolling();
    refreshFiles().catch(function (error) { log("could not refresh storage: " + error.message); });
    $("taskName").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bitAt(hex, index) {
    if (!hex) return false;
    var byteIndex = index >> 3;
    var pair = hex.slice(byteIndex * 2, byteIndex * 2 + 2);
    if (pair.length !== 2) return false;
    var byte = parseInt(pair, 16);
    if (!isFinite(byte)) return false;
    return (byte & (0x80 >> (index & 7))) !== 0;
  }

  function drawMap(pieceCount, hex, running) {
    var canvas = $("pieceMap");
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var width = Math.max(1, rect.width);
    var height = Math.max(1, rect.height);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = "#0b2024";
    ctx.fillRect(0, 0, width, height);

    var hasTask = Number(pieceCount) > 0;
    var count = hasTask ? Number(pieceCount) : 384;
    var cols;
    if (count <= 240) {
      var target = width / height;
      var bestScore = Infinity;
      cols = 1;
      for (var candidate = 1; candidate <= count; candidate++) {
        var candidateRows = Math.ceil(count / candidate);
        var score = Math.abs(candidate / candidateRows - target) + Math.abs(candidate * candidateRows - count) * 0.001;
        if (score < bestScore) { bestScore = score; cols = candidate; }
      }
    } else {
      cols = Math.max(1, Math.ceil(Math.sqrt(count * (width / height))));
    }
    var rows = Math.ceil(count / cols);
    var cell = Math.min((width - 28) / cols, (height - 28) / rows);
    cell = Math.max(1, cell);
    var gridW = cell * cols;
    var gridH = cell * rows;
    var ox = (width - gridW) / 2;
    var oy = (height - gridH) / 2;
    var gap = cell >= 3 ? 1 : 0;

    ctx.strokeStyle = "rgba(228, 233, 228, .075)";
    ctx.lineWidth = 1;
    for (var c = 0; c <= cols; c++) {
      var x = Math.round(ox + c * cell) + .5;
      ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy + gridH); ctx.stroke();
    }
    for (var r = 0; r <= rows; r++) {
      var y = Math.round(oy + r * cell) + .5;
      ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox + gridW, y); ctx.stroke();
    }

    if (!hasTask || count <= 240) {
      ctx.fillStyle = "#17363b";
      for (var i = 0; i < count; i++) {
        var cx = i % cols;
        var cy = Math.floor(i / cols);
        ctx.fillRect(ox + cx * cell + gap, oy + cy * cell + gap, Math.max(1, cell - gap * 2), Math.max(1, cell - gap * 2));
      }
    }

    if (hasTask) {
      ctx.fillStyle = "#dfa33a";
      for (var p = 0; p < count; p++) {
        if (!bitAt(hex, p)) continue;
        var px = p % cols;
        var py = Math.floor(p / cols);
        ctx.fillRect(ox + px * cell + gap, oy + py * cell + gap, Math.max(1, cell - gap * 2), Math.max(1, cell - gap * 2));
      }
    }

    ctx.strokeStyle = "rgba(228, 233, 228, .22)";
    ctx.strokeRect(Math.round(ox) + .5, Math.round(oy) + .5, Math.round(gridW), Math.round(gridH));
    $("mapWrap").classList.toggle("is-running", Boolean(running));
  }

  function renderTask(t) {
    state.lastTask = t;
    $("taskName").textContent = t.name;
    $("taskSub").textContent = (t.pieceCount || 0) + " pieces of " + bytes(t.pieceLength) +
      ", " + bytes(t.totalLength) + " total. " + countLabel((t.files ? t.files.length : 0), "file", "files") + ".";

    var status = $("taskStatus");
    status.className = "status " + t.status;
    $("statusText").textContent = t.status;

    var percent = Math.max(0, Math.min(100, (Number(t.progress) || 0) * 100));
    drawMap(t.pieceCount, t.verifiedBitmap, t.status === "downloading" || t.status === "finalizing");
    $("mapEmpty").classList.toggle("hidden", Boolean(t.pieceCount));

    var values = [
      [percent.toFixed(1) + "%", "verified"],
      [bytes(t.verifiedBytes) + " / " + bytes(t.wantedBytes), "transferred"],
      [bytes(t.leftBytes), "left"],
      [String(t.peerCount || 0), "peers"],
      [String((t.trackers || []).length), "trackers"],
      [bytes(t.usage ? t.usage.storedBytes : 0), "stored in R2"]
    ];
    $("stats").innerHTML = values.map(function (item) {
      return '<div class="readout-item"><span class="readout-value">' + esc(item[0]) +
        '</span><span class="readout-label">' + esc(item[1]) + '</span></div>';
    }).join("");

    var actions = [];
    if (t.status === "downloading" || t.status === "finalizing") {
      actions.push('<button class="button" onclick="app.pause()">Pause transfer</button>');
    }
    if (t.status === "paused" || t.status === "failed") {
      actions.push('<button class="button primary" onclick="app.resume()">Resume transfer</button>');
    }
    if (t.status === "completed") {
      actions.push('<button class="button primary" onclick="app.download()">Download file</button>');
      actions.push('<button class="button" onclick="app.manifest()">Open manifest</button>');
    }
    actions.push('<button class="button quiet" onclick="app.refresh()">Refresh</button>');
    actions.push('<button class="button danger" onclick="app.remove()">Delete transfer</button>');
    $("actions").innerHTML = actions.join("");

    setError(t.lastError || "");

    $("files").innerHTML = ((t.files || []).map(function (f) {
      var stateText = f.padding ? "padding, not written" : (f.selected === false ? "not included" : "included");
      return '<li><span class="file-path">' + esc(f.path) + '</span> <span class="muted">' +
        bytes(f.length) + ", " + stateText + '</span></li>';
    }).join("") || '<li class="muted">No files.</li>') +
      (t.filesTruncated ? '<li class="muted">Showing the first ' + t.files.length + ' of ' + t.fileCount +
        ' files. The manifest has the full list.</li>' : "");

    $("trackersList").innerHTML = (t.trackers || []).map(function (url) {
      return '<li>' + esc(url) + '</li>';
    }).join("") || '<li class="muted">No HTTP(S) trackers yet.</li>';

    renderCost(t);
    if (t.status === "completed") step("stepGet");
  }

  function renderCost(t) {
    if (!t.estimatedCost) { $("cost").innerHTML = '<p class="note">No estimate yet.</p>'; return; }
    var c = t.estimatedCost;
    var rows = [
      ["R2 storage for one month", c.lines.r2StorageMonthly],
      ["R2 Class A operations", c.lines.r2ClassA],
      ["R2 Class B operations", c.lines.r2ClassB],
      ["Durable Object requests", c.lines.doRequests],
      ["Durable Object duration", c.lines.doDuration],
      ["SQLite rows read", c.lines.sqliteReads],
      ["SQLite rows written", c.lines.sqliteWrites],
      ["Worker requests", c.lines.workersRequests],
      ["Worker CPU", c.lines.workersCpu]
    ];
    var html = rows.map(function (row) {
      return '<div class="cost-row"><span>' + esc(row[0]) + '</span><span class="amount">' + money(row[1]) + '</span></div>';
    }).join("");
    html += '<div class="cost-row total"><span>Total, excluding the plan base</span><span class="amount">' + money(c.total) + '</span></div>';
    html += '<p class="cost-units">' + bytes(c.units.r2StorageBytes) + " stored; " +
      c.units.r2ClassA + " Class A and " + c.units.r2ClassB + " Class B operations; " +
      c.units.doRequests + " Durable Object requests; " + c.units.doGbSeconds.toFixed(4) +
      " GB-seconds; " + c.units.sqliteRowsWritten + " SQLite rows written. Prices as of " +
      esc(c.pricingAsOf) + ".</p>";
    html += '<p class="note">' + (c.withinFreeTierIfOnlyTask
      ? "This transfer alone is likely inside the account free allowances."
      : "This transfer alone may exceed one or more free allowances.") + "</p>";
    $("cost").innerHTML = html;
  }

  function startPolling() {
    stopPolling();
    var tick = async function () {
      if (!state.id) return;
      try {
        var task = await api("/api/torrents/" + state.id + "?bits=1");
        renderTask(task);
        if (task.status !== "completed" && task.status !== "failed") {
          state.timer = setTimeout(tick, 2000);
        } else {
          state.timer = null;
          refreshFiles().catch(function () {});
        }
      } catch (error) {
        log("status refresh failed: " + error.message);
        state.timer = setTimeout(tick, 5000);
      }
    };
    tick();
  }
  function stopPolling() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  }

  function tokenQuery() { return state.token ? "?token=" + encodeURIComponent(state.token) : ""; }
  function fileUrl(key) {
    return "/api/files/object?key=" + encodeURIComponent(key) +
      (state.token ? "&token=" + encodeURIComponent(state.token) : "");
  }

  async function refreshFiles() {
    var prefix = $("filePrefix").value;
    var data = await api("/api/files?all=1&prefix=" + encodeURIComponent(prefix));
    var rows = (data.objects || []).map(function (o) {
      var encoded = encodeURIComponent(o.key).replace(/'/g, "%27");
      return '<tr><td class="key">' + esc(o.key) + '</td><td>' + bytes(o.size) + '</td><td>' +
        esc(date(o.uploaded)) + '</td><td><a href="' + esc(fileUrl(o.key)) + '">download</a> ' +
        '<button class="button small danger" onclick="app.deleteFile(\'' + encoded + '\')">delete</button></td></tr>';
    }).join("");
    $("fileRows").innerHTML = rows || '<tr><td colspan="4" class="muted">No objects.</td></tr>';
    var summary = (data.objects || []).length + " objects, " + bytes(data.totalBytes || 0);
    if (data.estimatedStorage) {
      summary += ". About " + money(data.estimatedStorage.monthlyCost) + " per month at list price";
      if (data.listingCapped) summary += " (listing capped, totals are partial)";
    }
    $("storageSummary").textContent = summary + ".";
  }

  window.app = {
    pause: async function () {
      try { await api("/api/torrents/" + state.id + "/pause", { method: "POST" }); } catch (e) { setError(e.message); }
    },
    resume: async function () {
      try { await api("/api/torrents/" + state.id + "/start", { method: "POST" }); } catch (e) { setError(e.message); }
    },
    refresh: async function () {
      try { renderTask(await api("/api/torrents/" + state.id + "?bits=1")); } catch (e) { setError(e.message); }
    },
    remove: async function () {
      if (!state.id) return;
      if (!confirm("Delete this transfer and its R2 objects?")) return;
      try {
        var result = await api("/api/torrents/" + state.id, { method: "DELETE" });
        if (result.cleanupErrors && result.cleanupErrors.length) {
          log("cleanup warnings: " + result.cleanupErrors.join("; "));
        }
        stopPolling(); state.id = null; state.lastTask = null;
        $("taskName").textContent = "No transfer yet";
        $("taskSub").textContent = "Drop a torrent or resolve a magnet to begin.";
        $("taskStatus").className = "status idle";
        $("statusText").textContent = "idle";
        $("stats").innerHTML = "";
        $("actions").innerHTML = "";
        $("files").innerHTML = "";
        $("trackersList").innerHTML = "";
        $("cost").innerHTML = "";
        $("error").classList.add("hidden");
        $("mapEmpty").classList.remove("hidden");
        drawMap(0, "", false);
        step("stepAdd");
        try { history.replaceState(null, "", location.pathname); } catch (e) {}
        await refreshFiles();
        log("transfer deleted");
      } catch (e) { setError(e.message); }
    },
    download: function () {
      if (!state.id) return;
      window.location.href = "/api/torrents/" + state.id + "/download" + tokenQuery();
    },
    manifest: function () {
      if (!state.id) return;
      window.location.href = "/api/torrents/" + state.id + "/manifest" + tokenQuery();
    },
    deleteFile: async function (encoded) {
      var key = decodeURIComponent(encoded);
      var warning = (key.indexOf("staging/") === 0 || key.indexOf("torrents/") === 0)
        ? "\n\nDeleting this object can break a running transfer."
        : "";
      if (!confirm("Delete this R2 object?\n" + key + warning)) return;
      try {
        await api("/api/files/object?key=" + encodeURIComponent(key), { method: "DELETE" });
        log("deleted " + key);
        await refreshFiles();
      } catch (e) { setError(e.message); }
    }
  };

  function wire() {
    var stored = localStorage.getItem("cfTorrentToken") || "";
    state.token = stored;
    $("token").value = stored;

    $("saveToken").onclick = function () {
      state.token = $("token").value.trim();
      localStorage.setItem("cfTorrentToken", state.token);
      log("API token saved locally");
      refreshFiles().catch(function () {});
    };
    $("browse").onclick = function () { $("file").click(); };
    $("file").onchange = function () { if ($("file").files[0]) inspectFile($("file").files[0]); };
    $("startSelected").onclick = startSelected;
    $("cancelInspect").onclick = function () {
      state.pendingFile = null; state.pendingMeta = null;
      $("inspect").classList.add("hidden");
    };
    $("addMagnet").onclick = addMagnet;
    $("addTracker").onclick = async function () {
      if (!state.id) { setError("Add a transfer first."); return; }
      var urls = parseTrackers($("newTracker").value);
      if (!urls.length) { setError("Enter an HTTP(S) tracker URL."); return; }
      try {
        var task = await api("/api/torrents/" + state.id + "/trackers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ urls: urls })
        });
        renderTask(task);
        $("newTracker").value = "";
        log("trackers added");
      } catch (e) { setError(e.message); }
    };
    $("refreshFiles").onclick = function () { refreshFiles().catch(function (e) { setError(e.message); }); };
    $("filePrefix").onchange = function () { refreshFiles().catch(function (e) { setError(e.message); }); };

    var drop = $("drop");
    drop.ondragover = function (event) { event.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = function () { drop.classList.remove("over"); };
    drop.ondrop = function (event) {
      event.preventDefault(); drop.classList.remove("over");
      var file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) { inspectFile(file); return; }
      var text = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      if (text && /^magnet:/i.test(text.trim())) {
        $("magnet").value = text.trim();
        addMagnet();
      }
    };

    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (!state.lastTask) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.lastTask) {
          drawMap(state.lastTask.pieceCount, state.lastTask.verifiedBitmap,
            state.lastTask.status === "downloading" || state.lastTask.status === "finalizing");
        }
      }, 120);
    });

    drawMap(0, "", false);
    refreshFiles().catch(function (e) { log("initial storage read failed: " + e.message); });

    var requested = new URLSearchParams(location.search).get("task");
    if (requested && /^[0-9a-f]{40}$/.test(requested)) {
      state.id = requested;
      api("/api/torrents/" + requested + "?bits=1")
        .then(function (task) {
          $("mapEmpty").classList.add("hidden");
          step("stepWatch");
          renderTask(task);
          startPolling();
        })
        .catch(function (e) {
          state.id = null;
          try { history.replaceState(null, "", location.pathname); } catch (ignored) {}
          log("could not open the requested transfer: " + e.message);
        });
    }
  }

  wire();
})();
</script>
</body>
</html>`;
