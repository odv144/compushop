const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');

function generateOrderNumber() {
  const date = new Date();
  const y = date.getFullYear().toString().slice(-2);
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `CS${y}${m}${d}-${rand}`;
}

// POST /api/orders  (confirmar pedido desde el carrito)
function create(req, res) {
  try {
    const {
      items, // [{ type: 'product'|'service', id, quantity, name, price }]
      shipping_address,
      notes,
      customer_name,
      customer_email,
      customer_phone,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'El pedido debe tener al menos un ítem' });
    }

    if (!customer_name || !customer_email) {
      return res.status(400).json({ error: 'Nombre y email del cliente son obligatorios' });
    }

    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const orderNumber = generateOrderNumber();
    const userId = req.user ? req.user.id : null;

    const insertOrder = db.prepare(`
      INSERT INTO orders (user_id, order_number, status, total, shipping_address, notes, customer_name, customer_email, customer_phone)
      VALUES (?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)
    `);

    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, service_id, name, price, quantity, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const updateStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');

    const transaction = db.transaction(() => {
      const result = insertOrder.run(
        userId,
        orderNumber,
        total,
        shipping_address || null,
        notes || null,
        customer_name,
        customer_email,
        customer_phone || null
      );

      const orderId = result.lastInsertRowid;

      for (const item of items) {
        const productId = item.type === 'product' ? item.id : null;
        const serviceId = item.type === 'service' ? item.id : null;

        insertItem.run(orderId, productId, serviceId, item.name, item.price, item.quantity, item.type);

        // Descontar stock solo de productos
        if (item.type === 'product') {
          const info = updateStock.run(item.quantity, item.id, item.quantity);
          if (info.changes === 0) {
            throw new Error(`Stock insuficiente para: ${item.name}`);
          }
        }
      }

      return orderId;
    });

    const orderId = transaction();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

    res.status(201).json({
      message: 'Pedido confirmado correctamente',
      order: { ...order, items: orderItems },
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || 'Error al crear el pedido' });
  }
}

// GET /api/orders (admin: todos | customer: solo los suyos)
function getAll(req, res) {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = 'SELECT * FROM orders WHERE 1=1';
    const params = [];

    if (req.user.role !== 'admin') {
      sql += ' AND user_id = ?';
      params.push(req.user.id);
    }

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
    const { total } = db.prepare(countSql).get(...params);

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const orders = db.prepare(sql).all(...params);

    res.json({
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
}

// GET /api/orders/:id
function getOne(req, res) {
  try {
    const { id } = req.params;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // Solo admin o el dueño
    if (req.user.role !== 'admin' && order.user_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
    res.json({ order: { ...order, items } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener pedido' });
  }
}

// PUT /api/orders/:id/status (admin)
function updateStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const valid = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, id);

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    res.json({ message: 'Estado actualizado', order: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
}

module.exports = { create, getAll, getOne, updateStatus };
