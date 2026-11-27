# Instrucciones para Claude

## REGLA CRÍTICA: Comillas en HTML

**NUNCA usar comillas tipográficas** (`"` `"` U+201C/U+201D) en archivos HTML. Siempre usar comillas ASCII rectas (`"` 0x22).

Las comillas curvas rompen todos los atributos `class=` y `style=` porque el browser no las reconoce como delimitadores de atributos HTML. Los CSS classes dejan de aplicar y el layout se rompe completamente — es un bug muy difícil de diagnosticar visualmente.

Antes de deployar cualquier edición de HTML, si hay dudas: verificar con PowerShell que no haya bytes `e2 80 9d` o `e2 80 9c` en el archivo.

## Centrar: las dos trampas

### Trampa 1: `text-align-last`

`public/style.css` declaraba, en las reglas de base:

```css
p  { text-align: left; text-align-last: left; }
h2 { text-align: left; }
h3, h4, h5, h6 { text-align: left; }
```

Eso produce dos problemas distintos, y conviene no confundirlos:

1. **Centrar el contenedor no alcanza.** Un `text-align: center` en el padre no
   llega al `<p>` ni a los encabezados, porque cada uno trae su propio
   `text-align: left`. Hay que ponerlo en el elemento.
2. **Centrar el propio `<p>` tampoco alcanza, y esta es la traicionera.** En un
   parrafo de **una sola linea**, la unica linea es tambien la ultima, asi que
   manda `text-align-last` y no `text-align`. El `text-align: center` queda
   escrito, se ve correcto al leer el codigo, y no hace nada.

**Entonces, hasta el 19/11/2026 habia que escribir las dos:**

```css
.loquesea { text-align: center; text-align-last: center; }
```

Ya mordio varias veces: `/links/`, `/consultas/formulario.html` (tres veces) y
la `404.html` tienen cada uno su `text-align-last: center` puesto a mano para
esquivarlo.

En `public/style.css` el `text-align-last: left` es **redundante** (la ultima
linea de un texto alineado a la izquierda ya esta a la izquierda): su unico
efecto real es romper los centrados. Donde si corresponde es en
`public/libros/style.css`, que justifica el texto: ahi `text-align-last: left`
evita que la ultima linea se estire. No borrar esa.

**Resuelto el 19/11/2026:** se saco `text-align-last: left` de
`public/style.css` y de las dos copias inline del CSS critico (la home y
`/formaciones/`), y las 61 paginas pasaron a `style.css?v=32`. Hoy alcanza con
`text-align: center`. Los `text-align-last: center` que quedaron en `/links/`,
en el formulario de consultas y en la `404.html` son restos inofensivos.

### Trampa 2: el elemento ocupa todo el ancho

Mismo sintoma, causa distinta, y es la que mas se confunde con la anterior.
Centrar el texto de un contenedor no mueve a un hijo que **ya ocupa todo el
ancho**: la caja es tan ancha como el padre, asi que no hay nada que centrar y
el contenido se alinea al principio.

El caso concreto: **`.btn-sutil` esta declarado DOS VECES en
`public/style.css`** (hay un comentario "OJO" en la primera avisandolo), y la
segunda lo pone en `display: flex`. Un flex de nivel bloque ocupa todo el
ancho. Por eso el "Volver al inicio" de la `404.html` quedaba a la izquierda
aunque el parrafo estuviera centrado.

Se arregla haciendo que el elemento vuelva al flujo del texto:

```css
.loquesea .btn-sutil { display: inline-flex; justify-content: center; }
```

O, si tiene que seguir siendo de bloque, centrando la caja y no el texto:
`width: fit-content; margin: 0 auto` (es lo que hace `.deslizar-hint` en la
home, y por eso esa nunca se vio descentrada).

**Como distinguirlas en dos segundos:** si el texto esta a la izquierda pero
dentro de una caja que ocupa todo el ancho, es la trampa 2. Si la caja se
ajusta al texto y aun asi no se centra, era la trampa 1.

## Proyecto

- **El trabajo pesado va en `C:\dev\scratch`, nunca adentro del proyecto.** `functions/` vive en Google Drive, y Drive corta las escrituras mientras sincroniza: un `npm install` ahí dejó 4152 archivos en cero, incluidos los `package.json` de `puppeteer-core` y `mercadopago`, y no avisa más que con un `TAR_ENTRY_ERROR` perdido en la salida. Instalar en `C:\dev\scratch` con una copia del `package.json`, verificar que los módulos carguen, y recién entonces traer el resultado con `robocopy /MIR`. Lo mismo para cualquier archivo temporal grande.
- Sitio estático en Firebase Hosting (sebabru-e5563)
- Deploy: `firebase deploy --only hosting` desde `g:\Mi unidad\Seba Bru\SITIO`
- Archivos en `public/`
- Imágenes en `public/img/` — deben estar descargadas de Google Drive antes de deployar
- **Las reglas de Firestore se deployan con `firebase deploy --only firestore:cursos`, no con `--only firestore:rules`.** La base no es la default (se llama `cursos`) y `firebase.json` la declara en un arreglo, así que `--only firestore:rules` **termina con "Deploy complete!" sin haber publicado nada**: no compila, no sube y no releasea. Falla en silencio, que es la peor forma de fallar. Con el nombre de la base la salida dice "rules file firestore.rules compiled successfully", "uploading rules" y "released rules": si no están esas tres líneas, no se deployó (comprobado el 24/11/2026).
- **Un trigger nuevo con `retry: true` pide `--force`.** `firebase deploy --only functions:...` corta con "Pass the --force option to deploy functions with a failure policy" la primera vez que se crea. Con `--only functions:<nombres>` el `--force` no borra nada: no hay funciones de más en el plan.

## Mailing (Brevo)

- Cliente de la API: `functions/brevo.js` (fetch nativo, sin SDK). Hay una copia en `C:\dev\herramientas-sebabru\brevo.js`: si cambia uno, copiar al otro.
- **Un fallo de Brevo nunca puede romper una compra ni una inscripción.** Las altas se encolan en la colección `brevo_contactos` de Firestore y las procesa el trigger `sincronizarContactoBrevo`. No llamar a Brevo en línea desde un `onRequest`: la instancia se congela después del `res.send()`.
- El único que llama en línea es `exports.suscribir`, porque ahí Brevo es el flujo. Si falla, encola el alta y contesta que el mail va a demorar.
- **La suscripción es de un paso, o de dos según el carril** (de un solo paso
  por decisión de Seba del 2026-11-12; el segundo carril se agregó el
  21/11/2026). Con el captcha resuelto se da de alta directo y sale un mail de
  bienvenida, que es lo que pasa casi siempre. Lo que reemplaza al doble opt-in
  para evitar rebotes es `dominioRecibeCorreo()`, que verifica los MX del
  dominio antes de dar el alta; más el captcha desde el primer envío, la trampa
  para bots y la detección de typos. El mail de bienvenida lleva el enlace de
  baja bien visible, porque es el primer aviso que recibe quien no se anotó
  (ver el punto de la baja, más abajo).
- **Quien no puede resolver el captcha entra igual, con confirmación.** Antes
  se lo rechazaba con "No pudimos verificar que no sos un robot", y eso se
  comía también a quien tenía Cloudflare bloqueado por una extensión — que no
  puede hacer nada al respecto, ni recargando. Ahora `evaluarTurnstile()`
  devuelve cuatro estados en vez de un sí/no: sólo `rechazado` (un token
  forjado) cierra la puerta; `sin_token` y `sin_config` van a un carril que
  encola `doi: true` y deja que Brevo mande el mail de confirmación, sin
  `upsertContacto` ni bienvenida en línea. **Si falta la plantilla de
  confirmación de ese origen, el carril falla cerrado**, porque un carril
  degradado sin su único control es un endpoint abierto.
- **`redirectionUrl` no es opcional en el doble opt-in.** Sin ella
  `/contacts/doubleOptinConfirmation` contesta 400 "Redirection url is
  missing", y como es un 4xx el trigger lo toma por permanente, lo anota y no
  reintenta: **el alta se pierde sin que nadie se entere** mientras la página
  le dice a la persona que revise su casilla. Pasó entre el 21/11 y el
  25/11/2026 y dejó a dos personas afuera. Ahora la URL de vuelta la fija
  `confirmacionDeAlta()` y `pedirDobleOptin` tira si no la recibe, en vez de
  gastar un pedido que Brevo va a rechazar seguro.
- **El ebook entró al carril el 25/11/2026, con plantilla propia.** Antes
  quedaba afuera y se rechazaba, y el motivo valía: la rama `if (pedido.doi)`
  del trigger ignoraba `pedido.plantilla`, así que confirmar daba el alta y el
  libro **no llegaba nunca** (el bug del 2026-11-18). Lo que lo arregla es que
  esa rama ahora sí pasa `pedido.plantilla` y que el ebook tiene su propia
  plantilla de confirmación (id 10), donde **un solo botón confirma y entrega**:
  el `redirectUrl` del pedido deja a la persona en la página del libro. Por eso
  esa plantilla **no** lleva un enlace directo al ebook — si lo llevara, el
  libro se entregaría sin confirmar y el canje no sería canje. Si alguna vez se
  saca el `plantilla: pedido.plantilla` del trigger, el regalo deja de llegar
  otra vez.
- **Quién decide qué plantilla y qué vuelta es `confirmacionDeAlta(origen)`**,
  el equivalente de `plantillaDeAlta()` para el carril. Un origen nuevo que
  tenga que entregar algo necesita su entrada ahí, su plantilla y su
  `BREVO_DOI_*_TEMPLATE_ID`; si no la tiene, usa la general y está bien.
- **El captcha no es la única barrera, pero casi.** Conviene tenerlo claro
  antes de aflojar algo más: el honeypot no corre contra un POST directo al
  endpoint (un bot no manda el campo `hp`), y `dominioRecibeCorreo()` mira el
  dominio, no la dirección, así que cualquier cosa arroba gmail.com pasa. Lo
  que acota el daño es el **tope diario** (`TOPE_MAILS_SUSCRIBIR_DIA`, 50
  mails/día desde el formulario) y el **tope por dirección**
  (`TOPE_POR_DIRECCION`, 3 cada 24 h). El tope diario existe porque los 300
  mails/día de Brevo los comparten las confirmaciones de compra: sin él, un día
  de abuso deja sin mail a quien acaba de pagar un curso.
