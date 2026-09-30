const db = require('../db/database');

// GET /api/settings (admin)
function getAll(req, res) {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
}

// PUT /api/settings (admin)
function update(req, res) {
  try {
    const data = req.body;
    const allowed = [
      'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'contact_to',
      'store_name', 'store_phone', 'store_address', 'store_email',
    ];

    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);

    const transaction = db.transaction(() => {
      for (const key of allowed) {
        if (data[key] !== undefined) {
          upsert.run(key, String(data[key]));
        }
      }
    });

    transaction();

    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });

    res.json({ message: 'Configuración actualizada', settings });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar configuración' });
  }
}

module.exports = { getAll, update };
