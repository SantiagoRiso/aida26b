# Agenda profesional - Sistema de turnos multi negocio

Sistema de gestión de turnos y agendas para profesionales que atienden con cita previa
(consultorios, gabinetes, estudios). Cada negocio es un inquilino separado: todos los datos
se filtran por `business_id` y nadie ve los de otro negocio. Opera solo en Argentina y solo
en pesos argentinos (ARS), con la zona horaria del negocio como referencia para fechas y
límites de cancelación.

## Características

- **Turnos con ciclo de vida**: solicitud, aprobación, reprogramación, asistencia, ausencia
  y cancelación, con transiciones validadas tanto en la aplicación como por un trigger en la
  base de datos.
- **Turnos recurrentes**: la regla de repetición se guarda una vez y las ocurrencias existen
  como filas recién cuando se las toca (reprograma, cancela, completa).
- **Disponibilidad calculada**: los horarios libres se derivan de los bloques semanales menos
  las excepciones (vacaciones, feriados, cierres del negocio) menos lo ya reservado. No se
  guardan slots.
- **Sobreturnos**: el personal puede forzar un turno sobre un horario ocupado; el sistema lo
  registra como override explícito en lugar de rechazarlo en silencio.
- **Precios por cliente**: cada cliente puede tener un precio propio por servicio y profesional;
  si no lo tiene se usa el precio por defecto del servicio. El precio se congela al reservar.
- **Cuenta corriente**: libro de movimientos solo de altas (cargos, pagos y ajustes). El saldo
  se calcula al leer, nunca se actualiza una fila existente.
- **Roles y permisos**: Administrador, Profesional, Recepcionista y Cliente. La recepcionista
  ve la agenda de un profesional solo si tiene un permiso de calendario explícito.
- **Auditoría**: las operaciones sensibles quedan registradas en una tabla de solo altas.
- **API REST**: rutas genéricas de CRUD generadas a partir de una única fuente de verdad, más
  rutas propias para los flujos de negocio.

## Tecnologías Utilizadas

- **Backend**: Node.js, TypeScript, Express 4
- **Frontend**: Vue 3, TypeScript, Vite
- **Base de Datos**: PostgreSQL 18
- **Acceso a datos**: SQL directo con la librería `pg`, sin ORM
- **Pruebas**: Vitest (unitarias y de base de datos) y Playwright (E2E)

## Estructura del Proyecto

```
/
├── backend/           # API REST (Express + pg)
│   ├── src/
│   │   ├── server.ts       # Arranque: env, guards de auth, rutas de dominio
│   │   ├── app.ts          # Armado de la app y orden de middlewares
│   │   ├── routes/         # Rutas genéricas de CRUD y rutas de dominio
│   │   └── db/             # Único lugar con SQL escrito a mano
│   ├── test/               # *.test.ts (sin base) y *.db.test.ts (con base)
│   ├── package.json
│   └── tsconfig.json
├── frontend/          # SPA en Vue 3
│   ├── src/
│   ├── e2e/                # Suite Playwright
│   ├── index.html
│   └── vite.config.ts
├── shared/
│   └── src/ssot/           # Fuente de verdad: tablas, columnas, permisos, rutas
├── database/
│   ├── bootstrap.sh        # Crea roles y base de datos (corre una vez)
│   └── migrations/         # Migraciones SQL versionadas
└── README.md
```

`shared/src/ssot/` describe cada tabla una sola vez (columnas, clave primaria, qué operaciones
expone, qué roles pueden usarlas y cómo se filtran las filas). El backend genera desde ahí las
rutas genéricas y el frontend arma desde ahí sus formularios y grillas.

## Instalación y Configuración

### Prerrequisitos

- Node.js (versión 16 o superior)
- PostgreSQL (versión 12 o superior)
- npm o yarn

### Base de Datos

1. Setup inicial (una vez por entorno, como superusuario de Postgres):
   ```
   set -a; . .env; set +a          # carga DB_* (ver .env.example)
   POSTGRES_USER=postgres sh database/bootstrap.sh
   ```
   Toma los roles/base de las variables `DB_*` del entorno y crea los roles
   `aida26_owner` / `aida26_user` y la base `professional_agenda`.

