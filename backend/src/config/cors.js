/**
 * Configuracion de CORS.
 *
 * Se separa en un modulo propio (y en funciones puras) para poder testearlo
 * sin levantar el server: el allowlist es la frontera de seguridad entre el
 * navegador y la API, y un error ahi es silencioso en desarrollo y
 * explotivo en produccion.
 */

// Origenes de desarrollo. Vite usa 5173, su preview 4173, CRA 3000.
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4173',
];

// Dominio de produccion. Es el unico subdominio de Vercel permitido por
// defecto; cualquier otro requiere opting in explicito por env.
const PROD_ORIGIN = 'https://compushop-dun.vercel.app';

const splitList = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Compone la configuracion de CORS desde el entorno.
 *
 * FRONTEND_URL y ALLOWED_ORIGINS aceptan listas separadas por coma.
 * ALLOWED_ORIGIN_PATTERNS acepta regex, y viene VACIA por defecto: no hay
 * ningun comodin activo salvo que el operador lo pida a proposito.
 */
function buildCorsConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production' || !!env.VERCEL;

  // FRONTEND_URL puede venir apuntando a localhost (un .env de desarrollo
  // copiado tal cual). En produccion eso no aporta nada y solo abre
  // superficie, asi que se descarta con un warning en vez de confiar en que
  // el operador configuro bien.
  const fromEnv = [...splitList(env.FRONTEND_URL), ...splitList(env.ALLOWED_ORIGINS)];
  const envOrigins = fromEnv.filter((o) => {
    if (!isProd) return true;
    if (DEV_ORIGINS.includes(o)) {
      console.warn(`CORS: "${o}" es un origen de desarrollo y se ignora en produccion.`);
      return false;
    }
    return true;
  });

  const allowed = new Set(
    [
      ...(!isProd ? DEV_ORIGINS : []),
      PROD_ORIGIN,
      ...envOrigins,
    ].filter(Boolean)
  );

  // En produccion, localhost: no aporta nada y solo abre superficie.
  const patterns = splitList(env.ALLOWED_ORIGIN_PATTERNS).map((p) => {
    try {
      return new RegExp(p);
    } catch {
      console.warn(`ALLOWED_ORIGIN_PATTERNS: regex inválido ignorado -> ${p}`);
      return null;
    }
  }).filter(Boolean);

  return {
    allowedOrigins: [...allowed],
    allowedPatterns: patterns,
    // Trazabilidad: deja claro en el env cual es la config de produccion.
    isProd,
  };
}

/**
 * Decide si un Origin puede llamar a la API.
 *
 * Sin header Origin (curl, healthchecks, server-to-server) se permite: CORS
 * es un mecanismo de navegador y esas llamadas no lo incluyen.
 */
function isOriginAllowed(origin, config) {
  if (!origin) return { allowed: true, reason: 'sin-origin' };

  if (config.allowedOrigins.includes(origin)) {
    return { allowed: true, reason: 'allowlist' };
  }

  for (const re of config.allowedPatterns) {
    if (re.test(origin)) return { allowed: true, reason: `patron:${re.source}` };
  }

  return { allowed: false, reason: 'no-allowlisted' };
}

module.exports = { buildCorsConfig, isOriginAllowed, DEV_ORIGINS, PROD_ORIGIN };
