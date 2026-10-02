const crypto = require('crypto');
const poolModule = require('../../src/data/postgres/pool');

function safeEqual(expected, provided) {
  if (!expected || !provided) {
    return false;
  }
  const b1 = Buffer.from(expected, 'utf8');
  const b2 = Buffer.from(provided, 'utf8');
  if (b1.length !== b2.length) {
    // Longitud distinta: no comparar con timingSafeEqual (lanzaría). Devuelve false explícito.
    return false;
  }
  try {
    return crypto.timingSafeEqual(b1, b2);
  } catch (err) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  const secretEnv = process.env.CRON_SECRET;
  // 1) Sin CRON_SECRET configurado → 503 y CERO queries
  if (!secretEnv || !secretEnv.length) {
    return res.status(503).json({ ok: false, error: 'keep-warm not configured' });
  }

  // 2) Validar Authorization: Bearer <secret> con timingSafeEqual
  let provided = null;
  if (req && req.headers) {
    const auth = req.headers.authorization || req.headers.Authorization;
    if (auth && auth.startsWith('Bearer ')) {
      provided = auth.slice('Bearer '.length).trim();
    }
  }
  if (!safeEqual(secretEnv, provided)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // 3) Secreto correcto: verificar base con preflight() (sin catch → 500 si falla)
  try {
    await poolModule.preflight();
  } catch (err) {
    // Log server-side SOLO con err.code (ECONNREFUSED, ENOTFOUND, 57P01...).
    // NUNCA err.message: pg mete host/user/db del DSN adentro del mensaje, y
    // este endpoint responde a un caller remoto. Al cliente solo un 500 genérico.
    console.error('[keep-warm] preflight fallo:', err && err.code ? err.code : 'sin code');
    return res.status(500).json({ ok: false, error: 'db unreachable' });
  }

  // 4) OK
  return res.status(200).json({ ok: true });
};