- **Todas las salidas buenas devuelven `RESPUESTA_ALTA`, byte por byte.** Alta
  nueva, ya suscrito, honeypot, carril con confirmación y los dos topes. Si
  alguna difiere, quien quiera abusar distingue los carriles y elige el barato.
  Por lo mismo el tope por dirección contesta 200 y nunca 429: un 429 sería un
  oráculo para averiguar si un mail ajeno ya se intentó suscribir.
- **Cada decisión de `suscribir` deja una línea `suscribir_decision`** en Cloud
  Logging y un contador en `metricas_suscribir/{YYYY-MM-DD}`. Antes ningún
  rechazo dejaba rastro y no había forma de saber si un problema le pasaba a
  cuatro personas o al 40%. En los logs va **sólo el dominio** del mail (nunca
  la parte local), la IP hasheada y el user agent en categorías.
- Mientras `BREVO_API_KEY` esté vacía en `functions/.env`, todo el mailing es un no-op que loguea un warning. **Pero `suscribir` contesta 503 `no_configurado` a propósito**: nunca decirle a alguien que revise su casilla si el mail no va a salir.
- Los transaccionales (confirmaciones, accesos, la carta en PDF) **siguen en nodemailer/Gmail**, no en Brevo. El plan gratis tiene 300 mails por día compartidos: una newsletter grande dejaría sin mail a quien acaba de comprar.
- El regalo del ebook (`/ebook/`) es una suscripcion con `origen: "ebook"`. `plantillaDeAlta()` hace que ese alta reciba la plantilla del libro (`BREVO_EBOOK_TEMPLATE_ID`, id 4) en lugar de la de bienvenida: esa persona no vino a suscribirse, vino por el libro. **El enlace al ebook esta solo en esa plantilla**, no en la pagina: es lo que hace que el regalo valga como alta.
- **La baja la hacemos nosotros, y el enlace sale de un param.** `{{ unsubscribe }}` es un tag de **campañas**: en un transaccional por `/smtp/email` Brevo no lo sustituye y el href queda vacío (comprobado el 2026-11-13 con el tag puesto dos veces en cada plantilla). Lo que sí funciona en un transaccional son los `params`, así que `urlDeBaja()` firma la URL con `BAJA_SECRET` y la plantilla pone `{{ params.baja }}`. Las plantillas de **campaña** (`sumate.html`, `lunacion.html`) sí usan `{{ unsubscribe }}`: ahí es el mecanismo correcto. No confundirlas.
- `exports.baja` bloquea el contacto en Brevo (`emailBlacklisted`, que es la marca que sobrevive a una reimportación futura) y apaga `novedades` en `usuarios` y `tucarta_usuarios`, para que Firestore no diga lo contrario que Brevo. **La pide `/baja/` con un POST desde JavaScript, no el enlace del mail**: Gmail pre-carga los enlaces para analizarlos, y un GET daría de baja a quien nunca lo tocó.
- Orden de deploy: primero las functions y la configuración de Brevo, después el frontend. Al revés, el formulario queda publicado contra un endpoint que no existe.
- Las herramientas de listas, migración y campañas están en `C:\dev\herramientas-sebabru` (ver `BREVO.md` ahí). En esa misma carpeta viven las demás herramientas de admin, que no son de Brevo y no están documentadas en ningún otro lado: `certificados.js` (los 4 certificados viejos), `titulos.js` (el padrón de los títulos nuevos), `videos.js`, `textos.js` (los 36 textos largos de la calculadora), `textos-puntos.js` (los 200 de las paginas de `/carta-natal/`), `paginas-textos.js`, `libro.js` y `kit-paginas.js` (la página de cada episodio del Kit, que sale del borrador del mailing).

## Títulos de egreso

- La persona lo emite sola desde `/escuela/certificados/` con su sesión de la escuela: completa cómo va escrito su nombre, el DNI y sus pronombres, lo ve en una vista previa y confirma. El PDF se arma, se descarga y le llega por mail.
- **El PDF no se guarda en ningún lado.** Es determinístico a partir del registro de `titulos` en Firestore, así que `descargarTitulo` lo regenera cada vez. Eso evita que un PDF con el DNI impreso quede en reposo en una URL, y evita Cloud Storage.
- La plantilla imprimible es `public/escuela/titulo/hoja.html`: recibe los datos en el fragmento (`#hoja=<base64url>`), igual que `/cartas/`, y tiene que dejar `window.hojaLista` o `window.hojaError`. **El fragmento no viaja al servidor**: por eso el DNI no queda en los logs de acceso. Necesita `firma.png` al lado; si falta, la hoja la oculta y el título sale igual.
- Dos plantillas en el mismo archivo (`plantilla: 'curso'` y `'formacion'`), que es lo único que cambia entre un año suelto y los cuatro años.
- Quién puede emitir sale de dos lugares, y alcanza con uno: el aula habilitada en `usuarios/{mail}.cursos`, o el padrón `titulos_habilitados/{mail}` que carga `node titulos.js --habilitar` en `C:\dev\herramientas-sebabru`.
- El título de los 4 años lo habilitan las aulas **`escucha`** y **`linaje26`**, que son las dos con las que se cierra la formación. Ojo con `linaje26` y no `linaje`: el segundo es el curso suelto de la formación abierta, que cualquiera compra. Es otro de los pares de nombre parecido, como `lunanegra`/`lilith` y `pluton`/`pluton26`.
- **`abierta: false` cierra la emisión de una formación** (así está hoy `lectura`, porque sus 4 egresadxs ya tienen el certificado viejo). Cierra solo el camino del aula: el padrón sigue funcionando, para dejar pasar a quien llegue tarde sin reabrirlo para todos. Cambiarlo es un redeploy de functions.
- **El número es `4-1122-2601`**: el prefijo lo fija cada formación (`prefijoNumero`), después van los dos últimos dígitos del año y un correlativo de dos dígitos que arranca en 01. Cada formación numera por su cuenta: el contador se guarda en `contadores/titulos` con la clave `<prefijo>-<año>`. Una formación sin `prefijoNumero` no puede emitir, y está bien que sea así: inventar un número de certificado es peor que no emitirlo.
- El número es lo que hace válido al título, no el PDF: la hoja es pública y cualquiera puede armarse un fragmento y ver un diploma inventado en pantalla. Lo que no puede falsificar es el número, que `/titulo/` verifica contra Firestore.
- La URL de verificación lleva número **y** un código HMAC de `TITULO_SECRET`. Sin el código, los números son correlativos y `/titulo/` sería un padrón de egresadxs recorrible de a uno. **Si se cambia el secreto, los códigos ya impresos en los PDF dejan de validar.**
- Emitir dos veces no genera dos títulos: corrige el que hay, con el mismo número, hasta tres veces. Es lo que resuelve el soporte más probable (un nombre mal tipeado).
- El mail con el adjunto sale por el trigger `enviarTitulo`, con nodemailer directo y 2 GiB. **No va por `mails_salientes`**: el PDF pasa el tope de 700 KiB de esa cola. Mismo arreglo que la carta natal de las inscripciones.
- **Los de años anteriores se emiten a mano** con `node titulos.js --manual <numero> "<Nombre>" <dni> <f|m|x> --confirmar` en `C:\dev\herramientas-sebabru`: esa gente no tiene cuenta ni las aulas de 2026, y su número lleva el año de su cohorte (`4-1122-2411`), así que no sale del contador. El comando registra el título, deja el PDF en `C:\dev\scratch` y **no manda ningún mail**. Registrarlo no es opcional: sin el documento en `titulos`, el QR del diploma contesta que no existe.
- Un título emitido a mano va sin mail, con id `manual__<numero>`, así que no queda atado a ninguna cuenta y la persona no lo puede rebajar sola. Se regenera con el mismo comando: con los mismos datos sale el mismo PDF.
- Los 4 certificados viejos (hechos a mano, PDF aplanados en `functions/certificados/`) siguen saliendo por `descargarCertificado`. Esa rama no se tocó.
- **Los ocho seminarios usan la plantilla `seminario`** (desde 2026-11-16), que no trae el texto escrito en `hoja.html`: lo recibe en tres tramos (`antes`, `medio`, `cierre`) alrededor de la itálica, desde `cuerpo` en `FORMACIONES_TITULO`. Es así porque los ocho textos no son un molde con huecos: cambia la apertura y cuatro tienen cierre propio. Sumar un seminario es una entrada más, sin tocar la hoja.
- **El progreso de clases todavía no llega al servidor.** "Clase reproducida" vive solo en `localStorage` (`visitadas_<pathname>`, en `escuela.js`): no cruza de dispositivo. Por eso los diplomas se habilitan por tener el aula y **no** por haber terminado la cursada. Cuando se abran las aulas de 2027 hay que escribirlo en `usuarios/{mail}.progreso.<slug>` y recién ahí el servidor puede exigir la última clase.

## Inscripciones a las formaciones y el padrón

- **Cada año de la formación es una entrada de configuración, no un endpoint.**
  `registrarInscripcion` es un motor genérico manejado por
  `FORMULARIOS_INSCRIPCION`; las cuatro formaciones las arma
  `formacionDeAnio()` a partir del arreglo `FORMACIONES_ESCUELA`. Sumar un año
  es una línea ahí. En vivo desde el 24/11/2026.
- Los `cursoId` del ciclo 2027 son **`intro27`, `lectura27`, `pluton27` y
  `transitos27`** (años 1 a 4), y son también el `formId` del formulario, la
  clave del padrón y el slug del aula. Ojo con los pares de nombre parecido:
  `pluton` es el seminario suelto y `pluton27` el tercer año; `lectura` es el
  curso viejo y `lectura27` el segundo.
- Las páginas son `/formaciones/{intro,lectura,seminarios3,transitos}/`, con el
  texto arriba y el formulario tras un `id="form"` (hay enlaces que apuntan a
  `/formaciones/intro/#form`). La lógica vive **una sola vez** en
  `public/formaciones/inscripcion.js`, parametrizada con `data-form-id`.
- **En las cuatro subpáginas el formulario es uno y está suelto abajo**, en
  una `section.anio-form` con el `id="form"`; el botón de adentro de la caja de
  scrolleo es un `<a href="#form">`, no abre nada. En la landing y en
  `/programa/`, donde conviven los cuatro años, el formulario **sí** va en una
  emergente (`emergente.js`), porque ahí no hay un "abajo" propio de cada año.
  No duplicar el formulario en una misma página: `sbBorrador` usa el `formId`
  como clave, así que dos instancias del mismo año se pisarían el borrador.
