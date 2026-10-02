/**
 * Helpers compartidos por los tests del backend.
 *
 * ===========================================================================
 * AISLAMIENTO: DOS COSAS
 * ===========================================================================
 * La app ya no lee NADA del store JSON (fase 4 en adelante: catalogo, usuarios,
 * mensajes, config, tokens Y pedidos viven en PostgreSQL). El store queda como
 * red de seguridad hasta la tarea 8.1, y los tests igual lo aíslan:
 *
 *   1. `data.json`  -> se copia a un archivo temporal y se restaura. Hoy NINGUN
 *                      helper lo escribe, asi que el restore es una red de
 *                      seguridad: si algo lo vuelve a tocar, la suite no deja
 *                      el store modificado entre archivos.
 *   2. PostgreSQL   -> se saca un snapshot de las 9 tablas y de las 9
 *                      secuencias con el DUENO de la base de tests, y se
 *                      restaura al terminar. Sin esto, cada test que crea un
 *                      producto deja una fila y una secuencia corrida para el
 *                      siguiente, y la suite deja de ser repetible.
 *
 * `order_number_seq` esta en la lista por la misma razon que las otras, con una
 * diferencia: NO tiene `owned by` (schema.sql), asi que `truncate ... restart
 * identity` no la resetearia. Si quedara fuera de este snapshot, el numero del
 * primer pedido de cada archivo seria distinto y los tests que comparan el
 * `order_number` (formato CS<fecha>-NNNN) no serian reproducibles.
 *
 * ===========================================================================
 * POR QUE `DATABASE_URL` SE APUNTA A `compushop_test_db` AL CARGAR ESTE ARCHIVO
 * ===========================================================================
 * `pool.js` lee `DATABASE_URL` AL SER REQUERIDO y no la vuelve a leer nunca. Si
 * los tests arrancaran con la URL de `postgres`, la app bajo test escribiria en
 * la base de PRODUCCION: borrarian productos,(users, usuarios. Es la unica
 * defensa que existe, y por eso esta al principio del archivo, antes de que
 * ningun test pueda requerir la capa de datos.
 *
 * No se puede usar `DATABASE_TEST_URL` tal cual: cambia el usuario, y el rol de
 * `compushop_app` es el que tiene los permisos que los guards verifican. La app
 * va con el USUARIO DE LA APP sobre la BASE DE TESTS; el snapshot usa
 * `DATABASE_TEST_URL`, que es el dueno y por eso puede truncar y setear
 * secuencias. Dos conexiones, dos roles, un motivo cada una.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const BACKEND_ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(BACKEND_ROOT, 'src', 'db', 'data.json');

require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

const POOLER_DB = 'compushop_test_db';

/**
 * URL de la APP (mismo usuario y password) sobre la BASE DE TESTS.
 *
 * El password se re-encodifica: en la URL puede venir percent-encoded y, si se
 * re-agrega crudo, un `@` corta el parseo del hostname y el error parece de
 * credenciales. Es el mismo motivo por el que D-09 exige el encoding.
 */
function appUrlOnTests() {
  const app = new URL(process.env.DATABASE_URL);
  const pass = encodeURIComponent(decodeURIComponent(app.password));
  return `postgresql://${app.username}:${pass}@${app.host}/${POOLER_DB}`;
}

process.env.DATABASE_URL = appUrlOnTests();
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

/**
 * Las 9 tablas, en orden de DEPENDENCIA para el restore.
 *
 * El orden importa SOLO para el `insert` del restore. Las FKs no son deferibles,
 * asi que un `order_items` insertado antes que su `orders` padre revienta con
 * 23503. El `truncate ... cascade` no necesita orden (cascade se encarga), pero
 * usar la misma lista para las dos cosas es la forma mas corta de olvidarse de
 * esto y que falle el `after` de un test que en realidad paso.
 */
const TABLES = [
  'settings',
  'users',
  'categories',
  'products',
  'services',
  'orders',
  'order_items',
  'contact_messages',
  'password_resets',
];

// Las 9 secuencias. `settings` no tiene: su clave es texto.
// `order_number_seq` no es `_id_seq` de ninguna tabla: es la del numero de pedido
// formateado (`CS260930-0001`), y por eso NO tiene `owned by`. Va igual, porque el
// snapshot/restore tiene que resetear TODAS las secuencias que el codigo pueda
// avanzar.
const SEQUENCES = [
  'users_id_seq',
  'categories_id_seq',
  'products_id_seq',
  'services_id_seq',
  'orders_id_seq',
  'order_number_seq',
  'order_items_id_seq',
  'contact_messages_id_seq',
  'password_resets_id_seq',
];

