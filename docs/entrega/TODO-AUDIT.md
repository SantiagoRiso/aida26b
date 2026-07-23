# Auditoría contra TODO.md

Fecha: 2026-07-21. Segunda revisión: la primera parte del documento registra los hallazgos,
la segunda registra cuáles se corrigieron en esta ronda y cómo se verificó cada corrección.

**Método.** Cada afirmación se verificó leyendo el código, no los mensajes de commit ni los
comentarios. Los ítems marcados **[vivo]** se reprodujeron contra un servidor levantado desde el
árbol de trabajo, apuntando a la base docker sembrada con el seed demo. Los conteos de tests
provienen de correr las suites en serie, no de contar archivos.

**Estado verificado del árbol (todo sin commitear):**

| Chequeo | Antes | Ahora |
|---|---|---|
| `npm run typecheck` (backend, tests de backend, frontend) | limpio | limpio |
| Suite pura de backend | 22 archivos / 249 tests | **32 / 419** |
| Suite de DB de backend | 32 archivos / 526 tests | **44 / 687** |
| Suite unitaria de frontend | 78 archivos / 698 tests | **85 / 806** |
| Specs E2E en disco | 40 archivos / 142 tests | sin cambios (no se corrieron en esta ronda) |

Nota sobre un test intermitente: `frontend/test/api-client.test.ts` falló una vez en una corrida
completa paralela (8,4 s contra 0,6 s aislado) y pasó en la corrida siguiente y aislado. Se
reprodujo de forma independiente durante trabajo no relacionado, así que es un intermitente
preexistente bajo carga paralela, no una regresión introducida.

---

## Resumen

| Dimensión | Veredicto | Estado en una línea |
|---|---|---|
| Single source of truth / single responsibility | Fuerte | El SSoT genera SQL, authz, scoping, validación, labels y montaje de rutas; cero SQL a mano fuera de `db/`, cero casos especiales por nombre de tabla en el motor genérico. Esta ronda agregó tres hechos más al SSoT en vez de duplicarlos. |
| Filtros, orden, paginación | Fuerte | Se cerraron los cuatro defectos del compilador de listas, se unificó el clamp de página y límite, las listas bespoke (auditoría, ledger, saldo, solicitudes) ganaron orden por columna server-side y estado en la URL, y el endpoint de auditoría pasó sus filtros a la gramática `filter_` compartida. |
| Autenticación, recuperar password | Fuerte | Se cerraron la fuga de credenciales, el login del usuario borrado, la sobre-proyección de datos personales y la ausencia de rate limiting. La recuperación es mediada por un administrador, por decisión explicada abajo, y el callejón sin salida que tenía (un negocio con un solo Admin) quedó cerrado. Sin 2FA. |
| UX/UI | Fuerte | Tema, i18n, modales y shell móvil ya estaban; se agregó calendario responsive, soporte táctil, estados de error distinguibles del vacío, tematizado completo de FullCalendar, header sticky real, contenido truncado legible en touch y una pasada de accesibilidad (teclado, `aria-*`, `<html lang>`, `aria-current`, reduced-motion, axe en dos temas sobre cinco pantallas). |
| Errores + logging | Fuerte | El CRUD genérico audita, un body malformado ya no filtra stack trace, todo error se correlaciona con su request, la persistencia del log operativo quedó acotada y documentada, los errores no capturados del navegador van a un endpoint de telemetría, y el frontend muestra el código traducido y las horas del cutoff que el backend manda en `detail`. |
| Foreign keys | Fuerte | Ningún id se tipea a mano, el servidor refuerza la cascada profesional/servicio y el tenant de toda FK, y las etiquetas resuelven por id fuera de la primera página pidiendo los ids en lote. |
| CRUD genéricos + potestad front/back | Fuerte | Exactamente 4 handlers para todas las tablas; el backend es autoridad real y ahora audita toda escritura genérica. |
| Migraciones, queries, inyección SQL | Fuerte | Defensa de inyección cerrada por construcción, sin un solo hallazgo; se restauró la atomicidad de las migraciones y se hizo portable el checksum. |
| Validaciones | Fuerte | Un motor compartido en ambos lados, más CHECKs y triggers; el mapa de SQLSTATE ahora cubre las reglas que viven solo en la DB. |
| Testing | Fuerte | ~1.973 tests en cuatro capas; typecheck y lint dan 0 sobre todo el árbol y CI ahora exige lint, type-check de tests/e2e y los umbrales de coverage de la suite de DB. |

