# La ruleta de puntos en /carta-natal/ — plan

**Estado: sin publicar.** Esto es el plan para revisar offline, no hay nada
deployado. Escrito el 17/11/2026.

## Qué es

Una rueda de puntos (Sol, Luna, Mercurio… los 15 que ya existen) que gira con
el scroll. Al tocar un punto se abre ahí mismo, sin que la persona se vaya de
la rueda, y adentro aparecen los 12 signos, cada uno en su propio desplegable.
En celular se ve sólo un fragmento de la rueda. Hay un "volver" que devuelve la
vista a la rueda completa.

## Qué hay hoy, medido

| | |
|---|---|
| Estructura | 15 hubs (`/carta-natal/neptuno/`) + 12 hojas cada uno = **196 páginas** |
| Hub | ~579 palabras, 13 enlaces |
| Hoja | ~316 palabras |
| Peso de las 196 juntas | 1,9 MB de HTML |
| Velocidad | **96/100 en móvil**, LCP 0,8 s — lo más rápido del sitio |
| JSON en `/textos/` | 37 (sol, luna y ascendente de la calculadora), ~2,8 KB cada uno |

Las 196 páginas y los JSON los genera `paginas-textos.js` desde Firestore, en
`C:\dev\herramientas-sebabru`. **No se editan a mano.**

## La decisión de arquitectura, y por qué

Los textos **no** van escritos dentro del HTML del hub. Van en un JSON por
punto que la rueda pide cuando hace falta.

Un acordeón no tiene ningún problema de SEO por sí mismo: desde que Google
indexa mobile-first, el texto escondido en un acordeón pesa igual que el
visible, siempre que **venga en el HTML y esté oculto por CSS**. Si lo trae un
`fetch` al hacer clic, Google no lo ve.

Pero el problema acá no es el acordeón, es cuántas URLs quedan. Hoy hay 196
puertas de entrada distintas, cada una con su `<title>`, su canonical y su
schema. Si los 196 textos pasan a vivir dentro del hub:

- **borrando las hojas** → queda una sola puerta, y una URL no puede ser a la
  vez el mejor resultado para "neptuno en piscis" y para "marte en aries";
- **dejando las hojas y duplicando** → las dos versiones compiten por la misma
  consulta y Google elige una, muchas veces la que no querés.

Traer el texto por `fetch` resuelve las dos cosas de una: no está en el HTML del
hub, así que Google no se lo cuenta al hub y no hay con qué competir; y la
persona lo lee sin irse. El hub rankea con sus 579 palabras propias.

**La contracara, anotada para no olvidarla:** si el export de Search Console de
diciembre dice que las hojas de ~316 palabras son demasiado finas para rankear
solas, la jugada opuesta es escribir los textos dentro del HTML del hub y dejar
de tener hojas. Son los dos extremos coherentes. Esta opción es la reversible.

## Cómo se arma

### 1. El generador emite un JSON por punto

En `paginas-textos.js`, una salida más: `public/textos/punto-<slug>.json`

```json
{
  "punto": "Neptuno",
  "slug": "neptuno",
  "signos": [
    { "signo": "Aries", "slug": "aries", "titulo": "...",
      "texto": "<p>...</p>", "url": "/carta-natal/neptuno/aries/" }
  ]
}
```

15 archivos, ~36 KB cada uno (12 textos de ~3 KB). Sale de la misma corrida que
las páginas, así que no se puede desincronizar. Los `/textos/*.json` ya tienen
`max-age` de 30 días por el `firebase.json`, así que hay que versionar el pedido
(`?v=N`) o el navegador se queda con el viejo cuando Seba corrija un texto.

### 2. La rueda

- Un `<ul>` de 15 items con enlaces **reales** (`<a href="/carta-natal/neptuno/">`),
  dispuestos en círculo con CSS. Sin JS tiene que seguir siendo una lista
  navegable: es lo que hace que Google llegue a los 15 hubs.
- El giro, con `transform: rotate()` sobre el contenedor y el scroll como
  entrada. **Reutilizar el patrón de `script.js`**, que ya mueve la cámara del
  recorrido con el scroll y duerme el `requestAnimationFrame` cuando llega
  (está comentado en el código: antes repintaba 60 veces por segundo con la
  página quieta, y eso era batería y calor en gama media).
- En celular, un arco en vez del círculo completo: el mismo markup, otro CSS.
- `prefers-reduced-motion`: sin giro, la lista queda vertical.

### 3. Los desplegables

- `<details>` nativos, anidados: uno por punto y 12 adentro.
- Al abrir el de un punto, un `fetch` del JSON; mientras llega, un
  placeholder. Si el fetch falla, se muestra el enlace a la hoja y listo —
  nunca una pantalla vacía.
- **Dentro de cada desplegable de signo, un `<a href>` de verdad en el HTML**,
  no generado por JS. El texto que entra por fetch los buscadores no lo ven,
  pero los enlaces tienen que estar: son los que llevan a Google a las 196.
- El "volver a la rueda" es un enlace al ancla de la rueda, no un `history.back()`.

## Lo que hay que cuidar

1. **La velocidad.** `/carta-natal/` saca 96/100 y es la parte más sana del
   sitio. Una rueda con `transform` y scroll es justo el tipo de widget que lo
   puede arruinar. **Medir con PageSpeed antes y después, con una página de
   control que no se toque**, igual que se hizo con los embeds.
2. **La rueda no puede ser el LCP.** Si el elemento más grande de la pantalla
   es un contenedor que arranca vacío y lo llena el JS, el LCP se dispara.
3. **Nada de contenido que dependa del scroll para existir en el HTML.**
4. El `<h1>` y el texto propio del hub van **arriba** de la rueda.
5. No tocar las 196 páginas a mano: todo cambio va por `paginas-textos.js`.

## Orden de trabajo

1. Agregar la salida JSON al generador y correrlo. No cambia nada del sitio
   publicado: sólo aparecen 15 archivos nuevos. **Se puede hacer y medir sin
   riesgo.**
2. Prototipo de la rueda en una página aparte, fuera del sitemap y con
   `noindex`, para mirarla sin tocar `/carta-natal/`.
3. Medir el prototipo con PageSpeed contra una hoja de control.
4. Si pasa, montarla en un solo hub (`/carta-natal/neptuno/`) y medir de nuevo.
5. Recién después, los 15 — y eso es un cambio en `paginas-textos.js`, no 15
   ediciones.

## Lo que falta decidir

- Si la rueda va sólo en los 15 hubs, o también en `/carta-natal/` con los 15
  puntos y otro nivel de anidado.
- Qué pasa con `/carta-natal/casas/`, que tiene 12 casas y no 12 signos: la
  rueda sirve igual, pero el JSON tiene otra forma.
- Si el desplegable muestra el texto completo o el primer párrafo con un
  "seguir leyendo". Con texto completo, la hoja se vuelve redundante para quien
  ya lo leyó; con el primer párrafo, la hoja conserva su razón de ser. Esto
  cambia cuánta gente llega a las 196 y conviene decidirlo con los datos de
  diciembre.
