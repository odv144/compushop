const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const repo = require('../data/repo');
const { generateToken } = require('../utils/jwt');
const { authenticate, requireAdmin, optionalAuth } = require('../middleware/auth');
const { sendContactEmail, sendPasswordResetEmail } = require('../utils/email');
const authCtrl = require('../controllers/authController');
const rateLimit = require('../config/rateLimit');

// ========== AUTH ==========
// bcrypt bloquea el event loop: sin estos limites, unos cuantos logins
// simultaneos dejan el server colgado para todos los usuarios.
router.post('/auth/register', rateLimit.registerLimiter(), authCtrl.register);
router.post('/auth/login', rateLimit.authLimiter(), authCtrl.login);
router.get('/auth/me', authenticate, authCtrl.me);
router.post('/auth/forgot-password', rateLimit.forgotPasswordLimiter(), authCtrl.forgotPassword);
router.post('/auth/reset-password', rateLimit.resetPasswordLimiter(), authCtrl.resetPassword);

function slugify(t) {
  return t.toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-');
}

const PRECIO_INVALIDO = 'Precio inválido: debe ser un número mayor o igual a 0';

/**
 * SEGUNDO MENSAJE, Y POR QUE HACE FALTA.
 *
 * `numeric(14,2)` REDONDEA. Un `45.555` no se guarda: se guarda `45.56`, en
 * silencio, y el admin que lo cargo cree que esta cobrando 45,555. Con el store
 * JSON el numero quedaba tal cual en el archivo, asi que el redondeo no
 * existia y ningun cliente podia depender de el.
 *
 * La alternativa a un 400 —dejarlo y avisar— es peor: el rounding del servidor
 * es invisible en la respuesta, asi que el 200 confirmaria un precio que la
 * base no tiene. Rechazar antes de escribir es lo unico que hace que el 400
 * signifique algo.
 */
const PRECIO_DECIMALES =
  'Precio inválido: se aceptan hasta 2 decimales. Un precio con más decimales se guardaría redondeado y dejaría de ser el que mandaste.';

/**
 * Cuantos decimales tiene REALMENTE un `number`, no cuantos creo que tiene.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NO `String(value).split('.')[1]`
 * ---------------------------------------------------------------------------
 * La representacion IEEE-754 de `45.55` es 45.5499999999999971578290569595992565155029296875. Si se
 * contaran decimales sobre ESO, el precio entero de la tienda caeria en un 400
 * y nadie sabria por que. Y al reves: un `0.1 + 0.2` de JavaScript da
 * 0.30000000000000004, que tiene "8 decimales" y tambien seria rechazado.
 *
 * `String(num)` no devuelve la expansion binaria: devuelve la forma DECIMAL MAS
 * CORTA que vuelve al mismo numero. O sea que `String(45.55)` es `"45.55"` y
 * `String(45.555)` es `"45.555"`. Contar sobre esa forma es exactamente
 * "cuantos decimales escribio el cliente", sin el ruido de la coma flotante.
 *
 * ---------------------------------------------------------------------------
 * LA NOTACION CIENTIFICA
 * ---------------------------------------------------------------------------
 * Los numeros muy chicos o muy grandes salen como `"1e-7"`, que no tiene punto
 * decimal y pareceria un entero. El exponente es la informacion: `1e-7` son 7
 * decimales, `1e-2` son 2. La cuenta es `decimalesDeLaMantisa - exponente`, y
 * el `max(0, ...)` cubre los exponentes positivos, donde el numero entero
 * (`1e2`) tiene 0 decimales.
 */
function decimalesDe(value) {
  const s = String(value);
  const e = s.search(/[eE]/);
  if (e === -1) {
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
  }
  const mantisa = s.slice(0, e);
  const exponente = Number(s.slice(e + 1));
  const enMantisa = (mantisa.split('.')[1] || '').length;
  return Math.max(0, enMantisa - exponente);
}