2. Aplicar migraciones (desde `backend/`):
   ```
   npm run migrate
   ```
   Esto crea/actualiza las tablas según los archivos en `database/migrations/`.

   Las migraciones son **forward-only** y nombradas con timestamp
   (ej. `20260520_120000_initial_schema.sql`). Para cambiar el schema,
   se agrega una migración nueva; nunca se editan las ya aplicadas.

   **Para deshacer un cambio:** no se edita la migración original: se escribe
   una migración nueva que aplique el revert. Ej: si
   `20260601_120000_add_phone.sql` hizo `ALTER TABLE services ADD COLUMN phone`,
   para sacarla escribimos `20260602_090000_remove_phone.sql` con
   `ALTER TABLE services DROP COLUMN phone`. Las migraciones aplicadas son
   inmutables, y modificarlas rompe la verificación de checksum.

3. Agregar una tabla nueva requiere tres pasos coordinados:

   1. **Migración** en `database/migrations/`: crear la tabla con FKs inline a tablas que
      ya existan (nunca `ALTER TABLE` después para agregarlas), sus índices, y terminar
      con un `GRANT` de mínimo privilegio a `aida26_user`, sin `DELETE` si la tabla es
      soft-delete o append-only. Ejemplo completo a copiar:
      `database/migrations/20260718_090000_appointment_series.sql`. El archivo no debe
      abrir ni cerrar transacciones (`BEGIN`/`COMMIT`): el runner envuelve cada migración
      en su propia transacción, junto con el registro en `schema_migrations`, y descarta
      esas sentencias antes de ejecutar el archivo.
   2. **Descriptor SSoT** en `shared/src/ssot/domain/*.ts`: columnas, `pk`, `crud`,
      `roleRequired`, y el scoping que corresponda (`businessScoped`, `ownership`,
      `grantScope`, `roleDiscriminator`). Si la tabla entra en un archivo de dominio ya
      existente alcanza con sumar la clave a su objeto exportado; si es un archivo de
      dominio nuevo hay que además importarlo y sumarlo a `schedulerTables` en
      `shared/src/ssot/domain/index.ts`, respetando el orden de dependencia de la
      migración.
   3. **El `GRANT`** del paso 1 se nombra aparte porque es el que más se olvida. Sin
      él el rol `aida26_user` no puede tocar la tabla nueva y toda request contra ella
      falla con 500 aunque el descriptor esté perfecto.

   Sin el paso 2 la tabla existe en la base pero es invisible para la API: cualquier
   ruta genérica contra ella devuelve 404, igual que una tabla desconocida.

### Backend

1. Navegar al directorio `backend`
2. Instalar dependencias: `npm install`
3. Configurar variables de entorno en `.env`:
   ```
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=professional_agenda
   DB_USER=tu_usuario
   DB_PASSWORD=tu_contraseña
   PORT=3000
   ```
4. Compilar solo backend: `npm run build`
5. Ejecutar: `node dist/backend/src/server.js` (servirá en http://localhost:3000 y también
   servirá `frontend/dist`). El punto de entrada queda anidado porque `tsc` refleja el árbol
   del repositorio: el backend importa `shared/`.

### Frontend

