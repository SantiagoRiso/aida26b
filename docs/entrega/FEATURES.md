# Inventario de funcionalidades

Sistema de gestión de turnos profesionales (AIDA). Listado exhaustivo de todo lo
implementado, agrupado por área. Cada ítem lleva un identificador estable (`F<área>.<n>`)
para poder referenciarlo desde el guion de demostración (`DEMO.md`) y desde el informe
(`INFORME.md`).

Convención de lectura: "staff" = Admin, Profesional o Recepcionista. "Cliente" = el rol
Client. "Negocio" = tenant (`business_id`).

---

## 1. Arquitectura transversal

| ID | Funcionalidad |
|----|---------------|
| F1.1 | Fuente única de verdad (SSoT): un objeto TypeScript en `shared/src/ssot/` declara las 17 entidades del dominio con sus columnas, tipos, validadores, etiquetas ES/EN, metadatos de filtrado y orden, y políticas de permiso. |
| F1.2 | El SSoT se compila hacia backend y frontend: una sola definición alimenta las rutas, los validadores, las tablas y los formularios. Agregar una tabla no requiere escribir endpoints nuevos. |
| F1.3 | Motor de CRUD genérico: `GET/POST/PUT/DELETE /api/:tabla` se generan en tiempo de ejecución desde el descriptor de cada tabla. |
| F1.4 | Opt-out declarativo: una tabla marcada `protected` queda fuera del CRUD genérico y se opera con rutas a medida (turnos, cuenta corriente, sesiones, auditoría, permisos de calendario, series recurrentes, negocio). |
| F1.5 | Compilador SQL guiado por descriptores: el texto SQL de las operaciones genéricas se arma en `backend/src/db/generic.ts` y `db/scope.ts` a partir del SSoT, nunca escribiendo casos especiales por nombre de tabla. |
| F1.6 | Capa de acceso a datos: todo SQL de dominio vive en `backend/src/db/*.ts` y toda ejecución pasa por `db/core.ts`. Las rutas no contienen SQL. |
| F1.7 | Transacciones centralizadas: `withTransaction` es dueña de BEGIN/COMMIT/ROLLBACK y repropaga el error original para que los errores estructurados sobrevivan. |
| F1.8 | Sin ORM: SQL parametrizado sobre `pg`, con constructores de consulta propios. |
| F1.9 | Tipos derivados del SSoT (`TableRecordMap[T]`, `query-types.ts`). El tipo `unknown` está prohibido en toda la aplicación. |
| F1.10 | Monorepo con tres paquetes (`shared`, `backend`, `frontend`) y un `tsconfig` base común. |
| F1.11 | Rutas de API declaradas una sola vez con constructores de URL; los patrones de Express se derivan de esos constructores para que no puedan divergir. |

---

## 2. Autenticación y sesiones

| ID | Funcionalidad |
|----|---------------|
| F2.1 | Login con usuario y contraseña (`POST /api/auth/login`). |
| F2.2 | Hash de contraseñas con `scrypt`, salt de 16 bytes por usuario, comparación con `timingSafeEqual`. |
| F2.3 | Defensa contra enumeración de usuarios: ante un usuario inexistente igual se ejecuta el `scrypt` contra un hash señuelo, para que el tiempo de respuesta no revele si la cuenta existe. |
| F2.4 | Error de login genérico (401 `invalid_credentials`): nunca distingue usuario inexistente de contraseña incorrecta ni de cuenta desactivada. |
| F2.5 | Sesiones del lado del servidor persistidas en PostgreSQL. En la base se guarda solo el SHA-256 del token, nunca el token. |
| F2.6 | Token de sesión de 32 bytes aleatorios entregado en cookie `aida_session` con `HttpOnly`, `SameSite=Lax`, `Path=/` y `Secure` en producción. No hay tokens en almacenamiento accesible por JavaScript. |
| F2.7 | Vencimiento absoluto de 7 días, con el plazo derivado de una única constante compartida que la sentencia SQL interpola. |
| F2.8 | Revalidación en cada request: la sesión vale solo si no expiró y el usuario sigue activo. |
| F2.9 | Logout idempotente (`POST /api/auth/logout`): borra la sesión, audita el evento y limpia la cookie. |
| F2.10 | Consulta de la sesión actual (`GET /api/auth/me`). |
| F2.11 | Cambio de contraseña propio, con verificación de la contraseña actual, mínimo de 8 caracteres y prohibición de reusar la misma. |
| F2.12 | Al cambiar la contraseña se invalidan todas las demás sesiones del usuario y se conserva solo la actual. |
| F2.13 | Contraseña temporal: los usuarios creados por un administrador nacen con `must_change_password`. |
| F2.14 | Bloqueo total hasta cambiar la contraseña: el guard `requirePasswordReady` responde 403 en todo endpoint protegido salvo cambio de contraseña y logout; el router del frontend fuerza la pantalla bloqueante. |
| F2.15 | Perfil propio consultable y editable (`GET`/`PATCH /api/auth/me/profile`), acotado a la propia fila y con verificación de email único (409 ante duplicado). |
| F2.16 | Guards en cadena `requireAuth` → `requirePasswordReady` → `requireAdmin`, con revalidación adicional de usuario dentro de cada handler (defensa en profundidad). |
| F2.17 | `guardMiddleware` termina el request en el catch sin llamar a `next()`, de modo que un guard que falla nunca puede caer al handler protegido. |

---

## 3. Roles y autorización

