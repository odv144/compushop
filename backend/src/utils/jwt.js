const jwt = require('jsonwebtoken');

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

// En producción no hay fallback: una clave por defecto significa que cualquiera
// puede firmar un token admin. Fallar al arrancar es preferible a fallar abierto.
if (IS_PROD && !process.env.JWT_SECRET) {
  throw new Error(
    'JWT_SECRET es obligatorio en producción. Configuralo en las variables de entorno antes de desplegar.'
  );
}

const JWT_SECRET = process.env.JWT_SECRET || 'compushop_secret_dev_only';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
  );
}

function verifyToken(token) {
  // algorithms fijado explícitamente: rechaza 'none' y cualquier alg distinto.
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

module.exports = { generateToken, verifyToken };
