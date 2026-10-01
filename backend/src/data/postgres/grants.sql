-- =============================================================================
-- Compushop — matriz de GRANTs
--
-- Verificada empíricamente (spikes 0.8 y 0.12). El orden importa: las tablas se
-- crean en schema.sql y las secuencias existen antes que las tablas.
--
-- PARA QUE SIRVE
-- El rol de la app NO puede crear tablas ni schemas. Medido:
--   CREATE SCHEMA -> permission denied for database postgres
--   CREATE TABLE  -> permission denied for schema public
-- `public` pertenece al rol predefinido `pg_database_owner`, que resuelve al
-- dueno de la base. Por eso el rol de la app solo puede hacer DML sobre lo que
-- otro creo y le concedio.
--
-- POR QUE HAY DOS PATRONES Y NO UNO
--   base de la app  -> las tablas son de postgres; compushop_app hace DML.
--                      compushop_test NO tiene porque entrar ahi.
--   base de tests   -> las tablas son de compushop_test (es dueno de la base),
--                      asi que puede correr el schema y hacer TRUNCATE.
--                      compushop_app no puede ni crear tablas ahi.
-- Ver spike 0.12: el unico rodeo para darle ownership a otro rol es que el rol
-- cree la base EL MISMO, porque el pooler no permite SET ROLE
-- (`ALTER ... OWNER TO` -> "must be able to SET ROLE").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Rol de la APP: solo lectura y escritura. Nunca DDL, nunca TRUNCATE.
-- -----------------------------------------------------------------------------
grant usage on schema public to compushop_app;

grant select, insert, update, delete on
  users, categories, products, services,
  orders, order_items, contact_messages, settings, password_resets
  to compushop_app;

-- Necesario para que los INSERT con default nextval() funcionen.
grant usage, select on all sequences in schema public to compushop_app;

-- Para las tablas que se agreguen en el futuro, sin tener que acordarse.
alter default privileges in schema public
  grant select, insert, update, delete on tables to compushop_app;
alter default privileges in schema public
  grant usage, select on sequences to compushop_app;

-- -----------------------------------------------------------------------------
-- Rol de TESTS: DML + TRUNCATE, porque la base de tests es suya.
-- `restart identity` necesita ser dueno de la secuencia, y las tablas las
-- crea el mismo, asi que funciona (medido: last_value vuelve a 1).
-- -----------------------------------------------------------------------------
grant usage on schema public to compushop_test;

grant select, insert, update, delete, truncate on
  users, categories, products, services,
  orders, order_items, contact_messages, settings, password_resets
  to compushop_test;

grant usage, select on all sequences in schema public to compushop_test;

alter default privileges in schema public
  grant select, insert, update, delete, truncate on tables to compushop_test;
alter default privileges in schema public
  grant usage, select on sequences to compushop_test;

-- -----------------------------------------------------------------------------
-- Lo que NO se concede, a proposito
--
-- Ningun rol tiene TRUNCATE en la base de la app: la app no borra tablas, y si
-- un dia alguien lo hace por un bug, wipea datos de produccion.
-- Ningun rol tiene CREATE sobre el schema public en la base de la app: el DDL
-- es un deploy, no una operacion de runtime.
-- compushop_app no tiene CONNECT implicito a la base de tests: Postgres da
-- CONNECT a PUBLIC por default, y ese privilege se puede revocar explicitamente
-- si alguna vez se quiere que el rol de app no llegue ahi. No se revoca ahora
-- porque la app nunca se pasa esa URL y dejarlo abierto no agrega superficie
-- real (la base de tests no tiene datos de produccion).
-- =============================================================================
