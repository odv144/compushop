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

function getAll(req, res) {
  try {
    const { active } = req.query;
    let sql = 'SELECT * FROM services WHERE 1=1';
    if (active !== 'all') {
      sql += ' AND is_active = 1';
    }
    sql += ' ORDER BY created_at DESC';

    const services = db.prepare(sql).all().map(s => ({
      ...s,
      is_active: !!s.is_active,
    }));

    res.json({ services });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener servicios' });
  }
}

function getOne(req, res) {
  try {
    const { id } = req.params;
    let service;

    if (isNaN(id)) {
      service = db.prepare('SELECT * FROM services WHERE slug = ?').get(id);
    } else {
      service = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    }

    if (!service) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    service.is_active = !!service.is_active;
    res.json({ service });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener servicio' });
  }
}

function create(req, res) {
  try {
    const { name, description, price, duration, image, is_active = 1 } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
    }

    let slug = slugify(name);
    const existing = db.prepare('SELECT id FROM services WHERE slug = ?').get(slug);
    if (existing) slug = `${slug}-${Date.now()}`;

    const result = db.prepare(`
      INSERT INTO services (name, slug, description, price, duration, image, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, slug, description || null, price, duration || null, image || null, is_active ? 1 : 0);

    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ message: 'Servicio creado', service });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear servicio' });
  }
}

function update(req, res) {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    const {
      name = existing.name,
      description = existing.description,
      price = existing.price,
      duration = existing.duration,
      image = existing.image,
      is_active = existing.is_active,
    } = req.body;

    let slug = existing.slug;
    if (name !== existing.name) {
      slug = slugify(name);
      const conflict = db.prepare('SELECT id FROM services WHERE slug = ? AND id != ?').get(slug, id);
      if (conflict) slug = `${slug}-${id}`;
    }

    db.prepare(`
      UPDATE services SET
        name = ?, slug = ?, description = ?, price = ?, duration = ?, image = ?, is_active = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, slug, description, price, duration, image, is_active ? 1 : 0, id);

    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    res.json({ message: 'Servicio actualizado', service });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar servicio' });
  }
}

function remove(req, res) {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT id FROM services WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }
    db.prepare('DELETE FROM services WHERE id = ?').run(id);
    res.json({ message: 'Servicio eliminado' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar servicio' });
  }
}

module.exports = { getAll, getOne, create, update, remove };
