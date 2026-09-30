# AGENTS.md — Compushop

Documento de requerimientos y contexto actual de la aplicación para agentes de desarrollo (humanos o IA).

---

## 1. Descripción del producto

**Compushop** es un e-commerce fullstack para una casa de computación.

**Vende / ofrece:**
- Notebooks, PCs de escritorio, componentes, monitores
- Muebles de oficina e insumos
- Servicios técnicos (armado, reparación, mantenimiento, redes)

**Idioma de la interfaz:** español (Argentina).

**URLs de producción (referencia):**
| Servicio  | URL |
|-----------|-----|
| Frontend  | `https://compushop-dun.vercel.app` |
| Backend   | `https://compushop-backend.vercel.app` |

---

## 2. Stack tecnológico

### Frontend
| Tecnología | Uso |
|------------|-----|
| React 18 | UI |
| Vite 6 | Build / dev server |
| Chakra UI 2 | Componentes y tema (claro/oscuro) |
| React Router 6 | Rutas SPA |
| Axios | Cliente HTTP |
| React Icons | Iconografía |
| Framer Motion | Animaciones (vía Chakra) |

### Backend
| Tecnología | Uso |
|------------|-----|
| Node.js + Express 4 | API REST |
| jsonwebtoken | Auth JWT |
| bcryptjs | Hash de contraseñas |
| cors | CORS |
| dotenv | Variables de entorno |
| nodemailer | Emails (contacto / recuperación) |
| uuid | Tokens de reset de clave |
| Store JSON (`src/db/store.js`) | Persistencia actual (archivo `data.json`) |

> **Nota:** La persistencia es un store en archivo JSON (no SQLite en runtime de producción). Migración futura prevista a SQLite / MySQL / MongoDB.

### Deploy
- Frontend y backend en **Vercel** (proyectos separados).
- Backend: entry serverless `backend/api/index.js` + `backend/vercel.json`.
- Frontend: SPA con `frontend/vercel.json` (rewrites a `index.html`).

---

## 3. Roles de usuario

| Rol | Descripción | Acceso |
|-----|-------------|--------|
| `customer` | Cliente registrado | Catálogo, carrito, pedidos propios, perfil implícito vía JWT |
| `admin` | Administrador | Dashboard completo (CRUD, pedidos, usuarios, mensajes, settings, stats) |
| Anónimo | Sin login | Catálogo, carrito local, confirmar pedido, contacto, registro/login |

---

## 4. Autenticación (JWT)

### Requisitos vigentes
- Registro de clientes con: nombre, email, password (mín. 6), DNI opcional, teléfono, dirección.
- Login con email + password → responde `{ user, token }`.
- Token JWT en header: `Authorization: Bearer <token>`.
- Payload JWT: `id`, `email`, `role`, `name`.
- Expiración configurable (`JWT_EXPIRES_IN`, default `7d`).
- Recuperación de clave **por DNI** (y email opcional de validación).
- Reset de password con token de un solo uso (1 hora).
- Frontend guarda `compushop_token` y `compushop_user` en `localStorage`.
- Al cargar la app se valida sesión con `GET /api/auth/me`.
- Ante 401 (fuera de login/register) se limpia la sesión.

### Credenciales demo (seed)
| Rol | Email | Password | DNI |
|-----|-------|----------|-----|
| admin | `admin@compushop.com` | `admin123` | `12345678` |
| customer | `juan@email.com` | `cliente123` | `30123456` |

---

## 5. Funcionalidades por área

### 5.1 Público (sin login obligatorio)
- **Home:** hero “Tecnología Nítida”, about, productos destacados, banner promo, servicios, stats, CTA contacto.
- **Productos:** listado con filtro por categoría y búsqueda; detalle por slug/id.
- **Servicios:** listado de servicios técnicos.
- **Carrito:** Context + `localStorage`; agregar/quitar/cantidad; confirmar pedido (registra en backend y descuenta stock de productos).
- **Contacto:** formulario (nombre, email, teléfono, asunto, mensaje) → guarda en DB + intenta envío SMTP.
- **Auth UI:** login, registro, recuperar clave, reset password.
- Tema claro / oscuro.

### 5.2 Carrito y pedidos
- Carrito **solo frontend** hasta confirmar.
- Al confirmar: `POST /api/orders` con items, datos de cliente y dirección.
- Puede ser anónimo o usuario logueado (`user_id` si hay JWT).
- Descuenta stock de productos; valida stock insuficiente.
- Estados de pedido: `pending | confirmed | processing | shipped | delivered | cancelled`.
- Admin puede cambiar estado; cliente solo ve sus pedidos.

### 5.3 Dashboard admin (`/admin/*`, solo `role === 'admin'`)
- **Dashboard:** conteos (productos, servicios, clientes, pedidos, pendientes, mensajes sin leer, ingresos), pedidos recientes, stock bajo.
- **Productos:** CRUD (nombre, descripción, precio, stock, categoría, marca, imagen URL, activo).
- **Servicios:** CRUD (nombre, descripción, precio, duración, imagen, activo).
- **Pedidos:** listado + cambio de estado.
- **Usuarios:** listado, eliminar (no auto-eliminarse).
- **Mensajes:** listado de contacto, marcar leído.
- **Configuración:** datos de tienda + SMTP (host, port, user, pass, from, contact_to).

