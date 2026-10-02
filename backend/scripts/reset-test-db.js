#!/usr/bin/env node
/**
 * Resetea los fixtures de la base de test. Es la capa MANUAL de las tres que
 * cierran el agujero de "una corrida interrumpida dejo basura".
 *
 * Las otras dos, y por que esta no las reemplaza:
 *
 *   1. `tests/helpers.js -> testEmail` / `testDni`: identidad unica por corrida.
 *      Es la capa que hace que la basura SEA INERTE. Sin esta, un residuo con
 *      el mismo email que el fixture de hoy hace que `findByEmail` (order by id
 *      limit 1) resuelva a la fila vieja y la suite valide el usuario
 *      equivocado. Es la unica de las tres que evita el bug, las otras dos
 *      solo lo limpian despues.
 *   2. `tests/helpers.js -> limpiarFixturesColgados`, que corre dentro de
 *      `backupData`: borra los `@test.invalid` ANTES de tomar el snapshot, para
 *      que un residuo no se congele en el snapshot y se reproduzca en cada
 *      restore. Es la capa automatica y por eso es la que realmente cierra el
 *      agujero en el caso normal (Ctrl-C en el proximo `npm test` lo resuelve
 *      solo).
 *   3. Esta: el escape hatch manual, para cuando se quiere ver la base limpia
 *      sin correr los 450s de la suite.
 *
 * POR QUE NO ALCANZA SOLO CON LOS EMAILS UNICOS
 * Un email unico por corrida vuelve el residuo inerte pero NO lo borra: las
 * filas se acumulan para siempre, y con el paso del tiempo la tabla `users` de
 * la base de test queda con miles de filas de nadie. La limpieza automatico de
 * (2) las borra, salvo que la base este tan contaminada que el mismo `npm test`
 * falle antes de llegar al `backupData`.
 *
 * POR QUE ESTE SCRIPT REQUIRE `tests/helpers.js` Y NO `pg` DIRECTO
 * Al requirear helpers queda cargado el guard que fuerza `DATABASE_URL` a la
 * base de test, asi que este script no puede escribir en `postgres` ni aunque
 * alguien lo intente: no es una disciplina del autor, es una propiedad del
 * require. `resetTestDb` ademas vuelve a verificar `current_database()` y
 * aborta si no es la de test.
 *
 * NO borra los pedidos huerfanos: `orders` no tiene columna que marque un
 * pedido como fixture, asi que no se pueden distinguir de uno real sin
 * borrarlos a ciegas. Ver la nota de `resetTestDb` en tests/helpers.js.
 */
require('../tests/helpers')
  .resetTestDb()
  .then(() => console.log('[reset-test-db] listo.'))
  .catch((e) => {
    console.error(`[reset-test-db] fallo: ${e.message}`);
    process.exitCode = 1;
  });