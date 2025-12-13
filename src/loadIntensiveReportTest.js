/**
 * load-test-per-strategy.js
 *
 * - Runs the same tests for all caching strategies
 * - Saves per-strategy JSON/CSV + per-strategy HTML graph
 * - Also saves one combined JSON/CSV + ONE combined HTML graph comparing ALL strategies
 * - Includes 100 connections by default (10,25,50,100)
 *
 * Install:
 *   npm i autocannon axios
 *
 * Run:
 *   node load-test-per-strategy.js
 *
 * Optional:
 *   ONLY_SERVICE="Cache-Aside" node load-test-per-strategy.js
 *   CONCURRENCY=10,25,50,100,200 ITERATIONS=2 READ_DURATION=60 MIXED_DURATION=60 WRITE_DURATION=20 node load-test-per-strategy.js
 */

const autocannon = require("autocannon");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");

// -------------------- Same services --------------------
const SERVICES = [
    { name: "No-Caching", url: "http://localhost:3000", port: 3000 },
    { name: "Cache-Aside", url: "http://localhost:3001", port: 3001 },
    { name: "Write-Through", url: "http://localhost:3002", port: 3002 },
    { name: "Write-Behind", url: "http://localhost:3003", port: 3003 },
];

const PRODUCT_IDS = [
    "S10_1678", "S10_1949", "S10_2016", "S10_4698", "S10_4757",
    "S10_4962", "S12_1099", "S12_1108", "S12_1666", "S12_2823",
];

const CUSTOMER_IDS = [103, 112, 114, 119, 121, 124, 125, 128, 129, 131];

// -------------------- Config (env overridable) --------------------
const ITERATIONS = Number(process.env.ITERATIONS || 1); // start with 1 to validate it works
const WARMUP_SEC = Number(process.env.WARMUP_SEC || 5);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 800);

const CONCURRENCY_LEVELS = (process.env.CONCURRENCY || "10,25,50,100")
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

const READ_DURATION = Number(process.env.READ_DURATION || 30);
const WRITE_DURATION = Number(process.env.WRITE_DURATION || 10);
const MIXED_DURATION = Number(process.env.MIXED_DURATION || 30);

// If you want only one service while debugging:
// ONLY_SERVICE="Cache-Aside" node load-test-per-strategy.js
const ONLY_SERVICE = process.env.ONLY_SERVICE || "";

