# AGENTS.md â€” Compushop

Documento de requerimientos y contexto actual de la aplicaciÃ³n para agentes de desarrollo (humanos o IA).

---

## 1. DescripciÃ³n del producto

**Compushop** es un e-commerce fullstack para una casa de computaciÃ³n.

**Vende / ofrece:**
- Notebooks, PCs de escritorio, componentes, monitores
- Muebles de oficina e insumos
- Servicios tÃ©cnicos (armado, reparaciÃ³n, mantenimiento, redes)

**Idioma de la interfaz:** espaÃ±ol (Argentina).

**URLs de producciÃ³n (referencia):**
| Servicio  | URL |
|-----------|-----|
| Frontend  | `https://front-compushop.vercel.app` |
| Backend   | `https://compushop-ruby.vercel.app` |

---

## 2. Stack tecnolÃ³gico

### Frontend
| TecnologÃ­a | Uso |
|------------|-----|
| React 18 | UI |
| Vite 6 | Build / dev server |
| Chakra UI 2 | Componentes y tema (claro/oscuro) |
| React Router 6 | Rutas SPA |
| Axios | Cliente HTTP |
| React Icons | IconografÃ­a |
| Framer Motion | Animaciones (vÃ­a Chakra) |

### Backend
| TecnologÃ­a | Uso |
|------------|-----|
| Node.js + Express 4 | API REST |
| jsonwebtoken | Auth JWT |
| bcryptjs | Hash de contraseÃ±as |
| cors | CORS |
| dotenv | Variables de entorno |
| nodemailer | Emails (contacto / recuperaciÃ³n) |
| uuid | Tokens de reset de clave |
| Store JSON (`src/db/store.js`) | Persistencia actual (archivo `data.json`) |

> **Nota:** La persistencia es un store en archivo JSON (no SQLite en runtime de producciÃ³n). MigraciÃ³n futura prevista a SQLite / MySQL / MongoDB.

### Deploy
- Frontend y backend en **Vercel** (proyectos separados).
- Backend: entry serverless `backend/api/index.js` + `backend/vercel.json`.
- Frontend: SPA con `frontend/vercel.json` (rewrites a `index.html`).

---

## 3. Roles de usuario

| Rol | DescripciÃ³n | Acceso |
|-----|-------------|--------|
| `customer` | Cliente registrado | CatÃ¡logo, carrito, pedidos propios, perfil implÃ­cito vÃ­a JWT |
| `admin` | Administrador | Dashboard completo (CRUD, pedidos, usuarios, mensajes, settings, stats) |
| AnÃ³nimo | Sin login | CatÃ¡logo, carrito local, confirmar pedido, contacto, registro/login |

---

## 4. AutenticaciÃ³n (JWT)

### Requisitos vigentes
- Registro de clientes con: nombre, email, password (mÃ­n. 6), DNI opcional, telÃ©fono, direcciÃ³n.
- Login con email + password â†’ responde `{ user, token }`.
- Token JWT en header: `Authorization: Bearer <token>`.
- Payload JWT: `id`, `email`, `role`, `name`.
- ExpiraciÃ³n configurable (`JWT_EXPIRES_IN`, default `7d`).
- RecuperaciÃ³n de clave **por DNI** (y email opcional de validaciÃ³n).
- Reset de password con token de un solo uso (1 hora).
- Frontend guarda `compushop_token` y `compushop_user` en `localStorage`.
- Al cargar la app se valida sesiÃ³n con `GET /api/auth/me`.
- Ante 401 (fuera de login/register) se limpia la sesiÃ³n.

### Credenciales demo (seed)
| Rol | Email | Password | DNI |
|-----|-------|----------|-----|
| admin | `admin@compushop.com` | `admin123` | `12345678` |
| customer | `juan@email.com` | `cliente123` | `30123456` |

---

## 5. Funcionalidades por Ã¡rea

### 5.1 PÃºblico (sin login obligatorio)
- **Home:** hero â€œTecnologÃ­a NÃ­tidaâ€, about, productos destacados, banner promo, servicios, stats, CTA contacto.
- **Productos:** listado con filtro por categorÃ­a y bÃºsqueda; detalle por slug/id.
- **Servicios:** listado de servicios tÃ©cnicos.
- **Carrito:** Context + `localStorage`; agregar/quitar/cantidad; confirmar pedido (registra en backend y descuenta stock de productos).
- **Contacto:** formulario (nombre, email, telÃ©fono, asunto, mensaje) â†’ guarda en DB + intenta envÃ­o SMTP.
- **Auth UI:** login, registro, recuperar clave, reset password.
- Tema claro / oscuro.