1. Navegar al directorio `frontend`
2. Instalar dependencias: `npm install`
3. Compilar assets de producción: `npm run build`
4. Ejecutar el servidor de desarrollo con proxy API: `npm run dev` (servirá en http://localhost:8080)

### Comandos desde la raíz

1. Instalar frontend y backend: `npm run install:all`
2. Compilar frontend y backend: `npm run build`
3. Ejecutar backend compilado: `node backend/dist/backend/src/server.js`
4. Ejecutar backend en desarrollo: `npm run dev:backend`
5. Ejecutar frontend en desarrollo: `npm run dev:frontend`
6. Ejecutar tests unitarios frontend+backend: `npm test`
7. Ejecutar tests de integración con base de datos: `npm run test:db`
8. Ejecutar tests E2E Playwright: `npm run test:e2e`

> `npm run test:db` dropea y recrea una base de datos descartable (`professional_agenda_test`
> por defecto) en cada corrida. Para correr la suite en paralelo con otra corrida contra el mismo
> Postgres (otro agente, otro job de CI), seteá `TEST_DB_NAME` a un valor distinto en cada una,
> ver `.env.example`.

### Levantar todo con Docker

`docker-compose.yml` levanta los tres servicios (base, backend y frontend) y es el modo
recomendado para desarrollar:

```
docker compose up --build
```

- Frontend en http://localhost:8080, API en http://localhost:3000, Postgres en `localhost:5432`.
- El backend corre en modo desarrollo (`tsx watch`) sobre el código del repositorio montado
  dentro del contenedor, así que al guardar un archivo de `backend/src` o de `shared/src` el
  servidor se reinicia solo. No hace falta reconstruir la imagen para ver un cambio de código.
- La detección de cambios usa polling (`CHOKIDAR_USEPOLLING`), porque los volúmenes montados
  desde Windows o macOS no propagan eventos del sistema de archivos al contenedor. Si el
  polling consume demasiada CPU, subí `CHOKIDAR_INTERVAL` (milisegundos) en el `.env`.
- Solo hace falta reconstruir (`docker compose build backend`) cuando cambian las dependencias
  o el `Dockerfile`, no cuando cambia el código.
- Las migraciones y el usuario administrador inicial se aplican en cada arranque del contenedor
  de backend, antes de que la API empiece a escuchar.

Más detalles, comandos y solución de problemas en `DOCKER_SETUP.md`.

## Errores y logging

### Dos registros distintos, con propósitos distintos

El sistema escribe en dos lugares que no se reemplazan entre sí:

|                     | Log operativo                                           | Tabla `audit_events`                                |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| Dónde vive          | salida estándar del proceso, recogida por Docker        | en la base de datos, junto a los datos del negocio   |
| Para qué sirve      | diagnosticar: qué falló, en qué request, con qué stack  | dejar constancia de quién hizo qué y cuándo          |
| Cuánto dura         | ventana rotativa acotada (ver abajo)                    | permanente; se respalda con el resto de la base      |
| Cómo se consulta    | `docker compose logs`, `grep`, `jq`                     | SQL y `GET /api/audit`                               |
| Se puede modificar  | sí, es un archivo en el host                            | no: la tabla es solo altas y el rol de la aplicación no tiene `UPDATE` ni `DELETE` |

La distinción importa: el log operativo es descartable y existe para que un desarrollador
entienda una falla; la auditoría es el registro durable del negocio y sobrevive a cualquier
rotación, reinicio o recreación de contenedores.

### Qué se registra en el log operativo

- Una línea por request atendida: `reqId`, método, URL, status y duración en milisegundos.
  Si el cliente corta la conexión antes de recibir la respuesta la línea sale igual, marcada
  con `aborted: true`, así una navegación abandonada no desaparece del registro.
- Todo error no manejado dentro de una ruta: `reqId`, método, path, mensaje y stack.
- Fallas de infraestructura: un cliente ocioso de la base que se cae, y
  `uncaughtException` / `unhandledRejection` justo antes de que el proceso termine.
- Fallas al escribir la auditoría, para que un rastro de auditoría incompleto quede visible.
- Errores reportados por el navegador, con `kind: browser_error`.

Cada línea es un objeto JSON independiente con `level`, `time` y `version`, de modo que se
puede filtrar con `grep` o procesar con `jq` sin parsear texto libre. `version` sale de
`backend/package.json` salvo que se defina `VERSION`, así una línea siempre se puede atribuir
a la versión de código que la produjo. `LOG_LEVEL` (`debug`, `info`, `warn`, `error`, `silent`)
decide el nivel mínimo que se emite.

**Nunca se registra el cuerpo de la request**, ni contraseñas, ni la cookie de sesión.

### En dónde se guarda ese log

La aplicación no abre ningún archivo: escribe a la salida estándar y nada más. Es deliberado,
un proceso en contenedor no decide dónde se persisten sus logs, lo decide quien lo corre.

Quien lo corre acá es Docker, con el driver `json-file`, que guarda esa salida en el host en
`/var/lib/docker/containers/<id>/<id>-json.log`. Se lee siempre a través de Compose:

```
docker compose logs -f backend                       # en vivo
docker compose logs --since 15m backend              # últimos 15 minutos
docker compose logs backend | grep '"level":"error"' # solo errores
```

**Cuánto se conserva.** `docker-compose.yml` fija la rotación para los tres servicios:
`max-size` y `max-file`, por defecto 5 archivos de 10 MB, es decir un techo de 50 MB por
servicio. Se ajustan con `LOG_MAX_SIZE` y `LOG_MAX_FILE` en el `.env`. Al llenarse el archivo
actual se abre uno nuevo y se descarta el más viejo: lo que borra las líneas antiguas es el
volumen de tráfico, no el paso del tiempo. En desarrollo eso son varios días de uso normal, o
unos minutos si algo entra en un bucle de errores. Sin esta configuración el archivo crecería
sin límite hasta llenar el disco, que es el comportamiento por defecto de Docker.

**Qué lo borra.** `docker compose down` elimina los contenedores y con ellos sus logs;
`docker compose restart` no. Para conservar una corrida hay que volcarla antes de bajar el
stack:

```
docker compose logs --no-color > corrida.log
```

Los cambios en el bloque `logging:` del compose solo se aplican al **crear** el contenedor.
Un `restart` no alcanza: hay que recrearlo (`docker compose up -d --force-recreate backend`).
Para confirmar que la rotación quedó activa:

```
docker inspect aida26_backend --format '{{json .HostConfig.LogConfig}}'
```

### Qué faltaría en producción

El proyecto no tiene entorno de producción y esta sección no pretende lo contrario. El punto
es que no hace falta tocar el código para llegar a uno: escribir a stdout ya es la decisión
correcta, lo que cambia es quién recoge esa salida. Dos caminos, por orden de preferencia:

1. **Un agregador** (Loki, CloudWatch, Elastic): se reemplaza el `driver` del bloque
   `logging:` en el compose y las líneas van a parar a un servicio con búsqueda, retención por
   tiempo y alertas. Es lo indicado si hay más de una máquina o más de una réplica, porque el
   log deja de vivir en el host que lo generó.
2. **Un volumen montado**: se vuelca la salida a un archivo en un volumen persistente y se lo
   rota con `logrotate`. Es más pobre (no hay búsqueda ni alertas) pero alcanza para un
   servidor único y no agrega ninguna dependencia nueva.

Se eligió no incorporar hoy ninguna de las dos, ni una librería de logging con salida a
archivo. Para un entorno que se levanta con `docker compose`, una dependencia que nadie opera
es peor que una decisión documentada: la rotación acota el riesgo real (llenar el disco) y el
registro que sí tiene que sobrevivir, el de auditoría, ya está en la base de datos y no
depende de nada de esto.

## Demo accounts

Para probar el sistema con un dataset realista de un consultorio de Buenos Aires
(psicólogos, nutricionista, kinesiólogo, salas como recursos, clientes, turnos, cuenta
corriente y auditoría), cargá los datos de demostración:

```
npm run migrate --prefix backend && npm run seed:demo --prefix backend
```

> **Credenciales SOLO para uso local / demostración.** No son secretos reales; se guardan
> hasheadas en la base. Todas comparten la misma contraseña: `demo-pass-123`.

| Rol           | Usuario               | Contraseña      | Notas                                                                   |
| ------------- | --------------------- | --------------- | ----------------------------------------------------------------------- |
| Admin         | `demo_admin`          | `demo-pass-123` | Acceso total al negocio; autorizó el sobreturno y los ajustes.          |
| Profesional   | `demo_pro`            | `demo-pass-123` | Psicóloga; su calendario es compartido con la recepcionista y `demo_pro5`. |
| Profesional   | `demo_pro5`           | `demo-pass-123` | **Tiene un permiso sobre el calendario de `demo_pro`** (profesional como grantee). |
| Recepcionista | `demo_recep`          | `demo-pass-123` | **Tiene permisos** sobre los calendarios de `demo_pro` y `demo_pro2`.   |
| Cliente       | `demo_client`         | `demo-pass-123` | Homero Simpson; saldo en cero (cargó y pagó).                           |
| Cliente       | `demo_client_overdue` | `demo-pass-123` | Bart Simpson; **saldo vencido positivo** (pago parcial + mora).         |
| Profesional   | `demo_reset`          | `demo-pass-123` | **Sembrado con `must_change_password`**: ejercita el cambio forzado de contraseña. |

Además se siembran ~6-8 profesionales (`demo_pro` … `demo_pro6`, `demo_reset`), una segunda
recepcionista (`demo_recep2`) y ~30 clientes (`demo_client2` … `demo_client30`), todos con la
misma contraseña `demo-pass-123`. Los usernames coinciden exactamente con
`frontend/e2e/helpers.ts` para que las pruebas E2E resuelvan las cuentas correctas.

## Recuperación de contraseñas

La recuperación es siempre mediada por un administrador. Nadie se restablece la contraseña
a sí mismo, y ningún usuario queda sin forma de volver a entrar.

En todos los casos el restablecimiento fuerza el cambio de contraseña en el primer ingreso
(`must_change_password`) y cierra todas las sesiones abiertas del usuario, así que una sesión
robada deja de servir en el mismo momento en que se recupera la cuenta.

### Caso 1: cliente o personal del negocio

Lo recupera cualquier Admin de ese mismo negocio.

1. El Admin entra a **Usuarios**, busca a la persona y usa **Restablecer contraseña**.
2. Le comunica la contraseña provisoria por un canal que ya usen (teléfono, en el mostrador).
3. La persona ingresa con esa contraseña y el sistema la obliga a elegir una propia.

Equivalente por API:

```
POST /api/admin/users/:id/reset-password    { "password": "provisoria" }
```

Un Admin solo alcanza a los usuarios de su propio negocio. Un `:id` de otro negocio responde
404, igual que uno inexistente.

### Caso 2: el único Admin de un negocio

Si el negocio tiene un solo Admin y esa persona pierde la contraseña, no queda nadie adentro
que pueda ayudarla. Lo resuelve un super administrador: un Admin sin negocio propio
(`business_id` nulo), que es el rol que existe para actuar sobre todos los negocios.

El super administrador usa exactamente las mismas rutas, sobre el usuario del negocio afectado:

```
POST /api/admin/users/:id/reset-password    { "password": "provisoria" }
POST /api/admin/users/:id/deactivate
POST /api/admin/users/:id/enable-login      { "username": "...", "password": "..." }
```

El negocio sale de la fila apuntada, no de la sesión de quien llama. Para **crear** un usuario
no hay fila de la cual deducirlo, así que el super administrador nombra el negocio en el cuerpo:

```
POST /api/admin/users   { "username": "...", "password": "...", "role": "Admin",
                          "email": "...", "target_business_id": 7 }
```

Un Admin con negocio propio nunca envía `target_business_id`: si lo manda, el pedido se
rechaza (400) en lugar de crearse la cuenta en otro negocio.

Cada una de estas acciones queda registrada en auditoría bajo el negocio afectado, no bajo
quien la ejecutó, de modo que el Admin del negocio ve en su propia auditoría que su cuenta
fue restablecida desde afuera.

El super administrador no se crea desde la aplicación: `POST /api/admin/users` siempre exige
un negocio, así que toda cuenta creada por la API pertenece a uno. La cuenta sin negocio se
da de alta con acceso directo a la base (`business_id` nulo, rol `Admin`). El script
`npm run seed-admin --prefix backend` crea otra cosa: el Admin inicial de un negocio,
atado a ese negocio.

### Por qué no hay recuperación por email

Está deliberadamente fuera de alcance. Un "olvidé mi contraseña" por email necesita un
servicio de correo saliente que el proyecto no tiene, y agrega superficie propia: tokens de
un solo uso con vencimiento, y un formulario público que responde distinto según si la
dirección existe o no, lo que permite averiguar quién está registrado. La vía mediada por un
administrador cubre todos los casos sin nada de eso. La contrapartida honesta es que la
recuperación depende de que haya alguien disponible: un usuario del negocio depende de su
Admin, y el Admin depende del super administrador.

## Integración continua (CI)

El workflow `.github/workflows/ci.yml` corre automáticamente en cada `push` y `pull_request`.

**Qué hace CI:**

1. Levanta un servicio de **PostgreSQL 18-alpine** (la misma versión que usa `docker-compose.yml` localmente).
2. Aplica las migraciones (`npm run migrate`).
3. Carga el dataset de demostración (`npm run seed:demo`).
4. Instala los navegadores de Playwright (Chromium).
5. Compila el frontend (`npm run build`).
6. Corre los tests en orden:
   - Tests unitarios del backend (`npm run test --prefix backend`)
   - Tests de integración con la base de datos, incluido el test de migración+seed en esquema fresco, `migration-seed-fresh.test.ts` (`npm run test:db --prefix backend`)
   - Tests unitarios del frontend con Vitest (`npm run test --prefix frontend`)
   - Suite E2E completa de Playwright contra el servidor Express corriendo en CI (`npm run test:e2e --prefix frontend`)

**Versión de PostgreSQL:** PostgreSQL 18 (`postgres:18-alpine`), la misma que corre en `docker-compose.yml`. Los tests en CI ejercen la misma versión de motor que el entorno local.

## Uso

1. Levantar el stack: `docker compose up --build`, o bien el backend y el frontend por separado
   (`npm run dev:backend` y `npm run dev:frontend` desde la raíz).
2. Abrir el navegador en http://localhost:8080 (servidor de desarrollo del frontend, que
   redirige `/api` al backend). Si en cambio se sirve el frontend compilado desde Express,
   la aplicación queda en http://localhost:3000.
