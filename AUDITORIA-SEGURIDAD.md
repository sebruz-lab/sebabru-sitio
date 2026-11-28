# Auditoría de seguridad — 28 de noviembre de 2026

La anterior fue el **13/11/2026**. En quince días el sitio sumó casi todo lo que
hoy toca plata o datos personales: el padrón de las formaciones (mail, teléfono,
datos de nacimiento y la plata de 82+ personas), Finanzas, los títulos de egreso
con DNI, el agendador con delegación de dominio sobre el Calendar, y la
importación del archivo 2026. Nada de eso existía cuando se auditó.

**La próxima toca alrededor del 28 de febrero de 2027** (trimestral), y antes si
entra un flujo nuevo que reciba plata o datos personales. Más abajo está la lista
de lo que quedó pendiente, que es por dónde empezar.

---

## Qué se revisó, y con qué

| Frente | Alcance | Cómo |
|---|---|---|
| Cloud Functions | `functions/index.js` (11.768 líneas, 38 endpoints), `brevo.js`, `mails.js`, `agenda-motor.js` | Inventario endpoint por endpoint: autenticación, rate limiting, CORS, secretos, firmas, precios, escapado, logging |
| Reglas de Firestore | `firestore.rules` (420 líneas, 48 colecciones) y `storage.rules` | Rúbrica de red team del skill `firebase-security-rules-auditor`, **y 63 tests ejecutados contra el emulador** |
| Frontend | los 2 paneles de admin, 24 formularios, todo lo que se sirve de `public/` | Lectura dirigida: XSS almacenado, protección real vs cosmética, claves expuestas, archivos que no deberían ser públicos |
| Cabeceras y Hosting | `firebase.json` (288 líneas), y las cabeceras **en producción** | `curl` contra sebabru.com |
| CI/CD | las 5 workflows de GitHub Actions y sus scripts | Permisos, pinning de actions, manejo de tokens |
| Calculadora | `C:\dev\tucarta` (repo público) | Privacidad de los datos de nacimiento, service worker, terceros, historial de git |
| Herramientas locales | todo `C:\dev` | Secretos en reposo, repos y remotes, datos personales en disco, qué se publica |

### Con qué skill

**`firebase-security-rules-auditor`** fue la única que aportó, y aportó de
verdad: su checklist de red team es lo que destapó el hallazgo principal
(`email_verified`). No es una herramienta, es una rúbrica.

`security-review` y `code-review` auditan el **diff** de una rama, así que no
sirven para una auditoría de base — sí para revisar los arreglos después, que es
donde se usaron.

### Lo que esta auditoría NO cubre

- **La consola de Firebase y de Google Cloud.** Varias cosas sólo se ven ahí y
  quedaron como verificación pedida (ver *Pendiente*).
- **Las transcripciones de `whisper-clases`.** Si en una clase grabada alguien
  dijo su nombre o su carta, está en texto plano en `C:\dev\whisper-clases\salida`.
- **Seguridad de la máquina.** Todo está en claro en disco, sin cifrado de
  volumen.
- **Pentesting activo.** No se intentó explotar nada en producción.

---

## Lo que está bien, y conviene no romper

Vale listarlo porque es la mitad del resultado, y porque la próxima auditoría no
tiene que volver a mirarlo desde cero:

- **No hay XSS almacenado.** Era el hallazgo repetido de agosto y de noviembre.
  Esta vez el escapado está completo y es consistente (186 usos de `escapeHtml`
  en el backend), incluido el camino más hostil del panel: el volcado crudo de lo
  que escribió un desconocido en la pestaña Pendientes.
- **Ninguna colección con DNI, mail, teléfono, datos de nacimiento o montos es
  legible por "cualquier autenticado".** Las 30 sensibles están cerradas de los
  dos lados y pasan por callables que verifican la sesión del lado del servidor y
  dejan auditoría.
- **El panel de consultas usa un custom claim verificado** y pinta con
  `textContent`, no con `innerHTML`.
- **Los precios salen 100 % del servidor**, y la idempotencia de pagos es
  atómica (`doc.create()`).
