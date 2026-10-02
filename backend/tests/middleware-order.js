/**
 * Predicado compartido: orden de montaje de keep-warm vs limitador global.
 *
 * ===========================================================================
 * POR QUE ESTA EN UN ARCHIVO PROPIO Y NO DENTRO DEL TEST
 * ===========================================================================
 * El guard de orden vive en `architecture.test.js` y su mutacion se prueba en
 * `guards-selftest.test.js`. Con el predicado escrito DOS veces (una en cada
 * archivo) el selftest puede estar probando una copia que el guard real no usa:
 * se "pasa" una mutacion que el guard real no detectaria. Aca hay UNA sola
 * implementacion y los dos archivos la requieren, asi que no pueden divergir.
 *
 * ===========================================================================
 * POR QUE UN GUARD DE COMPORTAMIENTO NO ALCANZA
 * ===========================================================================
 * En tests `rateLimit.isTest` es true y el limitador global NO se registra. Un
 * guard que arrancara el server y mirara el orden real de la cadena de middlewares
 * no veria NADA: el limiter no esta. Y uno que solo mirara "la ruta responde 503"
 * tampoco alcanza, porque no distingue el motivo. Asi que el orden se verifica
 * leyendo el archivo.
 *
 * ===========================================================================
 * LAS CUATRO REGLAS DEL PREDICADO
 * ===========================================================================
 * 1. el montaje de keep-warm existe.
 * 2. el limitador global existe.
 * 3. keep-warm va ANTES del limitador (si no, un 429 tapa el 503/401 y el
 *    endpoint deja de servir para diagnosticar).
 * 4. el montaje de keep-warm esta a PROFUNDIDAD 0: no esta adentro de ningun
 *    `if`. Esto es lo que rompia y lo que el `indexOf` NO detectaba: en la
 *    version con `if (rateLimit.isTest) { } else { mount; limiter }` el
 *    `indexOf` de la linea del mount seguia dando un numero MENOR que el del
 *    limiter, asi que el guard daba verde sobre el bug. La profundidad de llaves
 *    si lo ve.
 * 5. el limitador sigue registrado DENTRO de un `if (!rateLimit.isTest)`. Si
 *    desaparece, la regla 4 sola no alcanza: el limite pasaria a registrarse en
 *    tests. Esta regla NO mira el orden: mira la forma del bloque, para que un
 *    fallo de orden no se reporte como un fallo de esta.
 */

const MOUNT = "app.all('/api/health/keep-warm'";
const LIMITER = 'rateLimit.globalLimiter()';

/**
 * Profundidad de llaves en `limite`, ignorando comentarios y strings.
 *
 * Los comentarios importan: el bloque de comentario que explica el por que del
 * montaje tiene llaves y numeros que, contados, corrarian la profundidad.
 * Los strings tambien: `` `CORS bloqueado (${reason})` `` tiene una `{` y una
 * `}`. Se tratan los tres (linea, bloque, comillas) como opacos.
 *
 * Los templates se tratan como opacos enteros, o sea que `${...}` no cuenta.
 * Para este guard eso es lo correcto: una sustitucion balanceada no deberia
 * mover la profundidad, y una llave suelta DENTRO de un template menos.
 */
function profundidadEn(src, limite) {
  let depth = 0;
  let i = 0;
  while (i < limite && i < src.length) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      while (i < limite && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < limite && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < limite) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return depth;
}

/**
 * El limitador global registrado DENTRO de un `if (!rateLimit.isTest) { ... }`
 * que no contiene nada mas.
 *
 * ===========================================================================
 * POR QUE UN REGEX Y NO "EL `if` ESTA ENTRE EL MOUNT Y EL LIMITER"
 * ===========================================================================
 * La primera version hacia exactamente eso: `slice(mount, limiter)` y buscar el
 * `if` adentro. Con el orden invertido el `slice` salia VACIO, el flag daba
 * false, y el test "el limitador sigue siendo condicional a NODE_ENV=test"
 * fallaba DICHAENDO ESO. Pero el limitador seguia adentro del `if` que lo
 * protege: la regla no se habia roto, solo habia cambiado el orden. O sea que
 * el guard anunciaba una regla distinta de la que se rompio, que es el mismo
 * defecto que el bug original (un guard que no describe lo que mide) y deja el
 * diagnostico mintiendo: el que lee el rojo Cree que el limitador quedo
 * global cuando el problema era el orden.
 *
 * Este regex no mira el orden: describes la FORMA que tiene que tener el bloque,
 * sola. Y que el bloque no contenga nada mas es deliberado, no decorativo: si
 * mañana alguien mete `app.use(cors(...))` ahi adentro, ese middleware pasaria a
 * no registrarse en tests y el fallo seria dificil de atribuir.
 */
