/**
 * Regresion de CORS.
 *
 * Antes del fix, el allowlist incluia /\.vercel\.app$/ : cualquier
 * subdominio de Vercel (de cualquiera, no solo de este proyecto) podia
 * llamar a la API. Ademas el rechazo lanzaba un Error que terminaba en el
 * error handler como 500 en lugar de 403.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { buildCorsConfig, isOriginAllowed, PROD_ORIGIN } = require('../src/config/cors');
const { backupData, restoreData, startTestServer } = require('./helpers');

const devEnv = (extra = {}) => ({ NODE_ENV: 'development', ...extra });
const prodEnv = (extra = {}) => ({ NODE_ENV: 'production', VERCEL: '1', ...extra });

describe('isOriginAllowed - allowlist', () => {
  test('permite el origen de produccion', () => {
    const cfg = buildCorsConfig(prodEnv());

    assert.equal(isOriginAllowed(PROD_ORIGIN, cfg).allowed, true);
  });

  test('permite localhost en desarrollo', () => {
    const cfg = buildCorsConfig(devEnv());

    for (const o of ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173']) {
      assert.equal(isOriginAllowed(o, cfg).allowed, true, `${o} deberia permitirse en dev`);
    }
  });

  test('bloquea localhost en produccion', () => {
    const cfg = buildCorsConfig(prodEnv());

    assert.equal(isOriginAllowed('http://localhost:5173', cfg).allowed, false);
  });

  test('un FRONTEND_URL de desarrollo se ignora en produccion', () => {
    // .env de desarrollo copiado tal cual a las vars de Vercel
    const cfg = buildCorsConfig(prodEnv({ FRONTEND_URL: 'http://localhost:5173' }));

    assert.equal(
      isOriginAllowed('http://localhost:5173', cfg).allowed,
      false,
      'produccion no debe confiar en localhost aunque venga en FRONTEND_URL'
    );
  });

  test('FRONTEND_URL de desarrollo NO elimina el resto de la config', () => {
    const cfg = buildCorsConfig(prodEnv({ FRONTEND_URL: 'http://localhost:5173' }));

    assert.equal(isOriginAllowed(PROD_ORIGIN, cfg).allowed, true);
  });

  test('en desarrollo FRONTEND_URL localhost si se respeta', () => {
    const cfg = buildCorsConfig(devEnv({ FRONTEND_URL: 'http://localhost:5173' }));

    assert.equal(isOriginAllowed('http://localhost:5173', cfg).allowed, true);
  });

  test('permite requests sin Origin (curl, healthchecks)', () => {
    const cfg = buildCorsConfig(prodEnv());

    const r = isOriginAllowed(undefined, cfg);
    assert.equal(r.allowed, true);
    assert.equal(r.reason, 'sin-origin');
  });

  test('rechaza un origen cualquiera', () => {
    const cfg = buildCorsConfig(prodEnv());

    assert.equal(isOriginAllowed('https://sitio-falso-joysfree.com', cfg).allowed, false);
  });
});

describe('isOriginAllowed - el comodin de Vercel fue eliminado', () => {
  test('rechaza OTROS subdominios de vercel.app (el agujero original)', () => {
    const cfg = buildCorsConfig(prodEnv());

    for (const evil of [
      'https://otro-proyecto-vercel.vercel.app',
      'https://attacker-abc123.vercel.app',
      'https://compushop-dun.attacker.vercel.app',
      'https://vercel.app',
    ]) {
      assert.equal(isOriginAllowed(evil, cfg).allowed, false, `${evil} NO debe permitirse`);
    }
  });

  test('no acepta un origen que solo CONTENGA el dominio propio', () => {
    const cfg = buildCorsConfig(prodEnv());

    for (const fake of [
      'https://compushop-dun.vercel.app.evil.com',
      'https://evil.com/https://compushop-dun.vercel.app',
      'https://notcompushop-dun.vercel.app',
      'http://compushop-dun.vercel.app', // http, no https
    ]) {
      assert.equal(isOriginAllowed(fake, cfg).allowed, false, `${fake} NO debe permitirse`);
    }
  });

  test('los preview deployments se habilitan solo con opting in explicito', () => {
    // Sin opt-in: bloqueado.
    const sinOptIn = buildCorsConfig(prodEnv());
    assert.equal(isOriginAllowed('https://compushop-dun-xyz.vercel.app', sinOptIn).allowed, false);

    // Con patron acotado al proyecto: permitido.
    const conOptIn = buildCorsConfig(
      prodEnv({ ALLOWED_ORIGIN_PATTERNS: '^https://compushop-dun-[a-z0-9]+\\.vercel\\.app$' })
    );
    assert.equal(isOriginAllowed('https://compushop-dun-abc123.vercel.app', conOptIn).allowed, true);
  });

  test('un patron mal formado se ignora en vez de romper el arranque', () => {
    const cfg = buildCorsConfig(prodEnv({ ALLOWED_ORIGIN_PATTERNS: 'esto-no-es-una-regex[' }));

    assert.equal(cfg.allowedPatterns.length, 0);
    assert.equal(isOriginAllowed(PROD_ORIGIN, cfg).allowed, true, 'el allowlist normal sigue funcionando');
  });
});

describe('buildCorsConfig - configuracion desde env', () => {
  test('FRONTEND_URL agrega origenes, y acepta listas separadas por coma', () => {
    const cfg = buildCorsConfig(prodEnv({ FRONTEND_URL: 'https://a.com, https://b.com' }));

    assert.equal(isOriginAllowed('https://a.com', cfg).allowed, true);
    assert.equal(isOriginAllowed('https://b.com', cfg).allowed, true);
  });

  test('ALLOWED_ORIGINS agrega origenes extra', () => {
    const cfg = buildCorsConfig(prodEnv({ ALLOWED_ORIGINS: 'https://staging.example.com' }));

    assert.equal(isOriginAllowed('https://staging.example.com', cfg).allowed, true);
  });

  test('sin FRONTEND_URL el proyecto sigue levantando', () => {
    const cfg = buildCorsConfig(prodEnv());

    assert.equal(isOriginAllowed(PROD_ORIGIN, cfg).allowed, true);
  });

  test('no hay ningun patron activo por defecto', () => {
    const cfg = buildCorsConfig(prodEnv());

    assert.deepEqual(cfg.allowedPatterns, [], 'ningun comodin debe estar activo sin asking');
  });
});

describe('Integracion: el server aplica el allowlist de verdad', () => {
  let api;
  // El server corre en modo produccion (helpers setea VERCEL al requerir la app),
  // que es donde el ataque de otros *.vercel.app seria real.
  const get = (origin) =>
    fetch(`${api.origin}/api/products`, { headers: origin ? { Origin: origin } : {} });

  before(async () => {
    await backupData();
    api = await startTestServer();
  });

  after(async () => {
    if (api) await api.close();
    await restoreData();
  });

  test('un origen permitido responde 200', async () => {
    const r = await get(PROD_ORIGIN);

    assert.equal(r.status, 200);
  });

  test('un request sin Origin (curl) responde 200', async () => {
    const r = await get(null);

    assert.equal(r.status, 200);
  });

  test('otro proyecto de Vercel recibe 403, NO 500', async () => {
    const r = await get('https://attacker-proyecto.vercel.app');

    assert.equal(r.status, 403, `esperaba 403, recibi ${r.status}`);
  });

  test('el origen malicioso no se refleja en la respuesta', () => {
    const r = isOriginAllowed('https://attacker-proyecto.vercel.app', buildCorsConfig(prodEnv()));

    assert.equal(r.allowed, false);
  });

  test('el cuerpo del 403 no revela configuracion interna', async () => {
    const r = await get('https://attacker-proyecto.vercel.app');
    const body = await r.text();

    assert.ok(!body.includes('JWT_SECRET'), 'no debe filtrar nada sensible');
    assert.ok(!body.includes('/api/'), 'no debe filtrar rutas internas');
  });

  test('un origen malicioso no puede ejecutar POST /contact', async () => {
    const r = await fetch(`${api.origin}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker-proyecto.vercel.app' },
      body: JSON.stringify({ name: 'x', email: 'x@x.com', message: 'spam' }),
    });

    assert.equal(r.status, 403, 'CORS solo impide leer; el guard debe cortar el trabajo');
  });

  test('localhost recibe 403 aunque el env traiga FRONTEND_URL de desarrollo', async () => {
    // El .env del proyecto tiene FRONTEND_URL=http://localhost:5173. En modo
    // produccion debe ignorarse: este test cerro un agujero real.
    const r = await get('http://localhost:5173');

    assert.equal(r.status, 403, `esperaba 403 para localhost en produccion, recibi ${r.status}`);
  });
});
