# Informe técnico

Sistema de gestión de turnos profesionales (AIDA).

> **Estado: borrador.** Cada sección tiene el título definitivo, un resumen breve de cómo
> funciona la funcionalidad, y una lista de decisiones a desarrollar con su justificación.
> Los bloques marcados `[desarrollar]` son los que faltan escribir.

---

## Mapa de la consigna

Correspondencia entre los puntos de `TODO.md` y las secciones de este informe.

| Punto de la consigna | Secciones que lo responden |
|---|---|
| Filtros, orden, paginación | §12.3 Motor de listados |
| Mostrar en la URL lo que el usuario está viendo | §12.4 Estado en la URL |
| Autenticación, recuperación de contraseña | §2 Autenticación y sesiones |
| ¿Los usuarios van en la misma base que los datos de negocio? | §2.5 Ubicación de la identidad |
| ¿Todos los usuarios pueden hacer todo? | §3 Autorización · §4 Multi-tenancy |
| UX/UI: modales, menú, overflow, responsive | §11 Interfaz · §11.5 Layout y navegación |
| Botón de idioma ES/EN | §13 Internacionalización |
| Botón de tema claro/oscuro | §11.6 Tema visual |
| Foreign keys como selector, y FKs dependientes | §12.2 Claves foráneas en la interfaz |
| CRUD genéricos: una API por operación, no por tabla | §1.2 Motor genérico · §1.3 Rutas a medida |
| ¿Dónde vive la estructura y los tipos? ¿De dónde los toma el frontend? | §1.1 Fuente única de verdad |
| Migraciones: cambios de esquema y tablas nuevas | §14 Migraciones |
| Queries sin inyección SQL | §12.5 Construcción segura de consultas |
| Validaciones: quién las conoce y quién las fuerza | §12.1 Validación compartida |
| Errores y logging: qué se registra, dónde, qué se muestra | §15 Errores, registro y observabilidad |
| Testing: end to end, backend, interacción del usuario | §16 Pruebas e integración continua |

---

## 1. Arquitectura: una sola definición del dominio

### 1.1 Fuente única de verdad

**Cómo funciona.** Un objeto TypeScript en `shared/src/ssot/` declara las diecisiete
entidades del dominio. Por cada tabla se declara: sus columnas con tipo y validador, sus
etiquetas en español e inglés, qué columnas son filtrables y ordenables, qué roles pueden
hacer cada operación, cómo se acota por negocio, si tiene baja lógica y si el servidor
estampa alguna columna. Ese paquete se compila hacia el backend y hacia el frontend, así
que las dos capas leen exactamente la misma definición. Agregar una tabla al sistema es
agregar un descriptor: no se escriben endpoints, ni validadores, ni formularios, ni
columnas de tabla.

**Decisiones a desarrollar.**
- Por qué la definición vive en un paquete compartido y no en el backend con un endpoint de
  metadatos, ni duplicada en el frontend. `[desarrollar]`
- Por qué el descriptor incluye las políticas de permiso y no solo la forma de los datos.
- Por qué se modularizó por dominio (`domain/*.ts`) manteniendo un archivo agregador, en
  lugar de un único archivo monolítico.
- Regla de trabajo derivada: el comportamiento de una tabla se cambia en su descriptor,
  nunca con un caso especial por nombre de tabla dentro del motor.

### 1.2 Motor de CRUD genérico

**Cómo funciona.** Cuatro rutas (`GET`, `POST`, `PUT`, `DELETE` sobre `/api/:tabla`)
atienden a todas las entidades ordinarias. El texto SQL se compila en tiempo de ejecución a
partir del descriptor: la proyección, los filtros, el orden, la paginación, las condiciones
de alcance y la sentencia de escritura. Se agregaron trece tablas al dominio sin agregar una
sola ruta.

**Decisiones a desarrollar.**
- Por qué el motor genera SQL parametrizado en lugar de usar un ORM o un constructor de
  consultas de terceros.
- Por qué la generación de SQL se movió desde la capa de rutas hacia la capa de datos, y
  qué invariante se buscaba con eso ("todo el SQL vive en un solo lugar").

### 1.3 Rutas a medida para lo que la declaración no puede expresar

**Cómo funciona.** Una tabla marcada `protected` queda fuera del motor genérico y se opera
con rutas escritas a mano. Son siete: turnos, series recurrentes, cuenta corriente,
auditoría, permisos de calendario, usuarios y negocio. La razón es que sus reglas no son
"quién puede tocar esta tabla" sino flujos de trabajo con transiciones, verificaciones
transaccionales y autorización que depende de relaciones entre filas.

**Decisiones a desarrollar.**
- El criterio de corte entre "entidad de configuración" y "entidad de flujo de trabajo".
- Por qué las tablas protegidas devuelven 404 y no 403 cuando alguien las pide por la vía
  genérica.

### 1.4 Capa de acceso a datos

