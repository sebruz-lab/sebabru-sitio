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
  `upsertContacto` ni bienvenida en línea. **Si falta `BREVO_DOI_TEMPLATE_ID`
  ese carril falla cerrado**, porque un carril degradado sin su único control
  es un endpoint abierto.
- **El ebook queda fuera del carril con confirmación**, y hay que acordarse de
  por qué: la rama `if (pedido.doi)` del trigger ignora `pedido.plantilla`, así
  que un alta del libro por ahí confirmaría la suscripción y nunca entregaría
  el libro. Es el mismo bug que ya pasó y se arregló el 2026-11-18.
- **PENDIENTE (pedido de Seba, 21/11/2026): que el mail de confirmación lleve
  contenido propio** y cuente como un correo con valor, no como un trámite de
  un clic. Hoy es la plantilla DOI pelada de Brevo. Cuando se haga, el ebook
  puede volver al carril (su plantilla de confirmación llevaría el libro) y
  `plantillaDeAlta()` necesita su equivalente para el DOI.
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
- Anual y semestral **se distinguen solo por color**; el mensual muestra
  cuántas cuotas van pagas y cuáles faltan con su mes (pedido de Seba,
  24/11/2026).
- **PENDIENTE (etapa 2):** el 10% a Clari, el cobro en línea con Mercado Pago y
  PayPal, y la importación de las ~100 filas de 2026 con verificación contra el
  BALANCE GENERAL. Dos cosas ya medidas que van a aparecer ahí: **TERCER AÑO
  tiene $255.000 de diferencia** entre la suma de sus pagos ($1.175.000) y lo
  que declara el BALANCE GENERAL ($920.000), y en Primer Año las columnas de
  meses no suman al `PAGO` en 8 de 26 filas.

## El panel de la escuela

- **Cinco grupos, no once pestañas** (reorganizado el 24/11/2026):
  **Gestión de alumnos** (el padrón, antes "Inscripciones"), **Usuarios**
  (buscar + todos), **Acceso a las aulas** (invitaciones, descuentos, migrar
  acceso, enlace maestro), **Contenidos** (videos del curso arriba, Tu carta
  abajo) y **Pendientes** (pendientes + compras). Cada grupo es un
  `.tab-panel`; los paneles viejos quedaron adentro como `.card` sueltas, así
  que mover una tarjeta de grupo es cortar y pegar.
- **El panel no tiene tope de ancho** (se sacó el `max-width: 900px` de
  `.tab-panel` el 25/11/2026): la planilla del padrón es la tabla más ancha del
  sitio. Lo que sí lleva medida es el texto largo — `.card > p`, los `textarea`
  y los párrafos de los ajustes —, porque una línea de prosa cruzando 2500 px
  no se lee. Las tablas quedan afuera de esa regla a propósito.
- **Varias tarjetas cargan sus datos recién al hacer clic en la pestaña.** Por
  eso, después de que la sesión se valida, el panel hace
  `document.querySelector('.tab-btn.active')?.click()`: la pestaña que ya viene
  abierta nunca recibiría ese clic y se vería vacía.
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
- **`gravedad: 'grave'`** para plata cobrada o configuración nuestra rota: sale
  un mail al toque a `AVISOS_INSCRIPCION`, con la ventana anti-repetición de
  `avisos/{motivo}`. Con `avisarSiempre: true` no se agrupa — es lo que
  corresponde cuando hay plata, porque dos pagos sin entregar son dos
  problemas. **`'normal'`** entra en el resumen diario de `revisarPendientes`.
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

Dos cosas que conviene recordar porque no son obvias:

- **Un `logger.error` no le avisa a nadie.** Hay más de 80 en `index.js` y no
  existe ninguna alerta configurada sobre los logs. Toda alarma sale por
  `mails.encolarMail`, nunca por Brevo y nunca confiando en el log.
- **`envios_carta` y `envios_titulo` corren sin `retry`.** Un fallo deja el
  documento con `enviado: null`; eso ahora lo levanta `revisarPendientes`, que
  es el único barrido de colas que existe.

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
