/**
 * ATOMICIDAD DE `POST /orders` — el pedido entero o nada.
 *
 * ==============================================================================
 * POR QUE ESTE ARCHIVO EXISTE Y POR QUE NO ESTA EN orders.security.test.js
 * ==============================================================================
 * `orders.security.test.js` mira el RESULTADO de la peticion: el status, el total
 * y cuanto stock bajo. Todo eso pasa perfecto aunque la compra se aplique a
 * MEDIAS: un `insert` de `orders` que sobrevive al fallo del `insert` de
 * `order_items`, un
 * descuento de stock aplicado para un producto y luego revertido por el error de
 * OTRO producto del mismo pedido, un `order_items` huerfano apuntando a un pedido
 * que en realidad se rechazo.
 *
 * Eso es estado INCOHERENTE, y por definicion no aparece en el status HTTP: la
 * API puede devolver 400 mientras la base queda con medio pedido adentro. Un
 * pedido a medio escribir es plata mal cobrada o stock fantasma, y se descubre
 * cuando el cliente reclama.
 *
 * Asi que estos tests no preguntan "que devolvio la API" sino "que quedo en la
 * base": cuentan filas y comparan el stock ANTES y DESPUES de un pedido que se
 * sabe que va a fallar. Si el rollback no esta, el contador se mueve y el test
 * falla.
 *
 * ==============================================================================
 * LO QUE NO PUEDE PROBAR ESTE ARCHIVO (y es importante saberlo)
 * ==============================================================================
 * `pool.js` va con `max: 1`: hay UNA sola conexion, asi que dos pedidos
 * "simultaneos" se serializan en el pool. El test de concurrencia de mas abajo
 * demuestra que el INVARIANTE se respeta (nunca queda stock negativo, nunca se
 * venden dos veces la ultima unidad) pero NO que se respete bajo conexiones
 * realmente paralelas, porque aqui eso no ocurre. Lo que si protege, y es lo
 * importante, es que el `update` condicional (`where stock >= $2`) haga su
 * trabajo aunque hoy el pool los ordene.
 *
 * El caso de verdadconcurrente (dos conexiones de verdad) necesita una base con
 * pool mas ancho o dos procesos; queda para cuando se migre la persistencia
 * (ver tarea 8.x).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  backupData,
  restoreData,
  startTestServer,
  createTestProduct,
  BACKEND_ROOT,
} = require('./helpers');

// helpers ya carga el `.env`, asi que el pool de abajo lee la misma base que la
// app que levanta `startTestServer`. Si el orden fuera al reves, el pool leeria
// una URL sin setear y fallaria con un error de credenciales.
const { withClient } = require(path.join(BACKEND_ROOT, 'src', 'data', 'postgres', 'pool.js'));

let api;
let rico;
let pobre;
let sinStock;
let paraHappy;

before(async () => {
  await backupData();
  api = await startTestServer();
  rico = await createTestProduct({ name: 'Producto Rico Test', price: 1000, stock: 100 });
  pobre = await createTestProduct({ name: 'Producto Pobre Test', price: 500, stock: 1 });
  sinStock = await createTestProduct({ name: 'Producto Sin Stock Test', price: 700, stock: 0 });
  // Fixture separado del que usa el test de concurrencia: ese necesita arrancar
  // en 1 y no puede ver a otro test gastarle la unidad.
  paraHappy = await createTestProduct({ name: 'Producto Happy Test', price: 300, stock: 50 });
});

after(async () => {
  if (api) await api.close();
  await restoreData();
});

/** Los tres contadores que definen si un pedido quedo entero o a medias. */
const conteoDe = () =>
  withClient(async (c) => {
    const r = await c.query(`
      select (select count(*)::int from orders)                                  as orders,
             (select count(*)::int from order_items)                             as items,
             (select count(*)::int from order_items where order_id is null)      as items_huerfanos
    `);
    return r.rows[0];
  });

const stockDe = async (id) => {
  const fila = await withClient(async (c) => {
    const r = await c.query('select stock from products where id = $1', [id]);
    return r.rows[0];
  });
  assert.ok(fila, `el producto ${id} deberia existir`);
  return fila.stock;
};

const pedido = (items) =>
  api.post('/orders', {
    items,
    customer_name: 'Cliente Atomic',
    customer_email: 'atomic@test.com',
  });

