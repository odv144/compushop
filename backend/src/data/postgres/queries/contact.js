/**
 * CONTACT MESSAGES — lectura (tarea 2.6).
 *
 * `GET /contact` tiene tres cosas que no son "obvias" y por eso estan aca
 * comentadas:
 *
 *  1. ORDEN `created_at DESC`. El store hacia
 *     `[...contact_messages].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))`.
 *
 *  2. `, id ASC` COMO DESEMPATE. `Array.prototype.sort` es ESTABLE: dos
 *     mensajes con el MISMO `created_at` quedan en el orden del array, o sea
 *     por id ascendente. `order by created_at desc` solo, en Postgres, deja el
 *     orden de los empates SIN ESPECIFICAR: dos llamadas al mismo endpoint
 *     pueden devolver los dos mensajes en orden contrario. Agregando el
 *     desempate explicito se replica el comportamiento del store, y de paso
 *     la paginacion deja de poder duplicar o perder un mensaje.
 *
 *  3. `unread` es el filtro de `?unread=true`, o sea "NO leidos". La ruta lo
 *     compara contra el STRING 'true', asi que aca se acepta el booleano o el
 *     string: la ruta de la Fase 4 va a pasar lo que le llegue del query param.
 *     `false` y `undefined` no filtran, que es el default.
 *
 * Sin enriquecimiento: el shape sale tal cual de la tabla.
 */
const { withClient } = require('../pool');

const COLS = 'm.id, m.name, m.email, m.phone, m.subject, m.message, m.is_read, m.created_at';

async function list({ unread } = {}) {
  return withClient(async (c) => {
    const params = [];
    let where = '';
    // Acepta `true` y el string 'true' porque la ruta comparaba contra el
    // string. Cualquier otro valor (incluido 'false') significa "sin filtro",
    // que es lo que hoy hace un `?unread=false`.
    if (unread === true || unread === 'true') {
      params.push(false);
      where = 'where m.is_read = $1';
    }

    const r = await c.query(
      `select ${COLS} from contact_messages m ${where} order by m.created_at desc, m.id asc`,
      params,
    );
    return r.rows;
  });
}

// =============================================================================
// ESCRITURAS (tareas 3.5)
// =============================================================================

const INSERT_COLS = 'name, email, phone, subject, message';

/**
 * `is_read` NO va en el INSERT: sale del default de la columna (`false`), que es
 * lo que el store seteaba a mano. Un mensaje recien creado que ya viene leido es
 * un estado que la API no puede producir, y dejarlo como default hace que ni el
 * SQL pueda expresarlo.
 */
async function create(message) {
  return withClient(async (c) => {
    const r = await c.query(
      `insert into contact_messages (${INSERT_COLS})
            values ($1, $2, $3, $4, $5)
          returning id, name, email, phone, subject, message, is_read, created_at`,
      [
        String(message.name),
        String(message.email),
        message.phone ?? null,
        message.subject ?? null,
        String(message.message),
      ],
    );
    return r.rows[0] || null;
  });
}

/**
 * `true` si HABIA un mensaje con ese id.
 *
 * El `PUT /contact/:id/read` actual responde 200 SIEMPRE, incluso con un id que
 * no existe: `if (m) { m.is_read = true }` y despues el `res.json` sin
 * condiciones. Por eso este metodo devuelve el booleano y la ruta NO lo usa para
 * decidir el status. Se devuelve igual, para que un `404` sea disponible el dia
 * que la API quiera darlo, sin cambiar el metodo.
 */
async function markRead(id) {
  return withClient(async (c) => {
    const r = await c.query('update contact_messages set is_read = true where id = $1', [Number(id)]);
    return r.rowCount > 0;
  });
}

module.exports = { list, create, markRead };
