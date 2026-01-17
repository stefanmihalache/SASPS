const express = require('express');
const DatabaseService = require('../services/database');
const RedisService = require('../services/redis');

/**
 * CACHE-ASIDE (LAZY LOADING) STRATEGY
 * - Read: Check cache first, if miss, load from DB and populate cache
 * - Write: Update DB first, then invalidate cache
 * - Application manages cache explicitly
 */
class CacheAsideService {
  constructor(dbConfig, redisConfig, metrics = null, serviceName = 'cache-aside') {
    this.db = new DatabaseService(dbConfig);
    this.cache = new RedisService(redisConfig);
    this.metrics = metrics;
    this.serviceName = serviceName;
    this.cacheTTL = 3600; // 1 hour
    this.stats = {
      reads: 0,
      writes: 0,
      cacheHits: 0,
      cacheMisses: 0,
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

  async init() {
    await this.db.connect();
    await this.cache.connect();
    console.log('✓ Cache-Aside Service initialized');
  }

  // Generate cache keys
  getCacheKey(type, id) {
    return `cache-aside:${type}:${id}`;
  }

  getRouter() {
    const router = express.Router();

    // Health check
    router.get('/health', (req, res) => {
      res.json({ status: 'healthy', strategy: 'cache-aside' });
    });

    // Stats endpoint
    router.get('/stats', (req, res) => {
      const hitRate = this.stats.reads > 0
        ? (this.stats.cacheHits / this.stats.reads * 100).toFixed(2)
        : 0;

      res.json({
        strategy: 'cache-aside',
        ...this.stats,
        cacheHitRate: `${hitRate}%`,
        avgResponseTime: this.stats.requests.length > 0
          ? this.stats.requests.reduce((a, b) => a + b, 0) / this.stats.requests.length
          : 0
      });
    });

    // Reset stats
    router.post('/stats/reset', async (req, res) => {
      this.stats = {
        reads: 0,
        writes: 0,
        cacheHits: 0,
        cacheMisses: 0,
        avgResponseTime: 0,
        requests: []
      };
      await this.cache.flush();
      res.json({ message: 'Stats reset and cache flushed successfully' });
    });

    // Get product by ID - Cache-Aside pattern
    router.get('/products/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        const cacheKey = this.getCacheKey('product', req.params.id);

        // Try cache first
        let product = await this.cache.get(cacheKey);
        let source = 'cache';

        if (product) {
          this.recordReadHit();
        } else {
          // Cache miss - load from database
          this.recordReadMiss();
          source = 'database';

          product = await this.db.getProductById(req.params.id);

          // Populate cache for future requests
          if (product) {
            await this.cache.set(cacheKey, product, this.cacheTTL);
          }
        }

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        if (product) {
          res.json({
            data: product,
            source,
            responseTime
          });
        } else {
          res.status(404).json({ error: 'Product not found' });
        }
      } catch (error) {
        console.error('Error fetching product:', error);
        this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Get all products
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

        res.json({
          data: products,
          source,
          count: products.length,
          responseTime
        });
      } catch (error) {
        console.error('Error fetching products:', error);
        this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Update product - Invalidate cache after write
    router.put('/products/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        this.recordWrite();

        // Write to database first
        const success = await this.db.updateProduct(req.params.id, req.body);

        if (success) {
          // Invalidate cache entries
          const cacheKey = this.getCacheKey('product', req.params.id);
          await this.cache.del(cacheKey);

          // Invalidate list caches
          const listKeys = await this.cache.keys(this.getCacheKey('products', '*'));
          for (const key of listKeys) {
            await this.cache.del(key);
          }
        }

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        if (success) {
          res.json({
            message: 'Product updated successfully',
            responseTime
          });
        } else {
          res.status(404).json({ error: 'Product not found' });
        }
      } catch (error) {
        console.error('Error updating product:', error);
        this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Create product
    router.post('/products', async (req, res) => {
      const startTime = Date.now();
      try {
        this.recordWrite();

        const success = await this.db.createProduct(req.body);

        if (success) {
          // Invalidate list caches
          const listKeys = await this.cache.keys(this.getCacheKey('products', '*'));
          for (const key of listKeys) {
            await this.cache.del(key);
          }
        }

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        if (success) {
          res.status(201).json({
            message: 'Product created successfully',
            responseTime
          });
        } else {
          res.status(400).json({ error: 'Failed to create product' });
        }
      } catch (error) {
        console.error('Error creating product:', error);
        this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Delete product
    router.delete('/products/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        this.recordWrite();

        const success = await this.db.deleteProduct(req.params.id);

        if (success) {
          const cacheKey = this.getCacheKey('product', req.params.id);
          await this.cache.del(cacheKey);

          const listKeys = await this.cache.keys(this.getCacheKey('products', '*'));
          for (const key of listKeys) {
            await this.cache.del(key);
          }
        }

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        if (success) {
          res.json({
            message: 'Product deleted successfully',
            responseTime
          });
        } else {
          res.status(404).json({ error: 'Product not found' });
        }
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
    await this.db.close();
    await this.cache.close();
  }
}

module.exports = CacheAsideService;

