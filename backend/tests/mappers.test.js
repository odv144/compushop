// Test de los mappers. Puros: sin DB, sin env, sin red.
// El motivo de que sea un archivo y no un bloque en el verify de la capa de
// datos: los mappers son donde vive el CONTRATO. Si un mapper devuelve null
// donde debia devolver undefined, ningun test de integracion que compare
// counts lo va a avisar. Solo un test que mire el JSON serializado.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const m = require('../src/data/postgres/mappers.js');

test('optional: null se vuelve undefined, el resto pasa', () => {
  assert.equal(m.optional(null), undefined);
  assert.equal(m.optional(0), 0);
  assert.equal(m.optional(''), '');
  assert.equal(m.optional(false), false);
});

// Este es EL test que importa. La trampa: JSON.stringify omite undefined pero
// serializa null. Si esto falla, cambio el JSON que ve el frontend.
test('productList SIN categoria omite las claves, no las pone en null', () => {
  const row = { id: 1, name: 'X', category_id: null, category_name: null, category_slug: null };
  const out = m.productList(row);

  assert.equal(out.category_name, undefined);
  assert.equal(out.category_slug, undefined);

  const json = JSON.parse(JSON.stringify(out));
  assert.equal('category_name' in json, false, 'category_name no debe aparecer en el JSON');
  assert.equal('category_slug' in json, false, 'category_slug no debe aparecer en el JSON');
  assert.equal(json.id, 1, 'el resto del producto sigue intacto');
});

test('productList CON categoria las trae', () => {
  const out = m.productList({ id: 1, category_name: 'Notebooks', category_slug: 'notebooks' });
  assert.equal(out.category_name, 'Notebooks');
  assert.equal(out.category_slug, 'notebooks');
  const json = JSON.parse(JSON.stringify(out));
  assert.equal(json.category_name, 'Notebooks');
});

test('productBare saca los campos de categoria (POST y PUT no los traian)', () => {
  const out = m.productBare({ id: 1, name: 'X', category_name: 'Notebooks', category_slug: 'notebooks' });
  assert.equal('category_name' in out, false);
  assert.equal('category_slug' in out, false);
  assert.equal(out.id, 1);
});

test('productBare ignora category_id: es un campo real de la fila', () => {
  // category_id SI existe en el store JSON y viaja en las respuestas. Lo que no
  // viaja es el nombre/slug resuelto.
  const out = m.productBare({ id: 1, category_id: 7 });
  assert.equal(out.category_id, 7);
});

test('categoryWithCount: product_count es number, y 0 no se pierde', () => {
  assert.equal(m.categoryWithCount({ id: 1, product_count: '0' }).product_count, 0);
  assert.equal(typeof m.categoryWithCount({ id: 1, product_count: '0' }).product_count, 'number');
  // count() devuelve bigint -> string. Sin Number() la API devolveria "3".
  assert.equal(m.categoryWithCount({ id: 1, product_count: '3' }).product_count, 3);
  // ausente -> 0, no undefined (undefined se omitiria del JSON)
  assert.equal(m.categoryWithCount({ id: 1 }).product_count, 0);
  assert.equal('product_count' in JSON.parse(JSON.stringify(m.categoryWithCount({ id: 1 }))), true);
});

test('categoryBare saca product_count', () => {
  const out = m.categoryBare({ id: 1, name: 'C', product_count: '5' });
  assert.equal('product_count' in out, false);
  assert.equal(out.name, 'C');
});

test('userSafe NUNCA deja pasar el password', () => {
  const out = m.userSafe({ id: 1, name: 'A', password: '$2a$10$hash' });
  assert.equal('password' in out, false);
  assert.equal('password' in JSON.parse(JSON.stringify(out)), false);
  assert.equal(out.id, 1);
});

test('settingsFromRows reconstruye el singleton y castea a string', () => {
  const s = m.settingsFromRows([
    { key: 'store_name', value: 'Compushop' },
    { key: 'smtp_port', value: '587' },
  ]);
  assert.equal(s.store_name, 'Compushop');
  // El store JSON guardaba TODOS los valores como string. smtp_port como
  // numero rompe el <Input value={settings.smtp_port}> del admin.
  assert.equal(typeof s.smtp_port, 'string');
  assert.equal(s.smtp_port, '587');
});

test('settingsFromRows con tabla vacia devuelve {}', () => {
  assert.deepEqual(m.settingsFromRows([]), {});
});

test('order NO trae items; orderWithItems si', () => {
  const row = { id: 1, order_number: 'CS1', total: 100 };
  assert.equal('items' in m.order(row), false);
  const det = m.orderWithItems(row, [{ id: 9, name: 'P', quantity: 2 }]);
  assert.equal(det.items.length, 1);
  assert.equal(det.items[0].quantity, 2);
  assert.equal(det.total, 100, 'el order mantiene sus campos');
});

test('orderWithItems con lista vacia trae items: [] y no undefined', () => {
  // Un pedido recien creado con items en blanco: la clave tiene que existir,
  // porque el front hace order.items.map(...).
  const det = m.orderWithItems({ id: 1 }, []);
  assert.equal('items' in det, true);
  assert.deepEqual(det.items, []);
});

test('paginated calcula pages con ceil', () => {
  assert.deepEqual(m.paginated({ page: 1, limit: 20, total: 45 }), { page: 1, limit: 20, total: 45, pages: 3 });
  assert.deepEqual(m.paginated({ page: 1, limit: 20, total: 40 }), { page: 1, limit: 20, total: 40, pages: 2 });
  assert.deepEqual(m.paginated({ page: 1, limit: 20, total: 0 }), { page: 1, limit: 20, total: 0, pages: 0 });
});

test('paginationFixed conserva el pages:1 clavado que ya consume el front', () => {
  // No es que este mal: es que cambiarlo en el mismo PR que la migracion
  // hace imposible saber que rompio que.
  assert.deepEqual(m.paginationFixed(300, 50), { page: 1, limit: 50, total: 300, pages: 1 });
  assert.deepEqual(m.paginationFixed(0, 100), { page: 1, limit: 100, total: 0, pages: 1 });
});

test('los mappers no mutan la fila de origen', () => {
  const row = { id: 1, category_name: null, password: 'x' };
  m.productList(row);
  m.userSafe(row);
  assert.equal(row.category_name, null, 'la fila original sigue intacta');
  assert.equal(row.password, 'x');
});

test('timestamps Date se dejan pasar: JSON.stringify da el mismo ISO', () => {
  const iso = '2026-10-01T16:23:29.169Z';
  const out = m.productList({ id: 1, created_at: new Date(iso) });
  // El store JSON guardaba el string. Si el mapper lo convirtiese a otro
  // formato, el front veria una fecha distinta.
  assert.equal(JSON.parse(JSON.stringify(out)).created_at, iso);
});