/**
 * Conexion del DUENO de la base de tests.
 *
 * `compushop_test` es dueno de `compushop_test_db`, asi que puede truncar y
 * setear secuencias. `compushop_app` NO puede (probado en data-layer.verify.js):
 * por eso el snapshot no usa la conexion de la app.
 */
/**
 * Conexion del DUENO de la base de tests.
 *
 * `compushop_test` es dueno de `compushop_test_db`, asi que puede truncar y
 * setear secuencias. `compushop_app` NO puede (probado en data-layer.verify.js):
 * por eso el snapshot no usa la conexion de la app.
 *
 * ===========================================================================
 * POR QUE EL OVERRIDE DE `numeric` ES POR CONEXION Y NO GLOBAL
 * ===========================================================================
 * numeric (oid 1700) llega como texto. `pool.js` pone un parser GLOBAL que
 * devuelve Number, porque la API tiene que responder numeros JSON. Tocar ese
 * parser con `types.setTypeParser` desde el harness arruina la app que se esta
 * testeando en el MISMO proceso: los `price` de las respuestas pasan a ser
 * `'6899.99'` y los `assert.strictEqual(price, 6899.99)`, que son justamente el
 * contrato que este change tiene que proteger, empiezan a fallar por el harness.
 *
 * OJO con la forma del override: `new Client({ types })` no acepta un mapa
 * parcial. pg hace `this._types = userTypes || types` y despues llama
 * `userTypes.getTypeParser(...)`, asi que `types` tiene que ser un objeto con la
 * FORMA de `pg-types` completa. Por eso se deriva con `Object.create(pg-types)`:
 * hereda todo y solo pisa `getTypeParser` para el oid 1700 en formato texto.
 * Pasar `{ 1700: fn }` a secas tira `this._types.getTypeParser is not a function`
 * adentro de `Result.addFields`, que es donde el error aparece y NADA explica
 * que la causa fue el harness.
 */
async function adminClient() {
  const { Client } = require('pg');
  const pgTypes = require('pg-types');
  const numericComoTexto = Object.create(pgTypes);
  numericComoTexto.getTypeParser = (oid, format) =>
    oid === 1700 && format !== 'binary' ? (v) => v : pgTypes.getTypeParser(oid, format);

  const c = new Client({
    connectionString: process.env.DATABASE_TEST_URL,
    ssl: process.env.SUPABASE_CA_CERT
      ? { ca: process.env.SUPABASE_CA_CERT, rejectUnauthorized: true }
      : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    types: numericComoTexto,
  });
  c.on('error', () => {});
  await c.connect();
  return c;
}

// ===========================================================================
// IDENTIDAD DE LOS FIXTURES: UNICA POR CORRIDA
// ===========================================================================
// Los fixtures de usuario usaban emails FIJOS (`cliente@test.com`,
// `admin@test.com`, ...). Con `users` sin restriccion UNIQUE sobre `email`
// (a proposito: el indice no es unico, ver schema.sql:60), dos corridas del
// mismo archivo dejan dos filas con el mismo email. Y `findByEmail` resuelve
// con `order by id limit 1`, o sea que devuelve SIEMPRE la de la corrida vieja:
//
//   - el login de los tests autenticaba a un usuario de una corrida anterior;
//   - el guard de auto-borrado compara `parseInt(params.id) === req.user.id`, y
//     con la fila equivocada la comparacion da falso: el admin SI se borraba a
//     si mismo y el test que deberia detectarlo daba verde.
//
// O sea que el fixture fijo no hacia la suite inestable: la hacia MENTIROSA.
// Un email por corrida elimina la ambiguedad entera, porque no hay dos filas
// que puedan coincidir.
//
// No alcanza SOLO con esto. Una corrida interrumpida (Ctrl-C, OOM, `kill -9`)
// deja las filas y `restoreData` no corre, asi que la basura se congela en el
// snapshot de la corrida siguiente y se reproduce para siempre. Por eso el
// `backupData` de mas abajo tambien las borra. Ver `limpiarFixturesColgados`.
const RUN_TAG = `${process.pid.toString(36)}${Date.now().toString(36)}`;
let fixtureSeq = 0;