// -------------------- Helpers --------------------
function nowISO() {
    return new Date().toISOString();
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function pickRand(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

async function waitForService(url) {
    const maxRetries = 30;
    for (let i = 0; i < maxRetries; i++) {
        try {
            await axios.get(`${url}/api/health`, { timeout: 2000 });
            return true;
        } catch (e) {
            if (i === maxRetries - 1) throw new Error(`Service ${url} is not responding`);
            await sleep(1000);
        }
    }
}

async function resetStats(url) {
    try {
        await axios.post(`${url}/api/stats/reset`, null, { timeout: 10_000 });
    } catch {
        // ignore
    }
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
    } catch {
        // ignore
    }
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

function runAutocannon({ url, connections, duration, requests }) {
    return new Promise((resolve, reject) => {
        autocannon({ url, connections, duration, requests }, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

// Requests (same spirit as your original)
function buildReadRequests() {
    return [
        { method: "GET", path: `/api/products/${pickRand(PRODUCT_IDS)}` },
        { method: "GET", path: "/api/products?limit=50" },
        { method: "GET", path: `/api/customers/${pickRand(CUSTOMER_IDS)}` },
    ];
}

function buildWriteRequests() {
    return [
        {
            method: "PUT",
            path: `/api/products/${PRODUCT_IDS[0]}`,
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

function buildMixedRequests() {
    return [
        { method: "GET", path: `/api/products/${pickRand(PRODUCT_IDS)}`, weight: 7 },
        { method: "GET", path: "/api/products?limit=30", weight: 2 },
        {
            method: "PUT",
            path: `/api/products/${PRODUCT_IDS[0]}`,
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

function extractMetrics(ac) {
    // autocannon typical fields:
    // - requests.mean = req/sec
    // - throughput.mean = bytes/sec
    // - latency.mean/p95/p99 in ms
    return {
        requestsTotal: ac?.requests?.total ?? 0,
        rpsMean: ac?.requests?.mean ?? null,
        rpsP99: ac?.requests?.p99 ?? null,
        bytesPerSecMean: ac?.throughput?.mean ?? null,
        bytesPerSecP99: ac?.throughput?.p99 ?? null,
        latencyMeanMs: ac?.latency?.mean ?? null,
        latencyP95Ms: ac?.latency?.p95 ?? null,
        latencyP99Ms: ac?.latency?.p99 ?? null,
        errors: ac?.errors ?? 0,
        timeouts: ac?.timeouts ?? 0,
        non2xx: ac?.non2xx ?? 0,
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

function buildPerServiceReportHTML(serviceName, meta, agg) {
    // agg shape:
    // { workloads: { read: { conc:[], series:{rps:[], p95:[], p99:[], bps:[], errRate:[], hitRate:[]}}, ... } }
    const data = JSON.stringify({ serviceName, meta, agg });

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${serviceName} - Load Test Report</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
    .card { border: 1px solid #e6e6e6; border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-top: 14px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 0 0 10px; }
    .meta { color: #555; font-size: 13px; line-height: 1.5; }
    canvas { width: 100% !important; height: 360px !important; }
    .row { display:flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 0; }
    select { padding: 6px 10px; border-radius: 10px; border: 1px solid #ddd; }
  </style>
</head>
<body>
  <h1>${serviceName} - Load Test Report</h1>
  <div class="meta" id="meta"></div>

  <div class="row">
    <div>
      <div class="meta">Workload</div>
      <select id="workloadSel"></select>
    </div>
    <div>
      <div class="meta">Metric</div>
      <select id="metricSel">
        <option value="rps">Req/Sec (mean)</option>
        <option value="bps">Bytes/Sec (mean)</option>
        <option value="p95">Latency p95 (ms)</option>
        <option value="p99">Latency p99 (ms)</option>
        <option value="err">Error rate (%)</option>
        <option value="hit">Cache hit rate (%)</option>
      </select>
    </div>
  </div>

  <div class="card">
    <h2 id="chartTitle">Chart</h2>
    <canvas id="chart"></canvas>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script>
    const PAYLOAD = ${data};

    const meta = PAYLOAD.meta || {};
    document.getElementById("meta").innerHTML =
      \`<div><b>Run:</b> \${meta.startedAt} → \${meta.finishedAt}</div>\` +
      \`<div><b>Config:</b> iterations=\${meta.config.iterations}, warmup=\${meta.config.warmupSec}s, conc=[\${meta.config.concurrency.join(", ")}]</div>\`;

    const workloads = Object.keys(PAYLOAD.agg.workloads || {});
    const workloadSel = document.getElementById("workloadSel");
    const metricSel = document.getElementById("metricSel");

    workloads.forEach(w => {
      const opt = document.createElement("option");
      opt.value = w; opt.textContent = w;
      workloadSel.appendChild(opt);
    });

    let chart;

    function titleFor(metric) {
      if (metric === "rps") return "Req/Sec (mean) vs Concurrency";
      if (metric === "bps") return "Bytes/Sec (mean) vs Concurrency";
      if (metric === "p95") return "Latency p95 (ms) vs Concurrency";
      if (metric === "p99") return "Latency p99 (ms) vs Concurrency";
      if (metric === "err") return "Error rate (%) vs Concurrency";
      if (metric === "hit") return "Cache hit rate (%) vs Concurrency";
      return "Chart";
    }

    function render() {
      const w = workloadSel.value || workloads[0];
      const metric = metricSel.value;

      document.getElementById("chartTitle").textContent = titleFor(metric);

      const wdata = PAYLOAD.agg.workloads[w];
      const labels = wdata.conc;
      const series = wdata.series;

      let y = [];
      let yTitle = "";

      if (metric === "rps") { y = series.rps; yTitle = "Req/Sec"; }
      if (metric === "bps") { y = series.bps; yTitle = "Bytes/Sec"; }
      if (metric === "p95") { y = series.p95; yTitle = "ms"; }
      if (metric === "p99") { y = series.p99; yTitle = "ms"; }
      if (metric === "err") { y = series.errRate; yTitle = "%"; }
      if (metric === "hit") { y = series.hitRate; yTitle = "%"; }

      const data = {
        labels,
        datasets: [{
          label: PAYLOAD.serviceName,
          data: y
        }]
      };

      const options = {
        responsive: true,
        plugins: { legend: { position: "bottom" } },
        scales: {
          x: { title: { display: true, text: "Connections (concurrency)" } },
          y: { title: { display: true, text: yTitle } }
        }
      };

      if (chart) chart.destroy();
      chart = new Chart(document.getElementById("chart"), {
        type: "line",
        data,
        options
      });
    }

    workloadSel.addEventListener("change", render);
    metricSel.addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

function aggregateForService(flatRows, concurrencyLevels) {
    // Aggregate per workload + concurrency (mean across iterations)
    const workloads = [...new Set(flatRows.map((r) => r.workload))];
    const out = { workloads: {} };

    for (const w of workloads) {
        const rowsW = flatRows.filter((r) => r.workload === w);

        const conc = [...new Set(rowsW.map((r) => r.connections))].sort((a, b) => a - b);
        const concOrdered = concurrencyLevels
            .filter((c) => conc.includes(c))
            .concat(conc.filter((c) => !concurrencyLevels.includes(c)));

        function meanFor(connections, key) {
            const rowsC = rowsW.filter((r) => r.connections === connections);
            if (!rowsC.length) return null;
            let s = 0,
                n = 0;
            for (const r of rowsC) {
                const v = r[key];
                if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
                s += Number(v);
                n++;
            }
            return n ? s / n : null;
        }

        function meanErrRate(connections) {
            const rowsC = rowsW.filter((r) => r.connections === connections);
            if (!rowsC.length) return null;
            let s = 0,
                n = 0;
            for (const r of rowsC) {
                const denom = Math.max(1, Number(r.requestsTotal || 0));
                const e = Number(r.errors || 0) + Number(r.timeouts || 0) + Number(r.non2xx || 0);
                s += (e / denom) * 100;
                n++;
            }
            return n ? s / n : null;
        }

        function meanHitRate(connections) {
            const rowsC = rowsW.filter((r) => r.connections === connections);
            if (!rowsC.length) return null;
            let s = 0,
                n = 0;
            for (const r of rowsC) {
                if (r.cacheHitRate === null || r.cacheHitRate === undefined) continue;
                s += Number(r.cacheHitRate) * 100;
                n++;
            }
            return n ? s / n : null;
        }

        out.workloads[w] = {
            conc: concOrdered,
            series: {
                rps: concOrdered.map((c) => meanFor(c, "rpsMean")),
                bps: concOrdered.map((c) => meanFor(c, "bytesPerSecMean")),
                p95: concOrdered.map((c) => meanFor(c, "latencyP95Ms")),
                p99: concOrdered.map((c) => meanFor(c, "latencyP99Ms")),
                errRate: concOrdered.map((c) => meanErrRate(c)),
                hitRate: concOrdered.map((c) => meanHitRate(c)),
            },
        };
    }

    return out;
}

// -------- NEW: aggregate + report for ALL strategies (comparison) --------
function aggregateAllForComparison(allFlatRows, concurrencyLevels) {
    const services = [...new Set(allFlatRows.map((r) => r.service))].sort();
    const workloads = [...new Set(allFlatRows.map((r) => r.workload))].sort();

    const out = { services, workloads: {} };

    for (const w of workloads) {
        const rowsW = allFlatRows.filter((r) => r.workload === w);

        const conc = [...new Set(rowsW.map((r) => r.connections))].sort((a, b) => a - b);
        const concOrdered = concurrencyLevels
            .filter((c) => conc.includes(c))
            .concat(conc.filter((c) => !concurrencyLevels.includes(c)));

        function mean(rows, key) {
            let s = 0, n = 0;
            for (const r of rows) {
                const v = r[key];
                if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
                s += Number(v); n++;
            }
            return n ? (s / n) : null;
        }

        function meanErrRate(rows) {
            if (!rows.length) return null;
            let s = 0, n = 0;
            for (const r of rows) {
                const denom = Math.max(1, Number(r.requestsTotal || 0));
                const e = Number(r.errors || 0) + Number(r.timeouts || 0) + Number(r.non2xx || 0);
                s += (e / denom) * 100;
                n++;
            }
            return n ? (s / n) : null;
        }

        function meanHitRate(rows) {
            let s = 0, n = 0;
            for (const r of rows) {
                if (r.cacheHitRate === null || r.cacheHitRate === undefined) continue;
                s += Number(r.cacheHitRate) * 100;
                n++;
            }
            return n ? (s / n) : null;
        }

        const datasets = { rps: {}, bps: {}, p95: {}, p99: {}, errRate: {}, hitRate: {} };

        for (const svc of services) {
            datasets.rps[svc] = concOrdered.map((c) => mean(rowsW.filter((r) => r.service === svc && r.connections === c), "rpsMean"));
            datasets.bps[svc] = concOrdered.map((c) => mean(rowsW.filter((r) => r.service === svc && r.connections === c), "bytesPerSecMean"));
            datasets.p95[svc] = concOrdered.map((c) => mean(rowsW.filter((r) => r.service === svc && r.connections === c), "latencyP95Ms"));
            datasets.p99[svc] = concOrdered.map((c) => mean(rowsW.filter((r) => r.service === svc && r.connections === c), "latencyP99Ms"));
            datasets.errRate[svc] = concOrdered.map((c) => meanErrRate(rowsW.filter((r) => r.service === svc && r.connections === c)));
            datasets.hitRate[svc] = concOrdered.map((c) => meanHitRate(rowsW.filter((r) => r.service === svc && r.connections === c)));
        }

        out.workloads[w] = { conc: concOrdered, datasets };
    }

    return out;
}

function buildCombinedReportHTML(meta, aggAll) {
    const data = JSON.stringify({ meta, aggAll });

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ALL Strategies - Load Test Comparison</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
    .card { border: 1px solid #e6e6e6; border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-top: 14px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 0 0 10px; }
    .meta { color: #555; font-size: 13px; line-height: 1.5; }
    canvas { width: 100% !important; height: 420px !important; }
    .row { display:flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 0; }
    select { padding: 6px 10px; border-radius: 10px; border: 1px solid #ddd; }
  </style>
</head>
<body>
  <h1>ALL Strategies - Comparison Report</h1>
  <div class="meta" id="meta"></div>

  <div class="row">
    <div>
      <div class="meta">Workload</div>
      <select id="workloadSel"></select>
    </div>
    <div>
      <div class="meta">Metric</div>
      <select id="metricSel">
        <option value="rps">Req/Sec (mean)</option>
        <option value="bps">Bytes/Sec (mean)</option>
        <option value="p95">Latency p95 (ms)</option>
        <option value="p99">Latency p99 (ms)</option>
        <option value="errRate">Error rate (%)</option>
        <option value="hitRate">Cache hit rate (%)</option>
      </select>
    </div>
  </div>

  <div class="card">
    <h2 id="chartTitle">Chart</h2>
    <canvas id="chart"></canvas>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script>
    const PAYLOAD = ${data};

    const meta = PAYLOAD.meta || {};
    document.getElementById("meta").innerHTML =
      \`<div><b>Run:</b> \${meta.startedAt} → \${meta.finishedAt}</div>\` +
      \`<div><b>Config:</b> iterations=\${meta.config.iterations}, warmup=\${meta.config.warmupSec}s, conc=[\${meta.config.concurrency.join(", ")}]</div>\`;

    const workloads = Object.keys(PAYLOAD.aggAll.workloads || {});
    const services = PAYLOAD.aggAll.services || [];

    const workloadSel = document.getElementById("workloadSel");
    const metricSel = document.getElementById("metricSel");

    workloads.forEach(w => {
      const opt = document.createElement("option");
      opt.value = w; opt.textContent = w;
      workloadSel.appendChild(opt);
    });

    function titleFor(metric) {
      if (metric === "rps") return "Req/Sec (mean) vs Concurrency";
      if (metric === "bps") return "Bytes/Sec (mean) vs Concurrency";
      if (metric === "p95") return "Latency p95 (ms) vs Concurrency";
      if (metric === "p99") return "Latency p99 (ms) vs Concurrency";
      if (metric === "errRate") return "Error rate (%) vs Concurrency";
      if (metric === "hitRate") return "Cache hit rate (%) vs Concurrency";
      return "Chart";
    }

    let chart;

    function render() {
      const w = workloadSel.value || workloads[0];
      const metric = metricSel.value;
      document.getElementById("chartTitle").textContent = titleFor(metric);

      const wdata = PAYLOAD.aggAll.workloads[w];
      const labels = wdata.conc;

      const datasets = services.map(svc => ({
        label: svc,
        data: (wdata.datasets[metric] && wdata.datasets[metric][svc]) ? wdata.datasets[metric][svc] : labels.map(_ => null),
      }));

      if (chart) chart.destroy();
      chart = new Chart(document.getElementById("chart"), {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          plugins: { legend: { position: "bottom" } },
          scales: {
            x: { title: { display: true, text: "Connections (concurrency)" } },
            y: { title: { display: true, text:
              metric === "rps" ? "Req/Sec" :
              metric === "bps" ? "Bytes/Sec" :
              (metric === "hitRate" || metric === "errRate") ? "%" :
              "ms"
            } }
          }
        }
      });
    }

    workloadSel.addEventListener("change", render);
    metricSel.addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

// -------------------- Main runner --------------------
async function main() {
    const runId = Date.now();
    const outDir = path.resolve(process.cwd(), `per-strategy-results-${runId}`);
    fs.mkdirSync(outDir, { recursive: true });

    const metaBase = {
        runId,
        startedAt: nowISO(),
        host: {
            platform: os.platform(),
            node: process.version,
            cpuCount: os.cpus()?.length ?? null,
            totalMemMB: os.totalmem() / 1024 / 1024,
        },
        config: {
            iterations: ITERATIONS,
            warmupSec: WARMUP_SEC,
            cooldownMs: COOLDOWN_MS,
            concurrency: CONCURRENCY_LEVELS,
            durations: { READ_DURATION, WRITE_DURATION, MIXED_DURATION },
        },
    };

    console.log(`\n✅ Output folder: ${outDir}`);
    console.log(`Config: conc=[${CONCURRENCY_LEVELS.join(", ")}], iterations=${ITERATIONS}`);
    console.log(`Durations: read=${READ_DURATION}s write=${WRITE_DURATION}s mixed=${MIXED_DURATION}s\n`);

    const servicesToRun = ONLY_SERVICE
        ? SERVICES.filter((s) => s.name.toLowerCase() === ONLY_SERVICE.toLowerCase())
        : SERVICES;

    if (!servicesToRun.length) {
        throw new Error(`ONLY_SERVICE="${ONLY_SERVICE}" did not match any service name`);
    }

    // We also save a combined flat CSV/JSON + combined report
    const allFlat = [];

    for (const service of servicesToRun) {
        const slug = slugify(service.name);
        const serviceFlat = [];

        const checkpointJson = path.join(outDir, `${slug}-flat.json`);
        const checkpointCsv = path.join(outDir, `${slug}-flat.csv`);
        const checkpointHtml = path.join(outDir, `${slug}-report.html`);

        console.log(`${"=".repeat(72)}\nTesting ${service.name} (${service.url})\n${"=".repeat(72)}`);

        await waitForService(service.url);
        console.log("✓ service ready");

        // Warmup (short)
        console.log(`♨️ warmup ${WARMUP_SEC}s...`);
        await runAutocannon({
            url: service.url,
            connections: Math.max(5, CONCURRENCY_LEVELS[0] || 10),
            duration: WARMUP_SEC,
            requests: [{ method: "GET", path: `/api/products/${PRODUCT_IDS[0]}` }],
        });
        await sleep(500);

        const workloads = [
            { name: "read", duration: READ_DURATION, build: () => buildReadRequests() },
            { name: "write", duration: WRITE_DURATION, build: () => buildWriteRequests() },
            { name: "mixed", duration: MIXED_DURATION, build: () => buildMixedRequests() },
        ];

        for (const wl of workloads) {
            console.log(`\n🏁 Workload: ${wl.name}`);

            for (const connections of CONCURRENCY_LEVELS) {
                for (let it = 1; it <= ITERATIONS; it++) {
                    console.log(`   ▶ conc=${connections}, iter=${it}/${ITERATIONS}, duration=${wl.duration}s`);

                    await resetStats(service.url);
                    await sleep(250);

                    const before = await getStats(service.url);

                    const ac = await runAutocannon({
                        url: service.url,
                        connections,
                        duration: wl.duration,
                        requests: wl.build(),
                    });

                    if (service.name === "Write-Behind" && (wl.name === "write" || wl.name === "mixed")) {
                        await maybeFlushWriteBehind(service);
                    }

                    const after = await getStats(service.url);
                    const metrics = extractMetrics(ac);
                    const delta = diffStats(before, after);

                    const flat = {
                        timestamp: nowISO(),
                        service: service.name,
                        url: service.url,
                        workload: wl.name,
                        iteration: it,
                        connections,
                        duration: wl.duration,

                        requestsTotal: metrics.requestsTotal,
                        rpsMean: metrics.rpsMean,
                        bytesPerSecMean: metrics.bytesPerSecMean,
                        latencyMeanMs: metrics.latencyMeanMs,
                        latencyP95Ms: metrics.latencyP95Ms,
                        latencyP99Ms: metrics.latencyP99Ms,
                        errors: metrics.errors,
                        timeouts: metrics.timeouts,
                        non2xx: metrics.non2xx,

                        cacheReads: delta?.reads ?? null,
                        cacheWrites: delta?.writes ?? null,
                        cacheHits: delta?.cacheHits ?? null,
                        cacheMisses: delta?.cacheMisses ?? null,
                        cacheHitRate: delta?.cacheHitRate ?? null,
                        queuedWrites: delta?.queuedWrites ?? null,
                        flushedWrites: delta?.flushedWrites ?? null,
                    };

                    serviceFlat.push(flat);
                    allFlat.push(flat);

                    // ✅ checkpoint save after EVERY run
                    fs.writeFileSync(checkpointJson, JSON.stringify({ meta: metaBase, rows: serviceFlat }, null, 2), "utf8");
                    fs.writeFileSync(checkpointCsv, toCSV(serviceFlat), "utf8");

                    console.log(
                        `      rps=${metrics.rpsMean?.toFixed?.(2) ?? "n/a"} | p95=${metrics.latencyP95Ms?.toFixed?.(2) ?? "n/a"}ms | errors=${metrics.errors} non2xx=${metrics.non2xx}`
                    );

                    await sleep(COOLDOWN_MS);
                }
            }
        }

        // Per-service report
        const agg = aggregateForService(serviceFlat, CONCURRENCY_LEVELS);
        const serviceMeta = { ...metaBase, finishedAt: nowISO(), service: { name: service.name, url: service.url } };
        const html = buildPerServiceReportHTML(service.name, serviceMeta, agg);
        fs.writeFileSync(checkpointHtml, html, "utf8");

        console.log(`\n✅ Saved:`);
        console.log(`   - ${checkpointJson}`);
        console.log(`   - ${checkpointCsv}`);
        console.log(`   - ${checkpointHtml}\n`);
    }

    // Combined flat results
    const allJson = path.join(outDir, `ALL-flat.json`);
    const allCsv = path.join(outDir, `ALL-flat.csv`);
    fs.writeFileSync(allJson, JSON.stringify({ meta: { ...metaBase, finishedAt: nowISO() }, rows: allFlat }, null, 2), "utf8");
    fs.writeFileSync(allCsv, toCSV(allFlat), "utf8");

    // ✅ Combined comparison report (ALL strategies on one chart)
    const allReport = path.join(outDir, `ALL-report.html`);
    const aggAll = aggregateAllForComparison(allFlat, CONCURRENCY_LEVELS);
    const htmlAll = buildCombinedReportHTML({ ...metaBase, finishedAt: nowISO() }, aggAll);
    fs.writeFileSync(allReport, htmlAll, "utf8");

    console.log(`\n🎯 Combined saved for comparison:`);
    console.log(`   - ${allJson}`);
    console.log(`   - ${allCsv}`);
    console.log(`   - ${allReport}`);
    console.log(`\nDone.\n`);
}

main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
});