3. Iniciar sesión con una de las cuentas de demostración de la sección anterior.
4. Según el rol, la aplicación muestra la agenda del profesional, el calendario del negocio,
   los clientes, los servicios, la cuenta corriente y la auditoría.

Para correr el backend compilado en lugar del modo desarrollo: `npm run build --prefix backend`
y después `node backend/dist/backend/src/server.js`. La salida de `tsc` refleja el árbol del
repositorio porque el backend importa `shared/`, por eso el punto de entrada queda anidado.

## API Endpoints

Todas las rutas cuelgan de `/api` y responden un sobre uniforme
(`{ success: true, data }` o `{ success: false, error: { code, message } }`). Salvo el login y
`/health`, todas exigen una sesión: la cookie `aida_session` que devuelve el login. Un `:id`
que no exista, que pertenezca a otro negocio o que el usuario no tenga permiso de ver responde
404, nunca 403, para no revelar que la fila existe.

### Sesión y perfil propio
- `POST /api/auth/login` - Iniciar sesión
- `POST /api/auth/logout` - Cerrar sesión
- `GET /api/auth/me` - Usuario y rol de la sesión actual
- `POST /api/auth/change-password` - Cambiar la propia contraseña
- `GET /api/auth/me/profile` - Datos del propio perfil
- `PATCH /api/auth/me/profile` - Editar el propio perfil

