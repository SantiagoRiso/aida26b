# Guion de demostración

Recorrido paso a paso, con qué clickear y qué tipear en cada lugar. El orden de las
sesiones es: **Profesional → Administrador → Cliente → Recepcionista**.

Cada paso indica entre paréntesis los identificadores de funcionalidad de
`FEATURES.md` que demuestra, para poder saltear bloques sin perder la cuenta de qué
quedó sin mostrar.

Duración estimada del recorrido completo: **35 a 45 minutos**. Con los bloques marcados
como *(opcional)* omitidos: **20 a 25 minutos**.

> Todo este guion fue ejecutado de punta a punta contra el sistema real. Los textos de
> pantalla, los nombres de los botones, los mensajes de error y los números que aparecen
> más abajo están verificados, no supuestos.

---

## 0. Preparación

### 0.1 Levantar el sistema

Desde la raíz del repositorio:

```bash
docker compose up -d --build
```

Correr esto **aunque los contenedores ya estén levantados**. Si el contenedor de frontend
fue creado con una configuración anterior, puede estar corriendo sin el puerto 8080
publicado, y `up --build` lo recrea. Verificar con:

```bash
curl -s http://localhost:3000/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/
```

El primero debe responder `{"success":true,"data":{"status":"ok","database":"up"}}` y el
segundo `200`. Si el health responde 503, la base todavía está arrancando; esperar unos
segundos y reintentar.

### 0.2 Cargar los datos de demostración

```bash
docker compose exec backend npm run seed:demo:reset
```

Este comando **borra todo** salvo el historial de migraciones y vuelve a sembrar. Es lo
que garantiza que la demostración sea repetible: si algo sale mal a mitad de la defensa,
se vuelve a correr y el sistema queda exactamente en el estado que describe este guion.
Termina imprimiendo `Demo reset complete (zeroed + reseeded).`

> **Importante:** correr esto **antes** de empezar, no durante. La semilla desplaza todas
> las fechas al lunes de la semana en curso, así que siempre hay unos días de historial
> hacia atrás y unas seis semanas de agenda hacia adelante, sin importar el día en que se
> haga la demostración.

Estado que deja la semilla, para poder anticipar lo que se va a ver:

| | |
|---|---|
| Negocio | Consultorio BsAs Demo, zona horaria de Buenos Aires, ARS |
| Personas | 1 administrador, 7 profesionales, 2 recepcionistas, 35 clientes |
| Catálogo | 4 servicios, 5 salas |
| Agenda | 1266 turnos, 9 series recurrentes |
| Plazo de cancelación | 24 horas |
| Ventana de reserva | de 0 a 60 días |

### 0.3 Abrir la aplicación

Navegador en **http://localhost:8080**.

Conviene abrir la ventana en **modo incógnito** o cerrar sesión entre bloques, porque la
sesión vive en una cookie y el guion cambia de usuario cuatro veces.

### 0.4 Credenciales

Todas comparten la contraseña **`demo-pass-123`**.

| Bloque | Usuario | Rol | Persona |
|--------|---------|-----|---------|
| 1 | `demo_pro` | Profesional | Dra. Marge Bouvier, psicóloga |
| 2 | `demo_admin` | Administrador | Admin Demo |
| 3 | `demo_client` | Cliente | Homero Simpson |
| 4 | `demo_recep` | Recepcionista | Recepcionista Demo |
| Anexo A | `demo_reset` | Profesional | Dr. Arnie Pye, con cambio de contraseña forzado |
| Anexo A | `demo_client_overdue` | Cliente | Bart Simpson, con saldo vencido |

### 0.5 Dos advertencias de manejo

- **No usar la tecla Escape para cerrar un selector de fecha.** Escape cierra el diálogo
  entero y se pierde lo cargado. Para cerrar un calendario emergente, clickear afuera.
- Los selectores de este sistema **se colapsan a una etiqueta de solo lectura cuando hay
  una sola opción posible**. Por eso, con `demo_pro` el campo Profesional aparece como
  texto y no como desplegable: es correcto, no es un error.

---

## Bloque 1. Profesional (`demo_pro`)

**Objetivo:** mostrar el día a día de quien atiende. Agenda propia, gestión de solicitudes,
conflictos, sobreturno y configuración de su horario.

### 1.1 Ingreso (F2.1, F2.3, F2.4, F2.6)

Antes del login real conviene mostrar el error genérico, que es más interesante que el
camino feliz.

1. Campo **Usuario**: tipear `demo_pro`. Campo **Contraseña**: tipear `cualquiercosa`.
   Clickear **Ingresar**.
2. Aparece: **"Credenciales inválidas. Verificar usuario y contraseña."**
3. Ahora tipear usuario `noexiste` con cualquier contraseña. Clickear **Ingresar**.
4. Aparece **exactamente el mismo mensaje**.

> **Para señalar:** el sistema nunca revela si la cuenta existe. Y no solo el texto es
> igual: ante un usuario inexistente el servidor igual calcula el hash de la contraseña
> contra un valor señuelo, para que **el tiempo de respuesta tampoco delate** la
> diferencia. Sin eso, un atacante mide la demora y descubre qué usuarios existen.

5. Campo **Usuario**: `demo_pro`. Campo **Contraseña**: `demo-pass-123`.
6. Clickear el ícono del ojo para mostrar la contraseña y clickearlo de nuevo para
   ocultarla.
7. Clickear **Ingresar**.

### 1.2 Menú lateral (F3.13, F16.11)

Sin hacer nada todavía, señalar el menú de la izquierda. Un profesional ve exactamente
siete secciones:

**Inicio · Calendario · Horario · Solicitudes · Clientes · Perfil · Configuración**

No ve **Negocio**, **Usuarios**, **Auditoría** ni **Profesionales**. Al pie figura
`demo_pro (Profesional)`.

> **Para señalar:** esto es solo la capa visual. El menú se arma leyendo el mismo mapa de
> permisos que usa el servidor, pero si alguien escribe la URL a mano igual lo rechaza el
> backend. Eso se demuestra en el paso 4.6.

### 1.3 Panel de inicio (F9.27)

Ya estamos en **Inicio**. Arriba de todo hay **una tarjeta de cierre por cada turno que ya
pasó y sigue abierto**. Sobre datos recién sembrados son cuatro. Cada una muestra el
título del turno, la fecha, la sala, el servicio, el precio, un campo **Pago (ARS)** ya
completado con el precio del turno, y tres botones: **Pagó**, **No pagó**, **Ausente**.

Más abajo están **Próximos turnos** y **Solicitudes pendientes** (con el DNI de cada
cliente).

