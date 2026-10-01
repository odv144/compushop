/**
 * DASHBOARD — las estadisticas del admin (tarea 4.5, extra del prompt).
 *
 * ---------------------------------------------------------------------------
 * POR QUE UN MODULO PROPIO Y NO UNA LISTA DE CONTADORES EN LA RUTA
 * ---------------------------------------------------------------------------
 * El store permitia `db.products.filter(p => p.is_active).length`: traer el
 * catalogo entero para contar filas es la forma mas lenta de responder "cuantos
 * hay". Con 12 productos no se nota; con 12.000 y `/dashboard/stats` abriendo en
 * cada carga del panel, se nota.
 *
 * Aca los conteos son `count(*)` dentro de la base, con el filtro en el WHERE, y
 * las tres cosas que hay que traer (conteos, pedidos recientes, stock bajo) en
 * un solo `withClient`. El `withClient` importa: el pool es `max: 1`, asi que
 * las tres queries van por la MISMA conexion, en serie, sin que otra pida la
 * liberacion en el medio.
 *
 * ---------------------------------------------------------------------------
 * `count(*)::int` Y POR QUE NO UN `setTypeParser` DE int8
 * ---------------------------------------------------------------------------
 * `count(*)` devuelve bigint, y `pg` devuelve bigint como STRING (asi viene de
 * fabrica, ver data-layer.verify.js). Sin el cast, `productsCount` seria `"12"`
 * y el front que compara con `=== 12` dejaria de matchear.
 *
 * La alternativa "limpia" seria `types.setTypeParser(20, Number)`. NO se hace, y
 * es deliberado: ese setter es estado GLOBAL del modulo `pg`. Convierte TODOS
 * los int8 del proceso en number, y si el dia hay un id grande (un contador de
 * pedidos, un id de 64 bits) el `Number` pierde precision en silencio y dos ids
 * distintos se vuelven el mismo. Un cast explicito por consulta es local y no
 * se propaga.
 *
 * ---------------------------------------------------------------------------
 * `revenue` NO CUENTA LOS CANCELADOS
 * ---------------------------------------------------------------------------
 * `where status <> 'cancelled'`, igual que el store. Es la misma regla que
 * usaba el filtro del panel, y por eso los dos dan el mismo numero: si el
 * dashboard mostrara una cosa y el filtro otra, el admin veria ingresos que no
 * puede encontrar.
 *
 * ---------------------------------------------------------------------------
 * QUE NO HACE ESTE MODULO
 * ---------------------------------------------------------------------------
 * `salesByMonth` sigue siendo `[]` y lo arma la ruta. No es una consulta que
 * falte: es una decision de producto que no se tomo (ver el comentario de
 * `dashboardStats` en mappers.js). Calcularla "porque ya que estamos" seria
 * agregar un contrato que el front nunca pidio.
 */
const { withClient } = require('../pool');
const { productBare, order } = require('../mappers');

const RECIENTES = 5;
const STOCK_BAJO = 5;
const STOCK_BAJO_MAX = 10;
const PENDIENTES = ['pending', 'confirmed', 'processing'];

/**
 * Una sola query con los siete numeros.
 *
 * Son subconsultas escalares y no una vuelta de `join` porque no se cruzan
 * datos entre tablas: cada contador es independiente, y un `from products p,
 * services s, users u...` multiplica las filas y obliga a `count(distinct)`.
 * Con subconsultas cada una cuenta lo suyo y el planner no tiene nada que
 * combinar.
 *
 * Los pendientes van parametrizados (`= any($1::text[])`) y no pegados como
 * `(a, b, c)`: es la lista de estados "abiertos", que crece con el negocio, y
 * tocarla tiene que ser cambiar un dato de este archivo, no reescribir el SQL.
 */
const STATS_SQL = `
  select
    (select count(*)::int from products where is_active)                  as products_count,
    (select count(*)::int from services where is_active)                  as services_count,
    (select count(*)::int from users where role = 'customer')             as users_count,
    (select count(*)::int from orders)                                    as orders_count,
    (select count(*)::int from orders where status = any($1::text[]))     as pending_orders,
    (select count(*)::int from contact_messages where not is_read)       as unread_messages,
    (select coalesce(sum(total), 0) from orders where status <> 'cancelled') as revenue`;

/**
 * Las filas del producto, EN ORDEN por stock ascendente.
 *
 * El `id` va de segundo criterio porque dos productos con el mismo stock (los dos
 * en 0, tipico) quedan en un orden que Postgres no garantiza: la respuesta
 * cambiaria entre llamadas y el panel "daria saltos" sin que nadie lo toque. Con
 * `id asc` el orden es total y repetible.
 */
const LOW_STOCK_SQL = `
  select p.id, p.name, p.slug, p.description, p.price, p.stock,
         p.category_id, p.brand, p.image, p.specs, p.is_active,
         p.created_at, p.updated_at
    from products p
   where p.is_active = true and p.stock <= $1
   order by p.stock asc, p.id asc
   limit $2`;

/**
 * `GET /dashboard/stats`. Devuelve el dominio, no el sobre: la ruta arma el
 * `{ stats, recentOrders, lowStock, salesByMonth }`.
 */
async function stats() {
  return withClient(async (c) => {
    const s = await c.query(STATS_SQL, [PENDIENTES]);
    const recientes = await c.query(
      `select o.id, o.user_id, o.order_number, o.status, o.total,
              o.shipping_address, o.notes, o.customer_name, o.customer_email,
              o.customer_phone, o.created_at, o.updated_at
         from orders o
        order by o.created_at desc, o.id desc
        limit $1`,
      [RECIENTES],
    );
    const bajo = await c.query(LOW_STOCK_SQL, [STOCK_BAJO, STOCK_BAJO_MAX]);

    return {
      stats: {
        productsCount: s.rows[0].products_count,
        servicesCount: s.rows[0].services_count,
        usersCount: s.rows[0].users_count,
        ordersCount: s.rows[0].orders_count,
        pendingOrders: s.rows[0].pending_orders,
        unreadMessages: s.rows[0].unread_messages,
        revenue: s.rows[0].revenue,
      },
      recentOrders: recientes.rows.map(order),
      lowStock: bajo.rows.map(productBare),
    };
  });
}

module.exports = { stats };