/**
 * EL CONTRATO DE LA CAPA DE DATOS (tarea 1.4, design §3).
 *
 * Este es el unico modulo que la aplicacion va a importar para leer y escribir
 * datos. Ni `routes/` ni `tests/` deben saber que existe PostgreSQL: `pg` solo
 * se importa desde `src/data/postgres/`. Si manana hay otra base, se escribe
 * `src/data/<otra>/` y lo UNICO que cambia es este archivo.
 *
 * ---------------------------------------------------------------------------
 * POR QUE UN OBJETO EXPORTADO Y NO UNA FABRICA
 * ---------------------------------------------------------------------------
 * El design §3 dice `module.exports = { users, ... }`. Se sigue al pie de la
 * letra porque el consumo es siempre el mismo: `require('../data/repo')` una
 * vez arriba del archivo y despues `repo.products.list(...)` en el handler.
 * Una fabrica `createRepo(pool)` obligaria a que cada modulo que toca la base
 * tenga que acordarse de crearla, guardarla y pasarla: un singleton con estado
 * que se puede olvidar de inicializar es peor que no tener estado.
 *
 * La excepcion al "sin estado" son las transacciones, y son explicitas: los
 * metodos que las necesitan toman un `client` como parametro (Fase 4).
 *
 * ---------------------------------------------------------------------------
 * QUE DEVUELVE CADA COSA, Y QUE NO
 * ---------------------------------------------------------------------------
 * Los metodos devuelven el DOMINIO, no el sobre de la respuesta HTTP:
 *
 *   products.list()   -> { products, pagination }   <- el sobre SI es del repo
 *   categories.list() -> Category[]
 *   services.list()   -> Service[]
 *   users.list()      -> User[]
 *   contact.list()    -> ContactMessage[]
 *   settings.getAll() -> { ...10 claves }
 *   orders.list()     -> { orders, pagination }     <- mismo criterio que products
 *   orders.findById() -> Order & { items }           <- con items: es la vista del modal
 *   dashboard.stats() -> { stats, recentOrders, lowStock }
 *
 * Donde NO hay sobre es porque la ruta lo arma. El criterio: lo que es
 * ESTRUCTURA DE PAGINACION va en el repo (`products`), y lo que es
 * ENVOLTORIO DE RESPUESTA Y POLITICA DE API va en la ruta (`{ services: [] }`,
 * `{ messages, pagination }` de contact, el `{ page: 1, limit: 100, pages: 1 }`
 * FIJO de users). La paginacion fija de contact y users no se "calcula bien"
 * aca: se preserva tal cual, y el mapper `paginationFixed` esta disponible
 * para que la ruta lo use en la Fase 4.
 *
 * Y `timestamptz` sale como `Date`, no como string. `JSON.stringify` de un
 * `Date` da el mismo ISO que daba el store, asi que el JSON de la respuesta es
 * identico, y en proceso queda algo que ordena con `<`.
 *
 * ---------------------------------------------------------------------------
 * LOS METODOS QUE TOMAN UN `client`
 * ---------------------------------------------------------------------------
 * `products.resolveForOrder`, `services.resolveForOrder` y todo lo de
 * `orders.createAtomicTx` reciben el client de `pg` como primer parametro, en
 * lugar de pedir uno al pool. No es una excepcion a una regla: es lo que
 * permite que la resolucion de un item ocurra DENTRO de la transaccion del
 * pedido. Si se resolriera antes, entre la lectura del precio y el INSERT otro
 * pedido (o un PUT del admin) puede cambiarlo, y el pedido guardaria un precio
 * que ya no existe.
 *
 * El call site de la app NUNCA los invoca con un client propio: los usa
 * `orders.createAtomic`, que ya abrio la transaccion. Quedan exportados para
 * que un test pueda abrir la suya.
 */
require('dotenv').config();