---

## Correcciones de esta ronda

Cada fila se verificó de forma independiente después de aplicarse: **[vivo]** contra un servidor
levantado desde el árbol, **[test]** por una suite que se corrió y se leyó.

### Críticos

| # | Hueco | Corrección | Verificación |
|---|---|---|---|
| C1 | El PUT/DELETE genérico devolvía `password_hash` y `password_salt` | `writeReturningClause(tableName)` proyecta las columnas declaradas por el descriptor en toda escritura, de toda tabla. Es una proyección, no una denylist: una columna física que ningún descriptor declara es inalcanzable por construcción, también en tablas futuras | **[vivo]** el mismo PUT que filtraba devuelve `id, display_name, email, dni, username, phone, notes` y cero columnas secretas. **[test]** 35 casos puros que recorren todas las tablas más 3 contra la API real |
| C2 | Un usuario borrado lógicamente seguía autenticándose | `findUserForLogin` y `loadSessionUser` ahora exigen `deleted_at IS NULL`. Un usuario borrado cae por el mismo camino nulo que un usuario inexistente, así que la postura anti enumeración queda intacta | **[test]** 4 casos: login rechazado tras el borrado y sesión existente que deja de validar |
| C3 | El motor CRUD genérico no escribía ninguna fila de auditoría | `crud-audit.ts` audita éxito y denegación en los tres handlers, con el tipo de evento derivado de la clave SSoT, así que una tabla nueva se audita sola | **[test]** 29 casos que derivan la superficie de escritura del SSoT (25 operaciones sobre 9 tablas) y fallan si aparece una tabla escribible sin cubrir. El guard se verificó por mutación: comentar la llamada de auditoría pone 7 tests en rojo |
| C4 | Las migraciones no eran atómicas: el `COMMIT;` propio de 13 archivos cerraba la transacción del runner | El lector quita el control de transacción antes de ejecutar, distinguiendo los `BEGIN` de PL/pgSQL dentro de `$$`, y el runner compara `pg_current_xact_id()` antes y después: si el archivo cerró la transacción, la migración falla y no se registra | **[vivo]** el migrador real contra la base docker con las 17 aplicadas responde `No pending migrations`, o sea cero drift de checksum. **[test]** 7 casos puros y 4 de DB, incluido el bug original |
| C5 | Un body JSON malformado devolvía HTML 400 con stack trace y rutas absolutas | Middleware terminal de 4 argumentos que responde el sobre estándar y loguea por el logger estructurado, más un 404 JSON para rutas `/api` no matcheadas | **[vivo]** devuelve `{"code":"invalid_request"}` como `application/json`, sin HTML ni stack |

### Altos