describe('POST /orders - atomicidad', () => {
  test('un rechazo por stock NO deja fila de pedido', async () => {
    const antes = await conteoDe();

    const r = await pedido([{ id: sinStock.id, type: 'product', quantity: 1 }]);

    assert.equal(r.status, 400, 'no hay stock, tiene que rechazarse');
    assert.deepEqual(await conteoDe(), antes, 'un pedido rechazado no puede dejar filas en orders');
  });

  test('un rechazo por stock NO deja order_items huerfanos', async () => {
    const antes = await conteoDe();

    const r = await pedido([
      { id: rico.id, type: 'product', quantity: 1 },
      { id: sinStock.id, type: 'product', quantity: 1 },
    ]);

    assert.equal(r.status, 400, 'la segunda linea no tiene stock');
    assert.deepEqual(
      await conteoDe(),
      antes,
      'ni una fila de items: un item huerfano es un pedido sin precio que facturar',
    );
  });

  test('si falla la SEGUNDA linea, el descuento de la PRIMERA se revierte', async () => {
    const stockAntes = await stockDe(rico.id);

    const r = await pedido([
      { id: rico.id, type: 'product', quantity: 5 },
      { id: sinStock.id, type: 'product', quantity: 1 },
    ]);

    assert.equal(r.status, 400);
    assert.equal(
      await stockDe(rico.id),
      stockAntes,
      'el primer producto NO puede quedar descontado: el rollback tiene que deshacerlo',
    );
  });

  test('un producto inexistente aborta el pedido entero, no solo su linea', async () => {
    const stockAntes = await stockDe(rico.id);
    const antes = await conteoDe();

    const r = await pedido([
      { id: rico.id, type: 'product', quantity: 3 },
      { id: 99999999, type: 'product', quantity: 1 },
    ]);

    assert.equal(r.status, 400);
    assert.equal(await stockDe(rico.id), stockAntes, 'nada se descuenta si una linea no resuelve');
    assert.deepEqual(await conteoDe(), antes, 'tampoco queda el pedido a medias');
  });

  test('el happy path SI deja el pedido completo: 1 pedido, N items, stock descontado', async () => {
    const stockRico = await stockDe(rico.id);
    const stockHappy = await stockDe(paraHappy.id);
    const antes = await conteoDe();

    const r = await pedido([
      { id: rico.id, type: 'product', quantity: 2 },
      { id: paraHappy.id, type: 'product', quantity: 3 },
    ]);

    assert.equal(r.status, 201);
    const despues = await conteoDe();
    assert.equal(despues.orders, antes.orders + 1, 'un pedido');
    assert.equal(despues.items, antes.items + 2, 'los dos items del cuerpo');
    assert.equal(await stockDe(rico.id), stockRico - 2, 'el stock baja exactamente lo comprado');
    assert.equal(await stockDe(paraHappy.id), stockHappy - 3, 'tambien el segundo producto');
  });
});

describe('POST /orders - no se puede vender dos veces la ultima unidad', () => {
  test('dos pedidos al mismo tiempo por el ultimo producto: uno entra, el otro no', async () => {
    const stockAntes = await stockDe(pobre.id);
    assert.equal(stockAntes, 1, 'el fixture arranca con 1 unidad, si no el test no prueba nada');

    // Se disparan JUNTOS a proposito: con `max: 1` el pool los serializa, y el
    // que pierde tiene que ver el stock ya descontado por el otro.
    const [a, b] = await Promise.all([
      pedido([{ id: pobre.id, type: 'product', quantity: 1 }]),
      pedido([{ id: pobre.id, type: 'product', quantity: 1 }]),
    ]);

    const creados = [a, b].filter((r) => r.status === 201);
    const rechazados = [a, b].filter((r) => r.status === 400);

    assert.equal(creados.length, 1, `uno solo puede crear el pedido: ${JSON.stringify([a.status, b.status])}`);
    assert.equal(rechazados.length, 1, 'el otro tiene que recibir 400, no un 201 clon');
    assert.equal(
      await stockDe(pobre.id),
      0,
      'el stock no puede quedar en -1: eso seria una unidad vendida que no existe',
    );
  });

  test('muchos pedidos seguidos: ningun order_number se repite', async () => {
    const pedidos = await Promise.all(
      Array.from({ length: 4 }, () => pedido([{ id: rico.id, type: 'product', quantity: 1 }])),
    );
    for (const r of pedidos) assert.equal(r.status, 201, `un pedido fallo: ${JSON.stringify(r.body)}`);

    const numeros = pedidos.map((r) => r.body.order.order_number);
    assert.equal(new Set(numeros).size, numeros.length, `se repitio un order_number: ${numeros}`);

    // El formato es parte del contrato visible (lo ve el cliente en el mail).
    for (const n of numeros) {
      assert.match(n, /^CS\d{6}-\d{4}$/, `order_number con formato raro: ${n}`);
    }

    // Y la base no tiene ninguno repetido: el indice unico es la red de
    // seguridad, pero si el nextval se compartiera, el indice botaria el INSERT.
    const repetidos = await withClient(async (c) => {
      const r = await c.query(
        'select count(*)::int as n from (select order_number from orders group by order_number having count(*) > 1) x',
      );
      return r.rows[0].n;
    });
    assert.equal(repetidos, 0, 'hay order_numbers repetidos en la base');
  });
});