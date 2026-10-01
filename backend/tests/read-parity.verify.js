#!/usr/bin/env node
/**
 * PARIDAD DE LECTURA: store JSON  vs  repo sobre PostgreSQL.
 *
 * Extension `.verify.js` y NO `.test.js` a proposito: necesita una base
 * levantada, y `npm test` corre `tests/*.test.js`. Este corre a mano:
 *
 *     node tests/read-parity.verify.js
 *
 * Que es lo que hace, y por que tiene que ser asi:
 *
 * Por cada lectura toma el MISMO dato de los dos lados y los compara CAMPO POR
 * CAMPO. El lado viejo es el servidor real, arrancado sobre el store JSON. El
 * lado nuevo es `data/repo.js` contra la BASE DE TESTS. Campo por campo porque
 * la diferencia que importa en esta migracion es invisible en un diff de
 * strings: un `category_name` que paso de ausente a `null`, o un `price` que
 * paso de number a string, se ven en el JSON y no se ven en un conteo de filas.
 *
 * ---------------------------------------------------------------------------
 * POR QUE LA BASE DE TESTS Y CON EL ROL DE LA APP
 * ---------------------------------------------------------------------------
 * `compushop_test_db` alcanzada con el USUARIO de `DATABASE_URL`
 * (`compushop_app`): el mismo nivel de privilegio que produccion, en una base
 * que se puede romper. `DATABASE_TEST_URL` no sirve para esto: su usuario es
 * `compushop_test`, que TIENE CREATE, y se estaria probando permisos que la
 * app no tiene. Un guard de privilegios verificado solo con el rol que mas
 * puede, no es un guard.
 *
 * ---------------------------------------------------------------------------
 * QUE ESCRIBE
 * ---------------------------------------------------------------------------
 * Nada de la app. Los INSERT/DELETE son filas probe en `compushop_test_db`, con
 * un nombre reconocible, para cubrir los dos caminos que el dato migrado NO
 * alcanza:
 *
 *   - un producto SIN categoria. Las 12 filas migradas todas tienen
 *     `category_id`, asi que el `LEFT JOIN` nunca se prueba de verdad, y sin
 *     probarlo no se sabe si `category_name` se OMITE o se pone en `null`.
 *   - dos productos con `_` y `X` en el mismo lugar del nombre, para probar
 *     que el `ILIKE` trata `_` como literal y no como comodin.
 *   - un password_reset valido, uno usado y uno expirado, que es donde se
 *     decide si el filtro de validez esta en SQL o es un `forget`.
 *
 * Se borran en el `finally`. Si el proceso muere a mitad quedan filas con
 * `parity-probe-` en el nombre, que se reconocen a simple vista.
 *
 * ---------------------------------------------------------------------------
 * LOS DIFFS CONOCIDOS
 * ---------------------------------------------------------------------------
 * Declarados en ACCEPTED_DIFFS, con path y motivo. Un diff que NO este ahi hace
 * fallar el script. Declararlos no es relajar el control: es decir que hay
 * exactamente uno conocido, cual es, y por que se acepta. Un guard sin lista de
 * excepciones dormido es un guard que nadie lee.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { startTestServer, BACKEND_ROOT } = require('./helpers');

require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

/**
 * URL de la APP sobre la BASE DE TESTS.
 *
 * No se puede usar `DATABASE_TEST_URL` tal cual: cambia el usuario, y la
 * password que viene ahi es la de `compushop_test`. Hay que recombinar las
 * tres partes de `DATABASE_URL`: usuario y password de la app, y el dbname
 * que se quiere. El password se re-encoda porque en la URL puede venir
 * percent-encoded, y si se re-agrega crudo un `@` corta el parseo del host y el
 * error parece de credenciales.
 */
const POOLER_DB = 'compushop_test_db';
function appUrlOnTests() {
  const app = new URL(process.env.DATABASE_URL);
  const pass = encodeURIComponent(decodeURIComponent(app.password));
  return `postgresql://${app.username}:${pass}@${app.host}/${POOLER_DB}`;
}