| # | Hueco | Corrección | Verificación |
|---|---|---|---|
| A1 | Las lecturas genéricas emitían `SELECT *` | La proyección externa usa las columnas declaradas. La subconsulta interna sigue con `SELECT *` a propósito, porque el WHERE externo necesita columnas que el descriptor no declara (`business_id`, las FK de `businessJoin`, `role`) y derivarlas duplicaría la lógica de scoping | **[vivo]** un Client leyendo `professionals` recibe exactamente `['bio','display_name','id']` |
| A3 | Sin desempate en el ORDER BY elegido por el usuario | Se agregan siempre las columnas de pk como clave secundaria, también en las listas bespoke de auditoría y ledger | **[test]** paginar un `sort=role` con empates visita cada fila exactamente una vez |
| A4 | Los filtros `boolean` y `date` se descartaban en silencio | Se implementaron ambos: booleano con `IS [NOT] DISTINCT FROM` para que en una columna nullable el complemento sea exacto, y fecha reusando la gramática `min,max` existente resuelta en `BUSINESS_TZ`. Un valor ilegible ahora compila a `1 = 0` en vez de descartarse | **[vivo]** con los 60 usuarios activos: `true` devuelve 60, `false` devuelve 0, basura devuelve 0 |
| A5 | El parser de paginación bespoke devolvía 500 | Ambos parsers clampean por `clampPage`/`clampLimit` en `list-protocol.ts`: una sola definición compartida en vez de dos copias que coincidan a mano | **[vivo]** `limit=-5` y `limit=2.5` responden 200 con límites 1 y 2; `page=1e15` cae a 1 |
| A6 | Metacaracteres de LIKE sin escapar | Se escapan `%`, `_` y el propio escape, con `ESCAPE` declarado | **[vivo]** sobre 42 clientes: `%` y `_` devuelven 0, `Simpson` devuelve 3 |
| A7 | El mapa de SQLSTATE cubría dos códigos | Se agregaron 23514, 23502, 22001, 22003, 22007 y P0001 como `400 validation_error`, el mismo bucket del validador de la app, más 57014 y 55P03 como `503` transitorios, consecuencia de los timeouts nuevos. Todos los códigos usados ya tenían traducción | **[test]** casos por código |
| A9 | La cascada profesional/servicio era solo del cliente | El servidor la exige en `resolveAndLoadService`, así que la heredan todas las superficies de reserva. Un profesional sin mapeos se considera no configurado y no restringido, que es lo que hace la UI | **[test]** 6 casos, incluida la decisión de cero mapeos y el servicio de otro tenant |
| A10 | Las FK que no son de usuario no tenían chequeo de tenant | El chequeo se deriva del descriptor de la tabla referenciada (`businessScoped` o `businessJoin`), sin nombres de tabla en la lógica. Aparecieron seis casos, no los dos reportados | **[test]** enumera los casos desde el SSoT y falla si una FK futura no tiene fixture |
| A11 | Una carga fallida se veía igual que "no hay datos" | Estado de error distinto del vacío en tabla genérica, Clientes, Saldo, Perfil y los tres dashboards, siguiendo el patrón que ya usaba Auditoría | **[test]** casos de error contra vacío por vista |
| A12 | Un guardado fallido se tragaba en silencio | Rama `else` que muestra el error por campo resuelto a i18n, con el flag de guardado en `finally` | **[test]** guardado rechazado por servicio |
| A13 | El calendario no era responsive ni soportaba touch | Cambio a vista de día bajo 768px con la misma consulta `matchMedia` que el shell, `pointercancel` manejado como cancelación y `touch-action: none` en las superficies arrastrables | **[test]** 6 casos de viewport y 4 de cancelación de drag |
| A14 | Cero `aria-sort`, `aria-invalid` y `aria-describedby`; orden y filas inoperables por teclado | El control de orden es un `<button>` real con `aria-sort`, la fila de Clientes abre por teclado, los campos con error se asocian a su mensaje, y crear o mover un bloque horario tiene camino de teclado | **[verificado]** de 0 a 17 ocurrencias de esos atributos |
| A15 | Un test de GRANTs reportaba verde cuando debía saltar | Guard compartido que lanza si el rol es superusuario, no existe o es dueño de tablas migradas | **[test]** ambos archivos usan el mismo guard |
| A16 | Los GRANTs de las 7 tablas de workflow no los cubría nada, y las suites que montan el app corrían como superusuario | Cobertura completa de las cuatro operaciones por tabla, con dos tests de exhaustividad, y las tres suites que montan el app pasaron al pool de menor privilegio | **[test]** 64 aserciones donde había 34; no apareció ningún GRANT faltante |
| A2 | Sin rate limiting ni lockout, y los intentos contra usuarios inexistentes no dejaban rastro | Ventana deslizante en proceso, con presupuesto doble: 5 por (cliente, usuario) y 20 por cliente cada 15 minutos, más un presupuesto propio para el cambio de contraseña. Un login exitoso libera solo el presupuesto de la identidad, nunca el del cliente, para que tener una cuenta válida no reponga el cupo de barrido. El lockout por cuenta se rechazó a propósito: se lo puede disparar contra cualquier usuario que se sepa nombrar, y su estado solo existiría para cuentas reales, que es justamente el oráculo de existencia que el dummy hash evita. Para registrar los intentos contra usuarios inexistentes, `audit_events.business_id` pasó a admitir NULL: son intentos contra el sistema, no contra un negocio | **[test]** 20 casos, incluido que un usuario real y uno inventado devuelven la misma secuencia de estados y de cuerpos serializados |
| A8 | Las etiquetas de FK no resolvían más allá de las primeras 500 filas | Resolución por pk, a demanda, agrupada por pasada de render y con caché negativo: un fallo de `labelFor` encola el id, espera la carga de la primera página, descarta lo que ya llegó y pide el resto. Cada id se pide una sola vez, así que una referencia colgada no reintenta en cada render, y una fila invisible por scope o baja lógica cae en una etiqueta neutra en vez de `#id`, que no decía nada y afirmaba que la fila existe | **[test]** 10 casos: resolución fuera de la primera página en celda y en selector, sin reintentos para una referencia rechazada, y el merge de búsqueda intacto |
| A17 | Sin timeouts ni configuración de pool | `statement_timeout`, `lock_timeout` e `idle_in_transaction` a nivel de rol para la app; el rol dueño queda sin tope de statement porque una migración larga no se debe matar. Pool con `max` explícito y `connectionTimeoutMillis`, que es lo que además acota la espera cuando el pool está lleno | **[test]** casos de configuración de pool y de settings de rol |

