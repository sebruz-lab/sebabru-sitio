# Plan de SEO con fechas — de noviembre 2026 a noviembre 2027

Arrancado el 17/11/2026. El diagnostico esta en `AUDITORIA-SEO.md`; esto es el
calendario. Cada linea dice **quien** la hace. Lo que dice "Seba" nadie lo puede
hacer por el: es texto propio o es una credencial.

Objetivo que fijo Seba: **vender formaciones**, alimentadas por la lista de mail.
Prioridad geografica: **Argentina**.

---

## Diciembre 2026 — medir y terminar el texto

| Cuando | Que | Quien |
|---|---|---|
| Semana del 17/11 | Clave de API de PageSpeed (ver `#como-paso-la-clave`) | Seba |
| Semana del 17/11 | Confirmar que el `sitemap.xml` esta **enviado** en Search Console | Seba |
| Semana del 17/11 | Exporte de Search Console de los ultimos 3 meses | Seba |
| Semana del 24/11 | Primera medicion de Core Web Vitals (home, una de `/carta-natal/`, `/cartas/`) | Claude |
| Semana del 24/11 | Linea de base de indexacion: cuantas de las 196 entraron | Claude |
| A medida que lleguen | Las **25 bajadas** que faltan en `/carta-natal/` | Seba escribe, Claude carga |
| A medida que lleguen | Los **12 textos nuevos** (la descripcion de cada punto en su pagina) | Seba escribe, Claude carga |
| Diciembre | Los **51 textos finos** (menos de ~300 palabras) | Seba |
| Diciembre | `/signos/`: faltan sagitario, capricornio, acuario, piscis | Seba |
| Diciembre | Reestructurar `/lunanueva/` y `/lunallena/` (ver abajo) | Claude, con el OK de Seba |

**Meta de diciembre:** 300-500 clics/mes y que un tercio de las consultas no sea
el nombre de Seba.

---

## Enero - febrero 2027 — que las paginas trabajen

| Cuando | Que | Quien |
|---|---|---|
| Enero | `/cartas/`: pagina de presentacion orientada a busqueda + `WebApplication` schema | Claude (repo `tucarta`) |
| Enero | `/formaciones/` como la pagina canonica de "formacion en astrologia en Argentina" | Seba redacta, Claude estructura |
| Enero | `/consultas/` segmentada por tipo de consulta | Seba redacta |
| Febrero | Primera comparacion contra la linea de base de diciembre | Claude |
| Febrero | Arreglar lo que Core Web Vitals haya marcado en rojo | Claude |

---

## Marzo - agosto 2027 — autoridad

Sin enlaces de otros dominios, nada de lo anterior rankea fuera de la marca.
Nada de esto se compra.

| Cuando | Que | Quien |
|---|---|---|
| Marzo | Google Business Profile para las consultas en Argentina | Seba |
| Marzo en adelante | Cada episodio del Kit deja un enlace al sitio desde YouTube y Spotify | Seba (ya hay skill) |
| Abril | Pedirle el enlace a lxs egresadxs que ejercen y tienen sitio | Seba |
| Mayo | La calculadora en comunidades de astrologia en castellano | Seba |
| Junio-agosto | Fechas en que la astrologia es noticia: eclipses, Mercurio retrogrado | Seba + Claude |

**Meta de agosto:** 1.500-2.500 clics/mes y 80-150 altas de Brevo por mes desde
organico, medidas en GA4.

---

## Septiembre 2027 en adelante — que la lista venda

- Ser el resultado de referencia en Argentina para "formacion en astrologia",
  "curso de astrologia online" y "consulta de carta natal".
- **Recien aca tiene sentido gastar en publicidad**, porque recien aca se puede
  comparar el costo contra un numero de inscripciones. Antes es a ciegas.
- Cuando llegue: Meta/Instagram de remarketing a quien ya visito `/programa/` o
  `/escuela/abierta/*`, **solo en las 3-4 semanas de cada ventana de inscripcion**,
  orden de magnitud USD 150-250/mes. No todo el año, y no SEM informacional.