- **El arancel 2027 son 10 cuotas de $80.000, de marzo a diciembre**, igual
  para los cuatro años. El descuento de quienes continúan la formación **no se
  publica**: Seba se lo dice a cada persona (decisión del 25/11/2026, antes
  estaba escrito como un 20% en la página). Los precios viven solo en
  `public/formaciones/` — `/programa/` no tiene ninguno.
- **La mitad del año se llama semestre, no cuatrimestre**, y son 15 clases:
  con diez cuotas de marzo a diciembre cada mitad dura cinco meses. El detalle
  clase por clase de `/programa/` sale de
  `G:\Mi unidad\Seba Bru\Textos difusión escuela\programa.md`, que es la
  fuente: el HTML se alinea a ese archivo y no al revés.
- **`FORMA_DEL_PLAN.mensual` son 10 cuotas `cada: 1`** (marzo a diciembre, sin
  el salto de julio que tenía el esquema de ocho) y **`semestral` vence
  `cada: 5`**, para que la segunda cuota caiga en agosto. Es solo el punto de
  partida: el plan de cada fila se edita en el panel.
- **`opcionesViejas` en un campo de `FORMULARIOS_INSCRIPCION` acepta textos que
  el formulario ya no ofrece.** Hoy lo usa `formaPago` con
  `'En 8 cuotas mensuales'`, el texto de 2026. Existe porque el rechazo de un
  campo con `opciones` contesta 400 **sin custodiar nada**: una página abierta
  antes del deploy mandaría el texto viejo y se perdería la inscripción. No van
  en `opciones` para que no aparezcan en el desplegable del panel, que lee esa
  misma lista. Se puede sacar en marzo de 2027.
- **`columnasPorEncabezado: true` es lo que salva las columnas de Seba.** Con
  esa opción `asegurarHojaInscripcion` no pisa la fila 1 de la pestaña y solo
  agrega al final los títulos que falten, así `PAGO`, `NOTA` y los meses
  cargados a mano sobreviven. Sin ella la fila 1 es nuestra y se reescribe.
- **El padrón (`padron/{cursoId}__{mail}`) es la copia durable**, porque
  `procesarPendiente` borra `valores` y `carta` al terminar y hasta el
  24/11/2026 la única copia de una inscripción quedaba en Google Sheets. Lo
  llena la cola `padron_pendientes` → trigger `escribirFilaPadron`, enganchada
  como quinto efecto del `Promise.all` de `procesarPendiente`. El valor de
  cada columna va en `campos[key]` y **nunca** como campo de primer nivel: por
  eso agregar una columna no migra ningún documento.
- **`encolarPadron` escribe `escrito: null` explícito.**
  `where('escrito','==',null)` no matchea un documento donde el campo no
  existe — es por eso que `filas_planilla` no se puede barrer así. Con el campo
  puesto, una fila trabada aparece en el resumen de `revisarPendientes`.
- `padron`, `padron_columnas`, `padron_movimientos` y `padron_pendientes` están
  **cerradas de los dos lados** y todo pasa por la callable `adminPadron` con
  `exigirAdmin`. Es la excepción al resto del panel de la escuela, que lee
  Firestore directo: esta colección junta mail, teléfono, datos de nacimiento y
  plata de todo el padrón, igual que `agenda_pedidos` y `titulos`.
- **El acceso al aula no lo da la inscripción**, lo da el botón "Dar acceso" de
  la pestaña Inscripciones del panel (`accion: 'darAula'`), que escribe
  `usuarios/{mail}.cursos` y `aulaDada` en un solo batch.
- **El cupón de descuento no descuenta nada solo.** Las formaciones no se
  cobran en el sitio, así que el código queda anotado en el padrón
  (`campos.codigoDescuento` y `campos.descuentoCodigo`) y lo aplica Clari al
  cotizar. El formulario lo chequea en vivo contra `codigos_descuento` por la
  function `validarDescuento`, que es un `onRequest` y no una lectura directa
  de Firestore porque el formulario no trae el SDK y sumarlo serían 100 KB de
  más en seis páginas. **Un código que no valida no corta el envío**: queda
  escrito tal como lo tipeó, con `descuentoCodigo: 'no validó'`.
- **El porcentaje lo resuelve el servidor, nunca el navegador.** La página
  muestra el cartel por cortesía, pero `registrarInscripcion` vuelve a llamar a
  `validarCodigo()` y lo que queda en el padrón sale de ahí.
- **`maxUsos` no se descuenta en una inscripción.** `contarUsoDescuento()` está
  atado a un pago, y acá no hay pago: un código de un solo uso se puede usar
  todas las veces que quieran. Si hace falta limitarlo de verdad, hay que
  desactivarlo a mano desde el panel.
- **Un código sin `cursos` vale para todo**, incluidas las formaciones y los
  cursos grabados. Para que valga solo para un año hay que elegirlo en el
  desplegable del creador de códigos del panel, que ya lista los cuatro.
- **`delServidor: true` en un campo** es una columna que calcula el servidor:
  el bucle de validación de `registrarInscripcion` ignora lo que mande el
  navegador para esa clave. Hoy lo usa `descuentoCodigo`.
- **`asegurarColumnasDePadron` agrega las columnas que falten** en vez de
  cortar si el documento ya existe, con la misma lógica que
  `columnasPorEncabezado` en la planilla y por la misma razón: lo que Seba
  configuró ahí (orden, ocultas, columnas propias) no se pisa. Antes cortaba, y
  eso dejaba un bug callado: un campo nuevo en la config se guardaba en
  `campos[key]` de cada fila pero el panel no lo mostraba nunca. **Agregar un
  campo a un formulario del padrón pide revisar esto.**
- **Paso manual pendiente**, igual que el de `datos_sin_procesar`:
  `gcloud firestore fields ttls update expira --collection-group=padron_pendientes --enable-ttl`.
- **La planilla del panel es editable, y no es Google Sheets.** Cada celda es
  un `<input class="pad-edit">` que guarda al salir del campo con
  `accion: 'editarCampo'`. **El mail no se edita**: el id del documento se
  deriva de él, así que cambiarlo sería crear otra fila y dejar la vieja dando
  vueltas. Una columna nueva se agrega desde el panel
  (`accion: 'agregarColumna'`, sin deploy) y su valor vive en `campos[key]`.
- **Un pago es un renglón, nunca un número.** `pagos[]` guarda monto, fecha,
  medio y a qué cuota corresponde (o `cuota: null`, un pago suelto que suma al
  total y no cancela ninguna cuota). **`pagado` es un derivado y se recalcula
  entero** en cada escritura, con `runTransaction` porque `pagos` es un arreglo
  y dos pestañas abiertas se pisarían: un pago perdido es plata que la persona
  pagó y que el panel dice que debe. Un total tipeado a mano es exactamente de
  donde sale la diferencia de $255.000 de TERCER AÑO en la planilla de 2026.
- **El estado de la plata lo calcula el servidor** (`deudaDeLaFila`), nunca el
  navegador: si no, la grilla de un curso y la vista general de deudores
  podrían decir cosas distintas. Devuelve siempre la misma forma, con plan o
  sin plan.
- **Sin `plan.desde` nada figura atrasado**, y está bien que sea así: no se
  puede deber un mes que no se sabe cuándo venció. Esa fila sale como
  `sin_fecha`, visible y aparte. El tipo de plan sale de `campos.formaPago` si
  no se cargó a mano (anual / semestral / mensual, 1 · 2 · 10 cuotas).
- **El inicio de clases de cada año vive en `padron_columnas/{cursoId}`**
  (`cursada` y `plan`), y la semilla está en `FORMACIONES_ESCUELA`: viernes
  19/03/2027 para `intro27`, miércoles 17 para `lectura27`, jueves 18 para
  `pluton27` y sábado 20 para `transitos27`, 10 cuotas desde `2027-03`. Sale de
  las páginas de `/formaciones/`, que son la fuente.
  `asegurarColumnasDePadron` completa lo que falte y **no pisa** lo cargado a
  mano, igual que con las columnas; desde el panel se edita, y un campo vacío
  vuelve al valor del código.
- **Una fila nueva nace con plan** (`planInicialDePadron`), tanto del
  formulario como del alta a mano: sin eso quedaba en `sin_plan` hasta que
  alguien la abriera una por una, y la columna "Atrasados" de la vista rápida
  era un cero estructural. **`total` nunca se siembra**: los $80.000 × 10 son
  el precio de lista y los descuentos son personales, así que un total de lista
  pondría en falsa deuda a casi todo el padrón.
- **`aplicarPlanCurso` completa las filas viejas**, solo lo que falta, sin
  tocar `total` ni `pagos`, y no escribe si no cambia nada. Es el botón
  "Aplicar a las filas que no lo tienen".
- **Todas las columnas se ordenan y se ocultan, también Alta, Nombre, Mail,
  Teléfono, Plan, Pagado y Aula** (desde el 25/11/2026). Esas doce no salen de
  un formulario: las pinta un renderer propio, y hasta esa fecha estaban
  escritas a mano tres veces en `pintarPadron()` (cabeceras, celdas y claves de
  orden, las tres en el mismo orden), lo que las volvía las únicas inamovibles
  y encajonaba a las columnas propias en el medio de la tabla. Ahora:
  `COLUMNAS_FIJAS_PADRON` en `functions/index.js` es la lista blanca,
  `PAD_FIJAS` en el panel tiene el renderer de cada una, y el `<thead>` y cada
  fila se arman con **una sola** pasada por la lista de columnas.
- **El orden de las fijas vive en `padron_columnas.estructura`, aparte de
  `columnas`, y tiene que seguir así.** `editarCampo` manda cualquier key que
  no conoce a `campos[key]`, y `asegurarColumnasDePadron` agrega al final las
  del formulario que falten: meter las fijas en el mismo arreglo crearía
  columnas fantasma con datos que nadie volvería a ver. El `orden` sí es uno
  solo — `guardarColumnas` renumera las dos listas con un contador único y
  `columnasFusionadas()` las vuelve a unir por ese número —, y es lo que
  permite poner una columna propia primera o entre dos fijas.
- **`agregarColumna` rechaza las keys fijas.** Deriva la key del título, así
  que una columna llamada "Plan" generaría `plan` y chocaría con la fija: dos
  columnas con la misma key y un valor en `campos.plan` que no se vería nunca.
