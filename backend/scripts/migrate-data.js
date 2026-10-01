#!/usr/bin/env node
/**
 * Migra src/db/data.json a PostgreSQL.
 *
 *   node scripts/migrate-data.js                 -> compushop_test_db (seguro)
 *   node scripts/migrate-data.js --target=app    -> postgres (la real, pide --force si no esta vacia)
 *   node scripts/migrate-data.js --dry-run       -> no escribe nada, solo valida
 *
 * Por que NO es un simple INSERT: la parte importante es la validacion. El
 * script lee las columnas reales de information_schema y las compara con las
 * claves reales del JSON. Si alguien agrega un campo al store y no al schema,
 * o al reves, el script lo dice y se frena. Una migracion que copia filas sin
 * mirar el destino convierte el drift de schema en perdida silenciosa de datos.
 *
 * Por que una sola transaccion: si falla algo a mitad, la base queda como
 * estaba. Con 9 tablas y FKs en cascada, un fallo parcial deja datos
 * inconsistentes y el rollback manual es un quilombo.
 *
 * Por que setval con is_called=false: `store.next()` de store.js devuelve el
 * valor ACTUAL del contador y despues incrementa. Con seq.products = 13, el
 * proximo id es 13. `setval(seq, 13, false)` reproduce eso exacto. Con
 * `is_called = true` el proximo seria 14 y el id 13 no existiria nunca: un
 * hueco silencioso en la secuencia.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const REF = 'rifmbtnyzquvljdbubth';
const POOLER = 'aws-0-us-west-2.pooler.supabase.com:6543';
const JSON_PATH = path.join(__dirname, '..', 'src', 'db', 'data.json');
const SSL = process.env.SUPABASE_CA_CERT
  ? { ca: process.env.SUPABASE_CA_CERT, rejectUnauthorized: true }
  : { rejectUnauthorized: false };

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const TARGET = (process.argv.find((a) => a.startsWith('--target=')) || '').split('=')[1] || 'test';

// Orden de insercion: por dependencia de FK. products antes que orders,
// orders antes que order_items. Cambiar esto y revienta la FK.
const ORDER = [
  'users', 'categories', 'products', 'services',
  'orders', 'order_items', 'contact_messages', 'password_resets',
];

// Orden logico del contador de ids de store.js.
const SEQ_TABLES = ['users', 'categories', 'products', 'services', 'orders', 'order_items', 'contact_messages', 'password_resets'];

// El pedido de prueba del spike quedo con PII real. La migracion lo anonimiza
// en el origen: si el PII llega a la base, quedo persistido y "anonimizar
// despues" es borrar, no anonimizar.
const ANONYMIZE_ORDER = {
  order_number: 'CS260930-5475',
  set: {
    customer_name: 'Cliente Anonimo',
    customer_email: 'cliente.anonimo@example.com',
    customer_phone: '0000000000',
    shipping_address: 'Direccion de Prueba 123',
  },
};

const out = (s = '') => console.log(s);
const ok = (s) => out(`  OK    ${s}`);
const warn = (s) => out(`  AVISO ${s}`);
const err = (s) => { out(`  FALLA ${s}`); problems.push(s); };
const stage = (s) => out(`\n${'='.repeat(74)}\n${s}\n${'='.repeat(74)}`);
let problems = [];

function ddlUrl() {
  if (TARGET === 'app') {
    return `postgresql://postgres.${REF}:${encodeURIComponent(process.env.DB_POSGRES_PASSWORD)}@${POOLER}/postgres`;
  }
  return process.env.DATABASE_TEST_URL;
}

// ---------------------------------------------------------------------------
// 1. Cargar y sanear
// ---------------------------------------------------------------------------
stage('1. data.json');
if (!fs.existsSync(JSON_PATH)) {
  out(`  No existe ${JSON_PATH}. Nada que migrar.`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

// Backup antes de tocar nada. Si el script tiene un bug, el JSON original
// sigue disponible y la migracion se puede reintentar desde cero.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(__dirname, '..', 'src', 'db', `data.json.bak-${stamp}`);
if (!DRY) {
  fs.copyFileSync(JSON_PATH, backup);
  ok(`backup: ${path.basename(backup)}`);
} else {
  ok('dry-run: no se escribe backup ni datos');
}

const counts = {};
for (const t of ORDER) counts[t] = Array.isArray(raw[t]) ? raw[t].length : 0;
const settingsKeys = raw.settings && typeof raw.settings === 'object' ? Object.keys(raw.settings).length : 0;
out(`       ${ORDER.map((t) => `${t}=${counts[t]}`).join('  ')}  settings=${settingsKeys}`);

if (counts.users === 0 && counts.products === 0) {
  out('  El JSON esta vacio. Nada que migrar.');
  process.exit(1);
}

// --- anonimizacion, en memoria, antes de tocar la base ---------------------
let anonApplied = false;
const orders = (raw.orders || []).map((o) => {
  if (o.order_number !== ANONYMIZE_ORDER.order_number) return o;
  anonApplied = true;
  return { ...o, ...ANONYMIZE_ORDER.set, user_id: null };
});
if (anonApplied) {
  ok(`anonimizado el pedido ${ANONYMIZE_ORDER.order_number}: ${Object.values(ANONYMIZE_ORDER.set).join(' / ')}`);
  const stillPii = orders.filter((o) => o.order_number === ANONYMIZE_ORDER.order_number
    && Object.values(ANONYMIZE_ORDER.set).some((v) => o.customer_name === v && v === 'Cliente Anonimo' && o.customer_email !== ANONYMIZE_ORDER.set.customer_email));
  if (stillPii.length) err('la anonimizacion del pedido quedo incompleta');
} else {
  warn(`no se encontro el pedido ${ANONYMIZE_ORDER.order_number} para anonimizar`);
}

const source = { ...raw, orders };

// ---------------------------------------------------------------------------
// 2. Validar contra el schema REAL de la base destino
// ---------------------------------------------------------------------------
stage('2. Deriva contra el schema real');

const ddl = new Client({ connectionString: ddlUrl(), ssl: SSL, connectionTimeoutMillis: 15000 });

(async () => {
  try {
    await ddl.connect();
  } catch (e) {
    out(`  No pude conectar al target "${TARGET}": ${e.message}`);
    process.exit(1);
  }

  const dbName = (await ddl.query('select current_database() d, current_user u')).rows[0];
  out(`       target: ${dbName.d} como ${dbName.u}`);

  // Las tablas del dominio, con sus columnas.
  const cols = {};
  const colRes = await ddl.query(`
    select table_name, column_name, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public' and table_name = any($1)
    order by table_name, ordinal_position`, [ORDER.concat('settings')]);
  for (const r of colRes.rows) (cols[r.table_name] ||= []).push(r);

  for (const t of ORDER.concat('settings')) {
    if (!cols[t]) { err(`falta la tabla ${t} en el target. Correr scripts/setup-db.js primero.`); }
  }
  if (problems.length) { out('\nAbortando: el schema no esta listo.'); await ddl.end(); process.exit(1); }

  // Deriva JSON -> columnas.
  const keysIn = (t) => {
    const rows = source[t] || [];
    const s = new Set();
    for (const r of rows) if (r && typeof r === 'object') for (const k of Object.keys(r)) s.add(k);
    return s;
  };
  const colsIn = (t) => new Set(cols[t].map((c) => c.column_name));

  const plan = {};
  for (const t of ORDER) {
    const jsonKeys = keysIn(t);
    const dbCols = colsIn(t);
    const used = [...jsonKeys].filter((k) => dbCols.has(k));
    const dropped = [...jsonKeys].filter((k) => !dbCols.has(k));
    const isEmpty = counts[t] === 0;

    // La validacion de "NOT NULL sin default" solo aplica si hay filas. Con la
    // coleccion vacia no hay claves de las que derivar, y acusar columnas
    // "imposibles de llenar" seria un falso positivo que frena la migracion de
    // algo que no tiene nada que migrar.
    const missing = isEmpty ? [] : [...dbCols].filter((k) => !jsonKeys.has(k)
      && cols[t].find((c) => c.column_name === k).is_nullable === 'NO'
      && !cols[t].find((c) => c.column_name === k).column_default);

    if (dropped.length) warn(`${t}: claves del JSON SIN columna en la base -> se descartan: ${dropped.join(', ')}`);
    if (missing.length) err(`${t}: columnas NOT NULL sin default y sin clave en el JSON -> no se pueden llenar: ${missing.join(', ')}`);
    if (isEmpty) out(`       ${t.padEnd(18)} 0 filas: sin validacion de columnas`);

    plan[t] = { used, columns: [...dbCols] };
    out(`       ${t.padEnd(18)} ${used.length} columnas  ${dropped.length ? `(${dropped.length} descartadas)` : ''}`);
  }

  // El orden de las claves del JSON tiene que calzar con el del schema para
  // poder insertar por posicion. Se explicita para no confiar en el orden.
  for (const t of ORDER) {
    if (counts[t] === 0) continue; // vacia: no hay orden que comparar
    const jsonOrder = [];
    for (const r of source[t] || []) {
      if (!r || typeof r !== 'object') continue;
      for (const k of Object.keys(r)) if (!jsonOrder.includes(k)) jsonOrder.push(k);
    }
    const filtered = jsonOrder.filter((k) => colsIn(t).has(k));
    if (JSON.stringify(filtered) !== JSON.stringify(plan[t].columns)) {
      warn(`${t}: el orden del JSON (${filtered.join(',')}) no coincide con el del schema (${plan[t].columns.join(',')}). Se inserta por nombre de columna.`);
    }
  }

  if (problems.length) { out('\nAbortando: hay columnas que no se pueden llenar.'); await ddl.end(); process.exit(1); }

  // --- estado actual del target -------------------------------------------
  stage('3. Estado del target antes de escribir');
  const before = {};
  for (const t of ORDER) {
    const r = await ddl.query(`select count(*)::int n from ${t}`);
    before[t] = r.rows[0].n;
  }
  const totalBefore = Object.values(before).reduce((a, b) => a + b, 0);
  out(`       ${Object.entries(before).map(([k, v]) => `${k}=${v}`).join('  ')}   (${totalBefore} filas)`);

  if (totalBefore > 0 && TARGET === 'app' && !FORCE) {
    out('\n  La base de la app NO esta vacia. Migrar encima BORRA los datos.');
    out('  Si de verdad queres,pasala con --force.');
    await ddl.end();
    process.exit(1);
  }
  if (totalBefore > 0) warn(`el target tiene ${totalBefore} filas: se van a TRUNCAR`);

  if (DRY) {
    stage('4. Dry-run: no se escribio nada');
    out(`  ${problems.length ? 'HAY PROBLEMAS' : 'El plan esta limpio. Correr sin --dry-run para aplicar.'}`);
    await ddl.end();
    process.exit(problems.length ? 1 : 0);
  }

  // -------------------------------------------------------------------------
  // 4. Escribir, en UNA transaccion
  // -------------------------------------------------------------------------
  stage('4. Escribiendo');
  await ddl.query('BEGIN');
  try {
    // CASCADE porque las FKs entre tablas del dominio. El orden de TRUNCATE es
    // irrelevante con CASCADE; el de INSERT no lo es.
    await ddl.query(`truncate ${ORDER.join(', ')} restart identity cascade`);
    ok('tablas vaciadas y secuencias reseteadas');

    // `restart identity` SOLO resetea las secuencias con `owned by`, y
    // `order_number_seq` es justo la que NO lo tiene (schema.sql: el numero de
    // pedido es un texto formateado, no una columna entera). Sin este setval, la
    // migracion dejaba el contador donde estuviera y dos corridas del script
    // producian numeros de pedido distintos para la misma base.
    //
    // `is_called = false` y valor 1: el primer pedido nuevo sale `CS<fecha>-0001`.
    // Los pedidos ya migrados (`CS260930-5475`) no salen de esta secuencia, asi
    // que no hay colision posible con el UNIQUE de `orders.order_number`.
    await ddl.query(`select setval('order_number_seq', 1, false)`);
    out(`       ${'order_number_seq'.padEnd(18)} setval 1 (is_called=false, el primer numero nuevo es -0001)`);

    for (const t of ORDER) {
      const rows = source[t] || [];
      if (!rows.length) { out(`       ${t.padEnd(18)} 0 filas`); continue; }
      const colsList = plan[t].columns;
      const placeholders = colsList.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `insert into ${t} (${colsList.join(', ')}) values (${placeholders})`;
      for (const r of rows) {
        const vals = colsList.map((c) => {
          const v = r[c];
          if (v === undefined) return null;
          if (v === '') return c.endsWith('_at') ? null : v; // '' en timestamp es null
          return v;
        });
        await ddl.query(sql, vals);
      }
      out(`       ${t.padEnd(18)} ${rows.length} filas`);
    }

    // settings: objeto -> key/value.
    if (settingsKeys) {
      for (const [k, v] of Object.entries(source.settings)) {
        await ddl.query('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, v == null ? '' : String(v)]);
      }
      ok(`settings: ${settingsKeys} claves`);
    }

    // --- setval, con el control de colisiones -------------------------------
    out('');
    for (const t of SEQ_TABLES) {
      const jsonSeq = (source.seq && source.seq[t]) || 1;
      const maxId = await ddl.query(`select coalesce(max(id), 0)::int m from ${t}`);
      const max = maxId.rows[0].m;
      // Si el contador del JSON quedo atras del max id real, el setval haria
      // que nextval devuelva un id que YA existe. Se corrige y se avisa.
      const target = Math.max(jsonSeq, max + 1);
      if (target !== jsonSeq) {
        warn(`${t}: seq del JSON (${jsonSeq}) <= max id (${max}). Ajustado a ${target} para no generar ids existentes.`);
      }
      await ddl.query(`select setval('${t}_id_seq', $1, false)`, [target]);
      out(`       ${t.padEnd(18)} setval ${target} (is_called=false, el proximo id es ${target})`);
    }

    await ddl.query('COMMIT');
    ok('COMMIT');
  } catch (e) {
    await ddl.query('ROLLBACK').catch(() => {});
    out(`\n  ROLLBACK: ${e.message}`);
    await ddl.end();
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 5. Verificar: los datos tienen que coincidir con el JSON
  // -------------------------------------------------------------------------
  stage('5. Verificacion contra el JSON de origen');

  let mismatches = 0;
  const check = (label, a, b) => {
    const good = String(a) === String(b);
    if (!good) mismatches++;
    out(`  ${good ? 'OK   ' : 'DIFER'} ${label.padEnd(34)} json=${String(a).padEnd(12)} pg=${b}`);
  };

  for (const t of ORDER) {
    const r = await ddl.query(`select count(*)::int n from ${t}`);
    check(t, counts[t], r.rows[0].n);
  }
  const s = await ddl.query('select count(*)::int n from settings');
  check('settings', settingsKeys, s.rows[0].n);

  // Plata: el total de los pedidos tiene que coincidir al centavo. Es el dato
  // que de verdad importa y el mas facil de corromper sin darse cuenta.
  const jsonTotal = (source.orders || []).reduce((a, o) => a + Number(o.total || 0), 0).toFixed(2);
  const pgTotal = (await ddl.query('select coalesce(sum(total), 0)::text t from orders')).rows[0].t;
  check('suma de orders.total', jsonTotal, Number(pgTotal).toFixed(2));

  const jsonItems = (source.order_items || []).reduce((a, i) => a + Number(i.quantity || 0), 0);
  const pgItems = (await ddl.query('select coalesce(sum(quantity), 0)::int s from order_items')).rows[0].s;
  check('suma de order_items.quantity', jsonItems, pgItems);

  // FKs huerfanas: si el orden de insercion estuvo mal, aparecen aca.
  const orph = await ddl.query(`
    select
      (select count(*)::int from order_items oi left join orders o on o.id = oi.order_id where o.id is null) as items,
      (select count(*)::int from order_items oi left join products p on p.id = oi.product_id where oi.product_id is not null and p.id is null) as prods,
      (select count(*)::int from products p left join categories c on c.id = p.category_id where p.category_id is not null and c.id is null) as cats,
      (select count(*)::int from orders o left join users u on u.id = o.user_id where o.user_id is not null and u.id is null) as users`);
  const o = orph.rows[0];
  for (const [k, label] of [['items', 'order_items -> orders'], ['prods', 'order_items -> products'], ['cats', 'products -> categories'], ['users', 'orders -> users']]) {
    if (o[k] > 0) { mismatches++; err(`${label}: ${o[k]} filas huerfanas`); }
    else ok(`sin huerfanas: ${label}`);
  }

  // PII: verificar que la anonimizacion quedo aplicada de verdad.
  const pii = await ddl.query(`select customer_name, customer_email, shipping_address from orders where order_number = $1`, [ANONYMIZE_ORDER.order_number]);
  if (!pii.rows.length) {
    warn(`el pedido ${ANONYMIZE_ORDER.order_number} no esta en la base`);
  } else {
    const row = pii.rows[0];
    const clean = row.customer_name === ANONYMIZE_ORDER.set.customer_name
      && row.customer_email === ANONYMIZE_ORDER.set.customer_email
      && row.shipping_address === ANONYMIZE_ORDER.set.shipping_address;
    clean ? ok(`pedido ${ANONYMIZE_ORDER.order_number} anonimizado`) : err(`el pedido ${ANONYMIZE_ORDER.order_number} conserva PII`);
  }

  // Proximo id por tabla: prueba funcional del setval.
  out('');
  for (const t of SEQ_TABLES) {
    const want = Math.max((source.seq && source.seq[t]) || 1, counts[t] ? 1 : 1);
    const seqState = await ddl.query(`select last_value, is_called from ${t}_id_seq`);
    const lv = Number(seqState.rows[0].last_value);
    lv === want
      ? ok(`${t}: proximo id = ${lv}`)
      : err(`${t}: proximo id = ${lv}, esperado ${want}`);
  }

  stage('Resultado');
  const totalProblems = problems.length + mismatches;
  if (totalProblems === 0) {
    out(`  MIGRACION VERIFICADA contra ${dbName.d}. ${Object.values(counts).reduce((a, b) => a + b, 0) + settingsKeys} filas, 0 diferencias.`);
  } else {
    out(`  ${totalProblems} problemas. NO tomar esto como una migracion exitosa.`);
  }
  if (TARGET === 'test') out('  (base de tests: nada de esto toco datos de la app)');
  await ddl.end();
  process.exit(totalProblems ? 1 : 0);
})();
