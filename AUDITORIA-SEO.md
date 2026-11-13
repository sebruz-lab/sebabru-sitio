# Auditoría de SEO y metadata — sebabru.com

Relevamiento del 2026-11-13 sobre las 62 páginas de `public/`. Este archivo es **solo el frente de SEO**: la seguridad, la usabilidad y el diseño se trabajan aparte.

Todo lo que sigue está verificado contra los archivos o contra el sitio en vivo. Donde dice "verificado en vivo" es con `curl` contra sebabru.com.

---

## Lo urgente

### 1. La home no tiene ni un solo meta OG
`public/index.html` — **cero coincidencias de `og:`** (verificado). El `<head>` tiene charset, viewport, title, description, preloads y favicon, y nada más.

Consecuencia concreta: cuando alguien comparte `sebabru.com` por WhatsApp, Instagram o Telegram, **no aparece ni imagen ni descripción**. Es la página más compartida del sitio.

Incumple la regla explícita del `CLAUDE.md` del repo, que pide estos 6 en toda página:

```html
<meta property="og:type" content="website">
<meta property="og:url" content="https://sebabru.com/">
<meta property="og:title" content="...">
<meta property="og:description" content="...">
<meta property="og:image" content="https://sebabru.com/img/portada.webp">
<meta property="og:site_name" content="Seba Bru Astrología">
```

### 2. No existe `robots.txt` ni `sitemap.xml`
Los dos devuelven **404 en vivo** (verificado). 62 páginas sin mapa para los buscadores.

Para el sitemap conviene generarlo en el workflow de deploy (`.github/workflows/firebase-hosting-merge.yml`) y no a mano, porque las páginas cambian. Ojo con un detalle: `public/cartas/` **no está en el repo**, se baja en el deploy desde `sebruz-lab/tucarta` (ver `.gitignore` y `tucarta.version`), así que un generador que recorra `public/` localmente no la va a ver y hay que agregarla a mano.

### 3. Cero `rel="canonical"` en todo el sitio
Ninguna de las 62 páginas lo tiene. Importa sobre todo donde hay contenido duplicado o casi duplicado (ver punto 6).

---

## Cobertura de metadata

| Ítem | Estado |
|---|---|
| `lang="es"` | 62 de 62 OK |
| `<title>` | 62 de 62 OK |
| `meta description` | **8 de 62** |
| Los 6 OG completos | **25 de 62** |
| `rel="canonical"` | **0 de 62** |
| Twitter Cards | **0 de 62** |
| favicon | 61 de 62 (falta en `public/Mey/index.html`) |
| 404 personalizada | OK, `public/404.html`, bien hecha (menú, footer, h1, CTA) |

**Sin OG, por orden de importancia comercial:** la home, `/kit/`, `/libros/`, `/programa/`, `/escuela/index.html`, los 8 cursos de `/escuela/abierta/*`, los 12 cursos sincrónicos, `/lilith/pedido/`, `/consultas/formulario.html`.

Las que sí cumplen están bien hechas y sirven de modelo: `public/signos/virgo/index.html`, `public/suscribirse/index.html`, `public/privacidad/index.html`.

**Sin `meta description`:** priorizar las de tráfico orgánico — los 9 signos, `/programa/`, `/libros/`, `/formaciones/`.

---

## 4. Páginas que no deberían estar indexadas y lo están

Solo 4 páginas tienen `noindex`: `/canjear/`, `/consultas/formulario.html`, `/escuela/cuenta/` y `/lilith/prototipo-3d.html`.

**Les falta a:**
- `public/escuela/admin/index.html` — el panel de administración (78,7 KB)
- `public/escuela/invitacion/index.html`
- `public/escuela/sin-acceso/index.html`
- `public/escuela/abierta/gracias.html` — página de retorno de pago
- **Cuatro prototipos publicados en producción:** `public/preview-bloques.html` ("Preview — Instagram embed"), `public/prueba-contenido.html` ("Prueba Contenidos Cinemáticos"), `public/escuela/abierta/test-descripcion.html` ("Prototipo — Descripción de cursos"). El `prototipo-3d.html` es el único de los cuatro que sí lo tiene.

Para los prototipos la pregunta de fondo no es el `noindex` sino **por qué están en el deploy**. Lo más limpio es sacarlos.

---