- **El orden por omisión es Alta · Nombre · Plan · Pagado · Aula · Mail ·
  Teléfono · las propias · nacimiento · Carta · Baja** (pedido de Seba,
  25/11/2026). Plan, Pagado y Aula estaban al fondo y obligaban a cruzar el
  scroll horizontal para ver lo que se mira al abrir la planilla. Vive en la
  semilla de `COLUMNAS_FIJAS_PADRON`, así que **sólo aplica a los cursos que
  todavía no guardaron su `estructura`**: un curso con el orden ya configurado
  desde el panel no se toca, que es justamente el punto. `intro27` tenía uno
  guardado a mano y se le borró el campo para que tomara el nuevo (no tenía
  columnas ocultas ni renombradas; si las hubiera tenido, había que decidirlo
  a mano).
- **Las columnas se acomodan desde la cabecera, no desde un editor** (desde el
  26/11/2026). Cada `<th>` se arrastra y además trae un `▾` con el menú de esa
  columna: ordenar por ella, mover a un lado o al otro, y ocultar. Lo elegido
  se guarda en el momento con `guardarColumnas` — el panel manda **la lista
  completa**, también las ocultas, que es lo que esa acción espera. El
  `<details>` "Títulos de las columnas" quedó sólo para renombrar y para crear
  una columna nueva: el orden y el ocultado ya no se leen de ahí, salen de
  `padColumnas`.
- **El menú va suelto en el `<body>`, `position: fixed`.** Adentro del `<th>`
  lo recortaba el contenedor de la tabla, que tiene `overflow-x: auto` (y
  `overflow-x: auto` con `overflow-y: visible` computa `auto` en los dos ejes).
  Se ubica con `getBoundingClientRect()`.
- **El ojo del final de la tabla es el camino de vuelta.** Es una columnita
  extra a la altura de las cabeceras que lista las ocultas; sin ella, ocultar
  la última columna no tendría regreso. Por eso el `colspan` del detalle de
  pagos es `visibles.length + 1`. Si están todas ocultas, la planilla lo avisa
  y ofrece el mismo menú en un botón.
- **Por omisión se ven Nombre, Plan, Pagado y Aula, y nada más** (pedido de
  Seba, 26/11/2026). Las fijas nacen con `oculta: true` en la semilla de
  `COLUMNAS_FIJAS_PADRON`, así que **sólo aplica a un curso que todavía no
  guardó su `estructura`**. Las del formulario son otra historia: no tienen
  estado "sin definir" (`asegurarColumnasDePadron` les escribe `oculta: false`),
  así que se ocultaron **una vez, a mano**, en los 14 documentos de
  `padron_columnas`. Las que se agreguen después —un campo nuevo del formulario
  o una columna del panel— **siguen naciendo a la vista a propósito**: una
  columna nueva tiene que anunciarse sola, que es justo el bug callado que
  documenta el punto de `asegurarColumnasDePadron`.
- **El mail se puede ocultar y mover, pero no editar**: el nombre del
  documento de la fila se deriva de él. El editor lo dice al lado.
- Se sacó la regla `@media` que escondía `:nth-child(3)` en pantalla chica.
  Servía cuando la tercera columna era siempre el mail; con las columnas
  ordenables tapaba un dato cualquiera.
- **Ordenar son dos cosas distintas y conviene no confundirlas.** El orden de
  las **columnas** es configuración de la formación y se guarda
  (`guardarColumnas`: reescribe `orden`, aplica `label` y `oculta`, preserva
  `tipo` y `opciones`, ignora las keys que no existen y deja al final las que
  no vinieron, para que una columna caída de la lista no se lleve los
  `campos[key]` de cada fila). El orden de las **filas** es una vista, vive en
  el navegador y se cambia con un clic en la cabecera. `listar` devuelve
  **todas** las columnas ordenadas por `orden`, también las ocultas: el panel
  necesita saber que existen para volver a mostrarlas, y filtra él.
- **`alta` no siempre es una fecha ISO.** La del formulario es la misma que va
  a la planilla de Sheets, en formato argentino (`25/11/2026, 14:30:05`), y
  `new Date()` sobre eso daba "Invalid Date" en la columna Alta; la de un alta
  a mano sí es ISO. Lo resuelve `fechaDeAlta()` en el panel, que entiende las
  dos y, si no entiende, muestra el texto tal cual antes que una fecha
  inventada.
- **Cobrar es un paso, y editar el plan es otro camino.** El botón de la
  columna Pagado abre el renglón de la fila con el formulario de pago
  **primero y ya completo**: la fecha de hoy, la cuota que toca (la primera
  pendiente) y el monto de cuota más frecuente de esa formación, que sale de
  contar los `pagos[]` de todas las filas (`montosPosibles()`); si todavía no
  hay ningún pago, de `total / cuotas` de la fila y del curso. El campo es
  escribible y el desplegable es un `<datalist>`, no una lista cerrada. El plan
  **ya no se edita ahí**: va por el lápiz de la columna Plan, en un emergente
  (`padPlanFondo`), para que cobrar no obligue a pasar por delante del plan.
- **Cada año es una sola vista, sin subpestañas** (se sacaron el 26/11/2026):
  primero la planilla y **abajo todo lo que la resume** — el inicio de clases,
  el total de esa cursada y los atrasados. Nada de eso va arriba de la tabla.
- **2026 tiene su propia vista rápida**, primera de su barra
  (`data-archivo-vista="1"`): el total del año más el detalle de las doce
  planillas. Ocupa el lugar de la planilla (se esconde `#pad-planilla-caja`),
  no se suma arriba. En la vista rápida general queda **sólo** el total del
  año: el mismo dato en dos recortes, `tarjetaDe2026()` y `tablaDe2026()`,
  para no repetir la tabla en los dos lugares.
- **Los datos de nacimiento no tienen interruptor.** Son tres columnas ocultas
  como cualquier otra, y `conNacimiento()` devuelve true sólo si alguna está a
  la vista: el dato no sale de Firestore si nadie lo está mirando. Al mostrar
  una, `guardarColumnasAhora()` ve que `conNacimiento() !== padNacCargado` y
  vuelve a cargar la planilla. `cargarPadron()` tiene la misma red para el
  cambio de curso, con una sola vuelta extra.
- **Las leyendas del panel se sacaron** (pedido de Seba, 26/11/2026): los
  carteles que explicaban cómo funciona cada cosa. Lo que queda son los
  mensajes de estado ("Nadie figura atrasado", "No hay columnas ocultas") y los
  errores. Las explicaciones van en los comentarios del código y acá, no en la
  pantalla.
- Anual y semestral **se distinguen solo por color**; el mensual muestra
  cuántas cuotas van pagas y cuáles faltan con su mes (pedido de Seba,
  24/11/2026).
- **Beca y media beca son tipos de plan** (desde el 26/11/2026). `beca` no es
  un plan de pago, es la ausencia de uno: `deudaDeLaFila` la corta antes de
  calcular nada y la devuelve con estado `'beca'`, así que no genera
  vencimientos, no puede figurar atrasada y no suma a "a cobrar"; la vista
  rápida la cuenta aparte. `media` **sí paga**, y paga igual que el mensual
  (10 cuotas, `cada: 1`): lo que cambia es el total, que como todos los
  totales es personal y se carga a mano. Por eso `PAD_EN_CUOTAS` del panel
  son dos tipos y no uno — si se agrega otro plan que venza de a cuotas, va
  en esa lista o se va a ver como una sola chapa.
- **Toda lista de pagos va de lo más nuevo a lo más viejo** (pedido de Seba,
  26/11/2026): el padrón, los pagos a Clari y los ingresos a mano. Las
  consultas del servidor ya ordenan por fecha, pero los `pagos[]` de una fila
  son un arreglo, así que el orden lo asegura `masNuevoPrimero()` en el panel,
  en un solo lugar.
- **El teléfono de un deudor es un enlace a WhatsApp.** `waHref()` arma el
  `wa.me`: en Argentina el móvil lleva el 9 después del 54 y no lleva el 0 ni
  el 15. Si el número no parece argentino se usa tal como está, porque un
  enlace que no abre es mejor que uno que abre con otra persona.
- **La vista rápida abre con todas las formaciones sumadas** y después el
  detalle año por año (pedido de Seba, 26/11/2026). La suma la hace el
  navegador con `sumaDeCursos()` sobre lo que ya devolvió `resumen`: no cuesta
  una lectura más.
- **Dar el aula de una formación anota a la persona en su planilla.** Lo hace
  el trigger `aulaAlPadron` sobre `usuarios/{email}`, y está ahí y no en el
  botón del panel a propósito: `usuarios.cursos` se escribe desde tres lugares
  (el casillero de "Editar usuario", el botón "Dar acceso" del padrón y la
  herramienta de migrar acceso), y así el padrón se completa por los tres.
  Reacciona **sólo a los cursos que se agregaron** y sólo a los de
  `FORMACIONES_ESCUELA`: un curso grabado no tiene padrón. Antes eran dos
  gestos separados y el panel podía decir que una formación tenía dos anotados
  mientras el aula tenía cuatro. La fila nace con `origen: 'aula'`,
  `aulaDada: true` y el plan del curso; si la escritura falla, custodia, para
  que no quede alguien con el aula y fuera de la planilla sin que nadie se
  entere.
- **Las cuotas se facturan con el facturador de AFIP, desde diciembre de 2026.**
  `C:\dev\facturador-afip` lista las cuotas sin facturar junto a las compras
  del sitio (ver `padron.js` y el LEEME de ahí). Facturan **Transferencia y
  Mercado Pago**; PayPal, Efectivo y Otro no. El corte es el 2026-12-01 y el
  archivo de 2026 nunca entra. Del lado de acá: un pago con `facturaId`
  **no se puede borrar** —`borrarPago` lo rechaza y el panel esconde el ✕—,
  porque la factura existe en AFIP y lo que corresponde es una nota de
  crédito; el renglón muestra el número abajo. Lo mismo para un ingreso de
  `finanzas_ingresos`, que **también se factura** desde ahí: es donde quedan
  las sesiones cobradas por fuera del sitio.
- **La factura dice una de tres palabras y nada más**: `Clases`, `Sesiones` o
  `Consultas` (decisión de Seba del 26/11/2026). Todo lo de la escuela es
  Clases; atender a alguien va por monto, con el corte en $100.000. No hay
  texto libre en ninguna pantalla y el facturador rechaza cualquier otra cosa.
  Qué se vendió no va impreso: queda en el registro de `facturas`. Y **todo
  sale a consumidor final sin identificar**, siempre.
