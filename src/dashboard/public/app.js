const tableBody = document.querySelector('#services-table tbody');
const alertsList = document.querySelector('#alerts');
const updatedAt = document.querySelector('#updated-at');
const refreshBtn = document.querySelector('#refresh-btn');

const POLL_MS = 3000;

function statusTag(healthy, queuedWrites, error) {
  if (!healthy) return '<span class="tag danger">Down</span>';
  if (error) return '<span class="tag warn">Degraded</span>';
  if (queuedWrites > 0) return '<span class="tag warn">Queue</span>';
  return '<span class="tag ok">Healthy</span>';
}

function formatNumber(value) {
  if (value === null || value === undefined) return '0';
  return Number(value).toLocaleString();
}

function buildRow(service) {
  const stats = service.stats || {};
  const status = statusTag(service.healthy, service.queuedWrites, service.error);
  const avg = stats.avgResponseTime ? stats.avgResponseTime.toFixed(2) : '—';
  const notes = service.error || '';

  return `<tr>
    <td>${service.name}</td>
    <td>${status}</td>
    <td>${service.hitRate || 'N/A'}</td>
    <td>${formatNumber(stats.reads)}</td>
    <td>${formatNumber(stats.writes)}</td>
    <td>${formatNumber(service.queuedWrites)}</td>
    <td>${formatNumber(service.flushedWrites)}</td>
    <td>${avg}</td>
    <td>${notes}</td>
  </tr>`;
}

function renderAlerts(services) {
  const alerts = [];

  services.forEach((svc) => {
    if (!svc.healthy) {
      alerts.push(`❌ ${svc.name} is not responding`);
    } else if (svc.error) {
      alerts.push(`⚠️ ${svc.name}: ${svc.error}`);
    }

    const queueSize = svc.queuedWrites || 0;
    if (queueSize > 0) {
      alerts.push(`⏳ ${svc.name} has ${queueSize} queued writes (write-behind pressure)`);
    }

    const hitRateNum = parseFloat((svc.hitRate || '0').toString().replace('%', ''));
    if (!Number.isNaN(hitRateNum) && hitRateNum < 20 && svc.name !== 'No-Caching') {
      alerts.push(`📉 Low hit rate on ${svc.name}: ${svc.hitRate}`);
    }
  });

  alertsList.innerHTML = alerts.length
    ? alerts.map((a) => `<li>${a}</li>`).join('')
    : '<li>All clear.</li>';
}

async function loadSummary() {
  refreshBtn.disabled = true;
  try {
    const res = await fetch('/api/summary');
    const summary = await res.json();

    tableBody.innerHTML = summary.services.map(buildRow).join('');
    renderAlerts(summary.services);
    updatedAt.textContent = `Updated: ${new Date(summary.updatedAt).toLocaleTimeString()}`;
  } catch (err) {
    alertsList.innerHTML = `<li>Failed to load summary: ${err.message}</li>`;
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener('click', loadSummary);

loadSummary();
setInterval(loadSummary, POLL_MS);

