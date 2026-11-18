# Plan de SEO y velocidad de sebabru.com

**Actualizado: 18/11/2026.** Reemplaza la version del 17/11 y la auditoria
`AUDITORIA-SEO.md` del 13/11, las dos vencidas.

Para quien lo continue en otra sesion: todo lo que esta abajo se midio, no se
dedujo. Las reglas de trabajo estan al final y **conviene leerlas antes de
tocar nada**.

---

## 1. Donde estamos hoy, medido

### Core Web Vitals reales (CrUX, personas de verdad)

Primera linea de base del sitio. Sale de PageSpeed con la clave. Hoy solo hay
datos **a nivel de todo el sitio**: ninguna URL sola junta trafico suficiente.

| Metrica | p75 | |
|---|---|---|
| LCP | 4,03 s | **LENTO** |
| FCP | 4,22 s | **LENTO** |
| TTFB | 1,72 s | regular |
| INP | 241 ms | regular |
| CLS | 0 | rapido |

CrUX es una ventana movil de 28 dias: lo que arreglamos hoy se va a ver recien
a mediados de diciembre. **Volver a medir el 16/12/2026.**

### Laboratorio (PageSpeed, movil)

| Pagina | Score | Peso | Nota |
|---|---|---|---|
| `/signos/aries/` | 89 | 0,73 MB | era 62 y 4,35 MB esta manana |
| `/carta-natal/*` | 96 | 0,20 MB | lo mas rapido del sitio |
| `/kit/` | 96 | — | |
| Home | 67 | 1,65 MB | **el numero no es comparable, ver abajo** |

**La home no se puede medir con Lighthouse.** Lighthouse no scrollea, y el
contenido de la home *es* un recorrido por scroll: mide la primera pantalla y
corta. Por eso le da 0 bytes de Instagram y no ve el Spotify que si carga mas
abajo. Sirve para una sola cosa: contar los bytes propios. Para la experiencia
real, usar CrUX.

### Estructura

| | |
|---|---|
| Paginas en el sitemap | 237 |
| `/carta-natal/` | 196 paginas generadas; 51 por debajo de 9 KB |
| `/signos/` | 9 de 12 (faltan capricornio, acuario, piscis) |
| `meta description` | 210 de 235 (25 esperan texto de Seba) |
| JSON-LD | home, `/libros/`, las 8 aulas de `/escuela/abierta/`, las 196 de `/carta-natal/` |
| Falta JSON-LD | `/programa/` (Course) |

---

## 2. Como se reparten los textos (ya resuelto, no rehacer)

**Un texto se escribe una vez, en Firestore. Vive en HTML en un solo lugar. A
todos los demas llega por `fetch`.**

```
Firestore (carta_textos)
    -> paginas-textos.js  (C:\dev\herramientas-sebabru)
        -> /carta-natal/PUNTO/SIGNO/    196 paginas HTML  <- LA UNICA que Google ve
        -> /textos/signos/<id>.json     204, los acordeones de /signos/
        -> /textos/<id>.json             37, la calculadora de /cartas/
```

`/textos/` esta en `Disallow` en `robots.txt`. Googlebot no puede bajar esos
JSON, asi que no existe una segunda copia con la cual competir. Eso es lo que
evita que `/signos/aries/` y `/carta-natal/sol/aries/` peleen por la misma
consulta.

El precio, deliberado: esos textos **no suman SEO** en `/signos/` ni en
`/cartas/`. Suman en `/carta-natal/`. Si el export de Search Console de
diciembre dice que las hojas de ~316 palabras son demasiado finas para rankear
solas, la jugada opuesta esta anotada en `PLAN-RULETA.md`.

Despues de correr `paginas-textos.js` hay que **pushear a `main`**: el
generador escribe archivos, no deploya.

---

## 3. Corto plazo — diciembre 2026 a febrero 2027

Objetivo: **medir de verdad y dejar de perder**. Meta: 300-500 clics/mes y que
al menos un tercio de las consultas no sean el nombre de Seba.

### Lo que depende de Seba

