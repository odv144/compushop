const nodemailer = require('nodemailer');
const store = require('../db/store');

function getSetting(key, def = '') {
  const s = store.get().settings || {};
  return s[key] !== undefined && s[key] !== '' ? s[key] : (process.env[key.toUpperCase()] || def);
}

function createTransporter() {
  const host = getSetting('smtp_host', 'smtp.gmail.com');
  const port = parseInt(getSetting('smtp_port', '587'), 10);
  const user = getSetting('smtp_user', '');
  const pass = getSetting('smtp_pass', '');
  if (!user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

async function sendContactEmail({ name, email, phone, subject, message }) {
  const transporter = createTransporter();
  const to = getSetting('contact_to', 'contacto@compushop.com');
  const from = getSetting('smtp_from', 'Compushop <noreply@compushop.com>');
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
  const transporter = createTransporter();
  const from = getSetting('smtp_from', 'Compushop <noreply@compushop.com>');
  if (!transporter) {
    console.warn('⚠️  SMTP no configurado.');
    return { sent: false, token };
  }
  const resetUrl = `http://localhost:5173/recuperar-clave?token=${token}`;
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

module.exports = { sendContactEmail, sendPasswordResetEmail, getSetting };