- **PENDIENTE (etapa 2):** el cobro en línea de las cuotas con Mercado Pago y
  PayPal. El 10% a Clari y la importación de 2026 se hicieron el 25/11/2026
  (ver las secciones "Finanzas" y "El archivo de 2026"); la diferencia de
  $255.000 de TERCER AÑO quedó confirmada y sin corregir.

## El agendador de consultas

- **Los tests del motor son la verificacion barata, pero hay que correrlos
  bien**: `node --test functions/agenda-motor.test.js`, **no**
  `node --test functions/`. El segundo agrupa todo en un subtest y reporta
  "pass 1 / fail 0" **aunque adentro haya tests rojos** (comprobado el
  27/11/2026 con 10 fallos invisibles). Un comando de verificacion que miente
  es peor que ninguno.
- **El horario de un encuentro habitual se protege por regla, no por estar
  materializado.** `horariosDe` recibe las series activas (`leerSeriesActivas`)
  y descarta sus dia+hora+frecuencia hasta el infinito. Antes solo estaba
  tomado donde el barrido ya habia creado el turno, o sea hasta
  `ventanaSeriesDias` (60), que es **el mismo numero** que `ventanaDias`: en el
  borde habia carrera y el espacio de alguien de anios se podia perder.
- **Las series no van nunca en `ocupados`.** En `case 'calendario'` esa misma
  variable es lo que se pinta como "ocupado en tu calendario", y un encuentro
  que todavia no se materializo **no esta** en Google Calendar. `horariosDe`
  devuelve una cuarta lista, `series`, con la forma de `tramosBloqueados`, y el
  panel la pinta aparte (ficha `habitual`, violeta).
- **Se excluye una ocurrencia, no la serie entera.** Excluir la serie dejaria
  mover el encuentro del 10 encima del horario propio del 24.
- **`ocupacionEntre` devuelve `[inicio, fin, docId]`** y el id solo lo traen
  los turnos del sitio. Es lo que permite sacar de la ocupacion el turno que
  alguien esta soltando sin **derivar** su id del horario, que es lo que se
  hacia antes: con dos turnos en el mismo instante, el id calculado matcheaba
  a los dos y se podia reservar encima de uno que nadie solto. `chocaCon`
  destructura `[a, b]`, asi que el motor no se entera. **Nunca volver a
  comparar `idDeTurno(ms)` contra un id guardado.**
- **El admin puede superponer y el publico no.** `sujeto.superponer` solo se
  honra si `quien === 'admin'` (se revalida contra `quien`, no se confia en el
  cuerpo) y lo unico que hace es saltear `chocaCon`: el admin ya no pasaba por
  las franjas, la grilla, la anticipacion ni la pausa. El panel lo pide con un
  confirm, nunca en silencio.
- **El id con sufijo es la UNICA excepcion al candado del documento.** Dos
  turnos superpuestos comparten el instante de arranque y no pueden compartir
  el documento, asi que ahi el id va `...T16-00__2`. La busqueda del id libre
  va **adentro** de la transaccion: afuera, dos pedidos simultaneos elegirian
  el mismo sufijo. Fuera de ese caso el id es el horario pelado, que es lo que
  hace que dos personas que aprietan el mismo horario choquen y una pierda.
- **La duracion puede venir del sujeto.** Los encuentros de Seba duran 55, 60,
  75 y 120 minutos segun la persona; antes `extenderSerie` forzaba
  `tipo: 'una-hora'` para todos.
- **El mail de una serie es opcional.** De los 17 encuentros habituales que
  vivian en el calendario, 15 no tenian mail anotado. Exigirlo dejaba la
  agenda de anios afuera del sistema por un dato que Seba tiene en otro lado.
  Sin mail el horario se protege igual, pero no hay enlace personal ni
  invitacion, y el panel lo dice en la ficha.
- **Un extra tomado cierra los otros extras de ese dia, y eso se DERIVA.**
  `franjasExcepcionales` recibe `reservas` (los turnos del sitio, no la
  ocupacion entera) y saltea los `unicoPorDia` del dia si alguna reserva cae
  en uno. Guardarlo en el documento pedia escribir al confirmar y revertir en
  los cinco caminos de cancelacion -- y el que mas se olvida no se llama
  cancelar: es la liberacion del turno viejo al reprogramar
  (`canceladoPor: 'reprogramacion'`). Derivado, cancelar reabre el dia gratis.
  **Un `unicoPorDia` ausente vale `false`**: los extras ya guardados no se
  reinterpretan.
- **`excepcionalSaneado` emite TODAS las claves en las dos ramas**, y no es
  prolijidad: se guarda con `set merge`, asi que si la rama de fecha no
  escribiera `repite: false`, un extra creado como recurrente y editado a una
  fecha sola seguiria cayendo todas las semanas mientras la pantalla muestra
  una fecha.
- **Un extra publicado que se edita guarda `previo`.** `descartarBorrador`
  **borraba** todo documento con `borrador: true`: en cuanto los extras se
  pueden editar, eso era perder un espacio publicado por descartar un cambio.
  Ahora, si tiene `publicado`, vuelve a `previo` en lugar de borrarse.
- **La frecuencia es la misma regla en tres lugares** (franja de la semana,
  extra recurrente, serie) y la resuelve un solo predicado,
  `caeEnLaFecha(entrada, diaISO, porDefecto)`. **El default no es el mismo**:
  una franja o un extra sin frecuencia son semanales y una serie sin
  frecuencia es quincenal, que es lo que significaban los que ya estaban
  guardados. **Se cuenta en semanas desde el ancla, no en dias exactos**: con
  dias exactos, un ancla puesta un lunes sobre una franja de los martes no
  daba multiplo de 14 ningun martes y la franja desaparecia entera, sin aviso.
- **Una franja puede ser solo para un tipo** (`tipos: []` es los dos). Con eso
  se arma el viernes de sesiones y el viernes de consultas: dos franjas
  quincenales sobre el mismo dia con anclas corridas una semana. Antes eso
  pedia un bloqueo a mano por cada viernes.
- **Los campos de una franja se leen por clase, nunca por posicion.**
  `primeraFranja` y `leerConfigDeLaPantalla` usaban
  `querySelectorAll('input')` con destructuring: el `input type="date"` del
  ancla habria desordenado los dos horarios en silencio.
- **`horariosDe` normaliza el tipo antes de usarlo** (`tipoId = t.id`). Con el
  `tipo` crudo, una llamada sin tipo -- que significa "la consulta de dos
  horas" -- no veia ni los horarios excepcionales ni los bloqueos puestos para
  las consultas, porque `aplicaATipo` comparaba contra `undefined`.
- **Importar del calendario: dos pasos, y el segundo de a uno.**
  `node agenda-detectar.js` en `C:\dev\herramientas-sebabru` **solo lee** e
  imprime el JSON para pegar en el panel (Sesiones -> Importar). Un script no
  puede escribir por `adminAgenda`: esa function exige un ID token de usuario
  con claim `admin`, y una cuenta de servicio no puede emitirlo. La escritura
  pasa por el panel con la sesion de Seba.
  - La serie importada guarda `recurrenciaExterna` (el id del evento repetido)
    y **no se materializa**: su horario ya esta protegido por regla y crear
    eventos le duplicaria cada encuentro en el calendario. `extenderSerie`
    corta de entrada si ese campo esta puesto.
  - **"Pasar al sistema"** (`adoptarSerie`) corta la repeticion vieja con un
    `UNTIL` de ayer -- no la borra, lo que ya paso queda -- y recien entonces
    materializa. Si no se pudo cortar, **no materializa**: dejaria cada
    encuentro dos veces y limpiarlo es a mano.
  - **Ojo con las ocurrencias renombradas.** Seba usa un hueco que se guarda
    (el "Silencio" de los viernes) y le cambia el nombre a quien lo va a
    ocupar esa vez. Eso parece una serie y no lo es: su repeticion es la del
    hueco, asi que importarla y adoptarla **cortaria el hueco de todas las
    semanas**. El detector pide el evento madre, compara los titulos y las
    manda a turnos sueltos.
  - La frecuencia sale de la `RRULE` del evento madre (`INTERVAL=2` es la
    quincena), no de medir la distancia entre ocurrencias: medirla falla
    cuando en la ventana hay una sola o cuando alguna se movio de semana.
  - La delegacion de dominio esta autorizada para el scope `calendar`, **no**
    para `calendar.readonly`: pedir el de solo lectura devuelve
    `unauthorized_client`.
- **`adminAgenda` tiene `timeoutSeconds: 300`.** Con los 60 s de fabrica,
  crear una serie **semanal** se cortaba a la mitad: materializa ocho o nueve
  encuentros en fila, cada uno con un `freebusy` y un `events.insert`, y en
  fila es a proposito (todos juntos contra la API de Google es un 429).
- **El espacio de un habitual es suyo, y se ofrece SOLO si se libero**
  (decision de Seba del 27/11/2026). El horario de quien viene desde hace
  anios queda reservado para esa persona y no se le ofrece a nadie. Se abre en
  tres casos y nada mas, y los tres los resuelve `bloquesDeSeries`: la serie
  esta **pausada**, su encuentro de ese dia se **cancelo**, o se **movio** a
  otro horario. Los dos ultimos llegan en `liberadas`, un Set de
  `<serieId>|<ocurrencia>` que `ocupacionEntre` arma de paso con los turnos que
  existen y ya no estan `reservado` -- la reprogramacion incluida, que es la
  que mas se olvida porque no se llama cancelar.
  - **Y SI mira frecuencia y ancla**, al contrario de lo que hacia hasta el
    27/11/2026: solo los dias que son ocurrencia de esa serie. La semana que no
    le tocaba no era de nadie, asi que no hay nada que liberar.
  - Entre el 27/11 a la manana y esa misma tarde se ofrecio **siempre**, con el
    argumento de que el dia y la hora son horario de trabajo de Seba caiga o no
    esa persona. Eso publicaba el espacio de cada habitual todas las semanas
    (el martes 11:45 de Gabi se le ofrecia a cualquiera) y hacia aparecer
    horarios que no salian de ninguna franja ni de ningun extraordinario -- el
    viernes 08:00 --, **asi que no habia nada que editar en el panel**. Para
    abrir un hueco suelto estan los extraordinarios, que se ven y se editan;
    para abrir el horario de verdad, las franjas.
  - La fusion de bloques se mantiene: **dos espacios de una hora seguidos y
    los dos liberados son una consulta de dos**. Solo se fusiona lo que se
    toca, y **no se fusiona con el espacio de al lado si ese sigue siendo de
    alguien**: lo que se ofrece es el hueco que quedo, no el de la persona que
    viene igual.
  - **`leerSeriesVigentes` trae activas Y pausadas**, y por eso no filtra por
    estado. Una pausada tiene que llegar al motor porque su espacio es
    justamente el que se vuelve a ofrecer. Es la **misma lista** en los cuatro
    lugares que la piden -- lo que se ofrece, lo que se revalida al reservar,
    el ensayo de una adopcion y el calendario del panel -- a proposito: con
    listas distintas, confirmar un horario contestaria `slot_ocupado` contra un
    calendario que se veia libre. El barrido que materializa tiene su propia
    consulta por `'activa'`: una serie pausada no debe crear encuentros.
  - **`tramosDeSeries` tambien saltea lo liberado**, no solo lo materializado.
    En la practica toda ocurrencia liberada esta materializada (las dos listas
    salen de los mismos documentos), asi que alcanzaria con una; pero entonces
    el motor dependeria de una invariante que vive en otro archivo, y el dia
    que dejara de valer protegeria justo el hueco que se acaba de abrir.