| ID | Funcionalidad |
|----|---------------|
| F3.1 | Cuatro roles fijos, uno por usuario: Admin, Profesional, Recepcionista, Cliente. El rol es inmutable después de la creación. |
| F3.2 | Autorización declarativa: cada tabla declara `roleRequired` por operación (`create`, `read`, `update`, `delete`). No hay comprobaciones de rol escritas a mano en las rutas genéricas. |
| F3.3 | Un único punto de decisión (`assertCrudAllowed`) que resuelve visibilidad, rol y alcance para las cuatro operaciones. |
| F3.4 | Semántica de fallo diferenciada: 401 sin sesión, 403 por rol insuficiente, 405 si la tabla no expone esa operación, 404 si la tabla es desconocida o protegida. |
| F3.5 | Ownership declarativo: un Cliente queda confinado a su propia fila; un Profesional a las filas de su propia agenda en escritura. |
| F3.6 | Ownership calibrado por operación: las lecturas de `professionals` no se restringen, porque un cliente necesita el listado completo para poder reservar. |
| F3.7 | Alcance por permiso de calendario: un Recepcionista solo ve y opera los profesionales sobre los que tiene un permiso explícito. Se implementa como filtro de consulta, no como error, de modo que la ausencia de permiso se ve como lista vacía o 404. |
| F3.8 | Guard asíncrono de agenda (`assertOwnScheduleAllowed`): un usuario profesional edita solo su agenda, un usuario administrador cualquiera de su negocio, y un usuario recepcionista solo aquellas sobre las que tiene permiso; las salas son solo de administración. |
| F3.9 | Prohibición de reasignar dueño: si un `PUT` intenta cambiar la clave foránea de dueño de una fila de agenda, responde 403. El dueño para autorizar se lee de la fila existente, nunca del cuerpo del request. |
| F3.10 | Lista negra en el `PUT` genérico sobre `auth.users`: `role`, `password_hash`, `password_salt`, `is_active`, `business_id`, `must_change_password` y las columnas de baja lógica nunca se escriben por la vía genérica, aunque el SSoT lo permitiese. |
| F3.11 | Autorización a medida para cuenta corriente y turnos, que expresa reglas que una lista de roles no puede: por ejemplo, un Profesional puede facturar a sus propios clientes. |
| F3.12 | Registro de accesos denegados: cada rechazo de autorización deja un evento de auditoría con resultado `denied`. |
| F3.13 | El frontend reutiliza el mismo `roleRequired` del SSoT para ocultar menús y botones, pero el backend sigue siendo la autoridad: forzar la URL devuelve 403. |

---

## 4. Multi-tenancy (negocio)

| ID | Funcionalidad |
|----|---------------|
| F4.1 | Todo el esquema está acotado por negocio. El `business_id` vive solo en los dueños directos y se deriva por join donde es alcanzable a través de un padre. |
| F4.2 | El negocio activo se deriva del lado del servidor a partir de la sesión. Un `business_id` en el cuerpo del request es rechazado, nunca sobreescrito en silencio. |
| F4.3 | Súper administrador: un Admin con `business_id` nulo ve todos los negocios. La base lo garantiza con un `CHECK` que solo permite negocio nulo si el rol es Admin. |
| F4.4 | Cierre por defecto: un usuario no administrador sin negocio produce la condición `1 = 0`, es decir, no ve nada, aunque la base lo permitiese. |
| F4.5 | Alcance para tablas con dos posibles dueños (bloques y licencias, que pertenecen a un profesional o a una sala): se generan las dos rutas de join unidas por `OR`. |
| F4.6 | Toda fila de otro negocio responde 404, nunca 403, para no filtrar su existencia. |
| F4.7 | Integridad referencial entre negocios: al insertar o actualizar, se verifica que todas las referencias de una fila apunten al mismo negocio, incluso para súper administradores. |
| F4.8 | Verificación de rol referenciado: una columna declarada `referencesUserRole` obliga a que apunte a un usuario de ese rol exacto, validada en la aplicación y por disparador en la base. |

---

## 5. Usuarios y personas

| ID | Funcionalidad |
|----|---------------|
| F5.1 | Modelo de persona unificado: clientes y profesionales son la misma tabla `auth.users`, discriminada por el rol. No existen tablas `clients` ni `professionals` en la base; son entidades lógicas del SSoT. |
| F5.2 | Vista de lectura sin secretos (`auth.users_directory`): toda lectura genérica de usuarios pasa por ella, de modo que el `SELECT *` del motor genérico no pueda filtrar hashes ni sales. Las escrituras van a la tabla real. |
| F5.3 | Alta de usuario con credenciales, transaccional, con rol asignado en el momento de la creación. |
| F5.4 | Alta de cliente de contacto sin credenciales: un recepcionista puede registrar a alguien que llamó por teléfono sin inventarle usuario ni contraseña. El cliente queda reservable de inmediato pero no puede iniciar sesión. |
| F5.5 | Habilitar acceso más tarde sobre un cliente de contacto, con un guard que impide sobreescribir un login ya existente. |
| F5.6 | Delegación acotada del alta: además del Admin, un Profesional o Recepcionista puede crear usuarios, pero solo con rol Cliente. |
| F5.7 | Baja lógica de usuarios: se desactivan, nunca se borran. La baja limpia todas las sesiones del usuario. |
| F5.8 | Prohibición de autodesactivarse y de autoresetearse la contraseña, para no dejar al negocio sin administrador y no invalidarse la propia sesión. |
| F5.9 | Reseteo de contraseña por el administrador, acotado a su negocio, que fuerza el cambio en el próximo ingreso y elimina las sesiones abiertas. |
| F5.10 | DNI opcional con unicidad por negocio mediante índice único parcial: impide cargar dos veces a la misma persona sin impedir múltiples fichas sin DNI. |
| F5.11 | Edición del perfil propio para el profesional: nombre visible, email, teléfono y biografía. |
| F5.12 | Búsqueda de clientes por nombre o DNI, con filtro para incluir o excluir clientes sin relación previa con el profesional que consulta. |
| F5.13 | Ficha de cliente: datos de contacto, cuenta corriente, turnos pendientes e historial completo con estados y precios. |
| F5.14 | Ficha de profesional: biografía, servicios que ofrece y próximos turnos. |

---

## 6. Catálogo: servicios, precios y salas

