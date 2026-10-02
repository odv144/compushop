/**
 * USUERS — lectura (tarea 2.5).
 *
 * ---------------------------------------------------------------------------
 * `findByEmail` ES EXACTO. SIN `lower()`.
 * ---------------------------------------------------------------------------
 * El store hacia `db.users.find(u => u.email === email)`. Case-SENSITIVE. Y el
 * schema tiene un indice NO unico sobre `email` a proposito, que es la misma
 * decision: cambiar a `lower(email)` seria un cambio de comportamiento
 * observable, no una consecuencia de migrar la persistencia. Esta anotado en
 * el design como no-objetivo (follow-up), no como un bug pendiente de esta
 * fase.
 *
 * El UNICO filtro de busqueda de `GET /users` que se hace en SQL es este. Los
 * otros dos (`role` y `search`) los sigue aplicando la ruta en JS, porque el
 * `search` tiene un quirk: compara `dni` SIN lowercasing
 * (`(u.dni || '').includes(t)` contra `t` ya lowercase). Replicar eso en SQL
 * obligaria a `dni like '%' || $t || '%'` con el termino sin lowercasear, que
 * es mas dificil de leer que el `filter` de una linea y no compra nada.
 *
 * ---------------------------------------------------------------------------
 * EL HASH DE PASSWORD
 * ---------------------------------------------------------------------------
 * `findByEmail` es el UNICO metodo que devuelve la fila con `password`, y
 * tiene que ser asi: `authController.login` hace
 * `bcrypt.compare(password, user.password)`. Sin el hash no hay login, no hay
 * forma deazyar el contrato sin romper el acceso.
 *
 * `findById`, `findByDni` y `list` NO lo devuelven. Ninguno lo necesita
 * (`me` re-arma el objeto sin el campo igual, y el email de reset usa
 * `name`/`email`), y ampliar la superficie por la que pasa un hash de bcrypt es
 * JUSTAMENTE el riesgo que el mapper `userSafe` documenta: un call site que
 * olvide sacarlo. Un solo metodo con el hash es un metodo que se puede auditar.
 */
const { withClient } = require('../pool');
const { userSafe } = require('../mappers');
const { updateFrom } = require('./_shared');

const COLS = 'u.id, u.name, u.email, u.dni, u.role, u.phone, u.address, u.created_at';
const COLS_WITH_PASSWORD = `${COLS}, u.password`;

/**
 * `order by id limit 1` y no un LIMIT pelado: el store usaba `.find()`, que
 * devuelve el PRIMERO del array, o sea el de id mas bajo. Sin el ORDER BY,
 * `limit 1` devuelve una fila arbitraria de las que coincidan.
 */
async function findByEmail(email) {
  return withClient(async (c) => {
    const r = await c.query(`select ${COLS_WITH_PASSWORD} from users u where u.email = $1 order by u.id limit 1`, [
      String(email),
    ]);
    return r.rows[0] || null;
  });
}

/** forgot-password busca por DNI. Sin hash: el email de reset no lo necesita. */
async function findByDni(dni) {
  return withClient(async (c) => {
    const r = await c.query(`select ${COLS} from users u where u.dni = $1 order by u.id limit 1`, [String(dni)]);
    return r.rows[0] || null;
  });
}

async function findById(id) {
  return withClient(async (c) => {
    const r = await c.query(`select ${COLS} from users u where u.id = $1`, [Number(id)]);
    return r.rows[0] || null;
  });
}

/**
 * Sin argumentos a proposito: `GET /users` filtra por `role` y `search` en JS
 * (ver la nota del encabezado) y sin query params devuelve la lista entera.
 * Por eso este metodo alcanza para cubrir el endpoint tal como esta hoy.
 *
 * El orden es el del store: orden de insercion, o sea `order by id`.
 */
async function list() {
  return withClient(async (c) => {
    const r = await c.query(`select ${COLS} from users u order by u.id`);
    return r.rows.map(userSafe);
  });
}

// =============================================================================
// ESCRITURAS (tarea 3.1)
// =============================================================================

