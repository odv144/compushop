/**
 * PRODUCTOS — lectura (tareas 2.2 y 2.3).
 *
 * Es la lectura con mas riesgo de contrato del change: cuatro filtros, un
 * LEFT JOIN, paginacion real y `category_name`/`category_slug`, que es donde
 * vive la trampa del `undefined` contra `null`.
 *
 * ---------------------------------------------------------------------------
 * LOS 4 FILTROS, y por que cada uno se arma asi
 * ---------------------------------------------------------------------------
 * 1. `active`  -> `where p.is_active = $1`. La ruta hace
 *                 `if (req.query.active !== 'all') filtrar por is_active`, o
 *                 sea que el default es "solo activos" y `all` significa "no
 *                 filtres". Por eso aca `active: false` significa SIN filtro y
 *                 NO "solo los inactivos". Es la unica lectura posible de esa
 *                 linea sin cambiarle el comportamiento, y por eso el default
 *                 es `true`.
 *
 * 2. `category`-> `where c.slug = $1` (D-02). El store comparaba
 *                 `p.category_slug === req.query.category`, o sea el SLUG de la
 *                 categoria, no su id. El filtro va en el WHERE y no en JS: el
 *                 LEFT JOIN ya esta porque el listado Enriquece con el nombre,
 *                 y filtrar ahi evita traer filas que se descartan.
 *
 * 3. `search`  -> `ILIKE` con el valor escapado (D-08). Replica
 *                 `toLowerCase().includes()` sobre name, description y brand.
 *                 `ILIKE` ya es case-insensitive: no hace falta envolver en
 *                 `lower()`. El escape de `%` y `_` es lo que hace que
 *                 signifique lo mismo que `includes()` — ver `_shared.js`.
 *
 * 4. `page`/`limit` -> `LIMIT/OFFSET` con el total de un `count(*)` sobre el
 *                 MISMO where. El total va DESPUES de filtrar: el store hacia
 *                 `total = list.length` sobre la lista ya filtrada, y por eso
 *                 `pages` tambien es el de la lista filtrada.
 *
 * ---------------------------------------------------------------------------
 * EL LEFT JOIN
 * ---------------------------------------------------------------------------
 * Trae `category_name` y `category_slug`. Un producto sin categoria tiene
 * `category_id` NULL (el schema lo permite y `POST /products` lo acepta), y el
 * store lo emitia con optional chaining: las claves NO existian en el JSON.
 * `LEFT JOIN` mas `optional()` en el mapper reproducen eso. Un `INNER JOIN`
 * perderia los productos huerfanos del catalogo: no es una diferencia de estilo,
 * es un producto que desaparece.
 */
const { withClient } = require('../pool');
const { productList, productDetail, productBare, paginated } = require('../mappers');
const { idOrSlugWhere, likePattern, intOr, updateFrom } = require('./_shared');

const DEFAULT_LIMIT = 20;

const COLS = `
  p.id, p.name, p.slug, p.description, p.price, p.stock,
  p.category_id, p.brand, p.image, p.specs, p.is_active,
  p.created_at, p.updated_at,
  c.name as category_name,
  c.slug as category_slug`;

/**
 * Arma el WHERE de `list`. Se comparte con el `count(*)` para que las dos
 * consultas no puedan filtrar distinto: si el count se armara aparte y se
 * olvidara un filtro, `total` y `pages` serian de otra lista y la paginacion
 * mostraria paginas vacias sin ningun error visible.
 */
function buildWhere({ active, category, search }) {
  const params = [];
  const clauses = [];

  if (active) {
    params.push(true);
    clauses.push(`p.is_active = $${params.length}`);
  }
  if (category) {
    params.push(String(category));
    clauses.push(`c.slug = $${params.length}`);
  }
  if (search) {
    params.push(likePattern(search));
    const i = params.length;
    // `coalesce(..., '')`: el store hacia `(p.description || '')`, o sea que
    // un NULL era una cadena vacia, no un NULL que no matchea. Con `coalesce`
    // el `ILIKE` devuelve el mismo booleano en los dos casos.
    clauses.push(
      `(p.name ilike $${i} escape '\\'` +
        ` or coalesce(p.description, '') ilike $${i} escape '\\'` +
        ` or coalesce(p.brand, '') ilike $${i} escape '\\')`,
    );
  }

  return { where: clauses.length ? `where ${clauses.join(' and ')}` : '', params };
}