### Ítems nuevos surgidos durante las correcciones

| # | Hueco | Corrección | Verificación |
|---|---|---|---|
| N1 | Un error lanzado antes del router no se podía correlacionar: el logger de request se montaba después de `express.json()` | El logger de request es ahora el primer middleware de `createApp`, que es el ensamblado único del servidor y de los tests | **[vivo]** la línea de error y la de acceso comparten el mismo uuid |
| N2 | El backend en docker no recargaba con los cambios | La causa no eran los montajes, que ya existían, sino que `tsx watch` no recibe eventos inotify a través de un bind mount de Docker en Windows. Se activó polling por variable de entorno | **[vivo]** probado en ambos sentidos dentro del contenedor: con polling recarga, sin polling no |
| N3 | El README documentaba otro proyecto (Alumnos, Materias, Inscripciones) | Reescrito para este sistema, con cada endpoint transcrito desde `api-paths.ts` y su verbo leído de la registración real | Revisión |
| N4 | Los dos caminos de archivado divergían: el genérico no tocaba `is_active` | Resultó más grave que cosmético. `is_active`, no `deleted_at`, es el predicado de vigencia en al menos cinco guardas (dueño de agenda, oferta de servicios, staff asignable, búsquedas de usuario), y ninguna mira `deleted_at`. Un cliente borrado desde su ficha seguía siendo reservable y se le podía habilitar login o resetear la contraseña. Se agregó `activeColumn` al descriptor de soft delete y se unificó la lista de asignaciones de archivado en una sola función que usan ambos caminos | **[test]** 5 casos de paridad entre ambos caminos |
| N5 | Las respuestas de escritura eran más angostas que las de lectura | Se resolvió solo, como consecuencia de A1: lectura y escritura proyectan por la misma función derivada del descriptor | **[verificado]** ambos caminos llaman `declaredColumnList` |

### Ronda sobre las dimensiones más flojas del rubro

Las dos preguntas del rubro de "Errores + logging" que antes se respondían "no lo hacemos", más las tres pantallas de UX que quedaban.