/**
 * Dominio reservado por RFC 2606: nunca routable, nunca resuelve. Se usa como
 * MARCA para poder reconocer un fixture propio y borrar solo esos, sin tocar los
 * usuarios del seed.
 */
const DOMINIO_FIXTURE = 'test.invalid';

/** Email de fixture unico por corrida. `testEmail('admin')` -> `admin.r<tag>.0.test.invalid`. */
function testEmail(base) {
  return `${base}.r${RUN_TAG}.${fixtureSeq++}@${DOMINIO_FIXTURE}`;
}

/** DNI de fixture unico por corrida. `dni` es `text` (schema.sql:51), no hay formato que respetar. */
function testDni(base) {
  return `${base}.r${RUN_TAG}.${fixtureSeq++}`;
}

/**
 * ===========================================================================
 * POR QUE `backupData` BORRA LOS FIXTURES COLGADOS
 * ===========================================================================
 * Es el agujero que `restoreData` no puede cerrar: si el proceso muere, el
 * `after` no corre, y la corrida siguiente arranca con `backupData` respaldando
 * una base que YA tiene basura. A partir de ahi el snapshot es la basura y cada
 * restore la reproduce. Un email unico por corrida vuelve esas filas inertes
 * (ningun fixture las busca), pero no las borra: se acumulan para siempre.
 *
 * Por eso se limpian ACA y no en un paso manual. Es deterministico: se borran
 * SOLO filas cuyo email termina en el dominio de fixture, o sea que ningun
 * usuario del seed ni ninguna fila de una app real se tocan. Y se loguea
 * cuantas eran, para que la limpieza no sea invisible.
 *
 * NO se usa `on delete cascade` ni se inventan cascadas: `orders.user_id` esta
 * declarado `on delete set null` y borrarlo a mano dejaria pedidos huerfanos sin
 * avisar. Se borran los usuarios de fixture y los pedidos que apuntan a ellos se
 * quedan con `user_id = null`, que es lo que el schema ya dice que pase. Los
 * pedidos huerfanos NO se borran: no hay forma de distinguirlos de los del seed
 * por una columna, y borrar a ciegas seria peor.
 */
async function limpiarFixturesColgados(admin) {
  const r = await admin.query(
    `delete from users where email like $1 returning id`,
    [`%@${DOMINIO_FIXTURE}`],
  );
  if (r.rowCount > 0) {
    console.warn(
      `[helpers] ${r.rowCount} usuario(s) de fixture de una corrida anterior (email %@${DOMINIO_FIXTURE}) ` +
      `borrados antes del snapshot. Si esto aparece en cada corrida, hay una corrida que se esta ` +
      `interrumpiendo y no completa el after.`,
    );
  }

  // Duplicados que NO son fixtures: los de los fixtures de email FIJO que
  // existian antes de que los emails fueran unicos por corrida. No se borran
  // (no se puede saber cual de los dos es el bueno, y borrar el equivocado
  // rompe cosas), pero se AVISA.
  //
  // Es un warning y no un assert a proposito: con los fixtures de ahora ninguna
  // busqueda cae en un duplicado asi, asi que la suite sigue siendo correcta y
  // un fallo aca seria ruido, no un bug. Lo que no se permite es que la
  // duplicacion siga sin que nadie se entere.
  const dups = await admin.query(
    `select email, count(*)::int as veces, array_agg(id order by id) as ids
       from users
      group by email
     having count(*) > 1
        and email not like $1`,
    [`%@${DOMINIO_FIXTURE}`],
  );
  if (dups.rows.length) {
    console.warn(
      `[helpers] ATENCION: ${dups.rows.length} email(s) con filas duplicadas que NO son fixtures. ` +
      `No rompen la suite (los fixtures ya no usan emails fijos), pero ensucian la base:`,
    );
    for (const d of dups.rows) {
      console.warn(`             ${d.email} x${d.veces} ids=${JSON.stringify(d.ids)}`);
    }
  }
  return r.rowCount;
}

