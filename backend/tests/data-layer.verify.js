/**
 * Verificacion de la capa de datos. Corre contra las bases REALES y no deja
 * datos: dropea la tabla probe al final.
 *
 * Estructura: la tabla probe la crea un ADMIN (el rol de la app no puede, y es
 * justamente el guard que se quiere verificar). Despues TODAS las operaciones
 * van con el rol de la app sobre una tabla que no es suya. Eso prueba lo que
 * importa: que el rol de la app puede hacer todo su trabajo sobre tablas que
 * otro creo, sin necesidad de ownsership.
 *
 *   1. pool.js conecta con CA verificada contra AMBAS bases
 *   2. guards: la app NO puede crear tablas, ni schemas, ni truncar
 *   3. numeric(14,2) llega como number, no string
 *   4. timestamptz llega como Date y sale ISO en JSON
 *   5. jsonb vuelve como objeto
 *   6. withTransaction hace rollback de verdad y devuelve el client al pool
 *   7. truncate + restart identity resetea la secuencia
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');
const results = [];
const ok = (n, d = '') => results.push({ n, d, pass: true });
const no = (n, d = '') => results.push({ n, d, pass: false });

const PROBE = 'zz_probe_fase1';
const REF = 'rifmbtnyzquvljdbubth';
const POOLER = 'aws-0-us-west-2.pooler.supabase.com:6543';
const SSL = process.env.SUPABASE_CA_CERT
  ? { ca: process.env.SUPABASE_CA_CERT, rejectUnauthorized: true }
  : { rejectUnauthorized: false };

// URL de la app CON LA BASE DE TESTS. No se puede cambiar el usuario sobre la
// URL de test: la password que viene ahi es la de compushop_test y no sirve.
// Hay que recombinar host + password de la app + dbname de test.
function appUrlOn(dbname) {
  const app = new URL(process.env.DATABASE_URL);
  return `postgresql://${app.username}:${encodeURIComponent(decodeURIComponent(app.password))}@${POOLER}/${dbname}`;
}

const adminUrl = (db) =>
  `postgresql://postgres.${REF}:${encodeURIComponent(process.env.DB_POSGRES_PASSWORD)}@${POOLER}/${db}`;

// Quien puede hacer DDL depende de la base, y esto NO es negociable:
// `public` pertenece a `pg_database_owner`, que resuelve al DUENO de la base.
//   postgres          -> dueno de `postgres`        -> puede DDL
//   compushop_test_db -> dueno es compushop_test     -> postgres NO puede, da
//                                                     permission denied
// Por eso el DDL de la base de tests lo tiene que correr compushop_test.
const ddlUrl = (db) => (db === 'postgres' ? adminUrl(db) : process.env.DATABASE_TEST_URL);

const attempt = async (fn) => { try { await fn(); return true; } catch { return false; } };

async function suite(label, dbname) {
  console.log(`\n${'='.repeat(74)}\n${label}\n${'='.repeat(74)}`);

  // pool.js lee DATABASE_URL al cargarse.
  process.env.DATABASE_URL = appUrlOn(dbname);
  const poolPath = path.join(__dirname, '..', 'src', 'data', 'postgres', 'pool.js');
  delete require.cache[require.resolve(poolPath)];
  const { withClient, withTransaction, preflight } = require(poolPath);

  const ddl = new Client({ connectionString: ddlUrl(dbname), ssl: SSL, connectionTimeoutMillis: 15000 });
  await ddl.connect();

  try {
    (await preflight()) ? ok('preflight', 'SELECT 1 ok') : no('preflight', 'no devolvio 1');

    // --- guards (todo con el rol de la app) ---------------------------------
    const canCreate = await attempt(() => withClient((c) => c.query(`create table ${PROBE}_g (id int)`)));
    canCreate ? no('guard CREATE TABLE', 'el rol pudo crear tablas') : ok('guard CREATE TABLE', 'bloqueado, correcto');

    const canSchema = await attempt(() => withClient((c) => c.query('create schema zz_probe')));
    canSchema ? no('guard CREATE SCHEMA', 'el rol pudo crear schemas') : ok('guard CREATE SCHEMA', 'bloqueado, correcto');

    // La tabla probe la crea el dueno de la base. La app solo la va a usar.
    // La secuencia va PRIMERO: `default nextval('x')` no la crea sola.
    await ddl.query(`drop table if exists ${PROBE} cascade`);
    await ddl.query(`drop sequence if exists ${PROBE}_id_seq cascade`);
    await ddl.query(`create sequence ${PROBE}_id_seq as integer start 1`);
    await ddl.query(`create table ${PROBE} (
      id int primary key default nextval('${PROBE}_id_seq'),
      price numeric(14,2) not null,
      created_at timestamptz not null default now(),
      specs jsonb,
      flag boolean not null default false
    )`);
    // Sin OWNED BY la secuencia queda huerfana y `truncate ... restart identity`
    // la ignora. Es el bug que este archivo existe para cazar.
    await ddl.query(`alter sequence ${PROBE}_id_seq owned by ${PROBE}.id`);
    await ddl.query(`grant select, insert, update, delete on ${PROBE} to compushop_app`);
    await ddl.query(`grant usage, select on sequence ${PROBE}_id_seq to compushop_app`);
    ok('tabla probe creada por el dueno de la base, DML concedido a la app');

    // nextval necesita la secuencia: la app no tiene CREATE SEQUENCE.
    const canSeq = await attempt(() => withClient((c) => c.query(`select nextval('${PROBE}_id_seq')`)));
    canSeq ? ok('la app puede nextval sobre secuencia ajena') : no('nextval', 'faltan privilegios de secuencia: los INSERT con default id fallan');

    // --- tipos (con el rol de la app) ---------------------------------------
    const ins = await withClient((c) => c.query(
      `insert into ${PROBE} (price, specs) values ($1, $2) returning id, price, created_at, specs, flag`,
      [6899.99, { ram: '16GB', gpu: 'RTX 4060' }],
    ));
    const row = ins.rows[0];

    typeof row.price === 'number'
      ? ok('numeric(14,2) -> number', `price=${row.price} (${typeof row.price})`)
      : no('numeric -> number', `llego como ${typeof row.price}: ${row.price}`);

    row.created_at instanceof Date
      ? ok('timestamptz -> Date', row.created_at.toISOString())
      : no('timestamptz -> Date', `llego como ${typeof row.created_at}`);

    JSON.stringify(row.created_at) === `"${row.created_at.toISOString()}"`
      ? ok('Date -> ISO en JSON', 'mismo ISO que antes de migrar')
      : no('Date -> ISO en JSON', JSON.stringify(row.created_at));

    row.specs && row.specs.ram === '16GB'
      ? ok('jsonb -> objeto', JSON.stringify(row.specs))
      : no('jsonb -> objeto', JSON.stringify(row.specs));

    row.flag === false ? ok('boolean default', 'false') : no('boolean default', String(row.flag));

    // Aritmetica de precios sin concatenacion de strings.
    const sum = await withClient((c) => c.query(`select sum(price) s from ${PROBE}`));
    typeof sum.rows[0].s === 'number'
      ? ok('sum(numeric) -> number', `sum=${sum.rows[0].s}`)
      : no('sum(numeric)', `llego como ${typeof sum.rows[0].s}`);

    // --- transaccion --------------------------------------------------------
    await withClient((c) => c.query(`delete from ${PROBE}`));
    await ddl.query(`alter sequence ${PROBE}_id_seq restart`);

    let threw = false;
    try {
      await withTransaction(async (c) => {
        await c.query(`insert into ${PROBE} (price) values (1)`);
        await c.query(`insert into ${PROBE} (price) values (1/0)`);
      });
    } catch { threw = true; }
    threw ? ok('withTransaction propaga el error') : no('withTransaction', 'no propago');

    const n1 = await withClient((c) => c.query(`select count(*)::int n from ${PROBE}`));
    n1.rows[0].n === 0 ? ok('rollback deshizo el INSERT') : no('rollback', `quedaron ${n1.rows[0].n} filas`);

    // Si el rollback no hubiera corrido, esto falla con "current transaction is aborted".
    const reuse = await withClient((c) => c.query('select 1 as ok'));
    reuse.rows[0].ok === 1 ? ok('client vuelve al pool usable post-rollback') : no('client reusable', 'no devolvio 1');

    await withTransaction((c) => c.query(`insert into ${PROBE} (price) values (2)`));
    const n2 = await withClient((c) => c.query(`select count(*)::int n from ${PROBE}`));
    n2.rows[0].n === 1 ? ok('commit dejo la fila') : no('commit', `quedaron ${n2.rows[0].n}`);

    // --- guarda de TRUNCATE -------------------------------------------------
    const canTruncate = await attempt(() => withClient((c) => c.query(`truncate ${PROBE} restart identity`)));
    canTruncate
      ? no('guard TRUNCATE', 'el rol de la app PUEDE truncar: un bug wipea la base')
      : ok('guard TRUNCATE', 'bloqueado en esta base, correcto');

    // El harness, con compushop_test, SI puede limpiar: sin esto los tests
    // no pueden aislarse entre archivos.
    const tst = new Client({ connectionString: process.env.DATABASE_TEST_URL, ssl: SSL, connectionTimeoutMillis: 15000 });
    if (dbname !== 'postgres') {
      await tst.connect();
      const t = await attempt(() => tst.query(`truncate ${PROBE} restart identity`));
      t ? ok('el harness (compushop_test) puede TRUNCATE') : no('TRUNCATE del harness', 'compushop_test no puede limpiar');

      // OJO: `last_value` es bigint (OID 20) y `pg` devuelve int8 como STRING.
      // Solo hay type parser para numeric (1700). Comparar con `=== 1` da false
      // siempre. Y `is_called` es lo que decide de verdad: si quedo en true, el
      // proximo nextval devuelve last_value+1.
      const s = await tst.query(`select last_value, is_called from ${PROBE}_id_seq`);
      const lv = s.rows[0].last_value;
      typeof lv === 'string'
        ? ok('last_value llega como string (int8 no parseado)', `valor=${lv}`)
        : ok('last_value llega como number', `valor=${lv}`);

      // La prueba que importa: insertar y ver que id sale. Inspeccionar
      // metadata puede mentir; un INSERT no.
      const fresh = await withClient((c) => c.query(`insert into ${PROBE} (price) values (5) returning id`));
      fresh.rows[0].id === 1
        ? ok('tras truncate, el proximo id es 1', 'aislamiento del harness real')
        : no('reset de secuencia', `el proximo id fue ${fresh.rows[0].id}, deberia ser 1`);

      // Y que el id siga siendo 1 en el siguiente ciclo: este es el bug que
      // se cuela si la secuencia quedo huerfana.
      await tst.query(`truncate ${PROBE} restart identity`);
      const fresh2 = await withClient((c) => c.query(`insert into ${PROBE} (price) values (6) returning id`));
      fresh2.rows[0].id === 1
        ? ok('y sigue siendo 1 en el segundo ciclo', 'OWNED BY funciona')
        : no('OWNED BY', `el segundo ciclo dio id ${fresh2.rows[0].id}`);

      await tst.end();
    }
  } catch (e) {
    no('suite', e.message);
  } finally {
    await ddl.query(`drop table if exists ${PROBE} cascade`).catch(() => {});
    await ddl.query('drop schema if exists zz_probe cascade').catch(() => {});
    await ddl.end().catch(() => {});
  }
}

(async () => {
  await suite('A. app -> postgres (base de produccion), rol compushop_app', 'postgres');
  await suite('B. app -> compushop_test_db, rol compushop_app', 'compushop_test_db');

  console.log(`\n${'='.repeat(74)}\nRESUMEN\n${'='.repeat(74)}`);
  let fails = 0;
  for (const r of results) {
    if (!r.pass) fails++;
    console.log(`  ${r.pass ? 'OK  ' : 'FAIL'}  ${r.n}${r.d ? ' — ' + r.d : ''}`);
  }
  console.log(`\n  ${results.length - fails}/${results.length} OK`);
  process.exit(fails ? 1 : 0);
})();