> **Para señalar:** en este momento **no** aparece la tarjeta "Turnos en conflicto". Es
> correcto: sobre datos frescos los únicos conflictos sembrados están en el pasado, y esa
> tarjeta solo lista turnos futuros. Va a aparecer en el paso 1.7, cuando creemos una
> licencia sobre un día que ya tiene turnos.

No tocar los botones todavía: se usan en el paso 1.8.

### 1.4 Calendario (F17.1, F17.3, F17.4, F17.13, F17.14)

1. Clickear **Calendario**.
2. Se abre en vista **Semana**, sobre la semana en curso.
3. Señalar la barra **Filtrar por:**. Marge ve **un solo chip de profesional, el suyo, ya
   seleccionado**, más los chips de salas (**Todas las salas**, Consultorio 1 a 5).

   > **Para señalar:** el filtro no es un conmutador de visibilidad. El servidor le
   > devuelve un único profesional porque es el único que puede ver. En el paso 2.4 el
   > administrador va a abrir exactamente la misma pantalla y le van a aparecer siete
   > chips, sin que cambie una línea de la interfaz.

4. Clickear **Día**, **Semana** y **Mes** arriba a la derecha. Volver a **Semana**.
5. Señalar los fondos: el rayado gris es fuera de horario, los recuadros punteados son
   horarios reservables libres, el gris claro es tiempo pasado, y la **banda rosa vertical
   con la leyenda "Feriado nacional"** es una licencia sembrada de día completo.
6. Buscar los turnos con **anillo rojo y un signo de admiración**: son los que están en
   conflicto con esa licencia. Y los que tienen un **ícono de repetición** son ocurrencias
   de una serie recurrente que todavía no se materializaron.
7. Pasar el puntero sobre un turno: aparece el globo con cliente, profesional, sala,
   servicio, precio y estado. Sobre un sobreturno agrega **"Sobreturno: Sí"**; sobre una
   ocurrencia virtual, **"Ocurrencia recurrente (aún no confirmada)"**.

### 1.5 Crear un turno, y forzar un sobreturno (F10.1, F10.7, F10.11, F17.5)

Este es el paso central de toda la demostración.

**Primera parte, un turno normal.** En la vista **Semana**, clickear y arrastrar sobre un
espacio libre (recuadro punteado) de un día futuro. Se abre **Nuevo turno** con la fecha y
la hora ya cargadas. Elegir un cliente y clickear **Guardar**.

**Segunda parte, el sobreturno.** Acá conviene usar el botón en lugar del arrastre, porque
el resultado es determinístico y no depende de dónde caiga el mouse.

1. Clickear **Nuevo turno** arriba a la derecha.
2. **Tildar primero la casilla `Sobreturno`.** El bloque "Seleccionar un horario"
   desaparece y en su lugar aparecen **Hora \*** y **Duración (min) \***.

   > **Por qué en este orden:** con Sobreturno apagado el formulario **solo ofrece
   > horarios libres**, así que es imposible provocar un choque. El modo sobreturno es
   > justamente el que permite pedir un horario arbitrario.

3. Campo **Cliente \***: tipear `Nelson` y elegir **Nelson Muntz**.
4. Los campos **Profesional \*** y **Servicio \*** aparecen como texto fijo
   (*Dra. Marge Bouvier*, *Sesión de Psicología Infantil*): Marge es la única profesional
   que puede elegir y ofrece un solo servicio.
5. Campo **Fecha \***: tipear el **martes de la semana que viene** en formato
   `dd/mm/aaaa`.
6. Campo **Hora \***: tipear `10:40`. Campo **Duración (min) \***: tipear `50`.
7. Clickear **Guardar**.
8. Aparece el diálogo **Conflicto de horario**:

   > Este horario se superpone con un turno existente.
   > *Este horario se superpone con otro turno de Dra. Marge Bouvier (10:40-11:30).*
   > Si elegís "Reservar de todos modos", el turno se guardará como sobreturno.

9. Clickear **Reservar de todos modos**.
10. El turno queda guardado, superpuesto, con el ícono de sobreturno.

> **Para señalar, tres cosas distintas:**
>
> 1. El sistema **avisa antes de guardar**. No rechaza con un error duro ni guarda en
>    silencio. Y el mensaje no viene armado desde el servidor: el servidor devuelve un
>    código de conflicto y los datos (quién, qué rango horario), y el navegador arma el
>    texto. Por eso la misma respuesta funciona en español y en inglés.
> 2. El forzado queda **registrado con quién lo autorizó**. La fila del turno guarda el
>    indicador de sobreturno y el identificador del autorizante.
> 3. El mismo control se vuelve a ejecutar **dentro de la transacción** de guardado, con
>    un bloqueo tomado sobre ese profesional antes de leer nada. Dos personas reservando
>    el mismo horario al mismo tiempo no pueden ganar las dos. Hay una prueba automatizada
>    con dos transacciones concurrentes que lo demuestra (Anexo C).

### 1.6 Mover un turno arrastrando (F17.7, F17.9, F17.11) *(opcional)*

1. Tomar un turno futuro y empezar a arrastrarlo.
2. Mientras se arrastra se **resaltan solo los destinos válidos**: los horarios donde la
   duración completa de ese turno entra en tiempo libre. No se resaltan todos los huecos,
   sino los que sirven para ese turno en particular.
3. Soltar sobre un destino resaltado. Aparece el diálogo **Reprogramar** con el texto
   *"Mover el turno a ..."*. Clickear **Confirmar**.
4. Repetir, pero **soltar sobre una zona no resaltada**. El turno vuelve solo a su lugar.
   No se teletransporta al horario más cercano.
5. Tildar **Sobreturno** arriba a la derecha y arrastrar de nuevo: ahora el turno se ubica
   en cualquier horario, con pasos finos, fuera de la grilla publicada. Destildarlo antes
   de seguir.

### 1.7 Licencias, y el aviso de conflictos (F7.8, F7.10, F7.11, F10.12)

> **Dónde está esto:** la **creación** de licencias vive en **Perfil**, no en Calendario.
> El calendario solo las **muestra y las borra**, y solo las del rango de fechas visible.
> Es coherente: una licencia es algo del profesional, no del calendario que se esté
> mirando.

1. Clickear **Perfil** en el menú.
2. Bajar hasta **Mis licencias**. El formulario está siempre visible, no hay que abrirlo.
3. Campo **Tipo \***: dejar **Día libre**. Las otras opciones son **Bloqueo parcial** y
   **Horario extra**.
4. Campo **Fecha \***: tipear el **lunes de la semana que viene** en formato `dd/mm/aaaa`.
5. Campo **Motivo**: tipear `Congreso`.
6. Clickear **Guardar**.
7. Aparece el diálogo **Agregar licencia** con el conteo exacto, por ejemplo:
   **"Va a dejar 9 turnos en conflicto el 20/07. ¿Continuar?"**
