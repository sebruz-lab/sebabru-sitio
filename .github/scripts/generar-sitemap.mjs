// Genera public/sitemap.xml recorriendo public/ en el momento del deploy.
//
// Se genera y no se escribe a mano a proposito: las paginas del sitio cambian
// seguido (y hay mas de una ventana trabajando en el repo), asi que una lista
// fija se desactualiza sin que nadie se entere.
//
// Corre DESPUES de bajar la calculadora en el workflow, para que /cartas/
// entre sola: esa carpeta no esta en el repo, se baja de sebruz-lab/tucarta.
//
// Reglas:
//   - Una pagina con <meta name="robots" content="noindex"> NO va al sitemap.
//     Listar una URL noindex es contradictorio y Search Console lo reporta.
//   - Los prototipos y pruebas tampoco (ademas estan excluidos del deploy en
//     firebase.json).
//   - 404.html no va nunca.
//   - <lastmod> sale de la fecha del ultimo commit de cada archivo, NO de su
//     mtime: en el runner todos los archivos tienen la fecha del checkout, y
//     una fecha falsa es peor que ninguna. Requiere fetch-depth: 0 en el
//     checkout del workflow (sin eso, el clon es shallow y el historial no
//     alcanza). Si git no contesta, la URL va sin lastmod: es opcional.
//     Las paginas de /cartas/ nunca tienen: no estan en el repo, se bajan.

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const RAIZ = 'public';
const DOMINIO = 'https://sebabru.com';

// Nombres que nunca se publican ni se listan.
const EXCLUIR_EXACTO = new Set(['404.html']);
const EXCLUIR_PATRON = /(^|[\/\\])(preview-|prueba-|test-|prototipo-)/i;

async function* htmls(dir) {
    for (const entrada of await readdir(dir, { withFileTypes: true })) {
        const ruta = join(dir, entrada.name);
        if (entrada.isDirectory()) {
            if (entrada.name === 'node_modules' || entrada.name.startsWith('.')) continue;
            yield* htmls(ruta);
        } else if (entrada.name.endsWith('.html')) {
            yield ruta;
        }
    }
}

// public/index.html            -> /
// public/signos/aries/index.html -> /signos/aries/
// public/escuela/abierta/x.html  -> /escuela/abierta/x.html
function aUrl(rutaRelativa) {
    const partes = rutaRelativa.split(sep);
    const archivo = partes.pop();
    const carpeta = partes.length ? '/' + partes.join('/') + '/' : '/';
    return archivo === 'index.html' ? carpeta : carpeta + archivo;
}

// Fecha del ultimo commit de cada archivo, en una sola pasada por el
// historial (237 llamadas a `git log` por archivo tardarian de mas).
// `git log --name-only` lista los commits del mas nuevo al mas viejo, asi
// que la PRIMERA vez que aparece un archivo es su ultima modificacion.
function fechasDeGit() {
    const fechas = new Map();
    let salida;
    try {
        salida = execFileSync('git', ['log', '--format=%cI', '--name-only', '--no-renames', '--', RAIZ],
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
        console.warn('Aviso: no pude leer las fechas de git (' + e.message.split('\n')[0] + '). El sitemap va sin <lastmod>.');
        return fechas;
    }
    let fecha = null;
    for (const linea of salida.split('\n')) {
        const l = linea.trim();
        if (!l) continue;
        if (/^\d{4}-\d{2}-\d{2}T/.test(l)) { fecha = l.slice(0, 10); continue; }
        if (fecha && !fechas.has(l)) fechas.set(l, fecha);
    }
    return fechas;
}

const fechas = fechasDeGit();
const urls = [];
const saltadas = [];

for await (const ruta of htmls(RAIZ)) {
    const rel = relative(RAIZ, ruta);

    const relUrl = rel.split(sep).join('/');
    if (EXCLUIR_EXACTO.has(relUrl)) {
        saltadas.push([rel, 'nunca va al sitemap']);
        continue;
    }
    if (EXCLUIR_PATRON.test(rel)) {
        saltadas.push([rel, 'prueba o prototipo']);
        continue;
    }

    const html = await readFile(ruta, 'utf8');

    // Un fragmento que otra pagina carga por JS no es una pagina: no tiene
    // <html> ni <head> ni <title>. En el sitemap seria una URL que Google
    // indexa sin titulo y sin estilos (el caso de
    // tu-identidad-en-el-cielo/ebook/contenido.html, que carga lector.js).
    if (!/<html[\s>]/i.test(html)) {
        saltadas.push([rel, 'fragmento, no es una pagina']);
        continue;
    }

    // Solo la directiva de robots, no cualquier aparicion de la palabra.
    if (/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html)) {
        saltadas.push([rel, 'noindex']);
        continue;
    }

    // La clave del mapa es la ruta como la escribe git: siempre con /.
    urls.push({ url: aUrl(rel), lastmod: fechas.get(ruta.split(sep).join('/')) });
}

urls.sort((a, b) => a.url.localeCompare(b.url, 'es'));

const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${DOMINIO}${u.url}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`),
    '</urlset>',
    '',
].join('\n');

await writeFile(join(RAIZ, 'sitemap.xml'), xml, 'utf8');

console.log(`sitemap.xml: ${urls.length} URLs`);
for (const u of urls) console.log('  ' + u.url + (u.lastmod ? '  (' + u.lastmod + ')' : '  (sin fecha)'));
if (saltadas.length) {
    console.log(`\nFuera del sitemap (${saltadas.length}):`);
    for (const [r, por] of saltadas) console.log(`  ${r} -- ${por}`);
}

// Red de seguridad: si /cartas/ no entro, el paso anterior del workflow fallo
// o cambio de lugar. Mejor que falle el deploy que publicar un sitemap mocho.
try {
    await stat(join(RAIZ, 'cartas', 'index.html'));
    if (!urls.some((u) => u.url === '/cartas/')) {
        console.error('\nERROR: existe public/cartas/index.html pero no entro al sitemap.');
        process.exit(1);
    }
} catch {
    console.error('\nERROR: no existe public/cartas/index.html. Se genero el sitemap sin la calculadora.');
    process.exit(1);
}