**Cómo funciona.** Las rutas no contienen SQL. Todo el SQL de dominio vive en módulos por
área (`db/appointments.ts`, `db/ledger.ts`, `db/grants.ts`) y toda ejecución pasa por
`db/core.ts`, que es dueño de las transacciones y del mapeo de errores de PostgreSQL a
códigos HTTP.

**Decisiones a desarrollar.**
- El diagnóstico que motivó el trabajo: el precio efectivo estaba duplicado literalmente en
  seis lugares, el andamiaje de transacciones repetido siete veces, y las conversiones de
  tipo dispersas en ocho archivos.
- Por qué los métodos lanzan errores tipados en lugar de devolver un envoltorio de
  resultado.

### 1.5 Sin ORM

**Cómo funciona.** SQL parametrizado directo sobre la biblioteca `pg`.

**Decisiones a desarrollar.**
- Requisito de la materia, pero además: hace explícitas las consultas de superposición y el
  uso de bloqueos, que un ORM tendería a esconder. `[desarrollar]`

---

## 2. Autenticación y sesiones

### 2.1 Contraseñas

**Cómo funciona.** `scrypt` con una sal de dieciséis bytes por usuario y comparación en
tiempo constante. Mínimo de ocho caracteres y prohibición de reusar la contraseña anterior.

**Decisiones a desarrollar.**
- Por qué `scrypt` y no `bcrypt`, que era lo que nombraba el enunciado.

### 2.2 Sesiones del lado del servidor

**Cómo funciona.** La sesión se persiste en PostgreSQL. El navegador recibe un token
aleatorio en una cookie con `HttpOnly` y `SameSite=Lax`, y `Secure` en producción. En la
base se guarda solamente el hash del token. Cada pedido revalida que la sesión no haya
vencido y que el usuario siga activo.

**Decisiones a desarrollar.**
- Por qué sesiones en base y no un token firmado sin estado: se pueden revocar, y una
  desactivación tiene efecto inmediato.
- Por qué nada queda en almacenamiento accesible por JavaScript.
- El vencimiento se declara una sola vez y la sentencia SQL lo interpola, en lugar de tener
  el número escrito en dos lados.

### 2.3 Defensa contra enumeración de usuarios

**Cómo funciona.** Ante un usuario inexistente el sistema igual calcula el hash contra un
valor señuelo, para que el tiempo de respuesta no delate si la cuenta existe. El mensaje de
error es idéntico para usuario inexistente, contraseña incorrecta y cuenta desactivada.

**Decisiones a desarrollar.**
- Por qué no se registra el intento fallido contra un usuario inexistente.

### 2.4 Contraseña temporal y cambio forzado

**Cómo funciona.** El administrador tipea una contraseña temporal al crear un usuario o al
resetear una contraseña. Esa cuenta queda marcada, y mientras la marca esté puesta el
servidor responde 403 en todo endpoint protegido salvo el cambio de contraseña y el cierre
de sesión. El frontend fuerza una pantalla bloqueante. Al cambiarla se eliminan todas las
demás sesiones del usuario.

**Decisiones a desarrollar.**
- Por qué la contraseña la tipea el administrador en lugar de generarla el sistema.
- Por qué el bloqueo es total y no de solo lectura.

### 2.5 Ubicación de la identidad

**Cómo funciona.** Los usuarios viven en el esquema `auth` de la misma base que los datos de
negocio, con permisos revocados para el público y una vista de lectura sin secretos por la
que pasan todas las lecturas genéricas.

**Decisiones a desarrollar.**
- Respuesta directa a la pregunta del enunciado: misma base, esquema separado, y por qué.
- Por qué existe la vista `auth.users_directory`: el motor genérico hace `SELECT *`, y sin
  la vista filtraría los hashes y las sales.

---

## 3. Autorización

### 3.1 Cuatro roles fijos

**Cómo funciona.** Admin, Profesional, Recepcionista y Cliente. Un rol por usuario, e
inmutable después de la creación: para cambiarlo se desactiva la cuenta y se crea otra.

**Decisiones a desarrollar.**
- Por qué un conjunto fijo y no un editor de roles y permisos.
- Por qué el rol es inmutable: garantiza que una persona nunca sea a la vez profesional y
  cliente.

### 3.2 Autorización declarativa

**Cómo funciona.** Cada tabla declara qué roles pueden crear, leer, actualizar y borrar. Un
único punto de decisión resuelve las cuatro operaciones para todas las tablas. No hay
comprobaciones de rol escritas dentro de las rutas genéricas.

**Decisiones a desarrollar.**
- Por qué la política es por operación y no un conjunto para lectura y otro para escritura.
- Por qué un solo punto de decisión en lugar de middleware por ruta.

### 3.3 Alcance por fila

**Cómo funciona.** Además del rol, la consulta lleva agregadas condiciones que acotan qué
filas se ven: por negocio, por propiedad (un cliente solo su ficha), por permiso de
calendario (un usuario recepcionista solo ve los profesionales delegados) y por rol
discriminante. Se
implementa como filtro de la consulta, no como error: la ausencia de acceso se manifiesta
como lista vacía o como 404.