/**
 * Normaliza un precio que viene del body. Devuelve `{ value }` o `{ error }`.
 *
 * Number('') === 0 y Number(null) === 0, asi que sin el chequeo de tipo un campo
 * vacio guardaba el producto en $0 y un `{"price":"abc"}` entraba como NaN. Solo
 * se aceptan number o string: booleanos, arrays y objetos ("abc", true, []) no
 * son precios.
 *
 * El `undefined` NO es un error aca: quien llama lo distingue antes, porque
 * "el cliente no mando price" y "el cliente mando price malo" son dos cosas
 * distintas y dan dos respuestas distintas.
 */
function parsePrice(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return { error: PRECIO_INVALIDO };
  if (typeof raw === 'string' && raw.trim() === '') return { error: PRECIO_INVALIDO };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return { error: PRECIO_INVALIDO };
  if (decimalesDe(value) > 2) return { error: PRECIO_DECIMALES };
  return { value };
}

/**
 * El `id` de ruta, resuelto como lo resolvia el store.
 *
 * Las rutas de escritura buscan con `x.id == req.params.id`, comparacion FLOJA:
 * `1 == '1'`, `1 == '1.0'`, `1000 == '1e3'`, y `1 == '1.5'` es `false`.
 * `Number()` reproduce exactamente eso, porque el `==` con un numero del lado
 * izquierdo convierte el string con `Number()`.
 *
 * Lo que NO se pasa a la base es el caso no numerico: `Number('abc')` es `NaN`,
 * y un `where id = NaN` es un error de tipo de Postgres ("invalid input syntax
 * for type integer") que el cliente recibiria como 500. El store en ese caso
 * no encontraba la fila y devolvia 404, asi que un `NaN` que vaut 404.
 */
function idDeRuta(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Envuelve un handler `async` para que un rechazo no cuelgue el request.
 *
 * Express 4 no captura el rechazo de una promesa que devuelve un handler async:
 * el error se pierde y el cliente se queda esperando hasta que agota el timeout.
 * Con el store JSON los handlers eran sincronos y no habia forma de que pasara;
 * contra la base, un pool agotado, una conexion que se cae o una violacion de
 * FK son cosas que pasan solas.
 *
 * Y NO se delega al error handler global de `src/index.js` a proposito: ese
 * responde `{ error: err.message }`, y el mensaje de `pg` puede traer el texto
 * de la consulta y nombres de columnas. Un fallo de base es del servidor y se
 * loguea entero; al cliente le llega un mensaje propio de la ruta.
 */
const asyncRoute = (fn, mensaje) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`[${req.method} ${req.originalUrl}]`, e);
    if (res.headersSent) return;

    // -------------------------------------------------------------------------
    // LOS CODIGOS DE POSTGRES QUE SON FALLAS DEL CLIENTE, NO DEL SERVIDOR
    // -------------------------------------------------------------------------
    // El store JSON no tenia constraints, asi que varias cosas que hoy son un
    // error de base se guardaban en silencio: un `category_id` inexistente
    // dejaba el producto huerfano y la API respondia 201. Con la FK de Postgres
    // el mismo request es 23503, y un 500 para "el id que mandaste no existe" es
    // la respuesta equivocada: le dice al cliente que el problema es nuestro.
    //
    // Es una diferencia de comportamiento NECESARIA de la migracion (D-L), no
    // una mejora de diseno: sin esto, un formulario con una categoria vieja
    // devuelve 500 y el admin no puede guardar. Con esto devuelve 400 y el
    // front puede avisarle.
    if (e && e.code === '23503') {
      return res.status(400).json({ error: 'Referencia inválida: el id enviado no existe' });
    }
    // `not_null_violation`: un `null` en una columna obligatoria. Mismo caso que
    // arriba — un cliente mandando `{"name": null}` en vez de omitir la clave.
    if (e && e.code === '23502') {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    // `unique_violation`: hoy no hay ninguna constraint unica (el `users.email`
    // es un indice a proposito), pero si alguien agrega una, 409 es el codigo
    // que corresponde y no un 500. Dejarlo listo no cuesta nada.
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un registro con esos datos' });
    }

    res.status(500).json({ error: mensaje });
  });

// ========== CATEGORIES ==========
router.get('/categories', asyncRoute(async (req, res) => {
  res.json({ categories: await repo.categories.list() });
}, 'Error al listar las categorías'));

