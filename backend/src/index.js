require('dotenv').config();
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { buildCorsConfig, isOriginAllowed } = require('./config/cors');
const rateLimit = require('./config/rateLimit');

const app = express();
const PORT = process.env.PORT || 4000;

// En Vercel (y detras de cualquier proxy) req.ip seria la IP del proxy para
// TODAS las requests. Sin esto, el rate limit por IP seria inutil: bastaria
// con que un solo usuario se bloqueara a si mismo para tumbar la API entera.
//
// TRUST_PROXY = cantidad de proxies confiables (Vercel pone 1). Si el server
// se expone DIRECTO a internet sin proxy, poner 0: con 1, un cliente podria
//MANDAR un X-Forwarded-For falso y evadir los limites por IP.
const trustProxy = process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) : 1;
if (Number.isFinite(trustProxy) && trustProxy > 0) {
  app.set('trust proxy', trustProxy);
}

// Allowlist explicita. No hay comodin de *.vercel.app: cualquier subdominio
// de Vercel podria llamar a la API. Los preview deployments se habilitan a
// proposito con ALLOWED_ORIGIN_PATTERNS.
const corsConfig = buildCorsConfig(process.env);

// Middleware de rechazo: CORS por si solo solo impide LEER la respuesta; el
// request igual se ejecuta. Como hay endpoints publicos con efecto (POST
// /orders, POST /contact), un origen no permitido se corta con 403 antes de
// hacer trabajo.
function corsGuard(req, res, next) {
  const { allowed, reason } = isOriginAllowed(req.headers.origin, corsConfig);
  if (allowed) return next();

  console.warn(`CORS bloqueado (${reason}): ${req.headers.origin}`);
  return res.status(403).json({ error: 'Origen no permitido' });
}

app.use(corsGuard);

app.use(cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin, corsConfig).allowed) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
}));

// ===========================================================================
// KEEP-WARM: SIEMPRE MONTADO, EL LIMITADOR GLOBAL SOLO EN PRODUCCION
// ===========================================================================
// Son dos decisiones separadas y por eso NO van en el mismo if.
//
// (1) El keep-warm se registra SIEMPRE, sin condiciones. La version anterior lo
//     metio dentro del `else` de `if (rateLimit.isTest)`, o sea que con
//     NODE_ENV=test la ruta NO existia. Los tests igual pasaban porque el unico
//     archivo que lo cubria importaba el handler y lo llamaba directo: se
//     probaba la logica, no que el endpoint estuviera montado. Un endpoint que
//     solo se prueba importando su handler no esta probado.
//
// (2) El limitador global se registra SOLO fuera de tests, para que los tests
//     puedan hacer muchos requests sin toparse el limite.
//
// (3) El keep-warm va ANTES del limiter a proposito. Si el limiter corriera
//     primero, sus 429 taparian los 503/401 del endpoint y no habria forma de
//     distinguir "la base esta caida" de "alguien esta abusando".
//
// TRADEOFF (lo que se paga por (1)+(3)): el endpoint queda fuera del limite
// global, en cualquier entorno. Se acepta porque exige
// `Authorization: Bearer <CRON_SECRET>`, sin secreto configurado responde 503
// sin tocar la base, y con secreto equivocado responde 401 sin tocar la base
// (ver api/health/keep-warm.js). O sea que el costo de dejarlo sin limite es
// un request de diagnostico por corrida del cron, contra el beneficio de que el
// diagnostico exista. Si alguna vez esto dejara de ser cierto (endpoint publico,
// query sin autenticar), la respuesta es moverlo DETRAS del limiter y aceptar
// perder el 503 limpio, noSACARLE el limite.
const keepWarmHandler = require('../api/health/keep-warm');
app.all('/api/health/keep-warm', keepWarmHandler);

if (!rateLimit.isTest) {
  app.use('/api', rateLimit.globalLimiter());
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api', routes);

app.get('/', (req, res) => {
  res.json({ name: 'Compushop API', version: '1.0.0', status: 'ok' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

// Vercel serverless: exportar app; local: listen
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`🚀 Compushop API corriendo en http://localhost:${PORT}`);
  });
  module.exports = app;
}
