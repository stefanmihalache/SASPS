const express = require('express');
require('dotenv').config();

const NoCachingService = require('./strategies/NoCaching');
const CacheAsideService = require('./strategies/CacheAside');
const WriteThroughService = require('./strategies/WriteThrough');
const WriteBehindService = require('./strategies/WriteBehind');

const SERVICE_NAME = process.env.SERVICE_NAME || 'no-caching';
const PORT = process.env.PORT || 3000;

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'user',
  password: process.env.DB_PASSWORD || 'pass',
  database: process.env.DB_NAME || 'testdb'
};

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
};

const writeBehindInterval = parseInt(process.env.WRITE_BEHIND_INTERVAL) || 5000;

async function startService() {
  const app = express();
  app.use(express.json());

  let service;

  console.log(`\n🚀 Starting ${SERVICE_NAME} service...\n`);

  try {
    // Initialize the appropriate caching strategy
    switch (SERVICE_NAME) {
      case 'no-caching':
        service = new NoCachingService(dbConfig);
        break;

      case 'cache-aside':
        service = new CacheAsideService(dbConfig, redisConfig);
        break;

      case 'write-through':
        service = new WriteThroughService(dbConfig, redisConfig);
        break;

      case 'write-behind':
        service = new WriteBehindService(dbConfig, redisConfig, writeBehindInterval);
        break;

      default:
        throw new Error(`Unknown service: ${SERVICE_NAME}`);
    }

    await service.init();

    // Mount routes
    app.use('/api', service.getRouter());

    // Root endpoint
    app.get('/', (req, res) => {
      res.json({
        service: SERVICE_NAME,
        status: 'running',
        endpoints: {
          health: '/api/health',
          stats: '/api/stats',
          products: '/api/products',
          productById: '/api/products/:id',
          customers: '/api/customers',
          customerById: '/api/customers/:id',
          orders: '/api/orders',
          orderById: '/api/orders/:id'
        }
      });
    });

    // Error handling middleware
    app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    // Start server
    const server = app.listen(PORT, () => {
      console.log(`\n✅ ${SERVICE_NAME} service listening on port ${PORT}\n`);
      console.log(`   Database: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
      if (SERVICE_NAME !== 'no-caching') {
        console.log(`   Redis: ${redisConfig.host}:${redisConfig.port}`);
      }
      if (SERVICE_NAME === 'write-behind') {
        console.log(`   Write-Behind Interval: ${writeBehindInterval}ms`);
      }
      console.log(`\n   Ready to accept requests! 🎉\n`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('\n📛 SIGTERM signal received. Closing gracefully...');
      server.close(async () => {
        await service.close();
        console.log('✅ Service closed successfully');
        process.exit(0);
      });
    });

    process.on('SIGINT', async () => {
      console.log('\n📛 SIGINT signal received. Closing gracefully...');
      server.close(async () => {
        await service.close();
        console.log('✅ Service closed successfully');
        process.exit(0);
      });
    });

  } catch (error) {
    console.error('❌ Failed to start service:', error);
    process.exit(1);
  }
}

startService();

