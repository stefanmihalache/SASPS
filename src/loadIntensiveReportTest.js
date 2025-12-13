/**
 *
 * Env knobs (optional):
 *   ITERATIONS=2
 *   WARMUP_SEC=10
 *   COOLDOWN_MS=1500
 *   CONCURRENCY=10,25,50,100,200
 *   READ_DURATION=60
 *   MIXED_DURATION=60
 *   WRITE_DURATION=30
 *   THRASH_DURATION=45
 *   WARM_CACHE_KEYS=2
 *   THRASH_KEYS=200
 *   RESERVOIR_SIZE=50000
 */

const autocannon = require("autocannon");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

// ---- Services (same as your test) ----
const SERVICES = [
    { name: "No-Caching", url: "http://localhost:3000", port: 3000 },
    { name: "Cache-Aside", url: "http://localhost:3001", port: 3001 },
    { name: "Write-Through", url: "http://localhost:3002", port: 3002 },
    { name: "Write-Behind", url: "http://localhost:3003", port: 3003 },
];

// ---- IDs (same as your test) ----
const PRODUCT_IDS_BASE = [
    "S10_1678", "S10_1949", "S10_2016", "S10_4698", "S10_4757",
    "S10_4962", "S12_1099", "S12_1108", "S12_1666", "S12_2823",
];

const CUSTOMER_IDS = [103, 112, 114, 119, 121, 124, 125, 128, 129, 131];

// ---- Config ----
const ITERATIONS = Number(process.env.ITERATIONS || 2);
const WARMUP_SEC = Number(process.env.WARMUP_SEC || 10);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 1500);

const CONCURRENCY_LEVELS = (process.env.CONCURRENCY || "10,25,50,100")
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

const READ_DURATION = Number(process.env.READ_DURATION || 60);
const MIXED_DURATION = Number(process.env.MIXED_DURATION || 60);
const WRITE_DURATION = Number(process.env.WRITE_DURATION || 30);
const THRASH_DURATION = Number(process.env.THRASH_DURATION || 45);

const WARM_CACHE_KEYS = Number(process.env.WARM_CACHE_KEYS || 2);
const THRASH_KEYS = Number(process.env.THRASH_KEYS || 200);

// For percentile sampling without storing every response time
const RESERVOIR_SIZE = Number(process.env.RESERVOIR_SIZE || 50_000);

// ---- Utility ----
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function nowISO() {
    return new Date().toISOString();
}
function osSnapshot() {
    const [l1, l5, l15] = os.loadavg();
    return {
        loadAvg1: l1,
        loadAvg5: l5,
        loadAvg15: l15,
        freeMemMB: os.freemem() / 1024 / 1024,
        totalMemMB: os.totalmem() / 1024 / 1024,
        cpuCount: os.cpus()?.length ?? null,
        platform: os.platform(),
        node: process.version,
    };
}
function processSnapshot() {
    const m = process.memoryUsage();
    return {
        rssMB: m.rss / 1024 / 1024,
        heapUsedMB: m.heapUsed / 1024 / 1024,
        heapTotalMB: m.heapTotal / 1024 / 1024,
        externalMB: m.external / 1024 / 1024,
    };
}

// event loop lag sampler (client-side)
function startEventLoopLagSampler(intervalMs = 100) {
    let maxLag = 0;
    let sumLag = 0;
    let count = 0;
    let last = performance.now();
    const t = setInterval(() => {
        const now = performance.now();
        const expected = last + intervalMs;
        const lag = Math.max(0, now - expected);
        maxLag = Math.max(maxLag, lag);
        sumLag += lag;
        count++;
        last = now;
    }, intervalMs);
    t.unref?.();
    return {
        stop() {
            clearInterval(t);
            return {
                eventLoopLagAvgMs: count ? sumLag / count : 0,
                eventLoopLagMaxMs: maxLag,
                samples: count,
            };
        },
    };
}

function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const w = idx - lo;
    return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function summarizeArray(arr) {
    if (!arr.length) {
        return { count: 0, min: null, max: null, mean: null, p50: null, p90: null, p95: null, p99: null };
    }
    const sorted = [...arr].sort((a, b) => a - b);
    let s = 0;
    for (const x of sorted) s += x;
    const mean = s / sorted.length;
    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean,
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
    };
}

