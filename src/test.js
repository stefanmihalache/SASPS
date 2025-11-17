const axios = require('axios');

/**
 * Simple test script to verify services are working correctly
 */

const SERVICES = [
  { name: 'No-Caching', url: 'http://localhost:3000' },
  { name: 'Cache-Aside', url: 'http://localhost:3001' },
  { name: 'Write-Through', url: 'http://localhost:3002' },
  { name: 'Write-Behind', url: 'http://localhost:3003' }
];

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
      productCode: product.data.data.productCode,
      productName: product.data.data.productName,
      source: product.data.source,
      responseTime: product.data.responseTime + 'ms'
    });

    // Get the same product again (should be cached in cache-aside, write-through, write-behind)
    const product2 = await axios.get(`${service.url}/api/products/S10_1678`);
    console.log('✅ Get product (2nd time):', {
      source: product2.data.source,
      responseTime: product2.data.responseTime + 'ms'
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
      responseTime: update.data.responseTime + 'ms'
    });

    // Get stats
    const stats = await axios.get(`${service.url}/api/stats`);
    console.log('✅ Stats:', {
      reads: stats.data.reads,
      writes: stats.data.writes,
      cacheHits: stats.data.cacheHits,
      cacheMisses: stats.data.cacheMisses,
      cacheHitRate: stats.data.cacheHitRate || 'N/A'
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