---

## 6. Modelo de datos (store JSON)

Entidades actuales en `backend/src/db/store.js` / `data.json`:

| Entidad | Campos principales |
|---------|-------------------|
| `users` | id, name, email, password (hash), dni, role, phone, address, created_at |
| `categories` | id, name, slug, description, image, created_at |
| `products` | id, name, slug, description, price, stock, category_id, brand, image, specs, is_active, timestamps |
| `services` | id, name, slug, description, price, duration, image, is_active, timestamps |
| `orders` | id, user_id, order_number, status, total, shipping_address, notes, customer_*, timestamps |
| `order_items` | id, order_id, product_id, service_id, name, price, quantity, type (`product`\|`service`) |
| `contact_messages` | id, name, email, phone, subject, message, is_read, created_at |
| `settings` | objeto key/value (SMTP, store_*) |
| `password_resets` | id, user_id, token, expires_at, used, created_at |

Seed: `npm run seed` en backend (12 productos, 4 servicios, 6 categorías, 2 usuarios, settings).

---

## 7. API REST (`/api`)

Base URL producción: `https://compushop-backend.vercel.app/api`  
Base URL local: `http://localhost:4000/api`

### Auth
| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| POST | `/auth/register` | — | Registro customer |
| POST | `/auth/login` | — | Login → JWT |
| GET | `/auth/me` | JWT | Usuario actual |
| POST | `/auth/forgot-password` | — | Solicitud reset por DNI |
| POST | `/auth/reset-password` | — | Nueva password con token |

### Catálogo
| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/products` | — | Listado (query: category, search, active, page, limit) |
| GET | `/products/:id` | — | Detalle (id o slug) |
| POST/PUT/DELETE | `/products` / `/:id` | admin | CRUD |
| GET | `/services` | — | Listado |
| GET | `/services/:id` | — | Detalle |
| POST/PUT/DELETE | `/services` / `/:id` | admin | CRUD |
| GET | `/categories` | — | Listado + product_count |
| POST/PUT/DELETE | `/categories` / `/:id` | admin | CRUD |

### Pedidos
| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| POST | `/orders` | opcional | Confirmar pedido |
| GET | `/orders` | JWT | Lista (admin: todos; customer: propios) |
| GET | `/orders/:id` | JWT | Detalle |
| PUT | `/orders/:id/status` | admin | Cambiar estado |

### Admin / sistema
| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| GET/PUT/DELETE | `/users` / `/:id` | admin | Gestión usuarios |
| POST | `/contact` | — | Enviar mensaje |
| GET | `/contact` | admin | Listar mensajes |
| PUT | `/contact/:id/read` | admin | Marcar leído |
| GET/PUT | `/settings` | admin | Configuración |
| GET | `/dashboard/stats` | admin | Estadísticas |

---

## 8. Rutas frontend

| Ruta | Página | Protección |
|------|--------|------------|
| `/` | Home | Pública |
| `/productos` | Catálogo | Pública |
| `/producto/:id` | Detalle producto | Pública |
| `/servicios` | Servicios | Pública |
| `/carrito` | Carrito + checkout | Pública |
| `/login` | Login | Pública |
| `/registro` | Registro | Pública |
| `/contacto` | Contacto | Pública |
| `/recuperar-clave` | Forgot password | Pública |
| `/reset-password` | Reset password | Pública |
| `/admin` | Dashboard | Solo admin |
| `/admin/productos` | CRUD productos | Solo admin |
| `/admin/servicios` | CRUD servicios | Solo admin |
| `/admin/pedidos` | Pedidos | Solo admin |
| `/admin/usuarios` | Usuarios | Solo admin |
| `/admin/mensajes` | Mensajes contacto | Solo admin |
| `/admin/configuracion` | Settings / SMTP | Solo admin |

---

## 9. Diseño UI (requerimientos visuales actuales)

- Estilo: corporativo, moderno, minimalista.
- Inspiración de layout tipo plantilla Mobirise (navbar pill, hero full-bleed, cards redondeadas) **con paleta azul original del proyecto**.
- Paleta `brand` (Chakra):
  - Principal: `#0066e6` (`brand.500`)
  - Hover/darker: `#0052b3` (`brand.600`)
- Navbar flotante tipo “pill”, sticky, con blur.
- Botones `borderRadius: full`.
- Cards de producto con imagen, precio, CTA “Comprar Ahora” / “Contratar”.
- Soporte **tema claro y oscuro** (toggle).
- Responsive (mobile drawer en navbar).

---

## 10. Variables de entorno

