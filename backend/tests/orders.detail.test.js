/**
 * Contrato de respuesta de GET /orders/:id.
 *
 * La pantalla de pedidos del admin (frontend/src/pages/admin/AdminOrders.jsx)
 * pide UN pedido bajo demanda y de ahi saca:
 *   - order.items[] con name / price / quantity / type  (tabla de items)
 *   - order.total                                        (total real del servidor)
 *   - order.customer_name / customer_email
 *   - order.customer_phone / shipping_address / notes    (datos para armar el envio)
 *   - order.order_number / created_at                    (contexto del modal)
 *
 * El endpoint ya hacia el join con order_items, pero la UI recien nacio: si
 * alguien saca un campo, renombra `items` o rompe el join, esta pantalla se
 * rompe en silencio. Estos tests son el contrato.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  backupData,
  restoreData,
  startTestServer,
  createTestProduct,
  createTestService,
  createTestUser,
  CUSTOMER,
  testEmail,
  testDni,
} = require('./helpers');

// Este archivo miraba `store.js` porque los pedidos vivian ahi (fase 4). Ya no:
// los pedidos, el catalogo y los usuarios estan en PostgreSQL, asi que el
// contrato de `GET /orders/:id` se verifica contra la API y nada mas. El require
// del store se fue con el resto.

let api;
let admin;
let customer;
let product;
let service;

// Pedido "rico": 3 lineas (2 productos + 1 servicio) con todos los datos de envio.
let richOrderId;
// Pedido "pelado": sin telefono, sin direccion y sin notas.
let bareOrderId;

const login = async (email, password) => {
  const r = await api.post('/auth/login', { email, password });
  return r.body && r.body.token;
};

before(async () => {
  await backupData();
  api = await startTestServer();
  // Email y DNI unicos por corrida: con el fixture fijo, este admin
  // `admin.detalle@test.com` accumulaba una fila por corrida y `findByEmail`
  // (order by id limit 1) devolvia la primera. Ver helpers.testEmail.
  admin = await createTestUser({ name: 'Admin Detalle', email: testEmail('admin.detalle'), password: 'admin123', dni: testDni('33333333'), role: 'admin' });
  customer = await createTestUser(CUSTOMER);
  product = await createTestProduct({ name: 'Producto Detalle Test', price: 2500, stock: 50 });
  service = await createTestService({ name: 'Servicio Detalle Test', price: 8000 });

  const adminToken = await login(admin.email, admin.password);

  const rich = await api.post('/orders', {
    items: [
      { id: product.id, type: 'product', quantity: 2 },
      { id: service.id, type: 'service', quantity: 1 },
      { id: product.id, type: 'product', quantity: 3 },
    ],
    customer_name: 'Cliente Con Datos',
    customer_email: 'con.datos@test.com',
    customer_phone: '3482558453',
    shipping_address: 'Antonio Taboas 953, Piso 2 Depto B',
    notes: 'Llamar antes de entregar',
  }, { token: adminToken });
  assert.equal(rich.status, 201, 'el pedido de prueba deberia crearse');
  richOrderId = rich.body.order.id;

  const bare = await api.post('/orders', {
    items: [{ id: service.id, type: 'service', quantity: 1 }],
    customer_name: 'Cliente Sin Datos',
    customer_email: 'sin.datos@test.com',
  }, { token: adminToken });
  assert.equal(bare.status, 201, 'el pedido sin datos de envio deberia crearse');
  bareOrderId = bare.body.order.id;
});

after(async () => {
  if (api) await api.close();
  await restoreData();
});

describe('GET /orders/:id - contrato que consume la pantalla de detalle', () => {
  test('el admin obtiene 200 y order.items', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get(`/orders/${richOrderId}`, { token });

    assert.equal(r.status, 200);
    assert.ok(r.body.order, 'la respuesta debe traer { order }');
    assert.ok(Array.isArray(r.body.order.items), 'order.items debe ser un array');
    assert.ok(r.body.order.items.length > 0, 'el pedido tiene items, no puede venir vacio');
  });

  test('cada item trae name, price, quantity y type (lo que pinta la tabla)', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get(`/orders/${richOrderId}`, { token });

    for (const item of r.body.order.items) {
      assert.equal(typeof item.name, 'string', 'name debe ser string');
      assert.ok(item.name.length > 0, 'name no puede venir vacio');
      assert.equal(typeof item.price, 'number', 'price debe ser numerico para calcular el subtotal');
      assert.equal(typeof item.quantity, 'number', 'quantity debe ser numerico');
      assert.ok(Number.isInteger(item.quantity) && item.quantity >= 1, 'quantity debe ser entero >= 1');
      assert.ok(['product', 'service'].includes(item.type), `type inesperado: ${item.type}`);
    }
  });

  test('un pedido con N items devuelve N items (el join no se rompe)', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get(`/orders/${richOrderId}`, { token });

    // El pedido se creo con 3 lineas: 2 productos + 1 servicio.
    assert.equal(r.body.order.items.length, 3, 'deben volver exactamente las 3 lineas del pedido');

    const ids = r.body.order.items.map((i) => i.id);
    assert.equal(new Set(ids).size, 3, 'los items no pueden venir duplicados');
  });

  test('los items conservan quantity > 1 para que la tabla calcule subtotales', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get(`/orders/${richOrderId}`, { token });

    const quantities = r.body.order.items.map((i) => i.quantity).sort((a, b) => a - b);
    assert.deepEqual(quantities, [1, 2, 3], 'las cantidades del pedido deben preservarse tal cual');
  });

  test('los items mezclan tipos product y service', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get(`/orders/${richOrderId}`, { token });

    const types = r.body.order.items.map((i) => i.type).sort();
    assert.deepEqual(types, ['product', 'product', 'service'],
      'la UI distingue producto de servicio con un Badge: los dos tipos deben llegar');
  });

  test('total viene del servidor y coincide con la suma de los items', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get(`/orders/${richOrderId}`, { token });

    const sum = r.body.order.items.reduce((acc, i) => acc + i.price * i.quantity, 0);
    assert.equal(typeof r.body.order.total, 'number', 'total debe ser numerico');
    assert.ok(Math.abs(r.body.order.total - sum) < 0.009,
      `el total del servidor (${r.body.order.total}) debe coincidir con la suma de items (${sum}): la UI muestra ambos y avisa si difieren`);
  });

  test('trae customer_name, customer_email y order_number para el contexto', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get(`/orders/${richOrderId}`, { token });

    assert.equal(r.body.order.customer_name, 'Cliente Con Datos');
    assert.equal(r.body.order.customer_email, 'con.datos@test.com');
    assert.ok(r.body.order.order_number, 'order_number es el titulo del modal');
    assert.ok(r.body.order.created_at, 'created_at se formatea en el modal');
  });

  test('trae customer_phone, shipping_address y notes para armar el envio', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get(`/orders/${richOrderId}`, { token });

    assert.equal(r.body.order.customer_phone, '3482558453');
    assert.equal(r.body.order.shipping_address, 'Antonio Taboas 953, Piso 2 Depto B');
    assert.equal(r.body.order.notes, 'Llamar antes de entregar');
  });

  test('los campos de envio EXISTEN aunque sean null (la UI los distingue de ausente)', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get(`/orders/${bareOrderId}`, { token });

    assert.equal(r.status, 200);
    for (const field of ['shipping_address', 'customer_phone', 'notes']) {
      assert.ok(field in r.body.order,
        `${field} debe estar presente en la respuesta (null, no ausente): la UI muestra "No informo" solo si el campo llega`);
      assert.equal(r.body.order[field], null, `${field} debe valer null cuando el cliente no lo informo`);
    }
  });

  test('un customer NO puede ver el pedido de otro (IDOR) y no filtra datos', async () => {
    const adminToken = await login(admin.email, admin.password);
    const ajeno = await api.post('/orders', {
      items: [{ id: product.id, type: 'product', quantity: 1 }],
      customer_name: 'Pedido Ajeno',
      customer_email: 'ajeno@test.com',
      shipping_address: 'Av. Secreta 123',
    }, { token: adminToken });
    const ajenoId = ajeno.body.order.id;

    const customerToken = await login(customer.email, customer.password);
    const attack = await api.get(`/orders/${ajenoId}`, { token: customerToken });

    assert.equal(attack.status, 403, 'IDOR: un customer no puede ver el pedido de otro');
    assert.equal(attack.body.order, undefined, 'la respuesta no debe filtrar datos del pedido ajeno');
  });

  test('sin token da 401 y un id inexistente da 404', async () => {
    const anon = await api.get(`/orders/${richOrderId}`);
    assert.equal(anon.status, 401, 'el detalle de un pedido no puede ser publico');

    const token = await login(admin.email, admin.password);
    const missing = await api.get('/orders/999999', { token });
    assert.equal(missing.status, 404, 'un pedido inexistente da 404, no 500');
  });
});