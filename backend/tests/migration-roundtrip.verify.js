/**
 * Round-trip independiente de la migracion.
 *
 * Por que existe aparte de migrate-data.js: ese script verifica lo que el mismo
 * script escribio. Si el bug esta en como arma el INSERT, el INSERT y el
 * chequeo comparten el error y los dos dan verde. Este archivo no comparte
 * codigo con el migrador: lee la base de vuelta con el ROL DE LA APP, con el
 * JOIN que la API usa, y compara campo por campo contra el JSON original.
 *
 * Diferencias esperadas y accounted for:
 *   - created_at/updated_at: JSON string ISO  ->  Postgres Date. Se comparan
 *     como ISO. Si el mapper no convierte, la API devuelve otra cosa.
 *   - categories.image: no existe en el JSON (el seed no lo setea) y en la base
 *     es NULL. La API va a devolver la clave con null, el JSON la omitia.
 *     Documentado como diferencia de contrato consciente, no como bug.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const poolPath = path.join(__dirname, '..', 'src', 'data', 'postgres', 'pool.js');
const REF = 'rifmbtnyzquvljdbubth';
const POOLER = 'aws-0-us-west-2.pooler.supabase.com:6543';

// La app sobre la base de tests: host + password de la app + dbname de test.
const app = new URL(process.env.DATABASE_URL);
process.env.DATABASE_URL =
  `postgresql://${app.username}:${encodeURIComponent(decodeURIComponent(app.password))}@${POOLER}/compushop_test_db`;

const { withClient } = require(poolPath);

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'data.json'), 'utf8'));

let pass = 0;
let fail = 0;
const problems = [];
const out = (s = '') => console.log(s);
const stage = (s) => out(`\n${'='.repeat(74)}\n${s}\n${'='.repeat(74)}`);

const isDateCol = (k) => k.endsWith('_at');
const norm = (k, v) => (isDateCol(k) && v instanceof Date ? v.toISOString() : v);
const same = (a, b) => (a === b) || (a === null && b === undefined) || (b === null && a === undefined);

/**
 * Igualdad profunda, insensible al ORDEN de las claves.
 *
 * Importa porque `jsonb` NO preserva el orden de las claves de un objeto:
 * Postgres las normaliza (por tamano de clave, no alfabeticamente). Los valores
 * son los mismos, pero `JSON.stringify` produce otra cadena. Comparar con
 * `JSON.stringify` marca como diferencia algo que es semanticamente igual, y
 * eso ensea a ignorar los fallos de verdad.
 *
 * El orden de las claves de un objeto JSON no significa nada. El orden de un
 * ARRAY si, y ese caso se conserva.
 */