### 5.2 Carrito y pedidos
- Carrito **solo frontend** hasta confirmar.
- Al confirmar: `POST /api/orders` con items, datos de cliente y direcciÃ³n.
- Puede ser anÃ³nimo o usuario logueado (`user_id` si hay JWT).
- Descuenta stock de productos; valida stock insuficiente.
- Estados de pedido: `pending | confirmed | processing | shipped | delivered | cancelled`.
- Admin puede cambiar estado; cliente solo ve sus pedidos.

### 5.3 Dashboard admin (`/admin/*`, solo `role === 'admin'`)
- **Dashboard:** conteos (productos, servicios, clientes, pedidos, pendientes, mensajes sin leer, ingresos), pedidos recientes, stock bajo.
- **Productos:** CRUD (nombre, descripciÃ³n, precio, stock, categorÃ­a, marca, imagen URL, activo).
- **Servicios:** CRUD (nombre, descripciÃ³n, precio, duraciÃ³n, imagen, activo).
- **Pedidos:** listado + cambio de estado.
- **Usuarios:** listado, eliminar (no auto-eliminarse).
- **Mensajes:** listado de contacto, marcar leÃ­do.
- **ConfiguraciÃ³n:** datos de tienda + SMTP (host, port, user, pass, from, contact_to).

---

## 6. Modelo de datos

La capa de persistencia es **PostgreSQL** (Supabase, pooler transaction mode en puerto 6543) mediante el repositorio src/data/repo.js. El store JSON (src/db/store.js) y su seed (src/db/seed.js) se mantienen en el repositorio **como red de seguridad** (no son usados en producción mientras DATABASE_URL esté configurado). 

Entidades en Postgres:

| Entidad | Campos principales |
|---------|-------------------|
| users | id, name, email, password (hash), dni, role, phone, address, created_at |
| categories | id, name, slug, description, image, created_at |
| products | id, name, slug, description, price, stock, category_id, brand, image, specs, is_active, timestamps |
| services | id, name, slug, description, price, duration, image, is_active, timestamps |
| orders | id, user_id, order_number, status, total, shipping_address, notes, customer_*, timestamps |
| order_items | id, order_id, product_id, service_id, name, price, quantity, type (product\|service) |
| contact_messages | id, name, email, phone, subject, message, is_read, created_at |
| settings | objeto key/value (SMTP, store_*) |
| password_resets | id, user_id, token, expires_at, used, created_at |

Seed legacy: 
pm run seed en backend (12 productos, 4 servicios, 6 categorías, 2 usuarios, settings).


## 7. API REST (`/api`)

Base URL producciÃ³n: `https://compushop-backend.vercel.app/api`  
Base URL local: `http://localhost:4000/api`

### Auth
| MÃ©todo | Ruta | Auth | DescripciÃ³n |
|--------|------|------|-------------|
| POST | `/auth/register` | â€” | Registro customer |
| POST | `/auth/login` | â€” | Login â†’ JWT |
| GET | `/auth/me` | JWT | Usuario actual |
| POST | `/auth/forgot-password` | â€” | Solicitud reset por DNI |
| POST | `/auth/reset-password` | â€” | Nueva password con token |

### CatÃ¡logo
| MÃ©todo | Ruta | Auth | DescripciÃ³n |
|--------|------|------|-------------|
| GET | `/products` | â€” | Listado (query: category, search, active, page, limit) |
| GET | `/products/:id` | â€” | Detalle (id o slug) |
| POST/PUT/DELETE | `/products` / `/:id` | admin | CRUD |
| GET | `/services` | â€” | Listado |
| GET | `/services/:id` | â€” | Detalle |
| POST/PUT/DELETE | `/services` / `/:id` | admin | CRUD |
| GET | `/categories` | â€” | Listado + product_count |
| POST/PUT/DELETE | `/categories` / `/:id` | admin | CRUD |

### Pedidos
| MÃ©todo | Ruta | Auth | DescripciÃ³n |
|--------|------|------|-------------|
| POST | `/orders` | opcional | Confirmar pedido |
| GET | `/orders` | JWT | Lista (admin: todos; customer: propios) |
| GET | `/orders/:id` | JWT | Detalle |
| PUT | `/orders/:id/status` | admin | Cambiar estado |

### Admin / sistema
| M��todo | Ruta | Auth | Descripci��n |
|--------|------|------|-------------|
| GET/PUT/DELETE | /users / /:id | admin | Gesti��n usuarios |
| POST | /contact | �?" | Enviar mensaje |
| GET | /contact | admin | Listar mensajes |
| PUT | /contact/:id/read | admin | Marcar le��do |
| GET/PUT | /settings | admin | Configuraci��n |
| GET | /dashboard/stats | admin | Estad��sticas |