8. Clickear **Continuar**.

> **Para señalar:** la licencia **no cancela nada**. Marca los turnos en conflicto y deja
> que una persona decida qué hacer con cada uno. Es una decisión deliberada: cancelar
> automáticamente destruiría información sin intervención humana, y la marca es
> reversible. Además, el número que muestra el aviso se calcula con **la misma condición
> SQL** que después marca los turnos, así que el aviso no puede mentir.

9. Volver a **Inicio**. Ahora sí aparece la tarjeta **Turnos en conflicto (9)** con el
   texto *"Se detectaron conflictos con otros eventos del calendario. Revise cada turno y
   reprográmelo o cancélelo según corresponda."*
10. Cada fila trae **Ignorar**, **Reprogramar** y **Cancelar**. La primera fila, que es una
    solicitud, trae además **Aprobar** y **Denegar** en lugar de Cancelar.
11. Clickear **Ignorar** en una fila. Ese turno sale de la lista y pierde el anillo rojo.
    Es reversible: desde el detalle del turno se puede clickear **Reactivar aviso**.

### 1.8 Cerrar un turno y cobrar (F9.16, F9.19, F13.2)

1. Volver a **Inicio** y usar la primera tarjeta de cierre.
2. El campo **Pago (ARS)** ya viene con el precio congelado del turno.
3. Clickear **Pagó**.
4. El turno pasa a completado y se registran **dos** movimientos en la cuenta corriente del
   cliente: el cargo de la sesión y el pago.

Alternativas para mencionar sin ejecutarlas: **No pagó** completa el turno generando solo
el cargo, y **Ausente** marca la inasistencia y **nunca genera cargo**.

> **Para señalar:** si el turno todavía no empezó, los tres botones están deshabilitados y
> aparece *"El turno todavía no empezó"*. Esa regla es una función pura compartida: el
> backend la aplica y la interfaz la usa para deshabilitar el botón, así que no pueden
> discrepar. Si alguien saltea la interfaz y llama a la API directamente, recibe un error
> `too_early`.

### 1.9 Editor de horario semanal (F7.1, F7.3, F7.5, F7.6, F6.4)

1. Clickear **Horario**. El título es **Editor de horario**.
2. El selector **Profesional** aparece colapsado a la etiqueta *Dra. Marge Bouvier*: es la
   única que puede editar.
3. Debajo, la ayuda: *"Arrastrar sobre un día para crear un bloque. Hacer clic en un bloque
   para seleccionarlo."*
4. La grilla muestra **días de la semana sin fechas**: es una plantilla recurrente, no un
   calendario. Los bloques sembrados de Marge son:

   | Día | Bloques |
   |---|---|
   | lunes a jueves | 09:00 a 13:10 **y** 13:50 a 17:10 |
   | viernes | 09:00 a 14:00 |
   | sábado | 09:00 a 11:30 |
   | domingo | sin bloques |

   > **Para señalar:** ese hueco de 13:10 a 13:50 es el almuerzo, y existe porque el modelo
   > admite **varios bloques por día**, no una única franja de apertura a cierre.

5. **Crear un bloque:** arrastrar sobre una franja libre del sábado a la tarde.
6. **Mover:** arrastrar el bloque nuevo desde el centro. **Redimensionar:** tomar el borde
   inferior y estirarlo.
7. **Intentar superponer:** arrastrarlo encima de otro bloque del mismo día. El sistema lo
   impide durante el arrastre, y si se fuerza por otra vía responde *"El bloque se
   superpone con otro en ese día."*
8. Clickear sobre un bloque para abrir **Editar bloque**: **Hora inicio**, **Hora fin**, y
   a la derecha el panel **Servicios del bloque**.
9. En el panel, tildar **Cambiar duración y precio** sobre un servicio. Se habilitan
   **Duración (min)** y **Precio**.
10. Tipear una duración que no divida el bloque, por ejemplo `45` en un bloque de 4 horas.
    Aparece el aviso *"Con turnos de 45 min, los últimos N min del bloque no se pueden
    reservar."*
11. Clickear **Cancelar** para no guardar.
12. Borrar el bloque de prueba con **Eliminar bloque** y confirmar.

> **Para señalar:** acá es donde el proyecto se separa del enunciado original, que fijaba
> una grilla de 15 minutos. **Cada bloque define el tamaño y el precio de sus turnos.** Un
> profesional puede atender sesiones de 50 minutos a la mañana y consultas de 30 a la
> tarde, con precios distintos, dentro del mismo día. Y la disponibilidad no se guarda en
> ninguna tabla: se calcula al vuelo restando licencias, feriados y turnos ya tomados.

### 1.10 Perfil (F5.11, F12.5, F12.10, F8.11)

Volver a **Perfil** y recorrer las cinco secciones:

1. **Datos personales:** Nombre visible, Email, Teléfono y **Biografía**. Cambiar la
   biografía y clickear **Guardar**.
2. **Mis servicios:** columnas **Mín** y **Máx**, que son la anticipación en días con la
   que se le puede reservar cada servicio. Vacío significa que hereda el valor del negocio.
3. **Cambiar contraseña:** mostrar los campos sin usarlos.
4. **Mis licencias:** el formulario del paso 1.7 y el listado, que ahora tiene dos
   entradas.
5. **Quién gestiona mi calendario:** aparece **demo_recep** con el chip *Recepcionista* y
   un botón **Quitar acceso**. Debajo, **Dar acceso a** con los siete profesionales y el
   otro usuario recepcionista.

> **No usar "Quitar acceso":** ese permiso se necesita en el Bloque 4.

> **Para señalar:** un profesional administra los permisos **de su propio calendario y de
> ningún otro**. Un usuario administrador puede administrar cualquiera. Un usuario
> recepcionista no puede administrar ninguno. Y el permiso es **binario**: la fila existe
> o no existe. No hay casillas de "puede ver" o "puede cancelar", porque lo que el
> autorizado puede hacer ya lo determina su rol.

### 1.11 Cerrar sesión

Clickear **Salir** al pie del menú lateral.

---

## Bloque 2. Administrador (`demo_admin`)

**Objetivo:** mostrar la configuración del negocio, la gestión de usuarios y la auditoría.

### 2.1 Ingreso

Usuario `demo_admin`, contraseña `demo-pass-123`, **Ingresar**.

### 2.2 Menú lateral (F3.2, F3.13)

El menú ahora tiene **diez** secciones: aparecen **Profesionales**, **Negocio**,
**Usuarios** y **Auditoría**, que el profesional no veía. Y **desaparece Perfil**, porque
el administrador edita a cualquier profesional desde **Profesionales** en lugar de tener
una pantalla para sí mismo.

