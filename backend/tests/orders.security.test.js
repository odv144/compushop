/**
 * Regresion de seguridad: POST /orders no debe confiar en el body del cliente.
 *
 * Contexto: antes del commit 12f946c, el total se calculaba con item.price
 * del body. Un curl podia comprar cualquier producto a $1 y el stock se
 * descontaba igual. Un quantity negativa incrementaba el stock.
 *
 * Si estos tests fallan, alguien reintrodujo la vulnerabilidad.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { backupData, restoreData, startTestServer, createTestProduct } = require('./helpers');

let api;
let product;

before(async () => {
  backupData();
  api = await startTestServer();
  product = createTestProduct({ name: 'Notebook Test Carissima', price: 689999, stock: 50 });
});

after(async () => {
  if (api) await api.close();
  restoreData();
});

const order = (items) =>
  api.post('/orders', {
    items,
    customer_name: 'Atacante',
    customer_email: 'attacker@evil.com',
    shipping_address: 'Av. Falsa 123',
  });

const stockOf = (id) =>
  api.get(`/products/${id}`).then((r) => r.body.product.stock);

describe('POST /orders - precios controlados por el cliente', () => {
  test('ignora el price del body y cobra el precio real de la DB', async () => {
    const r = await order([{ id: product.id, type: 'product', name: 'CUALQUIER COSA', price: 1, quantity: 1 }]);

    assert.equal(r.status, 201, 'el pedido deberia aceptarse');
    assert.equal(r.body.order.total, 689999, 'el total DEBE salir del store, no del body');
  });

  test('ignora el name del body y usa el nombre real', async () => {
    const r = await order([{ id: product.id, type: 'product', name: 'iPhone 17 Pro Max', price: 999999, quantity: 1 }]);

    assert.equal(r.body.order.items[0].name, 'Notebook Test Carissima');
  });

  test('persiste el precio real en order_items, no el del body', async () => {
    const r = await order([{ id: product.id, type: 'product', name: 'x', price: 1, quantity: 1 }]);

    assert.equal(r.body.order.items[0].price, 689999, 'order_items debe guardar el precio real');
  });

  test('precio 0 en el body no produce un pedido gratis', async () => {
    const r = await order([{ id: product.id, type: 'product', name: 'x', price: 0, quantity: 1 }]);

    assert.equal(r.body.order.total, 689999);
  });

  test('precio negativo en el body no genera un total negativo', async () => {
    const r = await order([{ id: product.id, type: 'product', name: 'x', price: -500000, quantity: 1 }]);

    assert.ok(r.body.order.total > 0, `total debe ser positivo, fue ${r.body.order.total}`);
  });

  test('acepta el slug en lugar del id', async () => {
    const r = await order([{ id: product.slug, type: 'product', name: 'x', price: 1, quantity: 1 }]);

    assert.equal(r.status, 201);
    assert.equal(r.body.order.total, 689999);
  });
});

describe('POST /orders - validacion de cantidad', () => {
  for (const q of [-1, -100, 0, 1.5, 'abc', {}, null]) {
    test(`rechaza quantity = ${JSON.stringify(q)}`, async () => {
      const r = await order([{ id: product.id, type: 'product', quantity: q }]);

      assert.equal(r.status, 400, `debio rechazar, devolvio ${r.status}`);
    });
  }

  test('una cantidad negativa NO incrementa el stock', async () => {
    const before = await stockOf(product.id);

    await order([{ id: product.id, type: 'product', quantity: -10 }]);

    const after = await stockOf(product.id);
    assert.equal(after, before, 'el stock no debe moverse con una cantidad rechazada');
  });

  test('el total siempre cumple total = suma(precio_real * cantidad)', async () => {
    const r = await order([{ id: product.id, type: 'product', name: 'x', price: 1, quantity: 3 }]);

    const expected = 689999 * 3;
    assert.equal(r.body.order.total, expected);
  });
});

describe('POST /orders - existencia y stock', () => {
  test('rechaza un producto inexistente', async () => {
    const r = await order([{ id: 999999, type: 'product', name: 'Fantasma', price: 1, quantity: 1 }]);

    assert.equal(r.status, 400);
  });

  test('rechaza un slug inexistente', async () => {
    const r = await order([{ id: 'no-existe-este-slug', type: 'product', name: 'x', price: 1, quantity: 1 }]);

    assert.equal(r.status, 400);
  });

  test('rechaza un producto inactivo aunque el body diga price=0', async () => {
    const inactivo = createTestProduct({ name: 'Producto Retirado', price: 99999, stock: 10, is_active: false });

    const r = await order([{ id: inactivo.id, type: 'product', name: 'x', price: 0, quantity: 1 }]);

    assert.equal(r.status, 400, 'no se puede comprar un producto inactivo');
  });

  test('rechaza stock insuficiente', async () => {
    const r = await order([{ id: product.id, type: 'product', quantity: 99999 }]);

    assert.equal(r.status, 400);
  });

  test('descuenta exactamente la cantidad comprada', async () => {
    const before = await stockOf(product.id);

    const r = await order([{ id: product.id, type: 'product', quantity: 2 }]);

    assert.equal(r.status, 201);
    assert.equal(await stockOf(product.id), before - 2);
  });

  // Regresion: el check de stock corria item por item contra el stock SIN
  // descontar, en un loop separado del que hacia el descuento. Mandar el mismo
  // producto dos veces pasaba los dos checks y dejaba el stock en negativo.
  test('el MISMO producto dos veces no puede dejar el stock en negativo', async () => {
    const scarce = createTestProduct({ name: 'Stock Escaso', price: 1000, stock: 1 });

    const r = await order([
      { id: scarce.id, type: 'product', quantity: 1 },
      { id: scarce.id, type: 'product', quantity: 1 },
    ]);

    assert.equal(r.status, 400, 'stock=1 no alcanza para 2 unidades del mismo producto');
    assert.equal(await stockOf(scarce.id), 1, 'el stock no puede quedar en negativo');
  });

  test('cantidades agregadas del mismo producto se suman para validar stock', async () => {
    const scarce = createTestProduct({ name: 'Stock Escaso Dos', price: 1000, stock: 3 });

    const r = await order([
      { id: scarce.id, type: 'product', quantity: 2 },
      { id: scarce.id, type: 'product', quantity: 3 },
    ]);

    assert.equal(r.status, 400, '2+3=5 supera el stock=3 aunque cada item pase solo');
    assert.equal(await stockOf(scarce.id), 3);
  });

  test('el agregado no rompe el caso valido: mismo producto 2 veces con stock suficiente', async () => {
    const ok = createTestProduct({ name: 'Stock Suficiente', price: 1000, stock: 10 });

    const r = await order([
      { id: ok.id, type: 'product', quantity: 2 },
      { id: ok.id, type: 'product', quantity: 3 },
    ]);

    assert.equal(r.status, 201);
    assert.equal(await stockOf(ok.id), 5, 'descuenta la suma de las dos lineas');
    assert.equal(r.body.order.items.length, 2, 'mantiene las dos lineas del pedido');
    assert.equal(r.body.order.total, 1000 * 5, 'el total suma ambas lineas');
  });
});

describe('POST /orders - servicios', () => {
  test('un servicio se resuelve por el store, no por el body', async () => {
    const services = await api.get('/services?active=all');
    const svc = services.body.services[0];
    const realPrice = svc.price;

    const r = await order([{ id: svc.id, type: 'service', name: 'Servicio Inventado', price: 0, quantity: 1 }]);

    assert.equal(r.status, 201);
    assert.equal(r.body.order.items[0].price, realPrice, 'el precio del servicio sale del store');
  });

  test('un servicio inexistente es rechazado', async () => {
    const r = await order([{ id: 888888, type: 'service', name: 'x', price: 0, quantity: 1 }]);

    assert.equal(r.status, 400);
  });
});

describe('POST /orders - validacion basica', () => {
  test('rechaza pedido sin items', async () => {
    const r = await api.post('/orders', { items: [], customer_name: 'x', customer_email: 'x@x.com' });

    assert.equal(r.status, 400);
  });

  test('rechaza pedido sin customer_email', async () => {
    const r = await api.post('/orders', { items: [{ id: product.id, type: 'product', quantity: 1 }], customer_name: 'x' });

    assert.equal(r.status, 400);
  });
});