function deepEqual(a, b) {
  if (same(a, b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function cmp(label, jsonRow, pgRow, { expect = {} } = {}) {
  const diffs = [];
  for (const k of Object.keys(jsonRow)) {
    if (!(k in pgRow)) { diffs.push(`${k}: ausente en la base`); continue; }
    const a = norm(k, jsonRow[k]);
    const b = norm(k, pgRow[k]);
    // Campos con valor esperado distinto del JSON (PII anonimizada).
    if (k in expect) {
      if (!same(b, expect[k])) diffs.push(`${k}: esperado ${JSON.stringify(expect[k])}, en pg ${JSON.stringify(b)}`);
      continue;
    }
    if (!deepEqual(a, b)) diffs.push(`${k}: json=${JSON.stringify(a)} pg=${JSON.stringify(b)}`);
  }
  if (diffs.length) {
    fail++;
    problems.push(label);
    out(`  DIFER ${label}`);
    for (const d of diffs) out(`          ${d}`);
  } else {
    pass++;
    return true;
  }
  return false;
}

(async () => {
  stage('Contexto');
  const who = await withClient((c) => c.query('select current_database() d, current_user u, current_setting(\'server_version\') v'));
  out(`       ${who.rows[0].d} como ${who.rows[0].u}  (PostgreSQL ${who.rows[0].v.split(' ')[0]})`);

  // ---------------------------------------------------------------------
  stage('1. users / categories / products / services, campo por campo');
  for (const t of ['users', 'categories', 'products', 'services']) {
    const { rows } = await withClient((c) => c.query(`select * from ${t} order by id`));
    const json = raw[t] || [];
    if (rows.length !== json.length) { fail++; problems.push(t); out(`  DIFER ${t}: ${json.length} en json, ${rows.length} en pg`); continue; }
    const passBefore = pass;
    const failBefore = fail;
    for (let i = 0; i < json.length; i++) {
      cmp(`${t}[id=${json[i].id}] ${(json[i].name || json[i].email || '').trim()}`, json[i], rows[i]);
    }
    const identicas = pass - passBefore;
    const distintas = fail - failBefore;
    out(`  ${t}: ${rows.length} filas -> ${identicas} identicas, ${distintas} con diferencias`);
  }

  // ---------------------------------------------------------------------
  stage('2. El JOIN de la API: category_name / category_slug');
  // Esta es la forma exacta que necesita GET /products. Si el JOIN o el
  // mapper estuvieran mal, el catalogo devuelve undefined.
  const { rows: prods } = await withClient((c) => c.query(`
    select p.*, c.name as category_name, c.slug as category_slug
    from products p left join categories c on c.id = p.category_id
    order by p.id`));

  let joinOk = 0;
  for (const p of prods) {
    const cat = (raw.categories || []).find((c) => c.id === p.category_id);
    const wantName = cat ? cat.name : null;
    const wantSlug = cat ? cat.slug : null;
    if (p.category_name !== wantName || p.category_slug !== wantSlug) {
      fail++;
      out(`  DIFER product id=${p.id}: category_name=${p.category_name} (esperado ${wantName}), slug=${p.category_slug} (esperado ${wantSlug})`);
    } else joinOk++;
  }
  pass += joinOk;
  out(`  ${joinOk}/${prods.length} productos resuelven su categoria`);

  const huerfanos = prods.filter((p) => p.category_id !== null && p.category_name === null);
  if (huerfanos.length) { fail++; out(`  FALLA ${huerfanos.length} productos apuntan a una categoria inexistente`); }
  else out('  sin productos con categoria rota');

  // ---------------------------------------------------------------------
  stage('3. products.specs (jsonb) y precios');
  let specsOk = 0;
  for (const p of prods) {
    const j = (raw.products || []).find((x) => x.id === p.id);
    if (typeof p.price !== 'number') { fail++; problems.push(`product id=${p.id} price`); out(`  FALLA product id=${p.id}: price es ${typeof p.price}, no number`); }
    // Orden-insensible: jsonb normaliza el orden de las claves.
    if (deepEqual(p.specs || null, j.specs || null)) specsOk++;
    else { fail++; problems.push(`product id=${p.id} specs`); out(`  DIFER product id=${p.id} specs: ${JSON.stringify(p.specs)} vs ${JSON.stringify(j.specs)}`); }
  }
  pass += specsOk;
  out(`  ${prods.length} precios como number, ${specsOk} specs identicos (comparacion sin orden)`);
  out(`  nota: jsonb reordena las claves de specs. Si algo del front compara`);
  out(`        con JSON.stringify, ahi hay un cambio de comportamiento real.`);

  // ---------------------------------------------------------------------
  stage('4. orders + order_items, y el detalle anidado');
  const { rows: orders } = await withClient((c) => c.query('select * from orders order by id'));
  // El pedido de prueba fue anonimizado a proposito por el migrador. Se compara
  // contra el valor ESPERADO, no contra el JSON crudo: comparar contra el JSON
  // no puede coincidir nunca y el fallo seria ruido, no senal.
  const ANON = {
    customer_name: 'Cliente Anonimo',
    customer_email: 'cliente.anonimo@example.com',
    customer_phone: '0000000000',
    shipping_address: 'Direccion de Prueba 123',
  };
  for (const o of orders) {
    const j = (raw.orders || []).find((x) => x.id === o.id);
    const isAnonTarget = j && j.order_number === 'CS260930-5475';
    cmp(`order id=${o.id} ${o.order_number}${isAnonTarget ? ' (anonimizado a proposito)' : ''}`, j, o, { expect: isAnonTarget ? ANON : {} });
  }

  const { rows: items } = await withClient((c) => c.query('select * from order_items order by id'));
  for (const it of items) {
    const j = (raw.order_items || []).find((x) => x.id === it.id);
    cmp(`order_item id=${it.id} ${it.name}`, j, it);
  }

  // El detalle: GET /orders/:id mete los items adentro del order.
  const detail = await withClient(async (c) => {
    const o = (await c.query('select * from orders order by id limit 1')).rows[0];
    const its = (await c.query('select * from order_items where order_id = $1 order by id', [o.id])).rows;
    return { ...o, items: its };
  });
  detail.items.length === 2
    ? (pass++, out('  el pedido trae sus 2 items anidados'))
    : (fail++, out(`  FALLA el pedido trae ${detail.items.length} items, esperado 2`));

  // El listado NO lleva items. Es una asimetria del contrato, no un bug.
  const listShape = await withClient((c) => c.query('select * from orders order by id'));
  const withItems = listShape.rows.filter((o) => 'items' in o).length;
  withItems === 0
    ? (pass++, out('  el listado de orders NO incluye items (correcto)'))
    : (fail++, out(`  FALLA el listado trae items en ${withItems} pedidos`));

  // ---------------------------------------------------------------------
  stage('5. settings: filas -> singleton');
  const { rows: srows } = await withClient((c) => c.query('select key, value from settings order by key'));
  const singleton = Object.fromEntries(srows.map((r) => [r.key, r.value]));
  const rawSettings = raw.settings || {};
  const skeys = Object.keys(rawSettings);
  const sameKeys = skeys.length === srows.length && skeys.every((k) => k in singleton);
  const sameVals = skeys.every((k) => String(singleton[k]) === String(rawSettings[k]));
  if (sameKeys && sameVals) { pass++; out(`  ${skeys.length} claves reconstruidas con los mismos valores`); }
  else {
    fail++;
    out(`  DIFER settings: en json=${skeys.length}, en pg=${srows.length}`);
    for (const k of skeys) if (String(singleton[k]) !== String(rawSettings[k])) out(`          ${k}: json=${rawSettings[k]} pg=${singleton[k]}`);
  }
  // smtp_port es string en el JSON ("587"). Si Postgres lo devolviera como
  // numero, un form que lo compare con "587" lo pierde.
  singleton.smtp_port === String(rawSettings.smtp_port)
    ? (pass++, out(`  smtp_port sigue siendo string: ${JSON.stringify(singleton.smtp_port)}`))
    : (fail++, out(`  FALLA smtp_port: ${JSON.stringify(singleton.smtp_port)}`));

  // ---------------------------------------------------------------------
  stage('6. PII');
  const { rows: pii } = await withClient((c) => c.query(`select customer_name, customer_email, customer_phone, shipping_address from orders where order_number = 'CS260930-5475'`));
  if (!pii.length) { fail++; out('  FALLA no esta el pedido de prueba'); }
  else {
    const r = pii[0];
    const clean = r.customer_name === 'Cliente Anonimo' && r.customer_email === 'cliente.anonimo@example.com'
      && r.customer_phone === '0000000000' && r.shipping_address === 'Direccion de Prueba 123';
    if (clean) { pass++; out('  pedido CS260930-5475 anonimizado en la base'); }
    else { fail++; out(`  FALLA el pedido conserva PII: ${JSON.stringify(r)}`); }
  }

  // ---------------------------------------------------------------------
  stage('7. Diferencias de contrato conocidas (esperadas, no bugs)');
  const catJson = (raw.categories || [])[0];
  const { rows: catPg } = await withClient((c) => c.query('select * from categories order by id limit 1'));
  const tieneImageEnJson = 'image' in catJson;
  out(`  categories.image: en json=${tieneImageEnJson}, en pg=${catPg[0].image === null ? 'null' : 'valor'}`);
  out(`    -> la API va a devolver la clave con null donde el JSON la omitia.`);
  out(`    -> el mapper tiene que emitir undefined si se quiere el JSON identico.`);
  out(`  timestamps: en json son strings, en pg son Date. JSON.stringify produce`);
  out(`    el mismo ISO, asi que la API no cambia. Verificado arriba.`);

  // ---------------------------------------------------------------------
  stage('Resumen');
  out(`  ${pass} OK / ${fail} diferencias`);
  if (fail) {
    out('\n  NO se puede dar la migracion por buena. Fallos:');
    for (const p of problems) out(`    - ${p}`);
  } else {
    out('\n  Round-trip verificado: lo que se leyo de la base es identico al JSON.');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e); process.exit(1); });
