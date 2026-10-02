const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { backupData, restoreData, startTestServer } = require('./helpers');
const keepWarmHandler = require('../api/health/keep-warm');

const APP_ROOT = path.join(__dirname, '..');

let api;

test.before(async () => {
  await backupData();
  api = await startTestServer();
});

test.after(async () => {
  if (api) await api.close();
  await restoreData();
});

test('keep-warm: sin CRON_SECRET → 503 y CERO queries', async () => {
  const prev = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const poolMod = require('../src/data/postgres/pool');
  const origWithClient = poolMod.withClient;
  let qCount = 0;
  poolMod.withClient = async (fn) => {
    return origWithClient(async (client) => {
      const wrapped = {
        query: async (...args) => {
          qCount++;
          return client.query(...args);
        },
      };
      Object.setPrototypeOf(wrapped, Object.getPrototypeOf(client));
      for (const k of Object.keys(client)) {
        if (!('query' in wrapped) || wrapped[k] === undefined) wrapped[k] = client[k];
      }
      return fn(wrapped);
    });
  };
  const req = { headers: {} };
  const res = {
    statusCode: 0,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  await keepWarmHandler(req, res);
  assert.strictEqual(res.statusCode, 503);
  assert.deepStrictEqual(res.body, { ok: false, error: 'keep-warm not configured' });
  assert.strictEqual(qCount, 0);
  poolMod.withClient = origWithClient;
  if (prev !== undefined) process.env.CRON_SECRET = prev;
});

test('keep-warm: secreto incorrecto → 401 y CERO queries', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'supersecretkey123456';
  const poolMod = require('../src/data/postgres/pool');
  const origWithClient = poolMod.withClient;
  let qCount = 0;
  poolMod.withClient = async (fn) => {
    return origWithClient(async (client) => {
      const wrapped = {
        query: async (...args) => {
          qCount++;
          return client.query(...args);
        },
      };
      Object.setPrototypeOf(wrapped, Object.getPrototypeOf(client));
      Object.assign(wrapped, client);
      return fn(wrapped);
    });
  };
  const req = { headers: { authorization: 'Bearer wrongsecret123456' } };
  const res = {
    statusCode: 0,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  await keepWarmHandler(req, res);
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(res.body, { ok: false, error: 'unauthorized' });
  assert.strictEqual(qCount, 0);
  poolMod.withClient = origWithClient;
  if (prev !== undefined) process.env.CRON_SECRET = prev;
});

test('keep-warm: secreto correcto + base caída → 500', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'supersecretkey123456';
  const poolMod = require('../src/data/postgres/pool');
  const origPreflight = poolMod.preflight;
  poolMod.preflight = async () => { throw new Error('connection failed'); };
  const req = { headers: { authorization: 'Bearer supersecretkey123456' } };
  const res = {
    statusCode: 0,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  await keepWarmHandler(req, res);
  assert.strictEqual(res.statusCode, 500);
  poolMod.preflight = origPreflight;
  if (prev !== undefined) process.env.CRON_SECRET = prev;
});

test('keep-warm: secreto correcto + base sana → 200', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'supersecretkey123456';
  const poolMod = require('../src/data/postgres/pool');
  const origPreflight = poolMod.preflight;
  poolMod.preflight = async () => true;
  const req = { headers: { authorization: 'Bearer supersecretkey123456' } };
  const res = {
    statusCode: 0,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  await keepWarmHandler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { ok: true });
  poolMod.preflight = origPreflight;
  if (prev !== undefined) process.env.CRON_SECRET = prev;
});

// ===========================================================================
// END-TO-END POR HTTP (no el handler importado directo)
// ===========================================================================
// Los cuatro tests de arriba importan `api/health/keep-warm` y lo llaman con un
// `req`/`res` de mentira. Eso prueba la LOGICA del handler y no prueba que el
// endpoint EXISTA. Son dos cosas distintas y la diferencia importa: el montaje
// estaba adentro de un `else` de `if (rateLimit.isTest)`, asi que con
// NODE_ENV=test la ruta NO se registraba y los cuatro tests de arriba pasaban
// igual sobre un endpoint inalcanzable. Un 404 no es un 503, asi que la
// asercion de status es la que distingue "llego el handler" de "llegue algo".

test('la RUTA /api/health/keep-warm existe y responde 503 sin CRON_SECRET (por HTTP)', async () => {
  const prev = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;

  const r = await api.get('/health/keep-warm');

  assert.equal(r.status, 503, `la ruta no llego al handler: respondio ${r.status} (un 404 seria la ruta sin montar)`);
  assert.deepEqual(r.body, { ok: false, error: 'keep-warm not configured' });

  if (prev !== undefined) process.env.CRON_SECRET = prev;
});

test('la RUTA /api/health/keep-warm responde 401 con secreto incorrecto (por HTTP)', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'supersecretkey123456';

  const r = await api.get('/health/keep-warm');

  assert.equal(r.status, 401, `la ruta no llego al handler: respondio ${r.status}`);
  assert.deepEqual(r.body, { ok: false, error: 'unauthorized' });

  if (prev !== undefined) process.env.CRON_SECRET = prev;
});

test('la ruta no cae ni en el 404 (sin montar) ni en el 429 (detras del limiter)', async () => {
  // Hay dos formas de romper esto y se ven distinto en el status:
  //   - 404: la ruta NO esta montada. Es el bug original (mount dentro del
  //     `else` de `if (rateLimit.isTest)`) y es lo que rompia en NODE_ENV=test.
  //   - 429: la ruta esta montada pero ATRAS del limitador global, asi que el
  //     diagnostico del cron queda tapado por el rate limit.
  //
  // Se prueban las dos negative porque un test que solo mirara "no es 429"
  // pasaba en VERDE sobre el bug de 404, y uno que solo mirara el status
  // exacto ya esta arriba (503). Lo que aporta este es decir explicitamente
  // cuales son los dos modos de falla, para que el rojo apunte a algo.
  //
  // LO QUE ESTE TEST NO PROBABA: el orden real del montaje. En tests
  // `rateLimit.isTest` es true, asi que el limitador global no se registra y
  // aca no hay ningun 429 posible. El orden en el archivo lo cubre el guard de
  // arquitectura (tests/middleware-order.js).
  const prev = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;

  const r = await api.get('/health/keep-warm');

  assert.notEqual(r.status, 404, 'la ruta no esta montada: un 404 significa que la ruta no llego al handler');
  assert.notEqual(r.status, 429, 'keep-warm no puede quedar atras del limitador global');
  if (prev !== undefined) process.env.CRON_SECRET = prev;
});

test('guard de arquitectura: keep-warm está montado en src/index.js', () => {
  const idx = fs.readFileSync(path.join(APP_ROOT, 'src', 'index.js'), 'utf8');
  assert.ok(idx.includes('/api/health/keep-warm'), 'el handler debe estar montado en src/index.js');
  assert.ok(idx.includes('keepWarmHandler'), 'debe hacer referencia al handler keepWarmHandler');
});

test('guard de arquitectura: el handler delega a la función serverless (no duplicar lógica)', () => {
  const idx = fs.readFileSync(path.join(APP_ROOT, 'src', 'index.js'), 'utf8');
  assert.ok(idx.includes('api/health/keep-warm'), 'src/index.js debe requerir api/health/keep-warm');
});