router.post('/categories', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { name, description, image } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre obligatorio' });
  const cat = await repo.categories.create({
    name,
    slug: slugify(name),
    description: description || null,
    image: image || null,
  });
  res.status(201).json({ message: 'Categoría creada', category: cat });
}, 'Error al crear la categoría'));

router.put('/categories/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const id = idDeRuta(req.params.id);
  const cat = await repo.categories.update(id, {
    // `?? undefined` y no el valor crudo: el store hacia
    // `req.body.name ?? cat.name`, o sea que un `name: null` explicito NO
    // borraba el nombre, lo dejaba como estaba. `updateFrom` saltea el
    // `undefined`; sin el `?? undefined` el null pasaria como "escribi null" y
    // la columna `not null` lo rechazaria con un 500 donde la API antes
    // respondia 200.
    name: req.body.name ?? undefined,
    description: req.body.description ?? undefined,
    image: req.body.image ?? undefined,
  });
  // `update` devuelve `null` si no habia fila. El 404 sale de ahi y no de un
  // `find` previo: la fila que devuelve el `returning` ES la actualizada.
  if (!cat) return res.status(404).json({ error: 'No encontrada' });
  res.json({ message: 'Actualizada', category: cat });
}, 'Error al actualizar la categoría'));

router.delete('/categories/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const borrada = await repo.categories.remove(idDeRuta(req.params.id));
  if (!borrada) return res.status(404).json({ error: 'No encontrada' });
  res.json({ message: 'Eliminada' });
}, 'Error al eliminar la categoría'));

// ========== PRODUCTS ==========
router.get('/products', asyncRoute(async (req, res) => {
  // `active !== 'all'` y NO `active === 'true'`: el store defaulted a "solo
  // activos" y solo `all` apagaba el filtro. Por eso se manda un booleano.
  const { products, pagination } = await repo.products.list({
    active: req.query.active !== 'all',
    category: req.query.category,
    search: req.query.search,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.json({ products, pagination });
}, 'Error al listar los productos'));

router.get('/products/:id', asyncRoute(async (req, res) => {
  const p = await repo.products.findByIdOrSlug(req.params.id);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ product: p });
}, 'Error al obtener el producto'));

router.post('/products', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { name, description, price, stock, category_id, brand, image, specs, is_active = true } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'Nombre y precio obligatorios' });
  const precio = parsePrice(price);
  if (precio.error) return res.status(400).json({ error: precio.error });

  let slug = slugify(name);
  // El store desambiguaba el slug contra el array de productos. `findByIdOrSlug`
  // resuelve id-o-slug, asi que el chequeo es "existe algo con ESTE slug", y por
  // eso el `dup.slug === slug`: sin el, un producto llamado "123" se renombraria
  // porque existe un producto de id 123. Y "123" es un nombre perfectamente
  // valido.
  const dup = await repo.products.findByIdOrSlug(slug);
  if (dup && dup.slug === slug) slug += '-' + Date.now();

  const product = await repo.products.create({
    name,
    slug,
    description: description || null,
    price: precio.value,
    stock: stock || 0,
    category_id: category_id || null,
    brand: brand || null,
    image: image || null,
    specs: specs || null,
    is_active: !!is_active,
  });
  res.status(201).json({ message: 'Producto creado', product });
}, 'Error al crear el producto'));

router.put('/products/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const id = idDeRuta(req.params.id);

  // La EXISTENCIA se consulta antes de validar el precio, y no por prolijidad:
  // el store hacia el `find` primero, asi que un PUT a un id inexistente con un
  // precio invalido respondia 404 y no 400. Invertir el orden cambiaria el status
  // de una combinacion que un cliente puede producir a proposito. El `update`
  // despues devuelve la fila, asi que el `find` no es un segundo `get`: es el
  // 404 con el orden de antes.
  if (!(await repo.products.findByIdOrSlug(id))) return res.status(404).json({ error: 'No encontrado' });

  // Validamos ANTES de escribir: si el precio es invalido el 400 tiene que salir
  // sin haber tocado la base. Con SQL no hay mutacion en memoria que "deshacer":
  // o se valida antes del `update`, o el precio invalido ya quedo guardado.
  const patch = {};
  if (req.body.price !== undefined) {
    const precio = parsePrice(req.body.price);
    if (precio.error) return res.status(400).json({ error: precio.error });
    patch.price = precio.value;
  }
  ['name', 'description', 'stock', 'category_id', 'brand', 'image', 'specs', 'is_active'].forEach((f) => {
    if (req.body[f] !== undefined) patch[f] = req.body[f];
  });

  // `slug` NO va en la patch, y no es una decision: el codigo anterior comparaba
  // `req.body.name !== p.name` DESPUES de que el forEach de campos ya hubiera
  // copiado el nombre a `p`, o sea que la comparacion era siempre falsa y el
  // slug NUNCA se regeneraba. Preservarlo es lo que hace que esto sea una
  // migracion de persistencia y no un cambio de contrato. Regenerarlo seria
  // cambiar la URL de un producto, asi que queda como follow-up con su test.
  // (En servicios SI se regeneraba: ahi la guarda no comparaba. Ver services.js.)
  const p = await repo.products.update(id, patch);
  res.json({ message: 'Actualizado', product: p });
}, 'Error al actualizar el producto'));