### Administración de usuarios

El negocio sobre el que actúan sale de la fila apuntada por `:id`, no de la sesión: un Admin
solo alcanza a su propio negocio, y un super administrador (Admin sin negocio propio) alcanza
a cualquiera. Ver [Recuperación de contraseñas](#recuperación-de-contraseñas).

- `POST /api/admin/users` - Crear usuario (el super administrador nombra el negocio con `target_business_id`)
- `POST /api/admin/users/:id/deactivate` - Desactivar usuario (nunca se borra)
- `POST /api/admin/users/:id/reset-password` - Forzar cambio de contraseña
- `POST /api/admin/users/:id/enable-login` - Habilitar el acceso de un usuario

### Turnos
- `GET /api/appointments` - Listar turnos del período consultado
- `GET /api/appointments/:id` - Detalle de un turno
- `PATCH /api/appointments/:id` - Editar campos editables del turno
- `POST /api/appointments/request` - Solicitud de turno de un cliente
- `POST /api/appointments/schedule` - Agendar un turno (personal del negocio)
- `POST /api/appointments/:id/approve` - Aprobar una solicitud
- `POST /api/appointments/:id/reschedule` - Reprogramar
- `POST /api/appointments/:id/transition` - Cambiar de estado (asistió, ausente, cancelado)
- `POST /api/appointments/:id/ignore-conflict` - Marcar un conflicto como aceptado
- `GET /api/appointments/related-clients` - Clientes con turnos relacionados al usuario

### Turnos recurrentes
- `POST /api/appointments/series` - Crear una serie a partir de una regla de repetición
- `GET /api/appointments/series/:id` - Detalle de la serie y sus ocurrencias
- `PUT /api/appointments/series/:id` - Editar la serie
- `POST /api/appointments/series/:id/materialize` - Convertir una ocurrencia en un turno real
- `POST /api/appointments/series/:id/future` - Aplicar un cambio de aquí en adelante
- `POST /api/appointments/series/:id/end` - Finalizar la serie

### Disponibilidad y conflictos
- `GET /api/availability` - Horarios libres calculados para un profesional o recurso
- `GET /api/booking-window` - Ventana en la que se puede reservar
- `POST /api/conflict-check` - Verificación previa de superposiciones
- `POST /api/time-off/conflict-preview` - Turnos que quedarían en conflicto por una ausencia

### Permisos de calendario
- `GET /api/calendar-grants` - Listar permisos otorgados
- `POST /api/calendar-grants` - Otorgar acceso al calendario de un profesional
- `DELETE /api/calendar-grants/:id` - Revocar el permiso
- `GET /api/calendar-grants/grantable-staff` - Personal al que se le puede otorgar acceso

### Cuenta corriente
- `POST /api/ledger` - Registrar un movimiento (cargo, pago o ajuste)
- `GET /api/clients/:id/balance` - Saldo del cliente
- `GET /api/clients/:id/ledger` - Movimientos del cliente

### Negocio y cierres
- `GET /api/business/settings` - Configuración del negocio de la sesión
- `GET /api/businesses/:id/settings` - Configuración de un negocio
- `PATCH /api/businesses/:id/settings` - Editar la configuración
- `GET /api/business-closures` - Listar cierres del negocio
- `POST /api/business-closures` - Crear un cierre (feriado, receso)
- `PUT /api/business-closures/:id` - Editar un cierre
- `DELETE /api/business-closures/:id` - Eliminar un cierre

### Auditoría
- `GET /api/audit` - Consultar el registro de auditoría

### CRUD genérico
Las tablas declaradas en `shared/src/ssot/` exponen las mismas cuatro rutas, generadas desde el
descriptor de cada tabla (`services`, `resources`, `schedule_blocks`, `schedule_exceptions`,
`client_professional_services` y demás):

- `GET /api/:tabla` - Listar. Una fila puntual se pide con `?id=`, no hay `GET /api/:tabla/:id`
- `POST /api/:tabla` - Crear
- `PUT /api/:tabla/:id` - Actualizar
- `DELETE /api/:tabla/:id` - Eliminar (baja lógica en las tablas que la usan)

Una tabla que no exista, que el descriptor marque como protegida o que el rol no tenga permitida
responde 404, igual que una tabla desconocida.

### Salud
- `GET /health` - Sin autenticación. Ejecuta una consulta real contra la base; responde 503 si
  la base no contesta. Es lo que usan el healthcheck del contenedor y CI.

## Pruebas E2E

La suite de Playwright vive en `frontend/e2e/` y corre contra el servidor Express compilado, no
contra el servidor de desarrollo de Vite.

- `npm run test:e2e` reutiliza un servidor ya levantado en http://localhost:3000 si lo encuentra.
- `npm run test:e2e:fresh` recrea la base, la vuelve a sembrar, compila y levanta el servidor
  antes de correr la suite. Es la forma confiable de correrla desde cero.
- La primera vez hay que instalar los navegadores: `npx playwright install` desde `frontend/`.

## Contribución

Antes de abrir un cambio: `npm run typecheck`, `npm test`, `npm run test:db` y, si el cambio toca
la interfaz, `npm run test:e2e`. Los mismos pasos corren en CI.

## Licencia

MIT. Ver el archivo `LICENSE`.
