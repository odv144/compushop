/**
 * Regresion de la normalizacion de `SUPABASE_CA_CERT` en `pool.js`.
 *
 * ===========================================================================
 * EL BUG
 * ===========================================================================
 * La misma variable llega de dos formas distintas segun el entorno, y `pg`
 * solo acepta una:
 *
 *   - LOCAL: `dotenv` (16.6.1) parsea `backend/.env` y EXPANDE los `\n` de un
 *     valor entre comillas dobles. La CA llega con newlines REALES (24 lineas).
 *   - VERCEL: las env vars se leen CRUDAS de `process.env` y NUNCA pasan por
 *     `dotenv`. Un valor copiado de `.env.example:44` llega como una unica
 *     linea con `\n` LITERALES (1 linea).
 *
 * Antes del fix, `pg` rechazaba la forma de Vercel y TODAS las APIs daban 500.
 * Medido antes de arreglar: local `newline REAL: true, lineas: 24, TLS valido:
 * SI` / Vercel `newline REAL: false, barra-n literal: true, lineas: 1, TLS
 * valido: NO`.
 *
 * ===========================================================================
 * POR QUE EL FIX NORMALIZA EN EL CODIGO Y NO DEPENDE DE COMO SE PEGO LA VARIABLE
 * ===========================================================================
 * `.env.example` muestra la forma de Vercel (comillas dobles + `\n` literales)
 * y es la forma que la gente copia, pero la forma que `dotenv` produce es
 * distinta. Depender de "recordar pegar el valor con newlines de verdad"
 * significa que el deploy se rompe por como se copio un texto, no por un bug.
 * Normalizar en el punto de consumo hace que las dos vias converjan y que el
 * valor correcto sea el unico resultado posible.
 *
 * ===========================================================================
 * POR QUE CADA CASO CORRE EN UN PROCESO NODE AISLADO
 * ===========================================================================
 * `pool.js` lee `process.env` y construye el objeto `ssl` A NIVEL DE MODULO, en
 * el `require`: no hay funcion a la que llamar con variantes, no hay hook. La
 * unica forma de probar dos valores distintos es requerirse dos veces con
 * entornos distintos, y en el MISMO proceso eso obliga a borrar la cache de
 * modulos y a mutar `process.env`.
 *
 * Mutar `process.env` aca seria una contaminacion real: `isProd` depende de
 * `NODE_ENV==='production' || !!process.env.VERCEL`, asi que un `VERCEL` que
 * quedara seteado manda TODOS los casos al branch de produccion y hace que los
 * tests midan otra cosa. Y si un test falla a mitad de camino, el resto de la
 * suite ya corre con un entorno mentiroso.
 *
 * Por eso se usa el patron que ya establecio `auth.security.test.js:43`
 * (`execFileSync` con un `node -e` y un env explicito): cada caso es un proceso
 * nuevo, el entorno se declara completo en cada llamada, y no hay cache que
 * limpiar ni `finally` que se pueda saltar. El aislamiento es estructural, no
 * una promesa.
 *
 * `VERCEL` se declara SIEMPRE (`undefined` included) en cada llamada: heredar
 * un `VERCEL` del shell mandaria los casos al branch equivocado.
 *
 * ===========================================================================
 * QUE SE CAPTURA
 * ===========================================================================
 * `pg.Pool` se reemplaza por una funcion que captura las opciones y devuelve
 * un `{ on() {} }`. Asi se lee el `ssl` EXACTAMENTE como `pool.js` lo entrego,
 * sin abrir un socket, sin timers, sin depender de la version de `pg`. Como
 * el `new Pool` esta DESPUES de la validacion del PEM, un `threw` con
 * `constructed === false` prueba que fallo al validar la config y no al
 * conectar: eso es lo que hace que el error sea accionable.
 *
 * El certificado es SINTETICO y vive solo aca. El valor real de la CA no esta en
 * ningun archivo del repo.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND_ROOT = path.join(__dirname, '..');
const POOL_PATH = path.join(BACKEND_ROOT, 'src', 'data', 'postgres', 'pool.js');

/**
 * PEM sintetico. El cuerpo base64 es inventado y esta partido en tres lineas
 * de 64 caracteres, como uno real, para que el round-trip tenga algo que
 * preservar: si la normalizacion tocara el cuerpo, el assert lo veria.
 */
