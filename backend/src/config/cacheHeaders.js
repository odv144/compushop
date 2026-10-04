/**
 * Politica de cache de la API.
 *
 * ---------------------------------------------------------------------------
 * EL PROBLEMA QUE ESTO ARREGLA
 * ---------------------------------------------------------------------------
 * Antes no habia NINGUN header de cache en el backend. Express pone `ETag` por
 * default, y con eso el navegador revalida y recibe 304. Eso PARECE caching y
 * no lo es: para calcular el ETag, Express primero genera el JSON COMPLETO de la
 * respuesta, o sea que la query a la base YA corrio y el body YA se construyo.
 * El 304 ahorra ancho de banda y CERO trabajo de base.
 *
 * Peor: sin `Cache-Control` ni `Vary`, una respuesta autenticada queda
 * almacenable por el navegador. `/api/settings` devuelve las DIEZ claves de la
 * tabla `settings` sin redaccion, `smtp_pass` incluida (ver
 * postgres/queries/settings.js). Un admin que abre /admin/configuracion puede
 * dejar la contrasena del SMTP en el cache de disco de la maquina.
 *
 * ---------------------------------------------------------------------------
 * LA POLITICA: DEFAULT DENY, NO DEFAULT ALLOW
 * ---------------------------------------------------------------------------
 * Todo `/api` es `no-store`. DESPUES se abre el cache para un catalogo
 * explicitamente nombrado.
 *
 * La lista de rutas cacheables esta ACA y en ningun otro lado, por el mismo
 * motivo que la allowlist de settings vive en el modulo que arma el INSERT: que
 * "esta ruta se cachea" sea una propiedad de un solo archivo y no algo que se
 * decide request por request. Una ruta nueva nace `no-store` sin que nadie
 * tenga que acordarse. Si mañana se agrega un endpoint con datos de otra
 * persona, sale seguro por defecto y no por acordarse.
 *
 * ---------------------------------------------------------------------------
 * POR QUE `max-age=0` Y NO `max-age=300`
 * ---------------------------------------------------------------------------
 * `max-age` es el navegador, `s-maxage` es el CDN de Vercel. Van distintos a
 * proposito:
 *
 *   - `max-age=0` + el ETag de Express => el navegador revalida siempre y sigue
 *     recibiendo 304. No se pierde el comportamiento que ya funciona.
 *   - `s-maxage=60` => el edge de Vercel responde durante 60s y el request NO
 *     LLEGA a la funcion. Esta es la parte que de verdad saca queries: no las
 *     acelera, las elimina.
 *
 * O sea: el ETag sigue sirviendo al navegador, y el CDN evita que la mayor parte
 * de las veces haya una funcion invocada. `stale-while-revalidate=300` deja que
 * el edge siga sirviendo la version vieja mientras revalida en background, en
 * vez de bloquear al usuario esperando un refresh.
 *
 * ---------------------------------------------------------------------------
 * `active=all` ESTA FUERA DE LA CACHE A PROPOSITO
 * ---------------------------------------------------------------------------
 * `GET /api/products?active=all` no es el catalogo publico: es la vista del
 * admin, la que incluye productos INACTIVOS con sus precios. Ademas hoy no pide
 * autenticacion (deuda preexistente, no introducida por este archivo). Marcarlo
 * cacheable dejaria Responses con productos sin publicar Guardadas en un cache
 * compartido, servidas sin volver a evaluar autorizacion.
 *
 * Un parametro de query que cambia la semantica de autorizacion no puede
 * depender solo del path para decidir si se cachea. Si el dia de manana se le
 * pone `authenticate` a `active=all`, esta guarda sigue siendo lo que impide
 * que el edge sirva el 200 cacheado sin pasar por el auth.
 */

/** Cache-Control del catalogo. Ver la nota de arriba sobre max-age vs s-maxage. */
const CATALOGO_CACHE_CONTROL =
  'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

/** Lo que recebe todo lo demas de la API. */
const NO_STORE = 'no-store';

