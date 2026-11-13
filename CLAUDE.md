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
- Las herramientas de listas, migración y campañas están en `C:\dev\herramientas-sebabru` (ver `BREVO.md` ahí).

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
