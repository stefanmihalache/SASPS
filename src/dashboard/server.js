const path = require('path');
const express = require('express');
const axios = require('axios');

const PORT = process.env.DASHBOARD_PORT || 4000;

// Default service map; can be overridden with env vars if ports differ
const SERVICES = [
  { name: 'No-Caching', key: 'no-caching', url: process.env.NO_CACHE_URL || 'http://localhost:3000' },
  { name: 'Cache-Aside', key: 'cache-aside', url: process.env.CACHE_ASIDE_URL || 'http://localhost:3001' },
  { name: 'Write-Through', key: 'write-through', url: process.env.WRITE_THROUGH_URL || 'http://localhost:3002' },
  { name: 'Write-Behind', key: 'write-behind', url: process.env.WRITE_BEHIND_URL || 'http://localhost:3003' },
  { name: 'Read-Through', key: 'read-through', url: process.env.READ_THROUGH_URL || 'http://localhost:3004' },
  { name: 'Write-Around', key: 'write-around', url: process.env.WRITE_AROUND_URL || 'http://localhost:3005' }
];

function safeHitRate(stats) {
  if (!stats || stats.reads === undefined) return 'N/A';
  if (stats.cacheHitRate) return stats.cacheHitRate; // already formatted in services
  if (stats.reads === 0) return '0%';
  const rate = (stats.cacheHits / Math.max(1, stats.reads)) * 100;
  return `${rate.toFixed(2)}%`;
}

async function fetchServiceState(service) {
  const state = {
    name: service.name,
    key: service.key,
    url: service.url,
    healthy: false,
    stats: null,
    error: null
  };

  try {
    const health = await axios.get(`${service.url}/api/health`, { timeout: 2000 });
    state.healthy = true;
    state.health = health.data;
  } catch (err) {
    state.error = `Health check failed: ${err.message}`;
    return state;
  }

  try {
    const stats = await axios.get(`${service.url}/api/stats`, { timeout: 2000 });
    state.stats = stats.data;
  } catch (err) {
    state.error = `Stats fetch failed: ${err.message}`;
  }

  return state;
}

async function buildSummary() {
  const results = await Promise.all(SERVICES.map(fetchServiceState));
  return {
    updatedAt: new Date().toISOString(),
    services: results.map((result) => ({
      ...result,
      hitRate: safeHitRate(result.stats),
      queuedWrites: result.stats?.queuedWrites ?? result.stats?.currentQueueSize ?? 0,
      flushedWrites: result.stats?.flushedWrites ?? 0
    }))
  };
}

async function start() {
  const app = express();
  const publicDir = path.join(__dirname, 'public');

  app.get('/api/services', (_req, res) => {
    res.json(SERVICES);
  });

  app.get('/api/summary', async (_req, res) => {
    try {
      const summary = await buildSummary();
      res.json(summary);
    } catch (error) {
      console.error('Failed to build dashboard summary:', error);
      res.status(500).json({ error: 'Failed to build summary' });
    }
  });

  app.use(express.static(publicDir));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`📊 Dashboard running on http://localhost:${PORT}`);
    console.log('Services monitored:');
    SERVICES.forEach((s) => console.log(` - ${s.name}: ${s.url}`));
  });
}

start().catch((err) => {
  console.error('Failed to start dashboard:', err);
  process.exit(1);
});

