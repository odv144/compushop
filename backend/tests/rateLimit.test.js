/**
 * Rate limiting de los endpoints publicos.
 *
 * Contexto: `bcrypt.compareSync` bloquea el event loop. Sin limites, unos
 * cuantos logins simultaneos cuelgan el server para todos los usuarios, y
 * ademas se pueden probar miles de passwords o enumerar DNIs.
 *
 * Estos tests usan `skip: () => false` para anular el bypass de NODE_ENV=test
 * y verificar el limitador de verdad.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createLimiter } = require('../src/config/rateLimit');

/**
 * Monta una app minima con el limitador dado y la devuelve escuchando.
 * Se cierra sola al terminar cada test: si el limitador tira al construirse,
 * el server queda huerfano y el proceso de node:test no termina nunca.
 */
function appWith(limiter) {
  const app = express();
  // Sin esto req.ip es siempre 127.0.0.1 y las IPs simuladas en X-Forwarded-For
  // se ignoran: todas las requests caerian en la misma clave del limitador.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/x', limiter, (req, res) => res.json({ ok: true }));
  app.get('/x', limiter, (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    post: (ip) => fetch(`${base}/x`, { method: 'POST', headers: { 'X-Forwarded-For': ip }, body: '{}' }),
    get: (ip) => fetch(`${base}/x`, { headers: { 'X-Forwarded-For': ip } }),
    // closeAllConnections es necesario: fetch de node mantiene keep-alive y
    // server.close() solo esperaria por esas conexiones para siempre.
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

const always = () => false;

/** Crea la app, corre el test, y siempre cierra el server. */
async function withApi(limiter, fn) {
  const api = appWith(limiter);
  try {
    await fn(api);
  } finally {
    await api.close();
  }
}

describe('createLimiter - comportamiento basico', () => {
  test('bloquea al superar el maximo', async () => {
    await withApi(createLimiter({ name: 't', windowMs: 60_000, max: 3, skip: always }), async (api) => {
      for (let i = 0; i < 3; i++) {
        const r = await api.post('1.1.1.1');
        assert.equal(r.status, 200, `intento ${i + 1} deberia pasar`);
      }
      const blocked = await api.post('1.1.1.1');
      assert.equal(blocked.status, 429, 'el cuarto intento debe rebotar');
    });
  });

  test('el limite es por IP: otra IP no se ve afectada', async () => {
    await withApi(createLimiter({ name: 't', windowMs: 60_000, max: 2, skip: always }), async (api) => {
      await api.post('1.1.1.1');
      await api.post('1.1.1.1');
      assert.equal((await api.post('1.1.1.1')).status, 429, 'primera IP agotada');

      const other = await api.post('2.2.2.2');
      assert.equal(other.status, 200, 'la segunda IP debe poder pasar');
    });
  });

  test('el mensaje de error va en español y es generico', async () => {
    await withApi(createLimiter({ name: 't', windowMs: 60_000, max: 1, skip: always }), async (api) => {
      await api.post('1.1.1.1');
      const r = await api.post('1.1.1.1');
      const body = await r.json();

      assert.equal(r.status, 429);
      assert.ok(body.error, 'debe traer un mensaje');
      assert.ok(
        !/password|contrasena|credencial|incorrect/i.test(body.error),
        'no debe revelar si el login fue correcto'
      );
    });
  });

  test('envia la cabecera RateLimit', async () => {
    await withApi(createLimiter({ name: 't', windowMs: 60_000, max: 5, skip: always }), async (api) => {
      const r = await api.get('1.1.1.1');
      const hasHeader = r.headers.get('ratelimit') || r.headers.get('ratelimit-limit');
      assert.ok(hasHeader, 'debe anunciar el limite al cliente');
    });
  });

  test('la ventana se renueva: tras expirar vuelve a pasar', async () => {
    // Ventana amplia a proposito: con 150ms, una request lenta bajo carga
    // reiniciaba el contador y este test fallaba de forma intermitente.
    const WINDOW = 800;
    await withApi(createLimiter({ name: 't', windowMs: WINDOW, max: 1, skip: always }), async (api) => {
      assert.equal((await api.post('1.1.1.1')).status, 200);
      assert.equal((await api.post('1.1.1.1')).status, 429);

      await new Promise((r) => setTimeout(r, WINDOW + 300));
      assert.equal((await api.post('1.1.1.1')).status, 200, 'la ventana debio expirar');
    });
  });
});

describe('createLimiter - skipSuccessfulRequests', () => {
  test('con skip, los exitos no cuentan', async () => {
    await withApi(
      createLimiter({ name: 't', windowMs: 60_000, max: 2, skipSuccessfulRequests: true, skip: always }),
      async (api) => {
        // Estos devuelven 200: nunca deberian sumar al contador.
        for (let i = 0; i < 10; i++) {
          const r = await api.post('1.1.1.1');
          assert.equal(r.status, 200, 'un request exitoso no debe ser penalizado');
        }
      }
    );
  });

  test('sin skip, todo cuenta', async () => {
    await withApi(createLimiter({ name: 't', windowMs: 60_000, max: 3, skip: always }), async (api) => {
      // `max` es la cantidad PERMITIDA: con max 3 pasan 3 y rebota la 4ta.
      for (let i = 0; i < 3; i++) {
        assert.equal((await api.post('1.1.1.1')).status, 200, `intento ${i + 1} permitido`);
      }
      assert.equal((await api.post('1.1.1.1')).status, 429, 'la cuarta debe rebotar');
    });
  });
});

describe('Limites configurados por endpoint', () => {
  const { LIMITS } = require('../src/config/rateLimit');

  test('todo endpoint publico sensible tiene un limite', () => {
    for (const name of ['auth', 'register', 'forgot-password', 'reset-password', 'contact', 'orders', 'api-global']) {
      assert.ok(LIMITS[name], `falta el limite para ${name}`);
      assert.ok(LIMITS[name].max > 0, `${name} necesita un max > 0`);
      assert.ok(LIMITS[name].windowMs > 0, `${name} necesita una ventana > 0`);
    }
  });

  test('los vectores de abuso tienen el limite mas estricto', () => {
    // Enumeracion de DNIs (forgot-password) y spam de la bandeja (contact) son
    // los dos ataques baratos: pocos intentos, mucho dano.
    assert.ok(LIMITS.contact.max <= 5, 'contact debe ser estricto');
    assert.ok(LIMITS['forgot-password'].max <= 5, 'forgot-password debe ser estricto');
    assert.ok(LIMITS.register.max <= 5, 'registro debe frenar masiva de cuentas');
  });

  test('los limites de abuso quedan por debajo del global', () => {
    // Si el global fuera mas estricto, un attacker podria agotar el global
    // en lugar del endpoint especifico.
    for (const name of ['auth', 'register', 'forgot-password', 'contact', 'orders']) {
      assert.ok(LIMITS[name].max < LIMITS['api-global'].max, `${name} debe ser mas estricto que api-global`);
    }
  });

  test('auth cuenta solo intentos fallidos', () => {
    assert.equal(LIMITS.auth.skipSuccessfulRequests, true);
  });

  test('los endpoints que mutan datos no usan skipSuccessfulRequests', () => {
    // Si un POST exitoso no contara, el atacante podria mandar pedidos/
    // contactos validos ilimitadamente sin sumar al contador.
    for (const name of ['contact', 'orders', 'register', 'forgot-password', 'reset-password']) {
      assert.ok(!LIMITS[name].skipSuccessfulRequests, `${name} debe contar TODOS los requests`);
    }
  });

  test('ningun limite es tan alto que sirva de adorno', () => {
    for (const [name, spec] of Object.entries(LIMITS)) {
      assert.ok(spec.max <= 600, `${name} con max ${spec.max} es tan alto que no protege`);
    }
  });
});