## 5. `public/Mey/`
Es un microsite de otra persona ("meydibuja", libros ilustrados) colgando del dominio. 2,7 KB, sin favicon, sin OG, y **ningún link del sitio apunta ahí**. Decisión a tomar: si tiene que estar, que tenga metadata propia; si no, sacarlo.

---

## 6. Contenido duplicado y títulos repetidos

- **`/formaciones/` duplica `/#formaciones`.** La landing `public/formaciones/index.html` son 24,9 KB de contenido, pero el menú de las 26 páginas manda siempre a `/#formaciones` (un ancla de la home, que existe y funciona). **Ningún link del sitio apunta a `/formaciones/`.** Son dos versiones del mismo contenido compitiendo, y la de verdad no la ve nadie. Hay que decidir cuál es la canónica.
- **Mismo `<title>` en dos páginas distintas:** `public/escuela/abierta/pluton26/index.html` y `public/escuela/pluton/index.html` son las dos "Plutón y los Nodos Lunares | Aula Virtual". Son cursos distintos (uno de cursada regular, otro de la escuela abierta).
- **Otras huérfanas con contenido real:** `/kit/` (22,4 KB, lead magnet, la home tiene un `<h2>Kit astrológico` pero no linkea a la página) y `/linaje/` (10,5 KB; la home linkea `/#seminario-linaje` y `/escuela/abierta/linaje/`, nunca `/linaje/`).

---

## 7. Marca inconsistente
Convive **"Seba Bru Astrología"** con tilde y **"Seba Bru Astrologia"** sin tilde en `og:site_name`, títulos y descripciones. Sin tilde en: `404.html`, `escuela/certificados/`, `formaciones/`, `signos/escorpio/`, `signos/libra/`. También aparece "astrologia", "mas alla", "Aqui esta" en textos de metadata — parece escrito sin acentos a propósito, por miedo a problemas de encoding (que hoy no existen: todas las páginas declaran UTF-8).

Hay que elegir una forma y unificar. La del `CLAUDE.md` es **con** tilde.

---

## 8. Los signos: la oportunidad orgánica desaprovechada
`public/signos/` tiene el índice más 8 signos publicados: aries (82 KB), tauro (79), géminis (77), cáncer (68), leo (77), virgo (94), libra (82), escorpio (87).

**Faltan sagitario, capricornio, acuario y piscis.** El índice promete 12 y entrega 8.

Son las páginas de tráfico orgánico más puro del sitio (contenido largo, búsqueda informacional constante) y ninguna tiene `meta description`. Nota para cruzar con el otro frente: tampoco tienen CTA de venta ni captura de mail, y ninguna linkea a otro signo — son hojas sin navegación lateral.

---

## 9. Un link roto de verdad
`public/escuela/index.html:167` tiene una tarjeta con `data-url="transitos/index.html"` y **`public/escuela/transitos/` está vacía**. Quien tenga ese curso habilitado va a un 404.

Aclaración sobre un falso positivo: `/cartas/` aparece linkeado 27 veces y la carpeta no está en el repo, pero **no es un link roto** — se baja en el deploy desde `sebruz-lab/tucarta` (versión fijada en `tucarta.version`, hoy `v1.19.1`). Solo rompe el preview local con `firebase serve`.

---

## 10. Redirects
Los 6 de `firebase.json` están bien, son todos estáticos y sin parámetros: `/tucarta` a `/cartas`, `/identidad-astral` a `/tu-identidad-en-el-cielo`, `/escuela/abierta-test` a `/escuela/abierta`, entre otros. No hay open redirect.

---

## Dónde puede haber choque con el otro frente de trabajo

En paralelo se están tocando seguridad, usabilidad y diseño. Dos puntos de esta lista pisan los mismos archivos:

1. **El `noindex` de los 4 prototipos** y la eventual decisión de sacarlos del deploy.
2. **La unificación de `og:site_name`**, que toca `404.html`, `certificados/`, `formaciones/` y dos signos.

Conviene coordinar antes de deployar.

Y dos cosas del repo que conviene saber antes de tocar cualquier HTML:
- **Nunca usar comillas tipográficas** en HTML: rompen todos los atributos `class=` y `style=`. Antes de deployar, verificar que no haya bytes `e2 80 9c` / `e2 80 9d` en los archivos editados.
- **El deploy va siempre con commit y push a `main`.** Un `firebase deploy` manual se revierte en el próximo push y además publica el sitio **sin `/cartas/`**.
