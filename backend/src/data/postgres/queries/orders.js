/**
 * PEDIDOS — la parte que hace que un pedido sea un pedido (tarea 4.1-4.4).
 *
 * Es el modulo mas diferente del resto de `queries/`, y la diferencia es
 * intencional: los demas son CRUD de una fila, y este hace que VARIAS filas de
 * DOS tablas cambien juntas o no cambien nada.
 *
 * ---------------------------------------------------------------------------
 * `createAtomic`: POR QUE UNA TRANSACCION Y NO UNA CONVENCION
 * ---------------------------------------------------------------------------
 * Un pedido son tres escrituras que dependen entre si:
 *
 *   1. el INSERT de `orders` (que ademas calcula el total y saca el numero),
 *   2. N INSERTs de `order_items`, uno por linea del body,
 *   3. N UPDATE de `products.stock`, uno por producto DISTINTO.
 *
 * Si el pedido 3 falla en el paso 5 de 7 y los pasos 1-4 ya se escritores, sin
 * transaccion queda un pedido SIN items con el stock ya descontado. Con
 * transaccion no existe ese estado: o esta todo, o no esta nada.
 *
 * D-01: la transaccion es una PROPIEDAD DEL METODO. El call site no puede
 * olvidarse de pedirla ni de cerrarla, porque no tiene el `client`: el unico que
 * sabe abrirla y cerrarla es este archivo.
 *
 * ---------------------------------------------------------------------------
 * EL STOCK NO SE VALIDA, SE DESCUENTA CON CONDICION
 * ---------------------------------------------------------------------------
 * Este es el punto que no se negocia (REQ-ATOMIC-03). La alternativa obvia —
 * `select stock ... if (stock < qty) throw` — tiene una carrera: dos pedidos
 * concurrentes sobre la ultima unidad los dos leen `stock = 1`, los dos pasan el
 * `if`, y los dos escriben `stock = 0`. La venta se duplica y el stock queda en
 * 0 cuando tenia que quedar en -1. En un e-commerce eso es plata.
 *
 * La forma que no tiene carrera es hacer la comprobacion PARTE de la escritura:
 *
 *     update products set stock = stock - $2
 *      where id = $1 and stock >= $2
 *      returning id
 *
 * `stock >= $2` se evalua con el lock de fila que el UPDATE toma. El segundo
 * pedido concurrente espera a que el primero confirme, recien ahi ve el `stock`
 * nuevo, y su `returning` viene vacio: se sabe que fallo HECHO, no "parece que
 * fallo". Si no vuelve ninguna fila, no habia stock: se tira todo.
 *
 * ---------------------------------------------------------------------------
 * POR QUE `requestedByProduct` Y NO "UN UPDATE POR LINEA"
 * ---------------------------------------------------------------------------
 * El body puede traer el MISMO producto dos veces (`{id: 5, quantity: 1}` dos
 * veces). Con un UPDATE por linea, cada uno veria `stock >= 1` y los dos
 * pasarian: stock 1 -> 0 -> -1. El `-1` es EXACTAMENTE el exploit que el
 * `orders.security.test.js` cubre hoy.
 *
 * Y NO se pueden agrupar los items: cada linea es una fila de `order_items` con
 * su propio id, y el admin las ve separadas en el modal de detalle. La
 * agregacion es solo para el `UPDATE`: una fila de `order_items` por linea del
 * body, un `UPDATE` por producto DISTINTO con la cantidad TOTAL.
 *
 * ---------------------------------------------------------------------------
 * EL TOTAL SE CALCULA EN SQL, CON `numeric`
 * ---------------------------------------------------------------------------
 * El precio sale de la base, asi que la aritmetica se hace con `numeric` y no
 * con float de JS. Es la diferencia entre `137.52` y `137.51999999999998`, que
 * es lo que el store guardaba cuando `45.84 * 3` pasaba por `reduce` con
 * `Number`. El `::numeric(14,2)` es el redondeo explicito: el total que se
 * guarda, el que se muestra y el que suma el dashboard son el mismo numero.
 *
 * Los precios viajan como TEXTO (`toFixed(2)`) hacia `numeric[]`. En JS, un
 * `45.55` es un double cuya representacion decimal mas corta es `45.55`, pero no
 * es un decimal exacto: mandarlos como `double precision` deja que la suma la
 * haga el servidor en punto flotante binario, que es de donde salen los
 * `136.64999999999998`. Como texto, `numeric` los trata como lo que son:
 * decimales exactos.
 *
 * ---------------------------------------------------------------------------
 * EL NUMERO DE PEDIDO
 * ---------------------------------------------------------------------------
 * `CS` + `YYMMDD` (en UTC, como el `toISOString().slice(2, 10)` del store) + `-`
 * + 4 digitos. Los digitos salen de `order_number_seq`, no de `Math.random()`:
 *
 *   - `Math.random()` podia repetir numero. Dos pedidos del mismo dia con el
 *     mismo numero son indistinguibles para el admin y para el cliente, y nada
 *     en la base lo detectaba.
 *   - la secuencia mas el `unique index` sobre `orders.order_number` convierten
 *     la repeticion en un error de la base, no en un dato dudoso.
 *
 * Huecos hay, y son correctos: las secuencias no son transaccionales, asi que un
 * pedido que se revierte igual consume numero. Un numero faltante es un numero
 * no usado; un numero repetido es una venta que no se puede cobrar.
 */