### Salud / Operaciones
| M��todo | Ruta | Auth | Descripci��n |
|--------|------|------|-------------|
| GET | /health/keep-warm | Bearer CRON_SECRET | Endpoint para keep-warm (Vercel Cron). Devuelve 200 si DB OK, 500 si DB caída. Sin CRON_SECRET → 503 (sin queries). Secreto incorrecto → 401 (sin queries). |


## 8. Rutas frontend

| Ruta | PÃ¡gina | ProtecciÃ³n |
|------|--------|------------|
| `/` | Home | PÃºblica |
| `/productos` | CatÃ¡logo | PÃºblica |
| `/producto/:id` | Detalle producto | PÃºblica |
| `/servicios` | Servicios | PÃºblica |
| `/carrito` | Carrito + checkout | PÃºblica |
| `/login` | Login | PÃºblica |
| `/registro` | Registro | PÃºblica |
| `/contacto` | Contacto | PÃºblica |
| `/recuperar-clave` | Forgot password | PÃºblica |
| `/reset-password` | Reset password | PÃºblica |
| `/admin` | Dashboard | Solo admin |
| `/admin/productos` | CRUD productos | Solo admin |
| `/admin/servicios` | CRUD servicios | Solo admin |
| `/admin/pedidos` | Pedidos | Solo admin |
| `/admin/usuarios` | Usuarios | Solo admin |
| `/admin/mensajes` | Mensajes contacto | Solo admin |
| `/admin/configuracion` | Settings / SMTP | Solo admin |

---

## 9. DiseÃ±o UI (requerimientos visuales actuales)

- Estilo: corporativo, moderno, minimalista.
- InspiraciÃ³n de layout tipo plantilla Mobirise (navbar pill, hero full-bleed, cards redondeadas) **con paleta azul original del proyecto**.
- Paleta `brand` (Chakra):
  - Principal: `#0066e6` (`brand.500`)
  - Hover/darker: `#0052b3` (`brand.600`)
- Navbar flotante tipo â€œpillâ€, sticky, con blur.
- Botones `borderRadius: full`.
- Cards de producto con imagen, precio, CTA â€œComprar Ahoraâ€ / â€œContratarâ€.
- Soporte **tema claro y oscuro** (toggle).
- Responsive (mobile drawer en navbar).

---

## 10. Variables de entorno

### Backend (`backend/.env`)
| Variable | Requerida | DescripciÃ³n |
|----------|-----------|-------------|
| `PORT` | no | Default `4000` |
| `JWT_SECRET` | **obligatoria en prod** | Secreto de firma JWT. Sin ella el server **falla al arrancar** en producciÃ³n (no hay fallback). |
| `JWT_EXPIRES_IN` | no | Default `7d` |
| `FRONTEND_URL` | recomendada | Origen CORS del front **y** host del link de recuperaciÃ³n de contraseÃ±a |
| `SMTP_*` / settings en DB | opcional | Email real; si falta, el mensaje se guarda igual. `dev_token` solo se devuelve fuera de producciÃ³n |

### Frontend (`VITE_*` en build)
| Variable | Requerida | DescripciÃ³n |
|----------|-----------|-------------|
| `VITE_API_URL` | **sÃ­ en prod** | Ej. `https://compushop-backend.vercel.app/api` |

Fallback en cÃ³digo: en localhost â†’ `http://localhost:4000/api`; fuera de localhost â†’ URL del backend Vercel hardcodeada como respaldo.

### CORS
OrÃ­genes permitidos: localhost:5173/3000, `https://compushop-dun.vercel.app`, `FRONTEND_URL`, y cualquier `*.vercel.app`.

---

## 11. Estructura de carpetas

`
compushop/
├── AGENTS.md
├── README.md
├── .gitignore
├── backend/
│   ├── api/index.js
│   ├── api/health/
│   │   └── keep-warm.js
│   ├── vercel.json
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js
│       ├── routes/index.js
│       ├── controllers/
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
`

## 12. Restricciones y deudas tecnicas conocidas

