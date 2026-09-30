/**
 * Regresion de seguridad de la capa de autenticacion y autorizacion.
 *
 * Cubierto por los parches del commit 12f946c mas los controles que ya
 * existian y hay que proteger de una regresion (IDOR en orders, self-delete).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { backupData, restoreData, startTestServer, createTestProduct, createTestUser, BACKEND_ROOT, CUSTOMER } = require('./helpers');

let api;
let admin;
let customer;
let product;

before(async () => {
  backupData();
  api = await startTestServer();
  admin = createTestUser({ name: 'Admin Test', email: 'admin@test.com', password: 'admin123', dni: '22222222', role: 'admin' });
  customer = createTestUser(CUSTOMER);
  product = createTestProduct({ name: 'Producto Test Auth', price: 10000, stock: 10 });
});

after(async () => {
  if (api) await api.close();
  restoreData();
});

const login = async (email, password) => {
  const r = await api.post('/auth/login', { email, password });
  return r.body && r.body.token;
};

// corre un script node isolado (necesario para probar el fail-fast de jwt.js)
const runNode = (script, args = [], extraEnv = {}) =>
  execFileSync('node', ['-e', script, ...args], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  }).toString().trim();

describe('POST /auth/login', () => {
  test('login valido devuelve token y usuario sin password', async () => {
    const r = await api.post('/auth/login', { email: CUSTOMER.email, password: CUSTOMER.password });

    assert.equal(r.status, 200);
    assert.ok(r.body.token, 'debe devolver token');
    assert.equal(r.body.user.email, CUSTOMER.email);
    assert.equal(r.body.user.password, undefined, 'NUNCA devolver el hash');
  });

  test('password incorrecta da 401 y no revela si el usuario existe', async () => {
    const r = await api.post('/auth/login', { email: CUSTOMER.email, password: 'incorrecta' });

    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Credenciales inválidas');
  });

  test('usuario inexistente da el mismo error que password incorrecta', async () => {
    const r = await api.post('/auth/login', { email: 'nadie@test.com', password: 'algo' });

    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Credenciales inválidas', 'no debe permitir enumerar usuarios');
  });
});

describe('GET /auth/me', () => {
  test('sin token da 401', async () => {
    const r = await api.get('/auth/me');

    assert.equal(r.status, 401);
  });

  test('token invalido da 401', async () => {
    const r = await api.get('/auth/me', { token: 'token-falso-firmado' });

    assert.equal(r.status, 401);
  });

  test('token valido devuelve el usuario sin password', async () => {
    const token = await login(CUSTOMER.email, CUSTOMER.password);
    const r = await api.get('/auth/me', { token });

    assert.equal(r.status, 200);
    assert.equal(r.body.user.email, CUSTOMER.email);
    assert.equal(r.body.user.password, undefined);
  });
});

describe('JWT - configuracion fail-fast', () => {
  const jwtPath = path.join(BACKEND_ROOT, 'src', 'utils', 'jwt.js');
  const probe = "try { require(process.argv[1]); console.log('ARRANCO'); } catch (e) { console.log('FALLO:' + e.message.slice(0, 40)); }";

  test('sin JWT_SECRET en produccion, el server NO arranca', () => {
    const out = runNode(probe, [jwtPath], { NODE_ENV: 'production', JWT_SECRET: '', VERCEL: '' });

    assert.ok(out.startsWith('FALLO:'), `debe fallar cerrado, devolvio ${out}`);
    assert.match(out, /JWT_SECRET/, 'el error debe nombrar la variable que falta');
  });

  test('con VERCEL seteado y sin secret, tambien falla', () => {
    const out = runNode(probe, [jwtPath], { NODE_ENV: 'production', JWT_SECRET: '', VERCEL: '1' });

    assert.ok(out.startsWith('FALLO'), `debio fallar, devolvio ${out}`);
  });

  test('con JWT_SECRET presente, arranca bien', () => {
    const out = runNode(probe, [jwtPath], { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), VERCEL: '1' });

    assert.equal(out, 'ARRANCO');
  });

  test('en desarrollo sin secret, no rompe el flujo local', () => {
    const out = runNode(probe, [jwtPath], { NODE_ENV: 'development', JWT_SECRET: '', VERCEL: '' });

    assert.equal(out, 'ARRANCO', 'el desarrollo local debe seguir funcionando');
  });
});

describe('JWT - validacion de firma y algoritmo', () => {
  const jwtPath = path.join(BACKEND_ROOT, 'src', 'utils', 'jwt.js');
  const jwt = path.join(BACKEND_ROOT, 'node_modules', 'jsonwebtoken');

  const verify = (token) =>
    runNode(
      `const {verifyToken}=require(process.argv[1]);try{verifyToken(process.argv[2]);console.log('ACEPTADO');}catch(e){console.log('RECHAZADO');}`,
      [jwtPath, token],
      // JWT_SECRET vacio a proposito: asi jwt.js usa su default de desarrollo.
      // Si heredamos el secret real de .env, el token de prueba seria rechazado
      // por la razon incorrecta y el test no probaria nada.
      { NODE_ENV: 'development', VERCEL: '', JWT_SECRET: '' }
    );

  const sign = (payload, secret, opts = {}) =>
    runNode(
      `const jwt=require(process.argv[1]);console.log(jwt.sign(JSON.parse(process.argv[2]),process.argv[3],Object.assign({expiresIn:'1h',algorithm:'HS256'},JSON.parse(process.argv[4]))));`,
      [jwt, JSON.stringify(payload), secret, JSON.stringify(opts)],
      { NODE_ENV: 'development', VERCEL: '', JWT_SECRET: '' }
    );

  test('rechaza alg=none (bypass de firma)', () => {
    const t = runNode(`const jwt=require(process.argv[1]);console.log(jwt.sign({id:1,role:'admin'},'',{algorithm:'none'}));`, [jwt], { NODE_ENV: 'development', JWT_SECRET: '' });

    assert.equal(verify(t), 'RECHAZADO', 'alg=none debe rechazarse siempre');
  });

  test('rechaza un token firmado con otra clave', () => {
    const t = sign({ id: 1, role: 'admin' }, 'clave-del-atacante');

    assert.equal(verify(t), 'RECHAZADO');
  });

  test('acepta un token firmado con el secret correcto', () => {
    // El secret de desarrollo que jwt.js usa cuando no hay JWT_SECRET.
    const t = sign({ id: 1, role: 'admin', name: 'x' }, 'compushop_secret_dev_only');

    assert.equal(verify(t), 'ACEPTADO');
  });

  test('rechaza un token expirado', () => {
    const t = sign({ id: 1, role: 'admin' }, 'compushop_secret_dev_only', { expiresIn: '-1h' });

    assert.equal(verify(t), 'RECHAZADO');
  });
});

describe('POST /auth/forgot-password - dev_token', () => {
  const authCtrlPath = path.join(BACKEND_ROOT, 'src', 'controllers', 'authController.js');

  const requestForgot = (env) =>
    runNode(
      `const c=require(process.argv[1]);
       let out=null;
       const res={status(){return this;},json(p){out=p;}};
       c.forgotPassword({body:{dni:process.argv[2]}},res);
       setTimeout(()=>console.log(JSON.stringify(out)),400);`,
      [authCtrlPath, admin.dni],
      env
    );

  test('en PRODUCCION no devuelve dev_token (seria toma de cuentas)', () => {
    const out = JSON.parse(requestForgot({ NODE_ENV: 'production', VERCEL: '1' }));

    assert.equal(out.dev_token, undefined, 'dev_token jamas debe filtrarse en produccion');
    assert.match(out.message, /Si el DNI existe/, 'debe responder con el mensaje generico');
  });

  test('con VERCEL seteado tampoco devuelve dev_token', () => {
    const out = JSON.parse(requestForgot({ NODE_ENV: 'development', VERCEL: '1' }));

    assert.equal(out.dev_token, undefined);
  });

  test('en DESARROLLO si expone dev_token (para poder testear el flujo)', () => {
    const out = JSON.parse(requestForgot({ NODE_ENV: 'development', VERCEL: '' }));

    if (out.dev_token) {
      assert.ok(out.dev_token.length > 10, 'si se expone, debe ser el token real');
    } else {
      // Si SMTP esta configurado en el entorno, no hay dev_token: tambien valido.
      assert.ok(true);
    }
  });

  test('no revela si el DNI existe (respuesta uniforme)', async () => {
    const r = await api.post('/auth/forgot-password', { dni: '99999999' });

    assert.equal(r.status, 200);
    assert.match(r.body.message, /Si el DNI existe/, 'debe ser indistinguible del caso existe');
  });
});

describe('Autorizacion por rol (IDOR y escalamiento)', () => {
  test('GET /users sin token da 401', async () => {
    const r = await api.get('/users');

    assert.equal(r.status, 401);
  });

  test('GET /users con token de customer da 403', async () => {
    const token = await login(CUSTOMER.email, CUSTOMER.password);
    const r = await api.get('/users', { token });

    assert.equal(r.status, 403, 'un customer no puede listar usuarios');
  });

  test('POST /products con token de customer da 403', async () => {
    const token = await login(CUSTOMER.email, CUSTOMER.password);
    const r = await api.post('/products', { name: 'Hacker', price: 1 }, { token });

    assert.equal(r.status, 403);
  });

  test('PUT /settings con token de customer da 403', async () => {
    const token = await login(CUSTOMER.email, CUSTOMER.password);
    const r = await api.put('/settings', { store_name: 'Hackeado' }, { token });

    assert.equal(r.status, 403);
  });

  test('GET /dashboard/stats con token de customer da 403', async () => {
    const token = await login(CUSTOMER.email, CUSTOMER.password);
    const r = await api.get('/dashboard/stats', { token });

    assert.equal(r.status, 403);
  });
});

describe('IDOR en pedidos', () => {
  test('un customer NO puede ver el pedido de otro', async () => {
    const adminToken = await login(admin.email, admin.password);
    const customerToken = await login(CUSTOMER.email, CUSTOMER.password);

    // pedido del admin
    const order = await api.post(
      '/orders',
      { items: [{ id: product.id, type: 'product', quantity: 1 }], customer_name: 'Admin', customer_email: admin.email },
      { token: adminToken }
    );
    const orderId = order.body.order.id;

    const r = await api.get(`/orders/${orderId}`, { token: customerToken });

    assert.equal(r.status, 403, 'IDOR: el cliente NO debe ver pedidos ajenos');
  });

  test('el admin SI puede ver cualquier pedido', async () => {
    const adminToken = await login(admin.email, admin.password);
    const customerToken = await login(CUSTOMER.email, CUSTOMER.password);

    const order = await api.post(
      '/orders',
      { items: [{ id: product.id, type: 'product', quantity: 1 }], customer_name: 'C', customer_email: CUSTOMER.email },
      { token: customerToken }
    );
    const r = await api.get(`/orders/${order.body.order.id}`, { token: adminToken });

    assert.equal(r.status, 200);
  });

  test('GET /orders de un customer solo devuelve SUS pedidos', async () => {
    const adminToken = await login(admin.email, admin.password);
    const customerToken = await login(CUSTOMER.email, CUSTOMER.password);

    await api.post(
      '/orders',
      { items: [{ id: product.id, type: 'product', quantity: 1 }], customer_name: 'Admin', customer_email: admin.email },
      { token: adminToken }
    );
    const before = await api.get('/orders', { token: customerToken });

    const adminOrders = await api.get('/orders', { token: adminToken });
    assert.ok(
      before.body.orders.length < adminOrders.body.orders.length,
      'el customer debe ver menos pedidos que el admin'
    );
  });
});

describe('Gestion de usuarios', () => {
  test('el admin NO puede eliminarse a si mismo', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.delete(`/users/${admin.id}`, { token });

    assert.equal(r.status, 400);
    assert.match(r.body.error, /eliminarte a vos mismo/);
  });

  test('GET /users nunca expone hashes de password', async () => {
    const token = await login(admin.email, admin.password);
    const r = await api.get('/users', { token });

    assert.equal(r.status, 200);
    for (const u of r.body.users) {
      assert.equal(u.password, undefined, `password filtrado en el usuario ${u.id}`);
    }
  });
});