const { withTransaction, withClient } = require('../pool');
const { order, orderItem } = require('../mappers');
const productsQ = require('./products');
const servicesQ = require('./services');

const DEFAULT_LIMIT = 20;

// Columnas explicitas. El `SELECT *` esta prohibido en esta capa (guard), y
// escribir la lista a mano es lo que hace que agregar una columna al schema NO
// cambie el contrato de la API por accidente.
const ORDER_COLS = `
  o.id, o.user_id, o.order_number, o.status, o.total,
  o.shipping_address, o.notes, o.customer_name, o.customer_email,
  o.customer_phone, o.created_at, o.updated_at`;

/**
 * El error de negocio de "no hay stock".
 *
 * Va con `code` y no como un string suelto para que la ruta pueda responder
 * 400 y no 500: un 500 en este caso seria mentirle al cliente, que si puede
 * hacer algo (comprar menos, esperar, elegir otro producto). Y lleva el nombre
 * del producto porque el mensaje del store lo llevaba (`Stock insuficiente: X`)
 * y el admin lo usa para saber que reponer.
 */
function stockInsuficiente(nombreProducto) {
  const err = new Error(`Stock insuficiente: ${nombreProducto}`);
  err.code = 'STOCK_INSUFICIENTE';
  err.nombreProducto = nombreProducto;
  return err;
}

/**
 * Resuelve UNA linea del body contra el catalogo. NUNCA lee precio ni nombre
 * del body: por mas que el cliente mande un `price` de 1 y un nombre inventado,
 * lo que se guarda es lo que dice la base.
 *
 * Se resuelve DENTRO de la transaccion a proposito. Si se resolviera antes
 * (fuera), entre la lectura y el INSERT otro pedido o un PUT del admin puede
 * cambiar el precio o dar de baja el producto, y el pedido guardaria un precio
 * que ya no existe. Leyendo adentro, la fila esta bloqueada por el snapshot de
 * la transaccion.
 *
 * @param {import('pg').PoolClient} client - cliente YA dentro de la transaccion.
 * @param {object} item - linea cruda del body: `{ id, quantity, type }`.
 * @returns {Promise<{id:number, type:'product'|'service', name:string, price:number, quantity:number}>}
 * @throws si la cantidad no es un entero >= 1.
 */
async function resolverLinea(client, item) {
  // Misma regla que el store: cualquier cosa que no sea exactamente 'service'
  // se trata como producto. Un `type: 'lo que sea'` cae en producto y falla con
  // "no disponible", que es la respuesta que daba antes.
  const type = item.type === 'service' ? 'service' : 'product';

  // La validacion de la cantidad vive en las DOS capas. En la ruta, porque es
  // la que responde al cliente y el guard la exige ahi; aca, porque el metodo
  // del repo se puede llamar desde cualquier otro lado y no puede confiar en que
  // el call site haya validado. Una cantidad 0 o -1 que llegara aca seria un
  // UPDATE que SUMA stock.
  const quantity = Number(item.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    const err = new Error('Cantidad inválida');
    err.code = 'CANTIDAD_INVALIDA';
    throw err;
  }

  const source =
    type === 'service'
      ? await servicesQ.resolveForOrder(client, item.id)
      : await productsQ.resolveForOrder(client, item.id);
  if (!source) return null;

  return { id: source.id, type, name: source.name, price: source.price, quantity };
}

/**
 * El nucleo de `createAtomic`, con el `client` YA adentro de una transaccion.
 *
 * Se exporta separado del `createTransaction` wrapper por una razon concreta:
 * el test de concurrencia necesita DOS transacciones simultaneas sobre un pool
 * con `max: 2`, y el pool del modulo es `max: 1` a proposito (ver pool.js). Con
 * el nucleo parametrizado por `client`, el test puede abrir las dos suyas y
 * ejercitar el MISMO codigo que usa la app, en vez de una copia.
 *
 * @param {import('pg').PoolClient} client - cliente con la transaccion abierta.
 * @param {object} payload
 * @returns {Promise<object>} el pedido con `items`, listo para el 201.
 */