/**
 * Rutas publicas y sin datos personales. Ancladas: `^` y `$` para que
 * `/products/123` matchee la segunda y `/products/123/extra` no matchee ninguna.
 * Se comparan contra `req.path`, que dentro de un `app.use('/api', ...)` ya
 * viene sin el prefijo.
 */
const CATALOGO = [
  /^\/products$/,
  /^\/products\/[^/]+$/,
  /^\/services$/,
  /^\/services\/[^/]+$/,
  /^\/categories$/,
];

/**
 * Un parametro de query invalida la cache. Hoy hay uno solo, y no es
 * arbitrario: `active=all` cambia que filas se devuelven, y esas filas no son
 * las publicas.
 */
const QUERY_INVALIDANTE = {
  active: 'all',
};

/**
 * El middleware se monta sobre la app ENTERA (ver src/index.js), asi que
 * `req.path` trae el prefijo: `/api/products`. La allowlist de arriba esta
 * escrita en terminos del RECURSO (`/products`), no del montaje, para que
 * mudarlo de `/api` a la app entera no obligue a reescribir los patrones.
 *
 * Normaliza las dos formas: `/api/products` y `/products` dan lo mismo.
 */
function normalizaRuta(path) {
  const p = typeof path === 'string' && path ? path : '/';
  if (p === '/api') return '/';
  return p.startsWith('/api/') ? p.slice(4) : p;
}

/**
 * `true` si esta request se puede cachear en el edge.
 * SOLO GET: los metodos con efecto no se cachean, y un 304 sobre un POST es un
 * bug de origen, no una optimizacion.
 */
function esCacheable(req) {
  if (req.method !== 'GET') return false;

  for (const [param, valor] of Object.entries(QUERY_INVALIDANTE)) {
    if (req.query && req.query[param] === valor) return false;
  }

  const ruta = normalizaRuta(req.path);
  return CATALOGO.some((re) => re.test(ruta));
}

/**
 * Solo un 200 es cacheable, y eso se decide AL VOLCAR LOS HEADERS.
 *
 * El middleware corre antes que el `corsGuard`, asi que cuando se decide la
 * cacheabilidad todavia no se sabe si la respuesta va a ser 200. Marcar el
 * catalogo como `public, s-maxage=60` a ciegas fue un bug real y con
 * consecuencias:
 *
 *   1. El `corsGuard` responde 403 sin llamar a `next()`. Ese 403 salia
 *     _headers con `public, s-maxage=60`_, o sea que un cache compartido lo
 *      guarda y lo sirve a cualquiera por 60 segundos. Con eso, UN request con
 *      un `Origin` invalido deja la API entera sin responder para todos los
 *      usuarios reales. Es un denegacion de servicio con una sola peticion.
 *
 *   2. Un 404 (`/products/999`) o un 500 (blip de la base) marcados igual
 *      convierten un error transitorio en un minuto de outage cacheado.
 *
 * La regla queda: se parte de `no-store` para TODA respuesta, y recien en el
 * `writeHead` —que es cuando ya se sabe el status y todavia no se envio
 * nada— se sube a la politica de edge, y solo si el status es 200.
 *
 * Envolver `writeHead` es el mecanismo que da Express para esto: los headers se
 * vuelcan ahi, asi que cambiar `Cache-Control` en ese punto todavia sirve.
 */
function cacheHeaders(req, res, next) {
  // El piso: toda respuesta de esta app nace no-store. El 403 del corsGuard, un
  // 500 del error handler y un 404 de ruta desconocida quedan cubiertos sin que
  // tengan que acordarse de la politica.
  res.set('Vary', 'Origin');
  res.set('Cache-Control', NO_STORE);

  if (esCacheable(req)) {
    const writeHeadOriginal = res.writeHead.bind(res);

    res.writeHead = function writeHeadConPoliticaDeCache(...args) {
      res.set('Cache-Control', res.statusCode === 200 ? CATALOGO_CACHE_CONTROL : NO_STORE);
      return writeHeadOriginal(...args);
    };
  }

  next();
}

module.exports = {
  cacheHeaders,
  esCacheable,
  normalizaRuta,
  CATALOGO_CACHE_CONTROL,
  NO_STORE,
  CATALOGO,
  QUERY_INVALIDANTE,
};