- **Los cinco HMAC del sistema se comparan con `timingSafeEqual`.** Cero
  comparaciones con `===`.
- **Ningún endpoint devuelve `error.message` al cliente**, y está comentado como
  decisión.
- **No hay rewrites en `firebase.json`**, así que ninguna function queda expuesta
  a través de Hosting.
- **No hay bucket ni SDK de Cloud Storage** en ninguna parte del proyecto.
- **El CI está prolijo**: actions clavadas al SHA, `permissions: contents: read`,
  `persist-credentials: false`, y el token de la GitHub App vive una hora.
- **La clave web de Firebase está restringida por referrer** (comprobado en vivo:
  un pedido sin referer da 403).
- **En `C:\dev` no hay un solo secreto commiteado**, ni en el árbol de trabajo ni
  en el historial, y las credenciales viven fuera de los repos y fuera de Drive.
- **La calculadora calcula local.** Los datos de nacimiento no salen del
  dispositivo: WASM en el navegador, `localStorage`, y GA4 sin fecha, hora ni
  lugar.

---

## Hallazgos

30 en total. Estado al cierre de la auditoría.

### Arreglados

| # | Sev. | Hallazgo | Arreglo |
|---|---|---|---|
| 1 | ALTO | **El passcode de Zoom estaba en un JS público.** El ID de la sala de las consultas y su clave viajaban escritos en `public/consultas/mi-agenda/mi-agenda.js` y en `agenda/agenda.js`, dos archivos que Hosting sirve a cualquiera sin sesión: se bajaban con un `curl`. Era el único secreto de verdad expuesto en todo el sitio | Ahora el Zoom lo manda el servidor en la respuesta de `miAgenda` y de `reservarTurno`, que piden token del enlace o ID token, y sólo cuando ese turno es por Zoom. **Falta cambiar el passcode**, porque el viejo estuvo público |
| 2 | ALTO | **Nadie chequeaba `email_verified`, en ningún lado.** El sitio crea cuentas con `createUserWithEmailAndPassword` en 5 lugares y **nunca** mandaba el mail de verificación, así que cualquiera podía registrarse con una dirección que no es suya; y toda la autoridad del sistema sale de `request.auth.token.email`. Dos consecuencias: (a) `activarInvitacion` y `canjearRegalo` identifican a quien canjea por ese mail, así que registrarse con la dirección de una invitación **antes que su dueña** se queda con el curso que pagó otra persona; (b) si alguna de las tres direcciones de admin no hubiera tenido cuenta, registrarla daba admin de todo | `esAdmin()` en las reglas y `exigirAdmin` en el servidor piden `email_verified`. Los cuatro canjes también. `fijarClaimsAdmin` —el que **otorga** el claim `admin:true`— ahora lo mira: su comentario decía "si el email verificado está en ADMINS_TUCARTA" desde siempre, pero el código nunca lo chequeaba. Y el nuevo `public/escuela/verificar.js` manda el mail de verificación en los 5 registros. Quien entra con Google no nota nada: Google ya devuelve `email_verified: true` |
| 3 | ALTO | **El rate limiting era evadible**, y de él cuelgan los topes de ~25 endpoints. La clave salía de `x-forwarded-for[0]`, y en Cloud Run el balanceador de Google no reemplaza ese header: le **agrega** la IP real al final. Mandando un valor distinto en cada pedido, cada uno estrenaba contador | `ipDelPedido()` toma el penúltimo elemento, que es la IP que abrió la conexión, y prefiere `req.ip`. Se unificaron los otros dos lugares que leían la IP a mano, incluido el de la constancia de consentimiento de `suscripciones` — donde una IP falsificable hacía que la constancia no probara nada |
| 4 | ALTO | **Tokens de acceso en claro en Cloud Logging**: el token de invitación, el código de regalo, el token de PayPal y el token de un enlace recién creado. Quien lea los logs canjea accesos, y un log vive por su retención, no por la del token | `huella()`: en el log va un sha256 de 10 caracteres, que alcanza para cruzar dos líneas y no sirve para entrar |
| 5 | ALTO | **La firma de Mercado Pago fallaba abierta.** Sin `MP_WEBHOOK_SECRET` cargado, `verificarFirmaMP` devolvía `true` y el webhook aceptaba cualquier pedido. El aviso era un `logger.error`, y en este proyecto un `logger.error` no le avisa a nadie: el modo degradado podía durar meses, que es exactamente lo que pasó con el webhook hasta el 13/11/2026 | Falla cerrada: contesta 503 (un 5xx hace que MP reintente, así que nada se pierde si el secreto se carga en las horas siguientes) y **custodia** con `gravedad: 'grave'` y `avisarSiempre`, que es lo que hace que se entere alguien |
| 6 | MEDIO | **El webhook de MP no tenía anti-replay**, y **logueaba el body antes de verificar la firma**, así que cualquiera podía escribir en Cloud Logging con un POST sin firmar | Ventana de 5 minutos sobre el `ts` (que ya venía firmado y nadie comparaba con el reloj), y el log después de la firma |
| 7 | MEDIO | **El service worker de la calculadora cacheaba todo `firestore.googleapis.com`** (`NetworkFirst`, 30 días), y por ahí pasan las cartas guardadas. O sea que los datos de nacimiento que la app se cuida de no mandar al servidor quedaban un mes en el Cache Storage del navegador, afuera del `localStorage` que limpia el botón "borrar" y sin vaciarse al cerrar sesión. En una máquina compartida y con la red lenta, el `NetworkFirst` podía servirle a la segunda persona la respuesta de la primera | La regla quedó acotada a `tucarta_config`, que es pública y la misma para todo el mundo. Y como un caché con nombre propio sobrevive a que su regla cambie, se agregó `ui/public/limpiar-cache-viejo.js`, que lo borra una vez al activarse el service worker nuevo. **Pendiente de release** (ver abajo) |
| 8 | MEDIO | **La lista de admins estaba escrita 20 veces en 3 archivos** (18 en las reglas, 1 en el HTML del panel, 1 en functions). Sacar a alguien era acertar 20 veces | Las 18 de las reglas quedaron en un `esAdmin()`. Las otras dos siguen aparte a propósito: la de functions es la fuente, y la del HTML es cosmética (decide si se ve el panel, no si se puede hacer algo) |
| 9 | MEDIO | **El `create` de `usuarios/{email}` no tenía `hasOnly`** mientras el `update` sí: al registrarse se podía escribir cualquier campo con cualquier valor y sin tope de tamaño. No había escalada (`cursos == []` siempre estuvo), era un documento de forma libre y consumo gratis | Lista blanca de los 5 campos que escriben los tres lugares que dan de alta, más topes de tamaño y de tipo. De paso se arregló un bug que estaba ahí antes: una cuenta de Google **sin nombre para mostrar** manda `nombre: null` y no podía crear su documento |
| 10 | MEDIO | **`cursoNombre` lo mandaba el cliente** y llegaba al título del item en el checkout de MP, a la descripción de PayPal, a `ordenes_paypal` y al registro de compra del panel de Finanzas. Acotado a 200 caracteres y sin saltos de línea, así que no era inyección — pero quien compraba elegía el texto que Seba después lee en el panel | `CURSO_NOMBRES` en el servidor: el cliente manda el `cursoId`, que es un enum validado contra `PRECIOS`, y el nombre sale de ahí. Igual que el precio, que ya era así |
| 11 | MEDIO | **`registrarTransferencia`: escritura pública sin captcha ni honeypot**, desde tres páginas | Tope bajado a 5 (y ahora el tope sirve, por el #3), más un campo trampa del lado del servidor. No se le puede poner captcha: no hay formulario, es un botón que avisa "ya transferí". Lo que acota el daño es que la fila nace "a confirmar" y que Finanzas cuenta lo no confirmado aparte: inflar esto ensucia el panel, no inventa un ingreso |
| 12 | MEDIO | **`obtenerMuestra` era el único endpoint público sin rate limit**, y cada llamada es una lectura de Firestore | Tope de 60 cada 10 minutos |
| 13 | MEDIO | **`**/*.js` con 30 días de caché y sin hash en el nombre.** Una corrección del lado del cliente tardaba hasta un mes en llegar a quien ya lo había cacheado — incluido el arreglo del passcode de Zoom de este mismo informe | Los JS y CSS escritos a mano bajan a 1 h en el navegador (con 30 días en el CDN y `stale-while-revalidate`), y `/cartas/assets/**`, que **sí** lleva hash, se queda en 30 días `immutable`. Y se subió el `?v=` de los 4 archivos que cambiaron, en 31 páginas |
| 14 | MEDIO | **La CSP no bloqueaba nada y tampoco reportaba.** La bloqueante traía sólo `frame-ancestors`, o sea que duplicaba el `X-Frame-Options`; la completa estaba en `Report-Only` **sin `report-uri` ni `report-to`**, así que las violaciones morían en la consola de quien estuviera mirando | Pasaron a bloqueante las cuatro directivas que no pueden romper contenido y sí frenan ataques reales: `object-src 'none'`, `base-uri 'self'`, `form-action` y `frame-ancestors`. Verificado antes: no hay un solo `<form action>`, `<object>`, `<embed>` ni `<base>` en el sitio. El resto sigue en Report-Only — ver *Pendiente*, porque ahí hay un trabajo más grande |
| 15 | BAJO | **La bitácora escribía en la planilla equivocada.** `SHEETS_SPREADSHEET_BITACORA` **nunca se cargó**, así que caía al respaldo `SHEETS_SPREADSHEET_ID`: todas las custodias desde el 25/11 fueron a la planilla **general**, con el payload completo (DNI, direcciones, datos de nacimiento) y para siempre, porque una planilla no vence. Es justo lo contrario de lo que el comentario del código dice que hace | Ahora lo grita en cada escritura en vez de quedarse callado. **Cargar la variable es tarea de Seba** (ver *Pendiente*) |
| 16 | BAJO | **`verificarTitulo`: HMAC truncado a 32 bits** sobre un número correlativo y adivinable. Con el tope evadible del #3, eso era enumerable, y lo que se filtraba era nombre, curso y año de cada egresadx | Los nuevos salen de 64 bits. Los de 8 **siguen valiendo**, porque están impresos en el QR de los PDF ya entregados y un diploma cuyo código deja de verificar es un diploma roto |
| 17 | BAJO | **No se reconciliaba el importe cobrado.** Ni en PayPal contra `ordenes_paypal.precioUsd`, ni en MP contra nada. No hay un camino conocido para pagar menos, pero si ese supuesto dejara de valer no habría forma de enterarse | Los dos comparan y, si no coincide, **custodian con aviso inmediato y entregan el acceso igual**: cortarlo sería dejar sin curso a alguien que pagó |
| 18 | BAJO | **Tres registros devolvían el error crudo de Firebase** (`'No se pudo crear la cuenta. ' + err.message`). El texto `auth/email-already-in-use` le confirma a cualquiera que una dirección ajena ya tiene cuenta con sólo probar a registrarse. `escuela.js` ya lo había arreglado y lo tenía comentado; los otros tres no | `mensajeDeErrorDeRegistro()` en `verificar.js`, con el mismo texto para "ya existe" y para "no se pudo" |
| 19 | BAJO | **`fijarClaimsAdmin` no tenía rate limit**, y es la función que otorga el claim `admin:true` | Tope de 30 |
| 20 | BAJO | **`public/pglite-debug.log` se publicaba.** El `ignore` de `firebase.json` sólo excluye `**/.*`, o sea archivos que empiezan con punto | `**/*.log` en el `ignore`. Y `img/*.epub`, por el #21 |
| 21 | BAJO | **Un `.epub` huérfano servido en `public/img/`.** 23 KB, una versión vieja y parcial del libro del regalo, que **no enlaza nadie**: ni el sitio ni ninguna de las 7 plantillas de mail. (Lo que no es un hallazgo, y conviene no confundirlo: el libro del regalo se lee en `/tu-identidad-en-el-cielo/#ebook`, y esa página es pública a propósito. La puerta del regalo es que el enlace vive sólo en el mail de Brevo) | Deja de publicarse. El archivo no se borró |
| 22 | BAJO | **Una IP cruda en el log de `mpWebhook`**, que además es texto elegido por quien pega | Hasheada, con el mismo criterio que el resto |

### Documentados, sin tocar

| # | Sev. | Hallazgo | Por qué no se tocó |
|---|---|---|---|
| 23 | ALTO | **`C:\dev\scratch` acumula datos personales sin caducidad**: DNI y nombre completo de 5 alumnas en base64 decodificable (`camelia.txt`, `flor.txt`, `f1.txt`, `f2.txt`), los 5 PDF de títulos con el nombre en el propio archivo, y `encuentros-habituales.json` con los nombres de las consultantes habituales y su frecuencia | Seba pidió no borrar nada todavía. **Es borrable sin perder nada**: los títulos se regeneran con `titulos.js` |
| 24 | ALTO | **Datos de terceros en claro en disco**: 25 Facturas C con nombre, DNI/CUIT e importe en `C:\dev\afip\facturas\`, y las **exportaciones completas de las 5 listas de Brevo** en CSV en `herramientas-sebabru\{entrada,salida}\` | Ídem. Los CSV se regeneran con `brevo-exportar.js` |
| 25 | MEDIO | **`C:\dev\publicar-tucarta\` es un staging completo de Hosting** con su propio `firebase.json` y su caché de deploy, **congelado el 31/10/2026**. Un `firebase deploy` desde ahí vuelve el sitio un mes atrás. No tiene `.firebaserc`, así que necesitaría un `--project` explícito, pero el caché muestra que ya se deployó desde ahí | Ídem. Hoy el deploy va por push a `main`, así que la carpeta no hace falta |
| 26 | MEDIO | **Los 32 secretos de `functions/.env` viven dentro de Google Drive**, sincronizados a la nube: el token de Mercado Pago, la contraseña de aplicación de Gmail, la llave privada de Sheets, la API key de Brevo. Están fuera de git, pero lo único que los protege es la cuenta de Google | El arreglo bueno es **Secret Manager**, y toca muchas funciones. Es el trabajo siguiente, no un parche de auditoría |
| 27 | MEDIO | **Sin topes de tamaño ni de cantidad** en `tucarta_usuarios/{uid}/cartas` (creación ilimitada), `cursos.videos`, `codigos_descuento`, `invitaciones`, `enlaces` y `tucarta_textos` | Todas esas son escritura de admin, salvo las cartas. Poner un tope a lo que escriben las herramientas de contenido para defenderse de una sesión de admin comprometida rompe las herramientas y protege poco. El de las cartas **no se puede hacer en reglas**: no saben contar documentos |
| 28 | BAJO | **`invitaciones/{token}` y `codigos_descuento/{codigo}` se leen sin sesión** (`get: if true`). El `list` está bien cerrado, así que no se enumeran | Los dos lo necesitan: la página de canje lee la invitación antes de que la persona esté logueada, y el checkout valida el cupón. El token **es** el secreto |
| 29 | BAJO | **Mails completos en ~18 líneas de log.** El criterio bueno ya existe y está aplicado en `suscribir` y en `baja` (sólo el dominio); falta en el resto | Es trazabilidad legítima de compras y accesos, y bajarla a dominio dificulta el soporte. Queda como criterio para lo nuevo |
| 30 | BAJO | **`firma.png` + `hoja.html` públicos** en `public/escuela/titulo/`: la firma manuscrita se descarga sin ninguna barrera y la plantilla del diploma también | Falsificar el **aspecto** de un diploma siempre va a ser posible: es un PDF. Lo que no se puede falsificar es el número, que `/titulo/` verifica contra Firestore, y eso está bien hecho. Esconder la firma daría una falsa sensación de control |

### Verificado como falso, para no repetirlo

- **"PayPal no verifica la firma del webhook."** No hay webhook de PayPal: lo que
  hay es el `return_url`, y la autoridad es la respuesta de la API de PayPal al
  capturar, más que la orden exista en `ordenes_paypal`. Lo que sí falta es una
  notificación asíncrona, para el caso de que la persona cierre la pestaña — pero
  eso ya está cubierto por la custodia `pago_cobrado_sin_orden`, que avisa.
- **"El ebook se descarga sin suscribirse."** No. El regalo manda a una página
  pública a propósito; lo que había era un archivo huérfano (#21).
- **"Las tres direcciones de admin podrían no tener cuenta."** Las tres tienen
  documento en `usuarios` con cursos y cohorte, así que las tres tienen cuenta.
  La escalada del #2 no era explotable el día de la auditoría — pero dependía de
  una pantalla de la consola, no de una condición escrita, y ahora está escrita.
- **"Alguien ya pudo haberse robado una invitación."** De las 23 invitaciones,
  **ninguna** fue canjeada por una dirección distinta a la de su destinatario.

---

## Lo que se midió

Con la llave de `C:\dev\firebase-admin.json`, de sólo lectura. Dato útil de
paso: **esa cuenta de servicio no tiene permisos de Auth**, sólo Firestore, lo
cual es correcto y es también el motivo de que parte del #2 haya que confirmarlo
en la consola.

- 119 documentos en `usuarios`, 113 con al menos un curso.
- Las 3 direcciones de admin tienen documento.
- 23 invitaciones: 17 sin canjear, **0 canjeadas por otra dirección**.
- De las 17 sin canjear, **12 no tienen destinatario anotado**: para esas, el
  token es el único control (quien lo tiene entra, sea quien sea). No es un bug
  —`activarInvitacion` saltea la comparación cuando no hay destinatario— pero
  conviene saberlo: son 12 accesos al portador.
- 1 regalo, sin canjear.

## Cómo se probaron las reglas

Hasta esta auditoría las reglas sólo se podían **leer**: no había `java`
instalado, así que no había emulador. Se instaló Temurin 21 y se armaron **63
tests** en `C:\dev\scratch\reglas-test`, que cubren quién administra, que nadie
se regale un curso, la forma del documento de usuario, los videos de un curso,
las 35 colecciones cerradas, lo que se lee sin sesión, y las cartas de la
calculadora.

```
cp "G:/Mi unidad/Seba Bru/SITIO/firestore.rules" reglas.rules
firebase emulators:exec --only firestore --project demo-sebabru "node --test"
```

**Y se comprobó que los tests tienen dientes**, que es lo que suele faltar:
corridos contra las reglas de antes del arreglo, **fallan 5** — exactamente las
que los arreglos cierran. Un test que pasaría igual con el bug adentro no prueba
nada.

Los tests se prueban contra la base default del emulador, no contra la base
`cursos`. El archivo de reglas es el mismo, así que lo que prueban es la lógica,
no el ruteo de la base.

---

## Pendiente

### De Seba, en la consola

1. **Cambiar el passcode de Zoom** de la sala de consultas. El viejo estuvo
   público en un archivo que servía Hosting. El nuevo va en
   `AGENDA_ZOOM`/`AGENDA_ZOOM_PASS` de `functions/index.js` — ahora el único
   lugar donde vive.
2. **`Authentication → Settings → User account linking`** tiene que decir
   **"Link accounts that use the same email"**. Es lo que impide registrar una
   dirección de admin que ya tiene cuenta. Si dijera "Create multiple accounts
   for each identity provider", el #2 vuelve a estar abierto.
3. **`Authentication → Settings → User actions`: Email enumeration protection**
   activada. Sin eso se puede averiguar desde afuera qué direcciones tienen
   cuenta, que es el primer paso del robo de invitaciones.
4. **`Authentication → Sign-in method`**: que estén sólo Email/Password y
   Google, sin proveedores olvidados. Y en `Authorized domains`, borrar los
   dominios que ya no existan.
5. **Las API keys**, en `console.cloud.google.com/apis/credentials`: la clave web
   ya está restringida por referrer, falta ponerle **API restrictions** (sólo
   Identity Toolkit, Firestore y Token Service). Y restringir la key de PageSpeed
   de `C:\dev\pagespeed-api-key.txt`, que hoy puede gastar cuota cualquiera.
6. **Confirmar si existe una base `(default)`** además de `cursos`, en
   `console.cloud.google.com/firestore/databases`. `firebase.json` declara sólo
   `cursos`, así que a una `(default)` este repo **nunca le publicó reglas**. Si
   está vacía, borrarla o agregarle un deny-all.
7. **Los dos TTL de Firestore**, que siguen pendientes desde la auditoría
   anterior. **El comando que venía anotado estaba mal: le falta
   `--database=cursos`**, sin lo cual apunta a otra base:
   ```
   gcloud firestore fields ttls update expira --collection-group=datos_sin_procesar --enable-ttl --database=cursos
   gcloud firestore fields ttls update expira --collection-group=padron_pendientes --enable-ttl --database=cursos
   ```
   O por consola: `console.cloud.google.com/firestore/databases` → base `cursos`
   → pestaña **Time-to-live (TTL)** → Create policy, campo `expira`, para las dos
   colecciones. (`gcloud` no se pudo instalar en esta sesión: winget tiene el
   hash viejo del instalador, que Google rota. Se instala con el instalador
   oficial.)
8. **Cargar `SHEETS_SPREADSHEET_BITACORA`** en `functions/.env`, apuntando a una
   planilla propia con menos gente adentro (hallazgo #15). Mientras no esté, cada
   custodia lo avisa en los logs.

### De la máquina y los secretos

9. **Los secretos no van al backup.** `brevo.json`, `firebase-admin.json` y la
   llave de AFIP tienen que vivir en un gestor de contraseñas y quedar
   **excluidos** del backup de `D:`. Un backup cifrado protege del robo del
   disco; no protege de que la credencial esté en seis lugares.
10. **Un contenedor cifrado** para lo que sí convenga tener a mano. Windows 11
    Home no tiene BitLocker para discos de datos: sirve VeraCrypt, o un `.7z` con
    AES-256 y los nombres de archivo cifrados. Ahí adentro va `C:\dev\afip`
    completo.
11. **Rotar las tres credenciales**, porque estuvieron en claro en una carpeta
    que se respalda sola: la API key de Brevo desde su panel, y la llave
    `herramientas-claude` desde `console.cloud.google.com/iam-admin/serviceaccounts`.
12. **Limpiar `C:\dev\scratch` y las exportaciones de Brevo** (hallazgos #23 y
    #24), y decidir qué hacer con `publicar-tucarta` (#25).

### De código, para la próxima

13. **`functions/.env` a Secret Manager** (#26). Es el pendiente más grande y el
    que más baja el riesgo estructural.
14. **La CSP sin `'unsafe-inline'`** (#14). Hoy la Report-Only lo trae, así que
    pasarla entera a bloqueante no daría protección contra XSS. Hacerlo de verdad
    pide nonces en los `<script>` inline de casi todas las páginas, y los paneles
    son módulos inline de miles de líneas. Es un proyecto, no un parche.
15. **Un endpoint que reciba los reportes de CSP**, para que la Report-Only sirva
    de algo. Hoy no reporta a ningún lado.
16. **Correr los tests de reglas antes de cada deploy de `firestore.rules`.**
    Están en `C:\dev\scratch\reglas-test`, que es scratch: **conviene moverlos a
    un lugar durable** o se van a perder.

---

## Cómo se deployó

- Reglas: `firebase deploy --only firestore:cursos` — **nunca**
  `--only firestore:rules`, que termina con "Deploy complete!" sin publicar nada.
  La salida tiene que traer las tres líneas: "compiled successfully",
  "uploading rules" y "released rules".
- Functions: `firebase deploy --only functions` con
  `FUNCTIONS_DISCOVERY_TIMEOUT=120`.
- Frontend: por push a `main`. Un deploy manual se revierte en el próximo push y
  además publica el sitio sin `/cartas/`.
- La calculadora (`C:\dev\tucarta`) se publica con un tag, y después se mueve
  `tucarta.version` en este repo. **El arreglo #7 queda pendiente de ese
  release.**
