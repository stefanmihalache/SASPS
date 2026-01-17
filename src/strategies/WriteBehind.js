const express = require('express');
const DatabaseService = require('../services/database');
const RedisService = require('../services/redis');

/**
 * WRITE-BEHIND (WRITE-BACK) STRATEGY
 * - Read: Check cache first, if miss, load from DB and populate cache
 * - Write: Write to cache immediately, queue DB write for later (async)
 * - Fast writes, but temporary inconsistency between cache and DB
 * - Risk of data loss if cache fails before DB write completes
 */
class WriteBehindService {
  constructor(dbConfig, redisConfig, metrics = null, serviceName = 'write-behind', writeBehindInterval = 5000) {
    this.db = new DatabaseService(dbConfig);
    this.cache = new RedisService(redisConfig);
    this.metrics = metrics;
    this.serviceName = serviceName;
    this.cacheTTL = 3600; // 1 hour
    this.writeBehindInterval = writeBehindInterval; // How often to flush writes to DB
    this.writeQueue = new Map(); // Pending writes
    this.flushTimer = null;
    this.stats = {
      reads: 0,
      writes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      queuedWrites: 0,
      flushedWrites: 0,
      avgResponseTime: 0,
      requests: []
    };
  }

  recordReadHit() {
    this.stats.reads++;
    this.stats.cacheHits++;
    this.metrics?.reads.labels(this.serviceName).inc();
    this.metrics?.cacheHits.labels(this.serviceName).inc();
  }

  recordReadMiss() {
    this.stats.reads++;
    this.stats.cacheMisses++;
    this.metrics?.reads.labels(this.serviceName).inc();
    this.metrics?.cacheMisses.labels(this.serviceName).inc();
  }

  recordWrite() {
    this.stats.writes++;
    this.metrics?.writes.labels(this.serviceName).inc();
  }

  recordDuration(ms) {
    this.stats.requests.push(ms);
  }

  recordError() {
    this.metrics?.errors.labels(this.serviceName).inc();
  }

  updateQueueGauges() {
    this.metrics?.queuedWrites.labels(this.serviceName).set(this.writeQueue.size);
    this.metrics?.flushedWrites.labels(this.serviceName).set(this.stats.flushedWrites);
  }

  async init() {
    await this.db.connect();
    await this.cache.connect();

    // Start background flush process
    this.startFlushTimer();
    this.updateQueueGauges();

    console.log(`✓ Write-Behind Service initialized (flush interval: ${this.writeBehindInterval}ms)`);
  }

  getCacheKey(type, id) {
    return `write-behind:${type}:${id}`;
  }

  // Background process to flush queued writes to database
  startFlushTimer() {
    this.flushTimer = setInterval(async () => {
      await this.flushWriteQueue();
    }, this.writeBehindInterval);
  }

  async flushWriteQueue() {
    if (this.writeQueue.size === 0) return;

    console.log(`Flushing ${this.writeQueue.size} queued writes to database...`);

    const writes = Array.from(this.writeQueue.values());
    this.writeQueue.clear();

    for (const write of writes) {
      try {
        switch (write.operation) {
          case 'update':
            await this.db.updateProduct(write.id, write.data);
            break;
          case 'create':
            await this.db.createProduct(write.data);
            break;
          case 'delete':
            await this.db.deleteProduct(write.id);
            break;
        }
        this.stats.flushedWrites++;
        this.updateQueueGauges();
      } catch (error) {
        console.error(`Error flushing write for ${write.id}:`, error);
        // In production, you might want to re-queue failed writes
      }
    }

    console.log(`✓ Flush complete. ${this.stats.flushedWrites} total writes flushed.`);
    this.updateQueueGauges();
  }

  queueWrite(operation, id, data = null) {
    const key = `${operation}:${id}`;
    this.writeQueue.set(key, { operation, id, data, timestamp: Date.now() });
    this.stats.queuedWrites++;
    this.updateQueueGauges();
  }

