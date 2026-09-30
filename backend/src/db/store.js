const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const empty = () => ({
  users: [],
  categories: [],
  products: [],
  services: [],
  orders: [],
  order_items: [],
  contact_messages: [],
  settings: {},
  password_resets: [],
  seq: { users: 1, categories: 1, products: 1, services: 1, orders: 1, order_items: 1, contact_messages: 1, password_resets: 1 },
});

function load() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (_) {}
  return empty();
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

let db = load();

function next(table) {
  const id = db.seq[table] || 1;
  db.seq[table] = id + 1;
  return id;
}

function persist() {
  save(db);
}

module.exports = {
  get: () => db,
  next,
  persist,
  reload: () => { db = load(); },
  reset: () => { db = empty(); persist(); },
};