### 2.3 Panel de inicio del administrador

El **Inicio** del administrador es distinto al del profesional: tres tarjetas numéricas
(**Turnos hoy**, **Solicitudes pendientes**, **Eventos recientes**), tres accesos rápidos
(**Usuarios**, **Configuración**, **Ver auditoría**) y la lista de **Actividad reciente**
con los últimos eventos de auditoría.

### 2.4 Calendario de todo el negocio (F17.3, F17.4)

1. Clickear **Calendario**.
2. La barra **Filtrar por:** ahora trae **un chip por cada profesional**, cada uno con su
   punto de color, además de **Todos** y los chips de salas.
3. Clickear el chip de un profesional para filtrar la grilla y volver a **Todos**.

> **Para señalar:** es exactamente la misma pantalla que vio Marge en el paso 1.4. Lo que
> cambia no es el componente sino **qué devuelve el servidor** según quién pregunta.

### 2.5 Gestión de usuarios (F5.3, F5.7, F5.8, F5.9, F2.13)

1. Clickear **Usuarios**, después **Agregar usuario**.
2. **Usuario**: `demo_nuevo`. **Email**: `nuevo@demo.test`. **Contraseña**: `temporal-123`.
   **Rol**: **Recepcionista**. **Nombre visible**: `Recepción Tarde`.
3. Clickear **Guardar**. El usuario aparece en la tabla.

> **Para señalar:** ese usuario nace con la marca de **cambio de contraseña obligatorio**.
> El administrador tipea una contraseña temporal y se la comunica por fuera del sistema
> (no hay envío de mails en este alcance). La primera vez que la persona ingresa, no puede
> hacer absolutamente nada hasta cambiarla. Eso se demuestra en el Anexo A.

4. En la fila de **cualquier otro** usuario, clickear **Resetear contraseña** y cerrar el
   panel sin guardar.
5. Señalar que en la fila **del propio administrador** no aparecen ni **Desactivar** ni
   **Resetear contraseña**. El servidor rechaza las dos operaciones sobre uno mismo: la
   primera dejaría al negocio sin administrador, la segunda invalidaría la sesión en curso.
6. Mencionar que **desactivar nunca borra**: marca la baja, guarda quién la hizo y elimina
   todas las sesiones abiertas de esa persona.

### 2.6 Configuración del negocio (F7.12, F6.1, F6.12, F9.13, F8.11, F12.5)

Clickear **Negocio**. La pantalla es una grilla de dos columnas con cinco tarjetas, todas
visibles a la vez: **General**, **Administración de Staff**, **Salas**, **Días festivos** y
**Servicios**.

**General**

1. Los tres campos vienen en `24`, `0` y `60`.
2. Probar la validación: poner **Anticipación máxima (días)** en `2`, dejar **mínima** en
   `10` y clickear **Guardar**. Aparece *"La anticipación máxima debe ser mayor o igual a
   la mínima."*
3. Corregir a `0` y `60` y guardar bien. Aparece el aviso **"Configuración guardada."**

> **Para señalar:** el plazo de cancelación es **por negocio y configurable**, no una
> constante escrita en el código. La ventana de reserva tiene dos niveles: este valor
> general, y el override por servicio que cada profesional tiene en su Perfil.

**Administración de Staff**

4. En el selector **Profesional**, elegir **Dra. Marge Bouvier**.
5. **Permisos de calendario** muestra **demo_recep**. Desde acá el administrador puede
   otorgar y quitar permisos sobre **cualquier** calendario del negocio.
6. **Servicios ofrecidos** muestra los servicios con casilla. Destildar y volver a tildar
   uno: se guarda al instante, sin botón de confirmación. Si la escritura falla, la casilla
   vuelve sola a su estado anterior.

**Salas**

7. Cada sala (Consultorio 1 a 5) tiene un botón **Horario** y los enlaces **Editar** y
   **Eliminar**. Clickear **＋ Agregar sala**, tipear `Consultorio 6` y clickear
   **Agregar**.
8. En esa sala, clickear **Horario**. Se abre **el mismo editor de bloques** del paso 1.9,
   pero para una sala. Señalar que **el panel de servicios no aparece**: una sala es una
   ventana de disponibilidad, no ofrece servicios.
9. Cerrar y eliminar la sala de prueba con **Eliminar**, confirmando.

**Días festivos**

10. El formulario está siempre visible. Campo **Fecha**: tipear un día hábil de la semana
    que viene. Dejar tildado **Todo el día**. Campo **Motivo (opcional)**: tipear
    `Feriado nacional`.
11. Clickear **Agregar día festivo** (ese botón es el que guarda).
12. Aparece el diálogo **Día festivo** con un conteo mucho más grande que el del paso 1.7,
    por ejemplo: **"Va a dejar 39 turnos en conflicto el 22/07. ¿Continuar?"**

> **Para señalar:** 9 turnos cuando la licencia era de una sola profesional, 39 cuando el
> cierre es de todo el negocio. En la base son **la misma tabla**, con un tercer tipo de
> dueño posible, y hay una restricción que garantiza que cada fila tenga exactamente uno
> de los tres: un profesional, una sala, o el negocio.

13. Clickear **Continuar** o **Cancelar**, según se quiera dejar el dato cargado.

**Servicios**

14. La tabla muestra Nombre, Descripción, Duración (min), Precio (ARS) y Acciones, con
    paginación al pie (*Página 1 de 1 · Total: 4*).
15. Clickear **Agregar servicio**. En el formulario, señalar que los campos, sus etiquetas,
    cuáles llevan asterisco y qué control usa cada uno **no están escritos en esta
    pantalla**: se derivan de la definición de la tabla. Cerrar sin guardar.

### 2.7 Auditoría (F14.1, F14.5, F14.8, F14.10)

1. Clickear **Auditoría**. Las columnas son **Fecha**, **Evento**, **Entidad**, **Actor** y
   **Resultado**.
2. Recorrer las primeras filas: se ven `login_success`, `logout`, `grant_listed`,
   `login_failed` con resultado **failure** (el login fallido del paso 1.1), y una fila
   **resaltada en rojo** con el ícono ⛔ y resultado **denied**.

> **Para señalar:** se registran los **rechazos**, no solo los éxitos. Un intento denegado
> es justamente lo que interesa auditar.

