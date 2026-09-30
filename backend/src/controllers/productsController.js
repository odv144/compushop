const db = require('../db/database');

function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-');
}

// GET /api/products
function getAll(req, res) {
  try {
    const { category, search, active, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = `
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (active !== 'all') {
      sql += ' AND p.is_active = 1';
    }

    if (category) {
      sql += ' AND c.slug = ?';
      params.push(category);
    }

    if (search) {
      sql += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.brand LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    // Count
    const countSql = sql.replace(/SELECT p\.\*, c\.name as category_name, c\.slug as category_slug/, 'SELECT COUNT(*) as total');
    const { total } = db.prepare(countSql).get(...params);

    sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const products = db.prepare(sql).all(...params);

    // Parse specs
    const result = products.map(p => ({
      ...p,
      specs: p.specs ? JSON.parse(p.specs) : null,
      is_active: !!p.is_active,
    }));

    res.json({
      products: result,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
}

// GET /api/products/:id or /api/products/slug/:slug
function getOne(req, res) {
  try {
    const { id } = req.params;
    let product;

    if (isNaN(id)) {
      product = db.prepare(`
        SELECT p.*, c.name as category_name, c.slug as category_slug
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.slug = ?
      `).get(id);
    } else {
      product = db.prepare(`
        SELECT p.*, c.name as category_name, c.slug as category_slug
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.id = ?
      `).get(id);
    }

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    product.specs = product.specs ? JSON.parse(product.specs) : null;
    product.is_active = !!product.is_active;

    res.json({ product });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
}

// POST /api/products (admin)
function create(req, res) {
  try {
    const { name, description, price, stock, category_id, brand, image, specs, is_active = 1 } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
    }

    let slug = slugify(name);
    // Asegurar unicidad
    const existing = db.prepare('SELECT id FROM products WHERE slug = ?').get(slug);
    if (existing) {
      slug = `${slug}-${Date.now()}`;
    }

    const result = db.prepare(`
      INSERT INTO products (name, slug, description, price, stock, category_id, brand, image, specs, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      slug,
      description || null,
      price,
      stock || 0,
      category_id || null,
      brand || null,
      image || null,
      specs ? JSON.stringify(specs) : null,
      is_active ? 1 : 0
    );

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    product.specs = product.specs ? JSON.parse(product.specs) : null;

    res.status(201).json({ message: 'Producto creado', product });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear producto' });
  }
}

// PUT /api/products/:id (admin)
function update(req, res) {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const {
      name = existing.name,
      description = existing.description,
      price = existing.price,
      stock = existing.stock,
      category_id = existing.category_id,
      brand = existing.brand,
      image = existing.image,
      specs = existing.specs ? JSON.parse(existing.specs) : null,
      is_active = existing.is_active,
    } = req.body;

    let slug = existing.slug;
    if (name !== existing.name) {
      slug = slugify(name);
      const conflict = db.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').get(slug, id);
      if (conflict) slug = `${slug}-${id}`;
    }

    db.prepare(`
      UPDATE products SET
        name = ?, slug = ?, description = ?, price = ?, stock = ?,
        category_id = ?, brand = ?, image = ?, specs = ?, is_active = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name, slug, description, price, stock,
      category_id, brand, image,
      specs ? JSON.stringify(specs) : null,
      is_active ? 1 : 0,
      id
    );

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    product.specs = product.specs ? JSON.parse(product.specs) : null;

    res.json({ message: 'Producto actualizado', product });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
}

// DELETE /api/products/:id (admin)
function remove(req, res) {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    res.json({ message: 'Producto eliminado' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
}

module.exports = { getAll, getOne, create, update, remove };