### Backend (`backend/.env`)
| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `PORT` | no | Default `4000` |
| `JWT_SECRET` | **obligatoria en prod** | Secreto de firma JWT. Sin ella el server **falla al arrancar** en producción (no hay fallback). |
| `JWT_EXPIRES_IN` | no | Default `7d` |
| `FRONTEND_URL` | recomendada | Origen CORS del front **y** host del link de recuperación de contraseña |
| `SMTP_*` / settings en DB | opcional | Email real; si falta, el mensaje se guarda igual. `dev_token` solo se devuelve fuera de producción |

### Frontend (`VITE_*` en build)
| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `VITE_API_URL` | **sí en prod** | Ej. `https://compushop-backend.vercel.app/api` |

Fallback en código: en localhost → `http://localhost:4000/api`; fuera de localhost → URL del backend Vercel hardcodeada como respaldo.

### CORS
Orígenes permitidos: localhost:5173/3000, `https://compushop-dun.vercel.app`, `FRONTEND_URL`, y cualquier `*.vercel.app`.

---

## 11. Estructura de carpetas

```
compushop/
├── AGENTS.md                 # Este documento
├── README.md
├── .gitignore
├── backend/
│   ├── api/index.js          # Entry Vercel serverless
│   ├── vercel.json
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js          # Express + CORS
│       ├── routes/index.js   # Rutas API consolidado
│       ├── controllers/      # Auth y legacy (ruta usa lógica inline + authCtrl)
│       ├── middleware/auth.js
│       ├── db/store.js + seed.js
│       └── utils/jwt.js + email.js
└── frontend/
    ├── vercel.json
    ├── package.json
    ├── .env.example
    └── src/
        ├── api/client.js
        ├── context/AuthContext.jsx + CartContext.jsx
        ├── theme/index.js
        ├── components/Navbar.jsx + ProductCard.jsx
        └── pages/ (+ admin/)
```

---

## 12. Restricciones y deudas técnicas conocidas

1. **Persistencia JSON en filesystem:** en Vercel serverless el FS es efímero; los datos pueden no persistir entre invocaciones. Para producción real hace falta DB externa (Postgres, Mongo, etc.).
2. **Imágenes:** solo URLs externas; no hay upload de archivos.
3. **Pagos:** no hay pasarela (Mercado Pago / Stripe); el “pedido” es registro operativo.
4. **Servicio detalle:** ruta de detalle de servicio en front no está tan completa como la de producto (catálogo sí).
5. **Capa `database.js` muerta (importante):** `src/db/database.js` (~500 líneas) simula una API tipo `better-sqlite3`, pero **no es SQL real** — parsea el string de la query con `.startsWith('INSERT INTO USERS')` y lo despacha a handlers hardcodeados. Además `src/db/database.js` usa `_meta.nextId` mientras `src/db/store.js` usa `seq`, y sus entidades de settings difieren (array de filas vs objeto key/value), por lo que sus datos no son intercambiables. Solo lo importan 7 controllers (`products`, `services`, `orders`, `users`, `categories`, `contact`, `dashboard`, `settings`) que **`routes/index.js` nunca carga**. La lógica viva va inline en `routes/index.js` contra `store.js`. **NoTomar `database.js` ni esos controllers como referencia de arquitectura** — están desconectados. Al borrar, borrar también `sql.js` del `package.json`.
6. **Emails:** dependen de SMTP configurado en settings/dashboard; sin SMTP el flujo no falla del todo (guarda el mensaje). `dev_token` de forgot-password solo se devuelve fuera de producción.

---

## 13. Comandos esenciales

```bash
# Backend
cd backend && npm install && npm run seed && npm start

# Frontend
cd frontend && npm install && npm run dev
```

---

## 14. Criterios para cambios futuros (guía para agentes)

Al modificar o extender Compushop:

1. Mantener **español** en UI y mensajes de error de API orientados al usuario.
2. Respetar roles: operaciones de escritura de catálogo/settings/usuarios solo **admin**.
3. No romper el contrato JWT ni las keys de `localStorage` sin migrar el front.
4. Cualquier nueva entidad debe integrarse al **store** (o a la DB que lo reemplace) y exponerse por `/api`.
5. El carrito permanece en cliente hasta `POST /orders`.
6. Preservar paleta azul `brand` y estilo de UI (pill navbar, radii grandes) salvo pedido explícito de rediseño.
7. Variables `VITE_*` requieren **rebuild/redeploy** del frontend en Vercel.
8. No commitear `.env` ni `data.json` con secretos o datos sensibles.
9. **Nunca confiar precio, nombre ni existencia vindos del body del cliente.** `POST /orders` los resuelve desde el store (`routes/index.js`). Un `curl` puede mandar cualquier `price`; si se usa ese valor, es una pérdida de plata directa. Misma regla aplica a cualquier cantidad usada para aritmética: validar entero ≥ 1 (un `quantity` negativo incrementaba el stock).

---

*Última actualización alineada al estado del proyecto en el repositorio de trabajo Compushop (frontend React/Chakra + backend Express/JWT + deploy Vercel).*