3. En el campo **Tipo de evento**, tipear `conflict_override` y clickear **Buscar**.
   Aparecen **dos** filas: el forzado que trae la semilla y **el sobreturno creado en el
   paso 1.5**, con quién lo autorizó.

   > **Ojo:** el filtro es de **coincidencia exacta**, no de subcadena. Tipear `override`
   > devuelve cero resultados. Hay que escribir el nombre completo del evento.

   > **Para señalar:** el sobreturno deja **dos** eventos, no uno. Por un lado
   > `appointment_scheduled`, que es la reserva. Por otro `conflict_override`, que es el
   > hecho de haber pasado por encima de un conflicto. Están separados a propósito: el
   > mismo turno puede agendarse, aprobarse y reprogramarse, y cada una de esas operaciones
   > puede o no haber forzado un conflicto. Si el forzado fuera solo un detalle dentro del
   > evento de reserva, no se podría filtrar "mostrame todos los sobreturnos" sin saber de
   > antemano qué operación los produjo. El campo de detalle del evento guarda cuál fue
   > (`{"operation": "schedule"}`).

4. Clickear **Limpiar**.
5. En el selector **Resultado**, elegir **denied** y clickear **Buscar**. Queda solo la
   fila de acceso rechazado.

> **Para señalar, dos cosas más:**
>
> - El registro es de **solo agregado**. Hay un disparador que rechaza cualquier intento de
>   modificar o borrar una fila, y además el rol de la aplicación **solo tiene permiso de
>   lectura e inserción** sobre esa tabla. Son dos capas independientes, y en el Anexo B se
>   ve cada una fallando por su lado.
> - Para las acciones de negocio, el evento se escribe **en la misma transacción** que la
>   acción. No puede existir un turno completado sin su registro de auditoría.

### 2.8 Cerrar sesión

**Salir**.

---

## Bloque 3. Cliente (`demo_client`)

**Objetivo:** mostrar el portal desde el otro lado del mostrador y las restricciones que
tiene un cliente.

### 3.1 Ingreso

Usuario `demo_client`, contraseña `demo-pass-123`, **Ingresar**.

El cliente aterriza en **/portal**, que es un área completamente distinta: barra superior
en lugar de menú lateral, y solo tres secciones: **Mis turnos**, **Mi saldo** y
**Preferencias**.

### 3.2 Mis turnos (F15.2, F15.3)

Homero tiene tres turnos próximos:

| Estado | Cuándo | Con quién | Precio | Botón |
|---|---|---|---|---|
| Programado | lunes que viene, 14:00 | Dra. Marge Bouvier | $ 6.500,00 | Cancelar |
| Programado | jueves que viene, 09:00 | Dra. Lisa Simpson | $ 7.000,00 | Cancelar |
| Solicitado | lunes de la otra semana, 11:30 | Dra. Marge Bouvier | $ 6.500,00 | Retirar solicitud |

1. Señalar que el turno solicitado dice **"Pendiente de aprobación"** y su botón es
   **Retirar solicitud**, no Cancelar.
2. Bajar a **Calendario**: el cliente ve su propio calendario, pero **no puede arrastrar ni
   redimensionar** nada.
3. Bajar a **Historial**: los turnos pasados con su estado y precio.

### 3.3 Solicitar un turno (F15.4, F15.6, F15.7, F6.5, F6.6)

1. Clickear **Solicitar turno**. Arriba aparece el paso a paso:
   **1. Profesional › 2. Horario › 3. Precio**.
2. **Paso 1.** En el buscador de **Profesional** tipear `Marge`. La opción muestra el
   nombre, la biografía y los servicios que ofrece. Elegirla.
3. El campo **Servicio** se colapsa solo a *Sesión de Psicología Infantil (50min)*, porque
   Marge ofrece un único servicio. Clickear **Siguiente**.
4. **Paso 2.** Campo **Fecha**: elegir el **viernes de la semana que viene**. Aparecen los
   horarios disponibles como botones (`11:30 (50m)` y similares). Elegir uno.

   > **Para señalar:** el cliente ve **solo horarios reservables**. No ve el turno de otro
   > paciente ni su nombre: el tiempo ocupado es opaco. Y el selector de fecha está acotado
   > a la ventana de reserva del negocio, así que no puede pedir un turno para dentro de
   > dos años.

5. Clickear **Ver precio**.
6. **Paso 3.** Aparece el resumen: Profesional, Servicio, Fecha, Horario, y
   **Costo estimado: $ 6.500,00**.

   > **Para señalar, el punto más importante del bloque:** el catálogo dice que ese
   > servicio cuesta **$8.000**. A Homero le muestra **$6.500** porque tiene una tarifa
   > particular acordada con Marge. La cadena de precedencia es: precio por cliente, si no
   > hay entonces precio del bloque horario, si no hay entonces precio por defecto del
   > servicio. Y la función que resuelve ese precio es **la misma** que se usa al guardar,
   > así que lo que el cliente ve acá no puede diferir de lo que se le va a cobrar.
   > Además el texto aclara *"Costo estimado al momento de la solicitud. El precio final
   > puede variar."*: la cuenta corriente es la verdad de lo adeudado, no esta pantalla.

7. Leer la nota: *"La solicitud queda en estado Solicitado hasta ser revisada. El resultado
   aparece en Mis turnos."*
8. Clickear **Solicitar turno**. Vuelve a la lista con el turno nuevo en estado
   **Solicitado**.

> **Para señalar:** el cliente **nunca** agenda directo. Siempre solicita, y alguien del
> staff aprueba, lo cual va a pasar en el paso 4.3. Tampoco puede elegir sala, ni fijar la
> duración, ni forzar un conflicto. Esas tres cosas ni siquiera se le ofrecen, pero además
> el servidor las ignora si llegaran en el pedido.

### 3.4 Plazo de cancelación (F9.13, F9.14, F15.9)

1. El turno en estado **Solicitado** tiene su botón **Retirar solicitud** habilitado, sin
   importar para cuándo sea.
2. Los turnos **Programados** tienen **Cancelar**. Si alguno cae dentro de las próximas 24
   horas, su botón aparece **deshabilitado** con el aviso en rojo *"Venció el plazo para
   cancelar este turno (24h antes del inicio)."*
3. Clickear un turno para abrir el panel de detalle y usar **Cancelar turno**. Confirmar en
   el diálogo.

> **Para señalar:** la distinción es deliberada. Una solicitud que todavía nadie confirmó
> se puede retirar en cualquier momento, porque no le reservó el tiempo a nadie de verdad.
> El plazo aplica solo a los turnos ya confirmados. Y el staff lo puede saltear siempre: la
> regla ata al cliente, no al mostrador.
>
> Si el plazo se cambia en **Negocio → General**, este aviso cambia solo: el número sale de
> la configuración, no está escrito en la pantalla.

### 3.5 Mi saldo (F13.4, F13.15)

