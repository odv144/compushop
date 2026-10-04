/**
 * Politica de cache de la API.
 *
 * Que se este probando con `fetch` crudo y no con el helper `request` de
 * tests/helpers.js es a proposito: ese helper devuelve `{ status, body }` y
 * tira los headers. Esta politica ES headers, asi que un test que no puede ver
 * los headers no probaria nada.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { esCacheable } = require('../src/config/cacheHeaders');
const { PROD_ORIGIN } = require('../src/config/cors');
const { startTestServer } = require('./helpers');

// req minimo para la funcion pura. `esCacheable` solo lee estos tres campos.
const req = (method, path, query = {}) => ({ method, path, query });

describe('esCacheable - allowlist del catalogo', () => {
  test('el catalogo publico es cacheable', () => {
    for (const p of ['/products', '/products/abc', '/services', '/services/abc', '/categories']) {
      assert.equal(esCacheable(req('GET', p)), true, `${p} deberia ser cacheable`);
    }
  });

  test('active=all NO es cacheable', () => {
    // `active=all` devuelve productos INACTIVOS: no es el catalogo publico.
    assert.equal(esCacheable(req('GET', '/products', { active: 'all' })), false);
  });

  test('otros valores de active no invalidan la cache', () => {
    for (const v of ['true', 'false', '1', '']) {
      assert.equal(
        esCacheable(req('GET', '/products', { active: v })),
        true,
        `active=${v} deberia seguir siendo cacheable`,
      );
    }
  });

  test('solo GET', () => {
    // Un 304 sobre un POST es un bug de origen, no una optimizacion.
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal(esCacheable(req(m, '/products')), false, `${m} no deberia cachearse`);
    }
  });

  test('rutas con datos personales o autenticadas NO son cacheables', () => {
    for (const p of [
      '/auth/me',
      '/orders',
      '/orders/1',
      '/users',
      '/users/1',
      '/contact',
      '/settings',
      '/dashboard/stats',
    ]) {
      assert.equal(esCacheable(req('GET', p)), false, `${p} no deberia cachearse`);
    }
  });

  test('las rutas del catalogo estan ancladas', () => {
    // `/products/abc/extra` tiene que caer en no-store: sin `^`/`$` matchearia
    // el patron `^/products/[^/]+$`... no, no matchea. Lo que se verifica aca es
    // que no matchee por prefijo y caiga en la politica conservative.
    assert.equal(esCacheable(req('GET', '/products/abc/extra')), false);
    assert.equal(esCacheable(req('GET', '/products-xyz')), false);
  });

  test('el prefijo /api no cambia el resultado', () => {
    // El middleware esta montado sobre la app entera, asi que `req.path` trae
    // `/api/products`. La allowlist esta escrita en terminos del recurso y
    // `esCacheable` normaliza. Esto lo cubria el montaje: si se rompe la
    // normalizacion, el catalogo entero pasa a no-store en silencio y lo unico
    // que se ve es que la cache deja de funcionar. Sin test, nadie lo nota.
    assert.equal(esCacheable(req('GET', '/api/products')), true);
    assert.equal(esCacheable(req('GET', '/products')), true);

    assert.equal(esCacheable(req('GET', '/api/orders')), false);
    assert.equal(esCacheable(req('GET', '/api/settings')), false);
  });

  test('una ruta desconocida nace no-store', () => {
    // Default deny: lo que no esta en la allowlist NO se cachea.
    assert.equal(esCacheable(req('GET', '/algo-nuevo')), false);
  });
});

describe('headers en la app montada', () => {
  let api;

  before(async () => {
    api = await startTestServer();
  });

  after(async () => {
    if (api) await api.close();
  });

  const head = async (path, init = {}) => {
    const res = await fetch(`${api.origin}/api${path}`, init);
    return res;
  };

  // El token exacto, no `includes` de string: un header `Vary` puede traer
  // varios valores separados por coma (`Origin, Access-Control-Request-Headers`
  // en el preflight, que es lo que responde el paquete `cors`). Comparar por
  // igualdad exacta falla contra esa forma correcta; buscar la subcadena
  // aceptaria un `X-Origin` que no sirve. Lo que importa es que `Origin` sea UNO
  // DE LOS tokens.
  const assertVaryOrigin = (res) =>
    assert.ok(
      (res.headers.get('vary') || '').split(/\s*,\s*/).includes('Origin'),
      `Vary deberia incluir Origin; vino: ${res.headers.get('vary')}`,
    );

  test('el catalogo sale cacheable y con Vary: Origin', async () => {
    const res = await head('/products?limit=1');

    assert.match(res.headers.get('cache-control') || '', /s-maxage=60/);
    assert.ok(
      (res.headers.get('vary') || '').split(/\s*,\s*/).includes('Origin'),
      `Vary deberia incluir Origin; vino: ${res.headers.get('vary')}`,
    );
  });

  test('products?active=all sale no-store', async () => {
    const res = await head('/products?active=all&limit=1');

    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(
      (res.headers.get('vary') || '').split(/\s*,\s*/).includes('Origin'),
      `Vary deberia incluir Origin; vino: ${res.headers.get('vary')}`,
    );
  });

  test('un 404 del catalogo NO se cachea', async () => {
    // `/products/999999` matchea la allowlist (es un catalogo) pero responde 404.
    // Cachearlo convertiria "este producto no existe" en una verdad de 60s: si
    // despues se crea, el catalogo seguiria sin mostrarlo. Solo un 200 se cachea.
    const res = await head('/products/999999999');

    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('una ruta autenticada sale no-store aunque responda 401', async () => {
    // Sin token da 401. El header tiene que estar IGUAL: el 401 no dice nada
    // sobre la Politica, y si el middleware corriera despues de las rutas un
    // error temprano se escabulliria sin cachear.
    const res = await head('/orders');

    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('/settings sale no-store', async () => {
    // Devuelve smtp_pass en texto plano. Que quede en un cache de navegador
    // es justo lo que esta politica evita.
    const res = await head('/settings');

    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('el preflight OPTIONS lleva Vary: Origin', async () => {
    // OJO con el origen: `startTestServer` requirea la app con VERCEL=1 para que
    // exporte en vez de escuchar, y `buildCorsConfig` trata eso como produccion
    // (`isProd = NODE_ENV==='production' || !!env.VERCEL`). Por eso localhost
    // da 403 en los tests y `PROD_ORIGIN` es el unico que entra.
    const res = await head('/products', {
      method: 'OPTIONS',
      headers: { Origin: PROD_ORIGIN },
    });

    assert.equal(res.status, 204);
    assert.ok(
      (res.headers.get('vary') || '').split(/\s*,\s*/).includes('Origin'),
      `Vary deberia incluir Origin; vino: ${res.headers.get('vary')}`,
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('un 403 de CORS tambien lleva Vary: Origin y no-store', async () => {
    // El corsGuard corta con 403 sin llamar a `next()`. Si el middleware de
    // cache estuviera montado despues, este 403 saldria sin ningun header de
    // cache, que es exactamente el default-allow que la politica previene.
    const res = await head('/products', { headers: { Origin: 'https://evil.example' } });

    assert.equal(res.status, 403);
    assert.ok(
      (res.headers.get('vary') || '').split(/\s*,\s*/).includes('Origin'),
      `Vary deberia incluir Origin; vino: ${res.headers.get('vary')}`,
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('la politica tambien cubre rutas fuera de /api', async () => {
    // El middleware esta montado sobre la app entera, no sobre `/api`. `/` es la
    // unica ruta hoy, pero el punto es que una ruta nueva fuera de `/api` nace
    // con la politica puesta sin que nadie se acuerde de montarsela.
    const res = await fetch(`${api.origin}/`);

    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(
      (res.headers.get('vary') || '').split(/\s*,\s*/).includes('Origin'),
      `Vary deberia incluir Origin; vino: ${res.headers.get('vary')}`,
    );
  });

  test('el keep-warm sale no-store', async () => {
    // Sin CRON_SECRET responde 503 sin tocar la base. El header tiene que
    // estar igual, porque el middleware esta montado antes que la ruta.
    const res = await head('/health/keep-warm');

    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});