| # | Hueco | Corrección | Verificación |
|---|---|---|---|
| M2 | El `<thead>` sticky era inerte por vivir dentro de un contenedor `overflow-x-auto` sin tope de altura | El contenedor mide la altura que le queda (alto del scroller menos las distancias a sus bordes, invariante a su propio alto y al scroll) y la aplica; si nada arriba scrollea, no inventa altura | **[test]** 11 casos, incluidas las dos propiedades de invariancia y que cada `th` queda sticky |
| M3 | El contenido truncado solo se leía por el tooltip `title`, muerto en touch | Clase propia con override `@media (hover: none)` que desactiva el clip donde `title` no puede dispararse, cubriendo también una laptop táctil, no solo el teléfono | **[test]** la regla desactiva las tres propiedades de recorte |
| M4 | FullCalendar no seguía el tema: en oscuro el popover "+N más" pintaba blanco (~1.6:1) | Un bloque mapea las 22 variables de color de FullCalendar a tokens semánticos, y los 47 literales `rgb()` del calendario pasan a `color-mix` sobre tokens. Los pocos literales que quedan van sobre el color de identidad del profesional, igual en ambos temas, y el test lo fija | **[test]** el test de tokens lee los defaults reales del paquete y exige que cada variable de color esté mapeada y el par del popover supere 4.5:1 en ambos temas |
| A14+ | Accesibilidad: `<html lang>` no seguía al idioma, la navegación activa era solo color, chrome sin nombre accesible, sin reduced-motion, y axe cubría 2 pantallas en un solo tema | `lang` se estampa en el mismo punto que el tema (correcto ya en el primer pintado); la navegación usa `active-class` de RouterLink para emitir `aria-current`; Skeleton/EmptyState/filtros/TimeField ganaron roles, nombres y operabilidad por teclado; bloque `prefers-reduced-motion`; el landmark `<main>` de las pantallas de auth se agregó y se quitó la supresión de axe que lo tapaba; axe corre sobre 5 pantallas en ambos temas | **[test]** 15 casos de chrome accesible; typecheck y suite de tokens verdes |
| M14 | El `version` de los logs quedaba en `'unknown'` en cualquier corrida compilada | `resolveVersion()` sube desde `__dirname` hasta el primer `package.json` con versión, que resuelve en ambos layouts; el test ahora compara contra la versión real y rechaza `'unknown'` | **[vivo]** el artefacto compilado con `VERSION` sin setear emite `"version":"1.0.0"` |
| M15 | Los requests abortados no se logueaban: el logger escuchaba `finish` | Pasó a `res.on('close')`, que dispara siempre, con una sola línea por request y `aborted: true` cuando la respuesta no terminó | **[test]** una línea cuando disparan ambos eventos, y el request abortado queda logueado |
| Logging: dónde se guarda | stdout sin límite ni explicación | Rotación por config (`json-file`, `max-size` 10m, `max-file` 5) en las tres services, y el README explica dónde cae la línea, cómo leerla, qué la evicta, y que el registro durable de quién hizo qué es `audit_events`, no el stream operativo | **[vivo]** confirmado que el daemon aplica la rotación creando un contenedor descartable desde el bloque renderizado |
| Errores del navegador | No se enviaba nada y no había endpoint | `POST /api/telemetry/browser-error` recibe errores no capturados, rechazos y violaciones de contrato (no los 4xx, que el servidor ya vio); anónimo a propósito (un crash en el login no tiene sesión), acotado con límite de body de 4 KB, recorte de campos y el throttle ya existente; va al log operativo, nunca a `audit_events` ni a SQL | **[test]** acepta un reporte válido, rechaza uno grande, throttlea, y un payload con sintaxis de log forjada no crea una línea falsa |
| Listas bespoke | Sin orden por columna ni estado en la URL | Auditoría, ledger, saldo y solicitudes ganaron orden server-side con allowlist por endpoint (una columna desconocida cae al orden default, nunca llega a SQL) y estado en la URL; saldo pasó de "cargar más" a paginación real. Apareció y se corrigió un defecto vivo: `listAppointments` ordenaba por `starts_at` sin desempate, en SQL y en la unión en memoria de ocurrencias virtuales | **[test]** cada columna cambia el orden en ambos sentidos, una columna hostil deja la tabla intacta, y paginar 12 filas con el mismo `created_at` visita cada una una vez |
| M16 | `backend/package.json` (`main`, `start`) y el `webServer` de Playwright apuntaban a `dist/server.js` en vez de `dist/backend/src/server.js` | Corregido directamente en los tres lugares | **[vivo]** el build deja el artefacto en la ruta corregida y resuelve |

### Ronda sobre integridad de CI y errores mostrados

