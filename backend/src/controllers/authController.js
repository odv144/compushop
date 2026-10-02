const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const repo = require('../data/repo');
const { generateToken } = require('../utils/jwt');
const { sendPasswordResetEmail } = require('../utils/email');

/**
 * Hash señuelo. Cuando el email no existe hay que comparar contra algo igual
 * de costoso que un bcrypt real: si seRespondiera de inmediato, el atacante
 * mide que la respuesta fue mas rapida y deduce que el usuario NO existe.
 * El mensaje es el mismo, pero el costo tiene que ser el mismo tambien.
 */
const DUMMY_HASH = '$2a$10$yjMOm8TFqInPHoJviaA8UOanEnbgbVQuai3lMwDI8PMRXI6cmHkVe';

async function register(req, res) {
  try {
    const { name, email, password, dni, phone, address } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son obligatorios' });
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    // Dos consultas separadas y no una de "insert que choca": el `users.email` es
    // un indice NO unICO a proposito (schema.sql), asi que la base no puede
    // resolver el duplicado por si sola. Ademas los mensajes tienen que quedar
    // EXACTAMENTE iguales: "ya esta registrado ese email" y "ya esta registrado
    // ese DNI", en ese orden, y no "el email ya existe" genérico.
    if (await repo.users.findByEmail(email)) return res.status(409).json({ error: 'El email ya está registrado' });
    if (dni && (await repo.users.findByDni(dni))) return res.status(409).json({ error: 'El DNI ya está registrado' });

    const user = await repo.users.create({
      name,
      email,
      password: await bcrypt.hash(password, 10),
      dni: dni || null,
      phone: phone || null,
      address: address || null,
      // `role` no se pasa: el default del INSERT es 'customer', igual que el
      // `role: 'customer'` hardcodeado de antes. Que el registro publico elija su
      // propio rol era justamente lo que se tenia que evitar.
    });
    const { password: _, ...safe } = user;
    res.status(201).json({ message: 'Usuario registrado correctamente', user: safe, token: generateToken(safe) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña son obligatorios' });

    const user = await repo.users.findByEmail(email);
    // Se compara SIEMPRE, exista o no el usuario, para que el tiempo de
    // respuesta no delate quais emails estan registrados.
    const ok = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const { password: _, ...safe } = user;
    res.json({ message: 'Login exitoso', user: safe, token: generateToken(safe) });
  } catch (e) {
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
}

/**
 * `try/catch` OBLIGATORIO, no opcional.
 *
 * Este handler quedo `async` cuando la lectura de usuario paso del store a
 * Postgres, y Express 4 NO agarra promesas rechazadas de un handler async: la
 * excepcion sale como unhandled rejection. Con Node >= 15 eso mata el proceso
 * entero, y en Vercel se lleva por delante la instancia. Sin este catch, un
 * hipo de la base en `/auth/me` no es un 500: es la app caida.
 *
 * `/auth/me` es el primer request que hace el frontend al cargar (valida la
 * sesion del localStorage), o sea que es la ruta con mas chances de pegarle el
 * primer error de conexion a un usuario que recien abre la app. Justamente la
 * que no puede colgarse.
 */
async function me(req, res) {
  try {
    const user = await repo.users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ user });
  } catch (e) {
    console.error('[auth] GET /auth/me fallo:', e.message);
    res.status(500).json({ error: 'Error al obtener el usuario' });
  }
}

async function forgotPassword(req, res) {
  try {
    const { dni, email } = req.body;
    if (!dni) return res.status(400).json({ error: 'El DNI es obligatorio' });

    const user = await repo.users.findByDni(dni);
    if (user && email && user.email !== email) {
      return res.status(400).json({ error: 'El email no coincide con el DNI registrado' });
    }

    if (!user) {
      return res.json({ message: 'Si el DNI existe en nuestros registros, recibirás un email con instrucciones.' });
    }

    await repo.passwordResets.invalidateAllForUser(user.id);
    const token = uuidv4();
    await repo.passwordResets.create({
      user_id: user.id,
      token,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    // `await` y no `.then()`: la funcion ya es async porque las consultas lo son.
    // Con el store, el `forEach` + `persist` eran sincronos y el `send` podia
    // terminar despues de responder. Ahora hay un `await` antes, y un `.then()`
    // sin catch seria una promesa sin manejar que tumba el proceso entero en vez
    // de dejar el 200.
    const result = await sendPasswordResetEmail(user, token);
    const response = { message: 'Si el DNI existe en nuestros registros, recibirás un email con instrucciones.' };
    // El token de reset solo puede filtrarse en desarrollo: en producción esto
    // permitiría resetear la contraseña de cualquier cuenta registrada.
    const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
    if (!isProd && !result.sent && result.token) {
      response.dev_token = result.token;
      response.dev_note = 'SMTP no configurado. Usá este token para probar.';
    }
    res.json(response);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
}

async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token y nueva contraseña son obligatorios' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const reset = await repo.passwordResets.findValidByToken(token);
    if (!reset) return res.status(400).json({ error: 'Token inválido o expirado' });

    const user = await repo.users.findById(reset.user_id);
    if (!user) return res.status(400).json({ error: 'Usuario no encontrado' });

    await repo.users.update(reset.user_id, { password: await bcrypt.hash(newPassword, 10) });

    // Invalida TODOS los resets del usuario, no solo este. Es mas amplio de lo que
    // hacia el store (`reset.used = true`), y a proposito: el contrato de
    // `repo.passwordResets` no tiene un "marcar este como usado" de un solo
    // token, y agregar un metodo para eso seria ampliar el contrato por un caso
    // que no se puede dar. No se puede dar porque `forgotPassword` YA invalida
    // los anteriores: hay a lo sumo UN reset sin usar por usuario, asi que
    // "invalidar todos" y "marcar este" tocan la misma fila. Y equivocarse de
    // direccion no puede hacer dano: invalidar de mas nunca habilita que se
    // reutilice un token, solo lo impide antes.
    await repo.passwordResets.invalidateAllForUser(reset.user_id);

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (e) {
    res.status(500).json({ error: 'Error al restablecer la contraseña' });
  }
}

module.exports = { register, login, me, forgotPassword, resetPassword };
