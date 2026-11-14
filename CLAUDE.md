# Instrucciones para Claude

## REGLA CRÍTICA: Comillas en HTML

**NUNCA usar comillas tipográficas** (`"` `"` U+201C/U+201D) en archivos HTML. Siempre usar comillas ASCII rectas (`"` 0x22).

Las comillas curvas rompen todos los atributos `class=` y `style=` porque el browser no las reconoce como delimitadores de atributos HTML. Los CSS classes dejan de aplicar y el layout se rompe completamente — es un bug muy difícil de diagnosticar visualmente.

Antes de deployar cualquier edición de HTML, si hay dudas: verificar con PowerShell que no haya bytes `e2 80 9d` o `e2 80 9c` en el archivo.

## Proyecto

- Sitio estático en Firebase Hosting (sebabru-e5563)
- Deploy: `firebase deploy --only hosting` desde `g:\Mi unidad\Seba Bru\SITIO`
- Archivos en `public/`
- Imágenes en `public/img/` — deben estar descargadas de Google Drive antes de deployar

## Mailing (Brevo)

- Cliente de la API: `functions/brevo.js` (fetch nativo, sin SDK). Hay una copia en `C:\dev\herramientas-sebabru\brevo.js`: si cambia uno, copiar al otro.
- **Un fallo de Brevo nunca puede romper una compra ni una inscripción.** Las altas se encolan en la colección `brevo_contactos` de Firestore y las procesa el trigger `sincronizarContactoBrevo`. No llamar a Brevo en línea desde un `onRequest`: la instancia se congela después del `res.send()`.
- El único que llama en línea es `exports.suscribir`, porque ahí Brevo es el flujo. Si falla, encola el alta y contesta que el mail va a demorar.
- **La suscripción es de un solo paso** (decisión de Seba, 2026-11-12): se da de alta directo y sale un mail de bienvenida. Lo que reemplaza al doble opt-in para evitar rebotes es `dominioRecibeCorreo()`, que verifica los MX del dominio antes de dar el alta; más el captcha desde el primer envío, la trampa para bots y la detección de typos. El mail de bienvenida lleva el enlace de baja bien visible, porque es el primer aviso que recibe quien no se anotó (ver el punto de la baja, más abajo). `pedirDobleOptin()` sigue en `brevo.js` por si se vuelve atrás.
- Mientras `BREVO_API_KEY` esté vacía en `functions/.env`, todo el mailing es un no-op que loguea un warning. **Pero `suscribir` contesta 503 `no_configurado` a propósito**: nunca decirle a alguien que revise su casilla si el mail no va a salir.
- Los transaccionales (confirmaciones, accesos, la carta en PDF) **siguen en nodemailer/Gmail**, no en Brevo. El plan gratis tiene 300 mails por día compartidos: una newsletter grande dejaría sin mail a quien acaba de comprar.
- El regalo del ebook (`/ebook/`) es una suscripcion con `origen: "ebook"`. `plantillaDeAlta()` hace que ese alta reciba la plantilla del libro (`BREVO_EBOOK_TEMPLATE_ID`, id 4) en lugar de la de bienvenida: esa persona no vino a suscribirse, vino por el libro. **El enlace al ebook esta solo en esa plantilla**, no en la pagina: es lo que hace que el regalo valga como alta.
- **La baja la hacemos nosotros, y el enlace sale de un param.** `{{ unsubscribe }}` es un tag de **campañas**: en un transaccional por `/smtp/email` Brevo no lo sustituye y el href queda vacío (comprobado el 2026-11-13 con el tag puesto dos veces en cada plantilla). Lo que sí funciona en un transaccional son los `params`, así que `urlDeBaja()` firma la URL con `BAJA_SECRET` y la plantilla pone `{{ params.baja }}`. Las plantillas de **campaña** (`sumate.html`, `lunacion.html`) sí usan `{{ unsubscribe }}`: ahí es el mecanismo correcto. No confundirlas.
- `exports.baja` bloquea el contacto en Brevo (`emailBlacklisted`, que es la marca que sobrevive a una reimportación futura) y apaga `novedades` en `usuarios` y `tucarta_usuarios`, para que Firestore no diga lo contrario que Brevo. **La pide `/baja/` con un POST desde JavaScript, no el enlace del mail**: Gmail pre-carga los enlaces para analizarlos, y un GET daría de baja a quien nunca lo tocó.
- Orden de deploy: primero las functions y la configuración de Brevo, después el frontend. Al revés, el formulario queda publicado contra un endpoint que no existe.
- Las herramientas de listas, migración y campañas están en `C:\dev\herramientas-sebabru` (ver `BREVO.md` ahí). En esa misma carpeta viven las demás herramientas de admin, que no son de Brevo y no están documentadas en ningún otro lado: `certificados.js` (los 4 certificados viejos), `titulos.js` (el padrón de los títulos nuevos), `videos.js`, `textos.js`, `paginas-textos.js` y `libro.js`.