| ID | Funcionalidad |
|----|---------------|
| F6.1 | Catálogo de servicios por negocio: nombre, descripción, duración por defecto y precio por defecto. Administrable solo por el Admin. |
| F6.2 | Servicios ofrecidos por profesional: relación explícita entre un profesional y los servicios que presta. |
| F6.3 | Las claves foráneas de esa relación son de solo lectura una vez creadas: reasignar es borrar y volver a crear, nunca editar. |
| F6.4 | Precio y duración por bloque de agenda: un mismo profesional puede cobrar y durar distinto a la mañana que a la tarde. |
| F6.5 | Precio por cliente: tarifa particular para la terna (cliente, profesional, servicio). |
| F6.6 | Cadena de precedencia de precio, resuelta en un único lugar: precio por cliente, luego precio del bloque, luego precio por defecto del servicio. |
| F6.7 | Cadena de precedencia de duración: duración manual de sobreturno indicada por staff, luego duración del bloque, luego duración por defecto del servicio. |
| F6.8 | La misma función resuelve el precio en la vista previa y en el guardado, de modo que lo que el usuario ve nunca puede diferir de lo que se persiste. |
| F6.9 | Precio congelado en el turno al momento de reservar: editar el catálogo después no altera la historia. |
| F6.10 | Formato monetario único: patrón compartido de importe no negativo con hasta dos decimales, aplicado a servicios, overrides, turnos y cuenta corriente. Los importes viajan como cadenas decimales, nunca como punto flotante. |
| F6.11 | Moneda única ARS, garantizada por un `CHECK` en la tabla de negocios. |
| F6.12 | Salas como recursos reservables, con su propio horario semanal y sus propias licencias. |
| F6.13 | Una sala puede asignarse opcionalmente a un turno; se evalúa su disponibilidad y sus superposiciones por separado de las del profesional. |

---

## 7. Agenda: bloques, licencias y feriados

| ID | Funcionalidad |
|----|---------------|
| F7.1 | Horario semanal como filas normalizadas (`schedule_blocks`): un bloque por día de la semana y franja horaria, con dueño profesional o sala pero nunca ambos. |
| F7.2 | Varios bloques por día: mañana y tarde con un hueco de almuerzo en el medio. |
| F7.3 | Granularidad por bloque en lugar de una grilla fija: cada bloque define el tamaño de sus turnos, y ese tamaño puede variar entre la mañana y la tarde. |
| F7.4 | Servicios asignados por bloque, con overrides opcionales de duración y precio. Las salas no tienen servicios: su bloque es una ventana de disponibilidad a secas. |
| F7.5 | Editor visual de horario semanal: se arrastra sobre una columna para crear un bloque, se arrastra el bloque para moverlo y se toma el borde para redimensionarlo. |
| F7.6 | El editor impide superponer bloques del mismo dueño y día, tanto por restricción durante el arrastre como por validación al guardar, sin dejar escrituras parciales. |
| F7.7 | El mismo editor sirve para profesionales y para salas, parametrizado por el tipo de dueño. |
| F7.8 | Licencias (excepciones fechadas) en tres formas: día completo libre, bloqueo parcial de horas, y horario extra fuera del patrón semanal. |
| F7.9 | El horario extra exige una granularidad propia, garantizada por un `CHECK` en la base. |
| F7.10 | Aviso previo al crear una licencia: se calcula cuántos turnos van a quedar en conflicto en esa fecha y se pide confirmación explícita antes de guardar. |
| F7.11 | Las licencias nunca cancelan turnos automáticamente: los marcan en conflicto, lo cual es reversible. |
| F7.12 | Feriados y cierres del negocio: excepciones con un tercer tipo de dueño, el negocio, que bloquean a todos los profesionales a la vez. |
| F7.13 | Los cierres se administran por una ruta a medida, solo para el Admin, que estampa el negocio desde la sesión. El motor genérico no puede crear un cierre. |
| F7.14 | Un `CHECK` garantiza que toda licencia tenga exactamente uno de sus tres dueños posibles. |

---

## 8. Disponibilidad y generación de horarios

| ID | Funcionalidad |
|----|---------------|
| F8.1 | La disponibilidad se computa, nunca se almacena: bloques semanales, menos licencias, menos cierres del negocio, menos lo ya reservado. |
| F8.2 | El motor es una función pura sin acceso a base de datos ni al reloj, lo que la hace testeable de forma exhaustiva. |
| F8.3 | Generación de horarios específicos por servicio: cada bloque se divide en turnos consecutivos del tamaño que corresponde a ese servicio, medidos desde el inicio del bloque. |
| F8.4 | Solo sobreviven los horarios que entran enteros en la ventana disponible: no se ofrece un turno que se pasaría del borde del bloque. |
| F8.5 | Ventanas libres sin dividir para el calendario de staff, que no tiene un servicio elegido y necesita ver la forma cruda de la jornada. |
| F8.6 | Superposición con final excluyente: un turno de 11:00 a 12:00 no choca con uno de 12:00 a 13:00. |
| F8.7 | Zona horaria de Argentina fijada en el dominio, con un test que recalcula el desplazamiento real y falla si el país reinstaurara el horario de verano. |
| F8.8 | Endpoint de disponibilidad con consulta por día o por rango, con el rango limitado a 42 días y reservado para staff. |
| F8.9 | Distinción entre "no atiende ese día" y "atiende pero está lleno", para poder dar mensajes distintos. |
| F8.10 | Exclusión del propio turno al consultar disponibilidad durante una reprogramación, para que un turno no se bloquee a sí mismo. |
| F8.11 | Ventana de reserva en dos niveles: anticipación mínima y máxima del negocio, con override opcional por servicio de cada profesional. |
| F8.12 | La ventana limita solo las solicitudes de clientes; el staff está exento. El selector de fecha del portal se acota a esa ventana. |
| F8.13 | Las salas se dividen a una granularidad fija de 30 minutos, únicamente para el sombreado visual; su conflicto real se evalúa por contención. |

---

## 9. Turnos y ciclo de vida

