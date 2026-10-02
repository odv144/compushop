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
const {
  backupData,
  restoreData,
  startTestServer,
  createTestProduct,
  createTestService,
  createTestUser,
  testEmail,
  testDni,
} = require('./helpers');

// La capa de datos: TODOS los precios de este archivo se leen y se escriben
// aca. Desde la fase 4 el store JSON no participa en ninguno: ni en el CRUD del
// catalogo, ni en el total de un pedido.
const repo = require(path.join(__dirname, '..', 'src', 'data', 'repo.js'));

let api;
let token;
let producto;

// Email y DNI unicos por corrida: con el fixture fijo, una corrida
// interrumpida dejaba otro `admin.precios@test.com` y `findByEmail`
// (order by id limit 1) autenticaba el de la corrida vieja. Ver helpers.testEmail.
const ADMIN = {
  name: 'Admin Precios',
  email: testEmail('admin.precios'),
  password: 'admin123',
  dni: testDni('44444444'),
};

/**
 * El precio COMO QUEDA en la base, leido por la capa de datos.
 *
 * Antes era `store.get()[collection].find(...)`. Ahora el producto vive en
 * Postgres y el store solo tiene la copia que `POST /orders` necesita, asi que
 * leer el store probaria la copia, no el dato. `assert.strictEqual` y no
 * `assert.equal` a proposito: 6899.99 tiene que ser el MISMO numero, no uno que
 * se parece.
 */
async function precioEnRepo(coleccion, id) {
  const fila = await repo[coleccion].findByIdOrSlug(id);
  assert.ok(fila, `no existe ${coleccion} ${id} para leer el precio`);
  return Number(fila.price);
}

const auth = () => ({ token });

before(async () => {
  await backupData();
  api = await startTestServer();
  await createTestUser({ ...ADMIN, role: 'admin' });
  const r = await api.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
  token = r.body.token;
  assert.ok(token, 'el admin de test deberia poder loguearse');
  producto = await createTestProduct({ name: 'Producto Precios Test', price: 1000, stock: 100 });
});

after(async () => {
  if (api) await api.close();
  await restoreData();
});

// Precios que NO pueden entrar a la base.
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
  // Menos de 2 decimales que NO es representable en numeric(14,2). Postgres
  // la redondearia solo (0.0001 -> 0.0000) y el admin creeria haber guardado
  // un precio de 0 que nunca escribio. Con la regla nueva es un 400 explicito.
  { label: 'mas de 2 decimales', value: 45.555 },
  { label: 'mas de 2 decimales en texto', value: '6899.999' },
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
    const before = await repo.products.list({ active: false, page: 1, limit: 1 });

    await api.post('/products', { name: 'No Debe Existir', price: 'abc' }, auth());

    const after = await repo.products.list({ active: false, page: 1, limit: 1 });
    assert.equal(after.pagination.total, before.pagination.total,
      'un 400 no puede dejar productos colgados en la base');
  });
});

describe('POST /products - precio valido', () => {
  test('guarda un precio con centavos exacto', async () => {
    const r = await api.post('/products', { name: 'Notebook Con Centavos', price: 6899.99, stock: 5 }, auth());

    assert.equal(r.status, 201);
    assert.equal(r.body.product.price, 6899.99);
    assert.equal(await precioEnRepo('products', r.body.product.id), 6899.99, 'la base debe guardar el decimal tal cual');
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
    const original = await precioEnRepo('products', producto.id);

    for (const { value } of INVALIDOS) {
      await api.put(`/products/${producto.id}`, { price: value }, auth());
      assert.equal(await precioEnRepo('products', producto.id), original,
        `un PUT rechazado dejo el precio en ${await precioEnRepo('products', producto.id)}`);
    }
  });

  test('un precio rechazado NO pisa otros campos antes de validar', async () => {
    const nombreOriginal = (await repo.products.findByIdOrSlug(producto.id)).name;

    await api.put(`/products/${producto.id}`, { name: 'Nombre Que No Se Guarda', price: 'abc' }, auth());

    const actual = await repo.products.findByIdOrSlug(producto.id);
    assert.equal(actual.name, nombreOriginal, 'el 400 tiene que salir antes de mutar el producto');
  });
});