**Meta:** 4.000+ clics/mes y inscripciones atribuibles al organico.

---

## Las lunaciones

Hoy `/lunanueva/` y `/lunallena/` son dos URLs que se pisan cada lunacion: el
texto anterior se tira. Ademas el `<title>` dice "Luna Nueva" a secas, sin el
signo ni el mes, que es justo lo que la gente busca.

**No conviene una URL por lunacion con fecha.** Serian 24 paginas nuevas por año,
cada una viva tres semanas y muerta para siempre, y las de 2027 competirian
contra las de 2026 por la misma consulta.

**Conviene una URL por signo:** `/lunanueva/escorpio/`, `/lunallena/tauro/`.
Son 24 paginas en total, no 24 por año. "Luna nueva en escorpio" se busca todos
los años, asi que cada una acumula autoridad en vez de repartirla, y el texto
nuevo de cada año se suma arriba con el anterior abajo como archivo. `/lunanueva/`
queda como madre y muestra siempre la vigente.

Hace falta ademas `Article` schema con `datePublished` y `dateModified`, que hoy
no estan, y el signo y el mes en el `<title>`.

---

## Decisiones que ya tomo Seba (17/11/2026)

- **`/sobre-mi/` no se hace:** la bio vive en el sector de la home. Queda pendiente
  que ese bloque tenga su propio `Person` schema, que ya esta puesto en la home.
- **`/escuela/` se queda indexable**, con description y OG, que le faltaban.
  Ojo: su `<h1>` dice "FORMACIONES" y compite con `/formaciones/`. Si mas adelante
  Search Console muestra que Google elige la equivocada, se cambia el `<h1>`.
- **`/formaciones/` y `/#formaciones` conviven**: la home ofrece todo junto, la
  pagina desglosa lo que esta abierto ahora. No hay 301. Lo que faltaba era el
  enlace: `/formaciones/` no la enlazaba **ninguna** pagina del sitio.

---

## Como paso la clave

<a id="como-paso-la-clave"></a>

### 1. La clave de API de PageSpeed (10 minutos, gratis)

1. Entrar a <https://console.cloud.google.com/> con la cuenta de siempre y elegir
   arriba el proyecto **`sebabru-e5563`** (es el mismo de Firebase).
2. Buscador de arriba: **"PageSpeed Insights API"** → **Habilitar**.
3. Menu → **APIs y servicios** → **Credenciales** → **Crear credenciales** →
   **Clave de API**.
4. Click en **Editar clave** → **Restricciones de API** → **Restringir clave** →
   tildar solo **PageSpeed Insights API** → Guardar. Esto importa: una clave sin
   restringir sirve para cualquier API del proyecto.
5. **No pegarla en el chat.** Guardarla en `C:\dev\herramientas-sebabru\.env`
   (esa carpeta esta fuera de git) en una linea nueva:

   ```
   PAGESPEED_API_KEY=la-clave-que-copiaste
   ```

   Y avisarme que esta. Yo la leo de ahi y nunca la escribo en ningun lado.

### 2. Search Console

No hace falta darme acceso. Alcanza con un exporte:

1. <https://search.google.com/search-console> → propiedad **sebabru.com**.
2. **Rendimiento** → arriba a la derecha **Exportar** → **Descargar CSV**.
   Antes de exportar, poner el rango en **Ultimos 3 meses**.
3. Dejar el `.zip` en `C:\dev\scratch\` y avisarme.
4. Aparte, en **Sitemaps** (menu de la izquierda): si no figura `sitemap.xml`,
   escribir `sitemap.xml` en el campo y **Enviar**. Publicado no es lo mismo que
   enviado.
5. Y en **Indexacion → Paginas**, mirar si dice cuantas estan indexadas. Ese es
   el unico numero que dice si las 196 de `/carta-natal/` sirvieron de algo.

### 3. GA4

Si queres que mida el camino `/carta-natal/` → `/cartas/` → `/suscribirse/`,
lo mas simple es un exporte igual que el de Search Console, o darle acceso de
**Lector** a una cuenta de servicio. Esto puede esperar a enero: primero importa
saber si entramos al indice.
