const nodemailer = require('nodemailer');
const repo = require('../data/repo');

/**
 * Una clave de `settings`, con la precedencia de siempre: la tabla, y si esta
 * vacia o no existe, la env var con el nombre en mayusculas.
 *
 * `frontend_url` -> `FRONTEND_URL`, `smtp_host` -> `SMTP_HOST`. Ese fallback en
 * env es lo que hace que `vercel.json` pueda setear el host del link de reset sin
 * tocar la tabla.
 *
 * ---------------------------------------------------------------------------
 * POR QUE `settings` COMO PARAMETRO
 * ---------------------------------------------------------------------------
 * `getSetting` es async porque la tabla esta en PostgreSQL, y cada llamada a la
 * base va al pooler. Sin el parametro, armar un email leeria las settings cuatro
 * veces seguidas (host, port, user, pass) por un unico `sendMail`.
 *
 * Por eso hay DOS funciones y no una: `getSettingDe` es pura y sincronica, y
 * `getSetting` es la que carga la tabla. Cada envio carga UNA vez y despues pasa
 * el objeto. La sincrona es la que usan las llamadas internas; la async se
 * exporta para el `authController` y para tests, y es la que el guard de
 * architecture.test.js sigue reconociendo en `getSetting('frontend_url', ...)`.
 */
function getSettingDe(settings, key, def = '') {
  return settings[key] !== undefined && settings[key] !== '' ? settings[key] : (process.env[key.toUpperCase()] || def);
}

async function getSetting(key, def = '', settings = null) {
  return getSettingDe(settings || (await repo.settings.getAll()), key, def);
}

/**
 * `null` si no hay usuario y password de SMTP. Es lo que hace que `sendContactEmail`
 * responda `email_sent: false` con un motivo, en vez de intentar autenticarse con
 * credenciales vacias y tragarse un error de red.
 */
function createTransporter(settings) {
  const host = getSettingDe(settings, 'smtp_host', 'smtp.gmail.com');
  const port = parseInt(getSettingDe(settings, 'smtp_port', '587'), 10);
  const user = getSettingDe(settings, 'smtp_user', '');
  const pass = getSettingDe(settings, 'smtp_pass', '');
  if (!user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

async function sendContactEmail({ name, email, phone, subject, message }) {
  const settings = await repo.settings.getAll();
  const transporter = createTransporter(settings);
  const to = getSettingDe(settings, 'contact_to', 'contacto@compushop.com');
  const from = getSettingDe(settings, 'smtp_from', 'Compushop <noreply@compushop.com>');
  if (!transporter) {
    console.warn('⚠️  SMTP no configurado. Mensaje guardado pero no enviado.');
    return { sent: false, reason: 'SMTP no configurado' };
  }
  try {
    await transporter.sendMail({
      from, to, replyTo: email,
      subject: `[Contacto Compushop] ${subject || 'Nuevo mensaje'}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px"><h2 style="color:#1a365d">Nuevo mensaje de contacto</h2>
        <p><b>Nombre:</b> ${name}</p><p><b>Email:</b> ${email}</p>
        <p><b>Teléfono:</b> ${phone || 'No indicado'}</p><p><b>Asunto:</b> ${subject || 'Sin asunto'}</p><hr/>
        <p style="white-space:pre-wrap">${message}</p></div>`,
    });
    return { sent: true };
  } catch (e) {
    console.error('Error email:', e.message);
    return { sent: false, reason: e.message };
  }
}

async function sendPasswordResetEmail(user, token) {
  const settings = await repo.settings.getAll();
  const transporter = createTransporter(settings);
  const from = getSettingDe(settings, 'smtp_from', 'Compushop <noreply@compushop.com>');
  if (!transporter) {
    console.warn('⚠️  SMTP no configurado.');
    return { sent: false, token };
  }
  // El token se lee en /reset-password (ver frontend App.jsx), no en /recuperar-clave.
  // getSetting ya resuelve FRONTEND_URL desde env; el default cubre desarrollo local.
  const baseUrl = await getSetting('frontend_url', 'http://localhost:5173', settings);
  const resetUrl = `${baseUrl.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await transporter.sendMail({
      from, to: user.email,
      subject: 'Recuperación de contraseña - Compushop',
      html: `<div style="font-family:Arial,sans-serif;max-width:600px"><h2 style="color:#1a365d">Recuperación de contraseña</h2>
        <p>Hola ${user.name},</p><p>Hacé clic para restablecer tu contraseña:</p>
        <p><a href="${resetUrl}" style="background:#3182ce;color:white;padding:12px 24px;text-decoration:none;border-radius:6px">Restablecer contraseña</a></p>
        <p>Expira en 1 hora. Si no solicitaste esto, ignorá el correo.</p></div>`,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message, token };
  }
}

module.exports = { sendContactEmail, sendPasswordResetEmail, getSetting, getSettingDe };
