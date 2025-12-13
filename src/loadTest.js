const autocannon = require('autocannon');
const axios = require('axios');

/**
 * Load testing script to compare caching strategies
 * Tests all services and generates performance metrics
 */

const SERVICES = [
  { name: 'No-Caching', url: 'http://localhost:3000', port: 3000 },
  { name: 'Cache-Aside', url: 'http://localhost:3001', port: 3001 },
  { name: 'Write-Through', url: 'http://localhost:3002', port: 3002 },
  { name: 'Write-Behind', url: 'http://localhost:3003', port: 3003 },
  { name: 'Read-Through', url: 'http://localhost:3004', port: 3004 },
  { name: 'Write-Around', url: 'http://localhost:3005', port: 3005 }
];

const PRODUCT_IDS = [
  'S10_1678', 'S10_1949', 'S10_2016', 'S10_4698', 'S10_4757',
  'S10_4962', 'S12_1099', 'S12_1108', 'S12_1666', 'S12_2823'
];

const CUSTOMER_IDS = [103, 112, 114, 119, 121, 124, 125, 128, 129, 131];

class LoadTester {
  constructor() {
    this.results = {};
  }

  async waitForService(url) {
    const maxRetries = 30;
    for (let i = 0; i < maxRetries; i++) {
      try {
        await axios.get(`${url}/api/health`, { timeout: 2000 });
        return true;
      } catch (error) {
        if (i === maxRetries - 1) {
          throw new Error(`Service ${url} is not responding`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async resetStats(url) {
    try {
      await axios.post(`${url}/api/stats/reset`);
      console.log(`✓ Stats reset for ${url}`);
    } catch (error) {
      console.error(`Failed to reset stats for ${url}:`, error.message);
    }
  }

  async getStats(url) {
    try {
      const response = await axios.get(`${url}/api/stats`);
      return response.data;
    } catch (error) {
      console.error(`Failed to get stats from ${url}:`, error.message);
      return null;
    }
  }

  async runReadTest(service, duration = 30) {
    console.log(`\n📊 Running READ test for ${service.name} (${duration}s)...`);

    const result = await autocannon({
      url: service.url,
      connections: 50,
      duration: duration,
      requests: [
        {
          method: 'GET',
          path: `/api/products/${PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)]}`
        },
        {
          method: 'GET',
          path: '/api/products?limit=50'
        },
        {
          method: 'GET',
          path: `/api/customers/${CUSTOMER_IDS[Math.floor(Math.random() * CUSTOMER_IDS.length)]}`
        }
      ]
    });

    return result;
  }

  async runWriteTest(service, duration = 10) {
    console.log(`\n📝 Running WRITE test for ${service.name} (${duration}s)...`);

    const result = await autocannon({
      url: service.url,
      connections: 20,
      duration: duration,
      requests: [
        {
          method: 'PUT',
          path: `/api/products/${PRODUCT_IDS[0]}`,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            productName: 'Updated Product ' + Date.now(),
            quantityInStock: Math.floor(Math.random() * 1000),
            buyPrice: (Math.random() * 100).toFixed(2),
            MSRP: (Math.random() * 200).toFixed(2)
          })
        }
      ]
    });

    return result;
  }

  async runMixedTest(service, duration = 30) {
    console.log(`\n🔀 Running MIXED test for ${service.name} (${duration}s)...`);

    const result = await autocannon({
      url: service.url,
      connections: 40,
      duration: duration,
      requests: [
        {
          method: 'GET',
          path: `/api/products/${PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)]}`,
          weight: 7 // 70% reads
        },
        {
          method: 'GET',
          path: '/api/products?limit=30',
          weight: 2 // 20% list queries
        },
        {
          method: 'PUT',
          path: `/api/products/${PRODUCT_IDS[0]}`,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            productName: 'Updated Product',
            quantityInStock: Math.floor(Math.random() * 1000),
            buyPrice: (Math.random() * 100).toFixed(2),
            MSRP: (Math.random() * 200).toFixed(2)
          }),
          weight: 1 // 10% writes
        }
      ]
    });

    return result;
  }

  printResults(testName, serviceName, autocannonResult, stats) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📈 ${testName} - ${serviceName}`);
    console.log('='.repeat(60));
    console.log(`Requests:           ${autocannonResult.requests.total}`);
    console.log(`Throughput:         ${autocannonResult.throughput.mean.toFixed(2)} req/sec`);
    console.log(`Latency (avg):      ${autocannonResult.latency.mean.toFixed(2)} ms`);
    console.log(`Latency (p99):      ${autocannonResult.latency.p99.toFixed(2)} ms`);
    console.log(`Errors:             ${autocannonResult.errors}`);

    if (stats) {
      console.log(`\nCache Statistics:`);
      console.log(`  Reads:            ${stats.reads}`);
      console.log(`  Writes:           ${stats.writes}`);
      console.log(`  Cache Hits:       ${stats.cacheHits}`);
      console.log(`  Cache Misses:     ${stats.cacheMisses}`);
      if (stats.cacheHitRate) {
        console.log(`  Cache Hit Rate:   ${stats.cacheHitRate}`);
      }
      if (stats.queuedWrites !== undefined) {
        console.log(`  Queued Writes:    ${stats.queuedWrites}`);
        console.log(`  Flushed Writes:   ${stats.flushedWrites}`);
      }
    }
    console.log('='.repeat(60));
  }

  async runFullTest() {
    console.log('\n🚀 Starting comprehensive load tests...\n');
    console.log('Testing configuration:');
    console.log('  - Read Test: 30s, 50 connections');
    console.log('  - Write Test: 10s, 20 connections');
    console.log('  - Mixed Test: 30s, 40 connections (70% reads, 20% lists, 10% writes)\n');

    const results = {
      timestamp: new Date().toISOString(),
      services: {}
    };

    for (const service of SERVICES) {
      console.log(`\n${'#'.repeat(60)}`);
      console.log(`Testing ${service.name} (${service.url})`);
      console.log('#'.repeat(60));

      try {
        // Wait for service to be ready
        await this.waitForService(service.url);
        console.log(`✓ Service ${service.name} is ready`);

        // Reset stats before testing
        await this.resetStats(service.url);
        await new Promise(resolve => setTimeout(resolve, 2000));

        const serviceResults = {};

        // 1. Read Test
        await this.resetStats(service.url);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const readResult = await this.runReadTest(service, 30);
        const readStats = await this.getStats(service.url);
        this.printResults('READ TEST', service.name, readResult, readStats);
        serviceResults.read = { autocannon: readResult, stats: readStats };

        await new Promise(resolve => setTimeout(resolve, 3000));

        // 2. Write Test
        await this.resetStats(service.url);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const writeResult = await this.runWriteTest(service, 10);
        const writeStats = await this.getStats(service.url);

        // For write-behind, trigger flush and wait
        if (service.name === 'Write-Behind') {
          console.log('\n⏳ Waiting for write-behind flush...');
          await axios.post(`${service.url}/api/flush`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        this.printResults('WRITE TEST', service.name, writeResult, writeStats);
        serviceResults.write = { autocannon: writeResult, stats: writeStats };

        await new Promise(resolve => setTimeout(resolve, 3000));

        // 3. Mixed Test
        await this.resetStats(service.url);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const mixedResult = await this.runMixedTest(service, 30);
        const mixedStats = await this.getStats(service.url);
        this.printResults('MIXED TEST', service.name, mixedResult, mixedStats);
        serviceResults.mixed = { autocannon: mixedResult, stats: mixedStats };

        results.services[service.name] = serviceResults;

      } catch (error) {
        console.error(`\n❌ Error testing ${service.name}:`, error.message);
        results.services[service.name] = { error: error.message };
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Save results to file
    const fs = require('fs');
    const resultsFile = `load-test-results-${Date.now()}.json`;
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`\n✅ Results saved to ${resultsFile}`);

    // Print comparison summary
    this.printComparison(results);
  }

  printComparison(results) {
    console.log('\n\n' + '='.repeat(80));
    console.log('📊 COMPARISON SUMMARY');
    console.log('='.repeat(80));

    const tests = ['read', 'write', 'mixed'];

    for (const test of tests) {
      console.log(`\n${test.toUpperCase()} TEST COMPARISON:`);
      console.log('-'.repeat(80));
      console.log(
          'Strategy'.padEnd(20) +
          'Throughput'.padEnd(15) +
          'Latency (avg)'.padEnd(15) +
          'Latency (p99)'.padEnd(15) +
          'Hit Rate'
      );
      console.log('-'.repeat(80));

      for (const serviceName in results.services) {
        const serviceResult = results.services[serviceName][test];
        if (serviceResult && !serviceResult.error) {
          const ac = serviceResult.autocannon;
          const stats = serviceResult.stats;
          console.log(
              serviceName.padEnd(20) +
              `${ac.throughput.mean.toFixed(2)} r/s`.padEnd(15) +
              `${ac.latency.mean.toFixed(2)} ms`.padEnd(15) +
              `${ac.latency.p99.toFixed(2)} ms`.padEnd(15) +
              (stats.cacheHitRate || 'N/A')
          );
        }
      }
    }

    console.log('\n' + '='.repeat(80) + '\n');
  }
}

// Run the tests
const tester = new LoadTester();
tester.runFullTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
