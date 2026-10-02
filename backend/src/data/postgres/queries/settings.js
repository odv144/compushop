/**
 * SETTINGS — lectura (tarea 2.7).
 *
 * En la base es key/value de 2 columnas (D-04). La API expone UN objeto. El
 * mapper `settingsFromRows` hace la traduccion; aca solo se lee.
 *
 * ---------------------------------------------------------------------------
 * TODOS LOS VALORES SON STRING. INCLUIDO `smtp_port`.
 * ---------------------------------------------------------------------------
 * `smtp_port` es el texto "587", no el numero 587. La columna es `text` y el
 * store guardaba `String(req.body[k])`. Si esto devolviera numeros, el form de
 * configuracion del admin, que compara contra "587", deja de matchear y el
 * puerto se ve vacio. La conversion a numero, si alguna vez hace falta, es del
 * `parseInt` de `utils/email.js` — que ya lo hace.
 *
 * Sin filas -> `{}`. `Object.fromEntries([])` da `{}` solo, y la ruta ya hacia
 * `store.get().settings || {}`, o sea que un settings vacio es valido y no es un
 * error. Devolver `null` aca obligaria a cada call site a acordarse del `|| {}`.
 *
 * `order by key` no cambia el objeto (las claves no se ordenan en un JSON
 * object) pero hace la query determinista, que sirve para el diff de paridad.
 */
const { withClient, withTransaction } = require('../pool');
const { settingsFromRows } = require('../mappers');

async function getAll() {
  return withClient(async (c) => {
    const r = await c.query('select key, value from settings order by key');
    return settingsFromRows(r.rows);
  });
}

// =============================================================================
// ESCRITURAS (tarea 3.6)
// =============================================================================

/**
 * Las DIEZ claves que la API acepta. Vive ACA y no en la ruta, y no por
 * gusto propio: es la unica lista que el `INSERT` puede usar, asi que es la
 * unica que garantiza que ninguna otra llegue a la base.
 *
 * Antes la lista estaba en la ruta (`const allowed = [...]` en el handler), y
 * la ruta era el unico filtro. Con la base escrita desde la capa de datos, un
 * call site que pase el body entero escribiria una clave cualquiera. Que la
 * allowlist viva en el modulo que arma el INSERT es lo que hace que "el admin
 * no puede inventar una setting" sea una propiedad de la capa de datos y no una
 * linea de codigo que hay que acordarse de no borrar.
 */
const ALLOWED = [
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'contact_to',
  'store_name',
  'store_phone',
  'store_address',
  'store_email',
];

/**
 * `insert ... on conflict (key) do update`, y EN UNA SOLA TRANSACCION.
 *
 * ---------------------------------------------------------------------------
 * POR QUE UNA TRANSACCION Y NO 10 UPSERTS SUELTOS
 * ---------------------------------------------------------------------------
 * El store hacia `allowed.forEach(k => { if (body[k] !== undefined) settings[k] = String(...) })` y despues UN `persist()`: las diez escrituras eran atomicas porque eran un `JSON.stringify` de un objeto en memoria.
 *
 * Diez `INSERT ... ON CONFLICT` sueltos NO lo son. `putSetting` del admin manda
 * el formulario entero; si la quinta clave tira (una conexion que se cae, un
 * `value` que no entra), quedan cuatro claves nuevas y cinco viejas, y el
 * cliente recibio un 500. El admin reintenta y no sabe en que estado quedo la
 * configuracion de SMTP. Con la transaccion: o entran las diez, o no entra
 * ninguna.
 *
 * ---------------------------------------------------------------------------
 * POR QUE `String()` Y POR QUE EL UPSERT NO TOMA LA DECISION
 * ---------------------------------------------------------------------------
 * `String(v)` va en la capa de datos, no en la ruta, por el mismo motivo que la
 * allowlist: es la conversion que hace que `smtp_port` siga siendo `"587"` y no
 * el numero 587. Si se dejara en la ruta, un segundo call site que se olvide de
 * castear guardaria un numero y el form del admin dejaria de matchear (mappers.js
 * lo explica).
 *
 * `on conflict do update` es lo que hace que la escritura sea un UPSERT y no un
 * `insert` que revienta con el `key` primary. El store sobrescribia la clave sin
 * preguntar. Con `do nothing`, un segundo `PUT` de la misma clave no fallaria
 * pero tampoco guardaria: eso seria peor que un error visible.
 *
 * ---------------------------------------------------------------------------
 * LO QUE DEVUELVE
 * ---------------------------------------------------------------------------
 * El objeto COMPLETO releido dentro de la misma transaccion, no solo las claves
 * que el admin toco. `PUT /settings` responde `{ settings }` con las DIEZ claves
 * (las que se mandaron y las que no), y el front cuenta las que hay. Devolver
 * solo la patch haria que el form quedara vacio de los campos que no se mandaron.
 */
async function upsertMany(values) {
  return withTransaction(async (c) => {
    const rows = ALLOWED.filter((k) => values[k] !== undefined).map((k) => [k, String(values[k])]);
    for (const [k, v] of rows) {
      await c.query(
        `insert into settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value`,
        [k, v],
      );
    }
    const r = await c.query('select key, value from settings order by key');
    return settingsFromRows(r.rows);
  });
}

module.exports = { getAll, upsertMany, ALLOWED };