router.delete('/products/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const borrado = await repo.products.remove(idDeRuta(req.params.id));
  if (!borrado) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Eliminado' });
}, 'Error al eliminar el producto'));

// ========== SERVICES ==========
router.get('/services', asyncRoute(async (req, res) => {
  const services = await repo.services.list({ active: req.query.active !== 'all' });
  res.json({ services });
}, 'Error al listar los servicios'));

router.get('/services/:id', asyncRoute(async (req, res) => {
  const s = await repo.services.findByIdOrSlug(req.params.id);
  if (!s) return res.status(404).json({ error: 'Servicio no encontrado' });
  res.json({ service: s });
}, 'Error al obtener el servicio'));

router.post('/services', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { name, description, price, duration, image, is_active = true } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'Nombre y precio obligatorios' });
  const precio = parsePrice(price);
  if (precio.error) return res.status(400).json({ error: precio.error });

  let slug = slugify(name);
  const dup = await repo.services.findByIdOrSlug(slug);
  if (dup && dup.slug === slug) slug += '-' + Date.now();

  const service = await repo.services.create({
    name,
    slug,
    description: description || null,
    price: precio.value,
    duration: duration || null,
    image: image || null,
    is_active: !!is_active,
  });
  res.status(201).json({ message: 'Servicio creado', service });
}, 'Error al crear el servicio'));

router.put('/services/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const id = idDeRuta(req.params.id);
  // Mismo criterio que en products: 404 antes que 400.
  if (!(await repo.services.findByIdOrSlug(id))) return res.status(404).json({ error: 'No encontrado' });

  const patch = {};
  if (req.body.price !== undefined) {
    const precio = parsePrice(req.body.price);
    if (precio.error) return res.status(400).json({ error: precio.error });
    patch.price = precio.value;
  }
  ['name', 'description', 'duration', 'image', 'is_active'].forEach((f) => {
    if (req.body[f] !== undefined) patch[f] = req.body[f];
  });
  // ACÁ EL slug SI SE REGENERA, porque el codigo anterior lo hacia: la guarda
  // era `if (req.body.name) s.slug = slugify(s.name)`, sin comparacion contra el
  // nombre anterior. Es observable (es la URL de /servicios/:slug) y por eso se
  // preserva en vez de "corregirse".
  if (req.body.name) patch.slug = slugify(req.body.name);

  const s = await repo.services.update(id, patch);
  res.json({ message: 'Actualizado', service: s });
}, 'Error al actualizar el servicio'));

router.delete('/services/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const borrado = await repo.services.remove(idDeRuta(req.params.id));
  if (!borrado) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Eliminado' });
}, 'Error al eliminar el servicio'));