// pool.js lee DATABASE_URL AL CARGARSE: tiene que estar seteada antes de
// cualquier require de la capa de datos.
process.env.DATABASE_URL = appUrlOnTests();
process.env.NODE_ENV = 'test';

const repo = require('../src/data/repo');
const { paginationFixed, settingsFromRows } = require('../src/data/postgres/mappers');
const { likePattern, idOrSlugWhere, intOr } = require('../src/data/postgres/queries/_shared');
const store = require('../src/db/store');

const DATA_JSON = path.join(BACKEND_ROOT, 'src', 'db', 'data.json');
const PROBE_PREFIX = 'parity-probe-';

/**
 * Los unicos diffs que se aceptan. El path tiene que coincidir con lo que
 * reporta `diff()`, que es notacion `a.b[0].c`.
 */
const ACCEPTED_DIFFS = [
  {
    matches: (p) => /^categories\[\d+\]\.image:/.test(p),
    motivo:
      'D-09 del design, el unico cambio de payload de la migracion. GET /categories ' +
      'agrega `image: null` en las categorias que no la tienen. Las 6 del seed nunca ' +
      'la tuvieron, pero POST /categories si la escribe, asi que emitirla hace el ' +
      'listado uniforme y NO pierde la imagen de las que el admin creo. Omitir la ' +
      'columna seria una regresion real de funcionalidad.',
  },
  {
    matches: (p) =>
      // OJO: `d` es el diff ENTERO, y sale como `path: store=... repo=...`, asi
      // que el path nunca esta solo. Por eso el anclaje es un lookahead al `:`
      // y no un `$`: con `$` la excepcion no matchea nunca y el gate fails.
      /^recentOrders\[\d+\]\.(shipping_address|customer_name|customer_email|customer_phone)(?=:)/.test(p),
    motivo:
      'Anonimizacion de PII de la migracion (D-11), no un desvio de la consulta. El ' +
      'script `migrate-data.js` reemplaza los datos personales del cliente en la fila ' +
      'de Postgres; `data.json` conserva el original porque es el origen de la ' +
      'migracion y todavia no se borra (tarea 8.1). Por eso el store dice "Omar Dario ' +
      'Virili" y la base dice "Cliente Anonimo". Lo que el dashboard MUESTRA es el ' +
      'nombre, y mostrar el nombre real es justamente lo que no se quiere: por eso el ' +
      'lado de Postgres va al seudonimo. El prefijo del path acota la excepcion a ' +
      '`recentOrders`: ningun otro campo y ningun otro endpoint la acepta. Si el diff ' +
      'apareciera en `ordersCount` o en `total`, NO entra por aca.',
  },
];

// ---------------------------------------------------------------------------
// Diff campo por campo, sobre JSON ya serializado.
// ---------------------------------------------------------------------------
/**
 * @returns {string[]} paths con diferencias, en notacion `a.b[0].c`.
 *   Cuando la diferencia es la EXISTENCIA de una clave, que es el caso
 *   interesante, lo dice en el texto en vez de reportar un valor.
 */
function diff(a, b, p = '', out = []) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push(`${p || '<raiz>'}: un lado es array y el otro no (${Array.isArray(a) ? 'store' : 'repo'})`);
      return out;
    }
    if (a.length !== b.length) out.push(`${p || '<raiz>'}.length: store=${a.length} repo=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${p}[${i}]`, out);
    return out;
  }

  if (isObj(a) || isObj(b)) {
    if (!isObj(a) || !isObj(b)) {
      out.push(`${p || '<raiz>'}: un lado es objeto y el otro no (${isObj(a) ? 'store' : 'repo'})`);
      return out;
    }
    for (const k of Object.keys(a)) {
      if (!(k in b)) out.push(`${p}.${k}: existe en store, FALTA en repo`);
      else diff(a[k], b[k], p ? `${p}.${k}` : k, out);
    }
    for (const k of Object.keys(b)) {
      if (!(k in a)) out.push(`${p}.${k}: existe en repo, FALTA en store`);
    }
    return out;
  }

  // `Object.is` y no `==`: distingue -0 de 0, que en un precio seria un bug
  // silencioso, y no colapsa null con undefined.
  if (!Object.is(a, b)) out.push(`${p}: store=${JSON.stringify(a)} repo=${JSON.stringify(b)}`);
  return out;
}