// Reservoir sampling to cap memory usage
function makeReservoir(size) {
    const sample = [];
    let seen = 0;
    return {
        push(value) {
            seen++;
            if (sample.length < size) {
                sample.push(value);
            } else {
                // replace with decreasing probability
                const j = Math.floor(Math.random() * seen);
                if (j < size) sample[j] = value;
            }
        },
        values() {
            return sample;
        },
        countSeen() {
            return seen;
        },
    };
}

function pick(obj, paths, def = null) {
    for (const path of paths) {
        const parts = path.split(".");
        let cur = obj;
        let ok = true;
        for (const p of parts) {
            if (cur == null) { ok = false; break; }
            cur = cur[p];
        }
        if (ok && cur !== undefined && cur !== null) return cur;
    }
    return def;
}

// ---- Service helpers ----
async function waitForService(url) {
    const maxRetries = 30;
    for (let i = 0; i < maxRetries; i++) {
        try {
            await axios.get(`${url}/api/health`, { timeout: 2000 });
            return true;
        } catch (e) {
            if (i === maxRetries - 1) throw new Error(`Service ${url} not responding`);
            await sleep(1000);
        }
    }
}

async function resetStats(url) {
    try { await axios.post(`${url}/api/stats/reset`); } catch { /* ignore */ }
}

async function getStats(url) {
    try {
        const r = await axios.get(`${url}/api/stats`, { timeout: 10_000 });
        return r.data ?? null;
    } catch {
        return null;
    }
}

async function maybeFlushWriteBehind(service) {
    if (service.name !== "Write-Behind") return;
    try {
        await axios.post(`${service.url}/api/flush`, null, { timeout: 10_000 });
        await sleep(1500);
    } catch { /* ignore */ }
}

function diffStats(before, after) {
    if (!before || !after) return null;
    const d = {
        reads: (after.reads ?? 0) - (before.reads ?? 0),
        writes: (after.writes ?? 0) - (before.writes ?? 0),
        cacheHits: (after.cacheHits ?? 0) - (before.cacheHits ?? 0),
        cacheMisses: (after.cacheMisses ?? 0) - (before.cacheMisses ?? 0),
    };
    const total = d.cacheHits + d.cacheMisses;
    d.cacheHitRate = total > 0 ? d.cacheHits / total : null;

    if (after.queuedWrites !== undefined && before.queuedWrites !== undefined) {
        d.queuedWrites = after.queuedWrites - before.queuedWrites;
    }
    if (after.flushedWrites !== undefined && before.flushedWrites !== undefined) {
        d.flushedWrites = after.flushedWrites - before.flushedWrites;
    }
    return d;
}

// ---- Workload requests ----
const pickRand = (arr) => arr[Math.floor(Math.random() * arr.length)];

function buildReadRequests(productIds, customerIds) {
    return [
        { method: "GET", path: `/api/products/${pickRand(productIds)}` },
        { method: "GET", path: "/api/products?limit=50" },
        { method: "GET", path: `/api/customers/${pickRand(customerIds)}` },
    ];
}

function buildWriteRequests(productIds) {
    const id = productIds[0];
    return [
        {
            method: "PUT",
            path: `/api/products/${id}`,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                productName: "Updated Product " + Date.now(),
                quantityInStock: Math.floor(Math.random() * 1000),
                buyPrice: (Math.random() * 100).toFixed(2),
                MSRP: (Math.random() * 200).toFixed(2),
            }),
        },
    ];
}

function buildMixedRequests(productIds, customerIds) {
    return [
        { method: "GET", path: `/api/products/${pickRand(productIds)}`, weight: 7 },
        { method: "GET", path: "/api/products?limit=30", weight: 2 },
        {
            method: "PUT",
            path: `/api/products/${productIds[0]}`,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                productName: "Updated Product",
                quantityInStock: Math.floor(Math.random() * 1000),
                buyPrice: (Math.random() * 100).toFixed(2),
                MSRP: (Math.random() * 200).toFixed(2),
            }),
            weight: 1,
        },
    ];
}

