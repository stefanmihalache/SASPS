const express = require('express');
const DatabaseService = require('../services/database');

/**
 * NO CACHING STRATEGY
 * All operations go directly to the database.
 * This serves as the baseline for comparison.
 */
class NoCachingService {
  constructor(dbConfig, metrics = null, serviceName = 'no-caching') {
    this.db = new DatabaseService(dbConfig);
    this.metrics = metrics;
    this.serviceName = serviceName;
    this.stats = {
      reads: 0,
      writes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      avgResponseTime: 0,
      requests: []
    };
  }

  recordRead(hit = false) {
    this.stats.reads++;
    if (hit) {
      this.stats.cacheHits++;
      this.metrics?.cacheHits.labels(this.serviceName).inc();
    } else {
      this.stats.cacheMisses++;
      this.metrics?.cacheMisses.labels(this.serviceName).inc();
    }
    this.metrics?.reads.labels(this.serviceName).inc();
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
    console.log('✓ No-Caching Service initialized');
  }

  getRouter() {
    const router = express.Router();

    // Health check
    router.get('/health', (req, res) => {
      res.json({ status: 'healthy', strategy: 'no-caching' });
    });

    // Stats endpoint
    router.get('/stats', (req, res) => {
      res.json({
        strategy: 'no-caching',
        ...this.stats,
        avgResponseTime: this.stats.requests.length > 0
          ? this.stats.requests.reduce((a, b) => a + b, 0) / this.stats.requests.length
          : 0
      });
    });

    // Reset stats
    router.post('/stats/reset', (req, res) => {
      this.stats = {
        reads: 0,
        writes: 0,
        cacheHits: 0,
        cacheMisses: 0,
        avgResponseTime: 0,
        requests: []
      };
      res.json({ message: 'Stats reset successfully' });
    });

    // Get product by ID
    router.get('/products/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        this.recordRead(false); // always miss

        const product = await this.db.getProductById(req.params.id);

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        if (product) {
          res.json({
            data: product,
            source: 'database',
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
        this.recordRead(false);

        const limit = parseInt(req.query.limit) || 100;
        const products = await this.db.getAllProducts(limit);

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        res.json({
          data: products,
          source: 'database',
          count: products.length,
          responseTime
        });
      } catch (error) {
        console.error('Error fetching products:', error);
        this.recordError();
        res.status(500).json({ error: error.message });
      }
    });

    // Update product
    router.put('/products/:id', async (req, res) => {
      const startTime = Date.now();
      try {
        this.recordWrite();

        const success = await this.db.updateProduct(req.params.id, req.body);

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
        this.recordRead(false);

        const customer = await this.db.getCustomerById(req.params.id);

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        if (customer) {
          res.json({
            data: customer,
            source: 'database',
            responseTime
          });
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
        this.recordRead(false);

        const limit = parseInt(req.query.limit) || 100;
        const customers = await this.db.getAllCustomers(limit);

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        res.json({
          data: customers,
          source: 'database',
          count: customers.length,
          responseTime
        });
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
        this.recordRead(false);

        const order = await this.db.getOrderById(req.params.id);

        const responseTime = Date.now() - startTime;
        this.recordDuration(responseTime);

        if (order) {
          res.json({
            data: order,
            source: 'database',
            responseTime
          });
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
  }
}

module.exports = NoCachingService;