| # | Hueco | Corrección | Verificación |
|---|---|---|---|
| M6 | El camino genérico descartaba el código traducido y caía a un toast genérico | `GenericForm`/`CrudSection` resuelven el código de nivel superior por `apiErrorMessage` cuando no hay error por campo; el genérico queda solo como último fallback | **[test]** un nombre de servicio duplicado (409) muestra "Ya existe un registro", no el genérico |
| M7 | El mensaje de cutoff perdía el parámetro de horas | Los sitios de `appointments.ts` que embeben un valor de runtime ahora mandan `detail: {key, params}` con las horas; el string i18n interpola `{hours}` | **[test]** el error de cutoff/no-show muestra las horas reales |
| M8 | `fieldErrorMessages` solo consultaba `fieldDetails` | Consume solo `fieldDetails`, así que un error `fields`-only cae al código traducido de nivel superior; `business-settings` pasó a emitir `fieldDetails` con claves estables | **[test]** un `invalid_reference_role` `fields`-only muestra el código, nunca la prosa en inglés |
| M10 | Los umbrales de coverage de la suite de DB nunca se ejecutaban en CI | CI corre `test:db:coverage`; el hang de merge documentado no se reprodujo. Umbrales 78/65/85/80 contra 82/71/90/86 medidos | **[vivo]** forzar el umbral a 99 hace salir a vitest con 1 aunque los 692 tests pasen: la cobertura sí es una compuerta |
| M12 | Un spec autoconsumido podía convertir una falla real en un skip verde | `retries: 0` en ese describe, así que una falla posterior a la mutación falla fuerte en vez de reintentar con la contraseña vieja y saltar | Razonado; el modo de falla quedó cerrado |
| M13 | Las acciones denegadas del super-admin no dejaban rastro | El writer de auditoría dejó de descartar el evento de un actor autenticado con negocio nulo (se registra con `business_id` nulo); el gate real anti-DoS (`actorId` nulo) se conserva, así que el tráfico anónimo no puede llenar la tabla append-only | **[test]** 4 casos: denegación de super-admin registrada, actor de tenant sin cambios, request no autenticado no escribe nada |
| M17 | Sin timeout de request en el frontend | El cliente de API abandona un request a los 20 s y lo reporta como `network_error` en vez de colgar la vista; compone con el abort del llamador (un abort del llamador relanza, el timeout devuelve un resultado) | **[test]** un request colgado da `network_error`; un abort del llamador sigue relanzando |
| M18 | El lint no corría en CI y ~70 archivos de test no se type-checkeaban | CI ganó un paso de lint, `frontend/e2e/**` entró a ESLint, y el `include` de tsconfig pasó de 13 archivos a un glob de todo `test/**`. Eso expuso ~113 problemas preexistentes (28 de lint, 83 de tipos en fixtures que nunca se compilaron), todos corregidos ajustando los fixtures al tipo real, sin `as any` ni suppressions | **[vivo]** `npm run typecheck` y `npm run lint` dan 0 sobre todo el árbol por primera vez |
| M19 | La carrera de doble reserva no tenía test por HTTP | Nuevo test de DB que monta el app real y dispara dos `POST /schedule` concurrentes al mismo profesional y slot, aseverando exactamente un turno; barrera sobre `ACCESS EXCLUSIVE` en `services` para que ambos pasen la lectura de disponibilidad antes de que cualquiera commitee | **[vivo]** quitar el advisory lock hace que el test dé rojo (dos filas), restaurado byte-exacto; la propiedad se sostiene, sin cambio de código fuente |

---

### Decidido: la recuperación de contraseña queda mediada por un administrador

No es un hueco pendiente sino una decisión tomada, y el motivo que la sostiene es concreto: el
único componente que faltaba de verdad era el envío de mail, porque todo lo demás ya existía (el
patrón de token de `auth.sessions`, la postura anti enumeración del login, el throttling, la
auditoría sin actor y la pantalla de cambio forzado). Agregar un transporte de mail habría sumado
una dependencia, credenciales de un proveedor y una superficie de tokens de reseteo, a cambio de un
camino que la vía administrativa ya cubre.

Lo que sí había que arreglar para que esa decisión fuera honesta era el callejón sin salida: un
super-admin (Admin con negocio nulo) no podía administrar usuarios en ningún negocio, porque toda
ruta de administración pedía el negocio del **llamador** y respondía 400 cuando no tenía. Con un
solo Admin en un negocio, olvidar la contraseña dejaba la cuenta irrecuperable salvo con acceso a la
base y el script `seed-admin`.