// pool.js tira si falta DATABASE_URL, y lo hace en TODOS los entornos a
// proposito (REQ-SEC-09). Este es el punto de entrada de la capa de datos, asi
// que es su responsabilidad tener el env cargado antes de llegar al pool: si
// dependiera de que otro modulo haya cargado dotenv, el orden de los requires
// pasaria a decidir si la app arranca.
const pool = require('./postgres/pool');
const categoriesQ = require('./postgres/queries/categories');
const productsQ = require('./postgres/queries/products');
const servicesQ = require('./postgres/queries/services');
const usersQ = require('./postgres/queries/users');
const contactQ = require('./postgres/queries/contact');
const settingsQ = require('./postgres/queries/settings');
const passwordResetsQ = require('./postgres/queries/passwordResets');
const ordersQ = require('./postgres/queries/orders');
const dashboardQ = require('./postgres/queries/dashboard');

const users = {
  // Devuelve la fila CON `password`: es lo unico que hace posible el login.
  // Es la unica excepcion, y por eso esta una sola vez y no en un mapper
  // compartido. Ver queries/users.js.
  //
  // `create` tambien la devuelve, y `update` NO. La asimetria esta justificada
  // en queries/users.js: el `create` tiene un solo call site (el register) y el
  // `update` tambien (el PUT), pero ninguno de los dos necesita el hash para
  // armar su respuesta.
  findById: usersQ.findById,
  findByEmail: usersQ.findByEmail,
  findByDni: usersQ.findByDni,
  list: usersQ.list,
  create: usersQ.create,
  update: usersQ.update,
  remove: usersQ.remove,
};

const categories = {
  list: categoriesQ.list,
  findByIdOrSlug: categoriesQ.findByIdOrSlug,
  create: categoriesQ.create,
  update: categoriesQ.update,
  remove: categoriesQ.remove,
};

const products = {
  list: productsQ.list,
  findByIdOrSlug: productsQ.findByIdOrSlug,

  create: productsQ.create,
  update: productsQ.update,
  remove: productsQ.remove,

  // Fase 4: resuelve id-o-slug, RECHAZA los inactivos y NO RECIBE precio. Por
  // eso el precio de un pedido no puede venir del body aunque el handler lo
  // quiera. Ver queries/products.js.
  resolveForOrder: productsQ.resolveForOrder,
};

const services = {
  list: servicesQ.list,
  findByIdOrSlug: servicesQ.findByIdOrSlug,
  create: servicesQ.create,
  update: servicesQ.update,
  remove: servicesQ.remove,

  // El gemelo para items de tipo `service`. Mismo contrato, misma regla de
  // inactivos, mismo `client` por parametro.
  resolveForOrder: servicesQ.resolveForOrder,
};

/**
 * D-01: la transaccion es una PROPIEDAD DEL METODO. `createAtomic` abre, corre
 * y deja que `withTransaction` cierre; el call site no tiene con que acordarse
 * ni de `BEGIN` ni de `ROLLBACK`, y por lo tanto no puede olvidarse.
 *
 * `createAtomicTx` queda exportado por una sola razon: el test de concurrencia
 * necesita DOS transacciones simultaneas y el pool del modulo es `max: 1` a
 * proposito (ver pool.js). El test abre las suyas en un pool `max: 2` y ejercita
 * este MISMO codigo, no una copia.
 */
const orders = {
  createAtomic: ordersQ.createAtomic,
  createAtomicTx: ordersQ.createAtomicTx,
  list: ordersQ.list,
  findById: ordersQ.findById,
  updateStatus: ordersQ.updateStatus,
};

const contact = {
  list: contactQ.list,
  create: contactQ.create,
  markRead: contactQ.markRead,
};

const settings = {
  getAll: settingsQ.getAll,
  upsertMany: settingsQ.upsertMany,
};

const passwordResets = {
  findValidByToken: passwordResetsQ.findValidByToken,
  create: passwordResetsQ.create,
  invalidateAllForUser: passwordResetsQ.invalidateAllForUser,
};

/**
 * `true` si la base responde. NUNCA tira: un chequeo de salud que lanza no
 * sirve para reportar que la base esta caida, que es justo el caso para el que
 * existe. El consumidor decide que hacer con el `false`.
 */
async function ping() {
  try {
    return await pool.preflight();
  } catch {
    return false;
  }
}

const health = { ping };

module.exports = {
  users,
  categories,
  products,
  services,
  orders,
  contact,
  settings,
  passwordResets,
  dashboard: { stats: dashboardQ.stats },
  health,
};
