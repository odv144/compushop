const db = require('../db/database');

// GET /api/dashboard/stats (admin)
function getStats(req, res) {
  try {
    const productsCount = db.prepare('SELECT COUNT(*) as c FROM products WHERE is_active = 1').get().c;
    const servicesCount = db.prepare('SELECT COUNT(*) as c FROM services WHERE is_active = 1').get().c;
    const usersCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'customer'").get().c;
    const ordersCount = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
    const pendingOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('pending','confirmed','processing')").get().c;
    const unreadMessages = db.prepare('SELECT COUNT(*) as c FROM contact_messages WHERE is_read = 0').get().c;

    const revenue = db.prepare(`
      SELECT COALESCE(SUM(total), 0) as total
      FROM orders
      WHERE status NOT IN ('cancelled')
    `).get().total;

    const recentOrders = db.prepare(`
      SELECT id, order_number, customer_name, total, status, created_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT 5
    `).all();

    const lowStock = db.prepare(`
      SELECT id, name, stock, price
      FROM products
      WHERE is_active = 1 AND stock <= 5
      ORDER BY stock ASC
      LIMIT 10
    `).all();

    // Ventas por mes (últimos 6 meses)
    const salesByMonth = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(total) as total, COUNT(*) as orders
      FROM orders
      WHERE status NOT IN ('cancelled')
        AND created_at >= date('now', '-6 months')
      GROUP BY month
      ORDER BY month
    `).all();

    res.json({
      stats: {
        productsCount,
        servicesCount,
        usersCount,
        ordersCount,
        pendingOrders,
        unreadMessages,
        revenue,
      },
      recentOrders,
      lowStock,
      salesByMonth,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
}

module.exports = { getStats };