async function createAtomicTx(client, payload) {
  const { items, userId = null, shippingAddress = null, notes = null } = payload;
  const customerName = payload.customerName;
  const customerEmail = payload.customerEmail;
  const customerPhone = payload.customerPhone ?? null;

  // --- 1. Resolver TODAS las lineas antes de escribir NADA ------------------
  // Resolver primero y escribir despues no es "optimizar": es para que un item
  // invalido en la posicion 5 no deje un pedido a medio escribir. El rollback
  // lo desharia igual, pero el mensaje de error que el cliente ve seria el de la
  // base y no el de negocio.
  const resolved = [];
  for (const item of items) {
    const linea = await resolverLinea(client, item);
    if (!linea) {
      const err = new Error(`Producto o servicio no disponible: ${item.name || item.id}`);
      err.code = 'ITEM_NO_DISPONIBLE';
      throw err;
    }
    resolved.push(linea);
  }

  // --- 2. Agregar por producto, para el descuento --------------------------
  // Un `Map` y no un objeto porque las claves son ids numericos y `{}` convierte
  // el 1 en "1".
  const requestedByProduct = new Map();
  for (const linea of resolved) {
    if (linea.type !== 'product') continue;
    requestedByProduct.set(linea.id, (requestedByProduct.get(linea.id) || 0) + linea.quantity);
  }

  // --- 3. Descontar stock, con la comprobacion DENTRO del UPDATE -----------
  for (const [productId, totalQty] of requestedByProduct) {
    const r = await client.query(
      `update products set stock = stock - $2, updated_at = now()
        where id = $1 and stock >= $2
      returning id`,
      [productId, totalQty],
    );
    if (r.rowCount === 0) {
      const nombre = resolved.find((l) => l.type === 'product' && l.id === productId).name;
      throw stockInsuficiente(nombre);
    }
  }

  // --- 4. INSERT del pedido: numero, total y todo lo demás -----------------
  // El numero se arma ACÁ, adentro del INSERT. Armarlo antes y pasarlo como
  // parametro abre una ventana en la que dos pedidos concurrentes pueden ver el
  // mismo `nextval` (las secuencias no se bloquean entre si en transaction
  // mode) y el segundo falla por el unique con un error de la base.
  const precios = resolved.map((l) => l.price.toFixed(2));
  const cantidades = resolved.map((l) => l.quantity);

  const inserted = await client.query(
    `insert into orders (user_id, order_number, status, total,
                         shipping_address, notes, customer_name, customer_email, customer_phone)
     select $1,
            'CS' || to_char((now() at time zone 'utc'), 'YYMMDD') || '-' ||
              lpad(nextval('order_number_seq')::text, 4, '0'),
            'confirmed',
            (select coalesce(sum(p.precio * p.cantidad), 0)::numeric(14,2)
               from unnest($2::numeric[], $3::integer[]) as p(precio, cantidad)),
            $4, $5, $6, $7, $8
     returning id, user_id, order_number, status, total, shipping_address, notes,
               customer_name, customer_email, customer_phone, created_at, updated_at`,
    [
      userId === undefined || userId === null ? null : Number(userId),
      precios,
      cantidades,
      shippingAddress ?? null,
      notes ?? null,
      customerName,
      customerEmail,
      customerPhone,
    ],
  );
  const nuevo = inserted.rows[0];

  // --- 5. Una fila de order_items por linea del body ----------------------
  // Uno por iteracion y no un INSERT multi-fila con `unnest` porque aca hay dos
  // FK mutuamente excluyentes (`product_id` o `service_id`, no ambos) y el
  // `unnest` de tres vectores en paralelo por nullable es exactamente el tipo de
  // detalle que se rompe en silencio: una fila con las dos FK en NULL pasa por
  // el NOT NULL del id pero no representa nada. Un INSERT parametrizado por
  // linea no tiene esa ambiguedad, y un pedido son pocas lineas.
  const orderItems = [];
  for (const linea of resolved) {
    const r = await client.query(
      `insert into order_items (order_id, product_id, service_id, name, price, quantity, type)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, order_id, product_id, service_id, name, price, quantity, type`,
      [
        nuevo.id,
        linea.type === 'product' ? linea.id : null,
        linea.type === 'service' ? linea.id : null,
        linea.name,
        linea.price.toFixed(2),
        linea.quantity,
        linea.type,
      ],
    );
    orderItems.push(orderItem(r.rows[0]));
  }

  return { ...order(nuevo), items: orderItems };
}

