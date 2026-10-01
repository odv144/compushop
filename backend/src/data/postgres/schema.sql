-- =============================================================================
-- Compushop — schema PostgreSQL
--
-- Derivado de la FORMA REAL de src/db/data.json y de los inserts de
-- src/routes/index.js. No de la documentacion: AGENTS.md dice que `categories`
-- tiene `image`, y el seed no lo setea, asi que la columna es nullable y la
-- migracion inserta NULL cuando el dato no esta.
--
-- IDs: enteros planos, iguales a los del JSON. La migracion los inserta
-- explicitos y hace setval de cada secuencia al valor de `seq` del JSON, asi
-- que los ids siguientes no colisionan con lo migrado.
--
-- Correr como postgres (o como dueno de la base). NO como compushop_app: en la
-- base de la app el rol no tiene CREATE sobre el schema public.
-- Es idempotente: se puede correr las veces que haga falta.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Secuencias primero: las tablas referencian con nextval() y el default se
-- resuelve al crear la tabla.
-- -----------------------------------------------------------------------------
create sequence if not exists users_id_seq            as integer start 1;
create sequence if not exists categories_id_seq        as integer start 1;
create sequence if not exists products_id_seq          as integer start 1;
create sequence if not exists services_id_seq          as integer start 1;
create sequence if not exists orders_id_seq            as integer start 1;
-- Consecuencia que hay que conocer: `truncate ... restart identity` NO la
-- resetea. Por eso `scripts/migrate-data.js` la setea a mano y el harness de
-- tests la tiene en su lista de secuencias (tests/helpers.js).
--
-- Los digitos salen de `nextval` y no de `Math.random()`: dos pedidos del mismo
-- dia ya no pueden sacar el mismo numero, y el `unique index` de abajo
-- convierte cualquier repeticion en un error en vez de en un dato dudoso.
--
-- SIN OWNED BY, y es a proposito: `order_number` es un TEXTO (`CS260930-0001`),
-- no un entero, asi que no hay columna de la que esta secuencia sea duena. Es la
-- unica secuencia del schema en esta situacion.
create sequence if not exists order_number_seq         as integer start 1;
create sequence if not exists order_items_id_seq       as integer start 1;
create sequence if not exists contact_messages_id_seq  as integer start 1;
create sequence if not exists password_resets_id_seq   as integer start 1;

-- -----------------------------------------------------------------------------
-- users — sin `updated_at`: el JSON real no lo tiene (verificado sobre las 2 filas)
-- -----------------------------------------------------------------------------
create table if not exists users (
  id          integer primary key default nextval('users_id_seq'),
  name        text    not null,
  email       text    not null,
  password    text    not null,
  dni         text,
  role        text    not null default 'customer',
  phone       text,
  address     text,
  created_at  timestamptz not null default now()
);
-- NO es unique a proposito: el JSON no garantiza unicidad y agregar la
-- constraint podria fallar el start si ya hay duplicados. Endurecer esto es un
-- cambio de contrato con su propio test, no un efecto colateral de la migracion.
create index if not exists users_email_idx on users (email);
create index if not exists users_dni_idx   on users (dni);

-- -----------------------------------------------------------------------------
-- categories — `image` existe en el POST /categories pero el seed no la setea
-- -----------------------------------------------------------------------------
create table if not exists categories (
  id          integer primary key default nextval('categories_id_seq'),
  name        text    not null,
  slug        text    not null,
  description text,
  image       text,
  created_at  timestamptz not null default now()
);
create index if not exists categories_slug_idx on categories (slug);

