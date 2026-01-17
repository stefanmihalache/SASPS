const express = require('express');
const DatabaseService = require('../services/database');
const RedisService = require('../services/redis');

/**
 * READ-THROUGH STRATEGY
 * - Read: cache first; on miss load from DB and populate cache
 * - Write: write-through (DB then cache) to keep strong consistency
 */
class ReadThroughService {
    constructor(dbConfig, redisConfig, metrics = null, serviceName = 'read-through') {
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
            queuedWrites: 0,   // kept for compatibility with your stats shape (always 0 here)
            flushedWrites: 0,  // kept for compatibility (always 0 here)
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
        console.log('✓ Read-Through Service initialized');
    }

    getCacheKey(type, id) {
        return `read-through:${type}:${id}`;
    }

    async invalidateProductLists() {
        const listKeys = await this.cache.keys(this.getCacheKey('products', '*'));
        for (const key of listKeys) await this.cache.del(key);
    }

    async invalidateCustomerLists() {
        const listKeys = await this.cache.keys(this.getCacheKey('customers', '*'));
        for (const key of listKeys) await this.cache.del(key);
    }

    async getOrLoad(cacheKey, loaderFn) {
        const cached = await this.cache.get(cacheKey);
        if (cached) {
            this.recordReadHit();
            return { value: cached, source: 'cache' };
        }

        this.recordReadMiss();
        const loaded = await loaderFn();
        if (loaded) {
            await this.cache.set(cacheKey, loaded, this.cacheTTL);
        }
        return { value: loaded, source: 'database' };
    }

    getRouter() {
        const router = express.Router();

        router.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                strategy: 'read-through'
            });
        });

        router.get('/stats', (req, res) => {
            const hitRate = this.stats.reads > 0
                ? (this.stats.cacheHits / this.stats.reads * 100).toFixed(2)
                : 0;

            res.json({
                strategy: 'read-through',
                ...this.stats,
                currentQueueSize: 0,
                cacheHitRate: `${hitRate}%`,
                avgResponseTime: this.stats.requests.length > 0
                    ? this.stats.requests.reduce((a, b) => a + b, 0) / this.stats.requests.length
                    : 0
            });
        });

        router.post('/stats/reset', async (req, res) => {
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
            await this.cache.flush();
            res.json({ message: 'Stats reset and cache flushed successfully' });
        });

        // --------------------
        // Products (Read-through)
        // --------------------
        router.get('/products/:id', async (req, res) => {
            const startTime = Date.now();
            try {
                const cacheKey = this.getCacheKey('product', req.params.id);

                const { value: product, source } = await this.getOrLoad(cacheKey, () =>
                    this.db.getProductById(req.params.id)
                );

                const responseTime = Date.now() - startTime;
                this.recordDuration(responseTime);

                if (product) return res.json({ data: product, source, responseTime });
                return res.status(404).json({ error: 'Product not found' });
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

                const { value: products, source } = await this.getOrLoad(cacheKey, () =>
                    this.db.getAllProducts(limit)
                );

                const responseTime = Date.now() - startTime;
                this.recordDuration(responseTime);

                res.json({
                    data: products || [],
                    source,
                    count: (products || []).length,
                    responseTime
                });
            } catch (error) {
                console.error('Error fetching products:', error);
                this.recordError();
                res.status(500).json({ error: error.message });
            }
        });

        // Writes: write-through (DB then cache)
        router.put('/products/:id', async (req, res) => {
            const startTime = Date.now();
            try {
                this.recordWrite();

                const current = await this.db.getProductById(req.params.id);
                if (!current) return res.status(404).json({ error: 'Product not found' });

                await this.db.updateProduct(req.params.id, req.body);

                const updatedProduct = { ...current, ...req.body };
                await this.cache.set(this.getCacheKey('product', req.params.id), updatedProduct, this.cacheTTL);

                await this.invalidateProductLists();

                const responseTime = Date.now() - startTime;
                this.recordDuration(responseTime);

                res.json({ message: 'Product updated successfully', responseTime });
            } catch (error) {
                console.error('Error updating product:', error);
                this.recordError();
                res.status(500).json({ error: error.message });
            }
        });

        router.post('/products', async (req, res) => {
            const startTime = Date.now();
            try {
                this.recordWrite();

                await this.db.createProduct(req.body);

                // Cache the created product (same style as your write-behind example)
                if (req.body?.productCode) {
                    await this.cache.set(this.getCacheKey('product', req.body.productCode), req.body, this.cacheTTL);
                }

                await this.invalidateProductLists();

                const responseTime = Date.now() - startTime;
                this.recordDuration(responseTime);

                res.status(201).json({ message: 'Product created successfully', responseTime });
            } catch (error) {
                console.error('Error creating product:', error);
                this.recordError();
                res.status(500).json({ error: error.message });
            }
        });

        router.delete('/products/:id', async (req, res) => {
            const startTime = Date.now();
            try {
                this.recordWrite();

                await this.db.deleteProduct(req.params.id);

                await this.cache.del(this.getCacheKey('product', req.params.id));
                await this.invalidateProductLists();

                const responseTime = Date.now() - startTime;
                this.recordDuration(responseTime);

                res.json({ message: 'Product deleted successfully', responseTime });
            } catch (error) {
                console.error('Error deleting product:', error);
                this.recordError();
                res.status(500).json({ error: error.message });
            }
        });

        // --------------------
        // Customers (Read-through)
        // --------------------
        router.get('/customers/:id', async (req, res) => {
            const startTime = Date.now();
            try {
                const cacheKey = this.getCacheKey('customer', req.params.id);

                const { value: customer, source } = await this.getOrLoad(cacheKey, () =>
                    this.db.getCustomerById(req.params.id)
                );

                const responseTime = Date.now() - startTime;
                this.recordDuration(responseTime);

                if (customer) return res.json({ data: customer, source, responseTime });
                return res.status(404).json({ error: 'Customer not found' });
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

                const { value: customers, source } = await this.getOrLoad(cacheKey, () =>
                    this.db.getAllCustomers(limit)
                );

                const responseTime = Date.now() - startTime;
                this.recordDuration(responseTime);

                res.json({
                    data: customers || [],
                    source,
                    count: (customers || []).length,
                    responseTime
                });
            } catch (error) {
                console.error('Error fetching customers:', error);
                this.recordError();
                res.status(500).json({ error: error.message });
            }
        });

        // --------------------
        // Orders (Read-through)
        // --------------------
        router.get('/orders/:id', async (req, res) => {
            const startTime = Date.now();
            try {
                const cacheKey = this.getCacheKey('order', req.params.id);

                const { value: order, source } = await this.getOrLoad(cacheKey, () =>
                    this.db.getOrderById(req.params.id)
                );

                const responseTime = Date.now() - startTime;
                this.recordDuration(responseTime);

                if (order) return res.json({ data: order, source, responseTime });
                return res.status(404).json({ error: 'Order not found' });
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

module.exports = ReadThroughService;
