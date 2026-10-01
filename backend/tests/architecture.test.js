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

  /** Saca comentarios: mentioning la API en un comentario no es usarla. */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
  // Recorre archivos .js en profundidad, sin reventar con archivos sueltos.
  const walk = (dir) => {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(abs);
        return entry.isFile() && entry.name.endsWith('.js') ? [abs] : [];
      });
  };
  const sourceFiles = [...walk(SRC), ...walk(path.join(BACKEND_ROOT, 'api'))];

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

  test('routes/index.js es el unico que enruta, y usa store.js', () => {
    const routes = fs.readFileSync(path.join(SRC, 'routes', 'index.js'), 'utf8');

    assert.ok(/require\(['"]\.\.\/db\/store['"]\)/.test(routes), 'las rutas deben usar store');
    assert.ok(!/db\/database/.test(routes), 'las rutas no deben usar la capa eliminada');
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
