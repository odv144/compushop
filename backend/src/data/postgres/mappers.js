/**
 * Mappers: fila de PostgreSQL -> forma exacta que la API promete.
 *
 * Son funciones PURAS. Sin DB, sin I/O, sin process.env. Por eso se testean
 * en unisolado y un fallo acá no necesita ni una base levantada.
 *
 * ---------------------------------------------------------------------------
 * EL TRAMPA DEL `undefined` vs `null`  (leer antes de tocar nada)
 * ---------------------------------------------------------------------------
 * El store JSON construye las respuestas con optional chaining:
 *
 *     { ...p, category_name: cat?.name, category_slug: cat?.slug }
 *
 * Cuando el producto no tiene categoria, `cat?.name` es `undefined`, y
 * `JSON.stringify` OMITE las claves cuyo valor es `undefined`. O sea que hoy
 * la API devuelve un producto SIN las claves `category_name` ni
 * `category_slug`. No con null: sin la clave.
 *
 * En PostgreSQL un LEFT JOIN sobre una categoria inexistente devuelve `NULL`,
 * que SI se serializa, como `"category_name": null`.
 *
 * Moraleja: "cambiar null por undefined" no es cosmetico. Cambia el JSON que
 * ve el cliente. Por eso `optional()` devuelve `undefined` y no `null`.
 *
 * ---------------------------------------------------------------------------
 * LA EXCEPCION: categories.image
 * ---------------------------------------------------------------------------
 * `image` se emite tal cual (null si no esta). Y es una excepcion DELIBERADA
 * al criterio de arriba, por una razon que conviene entender:
 *
 * El JSON tiene las 6 categorias del seed SIN la clave `image`, pero
 * `POST /categories` (routes/index.js:58) si la escribe como `image: image ||
 * null`. O sea que la API actual YA es inconsistente: las del seed no la
 * tienen, las creadas por admin si.
 *
 * Emitirla siempre como null (presente, con valor null) hace la respuesta
 * uniforme. Emitirla como undefined la BORRARIA tambien de las categorias
 * nuevas, que si la tienen. O sea: undefined aca empeora el contrato.
 *
 * ---------------------------------------------------------------------------
 * TIMESTAMPS
 * ---------------------------------------------------------------------------
 * No se convierten a string. La columna es `timestamptz` y `pg` devuelve un
 * `Date`; `JSON.stringify(new Date(...))` produce exactamente el mismo ISO que
 * producia `new Date().toISOString()` en el store JSON. El JSON de respuesta es
 * identico. En proceso queda un `Date` en vez de un string, que ademas ordena
 * con `<` en vez de necesitar `new Date(a) - new Date(b)`.
 *
 * Consecuencia a vigilar: si algun dia alguien hace `row.created_at.slice(...)`
 * o un `.startsWith()` sobre un timestamp, revienta. Hoy no hay nada que lo
 * haga (verificado en las 32 rutas). */

/**
 * null -> undefined. Para TODO lo que armaba el store JSON con optional
 * chaining, y que JSON.stringify por lo tanto omitia.
 */
const optional = (v) => (v === null ? undefined : v);

/**
 * PRODUCTOS
 *
 * `list`/`detail` agregan categoria (JOIN a categories, LEFT para no perder
 * productos huerfanos). `bare` NO: es lo que devuelven POST y PUT, que en el
 * store JSON tampoco la tenian. No es una inconsistencia que haya que
 * "arreglar": es el contrato.
 */
const productList = (row) => ({
  ...row,
  category_name: optional(row.category_name),
  category_slug: optional(row.category_slug),
});

const productDetail = (row) => productList(row);

// POST /products y PUT /products/:id. Sin campos de categoria.
const productBare = (row) => {
  const { category_name, category_slug, ...rest } = row;
  return rest;
};