| ID | Funcionalidad |
|----|---------------|
| F9.1 | Un turno es una sola fila con estado. No hay tabla separada de solicitudes. |
| F9.2 | Seis estados: solicitado, programado, completado, cancelado, ausente, rechazado. |
| F9.3 | Mapa de transiciones cerrado, declarado una sola vez: solicitado va a programado, rechazado o cancelado; programado va a completado, cancelado o ausente. Los estados terminales nunca vuelven atrás. |
| F9.4 | Doble aplicación de la máquina de estados: validación en la aplicación con error 422, y disparador en la base como red de contención. |
| F9.5 | El frontend consume el mismo mapa de transiciones para mostrar solo los botones legales en cada estado. |
| F9.6 | Cálculo de la hora de fin por disparador en cada alta o modificación, no como columna generada, porque la aritmética sobre `timestamptz` no es inmutable en PostgreSQL. |
| F9.7 | Solicitud de turno por el cliente: siempre nace en estado solicitado, sin posibilidad de forzar conflictos, sin elegir sala y sin fijar duración. |
| F9.8 | El cliente de la solicitud es siempre el usuario de la sesión; un `client_user_id` en el cuerpo se ignora. |
| F9.9 | Alta directa por staff, que crea el turno ya programado. |
| F9.10 | Aprobación de solicitud, que vuelve a verificar conflictos porque el horario pudo tomarse desde que se pidió. |
| F9.11 | Reprogramación por staff: puede cambiar profesional, servicio, sala, fecha, hora y duración, con reverificación transaccional y recálculo de precio y duración. |
| F9.12 | En la reprogramación la autorización se evalúa antes que el estado, para que un usuario no autorizado no pueda deducir el estado de un turno comparando un 403 con un 422. |
| F9.13 | Cancelación por el cliente sujeta a un plazo configurable por negocio, con valor por defecto de 24 horas. |
| F9.14 | Una solicitud aún no confirmada se puede retirar en cualquier momento; el plazo aplica solo a los turnos ya programados. |
| F9.15 | El staff cancela sin plazo. |
| F9.16 | Marcar completado exige que el turno ya haya empezado. |
| F9.17 | Marcar ausente exige haber entrado en la misma ventana en la que el cliente ya no puede cancelar. |
| F9.18 | Las tres reglas anteriores son funciones puras compartidas: el backend las aplica y el portal las usa para deshabilitar los botones, de modo que no puedan discrepar. |
| F9.19 | Cargo automático e idempotente al completar: se registra el cargo de la sesión al precio congelado, mediante un `INSERT ... WHERE NOT EXISTS` que impide duplicarlo. Un ausente nunca genera cargo. |
| F9.20 | Edición cosmética separada de la reprogramación: cambiar nombre o descripción no dispara reverificación de conflictos. |
| F9.21 | Congelamiento terminal: en un turno cerrado solo se puede editar la nota interna del staff. Cualquier otro campo devuelve 422. |
| F9.22 | Nota interna del staff, nunca visible para el cliente, editable en cualquier estado. |
| F9.23 | Filtrado de campos internos en toda respuesta dirigida a un cliente. |
| F9.24 | Listado de turnos con alcance automático por rol, y filtros por rango de fechas, profesional, sala, cliente, estado y presencia de conflicto. |
| F9.25 | Un cliente no puede acceder al detalle de un turno por endpoint dedicado; ve solo lo suyo a través del listado filtrado y de la disponibilidad opaca. |
| F9.26 | Consulta de clientes relacionados, que devuelve solo los identificadores para no volcar el historial completo al navegador. |
| F9.27 | Tarjeta de cierre de turno en el panel de inicio: registrar pago, registrar atención sin pago o marcar ausente, en una sola acción. |

---

## 10. Conflictos y sobreturno

| ID | Funcionalidad |
|----|---------------|
| F10.1 | Motor de conflictos como función pura, con seis clases: superposición de profesional, superposición de sala, falta de disponibilidad del profesional, falta de disponibilidad de la sala, choque con una solicitud pendiente, y desalineación con la grilla de horarios. |
| F10.2 | La API devuelve códigos de conflicto y datos estructurados, nunca un texto de pantalla. El frontend traduce a español o inglés. |
| F10.3 | Vista previa sin guardar (`POST /api/conflict-check`), que además devuelve el precio y la duración efectivos. |
| F10.4 | La vista previa es honesta: siempre reporta el conflicto y se limita a informar si el usuario podría forzarlo. El forzado se aplica solo en el guardado real. |
| F10.5 | Reverificación transaccional: la misma función y el mismo agregador se ejecutan de nuevo dentro de la transacción de guardado, de modo que el veredicto del guardado es idéntico al de la vista previa. |
| F10.6 | Bloqueo consultivo por dueño (`pg_advisory_xact_lock`) tomado antes de leer el estado, con espacios de nombres separados para profesionales y salas. Dos reservas concurrentes sobre el mismo profesional se serializan; sobre profesionales distintos siguen en paralelo. |
| F10.7 | Sobreturno: el staff puede forzar cualquier clase de conflicto con una confirmación booleana explícita, obteniendo un turno fuera de grilla y superpuesto. |
| F10.8 | La desalineación con la grilla es simplemente otra clase de conflicto: bloquea al cliente y es forzable por el staff. No existe una vía paralela de duración libre. |
| F10.9 | Un forzado redundante sobre un horario limpio no marca el turno como sobreturno. |
| F10.10 | Registro de quién forzó, en dos lugares: el turno guarda el indicador de sobreturno y el identificador del autorizante, y la auditoría recibe un evento `conflict_override` propio, separado del evento de la operación, con el detalle de cuál fue (agendar, aprobar o reprogramar). Un forzado se puede filtrar sin saber de antemano qué operación lo produjo. |
| F10.11 | Aviso antes de confirmar en todos los caminos: alta, aprobación, reprogramación y arrastre en el calendario muestran el conflicto y exigen una segunda confirmación. Nunca se guarda en silencio ni se responde con un rechazo duro. |
| F10.12 | Marca de conflicto calculada sobre turnos existentes: un turno futuro y abierto que cae dentro de una licencia o un feriado se muestra en conflicto. |
| F10.13 | Ignorar y reactivar el aviso de conflicto, con ambos eventos auditados. |
| F10.14 | Panel de triage de conflictos en el inicio, con acciones directas de ignorar, aprobar, reprogramar o cancelar. |

---

## 11. Turnos recurrentes

