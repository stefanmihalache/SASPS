#!/bin/bash

# Quick Start Script for Caching Strategies Comparison
echo "🚀 Starting Caching Strategies Comparison Project"
echo "=================================================="
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

echo "✅ Docker is running"
echo ""

# Build and start services
echo "📦 Building and starting services..."
docker-compose up -d --build

echo ""
echo "⏳ Waiting for services to be ready..."
sleep 10

# Check service health
echo ""
echo "🏥 Checking service health..."
echo ""

for port in 3000 3001 3002 3003; do
    if curl -s http://localhost:$port/api/health > /dev/null; then
        SERVICE=$(curl -s http://localhost:$port/api/health | grep -o '"strategy":"[^"]*"' | cut -d'"' -f4)
        echo "✅ Port $port: $SERVICE service is healthy"
    else
        echo "❌ Port $port: Service is not responding"
    fi
done

echo ""
echo "🎉 All services are running!"
echo ""
echo "Available Services:"
echo "  - No-Caching:    http://localhost:3000"
echo "  - Cache-Aside:   http://localhost:3001"
echo "  - Write-Through: http://localhost:3002"
echo "  - Write-Behind:  http://localhost:3003"
echo ""
echo "Database:"
echo "  - MySQL:         localhost:3306"
echo "  - Redis:         localhost:6379"
echo ""
echo "📊 To run load tests:"
echo "     npm run load-test"
echo ""
echo "📋 To view logs:"
echo "     docker-compose logs -f"
echo ""
echo "🛑 To stop services:"
echo "     docker-compose down"
echo ""