/**
 * CATEGORIAS
 *
 * `product_count` cuenta SOLO productos activos: el filtro es
 * `p.category_id === c.id && p.is_active`. Un producto dado de baja no cuenta.
 * El COUNT(*) tiene que traer el WHERE adentro; si se cuenta en JS se puede
 * equivocar el filtro sin que ningun test lo note.
 */
const categoryWithCount = (row) => ({ ...row, product_count: Number(row.product_count ?? 0) });

// La fila cruda, sin enrichment. Para POST/PUT, que no agregan product_count.
const categoryBare = (row) => {
  const { product_count, ...rest } = row;
  return rest;
};

/**
 * PEDIDOS
 *
 * `order` nunca trae items. Los items van aparte, explicitos, porque las tres
 * rutas que los necesitan los piden de forma distinta:
 *   GET  /orders      -> SIN items
 *   GET  /orders/:id  -> CON items
 *   POST /orders      -> CON items (los recien creados)
 *   PUT  /orders/:id/status -> SIN items
 *
 * Que el listado no los traiga es deliberado: son N+1 evitados y el front no los
 * usa en la tabla. Meterlos seria cambiar el contrato.
 */
const order = (row) => ({ ...row });

// GET /orders/:id y el 201 de POST /orders. Ahi el order trae los items DENTRO.
const orderWithItems = (row, items) => ({ ...order(row), items: items.map(orderItem) });

const orderItem = (row) => ({ ...row });

/**
 * USERS
 *
 * `password` NUNCA sale. No por filtro en la query sino aca, porque el filtro
 * en SQL es facil de olvidar en una de las diez rutas que devuelven usuarios
 * y el costo de equivocarse es un hash de bcrypt en la respuesta. Aca es un
 * unico lugar por el que pasa todo.
 */
const userSafe = (row) => {
  const { password, ...rest } = row;
  return rest;
};

/**
 * CONTACT
 *
 * Sin enrichment. El shape sale tal cual de la tabla.
 */
const contactMessage = (row) => ({ ...row });

/**
 * SETTINGS
 *
 * En la base es una tabla key/value; la API expone UN singleton objeto. Y
 * todos los valores son string, incluido smtp_port ("587"), porque el store
 * JSON los guardaba como `String(req.body[k])` y la migracion los copio tal
 * cual. Si esto devolviera numeros, el form del admin que compara con "587"
 * deja de matchear.
 */
const settingsFromRows = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.value]));

/**
 * PAGINACION
 *
 * Dos calidades de paginacion conviven en la API y hay que preservarlas:
 *
 * `paginated`  -> la real. products y orders, con `pages` calculado.
 * `paginationFixed` -> la de mentira. users y contact devuelven SIEMPRE
 *                 `{ page: 1, limit: N, total: <count>, pages: 1 }`, con
 *                 `limit` fijo (100 y 50) y `pages` clavado en 1 aunque haya
 *                 300 mensajes. El front ya vive con eso; calcularlo bien
 *                 seria cambiar el contrato en el mismo PR que la migracion,
 *                 y mezclando los dos cambios no se sabe cual rompio que.
 */
const paginated = ({ page, limit, total }) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

const paginationFixed = (total, limit) => ({ page: 1, limit, total, pages: 1 });

/**
 * DASHBOARD
 *
 * `revenue` se deja como sale de la query. El store JSON sumaba floats de
 * JS (0.1+0.2 = 0.30000000000000004); con `numeric(14,2)` la suma es exacta.
 * Es una MEJORA, no una regresion, y no hace falta "arreglarla" redondeando.
 *
 * `salesByMonth` va hardcodeado en [] en la ruta actual. No lo "mejores" aca:
 * no es un mapper, es una decision de producto que todavia no se tomo.
 */
const dashboardStats = (s) => s;

module.exports = {
  optional,
  productList,
  productDetail,
  productBare,
  categoryWithCount,
  categoryBare,
  order,
  orderWithItems,
  orderItem,
  userSafe,
  contactMessage,
  settingsFromRows,
  paginated,
  paginationFixed,
  dashboardStats,
};
