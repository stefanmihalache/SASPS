const client = require('prom-client');

/**
 * Create Prometheus metrics for a given service name.
 * Metrics are labeled by service to allow multi-service scraping.
 */
function createMetrics(service) {
  const register = new client.Registry();

  client.collectDefaultMetrics({
    register,
    prefix: `cache_${service.replace(/-/g, '_')}_`
  });

  const reads = new client.Counter({
    name: 'cache_reads_total',
    help: 'Total read operations',
    labelNames: ['service']
  });

  const writes = new client.Counter({
    name: 'cache_writes_total',
    help: 'Total write operations',
    labelNames: ['service']
  });

  const cacheHits = new client.Counter({
    name: 'cache_hits_total',
    help: 'Total cache hits',
    labelNames: ['service']
  });

  const cacheMisses = new client.Counter({
    name: 'cache_misses_total',
    help: 'Total cache misses',
    labelNames: ['service']
  });

  const errors = new client.Counter({
    name: 'cache_errors_total',
    help: 'Total request errors',
    labelNames: ['service']
  });

  const queuedWrites = new client.Gauge({
    name: 'cache_queued_writes',
    help: 'Pending queued writes (write-behind)',
    labelNames: ['service']
  });

  const flushedWrites = new client.Gauge({
    name: 'cache_flushed_writes',
    help: 'Flushed writes (write-behind)',
    labelNames: ['service']
  });

  const requestDurationMs = new client.Histogram({
    name: 'cache_request_duration_ms',
    help: 'Request duration in milliseconds',
    labelNames: ['service', 'method', 'route', 'status'],
    buckets: [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
  });

  register.registerMetric(reads);
  register.registerMetric(writes);
  register.registerMetric(cacheHits);
  register.registerMetric(cacheMisses);
  register.registerMetric(errors);
  register.registerMetric(queuedWrites);
  register.registerMetric(flushedWrites);
  register.registerMetric(requestDurationMs);

  return {
    register,
    reads,
    writes,
    cacheHits,
    cacheMisses,
    errors,
    queuedWrites,
    flushedWrites,
    requestDurationMs,
    service
  };
}

module.exports = {
  createMetrics
};

