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
//   - Sin <lastmod>: en el runner todos los archivos tienen la fecha del
//     checkout, asi que cualquier fecha que pusieramos seria mentira, y una
//     fecha falsa es peor que ninguna. Se puede agregar mas adelante leyendo
//     la fecha del ultimo commit de cada archivo (requiere fetch-depth: 0).

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

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

    urls.push(aUrl(rel));
}

urls.sort((a, b) => a.localeCompare(b, 'es'));

const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${DOMINIO}${u}</loc></url>`),
    '</urlset>',
    '',
].join('\n');

await writeFile(join(RAIZ, 'sitemap.xml'), xml, 'utf8');

console.log(`sitemap.xml: ${urls.length} URLs`);
for (const u of urls) console.log('  ' + u);
if (saltadas.length) {
    console.log(`\nFuera del sitemap (${saltadas.length}):`);
    for (const [r, por] of saltadas) console.log(`  ${r} -- ${por}`);
}

// Red de seguridad: si /cartas/ no entro, el paso anterior del workflow fallo
// o cambio de lugar. Mejor que falle el deploy que publicar un sitemap mocho.
try {
    await stat(join(RAIZ, 'cartas', 'index.html'));
    if (!urls.includes('/cartas/')) {
        console.error('\nERROR: existe public/cartas/index.html pero no entro al sitemap.');
        process.exit(1);
    }
} catch {
    console.error('\nERROR: no existe public/cartas/index.html. Se genero el sitemap sin la calculadora.');
    process.exit(1);
}