**Decisiones a desarrollar.**
- Por qué el filtro por propiedad se activa solo para el rol Cliente.
- Por qué las lecturas de profesionales no se restringen, aunque las escrituras sí.

### 3.4 Permisos de calendario

**Cómo funciona.** Una fila `(profesional, autorizado)` habilita a operar ese calendario. Es
binaria: no hay columnas de "puede ver", "puede crear", "puede cancelar". Qué puede hacer el
autorizado lo determina su propio rol. Revocar es borrar la fila. El autorizado puede ser
un usuario recepcionista o un usuario profesional, de modo que un profesional pueda cubrir
el calendario de otro.

**Decisiones a desarrollar.**
- Por qué binario en lugar de cuatro columnas booleanas, un arreglo de permisos o una
  máscara de bits.
- Por qué un profesional administra solamente los permisos de su propio calendario.

### 3.5 Autorización a medida donde la declarativa no alcanza

**Cómo funciona.** La cuenta corriente y las acciones sobre turnos tienen autorización
escrita a mano, porque expresan reglas que una lista de roles no puede: un profesional puede
facturar a sus propios clientes, y un usuario recepcionista solo puede facturar contra un turno de
un calendario que le fue delegado.

**Decisiones a desarrollar.**
- Por qué el descriptor de la cuenta corriente **omite** deliberadamente la política
  declarativa en lugar de declarar una que mienta sobre lo que el backend realmente permite.
- Por qué la verificación de permiso corre dentro de la misma transacción que la escritura.

### 3.6 Cómo se falla

**Cómo funciona.** 401 sin sesión, 403 por rol insuficiente sobre algo que existe, 405 si la
operación no está expuesta, y 404 para todo lo que no debería saberse que existe: tablas
protegidas, tablas desconocidas y, sobre todo, filas de otro negocio.

**Decisiones a desarrollar.**
- La regla del 404: un 403 sobre una fila de otro negocio confirmaría su existencia.
- Por qué en la reprogramación se evalúa la autorización antes que el estado del turno.

### 3.7 La interfaz oculta, el servidor decide

**Cómo funciona.** El frontend lee el mismo descriptor para ocultar menús y botones, pero
forzar una URL igual devuelve 403 o 404. La capa visual es comodidad, no seguridad.

---

## 4. Multi-tenancy

### 4.1 Alcance por negocio

**Cómo funciona.** El identificador de negocio vive solo en los dueños directos y se deriva
por join donde es alcanzable a través de un padre. El negocio activo se obtiene de la
sesión, nunca del pedido: un `business_id` en el cuerpo se rechaza con un error por campo en
lugar de sobreescribirse en silencio.

**Decisiones a desarrollar.**
- Por qué no se replicó la columna en todas las tablas, que es lo que decía el enunciado.
- Por qué rechazar en lugar de ignorar: validación estricta y predecible antes que
  permisividad silenciosa.

### 4.2 Cierre por defecto

**Cómo funciona.** Un usuario no administrador sin negocio genera la condición `1 = 0`: no
ve nada, aunque la base se lo permitiera. Un administrador sin negocio es súper
administrador y ve todos los negocios, y una restricción en la base garantiza que solo un
Admin puede tener negocio nulo.

### 4.3 Integridad entre negocios

**Cómo funciona.** Al escribir se verifica que todas las referencias de una fila apunten al
mismo negocio, incluso para un súper administrador, de modo que no se pueda armar una fila
que mezcle dos consultorios.

---

## 5. Modelo de personas

### 5.1 Una sola tabla de personas

**Cómo funciona.** No existen tablas `clients` ni `professionals` en la base: todo es
`auth.users`, discriminada por rol. En el descriptor sí existen como entidades lógicas, con
sus propias etiquetas y permisos, apuntando a la misma tabla física y a la vista de lectura.

**Decisiones a desarrollar.**
- La evolución del modelo: primero tablas separadas con puente, después perfiles con clave
  igual al usuario, finalmente una sola tabla. Qué se ganó en cada paso.
- Por qué el nombre de las claves foráneas es explícito (`client_user_id`).

### 5.2 Clientes sin credenciales

**Cómo funciona.** Un usuario recepcionista puede registrar a alguien que llamó por teléfono sin
inventarle usuario ni contraseña. Las columnas quedan nulas, y PostgreSQL admite varios
nulos en un índice único, así que la unicidad de los usuarios reales se preserva. El acceso
se puede habilitar después.

**Decisiones a desarrollar.**
- Por qué relajar las columnas existentes en lugar de crear una tabla paralela de contactos.
- El punto crítico de corrección: un intento de login contra una cuenta sin contraseña se
  comporta exactamente igual que contra un usuario inexistente.

### 5.3 Baja lógica

**Cómo funciona.** Los usuarios se desactivan, nunca se borran. Se guarda la fecha de baja y
quién la hizo, y la baja elimina todas las sesiones abiertas. El borrado de la vía genérica
se convierte en baja lógica para las entidades referenciadas.

