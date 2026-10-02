/**
 * Fuente unica de verdad para mostrar precios.
 *
 * Decimales condicionales a proposito: en un catalogo de hardware el 95% de los
 * precios son enteros y agregarles ",00" es ruido visual, pero cuando el precio
 * REAL tiene centavos hay que mostrarlos. Un "$ 6.900" sobre un dato guardado
 * como 6899.99 hace creer que los centavos se perdieron, que es exactamente el
 * bug que reporto el usuario. Y cuando los hay van los dos digitos: $ 45,50 y
 * no $ 45,5, porque un precio truncado en pantalla tambien se lee como error.
 *
 * Regla de AGENTS.md: precio, nombre y existencia se resuelven SIEMPRE en el
 * server. Esta funcion solo formatea lo que ya viene resuelto.
 */

const SIN_DATO = '\u2014';

/**
 * Convierte a numero finito, o devuelve null si no hay dato usable.
 * Number('') === 0 y Number(null) === 0: sin esta guarda, un campo vacio
 * terminaria mostrandose como un producto de $0.
 */
const toPrecio = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {number|string|null|undefined} value precio a mostrar
 * @returns {string} precio formateado en es-AR, o un guion si no hay dato
 */
export function formatPrice(value) {
  const n = toPrecio(value);
  if (n === null) return SIN_DATO;

  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}