/**
 * `POST /orders`. Abre la transaccion, corre el nucleo, y deja que
 * `withTransaction` haga el COMMIT o el ROLLBACK.
 *
 * Los errores de negocio (`CANTIDAD_INVALIDA`, `ITEM_NO_DISPONIBLE`,
 * `STOCK_INSUFICIENTE`) salen TIRADOS: es lo que el caller necesita para
 * distinguirlos de un error de infraestructura y responder 400 en vez de 500.
 * No se convierten en `null`: `null` no dice POR QUE fallo, y con el mismo
 * `null` para "no hay stock" y "el producto no existe" el cliente recibe un
 * mensaje que no puede usar.
 */
async function createAtomic(payload) {
  return withTransaction((client) => createAtomicTx(client, payload));
}

/**
 * `GET /orders`.
 *
 * El `where` se arma UNA vez y se usa en el `count(*) over()` y en el `list`, y
 * no puede ser de otra forma: si el count tuvieran un filtro de menos, `total`
 * y `pages` serian de una lista y la tabla del admin mostraria paginas vacias
 * sin ningun error visible.
 *
 * El filtro de `user_id` va en SQL y NO en JS. Filtrar en JS obligaria a traer
 * TODOS los pedidos de la base para descartar los ajenos en memoria: es la
 * diferencia entre "el cliente ve los suyos" y "el cliente ve los suyos, y de
 * paso todos los de los demas si alguien cambia una linea".
 *
 * @param {object} opts
 * @param {number|null} [opts.userId] - `null` = admin: sin filtro de dueno.
 * @param {string} [opts.status] - filtro opcional, como en el store.
 * @returns {Promise<{orders: object[], pagination: object}>}
 */
async function list({ userId = null, status, page = 1, limit = DEFAULT_LIMIT } = {}) {
  const params = [];
  const clauses = [];
  if (userId !== null && userId !== undefined) {
    params.push(Number(userId));
    clauses.push(`o.user_id = $${params.length}`);
  }
  if (status) {
    params.push(String(status));
    clauses.push(`o.status = $${params.length}`);
  }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Number.parseInt(limit, 10) || DEFAULT_LIMIT;

  return withClient(async (c) => {
    const r = await c.query(
      `select${ORDER_COLS}, count(*) over()::int as total_count
         from orders o
         ${where}
        order by o.created_at desc, o.id desc
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, safeLimit, (safePage - 1) * safeLimit],
    );

    // Con el filtro del `where` adelante, `total_count` viene de una fila que NO
    // cumple el filtro: cero filas, y `total` es 0. Es la unica forma de no
    // hacer una segunda consulta solo para el count.
    const total = r.rows.length ? Number(r.rows[0].total_count) : 0;

    return {
      orders: r.rows.map((row) => {
        const { total_count, ...rest } = row;
        return order(rest);
      }),
      pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) },
    };
  });
}

/**
 * `GET /orders/:id`. Con items, porque esta es la vista que arma el modal del
 * admin. El filtro de dueno NO se hace aca: la ruta lo hace, porque es politica
 * de la API y no del acceso a datos.
 */
async function findById(id) {
  return withClient(async (c) => {
    const r = await c.query(
      `select${ORDER_COLS} from orders o where o.id = $1`,
      [Number(id)],
    );
    if (!r.rows[0]) return null;

    const items = await c.query(
      `select id, order_id, product_id, service_id, name, price, quantity, type
         from order_items where order_id = $1 order by id`,
      [r.rows[0].id],
    );

    return { ...order(r.rows[0]), items: items.rows.map(orderItem) };
  });
}

/**
 * `PUT /orders/:id/status`. Devuelve el pedido SIN items: el store tampoco se
 * los ponia, y el front del admin no los usa en esa pantalla.
 *
 * `updated_at` se mueve siempre, no solo cuando el status cambio: es lo que
 * hacia el store (`order.updated_at = new Date().toISOString()` sin mirar el
 * valor anterior).
 */
async function updateStatus(id, status) {
  return withClient(async (c) => {
    const r = await c.query(
      `update orders set status = $2, updated_at = now()
        where id = $1
      returning id, user_id, order_number, status, total, shipping_address, notes,
                customer_name, customer_email, customer_phone, created_at, updated_at`,
      [Number(id), String(status)],
    );
    return r.rows[0] ? order(r.rows[0]) : null;
  });
}

module.exports = { createAtomic, createAtomicTx, list, findById, updateStatus };