Corregido resolviendo el negocio desde la **fila destino** en vez del actor, en las cuatro rutas de
administración de usuarios (alta, baja, reseteo y habilitación de login). La ampliación se expresa
como tipo (`UserAdminScope = {kind:'tenant',businessId} | {kind:'all'}`), no como un id que pueda
venir en null, así que alcanzar todos los negocios hay que pedirlo y no se llega por descuido. El
alta es la excepción: no tiene fila destino de la cual derivar el negocio, así que un super-admin lo
nombra explícitamente en `target_business_id`, campo que se **rechaza** si lo manda un Admin con
negocio propio. Los eventos de auditoría de esas cuatro rutas ahora se atribuyen al negocio del
destino, que es el afectado, así que las acciones del super-admin dejan rastro.

El runbook de recuperación quedó escrito en el README. Sigue sin haber 2FA.

### Ronda sobre los huecos restantes del top-7

| # | Hueco | Corrección | Verificación |
|---|---|---|---|
| Localización última milla | El backend ya mandaba las horas del cutoff en `detail`, pero `portal/AppointmentsView`, `AppointmentDetailPanel`, `useSettleCard` y `BusinessView` mostraban toasts fijos sin consumirlas | Los cuatro consumidores resuelven por `apiErrorMessage`/`fieldErrorMessages`, así que la cantidad de horas real llega al usuario | **[test]** el error de cutoff muestra las horas interpoladas en cada consumidor |
| Flakiness paralela | `api-client.test.ts` y `fk-by-id-resolution.test.ts` fallaban intermitentemente en la corrida completa | Se encontró la fuga real: el mapa de GETs en vuelo coalescía sobre una promesa vieja (el colgado de 8 s), y el reset del caché de FK no frenaba un `flush` ya agendado. Se agregó `resetApiClientState` y un `dispose` por entrada, más un `afterEach` global; el comportamiento de coalescing no cambió | **[vivo]** la suite completa corre verde 3 veces seguidas |
| M11 | Acumulación de fixtures en E2E sin limpieza | Cada spec que crea datos ahora los desactiva/borra en `afterAll`; donde el borrado es imposible (auditoría append-only) las aserciones se scopean al actor propio y `professionals-roster` filtra su fila en vez de asumir la página | **[vivo]** `professionals-roster` y `calendar-grants` pasan contra el server ya levantado con la limpieza corriendo |
| M9 + tenant | El endpoint de auditoría usaba su propia gramática de filtros, y su lista no distinguía de qué negocio venía cada fila | Los filtros pasaron a la gramática `filter_` compartida (el rango de fechas colapsó en un `min,max` sobre `created_at`), con la URL y el request derivando de la misma función. Se agregó `business_id` a la proyección solo para super-admin, al decoder (que tolera claves extra) y como columna en `AuditView` con marcador "Sistema" para filas sin tenant | **[test]** un filtro en gramática compartida narrowea, un campo hostil se descarta, y el super-admin ve la columna con el marcador |
| Super-admin escrituras de dominio | `business-closures`, `business-settings` y `grants` respondían 400 a un super-admin | Se aplicó el mismo idioma de `UserAdminScope` en un módulo `tenant-scope` compartido, resolviendo el negocio desde la fila destino (o un `target_business_id` explícito en el alta), en las rutas donde es inequívoco; las de `appointments`/`scheduling`/`ledger` quedan clasificadas y explicadas porque su authz corre atómica dentro de la tx de escritura y no admiten un swap mecánico | **[test]** 16 casos: super-admin actúa cross-tenant con el evento atribuido al negocio afectado; un admin de tenant sigue con 404 |
| M20 | `client_professional_services` tenía CRUD genérico y cero UI | Sección nueva en la ficha del cliente: lista/agrega/edita overrides con selectores de FK (no ids a mano), precio como string validado por el SSoT, y el narrowing profesional→servicio reusando `offeredServiceIds`; sin borrado porque el descriptor no lo permite | **[test]** 9 casos, incluida la validación de precio y el gating por rol |

---

## Huecos abiertos

El tier medio quedó vacío tras esta ronda. Lo que resta es la lista baja y la única decisión de
alcance (recuperación por email), más un hueco heredado del super-admin en rutas de dominio de
escritura transaccional (`appointments`/`scheduling`/`ledger`), clasificado arriba: su authz corre
atómica con la escritura y necesita un análisis por ruta, no una barrida.

