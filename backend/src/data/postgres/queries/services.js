/**
 * SERVICIOS — lectura (tarea 2.4).
 *
 * Lo mas simple de la capa, y esa simplicidad es el contrato:
 *
 *  - `GET /services` NO pagina. No hay `pagination` en la respuesta, no hay
 *    `limit`, no hay slice. Devuelve la lista entera. Agregar paginacion aca
 *    seria cambiar el contrato en el mismo change que migra la persistencia, y
 *    con los dos cambios mezclados no se sabe cual rompio que.
 *
 *  - `GET /services` NO enriquece. A diferencia de productos, un servicio no
 *    tiene categoria, asi que no hay `category_name` que agregar.
 *
 *  - El unico filtro es `active`, con la misma semantica que en productos:
 *    el default es "solo activos" y `false` significa SIN filtro (el
 *    `active=all` de la ruta).
 *
 *  - El sobre es `{ services: [...] }` en el listado y `{ service: {...} }` en
 *    el detalle. Lo arma la ruta, no el repo. Ver el comentario de repo.js.
 */
const { withClient } = require('../pool');
const { idOrSlugWhere, updateFrom } = require('./_shared');

const COLS = 's.id, s.name, s.slug, s.description, s.price, s.duration, s.image, s.is_active, s.created_at, s.updated_at';

async function list({ active = true } = {}) {
  return withClient(async (c) => {
    const params = [];
    // Sin filtro: `where ''` es valido en Postgres y trae todo. No se hace un
    // `if` con dos queries distintos: dos textos de SQL que pueden divergir.
    const where = active ? `where s.is_active = $1` : '';
    if (active) params.push(true);

    const r = await c.query(`select ${COLS} from services s ${where} order by s.id`, params);
    return r.rows;
  });
}

/**
 * `GET /services/:id` acepta id entero o slug, igual que productos.
 *
 * El nombre es `findByIdOrSlug` y no `findById` porque la ruta acepta las dos
 * formas (`const key = isNaN(req.params.id) ? 'slug' : 'id'`). Un `findById`
 * que solo buscara por id dejaria `GET /services/armado-pc-medida` en 404, que
 * es una regresion de la migracion, no una decision de diseno.
 */
async function findByIdOrSlug(idOrSlug) {
  return withClient(async (c) => {
    const params = [];
    const where = idOrSlugWhere('s', params, idOrSlug);
    const r = await c.query(`select ${COLS} from services s where ${where}`, params);
    return r.rows[0] || null;
  });
}

// =============================================================================
// ESCRITURAS (tarea 3.2)
// =============================================================================

const INSERT_COLS = 'name, slug, description, price, duration, image, is_active';

/**
 * `duration` es un STRING (`"24-48 hs"`), no un numero: la columna es `text` y
 * los 4 servicios del seed traen valores asi. No se castea en JS por el mismo
 * motivo que `price`: el `parseInt` que haria el "arreglo" convertiria
 * `"24-48 hs"` en `24`, que es un dato distinto.
 *
 * Devuelve la fila cruda, sin enriquecimiento, que en servicios es indistinto
 * de la enriquecida: no hay categoria que agregar.
 */
async function create(service) {
  return withClient(async (c) => {
    const r = await c.query(
      `insert into services (${INSERT_COLS})
            values ($1, $2, $3, $4, $5, $6, $7)
          returning id, name, slug, description, price, duration, image,
                    is_active, created_at, updated_at`,
      [
        String(service.name),
        String(service.slug),
        service.description ?? null,
        service.price,
        service.duration ?? null,
        service.image ?? null,
        service.is_active ?? true,
      ],
    );
    return r.rows[0] || null;
  });
}

/**
 * ACÁ EL `slug` SI SE REGENERA, y es una diferencia real con productos.
 *
 * El `PUT /services/:id` actual tiene `if (req.body.name) s.slug = slugify(s.name)`.
 * Sin comparacion contra el nombre anterior: si el cliente manda `name`, el slug
 * se recalcula, haya cambiado o no. El de productos comparaba (y por un bug de
 * orden nunca llegaba a comparar). Los dos comportamientos se replican tal cual:
 * la ruta de productos no manda `slug` en la patch, la de servicios lo manda.
 *
 * Que el slug cambie es observable — es la URL de `/servicios/:slug`—, asi que
 * no se "arregla" acá: se preserva.
 */
const WRITABLE = ['name', 'slug', 'description', 'price', 'duration', 'image', 'is_active'];

async function update(id, patch) {
  const { sets, params } = updateFrom(WRITABLE, patch);
  // `updated_at` siempre: el store lo movia en cada PUT, incluso sin cambios.
  sets.push('updated_at = now()');
  return withClient(async (c) => {
    const r = await c.query(
      `update services set ${sets.join(', ')} where id = $${params.length + 1}
          returning id, name, slug, description, price, duration, image,
                    is_active, created_at, updated_at`,
      [...params, Number(id)],
    );
    return r.rows[0] || null;
  });
}

async function remove(id) {
  return withClient(async (c) => {
    const r = await c.query('delete from services where id = $1', [Number(id)]);
    return r.rowCount > 0;
  });
}

/**
 * `POST /orders`: resuelve UN item del pedido que es un SERVICIO (tarea 4.2).
 *
 * Es el gemelo de `products.resolveForOrder`, con la misma regla de id-o-slug y
 * el mismo `is_active = true` en el WHERE. Va en `products.js` y no tambien
 * aca por un motivo concreto: el unico modulo que resuelve items para un pedido
 * es `orders.js`, y duplicar la query en dos archivos es como un dia el filtro
 * de inactivo queda en uno y no en el otro, y se vende un servicio retirado.
 *
 * `client` va por parametro por el mismo motivo que en productos: la resolucion
 * ocurre dentro de la transaccion del pedido.
 *
 * @param {import('pg').PoolClient} client
 * @param {string|number} idOrSlug
 * @returns {Promise<{id: number, name: string, price: number}|null>}
 */
async function resolveForOrder(client, idOrSlug) {
  const params = [];
  const where = idOrSlugWhere('s', params, idOrSlug);
  const r = await client.query(
    `select s.id, s.name, s.price from services s where ${where} and s.is_active = true`,
    params,
  );
  if (!r.rows[0]) return null;
  return { id: r.rows[0].id, name: r.rows[0].name, price: r.rows[0].price };
}

module.exports = { list, findByIdOrSlug, create, update, remove, resolveForOrder };
