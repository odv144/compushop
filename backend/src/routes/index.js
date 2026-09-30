const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const store = require('../db/store');
const { generateToken } = require('../utils/jwt');
const { authenticate, requireAdmin, optionalAuth } = require('../middleware/auth');
const { sendContactEmail, sendPasswordResetEmail } = require('../utils/email');
const authCtrl = require('../controllers/authController');

// ========== AUTH ==========
router.post('/auth/register', authCtrl.register);
router.post('/auth/login', authCtrl.login);
router.get('/auth/me', authenticate, authCtrl.me);
router.post('/auth/forgot-password', authCtrl.forgotPassword);
router.post('/auth/reset-password', authCtrl.resetPassword);

function slugify(t) {
  return t.toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-');
}

// ========== CATEGORIES ==========
router.get('/categories', (req, res) => {
  const db = store.get();
  const categories = db.categories.map(c => ({
    ...c,
    product_count: db.products.filter(p => p.category_id === c.id && p.is_active).length,
  }));
  res.json({ categories });
});

router.post('/categories', authenticate, requireAdmin, (req, res) => {
  const { name, description, image } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre obligatorio' });
  const db = store.get();
  const cat = { id: store.next('categories'), name, slug: slugify(name), description: description || null, image: image || null, created_at: new Date().toISOString() };
  db.categories.push(cat);
  store.persist();
  res.status(201).json({ message: 'Categoría creada', category: cat });
});

router.put('/categories/:id', authenticate, requireAdmin, (req, res) => {
  const db = store.get();
  const cat = db.categories.find(c => c.id == req.params.id);
  if (!cat) return res.status(404).json({ error: 'No encontrada' });
  Object.assign(cat, { name: req.body.name ?? cat.name, description: req.body.description ?? cat.description, image: req.body.image ?? cat.image });
  store.persist();
  res.json({ message: 'Actualizada', category: cat });
});

router.delete('/categories/:id', authenticate, requireAdmin, (req, res) => {
  const db = store.get();
  const i = db.categories.findIndex(c => c.id == req.params.id);
  if (i < 0) return res.status(404).json({ error: 'No encontrada' });
  db.categories.splice(i, 1);
  store.persist();
  res.json({ message: 'Eliminada' });
});

// ========== PRODUCTS ==========
router.get('/products', (req, res) => {
  const db = store.get();
  let list = db.products.map(p => {
    const cat = db.categories.find(c => c.id === p.category_id);
    return { ...p, category_name: cat?.name, category_slug: cat?.slug };
  });
  if (req.query.active !== 'all') list = list.filter(p => p.is_active);
  if (req.query.category) list = list.filter(p => p.category_slug === req.query.category);
  if (req.query.search) {
    const t = req.query.search.toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(t) || (p.description || '').toLowerCase().includes(t) || (p.brand || '').toLowerCase().includes(t));
  }
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = list.length;
  const start = (page - 1) * limit;
  res.json({ products: list.slice(start, start + limit), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.get('/products/:id', (req, res) => {
  const db = store.get();
  const key = isNaN(req.params.id) ? 'slug' : 'id';
  const p = db.products.find(x => x[key] == req.params.id);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const cat = db.categories.find(c => c.id === p.category_id);
  res.json({ product: { ...p, category_name: cat?.name, category_slug: cat?.slug } });
});

router.post('/products', authenticate, requireAdmin, (req, res) => {
  const { name, description, price, stock, category_id, brand, image, specs, is_active = true } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'Nombre y precio obligatorios' });
  const db = store.get();
  let slug = slugify(name);
  if (db.products.find(p => p.slug === slug)) slug += '-' + Date.now();
  const product = {
    id: store.next('products'), name, slug, description: description || null, price, stock: stock || 0,
    category_id: category_id || null, brand: brand || null, image: image || null, specs: specs || null,
    is_active: !!is_active, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  db.products.push(product);
  store.persist();
  res.status(201).json({ message: 'Producto creado', product });
});

router.put('/products/:id', authenticate, requireAdmin, (req, res) => {
  const db = store.get();
  const p = db.products.find(x => x.id == req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  const fields = ['name', 'description', 'price', 'stock', 'category_id', 'brand', 'image', 'specs', 'is_active'];
  fields.forEach(f => { if (req.body[f] !== undefined) p[f] = req.body[f]; });
  if (req.body.name && req.body.name !== p.name) {
    p.slug = slugify(req.body.name);
  }
  p.updated_at = new Date().toISOString();
  store.persist();
  res.json({ message: 'Actualizado', product: p });
});

router.delete('/products/:id', authenticate, requireAdmin, (req, res) => {
  const db = store.get();
  const i = db.products.findIndex(x => x.id == req.params.id);
  if (i < 0) return res.status(404).json({ error: 'No encontrado' });
  db.products.splice(i, 1);
  store.persist();
  res.json({ message: 'Eliminado' });
});

// ========== SERVICES ==========
router.get('/services', (req, res) => {
  let list = store.get().services;
  if (req.query.active !== 'all') list = list.filter(s => s.is_active);
  res.json({ services: list });
});

router.get('/services/:id', (req, res) => {
  const key = isNaN(req.params.id) ? 'slug' : 'id';
  const s = store.get().services.find(x => x[key] == req.params.id);
  if (!s) return res.status(404).json({ error: 'Servicio no encontrado' });
  res.json({ service: s });
});

router.post('/services', authenticate, requireAdmin, (req, res) => {
  const { name, description, price, duration, image, is_active = true } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'Nombre y precio obligatorios' });
  const db = store.get();
  let slug = slugify(name);
  if (db.services.find(s => s.slug === slug)) slug += '-' + Date.now();
  const service = {
    id: store.next('services'), name, slug, description: description || null, price,
    duration: duration || null, image: image || null, is_active: !!is_active,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  db.services.push(service);
  store.persist();
  res.status(201).json({ message: 'Servicio creado', service });
});

router.put('/services/:id', authenticate, requireAdmin, (req, res) => {
  const db = store.get();
  const s = db.services.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'No encontrado' });
  ['name', 'description', 'price', 'duration', 'image', 'is_active'].forEach(f => {
    if (req.body[f] !== undefined) s[f] = req.body[f];
  });
  if (req.body.name) s.slug = slugify(req.body.name);
  s.updated_at = new Date().toISOString();
  store.persist();
  res.json({ message: 'Actualizado', service: s });
});

