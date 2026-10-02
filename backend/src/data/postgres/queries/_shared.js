/**
 * Helpers de SQL compartidos por los modulos de entidad de `queries/`
 * (categories.js, products.js, services.js, ...).
 *
 * El prefijo `_` no es decorativo: este archivo NO es un modulo de entidad.
 * No exporta `list()` ni `findById()`. Exporta las tres piezas de armado de
 * WHERE que mas de un modulo necesita y que, si se duplican, se divergen.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTO NO ESTA EN mappers.js
 * ---------------------------------------------------------------------------
 * mappers.js es PURO por un motivo concreto: los tests de contrato corren sin
 * base. Si un mapper armara SQL, cada diferencia de API necesitaria una base
 * levantada para diagnosticarse. Un helper que devuelve TEXTO de SQL es lo
 * contrario de un mapper: no toca filas, pero tampoco es puro. Va aca.
 *
 * ---------------------------------------------------------------------------
 * POR QUE CADA PIEZA ESTA ACA Y NO INLINEADA
 * ---------------------------------------------------------------------------
 * Las tres replican comportamiento EXACTO del store JSON. Duplicarlas en cada
 * modulo es como la diferencia aparece en uno solo y el resto queda viejo.
 */

/**
 * `ILIKE` trata `%` y `_` de la DIRECHA como comodines. El store NO lo hacia:
 * filtraba con `nombre.toLowerCase().includes(termino)`, donde un `%` es un
 * `%` literal.
 *
 * Sin este escape, un cliente que busca el producto "Pantalla 24\"" y pega
 * `24_` recibe en pantalla notebooks que NO deveria ver, y uno que busca `50%`
 * recibe practicamente el catalogo entero. El filtro se vuelve trivialmente
 * manipulable desde el exterior.
 *
 * Con el escape + `ESCAPE '\'`, el patron vuelve a ser el substring literal que
 * `includes()` buscaba. Es la unica forma de que la busqueda en SQL signifique
 * lo mismo que la de antes.
 *
 * OJO con el orden: primero se escapan los separadores, y recien ahi se
 * agregan los `%` de borde.
 */
function escapeLike(term) {
  return String(term).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * El patron completo para un `includes()`: `%` + termino escapado + `%`.
 * Usar con `ESCAPE '\'`.
 */
function likePattern(term) {
  return `%${escapeLike(term)}%`;
}

/**
 * La regla de "esto es un id y no un slug", copiada de la ruta:
 *
 *     const key = isNaN(req.params.id) ? 'slug' : 'id';
 *
 * No se "mejora" a un chequeo de digitos. `isNaN` es lo que decide hoy, y
 * cambiarlo cambia que responde `GET /products/1e3` y `GET /products/1.0`.
 *
 * Con `Number()` y no el string crudo: el store comparaba con `==` flojo
 * (`p.id == '1'`), y en Postgres un `integer = $1` con un texto dispara error
 * de tipo. El numero ya resuelto es el equivalente exacto de ese `==`.
 *
 * @param {string} alias - prefijo de tabla, para no chocar en el JOIN.
 * @param {any[]} params - se MUTA: agrega el valor y devuelve la posicion.
 * @param {any} key - el valor crudo del parametro de ruta.
 * @returns {string} el fragmento SQL, con su placeholder ya numerado.
 */
function idOrSlugWhere(alias, params, key) {
  if (!isNaN(key)) {
    params.push(Number(key));
    return `${alias}.id = $${params.length}`;
  }
  params.push(String(key));
  return `${alias}.slug = $${params.length}`;
}

/**
 * Normaliza `page` y `limit`.
 *
 * Reproduce el `parseInt(x) || fallback` de la ruta para todo input sensato,
 * y ADEMAS cierra el caso patologico. `page = -1` en el store daba:
 *
 *     start = (-1 - 1) * 20 = -40
 *     list.slice(-40, -20)
 *
 * o sea, indices negativos de `slice` contam desde el FINAL de la lista. La
 * pagina "-1" devolvia los ultimos productos, no una pagina. En SQL lo mismo
 * es `OFFSET -40`, que Postgres rechaza con error. No se replica una
 * excepcion: se devuelve la pagina 1, que es lo que el que manda el parametro
 * estaba pidiendo.
 *
 * `limit = 0` SI se replica: `parseInt('0') || 20` da 20, y `Math.ceil(total/0)`
 * nunca llega a ejecutarse porque el limite ya es 20.
 *
 * @param {any} value - valor crudo (string del query, o number de un default).
 * @param {number} fallback - el default de la ruta.
 * @param {number} min - 1 para ambos. No hay un caso de uso legitimo de 0.
 */
function intOr(value, fallback, min = 1) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/**
 * Arma el `SET` de un UPDATE a partir de una patch, sobre una lista de columnas
 * FIJAS.
 *
 * ---------------------------------------------------------------------------
 * POR QUE LOS NOMBRES DE COLUMNA NO SE PARAMETRIZAN (y sin embargo no hay inyeccion)
 * ---------------------------------------------------------------------------
 * Postgres no acepta un placeholder en la parte `SET col = ...`: los valores van
 * `$1`, `$2`, y el LADO IZQUIERDO tiene que ser texto literal. O sea que el
 * nombre de la columna no se puede pasar como parametro. La unica forma de que
 * eso no sea una inyeccion es que el nombre NUNCA venga del request: sale de
 * `allowed`, que es un array literal del modulo, escrito por una persona.
 *
 * Por eso la firma es `(allowed, patch)` y no `(patch)`: el call site no puede
 * "olvidarse" de la allowlist, porque el primer argumento la exige. Y el
 * recorrido es sobre `allowed`, no sobre las claves de `patch`: una clave de mas
 * que llegue del request no produce ni un `SET` ni un error, simplemente no
 * existe como columna posible.
 *
 * Que devuelve `{ sets: [], params: [] }` cuando la patch no trae ninguna clave
 * de la lista, y eso NO se traduce a un `set  where ...`: el UPDATE vacio es un
 * error de sintaxis. Cada call site tiene que decidir que hacer, y la respuesta
 * no es la misma segun la entidad (un `PUT /settings` sin claves no cambia
 * nada; un `PUT /categories/:id` sin claves devuelve la fila como estaba).
 *
 * El `undefined` se saltea y NO se escribe: es la diferencia entre "el cliente
 * no mando este campo" y "el cliente mando null". El store hacia exactamente eso
 * con `if (req.body[f] !== undefined) p[f] = req.body[f]`.
 *
 * @param {string[]} allowed - columnas escribibles, en orden fijo.
 * @param {object} patch - valores a aplicar.
 * @returns {{sets: string[], params: any[]}}
 */
function updateFrom(allowed, patch) {
  const sets = [];
  const params = [];
  for (const column of allowed) {
    if (patch[column] === undefined) continue;
    params.push(patch[column]);
    sets.push(`${column} = $${params.length}`);
  }
  return { sets, params };
}

module.exports = { escapeLike, likePattern, idOrSlugWhere, intOr, updateFrom };
