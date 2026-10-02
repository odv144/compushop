/**
 * Pool de PostgreSQL (Supabase / Supavisor, transaction mode).
 *
 * Decisiones que NO son negociables y estan verificadas contra la base real
 * (ver sdd/migrate-store-to-postgres/addenda-4 y addenda-5 en Engram):
 *
 *  - `max: 1`. Vercel corre multiples instancias warm; cada una abre su propia
 *    conexion. Un pool por instancia multiplica contra el limite del pooler.
 *    El cliente es nuestro y se comparte entre invocaciones de la misma
 *    instancia, asi que max:1 limita la INSTANCIA, no el request.
 *
 *  - Transaction mode NO preserva estado de sesion. Todo lo que dependa de
 *    sesion (SET, locks, tablas temporales) muere entre transacciones. Por eso
 *    no hay estado a nivel de pool: cada operacion toma un client, trabaja, y lo
 *    devuelve. Y las transacciones se piden explicitamente con `withTransaction`.
 *
 *  - Prepared statements: PgBouncer los acepta, pero no aportan nada aca y
 *    agregan fragilidad (el statement se pierde si Supavisor recicla la
 *    conexion del servidor). Prohibido usar `{ name }` en cualquier query.
 *    Guard en tests/architecture.test.js.
 *
 *  - `ssl`: si hay CA cargada se VERIFICA la cadena. Sin CA solo se permite
 *    desarrollo, y en produccion el boot falla. Verificar es el default:
 *    `rejectUnauthorized: false` es una baja de verificacion permanente e
 *    invisible que ademas no previene MITM, solo lo hace silencioso.
 *
 *  - La password del usuario va percent-encoded en la URL. Una password que
 *    empieza con `@` corta el parseo del hostname y el error parece de
 *    credenciales. Ver D-09.
 */
const { Pool, types } = require('pg');

// numeric(14,2) -> number, no string. Sin esto toda la aritmetica de precios
// concatenaria strings y el redondeo del servidor seria invisible.
// OJO: es estado GLOBAL del modulo. Hay que setearlo antes de cualquier query,
// y por eso vive aca y no en el repo.
types.setTypeParser(1700, Number);

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL no esta definida. No hay fallback a data.json: la app falla ' +
    'explicitamente antes de atender un request con datos stale.'
  );
}

// Normalizacion del PEM. Localmente `dotenv` parsea el .env y expande los
// `\n` de un valor entre comillas dobles, asi que la CA llega con newlines
// reales. En Vercel NO: las env vars se leen crudas de process.env y nunca
// pasan por dotenv, asi que un valor copiado de .env.example llega como una
// unica linea con `\n` literales y `pg` rechaza el certificado. Depender de
// COMO se cargo la variable hacia que el deploy funcione o no, asi que se
// normaliza aca y las dos vias dan exactamente lo mismo.
const rawCa = process.env.SUPABASE_CA_CERT;
const ca = rawCa ? String(rawCa).replace(/\\n/g, '\n').trim() : undefined;
const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

let ssl;
if (ca) {
  // Fallar temprano y con un mensaje util. Sin esto el error real aparece
  // adentro de pg/TLS en el primer query, como un fallo de conexion que no
  // dice nada de la CA.
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) {
    throw new Error(
      'SUPABASE_CA_CERT no parece un PEM valido (faltan los marcadores BEGIN/END ' +
      'o el cuerpo base64 esta incompleto). Revisala en el dashboard de Vercel.'
    );
  }
  ssl = { ca, rejectUnauthorized: true };
} else if (isProd) {
  throw new Error(
    'SUPABASE_CA_CERT no esta definida y estamos en produccion. Sin CA la ' +
    'conexion no verifica el servidor. Descargala de Supabase > Database > ' +
    'Settings > Download Certificate y cargala como env var con el PEM completo.'
  );
} else {
  ssl = { rejectUnauthorized: false };
  console.warn(
    '[db] SUPABASE_CA_CERT ausente: conectando SIN verificar el certificado. ' +
    'Solo aceptable en desarrollo.'
  );
}

// `sslmode` / `sslrootcert` en la connection string son parametros de libpq.
// `pg` los ignora en silencio. Si alguien los pone, cree que verifica y no
// verifica. No ponerlos: el objeto `ssl` de arriba es la unica via.
if (/sslmode=|sslrootcert=/i.test(connectionString)) {
  throw new Error(
    'La connection string contiene sslmode o sslrootcert. Son parametros de ' +
    'libpq y `pg` los ignora: la verificacion NO estaria activa. Configura el ' +
    'objeto `ssl` de este archivo o la env var SUPABASE_CA_CERT.'
  );
}

const pool = new Pool({
  connectionString,
  ssl,
  max: 1,
  connectionTimeoutMillis: 10000,
  // Serverless congela la instancia entre requests y el socket queda congelado.
  // Con max:1 ese socket es el unico recurso: si muere, la instancia queda
  // inservible hasta que cierre el timeout. Sintoma a reconocer: CONNECT_TIMEOUT.
  idleTimeoutMillis: 10000,
  allowExitOnIdle: true,
});

pool.on('error', (err) => {
  // Un error en cliente idle (red, pooler reiniciado) no debe tirar el proceso.
  // En Vercel, un crash por esto mata la instancia entera.
  console.error('[db] error en cliente idle del pool:', err.message);
});

/**
 * Prende una conexion logica. `fn` recibe un client de `pg`.
 * Hace COMMIT si `fn` resuelve, ROLLBACK si tira.
 *
 * El client SIEMPRE vuelve al pool, incluso si la transaccion quedo abortada:
 * sin el rollback explicito una exception en `fn` deja la conexion en estado
 * aborted y el siguiente query del pool falla con "current transaction is
 * aborted".
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] ROLLBACK fallo:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Prende una conexion sin transaccion. Para lecturas y para operaciones que ya
 * son atomicas por si mismas (un unico INSERT, un unico UPDATE).
 */
async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Preflight. `SELECT 1` sin catch: si la DB no esta, el error tiene que subir
 * con su causa real, no esconderse detrás de un `skip()` que hace pasar la
 * suite en verde sobre una base inexistente.
 */
async function preflight() {
  const r = await withClient((c) => c.query('select 1 as ok'));
  return r.rows[0].ok === 1;
}

module.exports = { pool, withTransaction, withClient, preflight };
