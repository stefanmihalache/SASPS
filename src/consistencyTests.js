const fs = require('fs');
const { execSync } = require('child_process');
const axios = require('axios');

const PRODUCT_ID = process.env.PRODUCT_ID || 'S10_1678';
const POLL_LIMIT = 20;
const POLL_DELAY_MS = 500;
const SKIP_REDIS_KILL = process.argv.includes('--skip-redis-kill') || process.env.SKIP_REDIS_KILL === '1';

const SERVICES = {
  'No-Caching': process.env.NO_CACHE_URL || 'http://localhost:3000',
  'Cache-Aside': process.env.CACHE_ASIDE_URL || 'http://localhost:3001',
  'Write-Through': process.env.WRITE_THROUGH_URL || 'http://localhost:3002',
  'Write-Behind': process.env.WRITE_BEHIND_URL || 'http://localhost:3003',
  'Read-Through': process.env.READ_THROUGH_URL || 'http://localhost:3004',
  'Write-Around': process.env.WRITE_AROUND_URL || 'http://localhost:3005'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeGet(url) {
  try {
    return await axios.get(url, { timeout: 4000 });
  } catch (error) {
    return { error: error.message, data: null };
  }
}

async function staleWindowWriteBehind() {
  const marker = `wb-${Date.now()}`;
  const wbUrl = SERVICES['Write-Behind'];
  const baselineUrl = SERVICES['No-Caching'];

  const updateBody = {
    productName: `WB Test ${marker}`,
    quantityInStock: Math.floor(Math.random() * 9000) + 1000,
    buyPrice: 42.42,
    MSRP: 99.99
  };

  const result = {
    marker,
    queuedWrites: null,
    flushedWrites: null,
    staleWindowMs: null,
    dbUpdated: false,
    error: null
  };

  console.log('\n[Write-Behind] Updating product and measuring stale window...');
  try {
    await axios.put(`${wbUrl}/api/products/${PRODUCT_ID}`, updateBody, { timeout: 4000 });
  } catch (error) {
    result.error = `Update failed: ${error.message}`;
    return result;
  }

  const start = Date.now();
  let lastDbVal = null;

  for (let i = 0; i < POLL_LIMIT; i++) {
    const resp = await safeGet(`${baselineUrl}/api/products/${PRODUCT_ID}`);
    const name = resp?.data?.data?.productName;
    lastDbVal = name;
    if (name && name.includes(marker)) {
      result.dbUpdated = true;
      result.staleWindowMs = Date.now() - start;
      break;
    }
    await sleep(POLL_DELAY_MS);
  }

  const stats = await safeGet(`${wbUrl}/api/stats`);
  result.queuedWrites = stats?.data?.queuedWrites ?? stats?.data?.currentQueueSize ?? 0;
  result.flushedWrites = stats?.data?.flushedWrites ?? 0;
  result.lastDbValue = lastDbVal;

  return result;
}

async function cacheInvalidationSweep() {
  console.log('\n[Invalidation] Sweeping strategies for stale reads...');
  const strategies = ['Cache-Aside', 'Write-Through', 'Read-Through', 'Write-Around'];
  const outcomes = [];

  for (const name of strategies) {
    const url = SERVICES[name];
    const marker = `inv-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const payload = {
      productName: `Invalidate ${marker}`,
      quantityInStock: Math.floor(Math.random() * 5000) + 100,
      buyPrice: 11.11,
      MSRP: 22.22
    };

    const outcome = { strategy: name, marker, firstSource: null, secondSource: null, consistent: false, error: null };

    try {
      await axios.put(`${url}/api/products/${PRODUCT_ID}`, payload, { timeout: 4000 });
      const first = await axios.get(`${url}/api/products/${PRODUCT_ID}`, { timeout: 4000 });
      const second = await axios.get(`${url}/api/products/${PRODUCT_ID}`, { timeout: 4000 });

      outcome.firstSource = first?.data?.source || 'unknown';
      outcome.secondSource = second?.data?.source || 'unknown';

      const val1 = first?.data?.data?.productName;
      const val2 = second?.data?.data?.productName;
      outcome.consistent = Boolean(val1 && val2 && val1.includes(marker) && val2.includes(marker));
    } catch (error) {
      outcome.error = error.message;
    }

    outcomes.push(outcome);
  }

  return outcomes;
}

function runDocker(cmd) {
  return execSync(cmd, { stdio: 'pipe' }).toString();
}

async function redisFailureTest() {
  if (SKIP_REDIS_KILL) {
    console.log('\n[Redis failure] Skipped (flag present).');
    return { skipped: true };
  }

  console.log('\n[Redis failure] Stopping redis container...');
  try {
    runDocker('docker-compose stop redis');
  } catch (error) {
    return { skipped: true, error: `Failed to stop redis: ${error.message}` };
  }

  const url = SERVICES['Cache-Aside'];
  const marker = `redis-down-${Date.now()}`;
  const payload = {
    productName: `RedisDown ${marker}`,
    quantityInStock: Math.floor(Math.random() * 5000) + 500,
    buyPrice: 55.55,
    MSRP: 111.11
  };

  const result = { marker, writeSucceeded: false, readAfterRestart: null, error: null, skipped: false };

  try {
    await axios.put(`${url}/api/products/${PRODUCT_ID}`, payload, { timeout: 4000 });
    result.writeSucceeded = true;
  } catch (error) {
    result.error = `Write failed while redis down: ${error.message}`;
  }

  console.log('[Redis failure] Starting redis back up...');
  try {
    runDocker('docker-compose start redis');
  } catch (error) {
    result.error = result.error || `Failed to start redis: ${error.message}`;
    return result;
  }

  // Wait for redis to respond
  for (let i = 0; i < 10; i++) {
    try {
      runDocker('docker exec redis redis-cli ping');
      break;
    } catch {
      await sleep(1000);
    }
  }

  try {
    const post = await axios.get(`${url}/api/products/${PRODUCT_ID}`, { timeout: 4000 });
    result.readAfterRestart = post?.data?.data?.productName || null;
  } catch (error) {
    result.error = result.error || `Read after restart failed: ${error.message}`;
  }

  return result;
}

async function main() {
  console.log('🔍 Running consistency & failure tests...');

  const results = {
    timestamp: new Date().toISOString(),
    staleWindow: await staleWindowWriteBehind(),
    invalidation: await cacheInvalidationSweep(),
    redisFailure: await redisFailureTest()
  };

  const file = `consistency-results-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\n✅ Results written to ${file}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