- **Cada habitual tiene UN Meet, el mismo en todos sus encuentros** (desde el
  27/11/2026). La reunion se guarda en `agenda_series/{id}.conferencia` cuando
  se estrena y se copia a cada evento nuevo. Lo que **no** sirve para eso es el
  `requestId`: solo hace idempotente el reintento del mismo evento, asi que con
  uno por turno cada encuentro estrenaba link **y mover uno de horario le
  estrenaba otro** -- `reservarHorario` borra el evento y crea uno nuevo --, de
  modo que el enlace que la persona tenia guardado dejaba de servir. Una
  consulta suelta sigue estrenando reunion, que es lo que corresponde: no hay
  un vinculo que la reuse. `extenderSerie` materializa en fila, asi que el
  primero graba y los que siguen la encuentran: no hay carrera. Si copiarla
  falla (Seba borro el evento que la tenia), se pide una nueva y se regraba: un
  Meet viejo no puede impedir que el encuentro exista.
- **La regla protege lo que todavia NO se materializo, y nada mas.** Una
  ocurrencia que ya tiene turno sale de `tramosDeSeries` (`materializadas`, un
  Set de `<serieId>|<ocurrencia>` que arma `ocupacionEntre` de paso). Dentro
  del horizonte el turno ya bloquea desde `ocupados`, asi que aplicar las dos
  cosas no protegia mas: lo unico que agregaba era que un encuentro cancelado
  o movido siguiera tapando su horario viejo para siempre -- que es justo el
  que hay que volver a ofrecer.
- **Cuanto dura un encuentro habitual lo decide `duracionDeSerie`, en el
  motor, y nadie mas.** El default es `una-hora` y **no** el tipo por defecto
  del sitio, que es la consulta de dos. Cuando no era una sola funcion, una
  serie vieja sin `tipo` se protegia como consulta y se materializaba como
  sesion: el espacio de 08:00 a 09:00 tapaba hasta las 10:00, y el encuentro
  de las 09:30 de la persona siguiente se rechazaba con `slot_ocupado` contra
  un calendario que se veia vacio.
- **Adoptar una serie no la hace chocar contra si misma.** El ensayo corre
  antes de cortar la repeticion vieja, asi que `freebusy` todavia ve los
  encuentros de esa misma persona: `ensayarSerie` descuenta las ocurrencias de
  `recurrenciaExterna` (`instanciasDeRecurrencia`), comparando por el instante
  de arranque y no por superposicion, para no tapar un evento de verdad que
  caiga ahi al lado.
- **El mail NO alcanza para decir que un turno es de alguien**, y ahi estuvo
  el agujero mas grave del agendador (27/11/2026). `esTurnoDe()` es el unico
  predicado y lo usan los dos lugares que miran turnos ajenos: la lista del
  enlace (`turnosDePersona`) y el turno que se quiere mover
  (`turnoDePersona`). Tienen que dar la MISMA respuesta: si la lista muestra
  algo que el cambio no acepta, el boton da error; si el cambio acepta algo que
  la lista no muestra, se puede mover un encuentro ajeno a ciegas.
  - La regla: un turno con `serieId` es suyo **solo si esa serie es suya**; uno
    sin serie es suyo por mail o por pedido. Antes bastaba el mail, asi que con
    dos personas anotadas con la misma direccion -- lo que pasa con las series
    cargadas a mano para probar, varias con el mail de Seba -- el enlace de Mel
    mostraba "tu proximo encuentro" con **el horario de Ignacio**, y `miCambio`
    la dejaba moverselo.
  - La consulta por mail se hace igual y trae de todo: el filtro es el que
    decide, no la consulta. Y un turno **sin** serie sigue siendo suyo por
    mail, que es lo que hace que quien viene cada quince dias y ademas saco una
    consulta vea las dos cosas en un solo lugar.
  - Con la cuenta de la escuela `seriesDePersona` trae todas las series de ese
    mail, asi que el filtro no quita nada: son todas suyas.
- **Ojo con poner el mismo mail en dos series.** Mas alla del aislamiento, los
  avisos y las invitaciones de las dos van a esa direccion. Hoy Belen, Ignacio
  y Mel tienen el de Seba, que fue como se probo el sistema.
- **El enlace personal mueve cualquier encuentro futuro, no solo el
  proximo.** Cada fila de "Los que vienen despues" trae su propio boton y
  `abrirCambio(turno)` recibe cual. Antes habia un solo boton y para correr el
  encuentro del mes que viene habia que esperar a que fuera el proximo.
  `miDisponibilidad` ya aceptaba cualquier `?turno=`, no hubo que tocarlo.
- **Un encuentro se va del enlace cuando TERMINA**, no dos horas despues de
  empezar, que es lo que hacia `turnosDePersona`. Mientras esta pasando, el
  enlace es donde vive el Meet; apenas termina, el lugar lo toma el siguiente.
- **Los extraordinarios se ven adentro del calendario, en naranja**, con un
  aviso que sale solo los dias que tienen alguno: valen por esta vez y **no
  pasan a ser el horario de siempre de nadie**. Antes eran una lista plegada
  abajo, detras de un "no encontras un horario que te sirva" -- el camino
  equivocado para quien viene siempre y lo que busca es correr SU encuentro
  una semana.
- **El enlace puede decir que clase de encuentro se viene a agendar.**
  `/consultas/agenda/?tipo=una-hora` ofrece los horarios de las sesiones y
  reserva una sesion; sin el parametro sigue siendo la consulta de dos horas,
  que es lo que ofrece `/consultas/`. El backend ya lo soportaba --
  `disponibilidad` y `reservarParaPedido` leen `pedido.tipo` -- y lo unico que
  faltaba era que `iniciarAgenda` lo guardara. **Ese enlace no es secreto ni
  de un solo uso y no cobra nada**: es para mandarselo a una persona, no para
  publicarlo. Y reserva UN encuentro: para que quede como habitual hay que
  cargarla como serie en el panel.
- **El telefono de "ya falta menos de 12 horas" es el de Seba**
  (+54 9 3544 584122), no el de Clari ni el mail: mover un encuentro a ultimo
  momento lo decide el. Las 12 horas salen de `anticipacionCambioHoras` del
  tipo `una-hora` (la consulta de dos horas pide 48).
- **`hidden` necesita `[hidden] { display: none !important; }`** en cualquier
  pantalla que lo use para prender y apagar. El atributo no es mas que un
  display:none del navegador y cualquier regla propia con `display` lo anula.
  El cartel "Tenes cambios sin publicar" del panel estuvo **siempre** a la
  vista por `.pa-borrador { display: flex }`, dijera lo que dijera el
  servidor: no era que hubiera cambios pendientes.
- **Cortar una repeticion vieja no alcanza con el UNTIL.** Las ocurrencias que
  Seba edito a mano quedan guardadas aparte en Google y **sobreviven al
  corte**, asi que el encuentro aparece dos veces: el que crea el sistema y el
  resto de la repeticion. `cortarRecurrencia` las borra una por una despues de
  patchear, y todo va con `sendUpdates: 'none'` -- la persona sigue teniendo
  su encuentro y un mail de "evento cancelado" diria lo contrario.
- **Ojo con editar el mismo encuentro en Google Calendar.** Mover una
  repeticion con "este y los siguientes" crea una **serie nueva con otro id**,
  asi que el `recurrenciaExterna` que tiene anotado el sistema queda
  apuntando a una repeticion muerta mientras la viva es otra. Paso con
  Francisca (09:30 vs 12:00) y con Vir Cerione (10:30 vs 10:45). Para
  auditarlo esta `_auditar-series.js` en `C:\dev\herramientas-sebabru`, que
  compara serie por serie lo que dice el sistema con lo que hay en el
  calendario.
- **Editar una serie ya no le borra el tipo de encuentro.** El formulario del
  panel no manda `tipo` ni `notificaciones`, asi que `serieSaneada` los reponia
  en sus defaults: una serie de 75 o 120 minutos **se rebajaba a 60** al
  pausarla o al guardarla, y eso es lo que decide cuanto espacio se protege;
  las notificaciones que la persona habia apagado desde su enlace se volvian a
  prender. Ahora `serieSaneada(cruda, previa)` recibe lo guardado y conserva lo
  que el formulario no manda, y ademas el panel manda el tipo en un
  desplegable. Vale la regla: un formulario que manda un subconjunto de los
  campos pide sanear **contra** lo que ya esta guardado, nunca contra los
  defaults.
- **Los bloqueos se editan** (`guardarBloqueo`, desde el 27/11/2026), con el
  mismo molde que `guardarExcepcional`: `previo` para que descartar el borrador
  los devuelva. Antes solo se podian crear y borrar, asi que corregir una hora
  pedia quitarlo y volver a cargarlo -- y entre las dos cosas el horario
  quedaba abierto. `bloqueoSaneado` es la validacion, una sola para el alta y
  la edicion, y **emite todas las claves en las dos ramas** por el `set merge`,
  igual que `excepcionalSaneado`.