**Decisiones a desarrollar.**
- Por qué no se guarda un motivo de baja: el registro de auditoría ya captura el contexto.
- Por qué está prohibido autodesactivarse y autoresetearse la contraseña.

---

## 6. Catálogo, precios y salas

### 6.1 Catálogo plano y precios en cascada

**Cómo funciona.** El servicio define un nombre, una duración y un precio por defecto. Sobre
eso hay dos niveles de excepción: precio y duración por bloque de agenda (la mañana cuesta
distinto que la tarde), y precio por cliente para una terna cliente-profesional-servicio.
La cadena se resuelve en una única función pura.

**Decisiones a desarrollar.**
- Por qué la excepción de precio es por cliente y no por profesional, como decía el
  enunciado.
- Por qué la misma función resuelve la vista previa y el guardado: lo que el usuario ve no
  puede diferir de lo que se persiste.

### 6.2 Precio congelado

**Cómo funciona.** El precio se captura en el turno al reservar. Editar el catálogo después
no cambia la historia. Una reprogramación vuelve a resolverlo, porque un turno activo
todavía no es historia; el congelamiento definitivo ocurre al llegar a un estado terminal.

### 6.3 Importes

**Cómo funciona.** Un único patrón de importe no negativo con hasta dos decimales, aplicado
a servicios, excepciones, turnos y cuenta corriente. En la base son `NUMERIC(12,2)` con
restricción de no negatividad. Los importes viajan como cadenas decimales.

**Decisiones a desarrollar.**
- Por qué nunca se convierten a punto flotante ni en el servidor ni en el navegador.

### 6.4 Salas

**Cómo funciona.** Una sala es un recurso reservable con su propio horario semanal y sus
propias licencias. Un turno puede tener una sala, y su disponibilidad y sus superposiciones
se evalúan por separado de las del profesional.

**Decisiones a desarrollar.**
- Por qué cero o una sala por turno, y no una relación muchos a muchos.
- Por qué el bloqueo de una sala se hace con una licencia y no con un flujo de reserva
  propio.

---

## 7. Agenda y disponibilidad

### 7.1 La disponibilidad se calcula, no se guarda

**Cómo funciona.** Se guardan los bloques semanales y las excepciones fechadas. La
disponibilidad real es el resultado de restar a los bloques las licencias, los feriados del
negocio y los turnos ya tomados. Es una función pura, sin base de datos y sin reloj.

**Decisiones a desarrollar.**
- Por qué no hay tablas de disponibilidad materializada: no puede quedar desincronizada, y
  la lógica se puede probar de forma exhaustiva sin base.

### 7.2 Granularidad por bloque

**Cómo funciona.** Cada bloque de la semana define el tamaño de sus turnos. Un profesional
puede atender sesiones de cincuenta minutos a la mañana y consultas de treinta a la tarde,
con precios distintos, dentro del mismo día. El bloque se divide en turnos consecutivos
medidos desde su inicio, y solo sobreviven los que entran enteros.

**Decisiones a desarrollar.**
- La divergencia principal respecto del enunciado, que fijaba una grilla de quince minutos.
  Qué caso real la motivó y qué costo trajo (el calendario tuvo que dejar de usar el
  arrastre nativo de la biblioteca).

### 7.3 Bloques normalizados

**Cómo funciona.** El horario semanal empezó siendo un campo JSON y hoy son filas, una por
bloque, con dueño profesional o sala pero nunca ambos, garantizado por restricción.

**Decisiones a desarrollar.**
- Qué problema tenía el JSON: era opaco para la base, y su único campo de granularidad hacía
  doble función de duración de turno.
- Cómo se hizo la migración: relleno de datos y baja de la tabla anterior en la misma
  migración hacia adelante.

### 7.4 Licencias y feriados

**Cómo funciona.** Tres formas de excepción: día completo libre, bloqueo parcial y horario
extra fuera del patrón. Tres dueños posibles: un profesional, una sala o el negocio entero.
Una restricción garantiza que cada fila tenga exactamente uno.

**Decisiones a desarrollar.**
- Por qué un feriado del negocio es la misma tabla con un tercer dueño, y no una tabla nueva.
- Por qué la palabra que ve el usuario es "Licencia" aunque la tabla siga llamándose
  `schedule_exceptions`: las etiquetas son presentación, los identificadores son contrato.

### 7.5 Aviso antes de bloquear

**Cómo funciona.** Antes de guardar una licencia o un feriado se cuenta cuántos turnos van a
quedar en conflicto y se pide confirmación explícita. Los turnos no se cancelan: se marcan.

**Decisiones a desarrollar.**
- Por qué marcar y no cancelar: cancelar automáticamente destruye información sin
  intervención humana. La marca es reversible.
- El conteo previo y la marca usan exactamente la misma condición SQL, para que no puedan
  discrepar.

### 7.6 Ventana de reserva

**Cómo funciona.** Anticipación mínima y máxima configurable por negocio, con excepción por
servicio de cada profesional. Limita únicamente las solicitudes de clientes; el staff está
exento.

---

## 8. Turnos, conflictos y sobreturno