const CERT_BODY = [
  'MIIFATCCApegAwIBAgIUY2Zha2UtY2EtZm9yLXRlc3RpbmctMDAwMDAwMDAwMDAw',
  'DQYJKoZIhvcNAQELBQAwUjEYMBYGA1UEAxMPZmFrZS1jYS10ZXN0LW5vdC1yZWFs',
  'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAFAKEURFAKEURFAKEUR',
];

/** La forma de `dotenv`: newlines reales (5 lineas). */
const PEM_REAL = ['-----BEGIN CERTIFICATE-----', ...CERT_BODY, '-----END CERTIFICATE-----'].join('\n');

/** La forma de `.env.example:44` / Vercel: una sola linea con `\n` literales. */
const PEM_LITERAL = PEM_REAL.split('\n').join('\\n');

/** Cuenta ocurrencias de un caracter (o secuencia) sin regex. */
const countOf = (s, ch) => s.split(ch).length - 1;

/**
 * El probe corre en el hijo. Devuelve por stdout un JSON con:
 *   threw / message  -> si el require fallo, y con que mensaje
 *   constructed       -> si se llego a construir el Pool
 *   caB64             -> el `ssl.ca` recibido, en base64 (transporte sin ambiguedad)
 *   rejectUnauthorized-> el `ssl.rejectUnauthorized` recibido
 */