describe('PUT /products/:id - precio valido', () => {
  test('guarda 6899.99 exacto (el caso que reporto el usuario)', async () => {
    const r = await api.put(`/products/${producto.id}`, { price: 6899.99 }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(r.body.product.price, 6899.99);
    assert.strictEqual(await precioEnRepo('products', producto.id), 6899.99, '6899.99 no puede perder Precision');
  });

  test('un PUT sin price no toca el precio actual', async () => {
    await api.put(`/products/${producto.id}`, { price: 1234.56 }, auth());

    const r = await api.put(`/products/${producto.id}`, { stock: 77 }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(r.body.product.price, 1234.56, 'un PUT parcial no puede borrar el precio');
  });

  test('rechaza un precio con mas de 2 decimales en vez de redondear', async () => {
    // ANTES (store JSON): este test exigia 200 y 45.555 guardado tal cual, y el
    // comentario explicaba que el redondeo era "solo del total". Con numeric(14,2)
    // ese contrato es imposible: Postgres redondea 45.555 -> 45.56 (banker's
    // rounding) y el admin leeria un precio que no escribio. Ademas el item de
    // un pedido arrastraba el tercer decimal dentro del total.
    // Ahora la regla es maxima 2 decimales en el puerto, y el 400 es explicito.
    const r = await api.put(`/products/${producto.id}`, { price: 45.555 }, auth());

    assert.equal(r.status, 400, `debio rechazar, devolvio ${r.status}`);
    assert.match(r.body.error, /decimal/i, `mensaje inesperado: ${r.body.error}`);
  });

  test('el precio sigue intacto despues del rechazo por precision', async () => {
    assert.strictEqual(await precioEnRepo('products', producto.id), 1234.56);
  });

  test('acepta exactamente 2 decimales (el limite es inclusivo)', async () => {
    const r = await api.put(`/products/${producto.id}`, { price: 45.55 }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(await precioEnRepo('products', producto.id), 45.55);
  });

  test('un string con ceros de mas no cuenta como mas decimales', async () => {
    // "6899.5500" tiene 4 decimales de texto pero el numero es 6899.55, y eso
    // SI entra en numeric(14,2). Si se mirara la cadena, el admin veria un
    // rechazo sin explicacion cuando escribio un precio perfectamente valido.
    const r = await api.put(`/products/${producto.id}`, { price: '6899.5500' }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(await precioEnRepo('products', producto.id), 6899.55);
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
    assert.strictEqual(await precioEnRepo('services', r.body.service.id), 89.99);
  });
});

describe('PUT /services/:id - precio invalido y valido', () => {
  let servicio;

  before(async () => {
    servicio = await createTestService({ name: 'Servicio Para Editar', price: 5000 });
  });

  for (const { label, value } of INVALIDOS) {
    test(`rechaza price = ${label}`, async () => {
      const r = await api.put(`/services/${servicio.id}`, { price: value }, auth());

      assert.equal(r.status, 400, `debio rechazar, devolvio ${r.status}`);
    });
  }

  test('un precio rechazado NO cambia el precio guardado', async () => {
    assert.strictEqual(await precioEnRepo('services', servicio.id), 5000);
  });

  test('guarda 6899.99 exacto', async () => {
    const r = await api.put(`/services/${servicio.id}`, { price: 6899.99 }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(r.body.service.price, 6899.99);
    assert.strictEqual(await precioEnRepo('services', servicio.id), 6899.99);
  });

  test('un PUT parcial no toca el precio', async () => {
    const r = await api.put(`/services/${servicio.id}`, { duration: '3 horas' }, auth());

    assert.equal(r.status, 200);
    assert.strictEqual(r.body.service.price, 6899.99);
    assert.strictEqual(await precioEnRepo('services', servicio.id), 6899.99);
  });
});

describe('POST /orders - el total no arrastra basura flotante', () => {
  // 45.55*3 = 136.64999999999998 y 0.29*3 = 0.8699999999999999 en IEEE-754.
  // Sin redondear, orders.total guardaba 137.51999999999998.
  let A;
  let B;
  let S;

  // OJO: los createTestProduct van en un before y no en el cuerpo del describe.
  // El cuerpo se evalua al cargar el archivo, antes de que corra el backupData()
  // global: un producto creado ahi queda en el backup y sobrevive al restore.
  before(async () => {
    A = await createTestProduct({ name: 'Flotante A', price: 45.55, stock: 100 });
    B = await createTestProduct({ name: 'Flotante B', price: 0.29, stock: 100 });
    // El precio de un SERVICIO viaja por el mismo mapper que el de un producto
    // (`resolveForOrder` los resuelve con el mismo tipo de fila), asi que si uno
    // vuelve como string, el otro tambien.
    S = await createTestService({ name: 'Servicio Tipos', price: 12.34, duration: '1 dia' });
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

  test('el total persistido en la base tambien viene limpio', async () => {
    const r = await pedido();
    // Se relee de la BASE y no de la respuesta: el 201 arma el objeto con el
    // `returning` del INSERT, y un total feo podria venir justo de ahi. Lo que
    // importa es lo que quedo guardado, que es lo que despues suma el dashboard.
    const guardado = await repo.orders.findById(r.body.order.id);

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

  // Tarea 5.10. Este es el UNICO lugar donde se verifica el tipo en la frontera
  // HTTP, y hace falta por una razon concreta: `assert.equal` de node es laxo
  // (`==`), asi que `assert.equal(total, 137.52)` TAMBIEN pasa con total === '137.52'.
  // Todos los asserts de precio de este archivo son laxos, y por eso el tipo se
  // tiene que comprobar aparte y explicitamente.
  //
  // El bug que atrapa: `numeric` (oid 1700) llega como STRING si el typeParser de
  // `pool.js` no esta. No revienta nada: el front lo multiplica bien, los tests
  // laxos siguen verdes, y el unico sintoma es que `formatPrice` recibe texto y
  // un `.toFixed` en algun lado del front termina rompiendose en produccion.
  test('la API devuelve NUMEROS, no strings, en todos los precios', async () => {
    const prod = await api.get(`/products/${A.id}`);
    assert.strictEqual(typeof prod.body.product.price, 'number', `precio de producto: ${typeof prod.body.product.price}`);
    assert.strictEqual(typeof prod.body.product.stock, 'number', `stock de producto: ${typeof prod.body.product.stock}`);

    const srv = await api.get(`/services/${S.id}`);
    assert.strictEqual(typeof srv.body.service.price, 'number', `precio de servicio: ${typeof srv.body.service.price}`);

    const r = await pedido();
    assert.strictEqual(typeof r.body.order.total, 'number', `total del pedido: ${typeof r.body.order.total}`);
    for (const i of r.body.order.items) {
      assert.strictEqual(typeof i.price, 'number', `precio del item: ${typeof i.price}`);
      assert.strictEqual(typeof i.quantity, 'number', `cantidad del item: ${typeof i.quantity}`);
    }

    // Y el enganche al store: un POST followed de un GET tiene que devolver el
    // mismo tipo, porque el mismo mapper pasa por las dos.
    const detalle = await api.get(`/orders/${r.body.order.id}`, { token: auth().token });
    assert.strictEqual(typeof detalle.body.order.total, 'number', `total en el detalle: ${typeof detalle.body.order.total}`);
  });
});