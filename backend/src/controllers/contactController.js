const db = require('../db/database');
const { sendContactEmail } = require('../utils/email');

// POST /api/contact
async function sendMessage(req, res) {
  try {
    const { name, email, phone, subject, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Nombre, email y mensaje son obligatorios' });
    }

    // Guardar siempre en DB
    db.prepare(`
      INSERT INTO contact_messages (name, email, phone, subject, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, email, phone || null, subject || null, message);

    // Intentar enviar email
    const result = await sendContactEmail({ name, email, phone, subject, message });

    res.status(201).json({
      message: 'Mensaje enviado correctamente. Te responderemos a la brevedad.',
      email_sent: result.sent,
      ...(result.reason && { note: result.reason }),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al enviar el mensaje' });
  }
}

// GET /api/contact (admin)
function getMessages(req, res) {
  try {
    const { unread, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = 'SELECT * FROM contact_messages WHERE 1=1';
    const params = [];

    if (unread === 'true') {
      sql += ' AND is_read = 0';
    }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
    const { total } = db.prepare(countSql).get(...params);

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const messages = db.prepare(sql).all(...params).map(m => ({
      ...m,
      is_read: !!m.is_read,
    }));

    res.json({
      messages,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
}

// PUT /api/contact/:id/read (admin)
function markAsRead(req, res) {
  try {
    const { id } = req.params;
    db.prepare('UPDATE contact_messages SET is_read = 1 WHERE id = ?').run(id);
    res.json({ message: 'Mensaje marcado como leído' });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar mensaje' });
  }
}

module.exports = { sendMessage, getMessages, markAsRead };