// ========== ORDERS ==========
//
// Los pedidos Ya NO pasan por el store JSON (fase 4). Todo lo de esta seccion
// va por el repo, y por el repo a PostgreSQL. Ninguna ruta lo lee.
//
// El store queda en el repo solo como red de seguridad DURANTE la tarea 8.1
// (la semana de gracia). Lo borra la 8.2. Ojo con la inversion: decir "hasta
// la 8.1" promete un borrado que la 8.1 no hace.
//
// La ruta quedo deliberadamente CHICA. Todo lo que hace que un pedido sea
// atomico esta en `repo.orders.createAtomic` (queries/orders.js): resolver
// precios, calcular el total, descontar stock y cerrar la transaccion. Si el
// handler hiciera cualquiera de esas cosas, "la transaccion es una propiedad del
// metodo" (D-01) seria mentira: seria una propiedad de acordarse.
router.post('/orders', rateLimit.orderLimiter(), optionalAuth, asyncRoute(async (req, res) => {
  const { items, shipping_address, notes, customer_name, customer_email, customer_phone } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'El pedido debe tener al menos un ítem' });
  if (!customer_name || !customer_email) return res.status(400).json({ error: 'Nombre y email obligatorios' });

  // Validacion de cantidad ACA y tambien en el repo (defensa en profundidad).
  // La de la ruta es la que responde al cliente; la del repo protege el metodo
  // de cualquier otro call site futuro. Una cantidad 0 o negativa que llegara al
  // UPDATE de stock seria un `stock = stock - (-1)`, o sea REPONER stock.
  for (const item of items) {
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({ error: 'Cantidad inválida' });
    }
  }

  try {
    const order = await repo.orders.createAtomic({
      items,
      userId: req.user?.id || null,
      shippingAddress: shipping_address || null,
      notes: notes || null,
      customerName: customer_name,
      customerEmail: customer_email,
      customerPhone: customer_phone || null,
    });
    res.status(201).json({ message: 'Pedido confirmado correctamente', order });
  } catch (e) {
    // Un error de NEGOCIO (no hay stock, el producto no esta, cantidad
    // invalida) es 400, no 500: el cliente puede hacer algo con esa respuesta.
    // Un 500 le diria "no se que paso" cuando si sabe: que no hay stock.
    if (e.code === 'STOCK_INSUFICIENTE') return res.status(400).json({ error: e.message });
    if (e.code === 'ITEM_NO_DISPONIBLE') return res.status(400).json({ error: e.message });
    if (e.code === 'CANTIDAD_INVALIDA') return res.status(400).json({ error: e.message });
    throw e;
  }
}, 'Error al crear pedido'));

router.get('/orders', authenticate, asyncRoute(async (req, res) => {
  // El filtro de dueno va a la query, no despues en JS. `admin` ve todos:
  // se pasa `userId: null` y el repo no filtra.
  const { orders, pagination } = await repo.orders.list({
    userId: req.user.role === 'admin' ? null : req.user.id,
    status: req.query.status,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.json({ orders, pagination });
}, 'Error al listar pedidos'));

// El 403 por IDOR va ACA y no en el repo: que es "no autorizado" es politica de
// la API. Si el filtro de dueno viviera en la capa de datos, `list` y
// `findById` tendrian que recibir el rol y aplicar la misma regla con otros
// parametros, y el control de acceso quedaria repartido en dos lugares que hay
// que mantener juntos sin que nada lo exija.
router.get('/orders/:id', authenticate, asyncRoute(async (req, res) => {
  const order = await repo.orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'No encontrado' });
  if (req.user.role !== 'admin' && order.user_id !== req.user.id) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  res.json({ order });
}, 'Error al obtener pedido'));

router.put('/orders/:id/status', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const valid = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error: 'Estado inválido' });
  const order = await repo.orders.updateStatus(req.params.id, req.body.status);
  if (!order) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Estado actualizado', order });
}, 'Error al actualizar estado'));

// ========== USERS ==========
router.get('/users', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  let list = await repo.users.list();
  if (req.query.role) list = list.filter(u => u.role === req.query.role);
  if (req.query.search) {
    const t = req.query.search.toLowerCase();
    list = list.filter(u => u.name.toLowerCase().includes(t) || u.email.toLowerCase().includes(t) || (u.dni || '').includes(t));
  }
  // La paginacion FIJA, con `pages` clavado en 1 aunque haya 300 usuarios: es el
  // contrato de hoy y calcularlo bien en el mismo change que migra la
  // persistencia haria imposible saber cual de los dos cambios rompio el front.
  res.json({ users: list, pagination: { page: 1, limit: 100, total: list.length, pages: 1 } });
}, 'Error al listar los usuarios'));

