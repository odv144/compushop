const bcrypt = require('bcryptjs');
const db = require('../db/database');

// GET /api/users (admin)
function getAll(req, res) {
  try {
    const { role, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = 'SELECT id, name, email, dni, role, phone, address, created_at FROM users WHERE 1=1';
    const params = [];

    if (role) {
      sql += ' AND role = ?';
      params.push(role);
    }
    if (search) {
      sql += ' AND (name LIKE ? OR email LIKE ? OR dni LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    const countSql = sql.replace(/SELECT .+ FROM/, 'SELECT COUNT(*) as total FROM');
    const { total } = db.prepare(countSql).get(...params);

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const users = db.prepare(sql).all(...params);
    res.json({
      users,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
}

// PUT /api/users/:id (admin)
function update(req, res) {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

    const {
      name = existing.name,
      email = existing.email,
      dni = existing.dni,
      role = existing.role,
      phone = existing.phone,
      address = existing.address,
      password,
    } = req.body;

    if (role && !['admin', 'customer'].includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    if (password) {
      const hashed = bcrypt.hashSync(password, 10);
      db.prepare(`
        UPDATE users SET name=?, email=?, dni=?, role=?, phone=?, address=?, password=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(name, email, dni, role, phone, address, hashed, id);
    } else {
      db.prepare(`
        UPDATE users SET name=?, email=?, dni=?, role=?, phone=?, address=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(name, email, dni, role, phone, address, id);
    }

    const user = db.prepare('SELECT id, name, email, dni, role, phone, address, created_at FROM users WHERE id = ?').get(id);
    res.json({ message: 'Usuario actualizado', user });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Email o DNI ya existe' });
    }
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
}

// DELETE /api/users/:id (admin)
function remove(req, res) {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'No podés eliminarte a vos mismo' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ message: 'Usuario eliminado' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
}

module.exports = { getAll, update, remove };
