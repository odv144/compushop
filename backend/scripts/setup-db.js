#!/usr/bin/env node
/**
 * Crea y deja lista la infraestructura de base de datos.
 *
 *   base de la app   `postgres`            dueno postgres    tablas de postgres
 *   base de tests   `compushop_test_db`   dueno compushop_test  tablas de compushop_test
 *
 * Es idempotente: se puede correr las veces que haga falta.
 *
 * POR QUE DOS BASES Y NO UNA CON TRUNCATE
 * Los tests van sobre HTTP (ver tests/helpers.js -> startTestServer). Una
 * transaccion no puede cruzar un request: pool.connect() por request y
 * transaction mode devuelven la conexion al pool al terminar. Entonces "aislar
 * con ROLLBACK" NO es posible para esta suite, y la unica forma de que un
 * TRUNCATE de los tests sea seguro es que los tests tengan su propia base.
 *
 * POR QUE EL ROL DE TESTS ES DUENO DE SU BASE
 * `public` pertenece a `pg_database_owner`, que resuelve al dueno de la base.
 * Si el dueno es compushop_test, entonces puede correr el schema y las tablas
 * le quedan de suyas, que es lo que hace falta para `TRUNCATE ... RESTART
 * IDENTITY` (sin ownership, `must be owner of sequence`).
 *
 * POR QUE EL ROL CREA LA BASE EL MISMO
 * A traves del pooler no se puede `ALTER ... OWNER TO` (Supavisor no permite
 * SET ROLE). El rodeo es: CREATEDB temporal -> el rol crea la base -> ya es
 * dueno -> revocar CREATEDB. Medido en spike 0.12.
 *
 * POR QUE LA APP CORRE COMO compushop_app CONTRA LA BASE DE TESTS
 * Para que los tests ejerciten el mismo nivel de privilegio que produccion. Si
 * la app corriera como el rol de test (que puede TRUNCATE y crear tablas),
 * ningun test detectaria que la app intenta algo que en produccion no puede.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const REF = 'rifmbtnyzquvljdbubth';
const POOLER = 'aws-0-us-west-2.pooler.supabase.com:6543';
const TDB = 'compushop_test_db';
const CA = process.env.SUPABASE_CA_CERT;

const SSL = CA ? { ca: CA, rejectUnauthorized: true } : { rejectUnauthorized: false };
if (!CA) {
  console.warn('[setup] SUPABASE_CA_CERT ausente: conecto sin verificar el certificado. Solo aceptable en dev.');
}

// La URL de administracion NO es DATABASE_URL: esa ya apunta a compushop_app,
// que no puede crear bases ni asignar ownership. Se reconstruye desde
// DB_POSGRES_PASSWORD, que es el superusuario real del proyecto.
if (!process.env.DB_POSGRES_PASSWORD) {
  console.error('Falta DB_POSGRES_PASSWORD en backend/.env. Es la password de postgres (NO la de los roles).');
  process.exit(1);
}
const ADMIN_DB = `postgresql://postgres.${REF}:${encodeURIComponent(process.env.DB_POSGRES_PASSWORD)}@${POOLER}/postgres`;
const admin = (db = 'postgres') => `postgresql://postgres.${REF}:${encodeURIComponent(process.env.DB_POSGRES_PASSWORD)}@${POOLER}/${db}`;

const rolePass = (which) => {
  const raw = which === 'app' ? process.env.DATABASE_URL : process.env.DATABASE_TEST_URL;
  return decodeURIComponent(new URL(raw).password);
};
const asRole = (user, pass, db) => `postgresql://${user}.${REF}:${encodeURIComponent(pass)}@${POOLER}/${db}`;

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'postgres', 'schema.sql'), 'utf8');
const GRANTS = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'postgres', 'grants.sql'), 'utf8');

const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => { console.log(`  FAIL ${m}`); process.exitCode = 1; };
const info = (m) => console.log(`       ${m}`);
const stage = (n) => console.log(`\n${'='.repeat(72)}\n${n}\n${'='.repeat(72)}`);

const att = async (c, sql) => { try { await c.query(sql); return null; } catch (e) { return e.message.split('\n')[0]; } };
const connect = async (u) => { const c = new Client({ connectionString: u, ssl: SSL, connectionTimeoutMillis: 15000 }); await c.connect(); return c; };

const TABLES = ['users', 'categories', 'products', 'services', 'orders', 'order_items', 'contact_messages', 'settings', 'password_resets'];

async function applySchema(c, label) {
  const e1 = await att(c, SCHEMA);
  if (e1) { bad(`${label}: schema.sql fallo -> ${e1}`); return false; }
  const e2 = await att(c, GRANTS);
  if (e2) { bad(`${label}: grants.sql fallo -> ${e2}`); return false; }
  ok(`${label}: schema + grants aplicados`);
  return true;
}

(async () => {
  stage('1. Base de la app (`postgres`)');
  const adm = await connect(ADMIN_DB);
  const hasAdmin = await applySchema(adm, 'app/postgres');
  if (hasAdmin) {
    const t = await adm.query(`select count(*)::int n from pg_tables where schemaname='public' and tablename = any($1)`, [TABLES]);
    ok(`tablas del dominio en postgres: ${t.rows[0].n}/9`);
  }

  stage('2. Base de tests: crearla con el dueno correcto');
  const exists = await adm.query('select 1 from pg_database where datname = $1', [TDB]);
  if (exists.rows.length) {
    const o = await adm.query('select pg_get_userbyid(datdba) o from pg_database where datname = $1', [TDB]);
    if (o.rows[0].o === 'compushop_test') {
      ok(`${TDB} ya existe y es de compushop_test`);
    } else {
      bad(`${TDB} existe pero es de ${o.rows[0].o}. Borrarla a mano: el pooler no puede cambiar el dueno.`);
    }
  } else {
    const g = await att(adm, 'alter role compushop_test createdb');
    if (g) { bad(`no se pudo dar CREATEDB: ${g}`); await adm.end(); process.exit(1); }
    const t = await connect(asRole('compushop_test', rolePass('test'), 'postgres'));
    const e = await att(t, `create database ${TDB}`);
    await t.end().catch(() => {});
    const r = await att(adm, 'alter role compushop_test nocreatedb');
    const back = await adm.query('select rolcreatedb from pg_roles where rolname = $1', ['compushop_test']);
    if (r) bad(`no se pudo revocar CREATEDB: ${r}`);
    else if (back.rows[0].rolcreatedb) bad('CREATEDB quedo activo');
    else ok('CREATEDB revocado, el rodeo no deja superficie');

    if (e) bad(`create database fallo: ${e}`);
    else {
      const o = await adm.query('select pg_get_userbyid(datdba) o from pg_database where datname = $1', [TDB]);
      o.rows[0].o === 'compushop_test' ? ok(`${TDB} creada, dueno=${o.rows[0].o}`) : bad(`dueno inesperado: ${o.rows[0].o}`);
    }
  }

  stage('3. Schema y grants en la base de tests (los corre compushop_test, que es dueno)');
  const tdb = await connect(asRole('compushop_test', rolePass('test'), TDB));
  if (await applySchema(tdb, `test/${TDB}`)) {
    const t = await tdb.query(`select count(*)::int n from pg_tables where schemaname='public' and tablename = any($1)`, [TABLES]);
    ok(`tablas del dominio en ${TDB}: ${t.rows[0].n}/9`);

    // La app tiene que poder correr CONTRA la base de tests con sus mismos
    // privilegios de produccion. Si no, ningun test verifica permisos: la app
    // pasaria con un rol que en produccion no tiene.
    const appProbe = await tdb.query(`select has_table_privilege('compushop_app', 'public.products', 'SELECT') as x`);
    appProbe.rows[0].x ? ok('compushop_app tiene SELECT en la base de tests') : bad('compushop_app NO tiene SELECT en la base de tests');
    const tr = await tdb.query(`select has_table_privilege('compushop_test', 'public.products', 'TRUNCATE') as x`);
    tr.rows[0].x ? ok('compushop_test tiene TRUNCATE (el harness lo necesita)') : bad('compushop_test NO tiene TRUNCATE');
  }
  await tdb.end();

  stage('4. Estado final');
  const dbs = await adm.query('select datname, pg_get_userbyid(datdba) o from pg_database where datistemplate = false order by datname');
  for (const d of dbs.rows) {
    const n = await adm.query(`select count(*)::int c from pg_tables where schemaname='public' and tablename = any($1)`, [TABLES]);
    info(`base ${d.datname.padEnd(22)} dueno=${String(d.o).padEnd(16)} tablas=${n.rows[0].c}/9`);
  }
  const roles = await adm.query(`select rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname like 'compushop%' order by rolname`);
  for (const r of roles.rows) info(`rol ${r.rolname.padEnd(18)} super=${r.rolsuper} createdb=${r.rolcreatedb} createrole=${r.rolcreaterole} bypassrls=${r.rolbypassrls}`);
  await adm.end();

  stage('5. Variables que faltan en backend/.env');
  const need = [
    ['SUPABASE_CA_CERT', 'PEM completo de prod-ca-2021.crt. Sin esto la app NO arranca en produccion.'],
    ['CRON_SECRET', 'para /api/health/keep-warm'],
  ];
  for (const [k, why] of need) {
    if (process.env[k]) ok(`${k} presente`);
    else info(`${k} FALTA — ${why}`);
  }
  if (process.env.DATABASE_TEST_URL) {
    const tdbPath = new URL(process.env.DATABASE_TEST_URL).pathname;
    tdbPath === `/${TDB}`
      ? ok(`DATABASE_TEST_URL apunta a ${TDB}`)
      : bad(`DATABASE_TEST_URL apunta a ${tdbPath}, deberia ser /${TDB}`);
  } else {
    info('DATABASE_TEST_URL FALTA — la usas para TRUNCATE y fixtures desde el harness.');
  }
  info('En los tests se sobreescribe DATABASE_URL con la URL de la base de tests');
  info('usando las credenciales de compushop_app, para no cambiar el nivel de privilegio.');

  console.log(`\n${'='.repeat(72)}`);
  console.log(process.exitCode ? '  HUBO FALLOS' : '  INFRAESTRUCTURA LISTA');
  console.log('='.repeat(72));
})().catch((e) => { console.error('CRASH:', e); process.exit(1); });
