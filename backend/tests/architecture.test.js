/**
 * Guarda de arquitectura.
 *
 * Impide que se reintroduzca la capa muerta que se elimino en el commit de
 * limpieza. Si alguien reintroduce database.js, o un controller desconectado,
 * estos tests fallan y avisan en vez de dejar codigo fantasma en el repo.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BACKEND_ROOT } = require('./helpers');

const SRC = path.join(BACKEND_ROOT, 'src');
const CONTROLLERS = path.join(SRC, 'controllers');
const DB = path.join(SRC, 'db');

const listJs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort() : []);
const readAll = (dir) =>
  listJs(dir).map((f) => ({ file: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));

/** Todos los .js de un arbol, en profundidad y en rutas absolutas. */
const walkJs = (dir) => {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkJs(abs);
      return entry.isFile() && entry.name.endsWith('.js') ? [abs] : [];
    });
};

/**
 * Las lineas de DDL de un .sql, sin comentarios.
 *
 * Hace falta porque schema.sql y grants.sql se documentan a si mismos y sus
 * comentarios mencionan "serial", "OWNED BY" y "truncate". Un match sobre el
 * archivo entero cuenta la documentacion como si fuera codigo, y el guard
 * dispara por su propio explanatory text. Ahi el equipo aprende a ignorar el
 * guard, que es peor que no tenerlo.
 */
const ddlLines = (sql) =>
  sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ''))
    .filter((l) => /^\s*(create|alter|grant|revoke)\s/i.test(l));

