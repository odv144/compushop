const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('fs');
const path = require('path');
const { test } = require('node:test');
const { BACKEND_ROOT } = require('./helpers');

const DATA = path.join(BACKEND_ROOT, 'src', 'data');
const PG = path.join(DATA, 'postgres');
const read = (p) => readFileSync(p, 'utf8');
const code = (p) => read(p).split(/\r?\n/).filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');

test('META: los guards de arquitectura detectan sus propios fallos', () => {
  // Un guard que nunca falla no es un guard: es decoracion. Estos mutan una
  // copia de los archivos con el bug inyectado y comprueban que el guard lo
  //_note_. Si alguno pasa con el bug presente, el guard es inutil.
  const schema = read(path.join(PG, 'schema.sql'));
  const grants = read(path.join(PG, 'grants.sql'));
  const pool = read(path.join(PG, 'pool.js'));
  const mappers = read(path.join(PG, 'mappers.js'));

  const declared = (s) => [...s.matchAll(/^\s*create sequence if not exists (\w+)/gm)].map((m) => m[1]);
  const owned = (s) => [...s.matchAll(/^\s*alter sequence (\w+)\s+owned by (\w+\.\w+)/gm)];
  // La MISMA cuenta que hace el guard: las declaradas que nadie posee.
  const sueltas = (s) => declared(s).filter((d) => !owned(s).some((o) => o[1] === d)).sort();

  // --- OWNED BY ---
  // `order_number_seq` es la unica secuencia sin dueno, y esta DECLARADA como
  // tal: su numero de pedido es un texto formateado y no tiene columna entera
  // de la que ser dueña. Ver el comentario en schema.sql.
  const STANDALONE = ['order_number_seq'];

  // Control: el schema real tiene exactamente esa, y solo esa.
  assert.deepEqual(sueltas(schema), [...STANDALONE].sort(), 'control: el schema real esta completo');

  // Bug 1: se saca el OWNED BY de una secuencia que si lo tenia.
  const roto = schema.replace(/^\s*alter sequence users_id_seq\s+owned by users\.id;.*$/m, '');
  assert.notEqual(roto, schema, 'el mutador no cambio nada');
  assert.equal(declared(roto).length, declared(schema).length, 'el bug no puede cambiar la cantidad de secuencias');
  assert.deepEqual(
    sueltas(roto),
    [...STANDALONE, 'users_id_seq'].sort(),
    'GUARD ROTO: no detecto la secuencia sin OWNED BY',
  );

  // Bug 2: aparece una secuencia NUEVA, sin dueno y sin declararla. Este es el
  // caso que el allowlist por comparacion EXACTA tiene que agarrar: si el guard
  // mirara "hay al menos una sin dueno y ya declare una", pasaria.
  const huerfana = schema.replace(
    /^(\s*create sequence if not exists order_items_id_seq\s+as integer start 1;)$/m,
    '$1\ncreate sequence if not exists secuencia_nueva_seq as integer start 1;',
  );
  assert.notEqual(huerfana, schema, 'el mutador de secuencia huerfana no aplico');
  assert.deepEqual(
    sueltas(huerfana),
    [...STANDALONE, 'secuencia_nueva_seq'].sort(),
    'GUARD ROTO: acepto una secuencia sin OWNED BY que nadie declaro',
  );

  // El caso del padding vive mas abajo, con el conteo de las que TIENEN dueno.

  // --- TRUNCATE al rol de la app ---
  const appGrants = (s) => s.split(/alter default privileges/i)[0].split(/-- Rol de TESTS/)[0];
  const leaks = (s) => /grant[^;]*\btruncate\b[^;]*to\s+compushop_app/i.test(appGrants(s));
  assert.equal(leaks(grants), false, 'control: el grants real esta limpio');

  const conTruncate = grants.replace(
    /^(grant select, insert, update, delete) on$/m,
    '$1, truncate on',
  );
  assert.notEqual(conTruncate, grants, 'el mutador de TRUNCATE no aplico');
  assert.equal(leaks(conTruncate), true, 'GUARD ROTO: no detecto TRUNCATE al rol de la app');

  // Y que NO confunda la mencion en comentario.
  assert.match(grants, /Ningun rol tiene TRUNCATE/, 'grants.sql menciona TRUNCATE en un comentario');
  assert.equal(leaks(grants), false, 'GUARD ROTO: conto el comentario como permiso');

  // --- SERIAL ---
  // Se busca sobre el archivo SIN COMENTARIOS, no filtrando por lineas que
  // empiezan con `create`: una columna va indentada DENTRO del create table, y
  // un filtro por prefijo la veza nunca. Ese fue el bug del primer intento:
  // el guard pasaba limpio con `id serial` en el schema.
  const sinComentarios = (s) => s.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
  const usaSerial = (s) => /\b(serial|bigserial|smallserial)\b/i.test(sinComentarios(s));
  assert.ok(/\bcreate table\b/i.test(sinComentarios(schema)), 'control: hay DDL en el schema');
  assert.equal(usaSerial(schema), false, 'control: el schema real no usa serial');

  // La linea tiene que existir tal cual para que el mutador aplique. Si el
  // schema cambia de forma, este test avisa en vez de "verificar" un guard que
  // nunca llego a comprobar nada.
  const ancla = "id          integer primary key default nextval('users_id_seq')";
  assert.ok(schema.includes(ancla), 'el schema cambio de forma y el mutador no aplica');
  const conSerial = schema.replace(ancla, 'id          serial primary key');
  assert.notEqual(conSerial, schema, 'el mutador no cambio nada');
  assert.equal(usaSerial(conSerial), true, 'GUARD ROTO: no detecto serial');

  // Y NO debe dar falso positivo por la mencion legitima del comentario.
  assert.match(schema, /no con `serial`/, 'el schema menciona serial en un comentario');
  assert.equal(usaSerial(schema), false, 'GUARD ROTO: conto el comentario como serial');

  // --- OWNED BY: el helper tiene que contar las 8 aunque cambie el padding ---
  // El total delas que TIENEN dueno es declaradas menos las declaradas sueltas.
  const conDueno = (s) => owned(s).length;
  const esperado = declared(schema).length - STANDALONE.length;
  assert.equal(conDueno(schema), esperado, 'control: el schema real tiene todas las duenas');
  assert.equal(
    conDueno(schema.replace(/(alter sequence \w+)\s{2,}owned by/g, '$1 owned by')),
    esperado,
    'GUARD ROTO: dependia del padding',
  );
  assert.equal(
    conDueno(schema.replace(/(alter sequence \w+)\s+owned by/g, '$1 owned by')),
    esperado,
    'GUARD ROTO: no tolera un solo espacio',
  );

  // --- mappers puros ---
  const impuro = (s) => {
    const c = s.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
    return /require\(|process\.env|\bawait\b|\basync\b/.test(c);
  };
  assert.equal(impuro(mappers), false, 'control: los mappers reales son puros');

  assert.equal(impuro(mappers + '\nrequire("./db/store")'), true, 'GUARD ROTO: no detecto require');
  assert.equal(impuro(mappers + '\nconst x = process.env.DATABASE_URL;'), true, 'GUARD ROTO: no detecto process.env');
  assert.equal(impuro(mappers + '\nasync function f() { await g(); }'), true, 'GUARD ROTO: no detecto async/await');

  // Y NO debe dar falso positivo por los comentarios del doc.
  assert.match(mappers, /Sin DB, sin I\/O, sin process\.env/, 'el doc menciona process.env');
  assert.equal(impuro(mappers), false, 'GUARD ROTO: cuento el comentario como impurity');

  // --- pool sin fallback ---
  const usaStore = (s) => /require\(\s*['"][^'"]*db\/store|readFileSync|createReadStream/.test(s);
  assert.equal(usaStore(pool), false, 'control: pool.js no lee el store');

  // El mensaje de error MENCIONA data.json a proposito. Tiene que seguir
  //matching clean: un guard que se dispara por su propia documentacion es
  // peor que no tener guard, porque entrena al equipo a ignorarlo.
  assert.match(pool, /No hay fallback a data\.json/, 'el mensaje de error menciona data.json');
  assert.equal(usaStore(pool), false, 'GUARD ROTO: el texto del error disparo el guard');

  assert.equal(usaStore(pool + '\nconst s = require("../db/store");'), true, 'GUARD ROTO: no detecto el import');
  assert.equal(usaStore(pool + '\nfs.readFileSync("data.json");'), true, 'GUARD ROTO: no detecto readFileSync');

  // --- el pool se importa desde adentro de postgres/ ---
  // El guard nuevo de architecture.test.js prohibe que `queries/*.js` salgan de
  // su namespace a buscar el pool. Se comprueba con el MISMO bug que se
  // prohibe: volver al `require('../../pool')` de antes del fix D-A.
  const QUERIES = path.join(PG, 'queries');
  const poolModules = readdirSync(QUERIES).filter((f) => f.endsWith('.js'));
  // Mismo filtro del guard: solo interesan los modulos que IMPORTAN el pool.
  // `_shared.js` no lo importa (son helpers puros de SQL, sin DB), asi que no
  // puede violar una regla de require.
  const importaPool = (src) => /require\([^)]*pool[^)]*\)/.test(src);
  const sacaNamespace = (src) => importaPool(src) && !/require\(\s*'\.\.\/pool'\s*\)/.test(src);

  const fueraDeNamespace = poolModules.filter((f) => sacaNamespace(read(path.join(QUERIES, f))));
  assert.deepEqual(fueraDeNamespace, [], 'control: todos los modulos que importan el pool usan ../pool');

  // Mutacion: volver al require que sube dos niveles.
  assert.equal(
    sacaNamespace(read(path.join(QUERIES, 'products.js')).replace("require('../pool')", "require('../../pool')")),
    true,
    'GUARD ROTO: no detecto el require que sale del namespace',
  );
  // Y el otro camino de "traer el pool desde afuera": un path absoluto.
  assert.equal(sacaNamespace(`require('${path.join(DATA, 'pool')}')`), true,
    'GUARD ROTO: no detecto el path absoluto al pool');
  // Y que un modulo sin require de pool no se marque: si no, el guard dispara
  // por un archivo que no podia violarlo.
  assert.equal(sacaNamespace(`// nada que ver con el pool\nconst a = 1;`), false,
    'GUARD ROTO: marco un modulo que ni importa el pool');

  // --- la capa de datos es el repo, no el store JSON ---
  // El guard de las rutas estaba INVERTIDO: exigia `require('../db/store')` porque
  // en la era del store JSON esa era la capa de datos. Cuando la migracion a
  // PostgreSQL termino, el guard paso a exigir un import muerto. Un guard que
  // bloquea la migracion en vez de protegerla es peor que no tener guard.
  //
  // Se comprueba en las DOS direcciones, que es como se rompe un require:
  // agregando el store, y sacando el repo.
  const ROUTES_FILE = path.join(BACKEND_ROOT, 'src', 'routes', 'index.js');
  const routes = read(ROUTES_FILE);

  // Mismo stripper que el guard: si divergen, el selftest deja de probarlo.
  const codigo = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const rutasImportanStore = (s) => /require\(\s*['"][^'"]*db\/store/.test(codigo(s));
  const rutasUsanStore = (s) => /\bstore\s*\./.test(codigo(s));
  const rutasImportanRepo = (s) => /require\(\s*['"]\.\.\/data\/repo['"]\s*\)/.test(codigo(s));

  // Acoplamiento: los patrones del selftest son COPIAS de los del guard. Si el
  // guard cambia el patron y el selftest no, el selftest pasa probando otra cosa.
  // Se verifica que el archivo del guard siga conteniendo el texto exacto.
  const guardSrc = read(path.join(BACKEND_ROOT, 'tests', 'architecture.test.js'));
  for (const patron of ["[^'\"]*db\\/store", "\\bstore\\s*\\.", "['\"]\\.\\.\\/data\\/repo['\"]"]) {
    assert.ok(guardSrc.includes(patron), `el guard dejo de usar el patron ${patron}: el selftest ya no lo prueba`);
  }

  // Control: el archivo real esta limpio y si lee por el repo.
  assert.equal(rutasImportanStore(routes), false, 'control: las rutas reales no importan el store');
  assert.equal(rutasUsanStore(routes), false, 'control: las rutas reales no usan `store.`');
  assert.equal(rutasImportanRepo(routes), true, 'control: las rutas reales importan el repo');

  // Bug 3: se vuelve a meter el require del store. Es exactamente lo que
  // alguien hace para hacer pasar el guard viejo.
  const conStore = routes.replace(
    /^(const repo = require\('\.\.\/data\/repo'\);)$/m,
    "$1\nconst store = require('../db/store');",
  );
  assert.notEqual(conStore, routes, 'el mutador del require del store no aplico');
  assert.equal(rutasImportanStore(conStore), true, 'GUARD ROTO: no detecto el require del store en las rutas');

  // Bug 3b: el store se USA sin require (alguien lo importa con otro nombre, o
  // se cuela el receiver). El assert del require solo no lo ve.
  assert.equal(rutasUsanStore(routes + '\nconst p = store.get("products");'), true,
    'GUARD ROTO: no detecto el uso del store en las rutas');
  // Y que un `store.` en COMENTARIO no dispare: es prosa sobre la migracion.
  assert.equal(rutasUsanStore(routes + '\n// antes se usaba: store.get("products")\n'), false,
    'GUARD ROTO: conto el comentario como uso del store');
  assert.equal(rutasImportanStore(routes + '\n// const store = require("../db/store");\n'), false,
    'GUARD ROTO: conto el comentario como import del store');

  // Bug 4: las rutas dejan de importar el repo. Sin este assert el guard pasaba
  // por vacuidad: un archivo que no lee de ninguna parte.
  const sinRepo = routes.replace(/^const repo = require\('\.\.\/data\/repo'\);\n/m, '');
  assert.notEqual(sinRepo, routes, 'el mutador del require del repo no aplico');
  assert.equal(rutasImportanRepo(sinRepo), false, 'GUARD ROTO: las rutas pueden dejar de importar el repo');

  // --- y el request path (controllers/middleware/utils) ---
  const CONSUMIDORES = ['controllers', 'middleware', 'utils'];
  const requestPath = () => {
    const out = [];
    for (const dir of CONSUMIDORES) {
      const abs = path.join(BACKEND_ROOT, 'src', dir);
      for (const file of readdirSync(abs).filter((f) => f.endsWith('.js'))) {
        out.push({ rel: `${dir}/${file}`, content: read(path.join(abs, file)) });
      }
    }
    return out;
  };
  const conStoreImportado = (files) =>
    files.filter((f) => /require\(\s*['"][^'"]*db\/store/.test(codigo(f.content))).map((f) => f.rel);

  assert.deepEqual(conStoreImportado(requestPath()), [], 'control: el request path no importa el store');
  // Que el recorrido no sea vacio: si CONSUMIDORES se rompe, el assert de arriba
  // pasa por vacuidad con cero archivos revisados.
  assert.ok(requestPath().length >= 4, 'control: se revisaron muy pocos archivos del request path');

  const sucio = requestPath().map((f) =>
    f.rel === 'utils/email.js'
      ? { ...f, content: `${f.content}\nconst store = require('../db/store');` }
      : f,
  );
  assert.deepEqual(conStoreImportado(sucio), ['utils/email.js'],
    'GUARD ROTO: no detecto el store colado en utils/email.js');
});


test('META: el guard de orden keep-warm vs limiter detecta las tres regresiones', () => {
  // El predicado de orden vive en tests/middleware-order.js, NO duplicado aca:
  // con dos copias, el selftest puede pasar probando una que el guard real no
  // usa. Se exige que architecture.test.js lo requiera, asi que el acoplamiento
  // entre "el guard" y "lo que el selftest prueba" no se puede romper en silencio.
  const { analizar, ordenKeepWarmValido, MOUNT, LIMITER, mountDespuesDelLimiter, mountDentroDeIf, limiterSinGuard } =
    require('./middleware-order');

  const guardSrc = read(path.join(BACKEND_ROOT, 'tests', 'architecture.test.js'));
  assert.ok(
    guardSrc.includes("require('./middleware-order')"),
    'acoplamiento roto: architecture.test.js dejo de usar el predicado compartido',
  );
  const modSrc = read(path.join(BACKEND_ROOT, 'tests', 'middleware-order.js'));
  for (const patron of [MOUNT, LIMITER]) {
    assert.ok(modSrc.includes(patron), `el predicado compartido dejo de usar el patron ${patron}`);
  }

  const index = read(path.join(BACKEND_ROOT, 'src', 'index.js'));

  // Control: el archivo real cumple las cinco reglas.
  assert.equal(ordenKeepWarmValido(index), true, 'control: el orden real es correcto');
  const a = analizar(index);
  assert.equal(a.profundidadMount, 0, 'control: el montaje real es incondicional');
  assert.ok(a.limiterGuardadoPorIsTest, 'control: el limiter real sigue guardado por isTest');

  // Cada mutacion tiene que (a) aplicar de verdad y (b) romper el predicado.
  // El `notEqual` contra el original es lo que evita el falso "el guard funciona":
  // un mutador que no encuentra la forma devuelve el fuente sin tocar y pasaria
  // por deteccion si no se comprobara.
  const casos = [
    {
      nombre: 'M1 keep-warm despues del limiter',
      mutado: mountDespuesDelLimiter(index),
    },
    {
      nombre: 'M2 keep-warm montado dentro de un if (el bug original)',
      mutado: mountDentroDeIf(index),
    },
    {
      nombre: 'M3 limiter registrado sin el guard de isTest',
      mutado: limiterSinGuard(index),
    },
  ];

  for (const { nombre, mutado } of casos) {
    assert.notEqual(mutado, index, `el mutador ${nombre} no aplico`);
    assert.equal(ordenKeepWarmValido(mutado), false, `GUARD ROTO: no detecto ${nombre}`);
  }
});


test('META: cada guard de keep-warm falla por SU regla y no por una ajena', () => {
  // El selftest de arriba prueba que el predicado COMPUESTO se rompe, que es lo
  // unico que importa para no dejar pasar el bug. No alcanza: un predicado
  // compuesto puede romperse siempre por el mismo motivo y aun asi cada test
  // individual mentir sobre QUE se rompio.
  //
  // Eso era exactamente lo que pasaba. `limiterGuardadoPorIsTest` se calculaba
  // con `src.slice(mount, limiter)`, o sea que exigia que el `if (!isTest)`
  // estuviera ENTRE el montaje y el limitador. Con el orden invertido (M1) el
  // `slice` salia vacio, el flag daba false, y el test "el limitador sigue
  // siendo condicional a NODE_ENV=test" fallaba anunciando esa regla. Pero el
  // limitador SEGUIA dentro del `if` que lo protege: la regla no se habia roto,
  // solo el orden. El rojo apuntando a la regla equivocada manda al que lo lee
  // a cambiar la condicion del limitador, que es justo lo que no hay que tocar.
  //
  // Aca cada mutacion tiene que romper SU regla y dejar las otras dos en verde.
  // Una regla que se rompe de mas no es conservatism: es diagnostico incorrecto.
  const { analizar, mountDespuesDelLimiter, mountDentroDeIf, limiterSinGuard } =
    require('./middleware-order');
  const read = (p) => require('fs').readFileSync(p, 'utf8');
  const index = read(path.join(BACKEND_ROOT, 'src', 'index.js'));
  const base = analizar(index);
  assert.equal(base.mount < base.limiter, true, 'control: el orden real es correcto');
  assert.equal(base.profundidadMount, 0, 'control: el montaje real es incondicional');
  assert.equal(base.limiterGuardadoPorIsTest, true, 'control: el limiter real sigue guardado');

  const R = (a) => ({ orden: a.mount < a.limiter, incondicional: a.profundidadMount === 0, guardado: a.limiterGuardadoPorIsTest });
  const espera = {
    'M1 keep-warm despues del limiter': { orden: false, incondicional: true, guardado: true },
    'M2 keep-warm dentro de un if': { orden: true, incondicional: false, guardado: true },
    'M3 limiter sin el guard de isTest': { orden: true, incondicional: true, guardado: false },
  };
  const mutaciones = {
    'M1 keep-warm despues del limiter': mountDespuesDelLimiter(index),
    'M2 keep-warm dentro de un if': mountDentroDeIf(index),
    'M3 limiter sin el guard de isTest': limiterSinGuard(index),
  };

  for (const [nombre, quiero] of Object.entries(espera)) {
    const a = R(analizar(mutaciones[nombre]));
    for (const [regla, valor] of Object.entries(quiero)) {
      assert.equal(
        a[regla],
        valor,
        `${nombre}: la regla "${regla}" deberia dar ${valor} y dio ${a[regla]}. ` +
        `O se rompio una regla que no deberia, o el guard que la mide no mide eso.`,
      );
    }
  }
});