1. [RESUELTA] Persistencia migrada a PostgreSQL (Supabase, pooler transaction mode en puerto 6543). src/db/store.js y seed.js se mantienen en el repo como red de seguridad (tarea 8.1), no son usados en produccion mientras DATABASE_URL este configurado.
2. Imagenes: solo URLs externas; no hay upload de archivos.
3. Pagos: no hay pasarela (Mercado Pago / Stripe); el pedido es registro operativo.
4. Servicio detalle: ruta de detalle de servicio en front no esta tan completa como la de producto (catalogo si).
5. [RESUELTA] La capa database.js y los 7 controllers que la usaban fueron eliminados. Ahora src/db/ solo tiene store.js (persistencia activa) y seed.js, y src/controllers/ solo uthController.js. sql.js fue quitado de package.json. Guardas activas en ackend/tests/architecture.test.js que fallan si alguien reintroduce la capa.
6. Emails: dependen de SMTP configurado en settings/dashboard; sin SMTP el flujo no falla del todo (guarda el mensaje). dev_token de forgot-password solo se devuelve fuera de produccion.

### 12.1 Deudas operativas (migracion Postgres)

- Red de seguridad de datos: data.json sigue en el repo como red de seguridad hasta la tarea 8.1. Contiene PII real (usuarios, pedidos, mensajes de contacto). No eliminar hasta que la ventana de gracia haya pasado.
- Cobertura de concurrencia: el test de concurrencia con max: 1 prueba el invariante, pero no prueba el paralelismo real (conexiones serializadas).
- Suite lenta: ~244/244 ~350s contra Postgres remoto (pooler), esperado con aislamiento por snapshot/restore.
- Cron (keep-warm): ercel.json con uilds+outes (legacy) debe verificarse en logs de Vercel Cron Jobs post-deploy (2xx). Deploy verde no garantiza ruteo correcto. Si aparece 404, migrar a ewrites y re-verificar.
- Rollback de migracion: unset DATABASE_URL + redeploy. Al hacerlo, el cron vuelve al estado de ese deployment.
- TLS/CA: en produccion es obligatorio SUPABASE_CA_CERT (verificacion con CA). En desarrollo/local puede degradarse explicitamente si no se carga; nunca dejar ejectUnauthorized: false como default permanente.

## 13. Comandos esenciales

```bash
# Backend
cd backend && npm install && npm run seed && npm start
npm test                                  # 65 tests (node:test, sin deps)

# Frontend
cd frontend && npm install && npm run dev
```

### Tests del backend
`backend/tests/` usa el runner nativo de Node (`node --test`, sin dependencias extra).
Hacen backup y restauran `src/db/data.json`, asi que se pueden correr contra datos reales.

| Archivo | Que cubre |
|---------|-----------|
| `orders.security.test.js` | Regresion del exploit de precio: precio/nombre resueltos server-side, quantity entero â‰¥ 1, stock, productos inactivos, servicios |
| `auth.security.test.js` | Login, `/auth/me`, fail-fast de `JWT_SECRET`, `alg:none`, expiracion, `dev_token` solo en dev, roles (403), IDOR en pedidos, no auto-borrado, no hash filtrado |
| `architecture.test.js` | Guardas de estructura: no reintroducir `database.js` ni controllers muertos, imports no rotos, y reglas de seguridad (precio server-side, HS256 pin, link de reset) |

Un fallo en cualquiera de estos = regresion de seguridad o de estructura. No ignorar.

---

## 14. Criterios para cambios futuros (guÃ­a para agentes)

Al modificar o extender Compushop:

1. Mantener **espaÃ±ol** en UI y mensajes de error de API orientados al usuario.
2. Respetar roles: operaciones de escritura de catÃ¡logo/settings/usuarios solo **admin**.
3. No romper el contrato JWT ni las keys de `localStorage` sin migrar el front.
4. Cualquier nueva entidad debe integrarse al **store** (o a la DB que lo reemplace) y exponerse por `/api`.
5. El carrito permanece en cliente hasta `POST /orders`.
6. Preservar paleta azul `brand` y estilo de UI (pill navbar, radii grandes) salvo pedido explÃ­cito de rediseÃ±o.
7. Variables `VITE_*` requieren **rebuild/redeploy** del frontend en Vercel.
8. No commitear `.env` ni `data.json` con secretos o datos sensibles.
9. **Nunca confiar precio, nombre ni existencia vindos del body del cliente.** `POST /orders` los resuelve desde el store (`routes/index.js`). Un `curl` puede mandar cualquier `price`; si se usa ese valor, es una pÃ©rdida de plata directa. Misma regla aplica a cualquier cantidad usada para aritmÃ©tica: validar entero â‰¥ 1 (un `quantity` negativo incrementaba el stock).

---

*Ãšltima actualizaciÃ³n alineada al estado del proyecto en el repositorio de trabajo Compushop (frontend React/Chakra + backend Express/JWT + deploy Vercel).*