## Títulos de egreso

- La persona lo emite sola desde `/escuela/certificados/` con su sesión de la escuela: completa cómo va escrito su nombre, el DNI y sus pronombres, lo ve en una vista previa y confirma. El PDF se arma, se descarga y le llega por mail.
- **El PDF no se guarda en ningún lado.** Es determinístico a partir del registro de `titulos` en Firestore, así que `descargarTitulo` lo regenera cada vez. Eso evita que un PDF con el DNI impreso quede en reposo en una URL, y evita Cloud Storage.
- La plantilla imprimible es `public/escuela/titulo/hoja.html`: recibe los datos en el fragmento (`#hoja=<base64url>`), igual que `/cartas/`, y tiene que dejar `window.hojaLista` o `window.hojaError`. **El fragmento no viaja al servidor**: por eso el DNI no queda en los logs de acceso. Necesita `firma.png` al lado; si falta, la hoja la oculta y el título sale igual.
- Dos plantillas en el mismo archivo (`plantilla: 'curso'` y `'formacion'`), que es lo único que cambia entre un año suelto y los cuatro años.
- Quién puede emitir sale de dos lugares, y alcanza con uno: el aula habilitada en `usuarios/{mail}.cursos` (para un año suelto), o el padrón `titulos_habilitados/{mail}` que carga `node titulos.js --habilitar` en `C:\dev\herramientas-sebabru` (para la formación de 4 años, que no se corresponde con ninguna aula). Una formación con `porPadron` **ignora las aulas a propósito**: tener un aula de tercero no prueba haber terminado cuarto.
- El número (`SB-2026-0001`) es lo que hace válido al título, no el PDF: la hoja es pública y cualquiera puede armarse un fragmento y ver un diploma inventado en pantalla. Lo que no puede falsificar es el número, que `/titulo/` verifica contra Firestore.
- La URL de verificación lleva número **y** un código HMAC de `TITULO_SECRET`. Sin el código, los números son correlativos y `/titulo/` sería un padrón de egresadxs recorrible de a uno. **Si se cambia el secreto, los códigos ya impresos en los PDF dejan de validar.**
- Emitir dos veces no genera dos títulos: corrige el que hay, con el mismo número, hasta tres veces. Es lo que resuelve el soporte más probable (un nombre mal tipeado).
- El mail con el adjunto sale por el trigger `enviarTitulo`, con nodemailer directo y 2 GiB. **No va por `mails_salientes`**: el PDF pasa el tope de 700 KiB de esa cola. Mismo arreglo que la carta natal de las inscripciones.
- Los 4 certificados viejos (hechos a mano, PDF aplanados en `functions/certificados/`) siguen saliendo por `descargarCertificado`. Esa rama no se tocó.

## OG Tags

Toda página nueva debe incluir estos 6 meta OG en el `<head>`:
```html
<meta property="og:type" content="website">
<meta property="og:url" content="https://sebabru.com/PAGINA">
<meta property="og:title" content="...">
<meta property="og:description" content="...">
<meta property="og:image" content="https://sebabru.com/img/IMAGEN.webp">
<meta property="og:site_name" content="Seba Bru Astrología">
```