### 8.1 Una tabla con estado

**Cómo funciona.** Un turno es una fila con estado. Las solicitudes no tienen tabla propia:
son turnos en estado "solicitado". Seis estados y un mapa de transiciones cerrado declarado
una sola vez.

**Decisiones a desarrollar.**
- Por qué el mapa se aplica en dos capas: validación en la aplicación con mensaje útil, y
  disparador en la base como red de contención.
- Por qué el frontend consume el mismo mapa para mostrar solo los botones legales.
- Por qué la hora de fin la calcula un disparador y no una columna generada.

### 8.2 El invariante central: nunca reservar dos veces

**Cómo funciona.** El motor de conflictos es una función pura con seis clases de choque.
Se ejecuta dos veces: una como vista previa sin guardar, y otra dentro de la transacción de
guardado, con un bloqueo consultivo tomado sobre el profesional antes de leer el estado.
Dos reservas concurrentes sobre el mismo profesional se serializan; sobre profesionales
distintos siguen en paralelo. La superposición usa final excluyente.

**Decisiones a desarrollar.**
- Por qué un bloqueo consultivo y no `SELECT ... FOR UPDATE`: bloquear filas de turnos deja
  el hueco del horario vacío, donde dos primeras reservas pueden pasar las dos.
- Por qué la vista previa y la verificación real comparten el mismo agregador y el mismo
  cargador de estado.
- Por qué la vista previa nunca aplica el forzado, aunque se lo pidan: el guardado es el
  único lugar que actúa sobre él.

### 8.3 Sobreturno

**Cómo funciona.** El staff puede forzar cualquier clase de conflicto con una confirmación
booleana explícita, obteniendo un turno superpuesto y fuera de grilla. Queda registrado
quién lo autorizó, en la fila del turno y en la auditoría. El cliente nunca puede forzar.

**Decisiones a desarrollar.**
- Por qué la desalineación con la grilla es simplemente otra clase de conflicto en lugar de
  una vía paralela de duración libre.
- Por qué se avisa antes de guardar en lugar de rechazar con un error duro o guardar en
  silencio.
- Por qué un forzado redundante sobre un horario limpio no marca el turno como sobreturno.

### 8.4 Reglas de tiempo

**Cómo funciona.** El cliente cancela un turno confirmado solo dentro de un plazo
configurable por negocio; una solicitud todavía no confirmada se retira siempre. Completar
exige que el turno haya empezado; marcar ausente exige haber entrado en la misma ventana en
la que el cliente ya no podía cancelar. Las tres reglas son funciones puras compartidas
entre el servidor y la interfaz.

**Decisiones a desarrollar.**
- Por qué el plazo es configurable y no una constante.
- Por qué el staff lo saltea: la regla ata al cliente, no al mostrador.

### 8.5 Congelamiento terminal

**Cómo funciona.** En un turno cerrado solo se puede editar la nota interna del staff.
Cualquier otro campo devuelve un error de validación.

---

## 9. Turnos recurrentes

### 9.1 Regla y expansión

**Cómo funciona.** Se guarda la regla una sola vez. Las ocurrencias son virtuales: se
calculan para la ventana que se esté mirando o verificando. La primera vez que a una
ocurrencia le pasa algo real (se completa, se cancela, se mueve, se cobra) se convierte en
una fila concreta que a partir de ahí prevalece sobre su gemela virtual. Las ocurrencias que
simplemente ocurren en patrón y nunca se tocan nunca se vuelven filas.

**Decisiones a desarrollar.**
- El modelo que se descartó: materializar por adelantado con un horizonte móvil y una tarea
  diaria de reposición. Tres razones para descartarlo: era la primera pieza de
  infraestructura de fondo del proyecto, "sin fecha de fin" solo se satisfacía con
  crecimiento ilimitado de filas, y los calendarios reales no guardan ocurrencias.
- Por qué nuestras ocurrencias no son completamente sin estado, a diferencia de las de un
  calendario común: llevan precio congelado, máquina de estados y cargo a la cuenta
  corriente.

### 9.2 Integridad de la regla

**Cómo funciona.** Tres patrones y tres formas de fin, con restricciones en la base que
hacen imposible persistir una combinación incoherente. Un índice único parcial garantiza que
una serie materialice a lo sumo un turno por fecha.

### 9.3 Concurrencia sin infraestructura nueva

**Cómo funciona.** La materialización se cuelga del mismo bloqueo consultivo que ya toma la
verificación de conflictos, y el índice único parcial es el respaldo final ante una carrera.

### 9.4 Alcances de edición

**Cómo funciona.** Tres alcances: solo esta ocurrencia, esta y las siguientes (que cierra la
serie y abre una nueva), y toda la serie. Precio y duración quedan congelados al crear la
serie, y solo cambian con una edición deliberada de alcance explícito.

---

## 10. Cuenta corriente y auditoría

### 10.1 Libro inmutable con saldo derivado