const LIMITER_GUARDADO =
  /if\s*\(\s*!\s*rateLimit\.isTest\s*\)\s*\{\s*app\.use\(\s*(['"])\/api\1\s*,\s*rateLimit\.globalLimiter\(\)\s*\)\s*;?\s*\}/;

/** Datos crudos del archivo, para que el assert diga QUE regla fallo. */
function analizar(src) {
  const mount = src.indexOf(MOUNT);
  const limiter = src.indexOf(LIMITER);
  return {
    mount,
    limiter,
    profundidadMount: mount === -1 ? null : profundidadEn(src, mount),
    profundidadLimiter: limiter === -1 ? null : profundidadEn(src, limiter),
    limiterGuardadoPorIsTest: LIMITER_GUARDADO.test(src),
  };
}

/** El predicado. `true` = el orden es el que el endpoint necesita para ser diagnosticable. */
function ordenKeepWarmValido(src) {
  const a = analizar(src);
  return (
    a.mount !== -1 &&
    a.limiter !== -1 &&
    a.mount < a.limiter &&
    a.profundidadMount === 0 &&
    a.limiterGuardadoPorIsTest
  );
}

const eolDe = (src) => (src.includes('\r\n') ? '\r\n' : '\n');
const partirLineas = (src) => src.split(/\r?\n/);

// ---------------------------------------------------------------------------
// MUTADORES
// ---------------------------------------------------------------------------
// Devuelven el fuente mutado, o el ORIGINAL sin tocar si la forma no se reconoce.
// Devolver el original sin cambios es lo que hace que un mutador roto no pueda
// pasar por "`detecto la mutacion`": el assert `notEqual(mutado, original)` lo
// delata en el selftest.

/** M1: intercambia el orden -> keep-warm queda atras del limitador. */
function mountDespuesDelLimiter(src) {
  const lineas = partirLineas(src);
  const iMount = lineas.findIndex((l) => l.includes(MOUNT));
  if (iMount === -1 || !lineas.some((l) => l.includes(LIMITER))) return src;
  const [movida] = lineas.splice(iMount, 1);
  const iLimiter = lineas.findIndex((l) => l.includes(LIMITER));
  // Insertar despues de la llave que CIERRA el `if (!rateLimit.isTest)`, no
  // despues de la linea del limitador: esa linea esta adentro del bloque, y
  // meterla ahi dejaba el montage en profundidad 1 ademas de despues. Una
  // mutacion que rompe dos reglas a la vez no puede usarse para probar que cada
  // guard mide lo que dice medir.
  let cierre = -1;
  for (let i = iLimiter; i < lineas.length; i++) {
    if (/^\s*\}/.test(lineas[i])) { cierre = i; break; }
  }
  if (cierre === -1) return src;
  lineas.splice(cierre + 1, 0, movida);
  return lineas.join(eolDe(src));
}

/** M2: vuelve a meter el montaje adentro de un condicional (el bug original). */
function mountDentroDeIf(src) {
  const lineas = partirLineas(src);
  const i = lineas.findIndex((l) => l.includes(MOUNT));
  if (i === -1) return src;
  const indent = (lineas[i].match(/^\s*/) || [''])[0];
  const cuerpo = lineas[i].slice(indent.length);
  lineas.splice(i, 1, `${indent}if (rateLimit.isTest) {`, `${indent}  ${cuerpo}`, `${indent}}`);
  return lineas.join(eolDe(src));
}

/**
 * M3: saca el `if` que hace condicional el registro del limitador.
 *
 * Saca la llave de cierre que queda colgando tambien. No por estetica: una
 * mutacion que deja el archivo sin parsear no se parece a ninguna regresion
 * real (un developer nunca sube una llave descolgando), asi que probaria el
 * predicado contra una situacion que no existe.
 */
function limiterSinGuard(src) {
  const sinIf = src.replace(/if\s*\(\s*!\s*rateLimit\.isTest\s*\)\s*\{[^\S\r\n]*\r?\n[^\S\r\n]*/, '');
  if (sinIf === src) return src;
  const lineas = partirLineas(sinIf);
  const iLimiter = lineas.findIndex((l) => l.includes(LIMITER));
  if (iLimiter === -1) return src;
  for (let i = iLimiter + 1; i < lineas.length; i++) {
    if (/^\s*\}\s*$/.test(lineas[i])) {
      lineas.splice(i, 1);
      break;
    }
  }
  return lineas.join(eolDe(sinIf));
}

module.exports = {
  MOUNT,
  LIMITER,
  profundidadEn,
  analizar,
  ordenKeepWarmValido,
  mountDespuesDelLimiter,
  mountDentroDeIf,
  limiterSinGuard,
};