/**
 * @param {object} opts
 * @param {string} [opts.category] - slug de la categoria, NO el id.
 * @param {string} [opts.search]   - substring, case-insensitive.
 * @param {boolean} [opts.active=true] - `false` = sin filtro (el `active=all`
 *   de la ruta). NO significa "solo inactivos".
 * @returns {Promise<{products: object[], pagination: object}>}
 */
async function list({ category, search, active = true, page = 1, limit = DEFAULT_LIMIT } = {}) {
  // Mismo normalizado para el OFFSET y para el `limit` del count: si uno de los
  // dos usara el valor crudo, `pages` y el OFFSETarian sobre limites distintos.
  const safePage = intOr(page, 1);
  const safeLimit = intOr(limit, DEFAULT_LIMIT);
  const { where, params } = buildWhere({ active, category, search });

  return withClient(async (c) => {
    const count = await c.query(
      `select count(*)::int as total from products p left join categories c on c.id = p.category_id ${where}`,
      params,
    );
    const total = count.rows[0].total;

    const rows = await c.query(
      `select${COLS}
         from products p
         left join categories c on c.id = p.category_id
         ${where}
        order by p.id
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, safeLimit, (safePage - 1) * safeLimit],
    );

    return {
      products: rows.rows.map(productList),
      pagination: paginated({ page: safePage, limit: safeLimit, total }),
    };
  });
}

/**
 * `GET /products/:id`. Acepta id entero o slug, con la misma regla de la ruta
 * (`isNaN`). Devuelve el producto ENRIQUECIDO: las dos rutas de lectura lo
 * hacen, y por eso el mapper es `productDetail` y no `productBare`.
 */
async function findByIdOrSlug(idOrSlug) {
  return withClient(async (c) => {
    const params = [];
    const where = idOrSlugWhere('p', params, idOrSlug);
    const r = await c.query(
      `select${COLS}
         from products p
         left join categories c on c.id = p.category_id
        where ${where}`,
      params,
    );
    return r.rows[0] ? productDetail(r.rows[0]) : null;
  });
}

// =============================================================================
// ESCRITURAS (tarea 3.2)
// =============================================================================

const INSERT_COLS = 'name, slug, description, price, stock, category_id, brand, image, specs, is_active';

/**
 * `create` devuelve la fila CRUDA (`productBare`), sin `category_name` ni
 * `category_slug`, porque es lo que devuelven `POST /products` y
 * `PUT /products/:id` y lo que devolvian antes: el objeto recien agregado a
 * `db.products`, que no tinha categoria adjunta. El enriquecimiento vive en las
 * dos rutas de lectura y solo en ellas.
 *
 * ---------------------------------------------------------------------------
 * `specs` ES jsonb Y EL ROUND-TRIP ES EXACTO
 * ---------------------------------------------------------------------------
 * `node-postgres` serializa un objeto JS con `JSON.stringify` cuando el destino
 * es `jsonb`, y lo deserializa con `JSON.parse` al leer. O sea que
 * `create({specs: {ram: '16'}})` seguido de `findByIdOrSlug` devuelve
 * `{ram: '16'}` y no `'{"ram":"16"}'`. Esa equivalencia la verifico
 * `tests/migration-roundtrip.verify.js` sobre el JSON real, y es la razon de que
 * la columna sea `jsonb` y no `text`: con `text` habria que castear en cada
 * lectura, y un `specs` que vuelve como string rompe el front.
 *
 * ---------------------------------------------------------------------------
 * `price` A `numeric(14,2)` SIN CASTEAR EN JS
 * ---------------------------------------------------------------------------
 * El parametro va crudo. Si se casteara a `Number` aca, el `round` de Postgres
 * pasaria inadvertido y `45.555` se guardaria como `45.56` sin avisar. Que el
 * servidor redondee es justamente lo que REQ-MONEY-04 quiere que se pueda
 * DETECTAR antes, y por eso el rechazo de los 3 decimales vive en `parsePrice`,
 * en la ruta, no aca.
 */
async function create(product) {
  return withClient(async (c) => {
    const r = await c.query(
      `insert into products (${INSERT_COLS})
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          returning id, name, slug, description, price, stock, category_id,
                    brand, image, specs, is_active, created_at, updated_at`,
      [
        String(product.name),
        String(product.slug),
        product.description ?? null,
        product.price,
        product.stock ?? 0,
        product.category_id ?? null,
        product.brand ?? null,
        product.image ?? null,
        product.specs ?? null,
        product.is_active ?? true,
      ],
    );
    return r.rows[0] ? productBare(r.rows[0]) : null;
  });
}

/**
 * `slug` NO es escribible, y `created_at` tampoco.
 *
 * Del `slug` hay que decir la verdad: el `PUT /products/:id` actual NO lo
 * regenera, y no es una decision de diseno, es una condicion de codigo. La
 * guarda era `if (req.body.name && req.body.name !== p.name)`, pero el `forEach`
 * de campos que la precede YA habia copiado el nombre a `p`, asi que la
 * comparacion era siempre falsa y la rama nunca corria (ver routes/index.js,
 * donde queda el comentario). Arreglarlo cambia el slug de un producto a otro
 * en el mismo change que migra la persistencia, y sin un test que lo pida seria
 * un cambio de contrato disfrazado de refactor. Queda como follow-up.
 *
 * `updated_at` lo pone SIEMPRE la escritura, porque el store lo hacia en cada
 * PUT (`p.updated_at = new Date().toISOString()`), no solo cuando la patch
 * traia algo. Por eso no entra en la patch: es parte del `SET` fijo.
 */
const WRITABLE = ['name', 'description', 'price', 'stock', 'category_id', 'brand', 'image', 'specs', 'is_active'];

async function update(id, patch) {
  const { sets, params } = updateFrom(WRITABLE, patch);
  // Patch vacia: el store decia "actualizado" sin cambiar nada. `updated_at` se
  // mueve igual, porque es lo que hacia antes.
  sets.push(`updated_at = now()`);
  return withClient(async (c) => {
    const r = await c.query(
      `update products set ${sets.join(', ')} where id = $${params.length + 1}
          returning id, name, slug, description, price, stock, category_id,
                    brand, image, specs, is_active, created_at, updated_at`,
      [...params, Number(id)],
    );
    return r.rows[0] ? productBare(r.rows[0]) : null;
  });
}

/**
 * `on delete set null` de `order_items.product_id` (schema.sql) deja los items
 * historicos apuntando a NULL en vez de perderlos: el `delete` del store era un
 * `splice` del array de productos y los items igual seguian con su
 * `product_id`. Lo que SI cambia es que un `product_id` huerfano ya no puede
 * volver a colisionar con un id recien insertado.
 */
async function remove(id) {
  return withClient(async (c) => {
    const r = await c.query('delete from products where id = $1', [Number(id)]);
    return r.rowCount > 0;
  });
}

/**
 * `POST /orders`: resuelve UN item del pedido contra el catalogo (tarea 4.2).
 *
 * El metodo NO RECIBE precio. No es una convencion ni una sugerencia: la
 * signature hace que no haya precio que mentir. El unico precio que puede
 * llegar al pedido es el que sale de esta fila.
 *
 * Acepta id o slug con la MISMA regla de `idOrSlugWhere` que el resto del
 * modulo, porque el carrito manda las dos cosas: un item recien agregado manda el
 * id, uno que viene de una URL mandada por mail manda el slug.
 *
 * `is_active = true` va en el WHERE y no como filtro en JS: un producto dado de
 * baja tiene que ser INVISIBLE, no "visible pero rejecteado". Con el filtro en
 * JS habria que traer la fila inactiva y decidir sobre ella en cada call site,
 * y basta uno que se olvide para vender producto retirado.
 *
 * @param {import('pg').PoolClient} client - cliente con la transaccion abierta.
 *   Va por parametro y no por el pool a proposito: la resolucion TIENE que
 *   ocurrir dentro de la transaccion del pedido, o el precio puede cambiar
 *   entre que se lee y que se guarda.
 * @param {string|number} idOrSlug
 * @returns {Promise<{id: number, name: string, price: number}|null>} `null` si no
 *   existe o esta inactivo: el caller responde 400 y no 404, porque para el
 *   cliente el mensaje es "no disponible", no "no existe".
 */
async function resolveForOrder(client, idOrSlug) {
  const params = [];
  const where = idOrSlugWhere('p', params, idOrSlug);
  const r = await client.query(
    `select p.id, p.name, p.price from products p where ${where} and p.is_active = true`,
    params,
  );
  if (!r.rows[0]) return null;
  return { id: r.rows[0].id, name: r.rows[0].name, price: r.rows[0].price };
}

module.exports = { list, findByIdOrSlug, create, update, remove, resolveForOrder };