**Cómo funciona.** Cuatro tipos de movimiento: cargo y ajuste de débito aumentan la deuda,
pago y ajuste de crédito la reducen. Los importes son siempre positivos y la dirección la
determina el tipo. El saldo se calcula al leer sumando y restando; no hay ninguna columna de
saldo almacenado. Las correcciones son movimientos nuevos.

**Decisiones a desarrollar.**
- Por qué dos subtipos de ajuste en lugar de una columna de dirección o de un importe
  negativo: los dos habrían roto el invariante de importes positivos.
- Por qué el saldo se calcula y no se guarda.
- Por qué la inmutabilidad se garantiza en dos capas: disparador y permisos del rol. La
  razón concreta es que en desarrollo la aplicación y las migraciones comparten rol, así que
  revocar el permiso por sí solo no sería efectivo ahí.

### 10.2 Efectos financieros explícitos

**Cómo funciona.** El único cargo automático es el de la sesión al completar un turno, y es
idempotente. Un ausente nunca cobra. Un cargo sobre un turno cancelado permanece: la
devolución es un ajuste de crédito explícito. Los pagos no se asignan a un turno, lo que
soporta pagos parciales y múltiples de forma natural.

### 10.3 Auditoría de solo agregado

**Cómo funciona.** Cada acción relevante deja un evento con actor, negocio, entidad, acción,
resultado y detalles. Se registran los éxitos y también los rechazos. Para las mutaciones de
negocio el evento se escribe en la misma transacción que la acción, de modo que no pueda
existir una acción sin su registro.

**Decisiones a desarrollar.**
- Por qué se registran los intentos denegados.
- Por qué el detalle es mínimo en lugar de guardar el antes y el después, y qué se pierde
  con esa decisión.
- Por qué un forzado de conflicto emite su propio evento (`conflict_override`) además del
  evento de la operación, en lugar de quedar como un campo dentro de ella: el mismo turno
  puede agendarse, aprobarse y reprogramarse, y cada una de esas operaciones puede o no
  haber pasado por encima de un conflicto.
- Por qué la escritura es transaccional para las acciones de negocio y de mejor esfuerzo
  para el login.

---

## 11. Interfaz

### 11.1 Dos áreas funcionales

**Cómo funciona.** El espacio de trabajo del staff y el portal del cliente son áreas
distintas, con navegación, disposición y pantallas propias. Comparten la autenticación, el
componente de calendario y las primitivas visuales.

**Decisiones a desarrollar.**
- Por qué separadas por función y no una sola aplicación con secciones ocultas por rol.

### 11.2 Calendario

**Cómo funciona.** Construido sobre la versión libre de FullCalendar, con vistas de día,
semana y mes. El contenido está acotado por quién mira, no por un conmutador. Varios
profesionales se muestran en una sola grilla con código de color y chips de filtro.

**Decisiones a desarrollar.**
- Por qué el arrastre está hecho a mano en lugar de usar el nativo de la biblioteca: la
  biblioteca solo desplaza por saltos uniformes, y la agenda tiene granularidad variable por
  bloque.
- Por qué se resaltan solo los destinos donde la duración completa entra, y por qué soltar
  fuera revierte en lugar de acomodar al horario más cercano.

### 11.3 Tablas y formularios generados

**Cómo funciona.** Las pantallas de configuración se arman desde el descriptor: título,
columnas, tipo de control por campo, campos obligatorios, filtros y orden. Las pantallas con
lógica propia (calendario, cuenta corriente, auditoría, panel de inicio, portal) están
escritas a mano.

### 11.4 Convenciones compartidas

**Cómo funciona.** Estados de carga, estados vacíos, errores por campo y avisos emergentes
para errores generales. La expiración de sesión se maneja en forma suave: se avisa, se
bloquean las acciones y se redirige recién en la siguiente navegación.

### 11.5 Disposición y navegación `[desarrollar]`

**Cómo funciona.** Menú lateral fijo para el staff, barra superior para el portal. El menú se
filtra por rol desde el mismo mapa que usan los guards del router. Los formularios de alta y
edición abren en un panel lateral o en un diálogo, nunca reemplazando la pantalla.

**Pendiente de escribir.** Respuesta explícita a las preguntas del enunciado sobre menú
lateral contra pestañas superiores, tratamiento del desborde horizontal en las tablas, y
estado del diseño adaptable.

### 11.6 Tema visual `[desarrollar]`

**Estado actual.** Tema claro únicamente, construido con nombres de color semánticos para
poder agregar el modo oscuro sin rehacer las pantallas. El botón de tema claro y oscuro que
pedía el enunciado no está implementado. Corresponde declararlo como pendiente y explicar
por qué se pagó el costo de diseño ahora.

---

## 12. Validación, listados y seguridad de consultas

### 12.1 Validación compartida

**Cómo funciona.** El validador vive en el paquete compartido y lo usan las dos capas. El
navegador lo aplica al perder el foco para dar respuesta inmediata; el servidor lo aplica
como autoridad. El cuerpo de un pedido debe traer exactamente los campos permitidos: ni de
menos ni de más. Un campo que estampa el servidor se rechaza con error por campo.