/**
 * Reset explicito y SEGURO de los fixtures de la base de test.
 *
 * Borra SOLO los usuarios cuyo email termina en el dominio de fixture, o sea
 * los que creo una corrida de tests. Idempotente: correrlo dos veces es lo
 * mismo que correrlo una.
 *
 * ===========================================================================
 * POR QUE NO TRUNCA LAS NUEVE TABLAS
 * ===========================================================================
 * Truncar todo pareceria mas completo y es peor. `TRUNCATE ... CASCADE` deja la
 * base VACIA, incluyendo los dos usuarios del seed (`admin@compushop.com`,
 * `juan@email.com`) y el catalogo, y esa base no se reconstruye sola: hay que
 * correr `npm run seed` o `scripts/setup-db.js` a mano. Los `.verify.js`
 * (`read-parity`, `data-layer`) comparan contra el seed, asi que un truncate los
 * deja inservibles y el que lo descubre es el proximo que los corre, no el que
 * lo hizo.
 *
 * Lo que este helper NO saca son los pedidos huerfanos de una corrida
 * interrumpida: `orders` no tiene columna que los marque como fixture, asi que
 * no se pueden distinguir de un pedido real sin borrarlos a ciegas. No afectan
 * la determinacion de la suite (ningun test cuenta pedidos globales) pero se
 * acumulan. Si molesta, `npm run seed` los deja como estaban.
 *
 * Los `password_resets` de esos usuarios caen solos: `users_password_resets_fk`
 * ya es `on delete cascade` en el schema. No se toco el schema.
 */
async function resetTestDb() {
  const admin = await adminClient();
  try {
    const db = await admin.query('select current_database() as db');
    if (db.rows[0].db !== POOLER_DB) {
      throw new Error(`resetTestDb se niega a tocar "${db.rows[0].db}": solo "${POOLER_DB}"`);
    }
    const r = await admin.query('delete from users where email like $1 returning id, email', [`%@${DOMINIO_FIXTURE}`]);
    console.log(`[helpers] ${POOLER_DB}: ${r.rowCount} fixture(s) borrados.`);
    for (const row of r.rows) console.log(`             id=${row.id} ${row.email}`);
  } finally {
    await admin.end();
  }
  dbSnapshot = null;
}

let backupPath = null;
let dbSnapshot = null;

/**
 * Columnas de una tabla, en orden, tal como las define Postgres.
 *
 * Se leen de `information_schema` en vez de escribir 9 listas a mano: una lista
 * escrita a mano que se queda vieja (o que se olvida de una columna) rompe el
 * restore en silencio, que es la peor forma de romperlo.
 */
async function columnasDe(admin, tabla) {
  const r = await admin.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [tabla],
  );
  return r.rows.map((x) => x.column_name);
}

/** Copia las filas de las 9 tablas. Llamar en `before`. */
async function backupData() {
  if (fs.existsSync(DATA_PATH)) {
    backupPath = path.join(os.tmpdir(), `compushop-data-${process.pid}-${Date.now()}.json`);
    fs.copyFileSync(DATA_PATH, backupPath);
  }

  const admin = await adminClient();
  try {
    // ANTES del snapshot, para que el snapshot no se lleve la basura de una
    // corrida que murio sin restore. Ver `limpiarFixturesColgados`.
    await limpiarFixturesColgados(admin);

    const tablas = {};
    for (const t of TABLES) {
      const cols = await columnasDe(admin, t);
      const r = await admin.query(`select ${cols.join(', ')} from ${t}`);
      tablas[t] = { cols, rows: r.rows };
    }
    // `last_value` Y `is_called`. Falta el `is_called` y el siguiente id se
    // corre en uno: con `setval(seq, 12, true)` el próximo es 13, y una
    // secuencia recién creada (`start 1`, nunca usada) tiene
    // `is_called = false`, cuyo próximo es 1, no 2.
    const seqs = {};
    for (const s of SEQUENCES) {
      const r = await admin.query(`select last_value, is_called from ${s}`);
      seqs[s] = r.rows[0];
    }
    dbSnapshot = { tablas, seqs };
  } finally {
    await admin.end();
  }
}

/**
 * Restaura `data.json` y la base. Llamar en `after`.
 *
 * ===========================================================================
 * LA BASE SE RESTAURA DENTRO DE UNA TRANSACCION, Y NO ES COSMETICO
 * ===========================================================================
 * La primera version de esta funcion hacia `truncate` y despues insertaba
 * fila por fila sin transaccion. Con las tablas en el orden equivocado, el
 * `insert` de `order_items` revienta por FK (23503) DESPUES del truncate, y la
 * base queda VACIA. En serio vacia: las 9 tablas, 0 filas.
 *
 * Eso no es un test rojo, es perder el estado de la base de tests a mano y
 * tener que acordarse de que existe `scripts/migrate-data.js`. Con transaccion,
 * el mismo error deja la base EXACTAMENTE como estaba y el fallo se ve en el
 * `after` del archivo que lo produjo, que es donde lo estas buscando.
 *
 * El orden de `TABLES` sigue importando (las FKs no son deferibles), pero ya no
 * es la unica red.
 */
