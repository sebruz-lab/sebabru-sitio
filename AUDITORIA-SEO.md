# Auditoria de SEO de sebabru.com

Estado al **16/11/2026**. Reemplaza al relevamiento del 13/11, que quedo
vencido: sus tres puntos urgentes (OG en la home, robots.txt, sitemap.xml,
canonical) estan los tres hechos y verificados en vivo.

Todo lo que sigue esta medido contra los archivos o contra el sitio en vivo
con `curl`, no deducido.

---

## Lo que ya esta

| Que | Estado |
|---|---|
| `robots.txt` y `sitemap.xml` | En vivo, 237 URLs, generado en el deploy |
| `<lastmod>` en el sitemap | Si, de la fecha del ultimo commit de cada archivo |
| `rel="canonical"` | Todas las paginas indexables |
| Los 6 OG | 208 de 234 paginas indexables |
| JSON-LD | `Article` en las 196 de `/carta-natal/`, `Person`+`Organization`+`WebSite` en la home, `Course` en los 8 cursos, `Book` en `/libros/` |
| Chequeo automatico | `chequearMetadatos()` en `.github/chequeo/chequeo.mjs`: una pagina nueva sin metadata rompe el build |
| Prototipos | Fuera del deploy (`firebase.json` -> `hosting.ignore`) |

---

## Lo que falta, y de quien es

### De Seba: los textos

1. **Las 26 bajadas que faltan en `/carta-natal/`.** Los indices de los
   puntos y las 12 casas salen sin `meta description` y sin
   `og:description` porque la bajada esta vacia. No se arreglan editando el
   HTML: las paginas son generadas. Se escriben en `paginas-textos.js`
   (`bajada: ''`) en `C:\dev\herramientas-sebabru` y se regenera con
   `node paginas-textos.js --sitio "g:\Mi unidad\Seba Bru\SITIO" --confirmar`.
   El chequeo diario las lista una por una.

2. **Los 51 textos finos.** De las 195 hojas de `/carta-natal/`, 51 estan
   por debajo de 9 KB, que con las plantillas son unas 300 palabras. Una
   pagina de 300 palabras no compite contra nada. Es la prioridad numero
   uno de contenido.

3. **`/signos/` promete 12 y entrega 8.** Faltan sagitario, capricornio,
   acuario y piscis.

4. **`/sobre-mi/` no existe.** Hoy la unica biografia es el ancla `#bios`
   de la home. Una pagina de autor propia, enlazada desde el pie de todo el
   sitio y con `Person` schema, es la senal de E-E-A-T mas barata que hay, y
   es exactamente lo que los sitios programaticos de astrologia generados
   con IA no pueden tener. El texto lo escribe Seba.

### Decisiones pendientes (no son trabajo, es elegir)

1. **`/escuela/` (el hub de las aulas).** Tiene formulario de ingreso y
   `h1 FORMACIONES`. Es una pagina de login: o va a `noindex`, o se le pone
   metadata propia. Hoy no tiene ninguna de las dos y el chequeo lo avisa.

2. **`/formaciones/` duplica `/#formaciones`.** 24,9 KB de contenido con
   **cero** enlaces entrantes: ninguna pagina del sitio la enlaza. Hay que
   elegir cual es la canonica y redirigir la otra con un 301.

3. **`/Mey/`** es un microsite de otra persona colgado del dominio, sin
   enlaces entrantes y sin metadata. Si se queda, necesita metadata propia;
   si no, se saca.

4. **`/lunanueva/` y `/lunallena/` se pisan cada lunacion.** El contenido
   anterior se tira. "Luna nueva en escorpio" es una consulta de volumen
   alto y recurrente en Argentina. Dos caminos: URLs con fecha mas una URL
   madre evergreen, o mantener la URL unica pero con `Article` schema,
   `dateModified` y el signo y el mes en el `<title>`. En los dos casos
   falta `dateModified`, que hoy no esta.

### Lo que no se pudo medir todavia

**Core Web Vitals: nunca se midieron.** La API de PageSpeed contesta
`Quota exceeded` sin clave (verificado el 16/11, y el control con otra URL
tambien falla, asi que es la cuota y no la URL). Hace falta una clave de API
gratuita del proyecto `sebabru-e5563`.

Tampoco hay linea de base de indexacion: no sabemos cuantas de las 196
paginas de `/carta-natal/` entraron a Google. Sale de Search Console, en el
informe de Cobertura.

---

## Detalles menores, anotados y no arreglados

- Las redirecciones viejas dan **dos saltos** en vez de uno:
  `/sol/acuario/` -> `/carta-natal/sol/acuario` -> `/carta-natal/sol/acuario/`.
  Google sigue hasta 10, asi que no urge, pero se arregla poniendo la barra
  final en el `destination` de `firebase.json`.
- `public/sol/acuario/` existe en el disco local y da `Permission denied`
  (cosa de Google Drive). **No esta en git**, asi que no se deploya y las
  redirecciones en vivo funcionan bien. No hay que borrarlo a las apuradas.
- `paginas-textos.js` en `C:\dev\herramientas-sebabru` **no esta bajo git**:
  el cambio del pie que suma `/programa/` vive solo en ese disco.