| ID | Funcionalidad |
|----|---------------|
| F11.1 | Se guarda la regla una sola vez, no las ocurrencias. Las ocurrencias son virtuales hasta que algo real les pasa. |
| F11.2 | Tres patrones: semanal cada N semanas, mensual por día de la semana (por ejemplo el tercer lunes o el último), y mensual por día del mes. |
| F11.3 | Tres formas de fin: cantidad de ocurrencias, fecha límite, o serie abierta sin fin. |
| F11.4 | La serie abierta no requiere ningún proceso de fondo ni horizonte de materialización: no hay tarea programada ni crecimiento ilimitado de filas. |
| F11.5 | Integridad de forma garantizada por `CHECK`: un patrón semanal obliga a tener día de la semana y prohíbe las columnas mensuales, y así con cada combinación. Lo mismo para las tres formas de fin. |
| F11.6 | Expansión pura y determinista, sin base de datos ni reloj. |
| F11.7 | Las fechas inexistentes se saltean en lugar de recortarse: un patrón de día 31 omite febrero, siguiendo la convención de los calendarios estándar. |
| F11.8 | El conteo de ocurrencias se resuelve desde la fecha de inicio, no desde la ventana consultada, para que una expansión parcial no descuadre el total. |
| F11.9 | Materialización al primer contacto: completar, cancelar, mover, marcar ausente, editar la nota o forzar un conflicto convierte la ocurrencia en una fila real, que a partir de ahí prevalece sobre su gemela virtual. |
| F11.10 | Índice único parcial sobre (serie, fecha de ocurrencia) que garantiza que una serie materialice a lo sumo un turno por fecha. |
| F11.11 | Materialización idempotente y segura ante concurrencia: se apoya en el bloqueo consultivo que ya toma la reverificación y, ante una violación de unicidad simultánea, vuelve a leer y devuelve el ganador. |
| F11.12 | Las ocurrencias virtuales ocupan horario a efectos de disponibilidad y de conflictos, usando un identificador centinela negativo que nunca puede colisionar con un identificador real. |
| F11.13 | Una ocurrencia cancelada libera su horario; una movida ocupa el nuevo. |
| F11.14 | Tres alcances de edición: solo esta ocurrencia, esta y las siguientes (que cierra la serie y abre una nueva), y toda la serie. |
| F11.15 | Precio y duración congelados en la serie al crearla. Un cambio de precio nunca es automático: exige una edición deliberada con alcance explícito. |
| F11.16 | Vista previa de conflictos al crear la serie, acotada a los próximos 56 días, para que una serie abierta no dispare un recorrido ilimitado. |
| F11.17 | Las ocurrencias en conflicto se crean igual y se marcan, en lugar de saltearse en silencio. |
| F11.18 | Las series se terminan cambiando su estado, nunca se borran. Al terminarlas se cancelan las ocurrencias ya materializadas que sigan abiertas. |
| F11.19 | El cliente ve sus ocurrencias recurrentes en el portal en modo de solo lectura, con un horizonte de 90 días. |
| F11.20 | Las ocurrencias virtuales se distinguen visualmente en el calendario. |

---

## 12. Permisos de calendario

| ID | Funcionalidad |
|----|---------------|
| F12.1 | Permiso binario: la sola existencia de la fila (profesional, autorizado) habilita a operar ese calendario. No hay columnas de permisos por acción. |
| F12.2 | Lo que el autorizado puede hacer lo determina su propio rol, no el permiso. |
| F12.3 | Revocar es eliminar la fila. Por eso la tabla no tiene baja lógica y el rol de aplicación no recibe permiso de actualización sobre ella. |
| F12.4 | El autorizado puede ser Recepcionista o Profesional: un profesional puede cubrir el calendario de otro. |
| F12.5 | Un usuario profesional administra únicamente los permisos sobre su propio calendario; un usuario administrador sobre cualquiera de su negocio; un usuario recepcionista sobre ninguno. |
| F12.6 | Al listar, un Profesional queda forzado a su propio identificador aunque envíe otro por parámetro. |
| F12.7 | Un Cliente no puede consultar quién administra qué calendario. |
| F12.8 | Toda la lógica que sabe la forma de la tabla vive en un único módulo, y todas las verificaciones basadas en permisos pasan por ahí. |
| F12.9 | Los permisos gobiernan cinco superficies: acciones sobre turnos, edición de agenda, escritura en cuenta corriente, lectura de cuenta corriente y visibilidad de turnos y series. |
| F12.10 | Interfaz de administración de permisos reutilizada en dos lugares: la sección de administración de staff del hub de Negocio y el panel del propio profesional. |
| F12.11 | Alta, baja y listado auditados, incluidos los intentos denegados. |

---

## 13. Cuenta corriente

| ID | Funcionalidad |
|----|---------------|
| F13.1 | Libro inmutable: los movimientos no se editan ni se borran. Las correcciones son movimientos nuevos. |
| F13.2 | Cuatro tipos de movimiento: cargo y ajuste de débito (aumentan la deuda), pago y ajuste de crédito (la reducen). |
| F13.3 | Los importes son siempre positivos; la dirección la determina el tipo. |
| F13.4 | El saldo se calcula al leer, sumando débitos y restando créditos. Nunca hay una columna de saldo almacenado. |
| F13.5 | Los arrays de tipos de débito y crédito se declaran una sola vez en el SSoT y la consulta SQL los consume, en lugar de repetir literales. |
| F13.6 | Inmutabilidad garantizada en dos capas: un disparador que rechaza actualizaciones y borrados con un mensaje explícito, y un rol de aplicación que solo tiene permiso de inserción y lectura. |
| F13.7 | Pagos sin asignar a un turno concreto, lo que permite pagos parciales y múltiples de forma natural. |
| F13.8 | Varios cargos pueden referenciar un mismo turno, lo que habilita facturación de varias líneas por sesión. |
| F13.9 | Ningún efecto financiero automático derivado de un cambio de estado: un cargo sobre un turno cancelado permanece, y las devoluciones o condonaciones se hacen con un ajuste de crédito explícito. |
| F13.10 | Prellenado del importe desde el precio congelado del turno cuando el cargo lo referencia, con la restricción de que el turno pertenezca a ese cliente en ese negocio. |
| F13.11 | Matriz de escritura: un usuario administrador factura a cualquiera; un usuario profesional a sus propios clientes con cualquier tipo de movimiento; un usuario recepcionista solo cargos y pagos, y solo atados a un turno de un calendario sobre el que tiene permiso; un usuario cliente nunca escribe. Los tipos que puede usar un usuario recepcionista se declaran una sola vez en el SSoT (`RECEPTIONIST_ENTRY_TYPES`) y los leen tanto la verificación del servidor como el formulario. |
| F13.12 | La autorización de escritura se ejecuta dentro de la misma transacción que la inserción, de modo que no exista una ventana entre verificar el permiso y escribir. |
| F13.13 | Matriz de lectura simétrica a la de escritura, con la excepción de que un cliente desactivado conserva su historial legible. |
| F13.14 | Consulta de saldo y consulta de movimientos paginada, ambas como rutas dedicadas. |
| F13.15 | El cliente ve su saldo y sus movimientos en modo de solo lectura en el portal, con carga incremental. |
| F13.16 | Índice compuesto por cliente y fecha descendente para la ruta de lectura. |

