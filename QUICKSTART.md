# Quick Start Guide


### Step 1: Start All Services

```bash
./start.sh
```

Or manually:
```bash
docker-compose up -d --build
```

### Step 2: Wait for Services (30-60 seconds)

The services need time to initialize:
- MySQL database initialization
- Redis cache startup
- All 4 Node.js services

### Step 3: Verify Services are Running

```bash
npm test
```

This will test all 4 services and verify they're working correctly.

### Step 4: Run Load Tests

```bash
npm run load-test
```

This will run comprehensive performance tests on all strategies:
- **Read Test**: 30 seconds of read-heavy operations
- **Write Test**: 10 seconds of write operations  
- **Mixed Test**: 30 seconds of mixed read/write operations

Results are saved to `load-test-results-<timestamp>.json`

## Quick Examples

### Test Individual Services

**No-Caching (Port 3000):**
```bash
# Get a product
curl http://localhost:3000/api/products/S10_1678

# Get stats
curl http://localhost:3000/api/stats
```

**Cache-Aside (Port 3001):**
```bash
# First request (cache miss)
curl http://localhost:3001/api/products/S10_1678

# Second request (cache hit - should be faster)
curl http://localhost:3001/api/products/S10_1678

# View cache statistics
curl http://localhost:3001/api/stats
```

**Write-Through (Port 3002):**
```bash
# Update product (writes to both cache and DB)
curl -X PUT http://localhost:3002/api/products/S10_1678 \
  -H "Content-Type: application/json" \
  -d '{"productName":"Updated","quantityInStock":500,"buyPrice":50,"MSRP":100}'

# Read updated product (from cache)
curl http://localhost:3002/api/products/S10_1678

# Check stats
curl http://localhost:3002/api/stats
```

**Write-Behind (Port 3003):**
```bash
# Update product (immediate cache write, DB write queued)
curl -X PUT http://localhost:3003/api/products/S10_1678 \
  -H "Content-Type: application/json" \
  -d '{"productName":"Updated","quantityInStock":500,"buyPrice":50,"MSRP":100}'

# Force flush the write queue
curl -X POST http://localhost:3003/api/flush

# Check stats (shows queued and flushed writes)
curl http://localhost:3003/api/stats
```

## Understanding the Results

### Cache Hit Rate
- **0%**: No caching (baseline)
- **50-70%**: Good for mixed workloads
- **80-95%**: Excellent for read-heavy workloads

### Response Times
- **No-Caching**: Slowest, every request hits DB
- **Cache-Aside**: Fast after cache warm-up
- **Write-Through**: Fast reads, slower writes
- **Write-Behind**: Fastest overall, especially for writes

### Throughput (Requests/sec)
Higher is better. Caching strategies should show 2-10x improvement over no-caching.

## Monitoring

### View Real-Time Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f cache-aside
```

### Check Redis Cache
```bash
docker exec -it redis redis-cli

# Inside Redis CLI:
KEYS *                                    # List all keys
GET "cache-aside:product:S10_1678"       # Get specific cached item
FLUSHALL                                  # Clear all cache
```

### Check MySQL Database
```bash
docker exec -it db mysql -u user -ppass testdb

# Inside MySQL:
SELECT * FROM products LIMIT 10;
SELECT COUNT(*) FROM products;
SELECT * FROM products WHERE productCode = 'S10_1678';
```

## Testing Scenarios

### Scenario 1: Cache Warm-Up
```bash
# Make 10 requests to the same product
for i in {1..10}; do
  curl -s http://localhost:3001/api/products/S10_1678 | grep source
done

# You should see: "source":"database" first, then "source":"cache"
```

### Scenario 2: Cache Invalidation
```bash
# Read product (cache it)
curl http://localhost:3001/api/products/S10_1678

# Update product (invalidates cache)
curl -X PUT http://localhost:3001/api/products/S10_1678 \
  -H "Content-Type: application/json" \
  -d '{"productName":"Updated","quantityInStock":500,"buyPrice":50,"MSRP":100}'

# Read again (cache miss, loads from DB)
curl http://localhost:3001/api/products/S10_1678
```

### Scenario 3: Write-Behind Queue
```bash
# Make several writes quickly
for i in {1..5}; do
  curl -X PUT http://localhost:3003/api/products/S10_1678 \
    -H "Content-Type: application/json" \
    -d "{\"productName\":\"Update $i\",\"quantityInStock\":$((100+i)),\"buyPrice\":50,\"MSRP\":100}"
done

# Check queue size
curl http://localhost:3003/api/stats | grep queueSize

# Force flush
curl -X POST http://localhost:3003/api/flush
```

## Dashboard (New)
```bash
npm run dashboard
# Open http://localhost:4000
```

## Consistency & Failure Tests (New)
```bash
npm run consistency-tests
# Add --skip-redis-kill to avoid stopping Redis if Docker access is restricted
```

## Prometheus + Grafana (New)
```bash
docker-compose up -d
# Prometheus: http://localhost:9090
# Grafana:    http://localhost:3006 (admin / admin)
```

