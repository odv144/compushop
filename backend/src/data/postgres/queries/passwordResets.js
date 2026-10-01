/**
 * PASSWORD RESETS — lectura (tarea 2.8).
 *
 * ---------------------------------------------------------------------------
 * LA VALIDEZ SE RESUELVE EN SQL, NO EN JS
 * ---------------------------------------------------------------------------
 * El store traia la fila y despues comparaba en Node:
 *
 *     db.password_resets.find(r => r.token === token && !r.used
 *                                 && new Date(r.expires_at) > new Date())
 *
 * La comparacion de timestamps en JS tiene una zona horaria implicita: el
 * string ISO se parsea a UTC y `new Date()` es el instante actual, asi que hoy
 * funciona. Pero es una comparacion entre dos representaciones del mismo
 * instante, hecha con dos conversiones, en un lugar que no es el dueño del dato.
 *
 * En SQL es `expires_at > now()`, que es `timestamptz` contra `timestamptz`:
 * correcto por construccion y en la zona que usa la base.
 *
 * El beneficio extra es que la fila invalida NI SE TRAE. Traer el token de un
 * reset ya usado y descartar la fila despues es una fila de mas que existe en
 * la memoria del proceso sin motivo.
 */
const { withClient } = require('../pool');

const COLS = 'r.id, r.user_id, r.token, r.expires_at, r.used, r.created_at';

/**
 * @returns {Promise<object|null>} el reset valido, o `null` si no hay ninguno
 *   con ese token que siga sin usar y sin expirar.
 */
async function findValidByToken(token) {
  return withClient(async (c) => {
    const r = await c.query(
      `select ${COLS}
         from password_resets r
        where r.token = $1
          and r.used = false
          and r.expires_at > now()
        order by r.id
        limit 1`,
      [String(token)],
    );
    return r.rows[0] || null;
  });
}

module.exports = { findValidByToken, create, invalidateAllForUser };

// =============================================================================
// ESCRITURAS (tarea 3.7)
// =============================================================================

/**
 * `expires_at` va como ISO STRING y no como `Date`.
 *
 * `timestamptz` acepta los dos, pero el string es lo que produce el codigo que
 * llama (`new Date(Date.now() + 3600000).toISOString()`) y pasarlo crudo evita
 * una conversion por el camino que pueda correrse de zona horaria. La columna
 * lo normaliza a UTC igual, asi que el instante guardado es el mismo.
 *
 * `used` sale del default (`false`). `created_at` tambien: el default es
 * `now()`, que es el `new Date().toISOString()` de antes.
 */
async function create({ user_id, token, expires_at }) {
  return withClient(async (c) => {
    const r = await c.query(
      `insert into password_resets (user_id, token, expires_at)
            values ($1, $2, $3)
          returning id, user_id, token, expires_at, used, created_at`,
      [Number(user_id), String(token), expires_at],
    );
    return r.rows[0] || null;
  });
}

/**
 * UN `UPDATE`, no un `SELECT` de ids seguido de N updates.
 *
 * El store hacia `db.password_resets.forEach(r => { if (r.user_id === user.id) r.used = true })`: un
 * recorrido en memoria. La equivalente en SQL es un solo `UPDATE ... WHERE user_id = $1`, que es
 * atomico por si mismo y no necesita transaccion.
 *
 * Que invalidar todos los resets del usuario en vez de borrar los viejos es lo
 * que hace el store, y es lo correcto: borrar deja menos rastro de que hubo un
 * pedido de reset, y `used = true` conserva la evidencia.
 *
 * ---------------------------------------------------------------------------
 * NO ES ATOMICO CON EL `create` DEL MISMO REQUEST
 * ---------------------------------------------------------------------------
 * `forgotPassword` llama a este metodo y despues al `create`, en dos viajes
 * separados. Si el `create` fallara, los resets viejos quedan invalidados y no
 * hay nuevo: el usuario tiene que pedir uno nuevo. Es el mismo resultado que
 * da un 500 y un reintento, asi que no se pierde nada, pero si alguna vez se
 * quiere que el par sea indivisible hace falta un metodo unico que las dos cosas
 * dentro de `withTransaction`. El contrato de `repo.passwordResets` define los
 * dos metodos por separado, asi que aca no se inventa un tercero.
 *
 * @returns {Promise<number>} cuantos resets quedaron invalidados.
 */
async function invalidateAllForUser(userId) {
  return withClient(async (c) => {
    const r = await c.query('update password_resets set used = true where user_id = $1', [Number(userId)]);
    return r.rowCount;
  });
}