**Decisiones a desarrollar.**
- Respuesta directa al enunciado: la regla se declara una vez y las dos capas la leen. El
  frontend no la duplica ni la recibe por un endpoint de metadatos.
- Quién la fuerza: el servidor siempre. El navegador solo mejora la experiencia.
- Por qué las columnas actualizables se derivan de las creables, y ese mismo conjunto lo
  consume el constructor del `UPDATE`.

### 12.2 Claves foráneas en la interfaz

**Cómo funciona.** Toda clave foránea se edita con un selector de opciones, nunca tipeando
un identificador. Las opciones pueden depender de otra selección: los servicios ofrecidos se
filtran por el profesional elegido. En las tablas, las claves foráneas se muestran resueltas
a su nombre, con las opciones cargadas una vez por tabla y memorizadas para no disparar una
consulta por fila. Si una referencia no se encuentra se muestra el identificador atenuado, en
lugar de dejar la celda vacía.

### 12.3 Motor de listados

**Cómo funciona.** Filtrado, orden y paginación genéricos. Solo las columnas declaradas
filtrables construyen condiciones, y solo las declaradas ordenables construyen el orden; lo
demás se ignora. Las claves foráneas y las enumeraciones filtran por igualdad exacta, no por
coincidencia parcial. La paginación está acotada y el total se calcula con una función de
ventana en la misma consulta.

**Decisiones a desarrollar.**
- Por qué las claves foráneas no se filtran por subcadena: una búsqueda de "1" haría
  coincidir "10" y "21".
- Por qué los filtros desconocidos se ignoran en silencio en lugar de fallar.

### 12.4 Estado en la URL `[desarrollar]`

**Estado actual.** El enrutador usa modo historia y cada pantalla tiene su dirección, de modo
que una pantalla se puede compartir y recargar. El filtro, el orden y la página de las tablas
genéricas viven en el estado del componente, no en la dirección.

**Pendiente de escribir.** El punto del enunciado sobre reflejar en la dirección lo que el
usuario está viendo está cubierto a nivel de pantalla pero no a nivel de filtro. Corresponde
declararlo como pendiente.

### 12.5 Construcción segura de consultas

**Cómo funciona.** Todo valor viaja como parámetro. Lo único que se interpola en el texto SQL
son nombres de columna que provienen del descriptor, es decir, de una lista cerrada
controlada por el código, nunca de la entrada del usuario. El orden de los fragmentos de
alcance es fijo y la numeración de parámetros se recalcula al ensamblarlos.

**Decisiones a desarrollar.**
- Respuesta directa al enunciado sobre inyección SQL.
- Por qué esto es más fuerte que confiar en el escapado: un nombre de columna que no está en
  el descriptor no llega a la consulta.

---

## 13. Internacionalización

**Cómo funciona.** Dos fuentes de texto trabajando juntas. Los nombres de entidades,
columnas, estados, roles y tipos de movimiento vienen del descriptor del dominio, que trae
las dos versiones. Los textos de la interfaz vienen de un diccionario aparte. Las dos leen la
misma preferencia, persistida por dispositivo, con español por defecto. El diccionario en
inglés está tipado contra el español, de modo que una clave faltante rompe la compilación.
Los datos cargados por el usuario nunca se traducen.

**Decisiones a desarrollar.**
- Por qué híbrido en lugar de mover todos los textos al diccionario, lo que duplicaría el
  descriptor.
- Por qué los mensajes de conflicto se arman en el cliente a partir de códigos: mantiene la
  API neutral respecto del idioma.
- Consecuencia aceptada: la pantalla de login no tiene selector y se muestra en el último
  idioma guardado.

---

## 14. Migraciones y roles de base de datos

### 14.1 Migraciones hacia adelante con suma de comprobación

**Cómo funciona.** Archivos SQL numerados por marca de tiempo, aplicados en orden, cada uno
en su propia transacción y bajo un bloqueo consultivo. Cada migración aplicada guarda su
suma de comprobación: si alguien edita un archivo ya aplicado, la próxima corrida falla con
un mensaje explícito. Deshacer un cambio se hace escribiendo una migración nueva.

**Decisiones a desarrollar.**
- Respuesta directa al enunciado sobre cambios de esquema y tablas nuevas.
- Por qué el historial es inmutable, y qué costo tiene: reemplazar una restricción exige
  darla de baja y volver a crearla en una migración nueva.
- Por qué las semillas están fuera del historial: las migraciones definen el esquema, no
  filas de demostración.

### 14.2 Dos roles con privilegio mínimo

**Cómo funciona.** Un rol dueño posee los objetos y ejecuta las migraciones. Un rol de
aplicación recibe permisos explícitos por tabla, y los permisos amplios por defecto se
revocan en la primera migración. Los permisos están calibrados: sin borrado donde hay baja
lógica, solo lectura e inserción en las tablas de solo agregado, sin actualización donde no
hay baja lógica.

**Decisiones a desarrollar.**
- Por qué la inmutabilidad de la cuenta corriente y de la auditoría se aplica con permisos
  del rol y no solamente con código de aplicación.