function buildWarmCacheRequests(hotIds) {
    return [
        { method: "GET", path: `/api/products/${pickRand(hotIds)}`, weight: 9 },
        { method: "GET", path: "/api/products?limit=10", weight: 1 },
    ];
}

function buildThrashIds() {
    // Keep it safe: use only known IDs so you don’t turn the test into a 404 benchmark.
    // If you want true thrash with many real IDs, expand PRODUCT_IDS_BASE with real product codes.
    const ids = [];
    for (let i = 0; i < THRASH_KEYS; i++) ids.push(PRODUCT_IDS_BASE[i % PRODUCT_IDS_BASE.length]);
    return ids;
}

function buildThrashCacheRequests(thrashIds) {
    return [
        { method: "GET", path: `/api/products/${pickRand(thrashIds)}` },
        { method: "GET", path: "/api/products?limit=20" },
    ];
}

// ---- Autocannon runner with observed metrics ----
// Autocannon emits a "response" event with responseTime (ms). :contentReference[oaicite:2]{index=2}
function runAutocannonObserved({ url, connections, duration, requests, title }) {
    return new Promise((resolve, reject) => {
        const reservoir = makeReservoir(RESERVOIR_SIZE);
        let totalBytes = 0;
        const statusCounts = new Map();

        const instance = autocannon(
            { url, connections, duration, requests },
            (err, result) => {
                if (err) return reject(err);

                const samples = reservoir.values();
                const observedLatency = summarizeArray(samples);

                const actualSec =
                    pick(result, ["duration"], null) ??
                    duration;

                const observedBytesPerSec = actualSec ? (totalBytes / actualSec) : null;

                resolve({
                    title,
                    connections,
                    duration,
                    result,
                    observed: {
                        reservoirSeen: reservoir.countSeen(),
                        latencyMs: observedLatency,
                        bytesPerSec: observedBytesPerSec,
                        statusCounts: Object.fromEntries([...statusCounts.entries()].sort()),
                    },
                });
            }
        );

        instance.on("response", (client, statusCode, resBytes, responseTime) => {
            reservoir.push(responseTime);
            totalBytes += Number(resBytes || 0);
            statusCounts.set(statusCode, (statusCounts.get(statusCode) || 0) + 1);
        });

        instance.on("error", (e) => reject(e));
    });
}

function summarizeAutocannon(result) {
    // "requests" ~= Req/Sec, "throughput" ~= Bytes/Sec in autocannon output. :contentReference[oaicite:3]{index=3}
    const rpsMean = pick(result, ["requests.mean", "requests.average", "requests.avg"], null);
    const rpsP99 = pick(result, ["requests.p99"], null);

    const bytesMean = pick(result, ["throughput.mean", "throughput.average", "throughput.avg"], null);
    const bytesP99 = pick(result, ["throughput.p99"], null);

    const latencyMean = pick(result, ["latency.mean", "latency.average", "latency.avg"], null);
    const latencyP99 = pick(result, ["latency.p99"], null);
    const latencyP50 = pick(result, ["latency.p50"], null); // may or may not exist depending on version

    return {
        requestsTotal: pick(result, ["requests.total"], 0),
        rpsMean,
        rpsP99,
        bytesPerSecMean: bytesMean,
        bytesPerSecP99: bytesP99,
        latencyMeanMs: latencyMean,
        latencyP50Ms: latencyP50,
        latencyP99Ms: latencyP99,
        errors: pick(result, ["errors"], 0),
        timeouts: pick(result, ["timeouts"], 0),
        non2xx: pick(result, ["non2xx"], 0),
    };
}

