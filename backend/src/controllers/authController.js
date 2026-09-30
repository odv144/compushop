const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const store = require('../db/store');
const { generateToken } = require('../utils/jwt');
const { sendPasswordResetEmail } = require('../utils/email');

function register(req, res) {
  try {
    const { name, email, password, dni, phone, address } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son obligatorios' });
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const db = store.get();
    if (db.users.find(u => u.email === email)) return res.status(409).json({ error: 'El email ya está registrado' });
    if (dni && db.users.find(u => u.dni === dni)) return res.status(409).json({ error: 'El DNI ya está registrado' });

    const user = {
      id: store.next('users'),
      name, email,
      password: bcrypt.hashSync(password, 10),
      dni: dni || null, role: 'customer',
      phone: phone || null, address: address || null,
      created_at: new Date().toISOString(),
    };
    db.users.push(user);
    store.persist();

    const { password: _, ...safe } = user;
    res.status(201).json({ message: 'Usuario registrado correctamente', user: safe, token: generateToken(safe) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
}

function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña son obligatorios' });

    const user = store.get().users.find(u => u.email === email);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const { password: _, ...safe } = user;
    res.json({ message: 'Login exitoso', user: safe, token: generateToken(safe) });
  } catch (e) {
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
}

function me(req, res) {
  const user = store.get().users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { password, ...safe } = user;
  res.json({ user: safe });
}

function forgotPassword(req, res) {
  try {
    const { dni, email } = req.body;
    if (!dni) return res.status(400).json({ error: 'El DNI es obligatorio' });

    const db = store.get();
    const user = db.users.find(u => u.dni === dni);
    if (user && email && user.email !== email) {
      return res.status(400).json({ error: 'El email no coincide con el DNI registrado' });
    }

    if (!user) {
      return res.json({ message: 'Si el DNI existe en nuestros registros, recibirás un email con instrucciones.' });
    }

    db.password_resets.forEach(r => { if (r.user_id === user.id) r.used = true; });
    const token = uuidv4();
    db.password_resets.push({
      id: store.next('password_resets'),
      user_id: user.id,
      token,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      used: false,
      created_at: new Date().toISOString(),
    });
    store.persist();

    sendPasswordResetEmail(user, token).then(result => {
      const response = { message: 'Si el DNI existe en nuestros registros, recibirás un email con instrucciones.' };
      // El token de reset solo puede filtrarse en desarrollo: en producción esto
      // permitiría resetear la contraseña de cualquier cuenta registrada.
      const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
      if (!isProd && !result.sent && result.token) {
        response.dev_token = result.token;
        response.dev_note = 'SMTP no configurado. Usá este token para probar.';
      }
      res.json(response);
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
}

function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token y nueva contraseña son obligatorios' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const db = store.get();
    const reset = db.password_resets.find(r => r.token === token && !r.used && new Date(r.expires_at) > new Date());
    if (!reset) return res.status(400).json({ error: 'Token inválido o expirado' });

    const user = db.users.find(u => u.id === reset.user_id);
    if (!user) return res.status(400).json({ error: 'Usuario no encontrado' });

    user.password = bcrypt.hashSync(newPassword, 10);
    reset.used = true;
    store.persist();

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (e) {
    res.status(500).json({ error: 'Error al restablecer la contraseña' });
  }
}

module.exports = { register, login, me, forgotPassword, resetPassword };
