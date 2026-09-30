const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const defaultData = {
  users: [],
  categories: [],
  products: [],
  services: [],
  orders: [],
  order_items: [],
  contact_messages: [],
  settings: [],
  password_resets: [],
  _meta: { nextId: { users: 1, categories: 1, products: 1, services: 1, orders: 1, order_items: 1, contact_messages: 1, password_resets: 1 } }
};

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('Error leyendo DB, usando defaults');
  }
  return structuredClone(defaultData);
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

let data = load();

function nextId(table) {
  const id = data._meta.nextId[table] || 1;
  data._meta.nextId[table] = id + 1;
  return id;
}

// API simple tipo better-sqlite3 para no reescribir todos los controllers
const db = {
  prepare(sql) {
    // Parser muy básico para las queries que usamos
    return {
      run(...params) {
        return db._run(sql, params);
      },
      get(...params) {
        return db._get(sql, params);
      },
      all(...params) {
        return db._all(sql, params);
      },
    };
  },

  exec(sql) {
    // No-op para CREATE TABLE (ya usamos JSON)
  },

  pragma() {},

  transaction(fn) {
    return () => {
      const backup = structuredClone(data);
      try {
        const result = fn();
        save(data);
        return result;
      } catch (e) {
        data = backup;
        throw e;
      }
    };
  },

  _run(sql, params) {
    const s = sql.trim().toUpperCase();

    if (s.startsWith('INSERT INTO USERS')) {
      const [name, email, password, dni, phone, address, role] = params.length === 7
        ? params
        : [params[0], params[1], params[2], params[3], params[4], params[5], 'customer'];
      const id = nextId('users');
      const user = {
        id, name, email, password, dni: dni || null, role: role || 'customer',
        phone: phone || null, address: address || null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      data.users.push(user);
      save(data);
      return { lastInsertRowid: id, changes: 1 };
    }

    if (s.startsWith('INSERT INTO CATEGORIES')) {
      const [name, slug, description, image] = params;
      const id = nextId('categories');
      data.categories.push({ id, name, slug, description: description || null, image: image || null, created_at: new Date().toISOString() });
      save(data);
      return { lastInsertRowid: id, changes: 1 };
    }

    if (s.startsWith('INSERT INTO PRODUCTS')) {
      // Soporta tanto positional como named (simplificado)
      let p;
      if (typeof params[0] === 'object') {
        p = params[0];
      } else {
        p = {
          name: params[0], slug: params[1], description: params[2], price: params[3],
          stock: params[4], category_id: params[5], brand: params[6], image: params[7],
          specs: params[8], is_active: params[9] !== undefined ? params[9] : 1,
        };
      }
      const id = nextId('products');
      data.products.push({
        id, ...p, is_active: p.is_active ? 1 : 0,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      save(data);
      return { lastInsertRowid: id, changes: 1 };
    }

    if (s.startsWith('INSERT INTO SERVICES')) {
      const [name, slug, description, price, duration, image, is_active] = params;
      const id = nextId('services');
      data.services.push({
        id, name, slug, description, price, duration, image,
        is_active: is_active !== undefined ? (is_active ? 1 : 0) : 1,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      save(data);
      return { lastInsertRowid: id, changes: 1 };
    }

    if (s.startsWith('INSERT INTO ORDERS')) {
      const [user_id, order_number, status, total, shipping_address, notes, customer_name, customer_email, customer_phone] = params;
      const id = nextId('orders');
      data.orders.push({
        id, user_id, order_number, status: status || 'confirmed', total,
        shipping_address, notes, customer_name, customer_email, customer_phone,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      save(data);
      return { lastInsertRowid: id, changes: 1 };
    }

    if (s.startsWith('INSERT INTO ORDER_ITEMS')) {
      const [order_id, product_id, service_id, name, price, quantity, type] = params;
      const id = nextId('order_items');
      data.order_items.push({ id, order_id, product_id, service_id, name, price, quantity, type });
      save(data);
      return { lastInsertRowid: id, changes: 1 };
    }

    if (s.startsWith('INSERT INTO CONTACT_MESSAGES')) {
      const [name, email, phone, subject, message] = params;
      const id = nextId('contact_messages');
      data.contact_messages.push({
        id, name, email, phone, subject, message, is_read: 0,
        created_at: new Date().toISOString(),
      });
      save(data);
      return { lastInsertRowid: id, changes: 1 };
    }

    if (s.startsWith('INSERT INTO SETTINGS') || s.includes('ON CONFLICT')) {
      const [key, value] = params;
      const existing = data.settings.find(s => s.key === key);
      if (existing) {
        existing.value = value;
        existing.updated_at = new Date().toISOString();
      } else {
        data.settings.push({ key, value, updated_at: new Date().toISOString() });
      }
      save(data);
      return { changes: 1 };
    }

    if (s.startsWith('INSERT INTO PASSWORD_RESETS')) {
      const [user_id, token, expires_at] = params;
      const id = nextId('password_resets');
      data.password_resets.push({ id, user_id, token, expires_at, used: 0, created_at: new Date().toISOString() });
      save(data);
      return { lastInsertRowid: id, changes: 1 };
    }

    if (s.startsWith('UPDATE')) {
      return db._update(sql, params);
    }

    if (s.startsWith('DELETE')) {
      return db._delete(sql, params);
    }

    console.warn('Unhandled RUN SQL:', sql.substring(0, 80));
    return { changes: 0 };
  },

  _update(sql, params) {
    const s = sql.toUpperCase();

    if (s.includes('USERS SET PASSWORD')) {
      const [password, id] = params;
      const u = data.users.find(x => x.id === id);
      if (u) { u.password = password; u.updated_at = new Date().toISOString(); save(data); return { changes: 1 }; }
      return { changes: 0 };
    }

    if (s.includes('USERS SET') && s.includes('NAME=?')) {
      // full update
      if (params.length === 8) {
        const [name, email, dni, role, phone, address, password, id] = params;
        const u = data.users.find(x => x.id === id);
        if (u) {
          Object.assign(u, { name, email, dni, role, phone, address, password, updated_at: new Date().toISOString() });
          save(data); return { changes: 1 };
        }
      } else {
        const [name, email, dni, role, phone, address, id] = params;
        const u = data.users.find(x => x.id === id);
        if (u) {
          Object.assign(u, { name, email, dni, role, phone, address, updated_at: new Date().toISOString() });
          save(data); return { changes: 1 };
        }
      }
      return { changes: 0 };
    }

    if (s.includes('PRODUCTS SET')) {
      const id = params[params.length - 1];
      const p = data.products.find(x => x.id == id);
      if (!p) return { changes: 0 };
      // order: name, slug, description, price, stock, category_id, brand, image, specs, is_active, id
      p.name = params[0]; p.slug = params[1]; p.description = params[2]; p.price = params[3];
      p.stock = params[4]; p.category_id = params[5]; p.brand = params[6]; p.image = params[7];
      p.specs = params[8]; p.is_active = params[9]; p.updated_at = new Date().toISOString();
      save(data); return { changes: 1 };
    }

    if (s.includes('SERVICES SET')) {
      const id = params[params.length - 1];
      const p = data.services.find(x => x.id == id);
      if (!p) return { changes: 0 };
      p.name = params[0]; p.slug = params[1]; p.description = params[2]; p.price = params[3];
      p.duration = params[4]; p.image = params[5]; p.is_active = params[6];
      p.updated_at = new Date().toISOString();
      save(data); return { changes: 1 };
    }

    if (s.includes('ORDERS SET STATUS')) {
      const [status, id] = params;
      const o = data.orders.find(x => x.id == id);
      if (o) { o.status = status; o.updated_at = new Date().toISOString(); save(data); return { changes: 1 }; }
      return { changes: 0 };
    }

    if (s.includes('PRODUCTS SET STOCK')) {
      const [qty, id, minStock] = params;
      const p = data.products.find(x => x.id == id);
      if (p && p.stock >= minStock) {
        p.stock -= qty;
        save(data);
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (s.includes('CONTACT_MESSAGES SET IS_READ')) {
      const [id] = params;
      const m = data.contact_messages.find(x => x.id == id);
      if (m) { m.is_read = 1; save(data); return { changes: 1 }; }
      return { changes: 0 };
    }

    if (s.includes('PASSWORD_RESETS SET USED')) {
      if (params.length === 1) {
        // by id
        const r = data.password_resets.find(x => x.id == params[0]);
        if (r) { r.used = 1; save(data); return { changes: 1 }; }
      } else {
        // by user_id
        data.password_resets.forEach(r => {
          if (r.user_id == params[0] && r.used === 0) r.used = 1;
        });
        save(data);
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (s.includes('CATEGORIES SET')) {
      const [name, description, image, id] = params;
      const c = data.categories.find(x => x.id == id);
      if (c) {
        c.name = name; c.description = description; c.image = image;
        save(data); return { changes: 1 };
      }
      return { changes: 0 };
    }

    console.warn('Unhandled UPDATE:', sql.substring(0, 80));
    return { changes: 0 };
  },

  _delete(sql, params) {
    const s = sql.toUpperCase();
    const id = params[0];

    if (s.includes('FROM PRODUCTS')) {
      const before = data.products.length;
      data.products = data.products.filter(x => x.id != id);
      save(data);
      return { changes: before - data.products.length };
    }
    if (s.includes('FROM SERVICES')) {
      const before = data.services.length;
      data.services = data.services.filter(x => x.id != id);
      save(data);
      return { changes: before - data.services.length };
    }
    if (s.includes('FROM USERS')) {
      const before = data.users.length;
      data.users = data.users.filter(x => x.id != id);
      save(data);
      return { changes: before - data.users.length };
    }
    if (s.includes('FROM CATEGORIES')) {
      const before = data.categories.length;
      data.categories = data.categories.filter(x => x.id != id);
      save(data);
      return { changes: before - data.categories.length };
    }
    // bulk deletes for seed
    if (s.includes('FROM ORDER_ITEMS')) { data.order_items = []; save(data); return { changes: 1 }; }
    if (s.includes('FROM ORDERS')) { data.orders = []; save(data); return { changes: 1 }; }
    if (s.includes('FROM PASSWORD_RESETS')) { data.password_resets = []; save(data); return { changes: 1 }; }
    if (s.includes('FROM CONTACT_MESSAGES')) { data.contact_messages = []; save(data); return { changes: 1 }; }
    if (s.includes('FROM PRODUCTS')) { data.products = []; save(data); return { changes: 1 }; }
    if (s.includes('FROM SERVICES')) { data.services = []; save(data); return { changes: 1 }; }
    if (s.includes('FROM CATEGORIES')) { data.categories = []; save(data); return { changes: 1 }; }
    if (s.includes('FROM USERS')) { data.users = []; save(data); return { changes: 1 }; }
    if (s.includes('FROM SETTINGS')) { data.settings = []; save(data); return { changes: 1 }; }

    return { changes: 0 };
  },

  _get(sql, params) {
    const s = sql.toUpperCase();

    // Users
    if (s.includes('FROM USERS WHERE EMAIL')) {
      return data.users.find(u => u.email === params[0]) || null;
    }
    if (s.includes('FROM USERS WHERE DNI')) {
      return data.users.find(u => u.dni === params[0]) || null;
    }
    if (s.includes('FROM USERS WHERE ID')) {
      const u = data.users.find(u => u.id == params[0]);
      if (!u) return null;
      if (s.includes('SELECT ID, NAME, EMAIL, ROLE')) {
        const { password, ...safe } = u;
        return safe;
      }
      return u;
    }

    // Products
    if (s.includes('FROM PRODUCTS') && s.includes('WHERE P.ID') || (s.includes('FROM PRODUCTS P') && s.includes('WHERE P.ID'))) {
      const p = data.products.find(x => x.id == params[0]);
      if (!p) return null;
      const cat = data.categories.find(c => c.id === p.category_id);
      return { ...p, category_name: cat?.name, category_slug: cat?.slug };
    }
    if (s.includes('FROM PRODUCTS') && (s.includes('WHERE P.SLUG') || s.includes('WHERE SLUG'))) {
      const p = data.products.find(x => x.slug === params[0]);
      if (!p) return null;
      const cat = data.categories.find(c => c.id === p.category_id);
      return { ...p, category_name: cat?.name, category_slug: cat?.slug };
    }
    if (s.includes('FROM PRODUCTS WHERE ID')) {
      return data.products.find(x => x.id == params[0]) || null;
    }
    if (s.includes('FROM PRODUCTS WHERE SLUG')) {
      return data.products.find(x => x.slug === params[0]) || null;
    }

    // Services
    if (s.includes('FROM SERVICES WHERE ID') || s.includes('FROM SERVICES WHERE SLUG')) {
      const key = isNaN(params[0]) ? 'slug' : 'id';
      return data.services.find(x => x[key] == params[0]) || null;
    }

    // Orders
    if (s.includes('FROM ORDERS WHERE ID')) {
      return data.orders.find(x => x.id == params[0]) || null;
    }

    // Password resets
    if (s.includes('FROM PASSWORD_RESETS')) {
      return data.password_resets.find(r =>
        r.token === params[0] && r.used === 0 && new Date(r.expires_at) > new Date()
      ) || null;
    }

    // Settings
    if (s.includes('FROM SETTINGS WHERE KEY')) {
      const row = data.settings.find(s => s.key === params[0]);
      return row ? { value: row.value } : null;
    }

    // COUNT queries
    if (s.includes('COUNT(*)')) {
      return db._count(sql, params);
    }

    console.warn('Unhandled GET:', sql.substring(0, 100));
    return null;
  },

  _all(sql, params) {
    const s = sql.toUpperCase();

    if (s.includes('FROM PRODUCTS')) {
      let list = [...data.products];
      // filtros básicos
      if (s.includes('IS_ACTIVE = 1') || (!s.includes('ACTIVE = \'ALL\'') && !params.includes('all'))) {
        // default active only handled in controller mostly
      }
      // join category
      list = list.map(p => {
        const cat = data.categories.find(c => c.id === p.category_id);
        return { ...p, category_name: cat?.name, category_slug: cat?.slug };
      });
      return list;
    }

    if (s.includes('FROM SERVICES')) {
      return [...data.services];
    }

    if (s.includes('FROM CATEGORIES')) {
      return data.categories.map(c => ({
        ...c,
        product_count: data.products.filter(p => p.category_id === c.id && p.is_active).length,
      }));
    }

    if (s.includes('FROM ORDERS')) {
      return [...data.orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    if (s.includes('FROM ORDER_ITEMS')) {
      return data.order_items.filter(i => i.order_id == params[0]);
    }

    if (s.includes('FROM USERS')) {
      return data.users.map(({ password, ...u }) => u);
    }

    if (s.includes('FROM CONTACT_MESSAGES')) {
      return [...data.contact_messages].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    if (s.includes('FROM SETTINGS')) {
      return data.settings;
    }

    console.warn('Unhandled ALL:', sql.substring(0, 100));
    return [];
  },

  _count(sql, params) {
    // Simplified counts used by controllers
    if (sql.toUpperCase().includes('FROM PRODUCTS')) {
      return { total: data.products.length, c: data.products.filter(p => p.is_active).length };
    }
    if (sql.toUpperCase().includes('FROM SERVICES')) {
      return { c: data.services.filter(s => s.is_active).length };
    }
    if (sql.toUpperCase().includes('FROM USERS')) {
      return { c: data.users.filter(u => u.role === 'customer').length, total: data.users.length };
    }
    if (sql.toUpperCase().includes('FROM ORDERS')) {
      return { c: data.orders.length, total: data.orders.length };
    }
    if (sql.toUpperCase().includes('FROM CONTACT_MESSAGES')) {
      return { c: data.contact_messages.filter(m => !m.is_read).length, total: data.contact_messages.length };
    }
    return { total: 0, c: 0 };
  },
};

// Expose raw data for seed & complex queries
db._data = () => data;
db._save = () => save(data);
db._reload = () => { data = load(); };

module.exports = db;