router.delete('/services/:id', authenticate, requireAdmin, (req, res) => {
  const db = store.get();
  const i = db.services.findIndex(x => x.id == req.params.id);
  if (i < 0) return res.status(404).json({ error: 'No encontrado' });
  db.services.splice(i, 1);
  store.persist();
  res.json({ message: 'Eliminado' });
});

// ========== ORDERS ==========
router.post('/orders', optionalAuth, (req, res) => {
  try {
    const { items, shipping_address, notes, customer_name, customer_email, customer_phone } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'El pedido debe tener al menos un ítem' });
    if (!customer_name || !customer_email) return res.status(400).json({ error: 'Nombre y email obligatorios' });

    const db = store.get();
    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const orderNumber = `CS${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;

    // Stock check
    for (const item of items) {
      if (item.type === 'product') {
        const p = db.products.find(x => x.id === item.id);
        if (!p || p.stock < item.quantity) return res.status(400).json({ error: `Stock insuficiente: ${item.name}` });
      }
    }

    const order = {
      id: store.next('orders'),
      user_id: req.user?.id || null,
      order_number: orderNumber,
      status: 'confirmed',
      total,
      shipping_address: shipping_address || null,
      notes: notes || null,
      customer_name, customer_email, customer_phone: customer_phone || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.orders.push(order);

    const orderItems = [];
    for (const item of items) {
      const oi = {
        id: store.next('order_items'),
        order_id: order.id,
        product_id: item.type === 'product' ? item.id : null,
        service_id: item.type === 'service' ? item.id : null,
        name: item.name, price: item.price, quantity: item.quantity, type: item.type,
      };
      db.order_items.push(oi);
      orderItems.push(oi);
      if (item.type === 'product') {
        const p = db.products.find(x => x.id === item.id);
        if (p) p.stock -= item.quantity;
      }
    }
    store.persist();
    res.status(201).json({ message: 'Pedido confirmado correctamente', order: { ...order, items: orderItems } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al crear pedido' });
  }
});

router.get('/orders', authenticate, (req, res) => {
  const db = store.get();
  let list = [...db.orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (req.user.role !== 'admin') list = list.filter(o => o.user_id === req.user.id);
  if (req.query.status) list = list.filter(o => o.status === req.query.status);
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const total = list.length;
  res.json({ orders: list.slice((page - 1) * limit, page * limit), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.get('/orders/:id', authenticate, (req, res) => {
  const db = store.get();
  const order = db.orders.find(o => o.id == req.params.id);
  if (!order) return res.status(404).json({ error: 'No encontrado' });
  if (req.user.role !== 'admin' && order.user_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
  const items = db.order_items.filter(i => i.order_id === order.id);
  res.json({ order: { ...order, items } });
});

router.put('/orders/:id/status', authenticate, requireAdmin, (req, res) => {
  const valid = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error: 'Estado inválido' });
  const order = store.get().orders.find(o => o.id == req.params.id);
  if (!order) return res.status(404).json({ error: 'No encontrado' });
  order.status = req.body.status;
  order.updated_at = new Date().toISOString();
  store.persist();
  res.json({ message: 'Estado actualizado', order });
});

// ========== USERS ==========
router.get('/users', authenticate, requireAdmin, (req, res) => {
  let list = store.get().users.map(({ password, ...u }) => u);
  if (req.query.role) list = list.filter(u => u.role === req.query.role);
  if (req.query.search) {
    const t = req.query.search.toLowerCase();
    list = list.filter(u => u.name.toLowerCase().includes(t) || u.email.toLowerCase().includes(t) || (u.dni || '').includes(t));
  }
  res.json({ users: list, pagination: { page: 1, limit: 100, total: list.length, pages: 1 } });
});

router.put('/users/:id', authenticate, requireAdmin, (req, res) => {
  const db = store.get();
  const user = db.users.find(u => u.id == req.params.id);
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  ['name', 'email', 'dni', 'role', 'phone', 'address'].forEach(f => {
    if (req.body[f] !== undefined) user[f] = req.body[f];
  });
  if (req.body.password) user.password = bcrypt.hashSync(req.body.password, 10);
  store.persist();
  const { password, ...safe } = user;
  res.json({ message: 'Actualizado', user: safe });
});

router.delete('/users/:id', authenticate, requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'No podés eliminarte a vos mismo' });
  const db = store.get();
  const i = db.users.findIndex(u => u.id == req.params.id);
  if (i < 0) return res.status(404).json({ error: 'No encontrado' });
  db.users.splice(i, 1);
  store.persist();
  res.json({ message: 'Eliminado' });
});

// ========== CONTACT ==========
router.post('/contact', async (req, res) => {
  const { name, email, phone, subject, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Nombre, email y mensaje obligatorios' });
  const db = store.get();
  db.contact_messages.push({
    id: store.next('contact_messages'), name, email, phone: phone || null, subject: subject || null,
    message, is_read: false, created_at: new Date().toISOString(),
  });
  store.persist();
  const result = await sendContactEmail({ name, email, phone, subject, message });
  res.status(201).json({ message: 'Mensaje enviado correctamente. Te responderemos a la brevedad.', email_sent: result.sent, ...(result.reason && { note: result.reason }) });
});

router.get('/contact', authenticate, requireAdmin, (req, res) => {
  let list = [...store.get().contact_messages].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (req.query.unread === 'true') list = list.filter(m => !m.is_read);
  res.json({ messages: list, pagination: { page: 1, limit: 50, total: list.length, pages: 1 } });
});

router.put('/contact/:id/read', authenticate, requireAdmin, (req, res) => {
  const m = store.get().contact_messages.find(x => x.id == req.params.id);
  if (m) { m.is_read = true; store.persist(); }
  res.json({ message: 'Marcado como leído' });
});

// ========== SETTINGS ==========
router.get('/settings', authenticate, requireAdmin, (req, res) => {
  res.json({ settings: store.get().settings || {} });
});

router.put('/settings', authenticate, requireAdmin, (req, res) => {
  const db = store.get();
  if (!db.settings) db.settings = {};
  const allowed = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'contact_to', 'store_name', 'store_phone', 'store_address', 'store_email'];
  allowed.forEach(k => { if (req.body[k] !== undefined) db.settings[k] = String(req.body[k]); });
  store.persist();
  res.json({ message: 'Configuración actualizada', settings: db.settings });
});

// ========== DASHBOARD ==========
router.get('/dashboard/stats', authenticate, requireAdmin, (req, res) => {
  const db = store.get();
  const productsCount = db.products.filter(p => p.is_active).length;
  const servicesCount = db.services.filter(s => s.is_active).length;
  const usersCount = db.users.filter(u => u.role === 'customer').length;
  const ordersCount = db.orders.length;
  const pendingOrders = db.orders.filter(o => ['pending', 'confirmed', 'processing'].includes(o.status)).length;
  const unreadMessages = db.contact_messages.filter(m => !m.is_read).length;
  const revenue = db.orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
  const recentOrders = [...db.orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
  const lowStock = db.products.filter(p => p.is_active && p.stock <= 5).sort((a, b) => a.stock - b.stock).slice(0, 10);

  res.json({
    stats: { productsCount, servicesCount, usersCount, ordersCount, pendingOrders, unreadMessages, revenue },
    recentOrders, lowStock, salesByMonth: [],
  });
});

module.exports = router;