---

## 14. Auditoría

| ID | Funcionalidad |
|----|---------------|
| F14.1 | Registro de eventos de solo agregado, con actor, negocio, tipo y identificador de entidad, acción, resultado, fecha y detalles. |
| F14.2 | Inmutabilidad garantizada por disparador y por permisos: el rol de aplicación solo puede leer e insertar. |
| F14.3 | Escritura dentro de la misma transacción que la acción para todas las mutaciones de ciclo de vida, cuenta corriente y series: una acción no puede quedar registrada sin su evento. |
| F14.4 | Escritura de mejor esfuerzo para eventos periféricos como el login, donde un fallo de auditoría no debe romper el request. |
| F14.5 | Tres resultados posibles: éxito, fallo y denegado. Los intentos rechazados quedan registrados. |
| F14.6 | Registro de la dirección IP del cliente, con el servidor configurado para confiar en un único salto de proxy. |
| F14.7 | Un login fallido se atribuye a la cuenta intentada; un intento contra un usuario inexistente no se registra, porque no hay negocio al que atribuirlo. |
| F14.8 | Consulta de auditoría solo para administradores, acotada al negocio de la sesión, con filtros por tipo de entidad, actor, tipo de evento, resultado y rango de fechas. |
| F14.9 | Solo se interpolan nombres de columna controlados por código; todo valor de filtro va parametrizado. |
| F14.10 | Los eventos denegados se destacan visualmente en la tabla. |
| F14.11 | Cobertura amplia de eventos: autenticación, gestión de usuarios, ciclo de vida de turnos, series, cuenta corriente, permisos de calendario, cierres y cambios de configuración del negocio. |
| F14.12 | Índice compuesto por negocio y fecha descendente. |

---

## 15. Portal del cliente

| ID | Funcionalidad |
|----|---------------|
| F15.1 | Área funcional separada del espacio de trabajo del staff, con su propia navegación y su propio conjunto de pantallas. |
| F15.2 | Listado de próximos turnos y de historial, con estado, profesional, duración y precio. |
| F15.3 | Calendario propio en modo de solo lectura, sin arrastre ni redimensionado. |
| F15.4 | Solicitud de turno en tres pasos: elegir profesional y servicio, elegir fecha y horario, revisar el costo estimado y confirmar. |
| F15.5 | Buscador de profesional por nombre, servicio o especialidad, con las opciones ordenadas por uso reciente. |
| F15.6 | Solo se ofrecen horarios reservables. El tiempo ocupado es opaco: el cliente no ve de quién es el turno que bloquea. |
| F15.7 | Se muestra el precio efectivo antes de confirmar, presentado como costo estimado y no como factura. |
| F15.8 | El selector de fecha se acota a la ventana de reserva vigente. |
| F15.9 | Retiro de solicitud sin plazo y cancelación de turno programado sujeta al plazo, con el botón deshabilitado y el motivo explicado cuando el plazo venció. |
| F15.10 | Consulta de saldo con indicación clara de si la cuenta está al día o tiene deuda. |
| F15.11 | Preferencias propias con selector de idioma, porque el cliente no llega a la configuración del negocio. |

---

## 16. Interfaz derivada del SSoT

| ID | Funcionalidad |
|----|---------------|
| F16.1 | Tabla genérica que se arma desde los metadatos: título, columnas, orden, filtros, paginación y acciones. |
| F16.2 | Formulario genérico que elige el control por tipo de columna: área de texto, selector de clave foránea, selector de opciones, número, email, fecha o texto. |
| F16.3 | Marca de campo obligatorio y validación en línea al perder el foco, usando el mismo validador que aplica el backend. La validación del navegador es orientativa: la autoridad sigue siendo el servidor. |
| F16.4 | Las claves foráneas se editan con un selector de opciones, no tipeando el identificador. |
| F16.5 | Las opciones de una clave foránea pueden depender de otra selección: los servicios ofrecidos se filtran por el profesional elegido. |
| F16.6 | En las tablas, las claves foráneas se muestran resueltas a su nombre en lugar del identificador, con las opciones cargadas una vez por tabla y memorizadas para no disparar una consulta por fila. |
| F16.7 | Si una referencia no se encuentra, se muestra el identificador atenuado en lugar de dejar la celda vacía, para no perder el dato en silencio. |
| F16.8 | Se ocultan la clave primaria y las columnas derivadas del servidor. |
| F16.9 | Filtros por columna con negación, rangos numéricos, selectores de enumeración y búsqueda de texto. |
| F16.10 | Orden por columna y paginación con total de registros. |
| F16.11 | Navegación filtrada por rol, derivada del mismo mapa de acceso que usan los guards del router. |
| F16.12 | Precarga de rutas al pasar el puntero por un elemento del menú. |
| F16.13 | Convenciones compartidas de carga, estado vacío y error, con esqueletos de carga, componente de estado vacío, errores por campo y avisos emergentes para errores generales. |
| F16.14 | Manejo suave de la expiración de sesión: se avisa, se bloquean las acciones y se redirige al login recién en la siguiente navegación, sin tirones. |
| F16.15 | Manejo diferenciado del rechazo por permisos: aviso específico y permanencia en la vista, sin caída de la aplicación. |
| F16.16 | Componentes accesibles construidos sobre una biblioteca headless: diálogos, menús, listas de selección, pestañas y ventanas emergentes. |
| F16.17 | Campos de fecha y hora propios, alineados a la granularidad del bloque en lugar de a una grilla fija. |
| F16.18 | Panel lateral de detalle reutilizable en varios tamaños, y diálogo de confirmación estándar para toda acción destructiva. |

---

## 17. Calendario