/**
 * `insert ... returning` y no un `insert` pelado seguido de un select. Es el
 * motivo por el que el pool tiene `max: 1` y no importa: son dos viajes al
 * pooler, y entre el segundo que se cuele otro `insert` con el mismo
 * `nextval` seria teoricamente posible. `returning` cierra la ventana.
 *
 * No se pone la columna `id`: la genera el default `nextval('users_id_seq')`.
 * La migracion hizo `setval` de esa secuencia al `seq` del JSON justamente para
 * que el primer id nuevo no choque con una fila migrada.
 */
const INSERT_COLS = 'name, email, password, dni, role, phone, address';

/**
 * El `RETURNING` va SIN el alias `u.` porque en un `INSERT` no hay tabla
 * apelada, y sin el alias las claves del objeto salen igual (`id`, `name`, ...).
 */
const RETURNING = 'id, name, email, password, dni, role, phone, address, created_at';

/**
 * `create` DEVUELVE LA FILA CON `password`, y `update` NO. La asimetria es
 * deliberada y no una inconsistencia:
 *
 * `register` necesita el hash recien hecho para armar el token? No — el token se
 * firma con id/email/role/name. Lo que sí necesita `create` es devolver la fila
 * para que la ruta la muestre, y la fila tal cual la trae `returning`.
 *
 * Se devuelve CON hash por el mismo motivo que `findByEmail` lo trae: el
 * call site es UNO, es el `register`, y el unico que puede querer el hash es el
 * login, que usa `findByEmail`. Un metodo mas que devuelve un hash de bcrypt es
 * un metodo mas que hay que auditar, asi que la superficie queda en dos.
 *
 * Por el contrario `update` NUNCA devuelve el hash: su unico call site es el
 * `PUT /users/:id`, que responde `{ message, user }` sin password. Si el
 * metodo lo trajera, el unico que podria filtrarlo es el mapper de la ruta, y
 * el mapper se olvida. Que el dato no exista es mejor que depender de que
 * alguien se acuerde de sacarlo.
 */
async function create(user) {
  return withClient(async (c) => {
    const r = await c.query(
      `insert into users (${INSERT_COLS})
            values ($1, $2, $3, $4, $5, $6, $7)
          returning ${RETURNING}`,
      [
        String(user.name),
        String(user.email),
        String(user.password),
        // `??` y no `||`: la normalizacion de "" a null la hace la ruta (como
        // antes, con `dni || null`). Aca el valor llega ya normalizado y `??`
        // deja pasar un "" si algun call site lo mandara, que es informacion.
        user.dni ?? null,
        user.role ?? 'customer',
        user.phone ?? null,
        user.address ?? null,
      ],
    );
    return r.rows[0] || null;
  });
}

/**
 * Solo columnas que el store tambien dejaba escribir. `created_at` NO esta en la
 * lista: el store no lo tocaba nunca (los usuarios no tienen `updated_at`), y
 * `created_at` se decide una vez, al insertar.
 */
const WRITABLE = ['name', 'email', 'dni', 'role', 'phone', 'address', 'password'];

async function update(id, patch) {
  const { sets, params } = updateFrom(WRITABLE, patch);

  // Patch vacia: el store hacia `Object.assign` sin cambios y devolvia la fila.
  // `update users set  where id = $1` es un error de sintaxis, y la fila que la
  // ruta tiene que responder es la que ya estaba.
  if (!sets.length) return findById(id);

  return withClient(async (c) => {
    const r = await c.query(
      `update users set ${sets.join(', ')} where id = $${params.length + 1} returning ${RETURNING}`,
      [...params, Number(id)],
    );
    return r.rows[0] ? userSafe(r.rows[0]) : null;
  });
}

/**
 * `true` si habia fila. El `DELETE` de Postgres no distingue "no existia" de
 * "existia y borre" en los datos: solo lo dice el `rowCount`. La ruta lo
 * traduce a 404, igual que hacia el `findIndex` del store.
 */
async function remove(id) {
  return withClient(async (c) => {
    const r = await c.query('delete from users where id = $1', [Number(id)]);
    return r.rowCount > 0;
  });
}

module.exports = { findByEmail, findByDni, findById, list, create, update, remove };
