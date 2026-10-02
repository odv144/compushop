/**
 * Rate limiting por IP para los endpoints publicos.
 *
 * Por que importa: `bcrypt.compareSync` bloquea el event loop mientras
 * verifica. Un atacante que mande N logins simultaneos no solo queman sus
 * propias cuentas: cuelgan el server para todos los usuarios. El rate limit
 * es la primera linea; la segunda es el bcrypt async (ver authController).
 *
 * Los limites cuentan por IP. `ipKeyGenerator` agrupa IPv6 en /64 para que
 * un cliente con rango de IPv6 no pueda rotar direcciones y evadirlos.
 */
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * En los tests hay que poder loguearse muchas veces seguidas, asi que los
 * limitadores no aplican (ver `skip` en createLimiter). Sigue siendo posible
 * testear el comportamiento real pasando `skip: () => false`.
 */
const isTest = process.env.NODE_ENV === 'test';

/**
 * Fabrica un limitador. Los mensajes van en español y son genericos: no
 * dicen si el login fue correcto, solo que hay que esperar.
 */
function createLimiter({
  name,
  windowMs,
  max,
  skipSuccessfulRequests = false,
  message = 'Demasiados intentos. Intentá de nuevo en unos minutos.',
  // Por defecto el limitador no aplica en tests. Los tests que necesitan
  // verificar el comportamiento real pasan `skip: () => false`.
  skip,
} = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    // OJO: en express-rate-limit v8 la opcion se llama `identifier`.
    // `name` fue eliminada y hace lanzar ERR_ERL_UNKNOWN_OPTION.
    identifier: name,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    message: { error: message },
    skip: skip || (() => isTest),
  });
}

/**
 * Limites por endpoint, como datos puros. Se exportan para poder testearlos
 * directamente: leer `max` de un limitador ya construido no esta soportado por
 * la libreria.
 *
 * `auth` cuenta solo intentos FALLIDOS (skipSuccessfulRequests). Un usuario que
 * se equivoca tres veces y entra bien no queda penalizado; uno que prueba mil
 * passwords queda cortado.
 */
const LIMITS = {
  auth: { windowMs: 15 * MINUTE, max: 10, skipSuccessfulRequests: true },
  register: { windowMs: HOUR, max: 5 },
  'forgot-password': { windowMs: HOUR, max: 5 },
  'reset-password': { windowMs: HOUR, max: 10 },
  contact: { windowMs: HOUR, max: 5 },
  orders: { windowMs: HOUR, max: 20 },
  'api-global': { windowMs: 15 * MINUTE, max: 600 },
};

const MESSAGES = {
  auth: 'Demasiados intentos fallidos de acceso. Esperá 15 minutos.',
};

function build(name) {
  const spec = LIMITS[name];
  if (!spec) throw new Error(`Limite de rate limiting desconocido: "${name}"`);
  return createLimiter({
    name,
    windowMs: spec.windowMs,
    max: spec.max,
    skipSuccessfulRequests: spec.skipSuccessfulRequests || false,
    message: MESSAGES[name] || 'Demasiados intentos. Intentá de nuevo en unos minutos.',
  });
}

const authLimiter = () => build('auth');
const registerLimiter = () => build('register');
const forgotPasswordLimiter = () => build('forgot-password');
const resetPasswordLimiter = () => build('reset-password');
const contactLimiter = () => build('contact');
const orderLimiter = () => build('orders');
const globalLimiter = () => build('api-global');

module.exports = {
  MINUTE,
  HOUR,
  LIMITS,
  createLimiter,
  authLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  contactLimiter,
  orderLimiter,
  globalLimiter,
  isTest,
};