const PROBE = `
const pg = require('pg');
let captured = null;
pg.Pool = function (options) {
  captured = options;
  return { on: function () {} };
};
const out = { threw: false, message: null, constructed: false, caB64: null, rejectUnauthorized: null };
try {
  require(process.argv[1]);
} catch (e) {
  out.threw = true;
  out.message = String(e && e.message);
}
out.constructed = captured !== null;
if (captured && captured.ssl) {
  out.rejectUnauthorized = captured.ssl.rejectUnauthorized;
  out.caB64 = captured.ssl.ca === undefined ? null : Buffer.from(String(captured.ssl.ca), 'utf8').toString('base64');
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * Corre el probe con un entorno DECLARADO COMPLETO. Nada se hereda por
 * accidente: `NODE_ENV`, `VERCEL`, `DATABASE_URL` y `SUPABASE_CA_CERT` van
 * siempre explicitos.
 *
 * `SUPABASE_CA_CERT: undefined` saca la variable del env del hijo (Node omite
 * los valores `undefined` al armar el env block), que es como se prueba el
 * caso "no definida" de verdad y no "definida como vacio".
 *
 * `DATABASE_URL` es un dummy: `pool.js` solo exige que exista y que no traiga
 * `sslmode`. Como `pg.Pool` esta mockeado no se abre ninguna conexion, asi que
 * este test no necesita base de datos.
 */
const probe = ({ nodeEnv, vercel, ca }) => {
  const raw = execFileSync('node', ['-e', PROBE, POOL_PATH], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      VERCEL: vercel,
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      SUPABASE_CA_CERT: ca,
    },
  });
  const parsed = JSON.parse(raw.toString());
  return { ...parsed, ca: parsed.caB64 === null ? undefined : Buffer.from(parsed.caB64, 'base64').toString('utf8') };
};

const LOCAL = { nodeEnv: 'development', vercel: undefined };
const VERCEL_PROD = { nodeEnv: 'production', vercel: '1' };

describe('SUPABASE_CA_CERT - round-trip del PEM', () => {
  test('un PEM con newlines reales (dotenv, local) se usa tal cual', () => {
    const r = probe({ ...LOCAL, ca: PEM_REAL });

    assert.equal(r.threw, false, `no debe lanzar: ${r.message}`);
    assert.equal(r.ca, PEM_REAL, 'la CA debe llegar sin ninguna modificacion');
    assert.equal(countOf(r.ca, '\n'), 4, 'debe seguir con 4 newlines reales (5 lineas)');
    assert.equal(countOf(r.ca, '\\n'), 0, 'no debe aparecer ningun barra-n literal');
    assert.equal(r.rejectUnauthorized, true, 'con CA presente se verifica la cadena');
  });

  test('un PEM con \\n literales (Vercel / .env.example) queda con newlines reales', () => {
    // Control sobre el ENTRADA: el fixture tiene que ser de verdad la forma de
    // Vercel, o este test probaria una forma que nadie tiene.
    assert.equal(countOf(PEM_LITERAL, '\n'), 0, 'control: la entrada es una sola linea, sin newlines reales');
    assert.equal(countOf(PEM_LITERAL, '\\n'), 4, 'control: la entrada trae 4 barra-n literales');

    const r = probe({ ...VERCEL_PROD, ca: PEM_LITERAL });

    assert.equal(r.threw, false, `no debe lanzar: ${r.message}`);
    assert.equal(
      countOf(r.ca, '\\n'),
      0,
      'los "\\n" literales deben quedar convertidos en newlines reales',
    );
    assert.equal(countOf(r.ca, '\n'), 4, 'debe quedar con 4 newlines reales (5 lineas)');
  });

  test('la forma de Vercel conserva el cuerpo base64 intacto', () => {
    const r = probe({ ...VERCEL_PROD, ca: PEM_LITERAL });

    const lineas = r.ca.split('\n');
    assert.deepStrictEqual(
      lineas,
      ['-----BEGIN CERTIFICATE-----', ...CERT_BODY, '-----END CERTIFICATE-----'],
      'cada linea del cuerpo base64 tiene que sobrevivir la normalizacion tal cual',
    );
    assert.equal(r.rejectUnauthorized, true, 'con CA presente se verifica la cadena');
  });

  /**
   * EL ASSERTION CLAVE.
   *
   * Las dos vias de carga (dotenv en local, `process.env` crudo en Vercel)
   * tienen que converger EXACTAMENTE. Si difieren aunque sea en un caracter, el
   * deploy se rompe por como se copio una variable, que es el bug original.
   */
  test('local y Vercel producen el MISMO string de CA, byte a byte', () => {
    const local = probe({ ...LOCAL, ca: PEM_REAL });
    const vercel = probe({ ...VERCEL_PROD, ca: PEM_LITERAL });

    assert.equal(local.threw, false, `local no debe lanzar: ${local.message}`);
    assert.equal(vercel.threw, false, `vercel no debe lanzar: ${vercel.message}`);

    assert.equal(vercel.ca, local.ca, 'las dos vias de carga tienen que converger byte a byte');
    assert.equal(
      Buffer.from(vercel.ca, 'utf8').equals(Buffer.from(local.ca, 'utf8')),
      true,
      'comparacion byte a byte: no alcanza con que "se vean iguales"',
    );
    assert.equal(vercel.ca, PEM_REAL, 'ambas vias tienen que dar el PEM canonico');
  });

  test('un .env de Vercel con espacios alrededor tambien se normaliza', () => {
    // La gente pega con newline o espacio final; `.trim()` lo tiene que absorber.
    const r = probe({ ...VERCEL_PROD, ca: `  ${PEM_LITERAL}\n  ` });

    assert.equal(r.threw, false, `no debe lanzar: ${r.message}`);
    assert.equal(r.ca, PEM_REAL, 'el trim no puede cambiar el contenido del PEM');
  });
});

describe('SUPABASE_CA_CERT - validacion', () => {
  test('un valor basura sin marcadores lanza un error que menciona el PEM y sus marcadores', () => {
    const r = probe({ ...VERCEL_PROD, ca: 'no soy un certificado, soy un string cualquiera' });

    assert.equal(r.threw, true, 'una CA basura tiene que fallar el arranque');
    assert.match(r.message, /PEM/, 'el error tiene que nombrar el formato esperado');
    // El mensaje no dice la palabra "CERTIFICATE": dice "faltan los marcadores
    // BEGIN/END", que es MAS preciso que "no parece un certificado" porque
    // nombra el token exacto que hay que buscar en el valor.
    assert.match(r.message, /BEGIN/, 'el error tiene que nombrar el marcador BEGIN');
    assert.match(r.message, /END/, 'el error tiene que nombrar el marcador END');
  });

  test('el error de CA invalida es accionable, no un fallo opaco de TLS', () => {
    const r = probe({ ...VERCEL_PROD, ca: 'basura' });

    assert.equal(
      r.constructed,
      false,
      'tiene que morir ANTES de construir el Pool: si construye y falla al conectar, el error es opaco',
    );
    assert.doesNotMatch(
      r.message,
      /self[- ]signed|unable to verify|first certificate|ECONNREFUSED|ETIMEDOUT|CERT_HAS_EXPIRED/i,
      'no puede ser el error de TLS que aparecia en el primer query: ese no dice nada de la CA',
    );
    assert.match(r.message, /SUPABASE_CA_CERT/, 'tiene que nombrar la variable a corregir');
  });

  test('BEGIN sin END tambien se rechaza (faltan los dos marcadores)', () => {
    const r = probe({ ...VERCEL_PROD, ca: '-----BEGIN CERTIFICATE-----\n' + CERT_BODY.join('\n') });

    assert.equal(r.threw, true, 'un PEM truncado tiene que rechazarse');
    assert.match(r.message, /PEM/);
  });

  test('una CA valida NO es rechazada por la validacion', () => {
    // Control: si la validacion fuera demasiado estricta, esto seria un falso
    // negativo molesto en produccion.
    const r = probe({ ...VERCEL_PROD, ca: PEM_LITERAL });

    assert.equal(r.threw, false, `una CA valida no puede fallar: ${r.message}`);
    assert.equal(r.constructed, true, 'tiene que llegar a construir el Pool');
  });
});

describe('SUPABASE_CA_CERT - ausente', () => {
  test('undefined en desarrollo no lanza (deja connecting sin verificar)', () => {
    const r = probe({ ...LOCAL, ca: undefined });

    assert.equal(r.threw, false, `en dev la CA ausente no debe romper el flujo: ${r.message}`);
    assert.equal(r.ca, undefined, 'no hay CA que pasarle a pg');
    assert.equal(r.rejectUnauthorized, false, 'en dev se permite sin verificar');
  });

  test('string vacio en desarrollo tampoco lanza', () => {
    const r = probe({ ...LOCAL, ca: '' });

    assert.equal(r.threw, false, `un string vacio es el mismo caso que ausente: ${r.message}`);
    assert.equal(r.ca, undefined, 'un valor vacio tiene que cair en el camino de ausente');
    assert.equal(r.rejectUnauthorized, false, 'en dev se permite sin verificar');
  });

  test('undefined cae en el branch de isProd: en produccion si lanza', () => {
    // Esto prueba que el caso ausente REALMENTE llega al `else if (isProd)` y no
    // que se descarta en el medio. Sin este test, "no lanza en dev" tambien
    // pasaria con un `return` temprano que se comiera el chequeo de produccion.
    const r = probe({ ...VERCEL_PROD, ca: undefined });

    assert.equal(r.threw, true, 'en produccion sin CA tiene que fallar el arranque');
    assert.match(r.message, /SUPABASE_CA_CERT/, 'el error tiene que nombrar la variable');
    assert.match(r.message, /produccion/i, 'el error tiene que decir que es por estar en produccion');
  });
});