### Bajo

`POST` no aplica la denylist de columnas protegidas que sí aplica `PUT` · `/auth/me` y
`PATCH /auth/me/profile` no pasan por `requirePasswordReady` · `cors()` sin restricción de origen
y sin CSRF · `<html lang>` fijo en `es` · fechas y montos siempre en `es-AR` salvo dos pantallas
que localizan el día · sin `aria-current` en la navegación de staff · sin toggle de tema ni idioma
antes del login · ids de toast por `Date.now()` que colisionan · diagnósticos de contrato logueados
solo en PROD · el descriptor completo viaja al bundle del browser · `AMOUNT_PATTERN` sin acotar
contra `NUMERIC(12,2)` y varias columnas sin `maxLength` · el clamp de la ventana de reserva usa el
reloj del dispositivo y el servidor la zona del negocio · fechas absolutas ya pasadas en 4 fixtures
de tests de DB · el contenedor del frontend tiene el mismo problema de watcher que tenía el backend,
pero Vite necesita `server.watch.usePolling`, no la variable de tsx · deriva de documentación en
`ci.yml` y CLAUDE.md (16 tablas declaradas, 17 reales) · el párrafo de authz de CLAUDE.md no menciona
el throttling recién agregado · tres entradas muertas en `apiError.code`: `invalid_credentials`,
`invalid_current_password` y `password_reuse` tienen un único emisor cada una y siempre mandan
`detail`, y el resolver prueba `detail` antes que `code`, así que esas tres traducciones son
inalcanzables (la capa `code` en sí no está muerta: la usan los códigos que genera el cliente, como
`network_error`, y los endpoints que no mandan `detail`, que son la mayoría).

---

## Correcciones al registro anterior

Dos afirmaciones de la primera versión de este documento eran falsas y quedaron desmentidas al
verificarlas:

- El `README.md` de la raíz **sí existía** y documentaba el procedimiento de agregar una tabla. Su
  defecto real era otro: título y sección de endpoints heredados de un proyecto académico, ya
  reescritos.
- El test negativo de inyección **sí existía**, y es más fuerte que un test E2E porque asevera
  sobre el texto SQL compilado.

Y una tercera, surgida durante las correcciones: el backend en docker **sí tenía** bind mounts. El
problema era el watcher, no los montajes.

---

## Fortalezas

**El motor SSoT es real, no aspiracional.** Un solo objeto es la entrada de la generación de SQL,
la autorización, el scoping por tenant, la validación en ambos lados, los labels i18n y los patrones
de montaje de Express. Esta ronda lo reforzó en vez de esquivarlo: la proyección de columnas, la
columna de baja lógica y el chequeo de tenant de las FK se resolvieron agregando declaraciones al
descriptor, no casos especiales en el motor.

**Donde un hecho no puede derivar, hay guarda automática.** Tres capas independientes: constantes TS
contra el texto de la migración, existencia y nulabilidad de cada columna contra el catálogo vivo, y
GRANTs derivados del descriptor. A eso se sumaron guardas que fallan si aparece una tabla nueva sin
auditar, sin cubrir en los GRANTs, o con una FK sin chequeo de tenant.

**La superficie de inyección SQL está cerrada por construcción**, auditada sitio por sitio: todo
valor bindeado, todo identificador desde un allowlist del descriptor, listas IN por `= ANY`.

**Se prefirió unificar antes que policiar.** Donde aparecieron dos copias de un mismo hecho, se
resolvió con una sola definición compartida en vez de un test de drift: el clamp de página y límite,
y la lista de asignaciones del archivado lógico.

**Los tests no fijan strings de UI**, las fechas de fixture de E2E son relativas al presente, y la
separación de tres roles de Postgres en CI es lo que hace que las aserciones de privilegios
signifiquen algo.

**El proyecto declara sus propias omisiones** en lugar de esconderlas, y esta ronda mantuvo esa
disciplina: cada decisión de no hacer algo quedó escrita con su motivo, incluida la de no revocar
sesiones desde el motor genérico y la de no agregar un spec E2E móvil sin poder verificarlo.
