/**
 * CATEGORIAS — lectura (tarea 2.1).
 *
 * La unica lectura de categorias que tiene contrato de API es `GET /categories`,
 * que agrega `product_count`. `findByIdOrSlug` no tiene endpoint todavia: existe
 * porque el design §3 lo pide y porque las escrituras de productos necesitan
 * resolver la categoria.
 *
 * ---------------------------------------------------------------------------
 * `product_count` CUENTA SOLO ACTIVOS. No es un detalle de estilo.
 * ---------------------------------------------------------------------------
 * El store filtraba `p.category_id === c.id && p.is_active`. Un producto dado
 * de baja NO cuenta. Y el count va DENTRO del subquery con su WHERE: si se
 * acotara en JS habria que traer todas las filas de products para contarlas, y
 * un `WHERE` olvidado seria invisible.
 */
const { withClient } = require('../pool');
const { categoryWithCount, categoryBare } = require('../mappers');
const { idOrSlugWhere, updateFrom } = require('./_shared');

// `image` se selecciona SIEMPRE, y va a salir como null en las 6 del seed, que
// nunca la tuvieron. Es el unico cambio de payload de la migracion (design D-09)
// y es una mejora: `POST /categories` si la escribe, asi que sin esta columna
// una categoria creada por el admin perderia su imagen en el listado.
const COLS = 'c.id, c.name, c.slug, c.description, c.image, c.created_at';

const WITH_COUNT = `
  select ${COLS},
         (select count(*)::int
            from products p
           where p.category_id = c.id
             and p.is_active) as product_count
    from categories c
   order by c.id`;

/**
 * El store no ordenaba nada: devolvia el array en orden de insercion. Con ids
 * contiguos 1..N eso es `order by id`. Sin el ORDER BY el orden de Postgres es
 * el del heap y dos consultas al mismo catalogo pueden devolver filas en
 * distinto orden, lo que hace que un diff de paginacion parezca un bug de
 * datos.
 */
async function list() {
  return withClient(async (c) => {
    const r = await c.query(WITH_COUNT);
    return r.rows.map(categoryWithCount);
  });
}

/**
 * `GET /categories/:id` no existe todavia. Se resuelve id-o-slug igual que en
 * productos y servicios para que el criterio sea uno solo en toda la capa.
 *
 * SIN `product_count`: el store no lo tenia en la fila suelta y ningun endpoint
 * lo pide. `categoryBare` es el que lo saca si alguna vez sobra.
 */
async function findByIdOrSlug(idOrSlug) {
  return withClient(async (c) => {
    const params = [];
    const where = idOrSlugWhere('c', params, idOrSlug);
    const r = await c.query(`select ${COLS} from categories c where ${where}`, params);
    return r.rows[0] || null;
  });
}

// =============================================================================
// ESCRITURAS (tarea 3.2)
// =============================================================================

const INSERT_COLS = 'name, slug, description, image';

/**
 * Devuelve la fila CRUDA, sin `product_count`.
 *
 * No es que se le olvide el campo: `GET /categories` agrega el conteo con un
 * subquery porque lo necesita, y las dos rutas de escritura NO lo hacen. En el
 * store el `cat` que devolvian `POST` y `PUT` era el objeto recien agregado a
 * `db.categories`, que nunca tuvo `product_count`; el campo se armaba solo en el
 * listado. Si `create` devolviera la fila de `list`, el contrato del 201
 * cambiaria y habria que sacar el campo a mano en el mapper.
 */
async function create(category) {
  return withClient(async (c) => {
    const r = await c.query(
      `insert into categories (${INSERT_COLS})
            values ($1, $2, $3, $4)
          returning id, name, slug, description, image, created_at`,
      [String(category.name), String(category.slug), category.description ?? null, category.image ?? null],
    );
    return r.rows[0] || null;
  });
}

/**
 * `slug` NO es escribible. No por prudencia sino por el contrato: el `PUT`
 * actual no lo toca (ver routes/index.js), y si aca se pudiera escribir, el
 * `slug` de una categoria podria quedar desalineado del `name` sin que ninguna
 * ruta lo pidiera. Queda como follow-up, igual que el de productos.
 */
const WRITABLE = ['name', 'description', 'image'];

async function update(id, patch) {
  const { sets, params } = updateFrom(WRITABLE, patch);
  if (!sets.length) return findByIdOrSlug(Number(id));
  return withClient(async (c) => {
    const r = await c.query(
      `update categories set ${sets.join(', ')} where id = $${params.length + 1}
          returning id, name, slug, description, image, created_at`,
      [...params, Number(id)],
    );
    return r.rows[0] ? categoryBare(r.rows[0]) : null;
  });
}

/**
 * `on delete set null` de `products.category_id` (schema.sql) es lo que
 * reemplaza al `db.categories.splice()` del store: antes, borrar una categoria
 * dejaba productos apuntando a un id que ya no existia, y el listado los
 * mostraba igual porque el enriquecimiento era un `.find()` sobre el array.
 * Ahora quedan con `category_id` NULL y el LEFT JOIN los sigue trayendo, con
 * `category_name`/`category_slug` ausentes, que es el mismo JSON.
 */
async function remove(id) {
  return withClient(async (c) => {
    const r = await c.query('delete from categories where id = $1', [Number(id)]);
    return r.rowCount > 0;
  });
}

module.exports = { list, findByIdOrSlug, create, update, remove };