function flattenRow(row) {
    const ac = row.autocannonSummary || {};
    const ob = row.observed || {};
    const obLat = ob.latencyMs || {};
    const sd = row.statsDelta || {};
    return {
        timestamp: row.timestamp,
        service: row.service,
        workload: row.workload, // read/write/mixed/cache-warm/cache-thrash
        iteration: row.iteration,
        connections: row.connections,
        duration: row.duration,

        // autocannon (aggregated)
        rpsMean: ac.rpsMean,
        bytesPerSecMean: ac.bytesPerSecMean,
        latencyMeanMs: ac.latencyMeanMs,
        latencyP99Ms: ac.latencyP99Ms,
        errors: ac.errors,
        timeouts: ac.timeouts,
        non2xx: ac.non2xx,

        // observed (from per-response timings)
        observedP50Ms: obLat.p50,
        observedP90Ms: obLat.p90,
        observedP95Ms: obLat.p95,
        observedP99Ms: obLat.p99,
        observedBytesPerSec: ob.bytesPerSec,
        observedSamples: obLat.count,
        reservoirSeen: ob.reservoirSeen,

        // cache stats delta
        cacheReads: sd.reads,
        cacheWrites: sd.writes,
        cacheHits: sd.cacheHits,
        cacheMisses: sd.cacheMisses,
        cacheHitRate: sd.cacheHitRate,
        queuedWrites: sd.queuedWrites,
        flushedWrites: sd.flushedWrites,

        // client metrics
        eventLoopLagAvgMs: row.client?.eventLoop?.eventLoopLagAvgMs,
        eventLoopLagMaxMs: row.client?.eventLoop?.eventLoopLagMaxMs,
        rssMB: row.client?.process?.rssMB,
        heapUsedMB: row.client?.process?.heapUsedMB,
        loadAvg1: row.client?.os?.loadAvg1,
        freeMemMB: row.client?.os?.freeMemMB,
    };
}

function toCSV(rows) {
    const headers = Object.keys(rows[0] || {});
    const lines = [headers.join(",")];
    for (const r of rows) {
        lines.push(
            headers
                .map((h) => {
                    const v = r[h];
                    const s = v === null || v === undefined ? "" : String(v);
                    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
                    return s;
                })
                .join(",")
        );
    }
    return lines.join("\n");
}

