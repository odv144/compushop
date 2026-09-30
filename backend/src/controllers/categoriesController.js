const db = require('../db/database');

function getAll(req, res) {
  try {
    const categories = db.prepare(`
      SELECT c.*, COUNT(p.id) as product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1
      GROUP BY c.id
      ORDER BY c.name
    `).all();
    res.json({ categories });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener categorías' });
  }
}

function create(req, res) {
  try {
    const { name, description, image } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre obligatorio' });

    const slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '-')
      .replace(/[^\w-]+/g, '');

    const result = db.prepare(
      'INSERT INTO categories (name, slug, description, image) VALUES (?, ?, ?, ?)'
    ).run(name, slug, description || null, image || null);

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ message: 'Categoría creada', category });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    }
    console.error(error);
    res.status(500).json({ error: 'Error al crear categoría' });
  }
}

function update(req, res) {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Categoría no encontrada' });

    const { name = existing.name, description = existing.description, image = existing.image } = req.body;

    db.prepare(
      'UPDATE categories SET name = ?, description = ?, image = ? WHERE id = ?'
    ).run(name, description, image, id);

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    res.json({ message: 'Categoría actualizada', category });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar categoría' });
  }
}

function remove(req, res) {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Categoría no encontrada' });

    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    res.json({ message: 'Categoría eliminada' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar categoría' });
  }
}

module.exports = { getAll, create, update, remove };