async function restoreData() {
  if (backupPath && fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, DATA_PATH);
    fs.unlinkSync(backupPath);
    backupPath = null;
  }

  if (!dbSnapshot) return;

  const admin = await adminClient();
  try {
    await admin.query('BEGIN');
    try {
      await admin.query(`truncate table ${TABLES.join(', ')} cascade`);
      for (const t of TABLES) {
        const { cols, rows } = dbSnapshot.tablas[t];
        if (!rows.length) continue;
        const colsSql = cols.join(', ');
        for (const row of rows) {
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          await admin.query(`insert into ${t} (${colsSql}) values (${placeholders})`, cols.map((c) => row[c]));
        }
      }
      for (const s of SEQUENCES) {
        const { last_value, is_called } = dbSnapshot.seqs[s];
        await admin.query('select setval($1, $2, $3)', [s, last_value, is_called]);
      }
      await admin.query('COMMIT');
    } catch (e) {
      await admin.query('ROLLBACK').catch(() => {});
      throw new Error(
        `restoreData fallo y se hizo rollback (la base quedo como estaba): ${e.message}`,
      );
    }
  } finally {
    await admin.end();
    dbSnapshot = null;
  }
}

/**
 * Levanta la app real en un puerto efimero y devuelve una API de fetch.
 * No toca process.env.PORT del shell.
 */