1. Clickear **Mi saldo**. Homero tiene **$ 0,00** en verde: *"La cuenta está al día."*
2. En **Historial de movimientos** se ven los dos movimientos que lo dejaron en cero: un
   cargo de $6.500 y un pago de $6.500.

**Para comparar (opcional):** cerrar sesión, ingresar como `demo_client_overdue`
(Bart Simpson) y volver a **Mi saldo**. El saldo es **$ 11.500,00** en rojo con *"La cuenta
tiene saldo pendiente."*, y el historial tiene cuatro movimientos: dos cargos, un pago
parcial y un ajuste de débito por mora.

> **Para señalar:** ningún movimiento se puede editar ni borrar. Las correcciones son
> movimientos nuevos, y el saldo no está guardado en ninguna columna: se calcula al leer,
> sumando débitos y restando créditos. El Anexo B lo demuestra intentando modificarlo
> desde la base.

### 3.6 Cambio de idioma (F18.1, F18.2, F18.3)

1. Clickear **Preferencias**, después **English**.
2. Toda la interfaz cambia: el menú, los botones, y también **los estados de los turnos y
   los nombres de las columnas**. Volver a **My appointments** para verlo.
3. Volver a **Preferences** y clickear **Español**.

> **Para señalar:** son dos fuentes de texto trabajando juntas. Los nombres de entidades,
> columnas, estados y roles vienen de la definición única del dominio, que trae las dos
> versiones. Los textos de la interfaz vienen de un diccionario aparte. Las dos leen la
> misma preferencia, guardada por dispositivo. Y lo que el usuario tipeó (el nombre de un
> cliente, la descripción de un turno) **nunca se traduce**.

### 3.7 Cerrar sesión

**Salir**.

---

## Bloque 4. Recepcionista (`demo_recep`)

**Objetivo:** mostrar el alcance por permisos de calendario, que es la parte menos obvia
del modelo de autorización, y cerrar el circuito aprobando la solicitud del Bloque 3.

### 4.1 Ingreso

Usuario `demo_recep`, contraseña `demo-pass-123`, **Ingresar**.

El menú tiene siete secciones: **Inicio, Calendario, Horario, Solicitudes, Clientes,
Profesionales, Configuración**. No tiene Negocio, ni Usuarios, ni Auditoría, ni Perfil.

### 4.2 El alcance está acotado por permisos (F3.7, F12.1, F12.9)

1. Clickear **Calendario**. La barra **Filtrar por:** muestra **dos** chips de profesional:
   **Dra. Marge Bouvier** y **Dr. Ned Flanders**. No los siete del negocio.
2. Clickear **Profesionales** en el menú. La tabla también trae **solo esos dos**.

> **Para señalar:** no es un filtro de pantalla. El servidor agrega a cada consulta la
> condición de permiso y devuelve dos filas. El permiso es **binario**: la sola existencia
> de la fila `(profesional, autorizado)` habilita el calendario. **Qué** se puede hacer
> sobre él lo determina el rol del usuario autorizado, no el permiso. Y la ausencia de
> permiso no se manifiesta como un error sino como **ausencia**: los otros cinco
> profesionales simplemente no existen para esta sesión.

### 4.3 Aprobar la solicitud del cliente (F9.10, F10.11)

1. Clickear **Solicitudes**. Arriba hay dos filtros: **Profesional** (con la opción *Todos
   los profesionales*) y **Cliente** (*Buscar por nombre o DNI...*).
2. En la lista aparece **la solicitud que Homero envió en el paso 3.3**, con su fecha, su
   horario y **$ 6.500,00**.
3. Clickear sobre esa fila para abrir el detalle, que muestra en dos columnas:
   - **Solicitud:** fecha, profesional, servicio, sala, precio.
   - **Cliente:** nombre, email y teléfono.
   - **Saldo / deuda:** el saldo del cliente, en rojo si debe.
   - **Historial:** contadores de **Turnos**, **Completados**, **Cancelados** y
     **Ausencias**, y el detalle de los turnos previos.
   - A la derecha, **Agenda del día:** el calendario del profesional para esa fecha, en
     solo lectura, con la solicitud en revisión resaltada con borde azul.
4. Clickear **Aprobar**. El turno pasa a **Programado**, conservando el precio de $6.500
   congelado desde la solicitud.

> **Para señalar:** aprobar **vuelve a verificar los conflictos**. Entre que el cliente
> pidió el horario y alguien lo mira, el hueco pudo haberse ocupado. Si eso pasa, aparece
> el mismo diálogo del paso 1.5 y hay que forzarlo a conciencia.

5. Sobre otra solicitud, clickear **Rechazar** y confirmar. Ese turno pasa a **Rechazado**,
   que es un estado terminal del que nunca vuelve. El Anexo B demuestra que ni siquiera se
   puede revertir escribiendo SQL a mano.

### 4.4 Alta de cliente sin credenciales (F5.4, F5.6, F5.12)

Este es el caso "llamó alguien por teléfono y hay que anotarlo".

1. Clickear **Clientes**, después **Agregar cliente**.
2. **Nombre visible \***: `Maude Flanders`. **Email \***: `maude@demo.test`.
   **DNI**: `30991234`.
3. Dejar **sin tildar** la casilla **Crear usuario**.
4. Clickear **Guardar**. El cliente aparece en la tabla y ya se le puede agendar un turno.

> **Para señalar:** esa persona **no tiene usuario ni contraseña**. En la base, las columnas
> de nombre de usuario y de contraseña quedan **nulas**, y PostgreSQL permite varios nulos
> en un índice único, así que la unicidad de los usuarios reales se preserva sin ningún
> truco. El camino de login está cerrado por defecto: un intento contra una cuenta sin
> contraseña se comporta **exactamente igual** que contra un usuario inexistente, con el
> mismo mensaje y la misma demora del paso 1.1. Más adelante, desde la ficha, se puede
> clickear **Crear usuario** para habilitarle el acceso.
>
> El DNI es único **por negocio**, mediante un índice único parcial que solo aplica cuando
> el DNI no es nulo: impide cargar dos veces a la misma persona, sin impedir tener muchas
> fichas sin DNI.

5. En el buscador tipear `30991234`: la búsqueda funciona por nombre **y** por DNI.
6. Señalar la casilla **Incluir clientes sin relación previa**: por defecto, quien no es
   administrador ve solo los clientes con los que hubo turnos.

### 4.5 Cuenta corriente con alcance acotado (F13.11, F13.12)

1. Clickear sobre un cliente que tenga turnos con Marge o con Ned, por ejemplo **Bart
   Simpson**.