- **Los espacios libres se publican en el calendario de Seba** (desde el
  27/11/2026, pedido suyo): un evento por tramo contiguo agendable, una vez
  por dia a las 6:40, mas el boton "Rearmar los espacios libres del
  calendario" al final de Disponibilidad, que hace falta justo despues de
  cambiar las franjas (esta ahi, y no en Sesiones, porque es donde estan las
  franjas: cambiarlas es lo que vuelve falso lo publicado).
  - **LA TRAMPA, y es la que decide todo el diseno: la ocupacion se lee de ESE
    MISMO calendario con `freebusy`.** Un evento normal que diga "libre" seria
    ocupacion para el motor, asi que taparia justo el hueco que anuncia y el
    sitio dejaria de ofrecer nada. Por eso van con
    `transparency: 'transparent'`, que en Calendar es "disponible" y es lo que
    hace que freebusy no los cuente. **Comprobado de las dos puntas** el
    27/11/2026 (`_probar-transparente.js` en las herramientas): transparente
    no aparece en freebusy, y el mismo evento marcado como ocupado si. Si
    alguna vez se saca esa linea, la agenda se cierra sola y en silencio:
    freebusy no distingue el titulo del evento.
  - Se parte de los horarios que el sitio **ofrece de verdad**
    (`slotsVisibles` con el tipo de una hora, que es el mas corto) y no de las
    franjas menos lo ocupado: un hueco de cuarenta minutos no es un espacio
    agendable y pintarlo como libre seria prometer algo que la pantalla de
    reservas no da. `bloquesLibres` los fusiona con una tolerancia de 20
    minutos, **porque el aire entre encuentro y encuentro es parte del
    bloque**: con cadencia 75 y sesiones de 60, los horarios de 14:00 y 15:15
    dejan quince minutos que no son un hueco, son el respiro. Sin esa
    tolerancia cada sesion seria su propio evento.
  - **Se respeta la anticipacion** (no se pasa `sinAnticipacion`): un hueco que
    nadie puede tomar porque faltan menos de 24 horas no se anuncia.
  - Se reconocen por `extendedProperties.private.origen = 'sb-espacio-libre'`
    y **no por el titulo**: un evento que Seba escriba a mano y se llame
    parecido no se toca. Cada barrido borra los suyos y los vuelve a escribir,
    que es mas simple que comparar y no puede dejar anunciado un hueco que ya
    se lleno.
  - Con la agenda en pausa se borran y no se publica nada, y hay un tope de
    120 eventos por si el calculo se va de las manos.
- **La salida a Clari se ve siempre.** En `/consultas/agenda/`, el bloque
  "¿No encontrás un horario que te sirva?" **ya no se esconde** cuando no hay
  extraordinarios: se esconde solo la lista de adentro. Abajo va el WhatsApp
  de Clari, y quien no encontro nada es justamente quien lo necesita.

## El archivo de 2026

- **Las 82 filas de la planilla FORMACIONES 2026 están en el padrón** (migradas
  el 25/11/2026). Son cursos de archivo: `FORMACIONES_ARCHIVO` en
  `functions/index.js`, con `cursoId` `a26_*` y una entrada por pestaña de la
  planilla. El prefijo no es decorativo: `linaje26` y `pluton26` ya son slugs
  de aulas, y un `cursoId` repetido mezclaría dos padrones.
- **2026 no cruza a Finanzas, y tampoco a la vista rápida** (decisión de Seba
  del 26/11/2026; antes sí sumaba a Finanzas). El archivo es un campo de
  prueba para ver cómo funciona el padrón: `juntarTodo` saltea los cursos de
  `CURSOS_ARCHIVO` de entrada, así que no suma a ningún ingreso ni entra en la
  base del porcentaje de Clari. `accion: 'resumen'` los saltea igual, y las
  filas nacen con `plan: null`, así que nada puede figurar atrasado: 2026 está
  cerrado y reclamar una cuota de marzo de 2026 no es lo que el panel tiene
  que recordar todos los días. Se mira en su propia vista rápida, dentro del
  padrón, y ahí termina.
- **Gana la columna PAGO, no los meses** (decisión de Seba). Entra como **un**
  renglón de `pagos[]` fechado al 31/12/2026, con la nota que aclara que es el
  total del año y no un cobro de ese día. Las columnas de meses de PRIMER AÑO
  se guardan igual en `campos`, así que el detalle no se perdió.
- El importador es `C:\dev\herramientas-sebabru\padron-2026.js`: lee la
  planilla por la API REST de Sheets con las credenciales de `functions/.env`,
  mapea los encabezados **por alias** (cada hoja tiene los suyos; ESCUCHA
  escribe `pago` en minúscula) y lo que no matchea ningún alias lo guarda como
  columna propia con su título original. Simula por omisión; escribe con
  `--confirmar`; `--rehacer` reescribe lo ya importado.
- **Cuidado con las filas "TOTAL" de cada hoja.** Varias pestañas cierran con
  una, sin mail, y al importarla duplicaba exactamente lo cobrado del curso
  (ESCUCHA, LINAJE, SATURNO, REVOSOLAR y PLUTON daban el doble del BALANCE).
  `esFilaDeTotales()` las saltea, y pide que no tengan mail: si alguien se
  llamara "Total" y tuviera mail, es una persona.
- **Un valor con barra no puede ser el id de un documento: la barra es el
  separador de la ruta.** En SEGUNDO AÑO hay una fila con las columnas
  corridas y la fecha de nacimiento en la columna del mail
  (`31/08/1989`). Como el id se deriva del mail, el documento se escribió en
  `padron/a26_segundo__31/08/1989`, o sea un documento de una subcolección
  colgada de un documento que no existe: invisible para el panel y para
  cualquier consulta de `padron`. Se perdió una fila de $150.000 **sin un solo
  error en la salida**. Ahora un valor que no pasa `MAIL_VALIDO` no se usa como
  clave y se guarda como dato, y hay una red que corta cualquier id con barra.
  Vale para cualquier migración futura.
