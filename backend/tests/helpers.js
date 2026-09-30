/**
 * Helpers compartidos por los tests del backend.
 *
 * IMPORTANTE: los tests corren contra el store real (src/db/store.js), que
 * escribe en src/db/data.json. Para no pisar los datos de desarrollo, este
 * modulo hace backup antes de la suite y restaura despues.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const BACKEND_ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(BACKEND_ROOT, 'src', 'db', 'data.json');

let backupPath = null;

/** Guarda una copia del data.json actual. Llamar en `before`. */
function backupData() {
  if (fs.existsSync(DATA_PATH)) {
    backupPath = path.join(os.tmpdir(), `compushop-data-${process.pid}-${Date.now()}.json`);
    fs.copyFileSync(DATA_PATH, backupPath);
  }
}

/** Restaura el data.json original. Llamar en `after`. */
function restoreData() {
  if (backupPath && fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, DATA_PATH);
    fs.unlinkSync(backupPath);
    backupPath = null;
  }
}

/**
 * Levanta la app real en un puerto efimero y devuelve una API de fetch.
 * No toca process.env.PORT del shell.
 */
async function startTestServer() {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';

  // La app hace listen() al require salvo que VERCel este seteado.
  // Requerimos con VERCEL seteado => exporta la app sin escuchar,
  // y nosotros la montamos nosotros mismos en un puerto libre.
  process.env.VERCEL = '1';
  const app = require(path.join(BACKEND_ROOT, 'src', 'index.js'));
  delete process.env.VERCEL;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const base = `http://127.0.0.1:${server.address().port}/api`;
  const port = server.address().port;

  const request = async (method, url, { body, token } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  };

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    get: (url, opts) => request('GET', url, opts),
    post: (url, body, opts) => request('POST', url, { ...opts, body }),
    put: (url, body, opts) => request('PUT', url, { ...opts, body }),
    delete: (url, opts) => request('DELETE', url, opts),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Crea un producto de prueba directamente en el store y devuelve su id. */
function createTestProduct({ name, price, stock = 50, is_active = true } = {}) {
  const store = require(path.join(BACKEND_ROOT, 'src', 'db', 'store.js'));
  const db = store.get();
  const id = store.next('products');
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  db.products.push({
    id,
    name,
    slug,
    description: 'Producto de test',
    price,
    stock,
    category_id: null,
    brand: 'TestBrand',
    image: null,
    specs: null,
    is_active,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  store.persist();
  return { id, name, slug, price, stock };
}

/** Crea un usuario de test con password hasheada. */
function createTestUser({ name, email, password, dni, role = 'customer' } = {}) {
  const bcrypt = require(path.join(BACKEND_ROOT, 'node_modules', 'bcryptjs'));
  const store = require(path.join(BACKEND_ROOT, 'src', 'db', 'store.js'));
  const db = store.get();
  const id = store.next('users');
  db.users.push({
    id,
    name,
    email,
    password: bcrypt.hashSync(password, 10),
    dni: dni || null,
    role,
    phone: null,
    address: null,
    created_at: new Date().toISOString(),
  });
  store.persist();
  return { id, email, password, role };
}

const CUSTOMER = { name: 'Cliente Test', email: 'cliente@test.com', password: 'test123', dni: '11111111' };

module.exports = { BACKEND_ROOT, DATA_PATH, backupData, restoreData, startTestServer, createTestProduct, createTestUser, CUSTOMER };