-- -----------------------------------------------------------------------------
-- products — `specs` es un objeto en el JSON -> jsonb
-- `category_id` es nullable: POST /products acepta categoria nula (routes/index.js)
-- -----------------------------------------------------------------------------
create table if not exists products (
  id          integer primary key default nextval('products_id_seq'),
  name        text    not null,
  slug        text    not null,
  description text,
  price       numeric(14,2) not null,
  stock       integer not null default 0,
  category_id integer references categories (id) on delete set null,
  brand       text,
  image       text,
  specs       jsonb,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists products_category_idx on products (category_id);
create index if not exists products_slug_idx     on products (slug);
create index if not exists products_active_idx   on products (is_active);

-- -----------------------------------------------------------------------------
-- services — `duration` es un string ("24-48 hs"), NO un numero
-- -----------------------------------------------------------------------------
create table if not exists services (
  id          integer primary key default nextval('services_id_seq'),
  name        text    not null,
  slug        text    not null,
  description text,
  price       numeric(14,2) not null,
  duration    text,
  image       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists services_slug_idx on services (slug);

-- -----------------------------------------------------------------------------
-- orders — `user_id` es nullable: el JSON tiene pedidos anonimos (user_id null)
-- -----------------------------------------------------------------------------
create table if not exists orders (
  id               integer primary key default nextval('orders_id_seq'),
  user_id          integer references users (id) on delete set null,
  order_number     text    not null,
  status           text    not null,
  total            numeric(14,2) not null,
  shipping_address text,
  notes            text,
  customer_name    text,
  customer_email   text,
  customer_phone   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists orders_user_idx    on orders (user_id);
-- El numero de pedido es UNIQUE. Antes este indice era normal y el numero salia
-- de `Math.floor(Math.random() * 9000 + 1000)`: la colision era posible y
-- silenciosa, y dejaba dos pedidos indistinguibles para el admin y para el
-- cliente. El UNIQUE es lo que hace SEGURO el `nextval` de `order_number_seq`.
--
-- El `drop` no es decorativo: ese nombre lo tenia el indice NO-UNIQUE de la
-- version anterior, y `create index if not exists` es un no-op si el nombre ya
-- existe, aunque las columnas o la unicidad sean distintas. Sin el drop, correr
-- este schema sobre una base ya migrada dejaria el indice viejo y el UNIQUE no
-- llegaria a crearse nunca.
drop index if exists orders_number_idx;
create unique index if not exists orders_number_idx on orders (order_number);
create index if not exists orders_status_idx  on orders (status);
create index if not exists orders_created_idx on orders (created_at desc);

-- -----------------------------------------------------------------------------
-- order_items — sin `created_at`: el JSON real no lo tiene
-- `type` distingue producto de servicio; product_id y service_id son
-- mutuamente excluyentes en la practica (el JSON siempre tiene uno null)
-- -----------------------------------------------------------------------------
create table if not exists order_items (
  id         integer primary key default nextval('order_items_id_seq'),
  order_id   integer not null references orders (id) on delete cascade,
  product_id integer references products (id) on delete set null,
  service_id integer references services (id) on delete set null,
  name       text    not null,
  price      numeric(14,2) not null,
  quantity   integer not null,
  type       text    not null
);
create index if not exists order_items_order_idx   on order_items (order_id);
create index if not exists order_items_product_idx on order_items (product_id);
create index if not exists order_items_service_idx on order_items (service_id);

-- -----------------------------------------------------------------------------
-- contact_messages — shape tomado del POST /contact (routes/index.js:384)
-- -----------------------------------------------------------------------------
create table if not exists contact_messages (
  id         integer primary key default nextval('contact_messages_id_seq'),
  name       text    not null,
  email      text    not null,
  phone      text,
  subject    text,
  message    text    not null,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists contact_messages_unread_idx on contact_messages (is_read, created_at desc);

-- -----------------------------------------------------------------------------
-- password_resets — shape tomado de forgot-password (authController.js:87)
-- `expires_at` es un ISO string en el JSON, se guarda como timestamptz
-- -----------------------------------------------------------------------------
create table if not exists password_resets (
  id         integer primary key default nextval('password_resets_id_seq'),
  user_id    integer not null references users (id) on delete cascade,
  token      text    not null,
  expires_at timestamptz not null,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists password_resets_user_idx  on password_resets (user_id);
create index if not exists password_resets_token_idx on password_resets (token);
create index if not exists password_resets_used_idx  on password_resets (used, expires_at);

-- -----------------------------------------------------------------------------
-- Ownership de las secuencias
--
-- NO es cosmetico. `create sequence` + `default nextval('x')` NO vincula la
-- secuencia a la tabla: la deja huerfana. Y `TRUNCATE ... RESTART IDENTITY`
-- solo resetea las que tienen `OWNED BY`. Sin esto, `TRUNCATE users` vacia las
-- filas pero el proximo id sigue siendo 1001, 1002, ... y el aislamiento del
-- harness queda roto en silencio (los tests pasan, los ids no cuadran).
-- Se hace explicito y no con `serial`, para que `create sequence` y la tabla
-- queden en el mismo lugar del archivo y el orden sea legible.
-- -----------------------------------------------------------------------------
alter sequence users_id_seq           owned by users.id;
alter sequence categories_id_seq       owned by categories.id;
alter sequence products_id_seq         owned by products.id;
alter sequence services_id_seq         owned by services.id;
alter sequence orders_id_seq           owned by orders.id;
alter sequence order_items_id_seq      owned by order_items.id;
alter sequence contact_messages_id_seq owned by contact_messages.id;
alter sequence password_resets_id_seq  owned by password_resets.id;

-- -----------------------------------------------------------------------------
-- settings — en el JSON es un singleton objeto de 10 claves string.
-- Acá es key/value, que es la misma forma y ademas permite defaults faltantes.
-- `value` es text porque TODO el singleton es string, incluido smtp_port ("587").
-- -----------------------------------------------------------------------------
create table if not exists settings (
  key   text primary key,
  value text not null
);