const results = [];
const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const no = (name, detail = '') => results.push({ name, pass: false, detail });

/** Compara store vs repo y separa los diffs declarados de los inesperados. */
function compare(name, storeBody, repoValue) {
  const diffs = diff(JSON.parse(JSON.stringify(storeBody)), JSON.parse(JSON.stringify(repoValue)));

  if (diffs.length === 0) return ok(name, 'identico campo por campo');

  const accepted = [];
  const unexpected = [];
  for (const d of diffs) {
    const known = ACCEPTED_DIFFS.find((x) => x.matches(d));
    if (known) accepted.push(`      ${d}\n        motivo: ${known.motivo}`);
    else unexpected.push(`      ${d}`);
  }

  if (unexpected.length) return no(name, `DIFFS INESPERADOS:\n${unexpected.join('\n')}`);
  return ok(name, `identico salvo ${accepted.length} diff(s) DECLARADO(S):\n${accepted.join('\n')}`);
}

const check = (cond, name, detailOk, detailNo) => (cond ? ok(name, detailOk) : no(name, detailNo));

(async () => {
  // --- 0. La base tiene que responder antes de comparar nada ---------------
  if (!(await repo.health.ping())) {
    console.error('La base de tests no responde. Aborto: comparar contra el vacio daria verde falso.');
    process.exit(1);
  }
  ok('preflight', `la base responde (${POOLER_DB}, con el rol de la app)`);

  const dataBefore = fs.readFileSync(DATA_JSON, 'utf8');
  const db = store.get();
  const product0 = db.products[0];
  const category0 = db.categories[0];
  const service0 = db.services[0];

  const probe = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.SUPABASE_CA_CERT
      ? { ca: process.env.SUPABASE_CA_CERT, rejectUnauthorized: true }
      : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  let server;
  try {
    await probe.connect();
    server = await startTestServer();

    // --- 1. Admin, para los endpoints con requireAdmin -----------------------
    const login = await server.post('/auth/login', { email: 'admin@compushop.com', password: 'admin123' });
    if (login.status !== 200 || !login.body || !login.body.token) {
      throw new Error(`login admin devolvio ${login.status}: sin token no se comparan los endpoints admin`);
    }
    const token = login.body.token;
    ok('login admin sobre el servidor del store', 'token obtenido');

    const get = async (url) => {
      const r = await server.get(url, { token });
      if (r.status !== 200) throw new Error(`GET ${url} devolvio ${r.status}: ${JSON.stringify(r.body)}`);
      return r.body;
    };

    // === 2. CATEGORIAS (2.1) ================================================
    // El sobre `{ categories: [...] }` lo arma la ruta; el repo devuelve el array.
    compare('GET /categories (product_count solo activos)', await get('/categories'), {
      categories: await repo.categories.list(),
    });

    // === 3. PRODUCTS (2.2 / 2.3) ============================================
    // Estos SI devuelven el sobre entero: la paginacion es estructura de datos y
    // vive en el repo, armada por `paginated`.
    compare('GET /products (default: solo activos)', await get('/products'), await repo.products.list());
    compare(
      'GET /products?category=<slug>',
      await get(`/products?category=${category0.slug}`),
      await repo.products.list({ category: category0.slug }),
    );
    compare(
      'GET /products?search=lapto (subcadena, no limite de palabra)',
      await get('/products?search=lapto'),
      await repo.products.list({ search: 'lapto' }),
    );
    compare(
      'GET /products?search=NOTEBOOK (mayusculas del cliente)',
      await get('/products?search=NOTEBOOK'),
      await repo.products.list({ search: 'NOTEBOOK' }),
    );
    compare(
      'GET /products?search=zzz-no-existe (vacio)',
      await get('/products?search=zzz-no-existe'),
      await repo.products.list({ search: 'zzz-no-existe' }),
    );
    compare(
      'GET /products?active=all',
      await get('/products?active=all'),
      await repo.products.list({ active: false }),
    );
    compare(
      'GET /products?page=2&limit=5',
      await get('/products?page=2&limit=5'),
      await repo.products.list({ page: 2, limit: 5 }),
    );
    compare(
      'GET /products?page=1&limit=500 (limite > total)',
      await get('/products?page=1&limit=500'),
      await repo.products.list({ page: 1, limit: 500 }),
    );
    compare(
      'GET /products?page=3&limit=5 (pagina fuera de rango)',
      await get('/products?page=3&limit=5'),
      await repo.products.list({ page: 3, limit: 5 }),
    );
    compare(
      `GET /products/${product0.id} (por id, enriquecido)`,
      (await get(`/products/${product0.id}`)).product,
      await repo.products.findByIdOrSlug(product0.id),
    );
    compare(
      `GET /products/${product0.slug} (por slug)`,
      (await get(`/products/${product0.slug}`)).product,
      await repo.products.findByIdOrSlug(product0.slug),
    );
    const noSuch = await repo.products.findByIdOrSlug('no-existe-de-mia');
    check(noSuch === null, 'products.findByIdOrSlug inexistente -> null', 'null, como el 404 de la ruta',
      `devolvio ${JSON.stringify(noSuch)}`);

    // === 4. SERVICES (2.4) ==================================================
    compare('GET /services (sin paginacion, sin enrich)', await get('/services'), {
      services: await repo.services.list(),
    });
    compare('GET /services?active=all', await get('/services?active=all'), {
      services: await repo.services.list({ active: false }),
    });
    compare(
      `GET /services/${service0.id}`,
      (await get(`/services/${service0.id}`)).service,
      await repo.services.findByIdOrSlug(service0.id),
    );
    compare(
      `GET /services/${service0.slug}`,
      (await get(`/services/${service0.slug}`)).service,
      await repo.services.findByIdOrSlug(service0.slug),
    );

    // === 5. USERS (2.5) =====================================================
    // El sobre y la paginacion FIJA los arma la ruta. Se usa el mapper real
    // `paginationFixed` y no una copia a mano: si la regla de la paginacion de
    // mentira cambia, cambia en un solo lugar.
    const usersRepo = await repo.users.list();
    compare('GET /users (sin password, paginacion fija limit=100)', await get('/users'), {
      users: usersRepo,
      pagination: paginationFixed(usersRepo.length, 100),
    });
    check(
      usersRepo.every((u) => !('password' in u)),
      'users.list() NO expone el hash en ninguna key',
      `confirmado en ${usersRepo.length} usuarios`,
      'aparece la clave password: FUGA DE HASH',
    );

    const byEmail = await repo.users.findByEmail('admin@compushop.com');
    const byEmailUpper = await repo.users.findByEmail('ADMIN@compushop.com');
    check(byEmail && byEmail.id === 1, 'users.findByEmail( exacto )', 'id=1, el del seed',
      JSON.stringify(byEmail));
    check(
      byEmailUpper === null,
      'users.findByEmail es CASE-SENSITIVE (sin lower())',
      'ADMIN@ no encuentra, igual que el store: el indice es sobre email, no lower(email)',
      `devolvio id=${byEmailUpper && byEmailUpper.id}: se agrego lower() por error`,
    );
    check(
      byEmail && typeof byEmail.password === 'string' && byEmail.password.startsWith('$2'),
      'users.findByEmail trae el hash (login lo necesita)',
      'bcrypt presente: sin esto no hay login',
      'sin hash: bcrypt.compare no tiene contra que comparar',
    );

    const byDni = await repo.users.findByDni(db.users[0].dni);
    check(byDni && byDni.id === db.users[0].id, 'users.findByDni', `id=${byDni && byDni.id}`,
      JSON.stringify(byDni));
    check(
      byDni && !('password' in byDni),
      'users.findByDni NO trae el hash',
      'no lo necesita: el email de reset usa name/email',
      'trae un hash de bcrypt que ningun call site necesita',
    );
    const byId = await repo.users.findById(db.users[1].id);
    check(byId && byId.id === db.users[1].id, 'users.findById', `id=${byId && byId.id}`, JSON.stringify(byId));

    // === 6. CONTACT (2.6) ===================================================
    const contactRepo = await repo.contact.list();
    compare('GET /contact (created_at DESC, paginacion fija limit=50)', await get('/contact'), {
      messages: contactRepo,
      pagination: paginationFixed(contactRepo.length, 50),
    });
    const unreadRepo = await repo.contact.list({ unread: true });
    compare('GET /contact?unread=true', await get('/contact?unread=true'), {
      messages: unreadRepo,
      pagination: paginationFixed(unreadRepo.length, 50),
    });

    // === 7. SETTINGS (2.7) ==================================================
    compare('GET /settings (objeto, 10 claves, todas string)', await get('/settings'), {
      settings: await repo.settings.getAll(),
    });
    const settingsRepo = await repo.settings.getAll();
    check(
      Object.values(settingsRepo).every((v) => typeof v === 'string'),
      'settings.getAll(): TODOS los valores son string',
      `${Object.keys(settingsRepo).length} claves, included smtp_port=${JSON.stringify(settingsRepo.smtp_port)} (string)`,
      'hay un valor no-string: el form del admin compara contra "587" y dejaria de matchear',
    );
    check(
      typeof settingsRepo.smtp_port === 'string',
      'settings.smtp_port sigue siendo STRING, no numero',
      `"${settingsRepo.smtp_port}"`,
      `llego como ${typeof settingsRepo.smtp_port}`,
    );

    // === 7b. DASHBOARD (4.5 / D-K) — conteos que el panel le al ojo =========
    // Este bloque es el unico guard de los agregados del admin, y por eso vale
    // la pena ser explicito sobre que protege: los SIETE numeros de `stats` mas
    // las dos listas. Lo que mas se rompe en una migracion asi no es el payload
    // (el sobre lo arma la ruta, igual que antes) sino la SEMANTICA: un
    // `pending` que suma tambien `shipped`, un revenue que incluye cancelados, o
    // un `productsCount` que cuenta inactivos. Todo eso puede dar verde en
    // cualquier test de forma, y el admin ve el numero equivocado.
    //
    // El lado viejo se recalcula con la MISMA logica que tenia la ruta antes de la
    // migracion (`git show HEAD:backend/src/routes/index.js`), para que la
    // comparacion sea contra el comportamiento real y no contra una copia de
    // las queries nuevas.
    const oldStats = {
      productsCount: db.products.filter((p) => p.is_active).length,
      servicesCount: db.services.filter((s) => s.is_active).length,
      usersCount: db.users.filter((u) => u.role === 'customer').length,
      ordersCount: db.orders.length,
      pendingOrders: db.orders.filter((o) =>
        ['pending', 'confirmed', 'processing'].includes(o.status),
      ).length,
      unreadMessages: db.contact_messages.filter((m) => !m.is_read).length,
      revenue: db.orders
        .filter((o) => o.status !== 'cancelled')
        .reduce((s, o) => s + o.total, 0),
    };
    const oldRecentOrders = [...db.orders]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5);
    const oldLowStock = db.products
      .filter((p) => p.is_active && p.stock <= 5)
      // El store ordenaba solo por stock, y a empates Postgres no garantiza el
      // mismo orden que el array. `id` de segundo criterio hace la comparacion
      // estable; la respuesta ahora SI es determinista, que es una mejora, no un
      // desvío de contrato (el panel no promete un orden entre empates).
      .sort((a, b) => a.stock - b.stock || a.id - b.id)
      .slice(0, 10);

    const dashRepo = await repo.dashboard.stats();
    compare(
      'GET /dashboard/stats (los 7 numeros contra los del store)',
      { stats: oldStats, recentOrders: oldRecentOrders, lowStock: oldLowStock },
      dashRepo,
    );

    // El revenue en particular: tiene que ser numero, no string, y tiene que
    // excluir cancelados. Un `sum(numeric)` sin cast llega como string y el
    // `formatPrice` del front lo muestra crudo o lo rompe.
    check(
      typeof dashRepo.stats.revenue === 'number',
      'dashboard.stats.revenue es number (sum(numeric) parseado)',
      String(dashRepo.stats.revenue),
      `llego como ${typeof dashRepo.stats.revenue}`,
    );
    check(
      dashRepo.stats.revenue ===
        db.orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0),
      'dashboard.stats.revenue excluye los cancelados, igual que el store',
      `${dashRepo.stats.revenue} = suma de los no cancelados`,
      'el revenue incluye pedidos cancelados o difiere del store',
    );

    // Y el sobre de la ruta: `salesByMonth` sigue siendo [] por decision de
    // producto, no por consulta pendiente. Si alguien lo "completa" sin que el
    // front lo pida, esta comparacion lo delata.
    const dashApi = await get('/dashboard/stats');
    compare('GET /dashboard/stats (sobre de la ruta)', dashApi, { ...dashRepo, salesByMonth: [] });

    // === 8. PASSWORD RESETS (2.8) — sin endpoint publico = contra el store ===
    // El store tiene 0 resets, asi que la paridad literal es "ambos vacios".
    // Eso no prueba que el filtro de validez funcione, asi que abajo (bloque de
    // probes) se prueban los tres casos con filas reales.
    const storeValid = db.password_resets.filter(
      (r) => !r.used && new Date(r.expires_at) > new Date(),
    );
    check(
      storeValid.length === 0 && (await repo.passwordResets.findValidByToken('cualquier-token')) === null,
      'passwordResets: paridad literal (store vacio => repo null)',
      'los dos lados no tienen ningun reset valido',
      'divergen con el store vacio',
    );

    // === 9. Helpers puros de SQL (sin DB) ===================================
    // Viven en `_shared.js` y replican comportamiento del store. Si uno de
    // estos se rompe, la paridad de arriba puede seguir dando verde por
    // casualidad (el seed no tiene productos con `_` en el nombre).
    check(
      likePattern('50%') === '%50\\%%' && likePattern('a_b') === '%a\\_b%' && likePattern('back\\s') === '%back\\\\s%',
      'likePattern escapa %, _ y \\',
      'el patron es un substring literal, no un comodin',
      JSON.stringify([likePattern('50%'), likePattern('a_b'), likePattern('back\\s')]),
    );
    check(
      intOr(0, 20) === 20 && intOr('5', 20) === 5 && intOr(-1, 1) === 1 && intOr('abc', 20) === 20,
      'intOr replica `parseInt(x) || default`',
      '0->20, "5"->5, -1->1 (pagina), "abc"->20',
      JSON.stringify([intOr(0, 20), intOr('5', 20), intOr(-1, 1), intOr('abc', 20)]),
    );
    {
      const p1 = [];
      const p2 = [];
      const wNum = idOrSlugWhere('p', p1, '12');
      const wSlug = idOrSlugWhere('p', p2, 'mi-slug');
      check(
        wNum === 'p.id = $1' && p1[0] === 12 && wSlug === 'p.slug = $1' && p2[0] === 'mi-slug',
        'idOrSlugWhere: numerico -> id, resto -> slug (misma regla que la ruta)',
        'id numerico y slug separados, con el placeholder numerado',
        JSON.stringify([wNum, p1, wSlug, p2]),
      );
    }

    // === 10. PROBES: los caminos que el dato migrado no cubre ==============
    // Van AL FINAL, a proposito: agregan filas al catalogo, y si se hicieran
    // antes las comparaciones de `GET /products` de arriba verian productos de
    // mas que el store no tiene.

    // (a) Producto SIN categoria: el `LEFT JOIN` de verdad.
    await probe.query(
      `insert into products (name, slug, description, price, stock, category_id, brand, image, specs, is_active)
       values ($1, $2, $3, $4, $5, null, $6, $7, $8::jsonb, true)`,
      [`${PROBE_PREFIX}sin-categoria`, `${PROBE_PREFIX}sin-categoria`, 'fila probe', '1.11', 1,
       `${PROBE_PREFIX}brand`, null, JSON.stringify({ k: 'v' })],
    );

    const huerfano = await repo.products.findByIdOrSlug(`${PROBE_PREFIX}sin-categoria`);
    const huerfanoJson = JSON.parse(JSON.stringify(huerfano));
    check(
      huerfano !== null && !('category_name' in huerfanoJson) && !('category_slug' in huerfanoJson),
      'producto SIN categoria: las claves NO existen (undefined, no null)',
      'el mapper optional() + el store con optional chaining coinciden: la clave se OMITE',
      `category_name=${JSON.stringify(huerfanoJson.category_name)} category_slug=${JSON.stringify(huerfanoJson.category_slug)} ` +
        '(si aparecen, es que el LEFT JOIN no esta pasando por optional())',
    );
    check(
      huerfanoJson.price === 1.11 && typeof huerfanoJson.price === 'number',
      'numeric(14,2) sale como NUMBER (el typeParser funciona)',
      'price=1.11 typeof=number',
      `llego como ${typeof huerfanoJson.price}: ${JSON.stringify(huerfanoJson.price)}`,
    );
    check(
      huerfanoJson.created_at instanceof Date || typeof huerfanoJson.created_at === 'string',
      'timestamptz sale como Date (y como ISO al serializar)',
      `created_at=${huerfanoJson.created_at}`,
      'created_at no es una fecha',
    );
    check(
      huerfanoJson.specs && huerfanoJson.specs.k === 'v',
      'jsonb sale como objeto',
      JSON.stringify(huerfanoJson.specs),
      JSON.stringify(huerfanoJson.specs),
    );

    // (b) `_` literal vs comodin: dos productos que solo difieren en eso.
    await probe.query(
      `insert into products (name, slug, price, stock, is_active)
       values ($1, $2, 2.22, 1, true), ($3, $4, 2.23, 1, true)`,
      [`${PROBE_PREFIX}AXB`, `${PROBE_PREFIX}axb`, `${PROBE_PREFIX}A_B`, `${PROBE_PREFIX}a_b`],
    );

    const buscaUnderscore = await repo.products.list({ search: `${PROBE_PREFIX}A_B` });
    const buscaLetra = await repo.products.list({ search: `${PROBE_PREFIX}AXB` });
    check(
      buscaUnderscore.products.length === 1 && buscaUnderscore.products[0].slug === `${PROBE_PREFIX}a_b`,
      'search: "_" se escapa y NO actsua como comodin',
      `busco "${PROBE_PREFIX}A_B" y devolvio 1 sola fila (la del guion bajo)`,
      `devolvio ${buscaUnderscore.products.length} filas: el "_" se esta comiendo como comodin`,
    );
    check(
      buscaLetra.products.length === 1 && buscaLetra.products[0].slug === `${PROBE_PREFIX}axb`,
      'search: "X" (letra) tambien matchea solo la suya',
      '1 fila, la de la X',
      `devolvio ${buscaLetra.products.length} filas`,
    );

    // (c) password_resets: valido, usado, expirado.
    await probe.query(
      `insert into password_resets (user_id, token, expires_at, used) values
         (1, $1, now() + interval '1 hour', false),
         (1, $2, now() + interval '1 hour', true),
         (1, $3, now() - interval '1 hour', false)`,
      [`${PROBE_PREFIX}valido`, `${PROBE_PREFIX}usado`, `${PROBE_PREFIX}expirado`],
    );

    const rValido = await repo.passwordResets.findValidByToken(`${PROBE_PREFIX}valido`);
    const rUsado = await repo.passwordResets.findValidByToken(`${PROBE_PREFIX}usado`);
    const rExpirado = await repo.passwordResets.findValidByToken(`${PROBE_PREFIX}expirado`);
    const rFantasma = await repo.passwordResets.findValidByToken(`${PROBE_PREFIX}no-existe`);
    check(
      rValido !== null && rValido.token === `${PROBE_PREFIX}valido`,
      'findValidByToken: el token VALIDO se encuentra',
      `id=${rValido && rValido.id}, used=${rValido && rValido.used}`,
      JSON.stringify(rValido),
    );
    check(rUsado === null, 'findValidByToken: uno USADO devuelve null', 'null: `used = false` en SQL',
      JSON.stringify(rUsado));
    check(rExpirado === null, 'findValidByToken: uno EXPIRADO devuelve null',
      'null: `expires_at > now()` en SQL, resuelto por la base', JSON.stringify(rExpirado));
    check(rFantasma === null, 'findValidByToken: token inexistente devuelve null', 'null', JSON.stringify(rFantasma));

    // (d) settings vacio -> {} y no null ni exception.
    const settingsVacio = settingsFromRows([]);
    check(
      settingsVacio && typeof settingsVacio === 'object' && Object.keys(settingsVacio).length === 0,
      'settings con 0 filas -> {} (no null, no throw)',
      '{}: la ruta ya hacia `|| {}` y no cambia nada',
      JSON.stringify(settingsVacio),
    );
  } catch (e) {
    no('corrida', e.stack || e.message);
  } finally {
    // Limpieza. Va en el finally para que una corrida fallida no deje filas.
    // Sin esto, el proximo `GET /products` compara contra un catalogo con
    // productos de prueba y el resultado del script deja de ser confiable.
    try {
      await probe.query(`delete from products where slug like $1`, [`${PROBE_PREFIX}%`]);
      await probe.query(`delete from password_resets where token like $1`, [`${PROBE_PREFIX}%`]);
      const left = await probe.query(
        `select (select count(*) from products where slug like $1) as p,
                (select count(*) from password_resets where token like $2) as r`,
        [`${PROBE_PREFIX}%`, `${PROBE_PREFIX}%`],
      );
      // `count(*)` es bigint (OID 20) y `pg` devuelve int8 como STRING: solo hay
      // type parser para numeric. Comparar contra el numero 0 daria true y
      // dejaria pasar una limpieza a medias.
      if (left.rows[0].p !== '0' || left.rows[0].r !== '0') {
        no('limpieza', `quedaron ${left.rows[0].p} products y ${left.rows[0].r} resets probe`);
      } else {
        ok('limpieza', 'las filas probe se borraron: la base de tests quedo como estaba');
      }
    } catch (e) {
      no('limpieza', e.message);
    }
    if (server) await server.close().catch(() => {});
    await probe.end().catch(() => {});

    // El store no se toca: este script es de solo lectura sobre el lado viejo.
    if (fs.readFileSync(DATA_JSON, 'utf8') !== dataBefore) {
      no('data.json intacto', 'el script MODIFICO el store JSON: la paridad pierde sentido');
    } else {
      ok('data.json intacto', 'el lado viejo no sufrio escrituras: la comparacion es valida');
    }
  }

  // --- Resumen --------------------------------------------------------------
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(78)}\nPARIDAD DE LECTURA  (store JSON  vs  repo/Postgres)\n${'='.repeat(78)}`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'OK  ' : 'FAIL'}  ${r.name}${r.detail ? '\n        ' + r.detail.replace(/\n/g, '\n        ') : ''}`);
  }
  const declared = results.filter((r) => r.pass && r.detail.includes('DECLARADO')).length;
  console.log(`\n${'-'.repeat(78)}`);
  console.log(`  ${results.length - fails.length}/${results.length} OK`);
  console.log(`  lecturas comparadas campo por campo: ${results.filter((r) => r.pass).length - 3} (3 son preflight/login/limpieza)`);
  console.log(`  con diffs DECLARADOS (D-09, categories.image): ${declared}`);
  console.log(`  diffs inesperados: ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
})();