2. En la ficha, la sección **Cuenta corriente** muestra el saldo y los movimientos.
3. Clickear **Cargar pago / ajustar saldo** y abrir el selector **Tipo**.
4. El selector ofrece **dos tipos: Cargo y Pago**. No ofrece los ajustes.
5. Elegir **Pago**. Aparece el campo **Turno**, marcado con asterisco.
6. Elegir un turno. El importe queda **en blanco**: hay que tipearlo. Tipear `3000.00` y
   clickear **Guardar**.
7. El movimiento aparece en la tabla y el saldo se recalcula.
8. Volver a abrir el formulario, elegir **Cargo** y elegir un turno: ahora el importe **se
   prellena solo** con el precio congelado de ese turno.

> **Para señalar, la matriz completa:** un usuario recepcionista puede registrar cargos y
> pagos, pero **siempre atados a un turno** de un calendario sobre el que tiene permiso. No
> puede registrar ajustes, ni ningún movimiento suelto. Un usuario profesional ve los
> cuatro tipos, pero solo para sus propios clientes. Un usuario administrador ve los cuatro
> para cualquiera.
>
> Esa matriz no se puede expresar con una lista de roles por tabla, que es la forma
> declarativa que usa el resto del sistema. Por eso la cuenta corriente tiene autorización
> escrita a mano, y su descriptor **omite a propósito** la política declarativa en lugar de
> declarar una que mienta sobre lo que el servidor realmente permite.
>
> **Por qué el pago no se prellena y el cargo sí:** un cargo vale lo que valió el turno, así
> que heredar el precio congelado es correcto. Un pago puede ser parcial, y prellenarlo con
> el total registraría en silencio una plata que no entró. Se puede comprobar en el saldo de
> Bart: tiene un pago parcial sembrado, y por eso queda debiendo.
>
> **Y un detalle que no se ve:** esa verificación de permiso corre **dentro de la misma
> transacción** que la inserción. No hay una ventana entre comprobar el permiso y escribir,
> así que revocar un permiso a mitad de la operación no puede colar un movimiento.

### 4.6 La interfaz oculta, el servidor decide (F3.4, F3.13, F4.6)

Este paso cierra la demostración de seguridad.

1. Escribir a mano en la barra del navegador `http://localhost:8080/staff/audit`. Aparece
   el aviso **"Acción no permitida."** y no navega.
2. Para mostrar que la defensa real está en el servidor y no en el navegador, abrir las
   herramientas de desarrollo (F12), pestaña **Console**, y ejecutar:

   ```js
   await fetch('/api/audit', { credentials: 'include' }).then(r => r.status)
   ```

   Responde **403**.

3. Probar ahora con una tabla que no existe:

   ```js
   await fetch('/api/tabla_inventada', { credentials: 'include' }).then(r => r.status)
   ```

   Responde **404**.

4. Y con una tabla que existe pero está fuera del CRUD genérico:

   ```js
   await fetch('/api/appointment_series', { credentials: 'include' }).then(r => r.status)
   ```

   Responde **404** también, no 403.

> **Para señalar:** la diferencia entre esos códigos es deliberada. Un **403** dice "esto
> existe pero no es para vos". Un **404** dice "acá no hay nada". El sistema usa 404 para
> todo lo que no debería ni saberse que existe: tablas protegidas, tablas desconocidas y,
> sobre todo, **filas de otro negocio**. Si un administrador de un consultorio pide por
> identificador el turno de otro consultorio, recibe un 404, porque un 403 confirmaría que
> ese turno existe.

5. Como contraste, repetir el ejercicio con un cliente. Cerrar sesión, ingresar como
   `demo_client` y ejecutar en la consola:

   ```js
   await fetch('/api/clients/9/balance', { credentials: 'include' }).then(r => r.json())
   ```

   Responde `{"success":false,"error":{"code":"forbidden","message":"Clients may only read
   their own ledger"}}`. Y:

   ```js
   await fetch('/api/appointments', { credentials: 'include' })
     .then(r => r.json())
     .then(j => ({ cuantos: j.data.length, tieneNotaDeStaff: 'staff_note' in j.data[0] }))
   ```

   Devuelve solo **sus** turnos, y `tieneNotaDeStaff: false`: la nota interna del staff se
   quita de toda respuesta dirigida a un cliente.

### 4.7 Cerrar sesión

**Salir**.

---

## Anexo A. Cambio de contraseña forzado (`demo_reset`)

*(2 minutos. Se puede mover al principio de todo si se prefiere abrir con esto.)*

1. Ingresar con usuario `demo_reset` y contraseña `demo-pass-123`.
2. El sistema no lleva al panel de inicio: lleva a una pantalla bloqueante con el banner
   amarillo *"Por seguridad, definir una nueva contraseña antes de continuar."*
3. Intentar navegar a otra dirección escribiéndola a mano, por ejemplo
   `http://localhost:8080/staff/calendar`. Vuelve a la pantalla de cambio de contraseña.
4. Campo **Contraseña actual**: `demo-pass-123`. Campo **Nueva contraseña**:
   `demo-pass-123`.
5. Aparece *"La nueva contraseña debe ser distinta de la actual."* y el botón queda
   deshabilitado.
6. Cambiar la nueva por `nueva-pass-456` y clickear **Cambiar contraseña**. Recién ahí
   entra a la aplicación.

> **Para señalar:** el bloqueo no es cosmético. Se puede comprobar desde la consola,
> apenas iniciada la sesión y antes de cambiar la contraseña:
>
> ```js
> await fetch('/api/appointments', { credentials: 'include' }).then(r => r.status)
> ```
>
> Responde **403**. El guard del servidor rechaza **todo** endpoint protegido mientras la
> marca esté puesta, con la única excepción del cambio de contraseña y el cierre de sesión.
> Y al cambiarla se eliminan todas las demás sesiones del usuario, dejando viva solo la
> actual.

---

## Anexo B. Demostración contra la base de datos

*(5 minutos. Es el anexo más relevante para una materia de bases de datos, y el que mejor
muestra que las reglas no dependen de que la aplicación se porte bien.)*

La demostración consiste en atacar la base **por afuera de la aplicación**, con dos roles
distintos, para mostrar que hay **dos capas independientes** de protección.

### B.1 Con el rol de la aplicación: los permisos ya lo frenan

```bash
docker compose exec -e PGPASSWORD='CambiaEsta!' database \
  psql -U aida26_user -d professional_agenda
```

> El servicio se llama `database` (no `db`), y el rol de la aplicación es `aida26_user`.
> Las contraseñas son las de `docker-compose.yml`; si hay un `.env` propio, usar las de ahí.

```sql
SELECT id, entry_type, amount_ars FROM ledger_entries LIMIT 3;
```

Funciona: el rol puede **leer**.