| Cuando | Que |
|---|---|
| Esta semana | Confirmar en Search Console que el `sitemap.xml` esta **enviado**, no solo publicado |
| Esta semana | Exportar los ultimos 3 meses de Rendimiento a CSV, a `C:\dev\scratch` |
| Esta semana | Mirar Indexacion -> Paginas: cuantas de las 196 de `/carta-natal/` entraron |
| Diciembre | Los 25 textos de `bajada` que faltan |
| Diciembre | Decidir Instagram en la home (ver punto 6) |
| Enero | Los 51 textos finos de `/carta-natal/` |
| Enero | Capricornio, acuario y piscis en `/signos/` |
| Febrero | Las 12 descripciones de punto |

### Lo que es trabajo de Claude, sin bloqueos

1. `Course` en JSON-LD en `/programa/`.
2. Font Awesome: **289 KB de webfonts y CSS desde cdnjs** por un punado de
   iconos de marca. Pasarlos a SVG en linea. Esta en todas las paginas de
   `/signos/`, donde ahora es el peso mas grande que queda.
3. Spotify en la home: **1,1 MB** que si cargan cuando la persona recorre.
   Mirar si ese embed quedo sin facade.
4. Subir `s-maxage` de 3600 a 86400 una vez confirmado que no hay contenido
   viejo (el purgado ya esta probado, ver 18/11).
5. La salida `punto-<slug>.json` del generador, para la ruleta. Paso 1 de
   `PLAN-RULETA.md`: genera archivos que todavia nadie lee, no rompe nada.

### 16/12/2026 — revision

Volver a medir CrUX y comparar contra la tabla de arriba. Es la primera vez que
se va a poder decir si algo de esto sirvio.

---

## 4. Mediano plazo — marzo a agosto 2027

Objetivo: **que el organico alimente la lista**. Meta: 1.500-2.500 clics/mes y
80-150 altas de Brevo por mes atribuibles a organico en GA4.