async function startTestServer() {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';

  // La app hace listen() al require salvo que VERCel este seteado.
  // Requerimos con VERCEL seteado => exporta la app sin escuchar,
  // y nosotros la montamos nosotros mismos en un puerto libre.
  process.env.VERCEL = '1';
  const app = require(path.join(BACKEND_ROOT, 'src', 'index.js'));
  delete process.env.VERCEL;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const base = `http://127.0.0.1:${server.address().port}/api`;
  const port = server.address().port;

  const request = async (method, url, { body, token } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  };

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    get: (url, opts) => request('GET', url, opts),
    post: (url, body, opts) => request('POST', url, { ...opts, body }),
    put: (url, body, opts) => request('PUT', url, { ...opts, body }),
    delete: (url, opts) => request('DELETE', url, opts),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Fixtures: se escriben SOLO en PostgreSQL.
 * ===========================================================================
 * POR QUE YA NO SE ESCRIBE EN EL STORE
 * ===========================================================================
 * Antes cada fixture iba a los dos lados porque `POST /orders` resolvia los items
 * contra `store.get()`: un producto que existiera solo en Postgres era INVISIBLE
 * para el checkout, y los tests de pedidos fallaban con "Producto o servicio no
 * disponible".
 *
 * Con la fase 4 `POST /orders` resuelve contra Postgres (`repo.orders` +
 * `products.resolveForOrder`). Escribir en `data.json` ya no hace falta para que
 * nada funcione: seria exactamente la doble escritura que este change elimina, y
 * el fixture terminaria en un archivo que ninguna ruta lee.
 *
 * ===========================================================================
 * POR QUE EL id SIGUE BUSCANDOSE LIBRE
 * ===========================================================================
 * Porque las rutas allocatean con `nextval` y los fixtures insertan un id
 * EXPLICITO. Si el fixture toma un id que la secuencia todavia no alcanzo, el
 * proximo producto que cree una RUTA recibe ese mismo id y el insert revienta por
 * primary key en un test que no tiene nada que ver con el fixture.
 */
async function idLibreEnPostgres(admin, tabla) {
  const r = await admin.query(`select coalesce(max(id), 0)::int as max from ${tabla}`);
  return r.rows[0].max + 1;
}

async function crearEnPostgres(admin, tabla, datos, id) {
  const cols = Object.keys(datos);
  await admin.query(
    `insert into ${tabla} (id, ${cols.join(', ')})
     values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
    [id, ...cols.map((c) => datos[c])],
  );
  // La secuencia queda por encima del id del fixture: si no, el proximo
  // producto que cree una RUTA recibe un id que un fixture ya ocupa y el insert
  // falla por primary key en un test que no tiene nada que ver.
  //
  // El `setval` explicito y no "dejalo que se acomode" porque el pool corre con
  // `max: 1` y en transaction mode: dos inserts con el mismo `nextval` NO pueden
  // coexistir, cada transaccion ve su propio estado de secuencia.
  await admin.query(
    `select setval('${tabla}_id_seq', greatest((select last_value from ${tabla}_id_seq), $1), true)`,
    [id],
  );
}

/**
 * Crea un producto de prueba y devuelve su id. `async` porque escribe en la base.
 *
 * El slug usa el mismo `slugify` que la app. Esta es una copia y no un require
 * del de la ruta a proposito: los tests no deben depender de la implementacion
 * de la ruta, sino del CONTRATO (minusculas, sin acentos, guiones). Si el
 * `slugify` de la app cambia, este helper deja de ser un test valido y hay que
 * revisarlo.
 */
async function createTestProduct({ name, price, stock = 50, is_active = true } = {}) {
  const admin = await adminClient();
  try {
    const id = await idLibreEnPostgres(admin, 'products');
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const ahora = new Date().toISOString();
    const fila = {
      name,
      slug,
      description: 'Producto de test',
      price,
      stock,
      category_id: null,
      brand: 'TestBrand',
      image: null,
      specs: null,
      is_active,
      created_at: ahora,
      updated_at: ahora,
    };
    await crearEnPostgres(admin, 'products', fila, id);
    return { id, name, slug, price, stock, is_active };
  } finally {
    await admin.end();
  }
}

/** Igual que `createTestProduct`, para servicios. Ver la nota de ahi. */
async function createTestService({ name, price, is_active = true } = {}) {
  const admin = await adminClient();
  try {
    const id = await idLibreEnPostgres(admin, 'services');
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const ahora = new Date().toISOString();
    const fila = {
      name,
      slug,
      description: 'Servicio de test',
      price,
      duration: '2 horas',
      image: null,
      is_active,
      created_at: ahora,
      updated_at: ahora,
    };
    await crearEnPostgres(admin, 'services', fila, id);
    return { id, name, slug, price, is_active };
  } finally {
    await admin.end();
  }
}

/**
 * Crea un usuario de test con password hasheada. Solo en Postgres: ningun
 * endpoint lee usuarios del store, asi que la doble escritura aca seria
 * work sin destino.
 *
 * Devuelve `dni` ademas de lo obvio: `POST /auth/forgot-password` busca por DNI
 * y los tests de `dev_token` pasan `admin.dni`. Con un `createTestUser` que no
 * lo devolvia, `admin.dni` era `undefined`, el controller recibia la cadena
 * `"undefined"`, `findByDni` no encontraba a nadie y contestaba la respuesta
 * generica antes de crear el token: los tres tests pasaban sin haber probado
 * el flujo de reset.
 *
 * Si no se pasa `email`, se genera uno unico por corrida (ver `testEmail`).
 * `dni` tambien, por la misma razon: `findByDni` tiene el mismo
 * `order by id limit 1` que `findByEmail`.
 */
async function createTestUser({ name, email, password, dni, role = 'customer' } = {}) {
  const bcrypt = require(path.join(BACKEND_ROOT, 'node_modules', 'bcryptjs'));
  const repo = require(path.join(BACKEND_ROOT, 'src', 'data', 'repo.js'));
  const emailFinal = email || testEmail('usuario');
  const dniFinal = dni === undefined ? testDni('00000000') : dni;
  const user = await repo.users.create({
    name,
    email: emailFinal,
    password: bcrypt.hashSync(password, 10),
    dni: dniFinal,
    role,
  });
  return { id: user.id, name, email: emailFinal, password, dni: dniFinal, role };
}

const CUSTOMER = { name: 'Cliente Test', email: testEmail('cliente'), password: 'test123', dni: testDni('11111111') };

module.exports = {
  BACKEND_ROOT,
  DATA_PATH,
  POOLER_DB,
  RUN_TAG,
  DOMINIO_FIXTURE,
  testEmail,
  testDni,
  backupData,
  restoreData,
  resetTestDb,
  startTestServer,
  createTestProduct,
  createTestService,
  createTestUser,
  CUSTOMER,
};