| ID | Funcionalidad |
|----|---------------|
| F17.1 | Calendario construido sobre la versión libre de FullCalendar, con vistas de día, semana y mes, y semana como vista por defecto. |
| F17.2 | Rango horario dinámico: parte de 07:00 a 21:00 y se ensancha si hay turnos fuera de ese rango. |
| F17.3 | Contenido acotado por el observador, no por un conmutador global: el profesional ve el propio y los que le fueron delegados, el cliente los suyos, el staff todos los de su alcance. |
| F17.4 | Todos los profesionales en una sola grilla con código de color estable por identificador, más chips de filtro por profesional y por sala. |
| F17.5 | Creación de turno haciendo clic o arrastrando sobre un espacio libre, con la fecha, la hora y el profesional ya cargados. |
| F17.6 | Arrastre propio en la vista de día y semana, porque la biblioteca solo puede desplazar por saltos uniformes y la agenda tiene granularidad variable por bloque. |
| F17.7 | Con el modo sobreturno apagado, el bloque se acomoda a los horarios reales del profesional y se resaltan solo los destinos donde la duración completa entra. |
| F17.8 | Con el modo sobreturno encendido, el bloque se ubica en cualquier horario con pasos finos. |
| F17.9 | Soltar fuera de un destino válido revierte el movimiento y avisa, en lugar de teletransportar el turno al horario más cercano. |
| F17.10 | Redimensionar para cambiar la duración, con la misma validación que una edición por formulario. |
| F17.11 | Toda reprogramación por arrastre pide confirmación con el horario destino explícito. |
| F17.12 | Rechazo temprano de movimientos que cruzarían la medianoche, sin ida y vuelta al servidor. |
| F17.13 | Capas de fondo que distinguen horario disponible, ocupado, solicitado, pasado, fuera de horario, licencia por tipo y feriado del negocio. |
| F17.14 | Distintivos visuales por sobreturno, conflicto, ocurrencia recurrente y estado solicitado, y atenuado con tachado para los estados terminales. |
| F17.15 | Los estados cancelado y rechazado no se dibujan. |
| F17.16 | Panel de detalle con las acciones válidas para el estado y el rol, derivadas del mapa de transiciones. |
| F17.17 | En la vista de mes, los días sin disponibilidad se muestran en gris y no son seleccionables. |

---

## 18. Internacionalización

| ID | Funcionalidad |
|----|---------------|
| F18.1 | Toggle real de español e inglés que cambia las etiquetas visibles en todas las pantallas. |
| F18.2 | Modelo híbrido: los nombres de entidades, columnas, estados, roles y tipos de movimiento vienen del SSoT; los textos de la interfaz vienen del diccionario de vue-i18n. Ambos leen un único idioma reactivo. |
| F18.3 | Los datos cargados por el usuario nunca se traducen: se muestran tal como fueron tipeados. |
| F18.4 | Español por defecto, preferencia persistida por dispositivo. |
| F18.5 | El diccionario en inglés está tipado contra el español, de modo que una clave faltante rompe la compilación. |
| F18.6 | Los mensajes de conflicto se arman en el cliente a partir de códigos, lo que mantiene la API neutral respecto del idioma. |
| F18.7 | Selector de idioma disponible tanto en la configuración del staff como en las preferencias del portal del cliente. |

---

## 19. Integridad de datos en la base

| ID | Funcionalidad |
|----|---------------|
| F19.1 | Disparador que calcula la hora de fin de cada turno. |
| F19.2 | Disparador que valida las transiciones de estado de turnos. |
| F19.3 | Disparador que prohíbe modificar o borrar movimientos de cuenta corriente. |
| F19.4 | Disparador que prohíbe modificar o borrar eventos de auditoría. |
| F19.5 | Disparador genérico y reutilizable, parametrizado por argumentos, que verifica que cada clave foránea hacia usuarios apunte a un usuario del rol correcto. Está aplicado ocho veces. |
| F19.6 | Disparador que verifica que el profesional desnormalizado en los servicios de un bloque coincida con el dueño del bloque, y que rechaza asignar servicios a bloques de sala. |
| F19.7 | Restricciones de un solo dueño: los bloques tienen profesional o sala, y las licencias tienen exactamente uno de tres dueños posibles. |
| F19.8 | Restricción que solo permite negocio nulo si el rol es Admin. |
| F19.9 | Restricciones de coherencia de baja lógica: no puede haber autor de la baja sin fecha de baja. |
| F19.10 | Restricciones de orden temporal y de valores no negativos en horarios, duraciones, precios, plazos y ventanas de reserva. |
| F19.11 | Restricciones de forma para las reglas de recurrencia, que hacen imposible persistir una regla incoherente. |
| F19.12 | Índices únicos, incluidos parciales: DNI por negocio solo cuando hay DNI, y ocurrencia de serie solo cuando el turno pertenece a una serie. |
| F19.13 | Nombre de usuario único que admite múltiples nulos, lo que permite clientes sin credenciales sin romper la unicidad de los que sí las tienen. |
| F19.14 | Desactivación del conversor de fechas de la biblioteca de PostgreSQL, porque devolvía un objeto que al serializar corría el día calendario en clientes fuera de UTC. |

---

## 20. Migraciones y roles de base de datos

| ID | Funcionalidad |
|----|---------------|
| F20.1 | Migraciones SQL hacia adelante, numeradas por marca de tiempo y validadas por expresión regular. |
| F20.2 | Verificación por suma de comprobación: modificar una migración ya aplicada produce un error explícito. Deshacer un cambio se hace escribiendo una migración nueva. |
| F20.3 | Bloqueo consultivo durante la corrida, de modo que dos instancias no puedan migrar a la vez. |
| F20.4 | Cada migración corre en su propia transacción con reversión ante fallo. |
| F20.5 | Modelo de dos roles: un rol dueño que posee los objetos y ejecuta las migraciones, y un rol de aplicación que recibe permisos explícitos por tabla. |
| F20.6 | Los permisos amplios por defecto se revocan en la primera migración, de modo que el rol de aplicación reciba solo lo que se le concede en forma explícita. |
| F20.7 | Permisos calibrados por tabla: sin borrado donde hay baja lógica, solo lectura e inserción en las tablas de solo agregado, sin actualización donde no hay baja lógica, y sin alta ni baja sobre la tabla de negocios. |
| F20.8 | Los bloques de concesión de permisos están envueltos en comprobaciones de existencia del rol, para que el proyecto también funcione en un entorno de un solo rol. |
| F20.9 | Quince migraciones que documentan la evolución del esquema, incluida la normalización del horario semanal desde un campo JSON hacia filas, con relleno de datos y baja de la tabla anterior en la misma migración. |
| F20.10 | Semillas fuera del historial de migraciones, escritas en TypeScript e idempotentes, ejecutadas con el rol dueño. |
| F20.11 | Semilla de demostración con reinicio destructivo opcional, que trunca y vuelve a sembrar preservando el historial de migraciones. |