- Por qué la ausencia de permiso de borrado sobre turnos es una decisión de diseño y no un
  olvido: los turnos se cancelan.

### 14.3 Deriva entre el código y el SQL

**Cómo funciona.** Donde un valor existe a la vez en TypeScript y en SQL se prefiere
derivarlo antes que duplicarlo: por ejemplo, el vencimiento de la sesión se declara una vez y
la sentencia lo interpola. Donde el lado SQL es una migración inmutable y no se puede
derivar (los estados de turno, los tipos de movimiento, el plazo por defecto), hay una prueba
que verifica que las dos copias sigan coincidiendo.

---

## 15. Errores, registro y observabilidad

**Cómo funciona.** Un único sobre de respuesta: éxito con datos y metadatos, error con
código, mensaje y errores por campo. Los listados siempre traen página, límite y total. Los
códigos de PostgreSQL se mapean a HTTP en un solo lugar. El registro es JSON estructurado con
nivel configurable, e incluye identificador de pedido, método, dirección, estado, duración y
versión; el cuerpo del pedido nunca se registra. Hay un endpoint de salud sin autenticación
que ejecuta una consulta real contra la base.

**Decisiones a desarrollar.**
- Respuesta directa al enunciado: qué se registra en el servidor y dónde, qué se le muestra
  al usuario y cómo (errores por campo en línea, errores generales en avisos emergentes).
- Por qué el mapeo de códigos de base de datos está centralizado en lugar de inspeccionarse
  en cada ruta.
- Por qué existe una red de contención para código asíncrono: una promesa rechazada mataría
  el proceso.
- Pendiente: no hay envío de errores del navegador al servidor. Corresponde declararlo.

---

## 16. Pruebas e integración continua

**Cómo funciona.** Cuatro niveles. Unitarias sobre las funciones puras del dominio. De
integración contra una base PostgreSQL real, incluida una prueba de concurrencia con dos
transacciones y una de esquema fresco que aplica todas las migraciones y la semilla sobre una
base vacía. De componente sobre la lógica difícil del frontend. Y de extremo a extremo con
Playwright contra el servidor compilado y la base sembrada. Todo corre en integración
continua en cada envío.

**Decisiones a desarrollar.**
- Respuesta directa al enunciado sobre qué debe cumplir la aplicación de extremo a extremo,
  qué el backend, y cómo se testea la interacción del usuario.
- Por qué las pruebas de extremo a extremo corren contra el sistema real y no contra una API
  simulada.
- Por qué las pruebas importan las etiquetas del dominio en lugar de repetir textos, y por
  qué usan fechas relativas al día de ejecución.
- Por qué la arquitectura de funciones puras existe en buena medida para hacer testeable el
  dominio sin base de datos.

---

## 17. Datos de demostración

**Cómo funciona.** La semilla arma un consultorio de Buenos Aires con ocho profesionales,
dos usuarios recepcionistas, treinta y cinco clientes, cinco salas y cuarenta y cinco días de agenda
densa. Todas las fechas se desplazan por semanas enteras hasta el lunes de la semana en
curso, preservando el día de la semana y la hora, así que el conjunto de datos nunca
envejece. Cubre deliberadamente todas las funcionalidades: precios por cliente, excepciones
por bloque, licencias, feriados, series recurrentes de las tres formas de fin, sobreturnos
con autorizante registrado, solicitudes pendientes, movimientos de los cuatro tipos
incluyendo un saldo vencido, y eventos de auditoría incluidos los denegados. Una cuenta por
rol, más una sembrada con cambio de contraseña forzado.

---

## Anexo. Divergencias respecto del enunciado original `[desarrollar]`

Lista de puntos donde la implementación se apartó a conciencia de lo que pedía la
especificación inicial, con el motivo en cada caso. Los principales:

| Enunciado original | Implementación | Motivo resumido |
|---|---|---|
| Grilla fija de quince minutos | Granularidad por bloque | Un profesional necesita agendas distintas en el mismo día |
| Permisos de calendario con cuatro banderas | Permiso binario | El rol del autorizado ya acota qué puede hacer |
| Un cargo como máximo por turno | Varios cargos por turno | Facturación de varias líneas por sesión |
| Ajuste único | Ajuste de débito y de crédito | Preserva el invariante de importes positivos |
| Recepcionistas con acceso financiero total | Acotado por permiso de calendario | Solo se factura contra turnos que ese usuario administra |
| Cero o más salas por turno | Cero o una sala | Simplicidad, sin tabla intermedia |
| Duración editable por turno | Duración del horario, o sobreturno | Una sola vía de excepción en lugar de dos |
| `business_id` en toda tabla | Solo en dueños directos, derivado por join | Normalización |
| Mensaje de conflicto desde el servidor | Código de conflicto, texto en el cliente | API neutral respecto del idioma |
| Vencimiento por inactividad y recordarme | Vencimiento absoluto de siete días | Alcance recortado, declarado como pendiente |
