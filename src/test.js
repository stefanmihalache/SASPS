const axios = require('axios');

/**
 * Simple test script to verify services are working correctly
 */

const SERVICES = [
  { name: 'No-Caching', url: 'http://localhost:3000' },
  { name: 'Cache-Aside', url: 'http://localhost:3001' },
  { name: 'Write-Through', url: 'http://localhost:3002' },
  { name: 'Write-Behind', url: 'http://localhost:3003' },
  { name: 'Read-Through', url: 'http://localhost:3004' },
  { name: 'Write-Around', url: 'http://localhost:3005' }
];

function safeSource(resp) {
  return resp?.data?.source ?? 'N/A';
}

function safeResponseTime(resp) {
  const rt = resp?.data?.responseTime;
  return typeof rt === 'number' ? `${rt}ms` : 'N/A';
}

async function testService(service) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${service.name} (${service.url})`);
  console.log('='.repeat(60));

  try {
    // Health check
    const health = await axios.get(`${service.url}/api/health`);
    console.log('✅ Health check:', health.data);

    // Get a product
    const product = await axios.get(`${service.url}/api/products/S10_1678`);
    console.log('✅ Get product:', {
      productCode: product.data.data?.productCode,
      productName: product.data.data?.productName,
      source: safeSource(product),
      responseTime: safeResponseTime(product)
    });

    // Get the same product again
    // Expected:
    // - No-Caching: usually database again
    // - Cache-Aside / Write-Through / Write-Behind / Read-Through: cache hit
    // - Write-Around: cache hit too (writes bypass cache, reads still populate)
    const product2 = await axios.get(`${service.url}/api/products/S10_1678`);
    console.log('✅ Get product (2nd time):', {
      source: safeSource(product2),
      responseTime: safeResponseTime(product2)
    });

    // Update product
    const update = await axios.put(`${service.url}/api/products/S10_1678`, {
      productName: '1969 Harley Davidson Ultimate Chopper',
      quantityInStock: 7933,
      buyPrice: 48.81,
      MSRP: 95.70
    });
    console.log('✅ Update product:', {
      message: update.data.message,
      responseTime: safeResponseTime(update)
    });

    // Get product after update
    // Useful for checking behavior:
    // - Write-Through / Read-Through: should reflect updated value immediately (cache updated)
    // - Write-Around: should reflect updated value (cache invalidated, so likely DB then cached)
    // - Write-Behind: may reflect updated value from cache immediately, DB later
    const product3 = await axios.get(`${service.url}/api/products/S10_1678`);
    console.log('✅ Get product (after update):', {
      productName: product3.data.data?.productName,
      quantityInStock: product3.data.data?.quantityInStock,
      source: safeSource(product3),
      responseTime: safeResponseTime(product3)
    });

    // Get stats
    const stats = await axios.get(`${service.url}/api/stats`);
    console.log('✅ Stats:', {
      reads: stats.data.reads,
      writes: stats.data.writes,
      cacheHits: stats.data.cacheHits,
      cacheMisses: stats.data.cacheMisses,
      cacheHitRate: stats.data.cacheHitRate || 'N/A',
      currentQueueSize: stats.data.currentQueueSize ?? 'N/A',
      queuedWrites: stats.data.queuedWrites ?? 'N/A',
      flushedWrites: stats.data.flushedWrites ?? 'N/A'
    });

    console.log(`\n✅ ${service.name} tests passed!`);
    return true;

  } catch (error) {
    console.error(`\n❌ ${service.name} tests failed:`, error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    return false;
  }
}

async function runTests() {
  console.log('\n🧪 Starting service tests...\n');

  const results = [];
  for (const service of SERVICES) {
    const result = await testService(service);
    results.push({ name: service.name, passed: result });

    // Wait between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Summary
  console.log('\n\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));

  results.forEach(result => {
    const icon = result.passed ? '✅' : '❌';
    console.log(`${icon} ${result.name}`);
  });

  const allPassed = results.every(r => r.passed);
  console.log('\n' + '='.repeat(60));
  console.log(allPassed ? '✅ All tests passed!' : '❌ Some tests failed');
  console.log('='.repeat(60) + '\n');

  process.exit(allPassed ? 0 : 1);
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
