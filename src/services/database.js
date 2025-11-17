const mysql = require('mysql2/promise');

class DatabaseService {
  constructor(config) {
    this.config = config;
    this.pool = null;
  }

  async connect() {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
      });
      console.log(`✓ Database connection pool created`);
    }
    return this.pool;
  }

  async query(sql, params) {
    const connection = await this.pool.getConnection();
    try {
      const [rows] = await connection.query(sql, params);
      return rows;
    } finally {
      connection.release();
    }
  }

  // Product Operations
  async getProductById(productCode) {
    const sql = 'SELECT * FROM products WHERE productCode = ?';
    const results = await this.query(sql, [productCode]);
    return results[0] || null;
  }

  async getAllProducts(limit = 100) {
    const sql = 'SELECT * FROM products LIMIT ?';
    return await this.query(sql, [limit]);
  }

  async updateProduct(productCode, data) {
    const { productName, quantityInStock, buyPrice, MSRP } = data;
    const sql = `UPDATE products 
                 SET productName = ?, quantityInStock = ?, buyPrice = ?, MSRP = ? 
                 WHERE productCode = ?`;
    const result = await this.query(sql, [productName, quantityInStock, buyPrice, MSRP, productCode]);
    return result.affectedRows > 0;
  }

  async createProduct(product) {
    const sql = `INSERT INTO products 
                 (productCode, productName, productLine, productScale, productVendor, 
                  productDescription, quantityInStock, buyPrice, MSRP) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const result = await this.query(sql, [
      product.productCode,
      product.productName,
      product.productLine,
      product.productScale,
      product.productVendor,
      product.productDescription,
      product.quantityInStock,
      product.buyPrice,
      product.MSRP
    ]);
    return result.affectedRows > 0;
  }

  async deleteProduct(productCode) {
    const sql = 'DELETE FROM products WHERE productCode = ?';
    const result = await this.query(sql, [productCode]);
    return result.affectedRows > 0;
  }

  // Customer Operations
  async getCustomerById(customerNumber) {
    const sql = 'SELECT * FROM customers WHERE customerNumber = ?';
    const results = await this.query(sql, [customerNumber]);
    return results[0] || null;
  }

  async getAllCustomers(limit = 100) {
    const sql = 'SELECT * FROM customers LIMIT ?';
    return await this.query(sql, [limit]);
  }

  async updateCustomer(customerNumber, data) {
    const { customerName, phone, addressLine1, city, country, creditLimit } = data;
    const sql = `UPDATE customers 
                 SET customerName = ?, phone = ?, addressLine1 = ?, city = ?, country = ?, creditLimit = ? 
                 WHERE customerNumber = ?`;
    const result = await this.query(sql, [customerName, phone, addressLine1, city, country, creditLimit, customerNumber]);
    return result.affectedRows > 0;
  }

  // Order Operations
  async getOrderById(orderNumber) {
    const sql = `SELECT o.*, od.* 
                 FROM orders o 
                 LEFT JOIN orderdetails od ON o.orderNumber = od.orderNumber 
                 WHERE o.orderNumber = ?`;
    const results = await this.query(sql, [orderNumber]);
    if (results.length === 0) return null;

    // Aggregate order details
    const order = {
      orderNumber: results[0].orderNumber,
      orderDate: results[0].orderDate,
      requiredDate: results[0].requiredDate,
      shippedDate: results[0].shippedDate,
      status: results[0].status,
      comments: results[0].comments,
      customerNumber: results[0].customerNumber,
      items: results.map(row => ({
        productCode: row.productCode,
        quantityOrdered: row.quantityOrdered,
        priceEach: row.priceEach,
        orderLineNumber: row.orderLineNumber
      }))
    };
    return order;
  }

  async getOrdersByCustomer(customerNumber) {
    const sql = 'SELECT * FROM orders WHERE customerNumber = ? ORDER BY orderDate DESC';
    return await this.query(sql, [customerNumber]);
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      console.log('✓ Database connection pool closed');
    }
  }
}

module.exports = DatabaseService;