```sql
UPDATE ledger_entries SET amount_ars = 1 WHERE id = 1;
DELETE FROM ledger_entries WHERE id = 1;
DELETE FROM audit_events WHERE id = 1;
```

Las tres fallan con **`ERROR: permission denied for table ...`**.

> **Para señalar:** el rol con el que corre la aplicación **ni siquiera tiene el permiso**
> de modificar o borrar en esas tablas. No es que la aplicación se abstenga de hacerlo: no
> puede. Si mañana alguien escribiera por error un `UPDATE` sobre la cuenta corriente en el
> código, la base lo rechazaría.

Salir con `\q`.

### B.2 Con el rol dueño: ahora hablan los disparadores

```bash
docker compose exec -e PGPASSWORD='CambiaEsta_Owner!' database \
  psql -U aida26_owner -d professional_agenda
```

Este rol es dueño del esquema y **tiene todos los permisos**. Aun así:

```sql
UPDATE ledger_entries SET amount_ars = 1 WHERE id = 1;
```
```
ERROR:  ledger_entries are immutable; create a new adjustment row to correct
CONTEXT:  PL/pgSQL function forbid_ledger_mutation() line 3 at RAISE
```

```sql
DELETE FROM audit_events WHERE id = 1;
```
```
ERROR:  audit_events are append-only
CONTEXT:  PL/pgSQL function forbid_audit_mutation() line 3 at RAISE
```

```sql
UPDATE appointments SET state = 'scheduled'
WHERE id = (SELECT min(id) FROM appointments WHERE state = 'completed');
```
```
ERROR:  appointment state completed is terminal; cannot transition to scheduled
CONTEXT:  PL/pgSQL function enforce_appointment_state_transition() line 8 at RAISE
```

> **Para señalar:** este es el punto. El rol dueño tiene permiso para hacer las tres cosas y
> **igual no puede**, porque hay disparadores que las rechazan. Los permisos y los
> disparadores son **dos capas independientes**: la primera se ocupa de que la aplicación
> no pueda equivocarse, la segunda de que ni siquiera un administrador de base pueda
> reescribir la historia por accidente. La máquina de estados de los turnos vive a la vez
> en el código (donde da un mensaje útil) y en la base (donde es infranqueable).

### B.3 Los permisos, tabla por tabla

```sql
SELECT table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS permisos
FROM information_schema.role_table_grants
WHERE grantee = 'aida26_user'
  AND table_name IN ('ledger_entries','audit_events','appointments',
                     'users','calendar_grants','appointment_series')
GROUP BY table_name ORDER BY table_name;
```

```
     table_name     |        permisos
--------------------+------------------------
 appointment_series | INSERT, SELECT, UPDATE
 appointments       | INSERT, SELECT, UPDATE
 audit_events       | INSERT, SELECT
 calendar_grants    | DELETE, INSERT, SELECT
 ledger_entries     | INSERT, SELECT
 users              | INSERT, SELECT, UPDATE
```

> **Para leer la tabla en voz alta:** `ledger_entries` y `audit_events` solo tienen
> `INSERT, SELECT` porque son de solo agregado. `appointments` y `users` **no tienen
> DELETE**, porque los turnos se cancelan y los usuarios se desactivan, nunca se borran.
> `calendar_grants` es la única que **sí** tiene DELETE y **no** tiene UPDATE: un permiso de
> calendario no se edita, se otorga o se revoca, y revocarlo es borrar la fila. Cada
> permiso concedido responde a una decisión de diseño, no a un valor por defecto.

### B.4 Las migraciones son inmutables

```sql
SELECT filename, left(checksum, 12) AS checksum
FROM schema_migrations ORDER BY filename;
```

Devuelve las **15 migraciones** aplicadas, cada una con su suma de comprobación.

> **Para señalar:** si alguien edita un archivo de migración ya aplicado, la próxima corrida
> **falla con un mensaje explícito** en lugar de aplicar el cambio en silencio. Para
> deshacer algo se escribe una migración nueva. Eso hace que el historial del esquema sea
> tan auditable como el historial de la cuenta corriente. En la lista se puede ver, por
> ejemplo, `20260711_090000_schedule_blocks_services.sql`, que es la que reemplazó el
> horario semanal guardado como JSON por filas normalizadas, migrando los datos y dando de
> baja la tabla anterior en la misma transacción.

Salir con `\q`.

---

## Anexo C. Pruebas automatizadas

*(3 minutos, opcional.)*

Desde la raíz del repositorio:

```bash
npm test                # unitarias de backend y frontend
npm run test:db         # integración contra PostgreSQL real
npm run test:e2e        # extremo a extremo con Playwright
```

Puntos que vale la pena mencionar mientras corren:

- Hay una prueba de **concurrencia con dos transacciones** que demuestra que dos reservas
  simultáneas sobre el mismo horario no pueden ganar las dos.
- Hay una prueba de **esquema fresco** que aplica las quince migraciones y la semilla sobre
  una base vacía.
- Hay una prueba de **deriva**: cuando una constante existe a la vez en TypeScript y en una
  migración ya inmutable (los estados de turno, los tipos de movimiento, el plazo por
  defecto), un test verifica que sigan coincidiendo. Así la divergencia rompe una prueba en
  vez de romper la producción.
- Las pruebas **importan las etiquetas** del dominio en lugar de repetir textos, y usan
  fechas relativas al día de ejecución, así que el conjunto no envejece.

El mismo recorrido corre en GitHub Actions en cada envío, con PostgreSQL 18 y la zona
horaria de Buenos Aires configurada en el trabajo.

---

## Anexo D. Si algo sale mal durante la demostración

| Síntoma | Solución |
|---|---|
| La aplicación no carga en :8080 | `docker compose ps`. Si el frontend figura con `8080/tcp` en vez de `0.0.0.0:8080->8080/tcp`, el contenedor quedó creado con una configuración vieja: correr `docker compose up -d --build`. |
| El backend responde 503 en `/health` | La base todavía arranca. Esperar y reintentar. |
| Los datos quedaron inconsistentes | `docker compose exec backend npm run seed:demo:reset` y volver a empezar el bloque. |
| Un usuario quedó con contraseña cambiada | El reinicio de la semilla la devuelve a `demo-pass-123`. |
| Se perdió el permiso del usuario recepcionista | Ingresar como `demo_admin`, ir a **Negocio → Administración de Staff**, elegir Marge y volver a darle acceso, o reiniciar la semilla. |
| Se cerró un formulario sin querer | Probablemente se apretó Escape para cerrar un calendario emergente. Escape cierra el diálogo entero: cerrar los calendarios clickeando afuera. |
| Todo falló | `docker compose down -v && docker compose up -d --build`, después `docker compose exec backend npm run seed:demo` |