  getRouter() {
    const router = express.Router();

    router.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        strategy: 'write-behind',
        queueSize: this.writeQueue.size
      });
    });

    router.get('/stats', (req, res) => {
      const hitRate = this.stats.reads > 0
        ? (this.stats.cacheHits / this.stats.reads * 100).toFixed(2)
        : 0;

      res.json({
        strategy: 'write-behind',
        ...this.stats,
        currentQueueSize: this.writeQueue.size,
        cacheHitRate: `${hitRate}%`,
        avgResponseTime: this.stats.requests.length > 0
          ? this.stats.requests.reduce((a, b) => a + b, 0) / this.stats.requests.length
          : 0
      });
    });

    router.post('/stats/reset', async (req, res) => {
      // Flush pending writes before reset
      await this.flushWriteQueue();

      this.stats = {
        reads: 0,
        writes: 0,
        cacheHits: 0,
        cacheMisses: 0,
        queuedWrites: 0,
        flushedWrites: 0,
        avgResponseTime: 0,
        requests: []
      };
      this.updateQueueGauges();
      await this.cache.flush();
      res.json({ message: 'Stats reset and cache flushed successfully' });
    });

    // Force flush endpoint for testing
    router.post('/flush', async (req, res) => {
      await this.flushWriteQueue();
      res.json({
        message: 'Write queue flushed successfully',
        flushedWrites: this.stats.flushedWrites
      });
    });

    // Read operations - same as other strategies
    router.get('/products/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        const cacheKey = this.getCacheKey('product', req.params.id);

        let product = await this.cache.get(cacheKey);
        let source = 'cache';

        if (product) {
          this.recordReadHit();
        } else {
          this.recordReadMiss();
          source = 'database';

          product = await this.db.getProductById(req.params.id);

          if (product) {
            await this.cache.set(cacheKey, product, this.cacheTTL);
          }
        }

        const responseTime = Date.now() - startTime;
      this.recordDuration(responseTime);

        if (product) {
          res.json({ data: product, source, responseTime });
        } else {
          res.status(404).json({ error: 'Product not found' });
        }
      } catch (error) {
        console.error('Error fetching product:', error);
      this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    router.get('/products', async (req, res) => {
      const startTime = Date.now();
      try {
        const limit = parseInt(req.query.limit) || 100;
        const cacheKey = this.getCacheKey('products', `all:${limit}`);

        let products = await this.cache.get(cacheKey);
        let source = 'cache';

        if (products) {
          this.recordReadHit();
        } else {
          this.recordReadMiss();
          source = 'database';

          products = await this.db.getAllProducts(limit);
          await this.cache.set(cacheKey, products, this.cacheTTL);
        }

        const responseTime = Date.now() - startTime;
      this.recordDuration(responseTime);

        res.json({ data: products, source, count: products.length, responseTime });
      } catch (error) {
        console.error('Error fetching products:', error);
      this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Update product - Write-Behind: Update cache immediately, queue DB write
    router.put('/products/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        this.recordWrite();

        // First, get current product to merge with update
        const current = await this.db.getProductById(req.params.id);

        if (!current) {
          res.status(404).json({ error: 'Product not found' });
          return;
        }

        // Write to cache immediately
        const updatedProduct = { ...current, ...req.body };
        const cacheKey = this.getCacheKey('product', req.params.id);
        await this.cache.set(cacheKey, updatedProduct, this.cacheTTL);

        // Queue the database write for later
        this.queueWrite('update', req.params.id, req.body);
        this.updateQueueGauges();

        // Invalidate list caches
        const listKeys = await this.cache.keys(this.getCacheKey('products', '*'));
        for (const key of listKeys) {
          await this.cache.del(key);
        }

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        res.json({
          message: 'Product updated successfully (queued for DB write)',
          queueSize: this.writeQueue.size,
          responseTime
        });
      } catch (error) {
        console.error('Error updating product:', error);
      this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Create product - Write-Behind pattern
    router.post('/products', async (req, res) => {
      const startTime = Date.now();
      try {
        this.recordWrite();

        // Write to cache immediately
        const cacheKey = this.getCacheKey('product', req.body.productCode);
        await this.cache.set(cacheKey, req.body, this.cacheTTL);

        // Queue the database write
        this.queueWrite('create', req.body.productCode, req.body);
        this.updateQueueGauges();

        // Invalidate list caches
        const listKeys = await this.cache.keys(this.getCacheKey('products', '*'));
        for (const key of listKeys) {
          await this.cache.del(key);
        }

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        res.status(201).json({
          message: 'Product created successfully (queued for DB write)',
          queueSize: this.writeQueue.size,
          responseTime
        });
      } catch (error) {
        console.error('Error creating product:', error);
      this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Delete product - Write-Behind pattern
    router.delete('/products/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        this.recordWrite();

        // Remove from cache immediately
        const cacheKey = this.getCacheKey('product', req.params.id);
        await this.cache.del(cacheKey);

        // Queue the database delete
        this.queueWrite('delete', req.params.id);
        this.updateQueueGauges();

        // Invalidate list caches
        const listKeys = await this.cache.keys(this.getCacheKey('products', '*'));
        for (const key of listKeys) {
          await this.cache.del(key);
        }

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        res.json({
          message: 'Product deleted successfully (queued for DB write)',
          queueSize: this.writeQueue.size,
          responseTime
        });
      } catch (error) {
        console.error('Error deleting product:', error);
      this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Customer endpoints
    router.get('/customers/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        const cacheKey = this.getCacheKey('customer', req.params.id);

        let customer = await this.cache.get(cacheKey);
        let source = 'cache';

        if (customer) {
          this.recordReadHit();
        } else {
          this.recordReadMiss();
          source = 'database';
          customer = await this.db.getCustomerById(req.params.id);

          if (customer) {
            await this.cache.set(cacheKey, customer, this.cacheTTL);
          }
        }

        const responseTime = Date.now() - startTime;
      this.recordDuration(responseTime);

        if (customer) {
          res.json({ data: customer, source, responseTime });
        } else {
          res.status(404).json({ error: 'Customer not found' });
        }
      } catch (error) {
        console.error('Error fetching customer:', error);
      this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    router.get('/customers', async (req, res) => {
      const startTime = Date.now();
      try {
        const limit = parseInt(req.query.limit) || 100;
        const cacheKey = this.getCacheKey('customers', `all:${limit}`);

        let customers = await this.cache.get(cacheKey);
        let source = 'cache';

        if (customers) {
          this.recordReadHit();
        } else {
          this.recordReadMiss();
          source = 'database';
          customers = await this.db.getAllCustomers(limit);
          await this.cache.set(cacheKey, customers, this.cacheTTL);
        }

        const responseTime = Date.now() - startTime;
      this.recordDuration(responseTime);

        res.json({ data: customers, source, count: customers.length, responseTime });
      } catch (error) {
        console.error('Error fetching customers:', error);
      this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Order endpoints
    router.get('/orders/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        const cacheKey = this.getCacheKey('order', req.params.id);

        let order = await this.cache.get(cacheKey);
        let source = 'cache';

        if (order) {
          this.recordReadHit();
        } else {
          this.recordReadMiss();
          source = 'database';
          order = await this.db.getOrderById(req.params.id);

          if (order) {
            await this.cache.set(cacheKey, order, this.cacheTTL);
          }
        }

        const responseTime = Date.now() - startTime;
      this.recordDuration(responseTime);

        if (order) {
          res.json({ data: order, source, responseTime });
        } else {
          res.status(404).json({ error: 'Order not found' });
        }
      } catch (error) {
        console.error('Error fetching order:', error);
      this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }

  async close() {
    // Flush any pending writes before closing
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    await this.flushWriteQueue();
    await this.db.close();
    await this.cache.close();
  }
}

module.exports = WriteBehindService;

