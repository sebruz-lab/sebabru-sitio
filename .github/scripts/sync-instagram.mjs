// Renueva el token de Instagram y rearma la grilla de 6 posteos de la home.
//
// Por que una grilla de 6 imagenes propias y no el embed oficial: el embed
// trae un iframe de Instagram (megabytes y un tercero mirando a cada visita),
// y ademas estaba muerto — el blockquote seguia en la home pero embed.js no se
// cargaba, asi que esa seccion no mostraba nada.
//
// Por que se bajan las imagenes: las URLs que devuelve la API de Instagram
// vencen a las pocas horas. Hay que servirlas desde el sitio.
//
// Por que un archivo por posteo y no una imagen compuesta: cada celda enlaza a
// su propio posteo y el navegador las cachea por separado. Se nombran por el
// codigo del posteo (/p/<codigo>/), no por su posicion: asi un posteo nuevo
// agrega un archivo y borra el que salio, en vez de reescribir los seis y
// hacer crecer el historial de git 150 KB por dia.
//
// El token vive solo como secreto en GitHub: esto no se puede probar local, la
// primera corrida de verdad es la Action.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const token = process.env.IG_ACCESS_TOKEN;
const repo = process.env.GH_REPO;
if (!token) throw new Error('Falta IG_ACCESS_TOKEN');
if (!repo) throw new Error('Falta GH_REPO');

const PAGINA = 'public/index.html';
const CARPETA = 'public/img/ig';
const MARCA_INICIO = '<!-- GRILLA-IG:inicio -->';
const MARCA_FIN = '<!-- GRILLA-IG:fin -->';
const CUANTOS = 6;
const LADO = 320;

async function refreshToken(oldToken) {
  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(oldToken)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Refresh fallo: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ultimosPosteos(accessToken) {
  const campos = 'permalink,media_url,thumbnail_url,media_type,caption';
  const url = `https://graph.instagram.com/me/media?fields=${campos}&limit=${CUANTOS}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Media fetch fallo: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data || [];
}

// https://www.instagram.com/p/DffVHUQlnxu/ -> DffVHUQlnxu
function codigoDe(permalink) {
  const m = permalink.match(/\/(?:p|reel|tv)\/([^/?#]+)/);
  if (!m) throw new Error(`No pude sacar el codigo de ${permalink}`);
  return m[1];
}

// Un video no tiene media_url servible como imagen: hay que usar su miniatura.
function imagenDe(posteo) {
  return posteo.media_type === 'VIDEO' ? (posteo.thumbnail_url || posteo.media_url) : posteo.media_url;
}

function escapar(texto) {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// El alt sale del epigrafe que escribio Seba, recortado. Si no hay, queda uno
// generico: un alt vacio es peor que uno corto.
function altDe(posteo) {
  const bruto = (posteo.caption || '').replace(/\s+/g, ' ').trim();
  if (!bruto) return 'Posteo de Instagram de Seba Bru';
  const corto = bruto.length > 90 ? bruto.slice(0, 90).replace(/\s\S*$/, '') + '...' : bruto;
  return escapar(corto);
}

async function bajarYConvertir(posteo, codigo) {
  const destino = join(CARPETA, `${codigo}.webp`);
  if (existsSync(destino)) return destino;
  const url = imagenDe(posteo);
  if (!url) throw new Error(`El posteo ${codigo} no trae imagen (${posteo.media_type})`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No pude bajar la imagen de ${codigo}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await sharp(bytes)
    .resize(LADO, LADO, { fit: 'cover', position: 'attention' })
    .webp({ quality: 72 })
    .toFile(destino);
  console.log(`Imagen nueva: ${destino}`);
  return destino;
}

function armarGrilla(posteos) {
  const celdas = posteos.map((p) => {
    const codigo = codigoDe(p.permalink);
    const enlace = p.permalink.replace(/\/$/, '') + '/';
    return `        <a href="${enlace}" target="_blank" rel="noopener noreferrer">`
      + `<img src="/img/ig/${codigo}.webp" width="${LADO}" height="${LADO}" alt="${altDe(p)}" loading="lazy" decoding="async"></a>`;
  }).join('\n');

  return `${MARCA_INICIO}
    <style id="ig-grilla-estilos">
        .ig-grilla { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
        .ig-grilla a { display: block; line-height: 0; border-radius: 4px; overflow: hidden; }
        .ig-grilla img { width: 100%; height: auto; aspect-ratio: 1 / 1; object-fit: cover; display: block; transition: opacity .2s ease; }
        .ig-grilla a:hover img { opacity: .78; }
    </style>
    <div class="ig-grilla">
${celdas}
    </div>
    ${MARCA_FIN}`;
}

// --- Token -------------------------------------------------------------

const refreshed = await refreshToken(token);
const newToken = refreshed.access_token;
console.log(`Token renovado, vence en ${Math.round(refreshed.expires_in / 86400)} dias`);

execFileSync('gh', ['secret', 'set', 'IG_ACCESS_TOKEN', '--body', newToken, '--repo', repo], { stdio: 'inherit' });
console.log('Secreto IG_ACCESS_TOKEN actualizado en GitHub');

// --- Grilla ------------------------------------------------------------

const posteos = await ultimosPosteos(newToken);
if (!posteos.length) throw new Error('No se encontro ningun posteo');

const html = readFileSync(PAGINA, 'utf8');
const desde = html.indexOf(MARCA_INICIO);
const hasta = html.indexOf(MARCA_FIN);
if (desde === -1 || hasta === -1) throw new Error(`No encontre las marcas ${MARCA_INICIO} / ${MARCA_FIN} en ${PAGINA}`);

const bloqueViejo = html.slice(desde, hasta + MARCA_FIN.length);
const bloqueNuevo = armarGrilla(posteos);

mkdirSync(CARPETA, { recursive: true });

const codigos = posteos.map((p) => codigoDe(p.permalink));
for (const [i, p] of posteos.entries()) await bajarYConvertir(p, codigos[i]);

// Lo que ya no esta entre los seis se borra: la carpeta no es un archivo
// historico, es lo que la home muestra hoy.
const vigentes = new Set(codigos.map((c) => `${c}.webp`));
for (const archivo of readdirSync(CARPETA)) {
  if (!vigentes.has(archivo)) {
    unlinkSync(join(CARPETA, archivo));
    console.log(`Imagen que salio de la grilla: ${archivo}`);
  }
}

if (bloqueViejo === bloqueNuevo) {
  console.log('Sin cambios, los seis posteos ya estan reflejados.');
} else {
  writeFileSync(PAGINA, html.slice(0, desde) + bloqueNuevo + html.slice(hasta + MARCA_FIN.length), 'utf8');
  console.log(`Grilla actualizada: ${codigos.join(', ')}`);
}