1. `/signos/` completo y enlazado con `/carta-natal/` en los dos sentidos.
2. **La calculadora como iman de enlaces.** `/cartas/` es lo unico del sitio
   que otra gente linkearia sin que se lo pidan, y hoy no tiene pagina de
   presentacion orientada a busqueda ("calcular carta natal gratis", "carta
   natal online Argentina") ni `WebApplication` schema. Es la pieza de mayor
   retorno por esfuerzo de todo el plan. Ojo: `/cartas/` **no vive en este
   repo**, sale de `C:\dev\tucarta`.
3. **Rescatar `/lunanueva/` y `/lunallena/`**, que hoy se pisan cada lunacion y
   tiran el contenido. Dos caminos, hay que elegir uno:
   - URLs con fecha (`/lunanueva/escorpio-noviembre-2026/`) mas una URL madre
     evergreen. Acumula contenido, pide cambiar el flujo que Seba ya tiene
     aceitado.
   - Mantener la URL evergreen con `Article` schema, `dateModified`, el signo y
     el mes en el `<title>`, y un archivo de las anteriores. Mas barato.
4. La ruleta de `/carta-natal/`, si el export de diciembre dice que conviene.
5. Entre 15 y 25 dominios distintos enlazando al sitio.

---

## 5. Largo plazo — septiembre 2027 en adelante

Objetivo: **que la lista venda las formaciones**. Meta: 4.000+ clics/mes y un
numero de inscripciones por ciclo atribuible al organico.

Ser el resultado de referencia en Argentina para "formacion en astrologia",
"curso de astrologia online" y "consulta de carta natal", que son las consultas
que valen plata.

Autoridad, que es lo mas lento y lo que mas pesa. Nada de esto se compra:

1. **Google Business Profile** para las consultas en Argentina.
2. **El podcast Kit** dejando enlace al sitio desde Spotify y YouTube.
3. **`/escuela/egresadxs/`**: cada egresadx que ejerce y tiene sitio propio es
   un enlace natural. Pedirlo, no comprarlo.
4. La calculadora en comunidades de astrologia en castellano.
5. Medios argentinos en las fechas en que la astrologia es noticia.

### Publicidad

1. **Ahora, nada de SEM informacional.** Pagar por "sol en aries" es quemar
   plata: esa gente no compra una formacion de 4 anios.
2. Sin GA4 midiendo hasta la inscripcion, cualquier gasto es a ciegas.
3. Cuando haya medicion: **Meta/Instagram de remarketing solo en las 3-4
   semanas de cada ventana de inscripcion**, a quien ya visito `/programa/` o
   `/escuela/abierta/*`. Orden de magnitud: USD 150-250/mes, no todo el anio.
4. Google Ads de marca solo si alguien le compite "Seba Bru". Verificar antes
   de gastar un peso.
5. El mejor presupuesto publicitario de este sitio es **YouTube**, que ya
   existe y es gratis.

---

## 6. Decisiones abiertas

| Que | Estado |
|---|---|
| Instagram en la home | Seba aprobo la grilla de 6 posteos autoactualizada. **Falta construirla.** |
| Lunaciones | Sin decidir: URLs con fecha o evergreen con `dateModified` |
| Ruleta | Plan escrito en `PLAN-RULETA.md`, sin publicar, Seba lo revisa offline |
| Medir el recorrido de la home | Propuesto: `web-vitals` mandando LCP e INP a GA4 por pagina. Es la unica forma de saber que paga alguien que recorre la home entera. |

### La grilla de Instagram, especificada

`sync-instagram.mjs` ya renueva el token y pide el ultimo posteo. Cambiar a:

```
fields=permalink,media_url,thumbnail_url,media_type   limit=6
```

La Action baja las 6 imagenes, las achica a webp en `public/img/ig/1..6.webp`
(~25 KB cada una) y en la pagina van en grilla de 3x2, **cada celda un link a
su propio posteo**. Seis archivos y no una imagen compuesta: cada celda clickea
a su posteo y el navegador las cachea por separado.

Las URLs que devuelve la API de Instagram vencen, asi que las imagenes hay que
bajarlas y servirlas desde el sitio. El token vive solo como secreto en GitHub:
no se puede probar localmente, la primera corrida de verdad es en la Action.

---

## 7. Que se hizo el 18/11/2026

- Los 8 (hoy 9) `/signos/` sin el video vertical. De paso se fue el bug de
  `/signos/cancer/`, que mostraba el video de geminis.
- La calculadora de carta natal adentro del desplegable "Si no sabes que tenes
  en SIGNO", con `calc-lunacion.js` generalizado.
- Embeds de YouTube y Spotify con facade y miniatura, en la home, `/kit/` y
  `/signos/`. Las miniaturas las renueva una Action los martes al mediodia.
- El mp4 de las formaciones (427 KB) sale de la carga inicial de la home y de
  `/programa/`: `preload="none"` + poster generado con ffmpeg.
- **`NO_LCP` de la home resuelto.** Todo el contenido vivia adentro de un
  `.bloque` con `opacity: 0`, asi que Chrome no tenia ni un candidato a LCP.
  `.bloque--intro` arranca visible. Score 0 -> 67.
- **Embed de Instagram sacado de `/signos/aries/`**, que no era parte del
  diseno y estaba solo en esa pagina: 3,8 MB de 4,35. Score 62 -> 89.
- **TTFB:** la regla `**` daba `max-age=300` tambien a la CDN. Ahora el borde
  guarda una hora (`s-maxage=3600`) con `stale-while-revalidate`. Purgado en
  deploy confirmado: la cabecera nueva aparecio en 75 s.

---

## 8. Reglas de trabajo — leer antes de tocar nada

1. **Medi, no deduzcas, y pone un control.** Una prueba sin control no mide lo
   que parece. Hoy paso tres veces: una hipotesis refutada, una medicion
   ruidosa y un numero mal clasificado.
2. **Un 200 no prueba un deploy.** Buscar contenido nuevo en la respuesta.
3. **Nunca `git add -A`.** Hay varias sesiones escribiendo este repo a la vez.
   Commitear por ruta. Ya paso que un `add -A` se llevo archivos de otra
   sesion.
4. **El deploy es solo por push a `main`.** Un `firebase deploy` a mano publica
   el sitio sin `/cartas/` y se revierte en el proximo push.
5. **Comillas curvas.** Rompen todos los `class=` y `style=`. Verificar con
   grep antes de pushear.
6. **Las 196 paginas de `/carta-natal/` y los JSON de `/textos/` no se editan a
   mano**: los genera `paginas-textos.js`.
7. **`npm install` adentro del proyecto lo corrompe Google Drive.** Trabajo
   pesado en `C:\dev\scratch`.
8. **Versionar al tocar CSS o JS compartido.** `firebase.json` los cachea 30
   dias: sin bump del `?v=`, el cambio no llega.
9. **Nunca inventar ni rellenar texto de contenido.** Los textos los escribe
   Seba.
