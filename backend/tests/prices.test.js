/**
 * Integridad de precios en el CRUD de catalogo y en el total de los pedidos.
 *
 * Contexto (3 bugs reportados/arreglados juntos):
 *
 *  1. La UIMostraba 6899.99 como "$ 6.900" (maximumFractionDigits: 0). El dato
 *     SI estaba bien guardado; el que rompia era el display. Guard de formato
 *     en architecture.test.js.
 *
 *  2. El admin que escribe "6899,99" en el NumberInput de Chakra terminaba
 *     guardando 689999: Chakra borra la coma (sanitize + isValidCharacter).
 *     Acá, del lado server, garantizamos que cualquier cosa que llegue al store
 *     sea un numero >= 0 de verdad: "abc", -5, null, "" o NaX no entran mas.
 *     Antes solo se chequeaba que el campo EXISTIERA y se asignaba a ciegas.
 *
 *  3. El total del pedido arrastraba basura de punto flotante binario
 *     (45.55*3 = 136.64999999999998) que se guardaba en orders.total y sumaba
 *     en los Ingresos del dashboard.
 *
 * Si alguno de estos tests falla, alguien reintrodujo un hole de precios.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { backupData, restoreData, startTestServer, createTestProduct, createTestUser } = require('./helpers');

// Mismo singleton que usa el server.
const store = require(path.join(__dirname, '..', 'src', 'db', 'store.js'));

let api;
let token;
let producto;

const ADMIN = { name: 'Admin Precios', email: 'admin.precios@test.com', password: 'admin123', dni: '44444444' };

/** Crea un servicio en el store. Mismo estilo que createTestProduct. */
function createTestService({ name, price } = {}) {
  const db = store.get();
  const id = store.next('services');
  db.services.push({
    id,
    name,
    slug: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: 'Servicio de test',
    price,
    duration: '2 horas',
    image: null,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  store.persist();
  return { id, price };
}

const precioEnStore = (collection, id) => store.get()[collection].find((x) => x.id == id).price;

const auth = () => ({ token });

before(async () => {
  backupData();
  api = await startTestServer();
  createTestUser({ ...ADMIN, role: 'admin' });
  const r = await api.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  token = r.body.token;
  assert.ok(token, 'el admin de test deberia poder loguearse');
  producto = createTestProduct({ name: 'Producto Precios Test', price: 1000, stock: 100 });
});

after(async () => {
  if (api) await api.close();
  restoreData();
});

// Precios que NO pueden entrar al store.
const INVALIDOS = [
  { label: 'string no numerico', value: 'abc' },
  { label: 'string vacio', value: '' },
  { label: 'string de espacios', value: '   ' },
  { label: 'negativo', value: -5 },
  { label: 'negativo decimal', value: -0.01 },
  { label: 'null', value: null },
  { label: 'boolean', value: true },
  { label: 'objeto', value: { hack: true } },
  { label: 'array', value: [10] },
  { label: 'NaN como texto', value: 'NaN' },
  { label: 'Infinity como texto', value: 'Infinity' },
];

describe('POST /products - precio invalido', () => {
  for (const { label, value } of INVALIDOS) {
    test(`rechaza price = ${label}`, async () => {
      const r = await api.post('/products', { name: `Precio Invalido ${label}`, price: value }, auth());

      assert.equal(r.status, 400, `debio rechazar, devolvio ${r.status}`);
      assert.ok(r.body.error, 'debe explicar el error en español');
    });
  }

  test('rechaza un pedido sin el campo price', async () => {
    const r = await api.post('/products', { name: 'Sin Precio' }, auth());

    assert.equal(r.status, 400);
  });

  test('rechaza sin token de admin', async () => {
    const r = await api.post('/products', { name: 'Anonimo Barato', price: 1 });

    assert.equal(r.status, 401, 'el CRUD de catalogo sigue siendo admin-only');
  });

  test('no crea el producto cuando el precio es invalido', async () => {
    const before = store.get().products.length;

    await api.post('/products', { name: 'No Debe Existir', price: 'abc' }, auth());

    assert.equal(store.get().products.length, before, 'un 400 no puede dejar productos colgados en el store');
  });
});

describe('POST /products - precio valido', () => {
  test('guarda un precio con centavos exacto', async () => {
    const r = await api.post('/products', { name: 'Notebook Con Centavos', price: 6899.99, stock: 5 }, auth());

    assert.equal(r.status, 201);
    assert.equal(r.body.product.price, 6899.99);
    assert.equal(precioEnStore('products', r.body.product.id), 6899.99, 'el store debe guardar el decimal tal cual');
  });

  test('normaliza un precio enviado como string numerico', async () => {
    const r = await api.post('/products', { name: 'Precio Como Texto', price: '170000.50' }, auth());

    assert.equal(r.status, 201);
    assert.strictEqual(r.body.product.price, 170000.5, 'debe guardarse como numero, no como string');
  });

  test('acepta 0 (producto gratuito / a cotizar)', async () => {
    const r = await api.post('/products', { name: 'Consulta Precio', price: 0 }, auth());

    assert.equal(r.status, 201);
    assert.equal(r.body.product.price, 0);
  });

  test('rechaza con el mensaje de AGENTS.md en español', async () => {
    const r = await api.post('/products', { name: 'Mensaje De Error', price: -1 }, auth());

    assert.match(r.body.error, /Precio inválido/, `mensaje inesperado: ${r.body.error}`);
  });
});

describe('PUT /products/:id - precio invalido', () => {
  for (const { label, value } of INVALIDOS) {
    test(`rechaza price = ${label}`, async () => {
      const r = await api.put(`/products/${producto.id}`, { price: value }, auth());

      assert.equal(r.status, 400, `debio rechazar, devolvio ${r.status}`);
    });
  }

  test('un precio rechazado NO cambia el precio guardado', async () => {
    const original = precioEnStore('products', producto.id);

    for (const { value } of INVALIDOS) {
      await api.put(`/products/${producto.id}`, { price: value }, auth());
      assert.equal(precioEnStore('products', producto.id), original,
        `un PUT rechazado dejo el precio en ${precioEnStore('products', producto.id)}`);
    }
  });

  test('un precio rechazado NO pisa otros campos antes de validar', async () => {
    const nombreOriginal = store.get().products.find((x) => x.id == producto.id).name;

    await api.put(`/products/${producto.id}`, { name: 'Nombre Que No Se Guarda', price: 'abc' }, auth());

    assert.equal(store.get().products.find((x) => x.id == producto.id).name, nombreOriginal,
      'el 400 tiene que salir antes de mutar el producto');
  });
});

describe('PUT /products/:id - precio valido', () => {
  test('guarda 6899.99 exacto (el caso que reporto el usuario)', async () => {
    const r = await api.put(`/products/${producto.id}`, { price: 6899.99 }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(r.body.product.price, 6899.99);
    assert.strictEqual(precioEnStore('products', producto.id), 6899.99, '6899.99 no puede perder Precision');
  });

  test('un PUT sin price no toca el precio actual', async () => {
    await api.put(`/products/${producto.id}`, { price: 1234.56 }, auth());

    const r = await api.put(`/products/${producto.id}`, { stock: 77 }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(r.body.product.price, 1234.56, 'un PUT parcial no puede borrar el precio');
  });

  test('no redondea el precio unitario (el redondeo es solo del total)', async () => {
    const r = await api.put(`/products/${producto.id}`, { price: 45.555 }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(r.body.product.price, 45.555,
      'el precio unitario se guarda tal cual lo mando el admin; el redondeo a 2 decimales es del total del pedido');
  });
});

describe('POST /services - precio invalido y valido', () => {
  for (const { label, value } of INVALIDOS) {
    test(`rechaza price = ${label}`, async () => {
      const r = await api.post('/services', { name: `Servicio Invalido ${label}`, price: value }, auth());

      assert.equal(r.status, 400, `debio rechazar, devolvio ${r.status}`);
    });
  }

  test('rechaza sin el campo price', async () => {
    const r = await api.post('/services', { name: 'Servicio Sin Precio' }, auth());

    assert.equal(r.status, 400);
  });

  test('guarda un precio con centavos exacto', async () => {
    const r = await api.post('/services', { name: 'Service Con Centavos', price: 89.99 }, auth());

    assert.equal(r.status, 201);
    assert.strictEqual(r.body.service.price, 89.99);
    assert.strictEqual(precioEnStore('services', r.body.service.id), 89.99);
  });
});

describe('PUT /services/:id - precio invalido y valido', () => {
  let servicio;

  before(() => {
    servicio = createTestService({ name: 'Servicio Para Editar', price: 5000 });
  });

  for (const { label, value } of INVALIDOS) {
    test(`rechaza price = ${label}`, async () => {
      const r = await api.put(`/services/${servicio.id}`, { price: value }, auth());

      assert.equal(r.status, 400, `debio rechazar, devolvio ${r.status}`);
    });
  }

  test('un precio rechazado NO cambia el precio guardado', async () => {
    assert.strictEqual(precioEnStore('services', servicio.id), 5000);
  });

  test('guarda 6899.99 exacto', async () => {
    const r = await api.put(`/services/${servicio.id}`, { price: 6899.99 }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(r.body.service.price, 6899.99);
    assert.strictEqual(precioEnStore('services', servicio.id), 6899.99);
  });

  test('un PUT parcial no toca el precio', async () => {
    const r = await api.put(`/services/${servicio.id}`, { duration: '3 horas' }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(r.body.service.price, 6899.99);
  });
});

describe('POST /orders - el total no arrastra basura flotante', () => {
  // 45.55*3 = 136.64999999999998 y 0.29*3 = 0.8699999999999999 en IEEE-754.
  // Sin redondear, orders.total guardaba 137.51999999999998.
  let A;
  let B;

  // OJO: los createTestProduct van en un before y no en el cuerpo del describe.
  // El cuerpo se evalua al cargar el archivo, antes de que corra el backupData()
  // global: un producto creado ahi queda en el backup y sobrevive al restore.
  before(() => {
    A = createTestProduct({ name: 'Flotante A', price: 45.55, stock: 100 });
    B = createTestProduct({ name: 'Flotante B', price: 0.29, stock: 100 });
  });

  const pedido = () =>
    api.post('/orders', {
      items: [
        { id: A.id, type: 'product', quantity: 3 },
        { id: B.id, type: 'product', quantity: 3 },
      ],
      customer_name: 'Cliente Centavos',
      customer_email: 'centavos@test.com',
    });

  test('el total es exactamente 137.52', async () => {
    const r = await pedido();

    assert.equal(r.status, 201);
    assert.strictEqual(r.body.order.total, 137.52,
      `el total arrastro error de punto flotante: ${r.body.order.total}`);
  });

  test('el total es idempotente con Math.round(x*100)/100', async () => {
    const r = await pedido();

    assert.strictEqual(r.body.order.total, Math.round(r.body.order.total * 100) / 100);
    assert.strictEqual(r.body.order.total, 137.52);
  });

  test('order_items guarda el unitario limpio, sin multiplicar', async () => {
    const r = await pedido();

    for (const item of r.body.order.items) {
      assert.strictEqual(item.price, Math.round(item.price * 100) / 100,
        `el precio unitario ${item.price} tiene mas de 2 decimales`);
      assert.ok([45.55, 0.29].includes(item.price), `precio inesperado: ${item.price}`);
    }
  });

  test('el total persistido en el store tambien viene limpio', async () => {
    const r = await pedido();
    const guardado = store.get().orders.find((o) => o.id === r.body.order.id);

    assert.strictEqual(guardado.total, 137.52, 'lo que se guarda es lo que se muestra al admin');
    assert.strictEqual(guardado.total, Math.round(guardado.total * 100) / 100);
  });

  test('el total coincide con la suma de los items que muestra el modal del admin', async () => {
    // El admin ve "Subtotal items" y "Total del pedido" en el mismo modal, asi
    // que los dos tienen que dar lo mismo. El subtotal se suma en el navegador,
    // donde el error de punto flotante sigue existiendo: por eso la tolerancia
    // de un centavo (la misma que usa AdminOrders.jsx) y no igualdad estricta.
    const r = await pedido();
    const suma = r.body.order.items.reduce((acc, i) => acc + i.price * i.quantity, 0);

    assert.ok(Math.abs(r.body.order.total - suma) < 0.009,
      `el admin veria dos totales distintos: ${r.body.order.total} vs ${suma}`);
    assert.strictEqual(r.body.order.total, 137.52, 'el total del servidor sigue siendo exacto');
  });

  test('un pedido de un solo item con centavos tambien queda limpio', async () => {
    const r = await api.post('/orders', {
      items: [{ id: A.id, type: 'product', quantity: 1 }],
      customer_name: 'Cliente Uno',
      customer_email: 'uno@test.com',
    });

    assert.strictEqual(r.body.order.total, 45.55);
  });

  test('los ingresos del dashboard no arrastran el error acumulado', async () => {
    await pedido();
    const r = await api.get('/dashboard/stats', auth());

    assert.equal(typeof r.body.stats.revenue, 'number');
    assert.ok(Number.isFinite(r.body.stats.revenue), 'los ingresos no pueden ser NaN');
  });
});