router.put('/users/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const patch = {};
  ['name', 'email', 'dni', 'role', 'phone', 'address'].forEach((f) => {
    if (req.body[f] !== undefined) patch[f] = req.body[f];
  });
  if (req.body.password) patch.password = await bcrypt.hash(req.body.password, 10);

  const user = await repo.users.update(idDeRuta(req.params.id), patch);
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Actualizado', user });
}, 'Error al actualizar el usuario'));

router.delete('/users/:id', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  // La guarda anti-borrado propio va ANTES de tocar la base y antes del 404, y
  // queda igual que estaba: un admin no puede borrarse a si mismo ni aunque el id
  // exista. `parseInt` (no `idDeRuta`) porque el `400` tiene que saltar para el
  // propio id y para cualquier string que `parseInt` convierta al mismo numero.
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'No podés eliminarte a vos mismo' });
  const borrado = await repo.users.remove(idDeRuta(req.params.id));
  if (!borrado) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Eliminado' });
}, 'Error al eliminar el usuario'));

// ========== CONTACT ==========
router.post('/contact', rateLimit.contactLimiter(), asyncRoute(async (req, res) => {
  const { name, email, phone, subject, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Nombre, email y mensaje obligatorios' });
  await repo.contact.create({ name, email, phone: phone || null, subject: subject || null, message });
  const result = await sendContactEmail({ name, email, phone, subject, message });
  res.status(201).json({ message: 'Mensaje enviado correctamente. Te responderemos a la brevedad.', email_sent: result.sent, ...(result.reason && { note: result.reason }) });
}, 'Error al guardar el mensaje'));

router.get('/contact', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const list = await repo.contact.list({ unread: req.query.unread });
  res.json({ messages: list, pagination: { page: 1, limit: 50, total: list.length, pages: 1 } });
}, 'Error al listar los mensajes'));

router.put('/contact/:id/read', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  // 200 SIEMPRE, exista o no el mensaje: el store hacia `if (m) { m.is_read = true }`
  // y respondia sin condiciones. El booleano que devuelve el repo queda sin
  // usar a proposito; el dia que la API quiera un 404, el metodo ya lo tiene.
  await repo.contact.markRead(idDeRuta(req.params.id));
  res.json({ message: 'Marcado como leído' });
}, 'Error al marcar el mensaje como leído'));

// ========== SETTINGS ==========
router.get('/settings', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  res.json({ settings: await repo.settings.getAll() });
}, 'Error al leer la configuración'));

router.put('/settings', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  // La allowlist de las 10 claves y el `String()` viven en
  // queries/settings.js, no aca: son lo que garantiza que nada se escriba fuera
  // de esas diez. La ruta pasa el body entero.
  const settings = await repo.settings.upsertMany(req.body);
  res.json({ message: 'Configuración actualizada', settings });
}, 'Error al guardar la configuración'));

// ========== DASHBOARD ==========
//
// Las CINCO fuentes van a PostgreSQL (fase 4, D-K cerrado): products, services,
// users, contact_messages y orders. `queries/dashboard.js` las cuenta con
// `count(*)`/`sum()` en la base, no bajando el catalogo entero a JS para
// filtrarlo a mano. Por eso no se puede volver a componer el dashboard en la
// ruta: los conteos de pedidos y los ingresos tienen que salir de la misma
// fuente que escribe `POST /orders`, o el panel volveria a mostrar dos
// verdades distintas.
//
// El sobre lo arma la ruta, igual que en el resto de los endpoints. Los conteos
// van como `count(*)::int` y el total de ingresos se excluye de `cancelled`, que
// es lo que hacia la version del store: un pedido cancelado no es plata que
// entró.
//
// Si alguna vez hay que agregar una metrica, se agrega UNA consulta aqui abajo. No
// se re-mezcla el store JSON: ese archivo ya no participa de ninguna lectura.
router.get('/dashboard/stats', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  const { stats, recentOrders, lowStock } = await repo.dashboard.stats();

  res.json({
    stats,
    recentOrders,
    lowStock,
    // Decision de producto, no una consulta pendiente: el store tampoco lo
    // calculaba. No lo "completar" sin que el front lo pida.
    salesByMonth: [],
  });
}, 'Error al cargar estadisticas'));

module.exports = router;