/**
 * Saca comentarios: mencionar la API en un comentario no es usarla.
 *
 * Vive aca y no dentro de un describe porque mas de un guard lo necesita, y dos
 * definiciones de "que es codigo" divergen. Un guard que dispara por su propia
 * documentacion es peor que no tener guard: entrena al equipo a ignorarlo.
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Capa de persistencia', () => {
  test('src/db/database.js NO existe (el shim de SQL falso fue eliminado)', () => {
    const p = path.join(DB, 'database.js');

    assert.equal(fs.existsSync(p), false, 'database.js es codigo muerto: simula SQL sin ser SQL');
  });

  test('store.js es la unica capa de datos', () => {
    const files = listJs(DB);

    assert.deepEqual(files, ['seed.js', 'store.js'], `archivos inesperados en src/db: ${files.join(', ')}`);
  });
});

describe('Capa de datos PostgreSQL (src/data)', () => {
  const DATA = path.join(SRC, 'data');
  const PG = path.join(DATA, 'postgres');
  const QUERIES = path.join(PG, 'queries');

  /**
   * Allowlist EXACTA de los archivos de la capa, no un "no deberia haber nada".
   *
   * La razon de que sea exacta: el guard viejo de `src/db/` uso
   * `deepEqual(['seed.js','store.js'])` y cuando aparecio un archivo legitimo
   * habia dos salidas, relajar el assert o borrar el codigo. Relajar es el
   * mecanismo exacto por el que entro `database.js`: nadie vuelve a mirar un
   * guard que ya se relajo una vez. Con la lista exacta, agregar un modulo es
   * un acto deliberado que deja rastro en el test.
   */
  test('los archivos de la capa de datos estan donde corresponde', () => {
    // src/db queda siendo del store JSON legacy. Lo nuevo vive en src/data para
    // que cuando se borre el store JSON se borre una carpeta entera, no
    // archivos sueltos mezclados con el legacy.
    //
    // `src/data/` tiene SOLO el contrato. El pool NO va aca: vive adentro de
    // `postgres/` (design §7 y tarea 1.3). Un guard que fija la ubicacion
    // equivocada entrena al equipo a ignorar guards, asi que cuando la
    // implementacion se separo del design, el GUARD se movio con ella.
    assert.deepEqual(listJs(DATA), ['repo.js'], `src/data cambio sin actualizar el guard`);
    assert.deepEqual(
      listJs(PG),
      ['mappers.js', 'pool.js'],
      `src/data/postgres cambio sin actualizar el guard`,
    );

    // Un modulo por entidad, mas el archivo de helpers de SQL. Los nombres se
    // declaran aca: si aparece un `queries/pedidos.js` sin pasarlo por el
    // design, este assert lo frena.
    assert.ok(fs.existsSync(QUERIES), 'falta src/data/postgres/queries/');
    assert.deepEqual(
      listJs(QUERIES),
      [
        '_shared.js',
        'categories.js',
        'contact.js',
        'dashboard.js',
        'orders.js',
        'passwordResets.js',
        'products.js',
        'services.js',
        'settings.js',
        'users.js',
      ],
      `cambio el set de modulos de queries/`,
    );
  });

  test('los .sql del schema estan separados y no se editan a mano desde JS', () => {
    const sqls = fs.readdirSync(PG).filter((f) => f.endsWith('.sql')).sort();
    assert.deepEqual(sqls, ['grants.sql', 'schema.sql'], `sql inesperados: ${sqls.join(', ')}`);
  });

  test('el pool falla fuerte si no hay DATABASE_URL, sin fallback a JSON', () => {
    // Si esto se relaja, la app empieza a servir data.json stale en produccion
    // cuando la base no esta, y nadie se entera hasta que un cliente compre
    // contra un catalogo viejo.
    const pool = fs.readFileSync(path.join(PG, 'pool.js'), 'utf8');

    assert.match(pool, /if \(!connectionString\)/, 'pool.js tiene que validar DATABASE_URL');
    assert.match(pool, /throw new Error/, 'la falta de DATABASE_URL tiene que lanzar');
    // Se busca el require del store, NO la palabra "data.json": el mensaje de
    // error la menciona justamente para decir que no hay fallback, y matchear
    // el texto daria un falso positivo.
    assert.doesNotMatch(
      pool,
      /require\(\s*['"][^'"]*db\/store/,
      'pool.js no puede importar el store JSON: no hay fallback ni dual-write',
    );
    assert.doesNotMatch(
      pool,
      /readFileSync|createReadStream/,
      'pool.js no puede leer archivos: no hay fallback a data.json',
    );
  });

  test('production exige SUPABASE_CA_CERT', () => {
    const pool = fs.readFileSync(path.join(PG, 'pool.js'), 'utf8');

    // Sin esto, rejectUnauthorized:false en produccion es una baja de
    // verificacion permanente e invisible.
    assert.match(pool, /SUPABASE_CA_CERT/, 'pool.js tiene que leer la CA');
    assert.match(pool, /rejectUnauthorized: true/, 'con CA presente se verifica la cadena');
    assert.match(
      pool,
      /isProd[\s\S]{0,400}throw new Error/,
      'sin CA en produccion tiene que fallar el arranque',
    );
  });

  test('nadie usa named prepared statements', () => {
    // PgBolver/Supavisor los acepta pero los pierde al reciclar la conexion.
    // Un `{ name: 'q' }` que se ejecuta dos veces en instancias distintas es
    // un fallo intermitente, el peor tipo de bug.
    //
    // Se recorre TODO src/data y no una lista de archivos: el guard tiene que
    // cubrir el SQL nuevo de `queries/`. Un guard que solo mira los dos
    // archivos que existian cuando se escribio deja de proteger lo que se
    // escribio despues, que es exactamente el codigo nuevo.
    const offenders = [];
    for (const f of walkJs(DATA)) {
      if (/name:\s*['"]/i.test(fs.readFileSync(f, 'utf8'))) {
        offenders.push(path.relative(DATA, f));
      }
    }
    assert.deepEqual(offenders, [], `named prepared statement en:\n${offenders.join('\n')}`);
  });

  test('nadie importa pg fuera de la capa de datos', () => {
    // REQ-SEC-07: el SQL no sale del adaptador.
    //
    // Si un handler importa `pg` puede saltarse el repo entero: traer el precio
    // del body, abrir su propia transaccion, tener su propio pool con otro
    // max. Y el `max: 1` del pool deja de ser una garantia de concurrencia si
    // hay un segundo pool en el proceso. La connection string, arriba de todo,
    // tiene que estar en un solo lugar.
    //
    // La unica excepcion es `src/data/postgres/`, que es donde vive el SQL.
    // No hay allowlist: `pool.js` esta DENTRO de esa carpeta (design §7), asi
    // que la frontera es una sola y no una lista que hay que mantener al dia.
    // Cuando el pool vivia en `src/data/` la allowlist tenia DOS entradas y la
    // lista de archivos de arriba fijaba el path equivocado. Era el mismo bug
    // en dos guards: el codigo se separo del design y los guards consfirmaron
    // la separacion en lugar de corregirla.
    const offenders = [];
    for (const f of [...walkJs(SRC), ...walkJs(path.join(BACKEND_ROOT, 'api'))]) {
      if (f.startsWith(PG + path.sep)) continue;
      if (/require\(\s*['"]pg['"]\s*\)/.test(fs.readFileSync(f, 'utf8'))) {
        offenders.push(path.relative(BACKEND_ROOT, f));
      }
    }
    assert.deepEqual(offenders, [], `pg importado fuera de la capa de datos:\n${offenders.join('\n')}`);
  });

  test('nadie sale de src/data/postgres/ para traer el pool', () => {
    // `postgres/` es una CARPETA, no un prefijo decorativo. Si los modulos de
    // `queries/` tienen que salir a `src/data/` a buscar el pool, la carpeta no
    // esta encapsulando nada: mañana aparece `mongo/` o un mock en memoria y
    // hay que editar los 8 modulos. El require del pool tiene que ser RELATIVO
    // AL PROPIO MODULO (`../pool`), no absoluto ni subiendo dos niveles.
    const offenders = [];
    for (const f of walkJs(QUERIES)) {
      const content = fs.readFileSync(f, 'utf8');
      if (!/require\([^)]*pool[^)]*\)/.test(content)) continue;
      if (!/require\(\s*'\.\.\/pool'\s*\)/.test(content)) {
        offenders.push(path.relative(DATA, f));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `el pool se importa desde adentro de su namespace, no desde afuera:\n${offenders.join('\n')}`,
    );

    // Y que exista de verdad: un `queries/` que no importa el pool pasaria el
    // assert de arriba por vacuidad.
    assert.ok(
      /require\(\s*'\.\.\/pool'\s*\)/.test(fs.readFileSync(path.join(QUERIES, 'products.js'), 'utf8')),
      'control: products.js tiene que importar el pool (si no, el guard de arriba no probo nada)',
    );
  });

  test('el schema declara OWNED BY en todas las secuencias, salvo las declaradas sueltas', () => {
    // Sin OWNED BY la secuencia queda huerfana y `truncate ... restart identity`
    // la ignora: los ids siguen subiendo entre archivos de test y el
    // aislamiento queda roto en silencio. Los tests siguen pasando.
    //
    // LA EXCEPCION ESTA DECLARADA, NO SE INFERE. `order_number_seq` es la
    // unica secuencia sin dueno, y tiene que serlo: `order_number` es un texto
    // (`CS260930-0001`), no una columna entera, asi que no hay columna de la que
    // esa secuencia sea duena. La lista es explicita para que agregar una
    // secuencia nueva no la cubra automaticamente: la comparacion es EXACTA en
    // las dos direcciones, asi que una secuencia huerfana que nadie declaro hace
    // fallar el test.
    const STANDALONE = ['order_number_seq'];

    const schema = fs.readFileSync(path.join(PG, 'schema.sql'), 'utf8');

    // Se matchean lineas que EMPIEZAN con la sentencia, no cualquier mencion:
    // el archivo se documenta a si mismo y nombra "serial" y "OWNED BY" en los
    // comentarios, asi que un match global cuenta el comentario.
    const declared = [...schema.matchAll(/^\s*create sequence if not exists (\w+)/gm)].map((m) => m[1]);
    // OJO con el patron: entre el nombre de la secuencia y "owned by" hay
    // VARIOS espacios (el schema alinea las columnas). Con un solo espacio en
    // el regex matchea 1 de 8, y justo la que no tiene padding.
    const owned = [...schema.matchAll(/^\s*alter sequence (\w+)\s+owned by (\w+\.\w+)/gm)];

    assert.ok(declared.length > 0, 'no se encontro ninguna secuencia en schema.sql');

    const sueltas = declared.filter((d) => !owned.some((o) => o[1] === d));
    assert.deepEqual(
      sueltas.sort(),
      [...STANDALONE].sort(),
      `faltan OWNED BY (o hay una secuencia suelta sin declarar): ${sueltas.join(', ') || 'ninguna'}`,
    );

    for (const [, seq, target] of owned) {
      assert.match(target, /^\w+\.\w+$/, `${seq} debe apuntar a tabla.columna`);
    }

    // Y cada suelta tiene que estar EXPLICADA en el schema, porque una
    // secuencia sin dueno sin motivo escrito es una secuencia huerfana esperando
    // que alguien se confíe de `restart identity`.
    for (const seq of STANDALONE) {
      assert.ok(
        declared.includes(seq),
        `${seq} esta en la lista de sueltas pero no se declara en schema.sql`,
      );
      const line = schema.split(/\r?\n/).findIndex((l) => l.includes(`create sequence if not exists ${seq}`));
      const contexto = schema.split(/\r?\n/).slice(Math.max(0, line - 6), line).join('\n');
      assert.match(
        contexto,
        /SIN OWNED BY/i,
        `${seq} es la unica secuencia sin dueno y tiene que decir POR QUE en el schema`,
      );
    }
  });

  test('el schema NO usa SERIAL', () => {
    // Con serial la secuencia y la tabla quedan pegadas y el orden de creacion
    // pasa a ser implicito. Prefiero sequences explicitas: se leen en orden.
    //
    // Se busca sobre el archivo SIN COMENTARIOS, no solo sobre las lineas que
    // empiezan con `create`: la declaracion de una columna va indentada DENTRO
    // del create table, asi que un filtro por prefijo no la ve nunca.
    const schema = fs.readFileSync(path.join(PG, 'schema.sql'), 'utf8');
    const sql = schema.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');

    assert.match(sql, /create table/i, 'control: no se encontro DDL, el guard probaria el vacio');
    assert.doesNotMatch(sql, /\b(serial|bigserial|smallserial)\b/i, 'usar sequences explicitas');
  });

  test('los grants NO le dan DDL ni TRUNCATE al rol de la app', () => {
    const grants = fs.readFileSync(path.join(PG, 'grants.sql'), 'utf8');

    // Si el rol de la app trunca, un bug wipea produccion. Si crea tablas, el
    // schema no protege nada.
    const appGrants = grants
      .split(/alter default privileges/i)[0]
      .split(/-- Rol de TESTS/)[0];

    assert.doesNotMatch(appGrants, /grant[^;]*\btruncate\b[^;]*to\s+compushop_app/i, 'TRUNCATE al rol de la app');
    assert.doesNotMatch(appGrants, /grant[^;]*\bcreate\b[^;]*to\s+compushop_app/i, 'CREATE al rol de la app');
  });

  test('los mappers son puros: no tocan db ni env', () => {
    // Si un mapper pega a la base, los tests de contrato dejan de ser unitarios
    // y cada diferencia de API necesita una base levantada para diagnosticarse.
    // Se miran solo las SENTENCIAS, no los comentarios: el archivo explica en su
    // doc que no usa require ni process.env, y un match global contaria eso.
    const mappers = fs.readFileSync(path.join(PG, 'mappers.js'), 'utf8');
    const code = mappers
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');

    assert.doesNotMatch(code, /require\(/, 'mappers.js no puede requirear nada');
    assert.doesNotMatch(code, /process\.env/, 'mappers.js no puede leer process.env');
    assert.doesNotMatch(code, /\bawait\b|\basync\b/, 'mappers.js tiene que ser sincrono y puro');
  });
});

describe('Controllers', () => {
  test('solo existe authController (los demas eran codigo muerto)', () => {
    const files = listJs(CONTROLLERS);

    assert.deepEqual(files, ['authController.js'], `controllers inesperados: ${files.join(', ')}`);
  });

  test('ningun controller importa la capa de datos eliminada', () => {
    for (const { file, content } of readAll(CONTROLLERS)) {
      assert.ok(!/require\(['"]\.\.\/db\/database['"]\)/.test(content), `${file} todavia importa db/database`);
    }
  });

  test('ningun controller usa sql.js', () => {
    for (const { file, content } of readAll(CONTROLLERS)) {
      assert.ok(!/sql\.js|sql-js|initSqlJs/.test(content), `${file} todavia usa sql.js`);
    }
  });
});

describe('bcrypt en el request path', () => {
  // hashSync/compareSync bloquean el event loop. Con login y registro abiertos
  // al publico, unos cuantos requests concurrentes cuelgan el server para
  // TODOS los usuarios. Solo se tolera en el seed, que corre una vez por CLI.
  const ALLOWED_SYNC = ['db/seed.js'];

  const filesInRequestPath = () => {
    const out = [];
    for (const dir of [CONTROLLERS, path.join(SRC, 'routes'), path.join(SRC, 'middleware'), path.join(SRC, 'utils'), path.join(SRC, 'config')]) {
      out.push(...readAll(dir));
    }
    return out;
  };

  test('no hay hashSync ni compareSync en controllers, routes ni utils', () => {
    for (const { file, content } of filesInRequestPath()) {
      const rel = path.relative(SRC, path.join(file)).replace(/\\/g, '/');
      if (ALLOWED_SYNC.includes(rel)) continue;
      assert.ok(
        !/bcrypt\.(hashSync|compareSync)/.test(stripComments(content)),
        `${rel} usa bcrypt sincronico y bloquea el event loop`
      );
    }
  });

  test('los handlers de auth son async', () => {
    const src = fs.readFileSync(path.join(CONTROLLERS, 'authController.js'), 'utf8');
    for (const fn of ['register', 'login', 'resetPassword']) {
      assert.ok(
        new RegExp(`async function ${fn}\\s*\\(`).test(src),
        `${fn} deberia ser async para no bloquear con bcrypt`
      );
    }
  });

  test('TODO handler async de auth tiene try/catch', () => {
    // Regresion real: `me` paso a ser async cuando la lectura de usuario fue del
    // store a Postgres, y se quedo sin catch. Express 4 NO agarra promesas
    // rechazadas de un handler async: la excepcion sale como unhandled rejection
    // y con Node >= 15 eso mata el proceso. En Vercel se lleva la instancia.
    // `/auth/me` es ademas el primer request que hace el frontend al cargar.
    //
    // El guard es estructural: corta el handler desde su `async function` hasta
    // la proxima `async function` o el `module.exports`, y exige que tenga un
    // `catch`. Agregar un handler nuevo sin catch rompe el test.
    const src = fs.readFileSync(path.join(CONTROLLERS, 'authController.js'), 'utf8');
    const handlers = ['register', 'login', 'me', 'forgotPassword', 'resetPassword'];

    for (const fn of handlers) {
      const desde = src.indexOf(`async function ${fn}(`);
      assert.notStrictEqual(desde, -1, `${fn} deberia existir y ser async`);
      const resto = src.slice(desde + 1);
      const siguiente = resto.search(/\nasync function \w+\(/);
      const cuerpo = siguiente === -1 ? resto : resto.slice(0, siguiente);

      assert.ok(
        /catch\s*\(/.test(cuerpo),
        `${fn} es async y no tiene catch: un error de base lo convierte en un ` +
          'unhandled rejection que tumba el proceso en vez de un 500',
      );
    }
  });

  test('login compara contra un hash senuelo cuando el usuario no existe', () => {
    // Sin esto, un email inexistente responde mas rapido que uno con password
    // mala: midiendo el tiempo de respuesta se enumeran los usuarios validos.
    const src = fs.readFileSync(path.join(CONTROLLERS, 'authController.js'), 'utf8');
    assert.ok(/DUMMY_HASH/.test(src), 'debe existir el hash senuelo');
    assert.ok(
      /user\s*\?\s*user\.password\s*:\s*DUMMY_HASH/.test(src),
      'login debe comparar SIEMPRE, exista o no el usuario'
    );
  });
});

describe('Grafo de imports del backend', () => {
  const sourceFiles = [...walkJs(SRC), ...walkJs(path.join(BACKEND_ROOT, 'api'))];

  test('no hay imports rotos a modulos inexistentes', () => {
    const problems = [];

    for (const abs of sourceFiles) {
      const content = fs.readFileSync(abs, 'utf8');
      for (const m of content.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
        const target = path.resolve(path.dirname(abs), m[1]);
        const ok = ['', '.js', '.json'].some((ext) => fs.existsSync(target + ext)) || fs.existsSync(path.join(target, 'index.js'));
        if (!ok) problems.push(`${path.relative(BACKEND_ROOT, abs)} -> ${m[1]}`);
      }
    }

    assert.deepEqual(problems, [], `imports rotos:\n${problems.join('\n')}`);
  });

  test('routes/index.js NO importa db/store: la capa de datos es data/repo', () => {
    // Este assert estaba INVERTIDO. En la era del store JSON la invariante era
    // "las rutas leen del store", asi que el guard la exigia. Cuando la
    // migracion a PostgreSQL termino, ese mismo assert paso a exigir un import
    // muerto: dejo de proteger la migracion y empezo a bloquearla. Un guard
    // afirma la invariante que se QUIERE, no la que existia antes.
    //
    // `src/db/store.js` sigue en el repo a proposito (red de seguridad hasta la
    // 8.2). Lo que se prohibe es que algo lo USE, no que exista.
    assert.deepEqual(
      listJs(path.join(SRC, 'routes')),
      ['index.js'],
      'aparecio otro archivo de rutas: el enrutado vive en index.js',
    );

    const code = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'index.js'), 'utf8'));

    assert.doesNotMatch(
      code,
      /require\(\s*['"][^'"]*db\/store/,
      'routes/index.js no puede importar db/store: desde la fase 4 toda lectura va por data/repo',
    );

    // `store.` como receptor cubre CUALQUIER metodo (get, next, persist y los que
    // store.js agregue manana), asi que no hay una lista de API que mantener al
    // dia ni un metodo nuevo que se escape por no estar en ella. Y no puede dar
    // falso positivo: sin el require del assert de arriba, `store` no existe.
    assert.doesNotMatch(
      code,
      /\bstore\s*\./,
      'routes/index.js usa el store: el receptor `store.` no puede existir en el request path',
    );

    // Y que el repo este de verdad. Sin estos dos asserts, vaciar las rutas de su
    // require del repo dejaria un archivo que no lee de ninguna parte y todo lo
    // de arriba pasaria por vacuidad.
    assert.match(
      code,
      /require\(\s*['"]\.\.\/data\/repo['"]\s*\)/,
      'routes/index.js tiene que leer por data/repo',
    );
    assert.match(code, /\brepo\s*\./, 'control: repo tiene que usarse de verdad, no solo importarse');

    // Lo que afirmaba el assert viejo ademas de "usa el store": que la capa
    // `db/database` (el shim de SQL falso) no aparece. Sigue aqui.
    assert.doesNotMatch(code, /db\/database/, 'las rutas no deben usar la capa eliminada');
  });

  test('ningun modulo del request path importa db/store para leer datos', () => {
    // `controllers/`, `middleware/` y `utils/` se migraron en las fases 3 y 4.
    // La carpeta `src/db/` NO entra en la lista: ahi vive el store, y que
    // exista todavia es lo correcto hasta la 8.2.
    const CONSUMERS = ['controllers', 'middleware', 'utils'];
    const offenders = [];

    for (const dir of CONSUMERS) {
      for (const { file, content } of readAll(path.join(SRC, dir))) {
        if (/require\(\s*['"][^'"]*db\/store/.test(stripComments(content))) {
          offenders.push(`${dir}/${file}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `db/store importado desde el request path:\n${offenders.join('\n')}`);

    // Control explicito sobre los dos modulos que mas se tocan. Si uno de los
    // dos se rompe, el assert de arriba lo frena, pero este dice cual fue.
    for (const rel of ['controllers/authController.js', 'utils/email.js']) {
      const content = stripComments(fs.readFileSync(path.join(SRC, ...rel.split('/')), 'utf8'));

      assert.match(
        content,
        /require\(\s*['"]\.\.\/data\/repo['"]\s*\)/,
        `${rel} deberia leer por data/repo`,
      );
      assert.doesNotMatch(content, /\bstore\s*\./, `${rel} todavia usa el store`);
    }
  });
});

describe('Reglas de seguridad estructurales', () => {
  const routes = fs.readFileSync(path.join(SRC, 'routes', 'index.js'), 'utf8');
  const ordersBlock = routes.slice(routes.indexOf("router.post('/orders'"), routes.indexOf("router.get('/orders'"));

  test('POST /orders no calcula el total usando el price del body', () => {
    assert.ok(
      !/items\.reduce\(\s*\(sum,\s*i\)\s*=>\s*sum\s*\+\s*i\.price/.test(ordersBlock),
      'el total debe calcularse sobre los items resueltos desde la DB, no sobre el body'
    );
  });

  test('POST /orders valida que la cantidad sea un entero >= 1', () => {
    assert.ok(/Number\.isInteger/.test(ordersBlock), 'falta la validacion de entero para quantity');
    assert.ok(/qty < 1/.test(ordersBlock), 'falta el rechazo de cantidades < 1');
  });

  test('JWT_SECRET no tiene un fallback usable en produccion', () => {
    const jwtSrc = fs.readFileSync(path.join(SRC, 'utils', 'jwt.js'), 'utf8');

    assert.ok(/throw new Error/.test(jwtSrc), 'jwt.js debe fallar al arrancar sin secret en produccion');
    assert.ok(
      !/JWT_SECRET\s*\|\|\s*'compushop_secret'/.test(jwtSrc),
      'el fallback no puede ser el string original "compushop_secret"'
    );
  });

  test('verifyToken fija el algoritmo permitido (rechaza alg:none)', () => {
    const jwtSrc = fs.readFileSync(path.join(SRC, 'utils', 'jwt.js'), 'utf8');

    assert.ok(/algorithms:\s*\['HS256'\]/.test(jwtSrc), 'verifyToken debe fijar algorithms: [HS256]');
  });

  test('dev_token solo se expone fuera de produccion', () => {
    const authSrc = fs.readFileSync(path.join(SRC, 'controllers', 'authController.js'), 'utf8');
    const idx = authSrc.indexOf('dev_token');
    assert.ok(idx !== -1, 'el bloque dev_token deberia existir');
    const context = authSrc.slice(Math.max(0, idx - 600), idx);

    assert.ok(/isProd/.test(context), 'dev_token debe estar protegido por el chequeo de isProd');
  });

  test('el link de reset apunta a /reset-password y usa FRONTEND_URL', () => {
    const emailSrc = fs.readFileSync(path.join(SRC, 'utils', 'email.js'), 'utf8');

    assert.ok(!/localhost:5173\/recuperar-clave/.test(emailSrc), 'el link apuntaba a la ruta equivocada');
    assert.ok(/getSetting\(['"]frontend_url['"]/.test(emailSrc), 'debe tomar el host de settings/env');
  });
});

describe('Guards de UI: formato de precios y NumberInput de precio', () => {
  // Estas guards viven en el backend porque `npm test` es el unico runner del
  // repo: el frontend no tiene ni linter ni tests configurados.

  const REPO_ROOT = path.join(BACKEND_ROOT, '..');
  const FRONTEND_SRC = path.join(REPO_ROOT, 'frontend', 'src');
  // Relativo y SIEMPRE con "/" porque rel() normaliza a "/" (en Windows
  // path.join devuelve "\", y un endsWith con backslash nunca matchea).
  const FORMAT_UTIL = 'frontend/src/utils/format.js';

  const walk = (dir) => {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(abs);
        return entry.isFile() && /\.(jsx|tsx|js|ts)$/.test(entry.name) ? [abs] : [];
      });
  };

  const read = (abs) => fs.readFileSync(abs, 'utf8');
  const rel = (abs) => path.relative(REPO_ROOT, abs).replace(/\\/g, '/');

  /** El bloque del NumberInput de PRECIO: desde el label hasta el field. */
  const priceInputBlock = (abs) => {
    const src = read(abs);
    const from = src.indexOf('Precio</FormLabel>');
    const to = src.indexOf('<NumberInputField', from);
    return from === -1 || to === -1 ? '' : src.slice(from, to);
  };

  test('utils/format.js existe y es la unica fuente de formato de precios', () => {
    const fmt = path.join(REPO_ROOT, FORMAT_UTIL);

    assert.ok(fs.existsSync(fmt), 'debe existir frontend/src/utils/format.js');
    assert.ok(/export function formatPrice/.test(read(fmt)), 'debe exportar formatPrice');
  });

  test('ningun componente vuelve a formatear precios por su cuenta', () => {
    // Con maximumFractionDigits: 0 un precio de 6899.99 se mostraba "$ 6.900"
    // y el admin concluyo que los centavos no se guardaban. Ver backend tests.
    const offenders = walk(FRONTEND_SRC)
      .filter((abs) => rel(abs) !== FORMAT_UTIL)
      .filter((abs) => /Intl\.NumberFormat/.test(read(abs)))
      .map(rel);

    assert.deepEqual(offenders, [], `importa formatPrice de utils/format.js en vez de duplicarlo:\n${offenders.join('\n')}`);
  });

  test('ningun archivo del frontend redondea a 0 decimales un precio', () => {
    const offenders = walk(FRONTEND_SRC)
      .filter((abs) => /maximumFractionDigits\s*:\s*0/.test(read(abs)))
      .map(rel);

    assert.deepEqual(offenders, [], `maximumFractionDigits: 0 oculta los centavos:\n${offenders.join('\n')}`);
  });

  for (const file of ['AdminProducts.jsx', 'AdminServices.jsx']) {
    describe(file, () => {
      const abs = path.join(FRONTEND_SRC, 'pages', 'admin', file);
      const block = () => priceInputBlock(abs);

      test('el NumberInput de precio fija precision y step de centavo', () => {
        assert.ok(block(), 'no se encontro el bloque de precio del admin');
        assert.ok(/precision\s*=\s*{\s*2\s*}/.test(block()), 'falta precision={2}');
        assert.ok(/step\s*=\s*{?\s*0\.01\s*}?/.test(block()), 'falta step={0.01} para mover centavos');
        assert.ok(/min\s*=\s*{?\s*0\s*}?/.test(block()), 'falta min={0}');
      });

      test('el NumberInput de precio acepta la coma decimal argentina', () => {
        // Chakra filtra por /^[Ee0-9+\-.]$/: sin isValidCharacter el teclado
        // bloquea la coma, y sin parse el sanitize la borra ("6899,99" -> 689999).
        assert.ok(/isValidCharacter/.test(block()), 'falta isValidCharacter (el teclado bloquea la coma)');
        assert.ok(/parse/.test(block()), 'falta parse (sanitize borra la coma antes de Number())');
        assert.ok(/pattern\s*=\s*"\[0-9\]\*\(\[\.,\]\[0-9\]\+\)\?"/.test(block()), 'falta el pattern que acepta coma o punto');
      });

      test('el save no convierte un precio vacio en 0', () => {
        const src = read(abs);
        const save = src.slice(src.indexOf('const save ='), src.indexOf('const remove ='));

        assert.ok(/vacio|vacío/.test(save), 'debe chequear explicitamente el precio vacio');
        assert.ok(/Number\.isFinite/.test(save), 'debe validar que el precio sea un numero finito');
      });
    });
  }
});