// ---- HTML report ----
function toHTMLReport(payload) {
    const data = JSON.stringify(payload);
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Intensive Cache Strategy Load Test</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 18px; }
    @media (min-width: 1100px) { .grid { grid-template-columns: 1fr 1fr; } }
    .card { border: 1px solid #e6e6e6; border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    h1 { font-size: 22px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 0 0 10px; }
    .meta { color: #555; font-size: 13px; line-height: 1.5; }
    canvas { width: 100% !important; height: 360px !important; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border-bottom: 1px solid #eee; padding: 8px; text-align: left; }
    th { background: #fafafa; position: sticky; top: 0; }
    .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; background:#f3f3f3; font-size: 12px; }
    .row { display:flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 0; }
    select { padding: 6px 10px; border-radius: 10px; border: 1px solid #ddd; }
    .hint { font-size: 12px; color:#666; margin-top:6px; }
  </style>
</head>
<body>
  <h1>Intensive Cache Strategy Load Test</h1>
  <div class="meta" id="meta"></div>

  <div class="row">
    <div>
      <div class="meta">View</div>
      <select id="viewSel">
        <option value="workload">By workload</option>
        <option value="rw">Read vs Write</option>
      </select>
      <div class="hint">“Read vs Write” overlays read+write lines per service.</div>
    </div>

    <div id="workloadWrap">
      <div class="meta">Workload</div>
      <select id="workloadSel"></select>
    </div>

    <div>
      <div class="meta">Metric</div>
      <select id="metricSel">
        <option value="rps">Throughput (Req/Sec)</option>
        <option value="bps">Throughput (Bytes/Sec)</option>
        <option value="p50">Latency p50 (ms)</option>
        <option value="p90">Latency p90 (ms)</option>
        <option value="p95">Latency p95 (ms)</option>
        <option value="p99">Latency p99 (ms)</option>
        <option value="hit">Cache hit rate (%)</option>
        <option value="err">Error rate (%)</option>
      </select>
      <div class="hint">Latency percentiles come from observed per-response timings.</div>
    </div>
  </div>

  <div class="grid" style="margin-top:16px;">
    <div class="card" style="grid-column: 1 / -1;">
      <h2 id="chartTitle">Chart</h2>
      <canvas id="chartMain"></canvas>
    </div>

    <div class="card" style="grid-column: 1 / -1;">
      <h2>All Runs (flattened)</h2>
      <div style="max-height:420px; overflow:auto;">
        <table id="tbl"></table>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script>
    const PAYLOAD = ${data};
    const rows = PAYLOAD.flatRows || [];

    function fmt(x, d=2) {
      if (x === null || x === undefined) return null;
      const n = Number(x);
      if (!Number.isFinite(n)) return null;
      return n;
    }
    function uniqueSorted(arr) { return [...new Set(arr)].sort((a,b)=>a-b); }

    const meta = PAYLOAD.meta || {};
    document.getElementById("meta").innerHTML =
      \`<div><b>Started:</b> \${meta.startedAt || "n/a"} | <b>Finished:</b> \${meta.finishedAt || "n/a"}</div>\` +
      \`<div><b>Config:</b> iterations=\${meta.config?.iterations}, warmup=\${meta.config?.warmupSec}s, conc=[\${(meta.config?.concurrency||[]).join(", ")}], reservoir=\${meta.config?.reservoirSize}</div>\`;

    // selectors
    const workloadSel = document.getElementById("workloadSel");
    const viewSel = document.getElementById("viewSel");
    const metricSel = document.getElementById("metricSel");
    const workloadWrap = document.getElementById("workloadWrap");

    const workloads = uniqueSorted(rows.map(r => r.workload));
    workloads.forEach(w => {
      const opt = document.createElement("option");
      opt.value = w; opt.textContent = w;
      workloadSel.appendChild(opt);
    });

    const services = uniqueSorted(rows.map(r => r.service));
    let chart;

    function getY(metric, r) {
      if (metric === "rps") return fmt(r.rpsMean);
      if (metric === "bps") return fmt(r.observedBytesPerSec ?? r.bytesPerSecMean);
      if (metric === "p50") return fmt(r.observedP50Ms ?? r.latencyMeanMs);
      if (metric === "p90") return fmt(r.observedP90Ms);
      if (metric === "p95") return fmt(r.observedP95Ms);
      if (metric === "p99") return fmt(r.observedP99Ms ?? r.latencyP99Ms);
      if (metric === "hit") {
        const hr = (r.cacheHitRate === null || r.cacheHitRate === undefined) ? null : Number(r.cacheHitRate) * 100;
        return fmt(hr);
      }
      if (metric === "err") {
        // approximate with (errors+timeouts+non2xx) / requestsTotal if available
        const denom = Math.max(1, Number(r.requestsTotal || 0));
        const e = Number(r.errors||0) + Number(r.timeouts||0) + Number(r.non2xx||0);
        return fmt((e / denom) * 100);
      }
      return null;
    }

    function titleFor(metric) {
      if (metric === "rps") return "Throughput (Req/Sec) vs Concurrency";
      if (metric === "bps") return "Throughput (Bytes/Sec) vs Concurrency";
      if (metric === "p50") return "Latency p50 (ms) vs Concurrency";
      if (metric === "p90") return "Latency p90 (ms) vs Concurrency";
      if (metric === "p95") return "Latency p95 (ms) vs Concurrency";
      if (metric === "p99") return "Latency p99 (ms) vs Concurrency";
      if (metric === "hit") return "Cache hit rate (%) vs Concurrency";
      if (metric === "err") return "Error rate (%) vs Concurrency";
      return "Chart";
    }

    function render() {
      const view = viewSel.value;
      workloadWrap.style.display = (view === "workload") ? "block" : "none";

      const metric = metricSel.value;
      document.getElementById("chartTitle").textContent = titleFor(metric);

      let dataRows = rows;

      // Reduce noise: average across iterations per service+connections+workload
      function aggregate(rowsIn) {
        const map = new Map();
        for (const r of rowsIn) {
          const k = r.service + "|" + r.workload + "|" + r.connections;
          const cur = map.get(k) || { service:r.service, workload:r.workload, connections:r.connections, n:0, sum:0, sumHit:0, sumErr:0, countHit:0, countErr:0 };
          cur.n += 1;
          const y = getY(metric, r);
          if (y !== null) { cur.sum += y; }
          if (metric === "hit") { if (y !== null) { cur.sumHit += y; cur.countHit++; } }
          if (metric === "err") { if (y !== null) { cur.sumErr += y; cur.countErr++; } }
          map.set(k, cur);
        }
        const out = [];
        for (const v of map.values()) {
          const denom = (metric === "hit") ? Math.max(1, v.countHit)
                       : (metric === "err") ? Math.max(1, v.countErr)
                       : Math.max(1, v.n);
          out.push({
            service: v.service,
            workload: v.workload,
            connections: v.connections,
            y: (metric === "hit") ? (v.sumHit / denom)
               : (metric === "err") ? (v.sumErr / denom)
               : (v.sum / denom),
          });
        }
        return out;
      }

      let agg;
      if (view === "workload") {
        const w = workloadSel.value || workloads[0];
        dataRows = rows.filter(r => r.workload === w);
        agg = aggregate(dataRows);
      } else {
        // Read vs Write overlay: only use "read" and "write"
        dataRows = rows.filter(r => (r.workload === "read" || r.workload === "write"));
        agg = aggregate(dataRows);
      }

      const conc = uniqueSorted(agg.map(x => x.connections));

      function datasetFor(label, filterFn) {
        const filtered = agg.filter(filterFn);
        const m = new Map(filtered.map(x => [x.connections, x]));
        return {
          label,
          data: conc.map(c => m.get(c)?.y ?? null)
        };
      }

      const datasets = [];
      if (view === "workload") {
        for (const svc of services) {
          datasets.push(datasetFor(svc, x => x.service === svc));
        }
      } else {
        for (const svc of services) {
          datasets.push(datasetFor(svc + " - READ", x => x.service === svc && x.workload === "read"));
          datasets.push(datasetFor(svc + " - WRITE", x => x.service === svc && x.workload === "write"));
        }
      }

      const chartData = { labels: conc, datasets };

      const yTitle =
        metric === "rps" ? "Req/Sec" :
        metric === "bps" ? "Bytes/Sec" :
        metric === "hit" ? "Cache hit rate (%)" :
        metric === "err" ? "Error rate (%)" :
        "ms";

      const options = {
        responsive: true,
        plugins: { legend: { position: "bottom" } },
        scales: {
          x: { title: { display: true, text: "Connections (concurrency)" } },
          y: { title: { display: true, text: yTitle } }
        }
      };

      if (chart) chart.destroy();
      chart = new Chart(document.getElementById("chartMain"), {
        type: "line",
        data: chartData,
        options
      });
    }

    // table
    const tbl = document.getElementById("tbl");
    const headers = Object.keys(rows[0] || {});
    tbl.innerHTML =
      "<thead><tr>" + headers.map(h => "<th>"+h+"</th>").join("") + "</tr></thead>" +
      "<tbody>" +
      rows.map(r => "<tr>" + headers.map(h => "<td>"+String(r[h] ?? "")+"</td>").join("") + "</tr>").join("") +
      "</tbody>";

    workloadSel.addEventListener("change", render);
    viewSel.addEventListener("change", render);
    metricSel.addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

// ---- Main Runner ----
async function main() {
    console.log("\n🔥 Intensive autocannon suite starting…");

    const meta = {
        startedAt: nowISO(),
        host: osSnapshot(),
        config: {
            iterations: ITERATIONS,
            warmupSec: WARMUP_SEC,
            cooldownMs: COOLDOWN_MS,
            concurrency: CONCURRENCY_LEVELS,
            durations: { READ_DURATION, MIXED_DURATION, WRITE_DURATION, THRASH_DURATION },
            warmCacheKeys: WARM_CACHE_KEYS,
            thrashKeys: THRASH_KEYS,
            reservoirSize: RESERVOIR_SIZE,
        },
    };

    const rows = [];
    const flatRows = [];

    for (const service of SERVICES) {
        console.log(`\n${"=".repeat(72)}\nService: ${service.name} (${service.url})\n${"=".repeat(72)}`);

        await waitForService(service.url);
        console.log("✓ ready");

        // Warmup: cache-warm workload to stabilize
        await resetStats(service.url);
        await sleep(800);

        const warmHotIds = PRODUCT_IDS_BASE.slice(0, Math.max(1, WARM_CACHE_KEYS));
        console.log(`♨️ warmup ${WARMUP_SEC}s (cache-warm)`);
        await runAutocannonObserved({
            url: service.url,
            connections: Math.max(10, CONCURRENCY_LEVELS[0] || 10),
            duration: WARMUP_SEC,
            requests: buildWarmCacheRequests(warmHotIds),
            title: "warmup-cache-warm",
        });
        await sleep(1000);

        const workloads = [
            { name: "read", duration: READ_DURATION, build: () => buildReadRequests(PRODUCT_IDS_BASE, CUSTOMER_IDS) },
            { name: "mixed", duration: MIXED_DURATION, build: () => buildMixedRequests(PRODUCT_IDS_BASE, CUSTOMER_IDS) },
            { name: "write", duration: WRITE_DURATION, build: () => buildWriteRequests(PRODUCT_IDS_BASE) },
            { name: "cache-warm", duration: READ_DURATION, build: () => buildWarmCacheRequests(warmHotIds) },
            { name: "cache-thrash", duration: THRASH_DURATION, build: () => buildThrashCacheRequests(buildThrashIds()) },
        ];

        for (const wl of workloads) {
            console.log(`\n🏁 Workload: ${wl.name}`);

            for (const c of CONCURRENCY_LEVELS) {
                for (let it = 1; it <= ITERATIONS; it++) {
                    console.log(`   ▶ connections=${c}, duration=${wl.duration}s, iteration=${it}/${ITERATIONS}`);

                    await resetStats(service.url);
                    await sleep(400);

                    const before = await getStats(service.url);
                    const lag = startEventLoopLagSampler(100);

                    const run = await runAutocannonObserved({
                        url: service.url,
                        connections: c,
                        duration: wl.duration,
                        requests: wl.build(),
                        title: wl.name,
                    });

                    if (service.name === "Write-Behind" && (wl.name === "write" || wl.name === "mixed")) {
                        await maybeFlushWriteBehind(service);
                    }

                    const after = await getStats(service.url);
                    const eventLoop = lag.stop();

                    const autocannonSummary = summarizeAutocannon(run.result);

                    const row = {
                        timestamp: nowISO(),
                        service: service.name,
                        url: service.url,
                        workload: wl.name,
                        iteration: it,
                        connections: c,
                        duration: wl.duration,

                        autocannonRaw: run.result,
                        autocannonSummary,

                        observed: run.observed,

                        statsBefore: before,
                        statsAfter: after,
                        statsDelta: diffStats(before, after),

                        client: {
                            eventLoop,
                            process: processSnapshot(),
                            os: osSnapshot(),
                        },
                    };

                    rows.push(row);
                    flatRows.push(flattenRow(row));

                    const p95 = row.observed?.latencyMs?.p95;
                    console.log(
                        `      rps=${autocannonSummary.rpsMean?.toFixed?.(2) ?? "n/a"} | ` +
                        `bytes/s=${(row.observed?.bytesPerSec ?? autocannonSummary.bytesPerSecMean)?.toFixed?.(0) ?? "n/a"} | ` +
                        `p95(observed)=${p95?.toFixed?.(2) ?? "n/a"}ms | ` +
                        `errors=${autocannonSummary.errors} non2xx=${autocannonSummary.non2xx}`
                    );

                    await sleep(COOLDOWN_MS);
                }
            }
        }
    }

    meta.finishedAt = nowISO();

    const payload = { meta, rows, flatRows };

    const outJson = path.resolve(process.cwd(), "intensive-results.json");
    const outCsv = path.resolve(process.cwd(), "intensive-results.csv");
    const outHtml = path.resolve(process.cwd(), "intensive-report.html");

    fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), "utf8");
    fs.writeFileSync(outCsv, toCSV(flatRows), "utf8");
    fs.writeFileSync(outHtml, toHTMLReport(payload), "utf8");

    console.log("\n✅ Done");
    console.log("JSON:", outJson);
    console.log("CSV :", outCsv);
    console.log("HTML:", outHtml);
}

main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
});