- **El control es la hoja BALANCE 2026**, y el importador lo imprime hoja por
  hoja. Hoy 11 de las 12 coinciden al peso. La única diferencia es la de
  **TERCER AÑO**, que ya estaba medida y quedó confirmada por dos fuentes
  independientes: los pagos de las ocho personas suman $1.175.000 y el BALANCE
  declara $920.000. **No se corrigió**: queda a la vista para decidirla a mano.
  (El otro número viejo de ese pendiente, "los meses no suman al PAGO en 8 de
  26 filas de Primer Año", sigue sin tocarse porque gana el PAGO.)
- **`SUMA TOTAL` del BALANCE era $12.310.400 y el padrón suma $12.565.400**: la
  diferencia es exactamente la de TERCER AÑO.
- **La subpestaña 2026 abre con el total de los doce cursos juntos**: personas,
  cobrado y el detalle curso por curso. Sale del mismo `resumen` que la vista
  rápida (que ahora devuelve un bloque `archivo` aparte), así que verlo no
  cuesta una lectura más.
- **La deuda de 2026 en pesos no existe, y la pantalla lo dice.** Las columnas
  `resta` (PRIMER AÑO) y `faltan` (SEGUNDO) **no son importes: son cuotas**,
  con valores de 0 a 10, y el BALANCE declara TOTAL DEBEN $0. Por eso el total
  muestra "cuotas que faltaban" y no un monto: multiplicarlas por un arancel
  sería fabricar una deuda que nadie registró. Si algún día aparece el dato en
  plata, va en una columna nueva, no en esas dos.

## Finanzas

- **Pestaña Finanzas del panel**, con cuatro subpestañas: Ingresos de la
  escuela, Pagos a Clari, Consultas e Ingresos totales. Todo pasa por la
  callable **`adminFinanzas`**, y las cuatro colecciones (`finanzas_clari`,
  `finanzas_ingresos`, `finanzas_config`, `finanzas_movimientos`) están
  cerradas de los dos lados: una sola alcanza para reconstruir cuánto factura
  la escuela.
- **ARS y USD nunca se suman.** PayPal cobra en dólares y Mercado Pago en
  pesos; un total único sería un número que no existe. Cada agregado lleva las
  dos monedas en renglones separados.
- **Lo no confirmado va aparte.** Una compra con estado "transferencia avisada
  (a confirmar)" es alguien que dijo que pagó, no plata que entró.
- **El 10% de Clari se calcula sobre los pagos del padrón** (las formaciones),
  no sobre los cursos grabados ni las consultas. El porcentaje vive en
  `finanzas_config/clari` y se edita desde el panel: cambiarlo no es un deploy.
  2026 **no entra**, y ya no hay casilla para incluirlo (ver el punto de "El
  archivo de 2026"). El BALANCE 2026 calculaba "PAGAR A CLARI" como el 10% de
  **todo** lo ingresado: ese número ya no se puede reproducir desde el panel,
  y está bien, porque es la cuenta de un año cerrado.
- **Un pago a Clari es un renglón, nunca un número tipeado**, igual que los
  pagos del padrón: el saldo es derivado.
- **Una compra de prueba se marca, no se borra.** `compras` con
  `prueba: true` no suma a Finanzas. Es lo que se hizo con los $800 de
  `mp_183132780689` (el curso `lilith`, 01/11/2026), que era una prueba de
  Seba: el pago existió en Mercado Pago y borrar el registro sería perder el
  único rastro que tenemos de él.
- **"Consultas y sesiones" es una columna de Ingresos de la escuela**, no sólo
  una subpestaña: hasta el 26/11/2026 esa tabla mostraba formaciones, cursos
  y libro, y lo cobrado por consultas no aparecía en ningún total por mes.
- **El número de consultas es un piso, y la pantalla lo dice.** Sólo está lo
  que pasó por el sitio (Mercado Pago y PayPal, en `compras` con
  `producto: 'consulta'`). La columna "Pago" de la planilla de consultas está
  vacía en las 9 filas que hay, y una consulta que se paga por transferencia a
  Clari no queda registrada en ningún lado. Para eso está el alta de ingreso a
  mano (`finanzas_ingresos`), que es lo que hace que "Ingresos totales" pueda
  incluir lo del agendador.
- **`barrerColeccion()` pagina de verdad** con `startAfter`. Los `limit` del
  resto del panel son topes duros, y acá un total silenciosamente incompleto
  sería peor que un error. El rango de fechas de `compras` se filtra en
  memoria para no necesitar un índice compuesto el día que haya que cruzarlo
  con el producto o el estado.

## El panel de la escuela

- **Seis grupos, no once pestañas** (reorganizado el 24/11/2026, Finanzas
  sumada el 25/11/2026): **Gestión de alumnos** (el padrón, antes
  "Inscripciones"), **Usuarios** (buscar + todos), **Acceso a las aulas**
  (invitaciones, descuentos, migrar acceso, enlace maestro), **Contenidos**
  (videos del curso arriba, Tu carta abajo), **Finanzas** y **Pendientes**
  (pendientes + compras). Cada grupo es un `.tab-panel`; los paneles viejos
  quedaron adentro como `.card` sueltas, así que mover una tarjeta de grupo es
  cortar y pegar.
- **Las pestañas son de tres niveles y cada barra apaga sólo su grupo.** Cada
  `.tabs` declara un `data-grupo` y cada `.tab-panel` el suyo; la falta del
  atributo cuenta como el grupo `raiz`, y por eso el primer nivel no se tocó.
  El listener viejo apagaba **todos** los `.tab-panel` del documento, así que
  abrir una subpestaña cerraba la pestaña que la contenía: no alcanzaba con
  anidar el HTML. El listener es delegado en `document` para que la barra de
  2026, que la arma el servidor, no tenga que registrar nada.
- **Las subpestañas del padrón no duplican nada: sólo cambian el curso.**
  `#pad-curso` sigue existiendo (oculto) y sigue siendo el que manda; cada
  subpestaña de año hace `padCursoSel.value = cursoId` y dispara su `change`,
  que es el que ya llamaba a `cargarPadron()`. Las tres vistas (Planilla,
  Pagos y deuda, Columnas) son tres `.tab-panel` sobre **un solo** bloque de
  planilla, no tres copias. Mover el nodo con `appendChild` también habría
  funcionado (los listeners viajan con él), pero no hacía falta.
- **El alta a mano tiene su propio selector de curso** (`#pad-alta-curso`).
  Antes tomaba el de la planilla, y desde que están en subpestañas distintas
  eso sería anotar a alguien en un curso que no se ve en pantalla.
- **El panel no tiene tope de ancho** (se sacó el `max-width: 900px` de
  `.tab-panel` el 25/11/2026): la planilla del padrón es la tabla más ancha del
  sitio. Lo que sí lleva medida es el texto largo — `.card > p`, los `textarea`
  y los párrafos de los ajustes —, porque una línea de prosa cruzando 2500 px
  no se lee. Las tablas quedan afuera de esa regla a propósito.
- **Varias tarjetas cargan sus datos recién al hacer clic en la pestaña.** Por
  eso, después de que la sesión se valida, el panel llama a `abrirActivas()`,
  que recorre las barras **de afuera hacia adentro** y clickea el
  `.tab-btn.active` de cada una que esté a la vista (`barra.offsetParent`): la
  pestaña que ya viene abierta nunca recibiría ese clic y se vería vacía. Sólo
  las visibles, porque clickear la subpestaña de un grupo cerrado pediría
  datos que nadie está mirando. Antes era un único
  `document.querySelector('.tab-btn.active')?.click()`, que con tres niveles
  sólo abría el primero.
- **Quién administra sale de una sola lista**, `ADMINS_PANEL` en
  `functions/index.js`. `crearEnlace` y `ADMINS_TUCARTA` tenían su propia copia
  literal hasta el 24/11/2026 y ahora apuntan a esa: eran dos lugares donde
  olvidarse de sumar a alguien. Afuera quedan **18 copias en
  `firestore.rules`** (el resto del panel lee Firestore directo) y la de
  `ADMIN_EMAILS` en el HTML, que es **solo cosmética**: decide si se ve el
  panel, no si se puede hacer algo. Sumar un admin es tocar los tres lugares y
  redeployar functions **y** reglas.

## Nunca perder un dato que alguien dejó

**Criterio fijo, y vale para todo formulario nuevo** (pedido de Seba,
21/11/2026). Si todo está bien, flujo normal. Si hay algo raro, **el dato se
guarda igual**, se avisa, y la persona recibe una respuesta honesta. Un
rechazo nunca puede ser la única consecuencia de que alguien se haya tomado el
trabajo de escribir.

Hasta el 22/11/2026 el sitio validaba primero y guardaba al final, así que cada
rechazo tiraba lo escrito. Había pérdidas en 7 endpoints, dos de ellas
**después de cobrar**.

Lo que hay que hacer en cada endpoint nuevo que reciba datos de una persona:

- **`custodiar({ endpoint, motivo, gravedad, datos, contacto, req })`** en vez
  de un `return res.status(...)` seco. Escribe en `datos_sin_procesar` y nunca
  tira, como `encolarContactoBrevo` y `encolarMail`.
- **Toda custodia avisa por mail, desde el 25/11/2026.** Antes avisaban sólo
  las graves y el resto esperaba al resumen de la mañana siguiente: eso fue lo
  que dejó a cuatro personas sin suscripción durante tres días. Lo que evita la
  inundación no es callarse, es la ventana anti-repetición de `avisos/{motivo}`,
  que agrupa por motivo. **`gravedad: 'grave'`** (plata cobrada o configuración
  nuestra rota) más **`avisarSiempre: true`** saltea la ventana — es lo que
  corresponde cuando hay plata, porque dos pagos sin entregar son dos
  problemas. `'normal'` entra además en el resumen diario.
- **`custodiar()` escribe en TRES lugares, y ninguno cuelga del anterior.**
  Firestore (`datos_sin_procesar`, con TTL de 90 días, es el que alimenta el
  panel), la **pestaña `BITACORA`** de la planilla, y el mail. Van en un
  `Promise.allSettled` a propósito: el aviso y la planilla se intentan **aunque
  Firestore haya fallado**, que es justo el caso para el que existen.
- **La bitácora es el único canal que sobrevive a un Firestore caído.** Todo lo
  demás vive ahí: el dato, la ventana anti-repetición, y hasta el mail de
  alarma, que se encola en `mails_salientes`. La planilla es otro sistema, con
  otra autenticación. Usa la cuenta de servicio y los helpers que ya tenían los
  formularios (`getSheetsClient`, `asegurarHojaInscripcion` con
  `porEncabezado: true`, así una columna que agregue Seba no se pisa).
  **Ahí va el payload COMPLETO y una planilla no vence**: lo que en Firestore
  se borra a los 90 días, en la planilla queda para siempre, DNI y datos de
  nacimiento incluidos (decisión de Seba del 25/11/2026). Sale de
  `SHEETS_SPREADSHEET_BITACORA`, con la planilla principal como respaldo:
  moverla a un archivo con menos gente adentro no es un cambio de código.
- **El campo `bitacora` del documento dice si la fila salió.** Sin eso no había
  forma de saber que el segundo canal andaba sin abrir la planilla a mano. Si
  fallan los dos, queda un `dato_perdido` en el log con todo lo que escribió la
  persona, que es el último lugar donde mirar.
- **Nunca custodiar un bot**: ni el honeypot, ni el veredicto `rechazado` del
  captcha (token forjado). Hay además un tope de 20 custodias por IP por día.
  Sin esa regla la bandeja se llena de basura, Seba deja de leerla, y no sirve
  el día que caiga algo de verdad.
- **La respuesta cambia de tono.** Si el dato quedó guardado, no se contesta un
  error: se dice que quedó anotado y que se escribe por mail. Decirle "probá de
  nuevo" a alguien es pedirle que escriba todo otra vez para chocarse con el
  mismo problema.

Del lado del cliente, todo formulario nuevo lleva **`/borrador.js`**:
`window.sbBorrador.cuidar(form, 'nombre-del-form')` y `.listo()` cuando el
envío sale bien. Guarda en `localStorage` mientras se escribe y lo ofrece al
volver. **Nunca guarda contraseñas ni el honeypot**, y se carga **sin `defer`**
cuando lo usa un script en línea.

Cuatro cosas que conviene recordar porque no son obvias:

- **Un `logger.error` no le avisa a nadie.** Hay más de 80 en `index.js` y no
  existe ninguna alerta configurada sobre los logs. Toda alarma sale por
  `mails.encolarMail`, nunca por Brevo y nunca confiando en el log.
- **`envios_carta` y `envios_titulo` corren sin `retry`.** Un fallo deja el
  documento con `enviado: null`; eso lo levanta `revisarPendientes`, que es el
  único barrido de colas que existe. Desde el 25/11/2026 además **custodian**
  (`grave` + `avisarSiempre`) y siguen tirando, para que el documento quede en
  `null` y el barrido lo siga viendo: marcarlo enviado sería mentir.
- **Los fallos de las colas también custodian, no sólo los endpoints.** Era el
  agujero grande: `sincronizarContactoBrevo` anotaba el error en el documento y
  se callaba, así que un rechazo de Brevo no salía por mail ni aparecía en el
  panel, y lo único que lo nombraba era el resumen del día siguiente. Un
  trigger nuevo que pueda dejar a alguien sin lo que pidió lleva su
  `custodiar()`.
- **Ojo con custodiar desde `enviarMailEncolado`**: la custodia manda un mail
  por esa misma cola, así que sería un bucle. Esa cola la cubre el resumen
  diario y nada más.

La bandeja se ve en el panel de la escuela, pestaña **Pendientes**, que lee por
la callable `pendientes` (la colección está cerrada en las reglas: adentro hay
DNI, direcciones y datos de nacimiento). Se borra sola a los 90 días por la
política de TTL sobre el campo `expira` — **ese paso es manual** y no va en el
deploy:
`gcloud firestore fields ttls update expira --collection-group=datos_sin_procesar --enable-ttl`.

## OG Tags

Toda página nueva debe incluir estos 6 meta OG en el `<head>`:
```html
<meta property="og:type" content="website">
<meta property="og:url" content="https://sebabru.com/PAGINA">
<meta property="og:title" content="...">
<meta property="og:description" content="...">
<meta property="og:image" content="https://sebabru.com/img/preview.webp">
<meta property="og:site_name" content="Seba Bru Astrología">
```

`preview.webp` es el fallback. Si la página tiene imagen propia y al tema, va
esa. Lo que **no** va más es `img/portada.webp`: es la placa del libro Luna
Negra y estuvo de fallback en 210 páginas hasta el 21/11/2026.

Si la página lleva `twitter:image`, cambiarlo junto con `og:image`: es la otra
mitad del mismo preview y se olvida fácil. Y ojo con reemplazar el nombre del
archivo a ciegas: la home usa `img/portada.webp` como `<img>` de verdad, que ahí
sí corresponde.

El fallback también está escrito en los generadores, en
`C:\dev\herramientas-sebabru`: `paginas-textos.js` (las 196 de `/carta-natal/`)
y `kit-paginas.js`. Cambiar solo el HTML deja que la próxima regeneración lo
pise.