---

## 21. API, errores y observabilidad

| ID | Funcionalidad |
|----|---------------|
| F21.1 | Sobre de respuesta único: éxito con datos y metadatos opcionales, error con código, mensaje y errores por campo. |
| F21.2 | Los listados siempre incluyen página, límite y total. |
| F21.3 | Mapeo centralizado de códigos de PostgreSQL a HTTP: violación de unicidad a 409, violación de clave foránea a 400. |
| F21.4 | El error de base de datos conserva el nombre de la restricción, lo que permite dar un mensaje distinto según qué índice único se violó. |
| F21.5 | Errores de aplicación que llevan su propio mapeo HTTP y sobreviven al abandono de una transacción. |
| F21.6 | Red de contención para código asíncrono en Express, ya que una promesa rechazada mataría el proceso. |
| F21.7 | Rechazo de campos derivados del servidor con error 422 y detalle por campo. |
| F21.8 | Validador compartido que exige que el cuerpo del request tenga exactamente los campos permitidos: ni de menos ni de más. |
| F21.9 | Validación por tipo, entero, patrón con mensaje propio, longitud, rango, opciones de enumeración y fechas relativas al día argentino. |
| F21.10 | Las columnas actualizables se derivan de las creables quitando las de solo lectura en edición, y ese mismo conjunto lo consume el constructor del `UPDATE`, de modo que validación y escritura no puedan divergir. |
| F21.11 | Los filtros solo se construyen sobre columnas declaradas filtrables, y el orden solo sobre columnas declaradas ordenables. Lo demás se ignora en silencio. |
| F21.12 | Las claves foráneas y las enumeraciones filtran por igualdad exacta, no por coincidencia parcial, porque una búsqueda de subcadena sobre un identificador haría que 1 coincidiera con 10 y con 21. |
| F21.13 | Paginación acotada: página entre 1 y 1000, límite entre 1 y 500 con valor por defecto 50, con la misma política en las rutas a medida. |
| F21.14 | Conteo total en la misma consulta mediante función de ventana, con una consulta de conteo separada solo cuando la página viene vacía. |
| F21.15 | Endpoint de salud sin autenticación que ejecuta una consulta real contra la base y responde 503 si está caída. |
| F21.16 | Registro estructurado en JSON con nivel configurable, identificador de request, método, URL, estado, duración y versión. El cuerpo del request nunca se registra. |
| F21.17 | Servidor único: Express sirve la aplicación compilada y hace de respaldo para las rutas del cliente. |

---

## 22. Pruebas e integración continua

| ID | Funcionalidad |
|----|---------------|
| F22.1 | Pruebas unitarias sobre las funciones puras del dominio: validadores, disponibilidad, precedencia de excepciones, superposición con final excluyente, agregación de conflictos, expansión de recurrencia, precedencia de precios y cálculo de saldo. |
| F22.2 | Pruebas de integración contra una base PostgreSQL real, que cubren autenticación, autorización, alcance por negocio y por permisos, ciclo de vida de turnos, plazos, inmutabilidad y derivación de saldo. |
| F22.3 | Prueba de concurrencia con dos transacciones que demuestra que dos reservas simultáneas no pueden ganar ambas. |
| F22.4 | Prueba de esquema fresco que aplica todas las migraciones y la semilla sobre una base vacía. |
| F22.5 | Prueba de deriva entre el SSoT y el SQL: donde una constante existe en TypeScript y en una migración inmutable, un test verifica que sigan coincidiendo, de modo que la divergencia rompa una prueba y no la producción. |
| F22.6 | Pruebas de componente sobre la lógica difícil del frontend: generación de tablas y formularios desde el SSoT, cambio de idioma y reglas de visibilidad por rol y por permiso. |
| F22.7 | Pruebas de extremo a extremo con Playwright contra el servidor compilado y la base sembrada, que cubren los recorridos completos incluido el forzado de conflictos y el cambio de idioma. |
| F22.8 | Las pruebas importan las etiquetas del SSoT y del diccionario en lugar de repetir textos, de modo que un cambio de redacción no produzca una prueba falsamente verde ni falsamente roja. |
| F22.9 | Las fechas de las pruebas son relativas al día de ejecución, no fechas fijas, por lo que el conjunto de pruebas no envejece. |
| F22.10 | Integración continua en GitHub Actions que levanta PostgreSQL 18, migra, siembra, compila y ejecuta las cuatro suites en orden, con la zona horaria de Buenos Aires configurada en el trabajo. |

---

## 23. Datos de demostración

| ID | Funcionalidad |
|----|---------------|
| F23.1 | Semilla realista de un consultorio de Buenos Aires: psicólogos, nutricionista, kinesiólogo, médicos clínicos y salas como recursos. |
| F23.2 | Una cuenta documentada por rol, más un profesional con cambio de contraseña forzado y un cliente con saldo vencido. |
| F23.3 | Escala suficiente para ejercitar el calendario y los filtros: 7 profesionales, 2 recepcionistas, 35 clientes, 5 salas, 4 servicios, 9 series recurrentes y alrededor de 1260 turnos sobre 45 días de agenda densa. |
| F23.4 | Fechas relativas: la semilla desplaza todas las fechas por semanas enteras hasta el lunes de la semana en curso, preservando el día de la semana y la hora. El conjunto de datos nunca envejece. |
| F23.5 | Cobertura completa de funcionalidades en los datos: precios por cliente, overrides por bloque, licencias, feriados, series recurrentes de las tres formas de fin, sobreturnos con autorizante registrado, solicitudes pendientes, movimientos de cuenta corriente de los cuatro tipos y eventos de auditoría incluidos los denegados. |
| F23.6 | Semilla idempotente, más una variante de reinicio destructivo para volver a un estado conocido antes de una demostración. |
| F23.7 | Semilla mínima alternativa para pruebas rápidas y semilla de administrador para entornos reales, tomada de variables de entorno. |
