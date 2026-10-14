// =========================================================
// CHEQUEO DEL SITIO sebabru.com
// Corre en GitHub Actions (.github/workflows/chequeo-sitio.yml): todos
// los dias y despues de cada deploy. Si algo esta roto, termina con
// error -> GitHub avisa por mail y abre (o actualiza) un issue.
//
// Nunca ensucia datos reales: los envios a Google Analytics y los
// pedidos de pago se cortan antes de salir.
//
// Local:  cd .github/chequeo && npm install && node chequeo.mjs
//         (SOLO_ESTATICO=1 para saltear el navegador)
// =========================================================
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env.CHEQUEO_RAIZ || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = join(RAIZ, 'public');
const SITIO = (process.env.SITIO_URL || 'https://sebabru.com').replace(/\/$/, '');
const GA_ID = 'G-GDLRMR5D57';
const FUNCIONES = 'https://us-central1-sebabru-e5563.cloudfunctions.net';
const WHATSAPP_COMPROBANTES = 'https://wa.me/5493544584122';

// Lo que no se publica (firebase.json -> hosting.ignore) o son pruebas sueltas.
const IGNORAR = [/^test\//, /^test-3d\//, /^Mey\//, /^preview-bloques\.html$/, /^prueba-contenido\.html$/,
    /^test\.html$/, /^lilith\/prototipo-3d\.html$/, /^escuela\/abierta\/test-descripcion\.html$/, /^404\.html$/];
// Paginas donde un error de JavaScript cuenta como falla (en el resto, aviso).
const CLAVE = ['', 'lilith/', 'linaje/', 'formaciones/', 'escuela/abierta/', 'escuela/abierta/gracias.html', 'lilith/pedido/'];

const resultados = [];
const falla = (area, detalle) => resultados.push({ area, nivel: 'falla', detalle });
const aviso = (area, detalle) => resultados.push({ area, nivel: 'aviso', detalle });
const ok = (area, detalle) => resultados.push({ area, nivel: 'ok', detalle });

function archivos(dir, ext, base = dir) {
    let out = [];
    for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        const rel = relative(base, p).replace(/\\/g, '/');
        if (IGNORAR.some(re => re.test(rel)) || n === 'node_modules') continue;
        if (statSync(p).isDirectory()) out = out.concat(archivos(p, ext, base));
        else if (ext.includes(extname(n))) out.push(rel);
    }
    return out;
}

// ---------------------------------------------------------------
// 1. Chequeos sobre los archivos del repo (rapidos, sin navegador)
// ---------------------------------------------------------------
function existeEnPublic(ruta) {
    const p = join(PUBLIC, ruta);
    if (existsSync(p) && statSync(p).isFile()) return true;
    if (existsSync(p) && statSync(p).isDirectory()) return existsSync(join(p, 'index.html'));
    return false;
}

function chequearReferencias(paginasHtml) {
    const scripts = archivos(PUBLIC, ['.js']);
    const rotas = [];
    for (const rel of [...paginasHtml, ...scripts]) {
        const texto = readFileSync(join(PUBLIC, rel), 'utf8');
        const refs = new Set();
        const patrones = [
            /\b(?:src|href|data-src|poster)\s*=\s*"([^"]+)"/g,
            /\b(?:src|href|data-src|poster)\s*=\s*'([^']+)'/g,
            /\bfrom\s+['"]([^'"]+)['"]/g,
            /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
            /url\(\s*['"]?([^'")]+)['"]?\s*\)/g,
        ];
        for (const re of patrones) for (const m of texto.matchAll(re)) refs.add(m[1].trim());
        for (const ref of refs) {
            if (!ref || /^(https?:|\/\/|mailto:|tel:|data:|javascript:|#|%23|\$\{|blob:)/i.test(ref) || ref.includes('${') || ref.includes('+')) continue;
            const limpia = decodeURI(ref.split('#')[0].split('?')[0]);
            if (!limpia) continue;
            const destino = limpia.startsWith('/')
                ? limpia.slice(1)
                : relative(PUBLIC, resolve(join(PUBLIC, dirname(rel)), limpia)).replace(/\\/g, '/');
            if (destino.startsWith('..')) continue;
            if (IGNORAR.some(re => re.test(destino))) continue;
            if (!existeEnPublic(destino)) rotas.push(`\`${rel}\` apunta a \`${ref}\`, que no existe`);
        }
    }
    if (rotas.length) rotas.forEach(r => falla('Archivos que faltan', r));
    else ok('Archivos que faltan', `Todas las referencias de ${paginasHtml.length} páginas y ${scripts.length} scripts existen`);
}

function chequearComillas(paginasHtml) {
    // Comillas tipograficas DENTRO de una etiqueta rompen los atributos
    // (CLAUDE.md). En el texto visible estan bien.
    let hallazgos = 0;
    for (const rel of paginasHtml) {
        const lineas = readFileSync(join(PUBLIC, rel), 'utf8').split('\n');
        lineas.forEach((l, i) => {
            for (const m of l.matchAll(/<[a-zA-Z][^<>]*[“”][^<>]*>/g)) {
                hallazgos++;
                falla('Comillas curvas en etiquetas', `\`${rel}:${i + 1}\` → \`${m[0].slice(0, 90)}\``);
            }
        });
    }
    if (!hallazgos) ok('Comillas curvas en etiquetas', 'Ninguna');
}

function leerPrecios(archivo) {
    const txt = readFileSync(archivo, 'utf8');
    const bloque = (txt.match(/const PRECIOS\s*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
    const precios = {};
    for (const m of bloque.matchAll(/(\w+)\s*:\s*\{\s*ars:\s*(\d+),\s*usd:\s*(\d+)/g)) precios[m[1]] = { ars: +m[2], usd: +m[3] };
    return precios;
}

function chequearPrecios() {
    const servidor = leerPrecios(join(RAIZ, 'functions', 'index.js'));
    const aula = leerPrecios(join(PUBLIC, 'escuela', 'aula-abierta.js'));
    let problemas = 0;
    if (!Object.keys(servidor).length) { falla('Precios', 'No pude leer PRECIOS de functions/index.js'); return; }
    for (const [curso, p] of Object.entries(servidor)) {
        const a = aula[curso];
        if (!a) { aviso('Precios', `\`${curso}\` está en el servidor pero no en escuela/aula-abierta.js`); problemas++; continue; }
        if (a.ars !== p.ars || a.usd !== p.usd) {
            falla('Precios', `\`${curso}\`: el servidor cobra $${p.ars} / USD ${p.usd} pero el aula muestra $${a.ars} / USD ${a.usd}`);
            problemas++;
        }
    }
    // /lilith: lo que muestra la pagina vs lo que cobra el servidor.
    const lilith = readFileSync(join(PUBLIC, 'lilith', 'index.html'), 'utf8');
    const s = servidor.lilith;
    if (s) {
        const ars = '$' + s.ars.toLocaleString('es-AR');
        const mp = (lilith.match(/id="precio-mp-lilith">([^<]+)</) || [])[1];
        const pp = (lilith.match(/id="precio-pp-lilith">([^<]+)</) || [])[1];
        const curso = lilith.match(/const CURSO = \{[^}]*precio:\s*(\d+),\s*precioUsd:\s*(\d+)/);
        if (mp && mp.trim() !== ars) { falla('Precios', `/lilith muestra ${mp} en Mercado Pago, el servidor cobra ${ars}`); problemas++; }
        if (pp && pp.trim() !== `USD ${s.usd}`) { falla('Precios', `/lilith muestra ${pp} en PayPal, el servidor cobra USD ${s.usd}`); problemas++; }
        if (curso && (+curso[1] !== s.ars || +curso[2] !== s.usd)) { falla('Precios', `/lilith calcula descuentos sobre $${curso[1]} / USD ${curso[2]}, el servidor cobra ${ars} / USD ${s.usd}`); problemas++; }
    }
    if (!problemas) ok('Precios', `Coinciden servidor, aulas y /lilith (${Object.keys(servidor).length} cursos)`);
}

// ---------------------------------------------------------------
// 2. Servidor (Cloud Functions): pedidos inofensivos
// ---------------------------------------------------------------
async function chequearServidor() {
    // OPTIONS = la consulta previa del navegador: no crea nada.
    for (const fn of ['crearPago', 'crearPagoPaypal', 'crearPagoLibro', 'verificarPagoMP']) {
        try {
            const r = await fetch(`${FUNCIONES}/${fn}`, { method: 'OPTIONS', headers: { Origin: SITIO, 'Access-Control-Request-Method': 'POST' } });
            if (r.status === 204 || r.status === 200) ok('Servidor de pagos', `\`${fn}\` responde`);
            else falla('Servidor de pagos', `\`${fn}\` respondió ${r.status}`);
        } catch (e) { falla('Servidor de pagos', `\`${fn}\` no responde: ${e.message}`); }
    }
    // Clase gratis de cada aula que usa YouTube (data-video). Un aula que
    // el servidor todavia no conoce (CURSO_URLS) esta en construccion.
    const servidorTxt = readFileSync(join(RAIZ, 'functions', 'index.js'), 'utf8');
    const cursosServidor = ((servidorTxt.match(/const CURSO_URLS\s*=\s*\{([\s\S]*?)\};/) || [])[1] || '')
        .split('\n').map(l => (l.match(/^\s*(\w+)\s*:/) || [])[1]).filter(Boolean);
    const aulas = archivos(join(PUBLIC, 'escuela', 'abierta'), ['.html'])
        .filter(r => r.endsWith('/index.html'))
        .map(r => r.split('/')[0]);
    for (const slug of aulas) {
        const html = readFileSync(join(PUBLIC, 'escuela', 'abierta', slug, 'index.html'), 'utf8');
        if (!html.includes('data-video')) continue;
        if (!html.includes(`initAula('${slug}'`)) continue;
        if (!cursosServidor.includes(slug)) {
            aviso('Clase gratis en las aulas', `\`${slug}\`: el aula está publicada pero el curso todavía no está dado de alta en el servidor (functions/index.js → CURSO_URLS y PRECIOS), así que su clase gratis no carga`);
            continue;
        }
        try {
            const r = await fetch(`${FUNCIONES}/obtenerMuestra?curso=${slug}`);
            const d = await r.json().catch(() => ({}));
            if (r.ok && d.videoId) ok('Clase gratis en las aulas', `\`${slug}\`: video cargado`);
            else falla('Clase gratis en las aulas', `\`${slug}\`: no hay clase gratis (${r.status} ${d.error || ''})`);
        } catch (e) { falla('Clase gratis en las aulas', `\`${slug}\`: ${e.message}`); }
    }
}

// ---------------------------------------------------------------
// 3. Paginas publicadas, en un Chrome real
// ---------------------------------------------------------------
const espera = ms => new Promise(r => setTimeout(r, ms));

async function nuevaPagina(browser, { ancho = 1400, alto = 850, movimiento = 'no-preference', bloquear = [] } = {}) {
    const page = await browser.newPage();
    const celu = ancho < 500;
    await page.setViewport({ width: ancho, height: alto, isMobile: celu, hasTouch: celu });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: movimiento }]);
    const reg = { errores: [], rotos: [], pagos: [], gaEnvios: 0 };
    page.on('pageerror', e => reg.errores.push(String(e.message || e).split('\n')[0]));
    page.on('response', r => {
        const u = r.url();
        if (u.startsWith(SITIO) && r.status() >= 400) reg.rotos.push(`${r.status()} ${u.replace(SITIO, '')}`);
    });
    page.on('dialog', d => d.dismiss().catch(() => {}));
    await page.setRequestInterception(true);
    page.on('request', r => {
        const u = r.url();
        if (/google-analytics\.com\/.*collect/.test(u)) { reg.gaEnvios++; return r.abort(); }
        if (u.startsWith(FUNCIONES) && r.method() !== 'GET') { reg.pagos.push(u.split('/').pop().split('?')[0]); return r.abort(); }
        if (bloquear.some(b => u.includes(b))) return r.abort();
        r.continue();
    });
    return { page, reg };
}

async function chequearPaginas(browser, paginasHtml) {
    const rutas = paginasHtml.map(r => r.replace(/index\.html$/, ''));
    for (const ruta of rutas) {
        const area = 'Páginas publicadas';
        const { page, reg } = await nuevaPagina(browser);
        try {
            const resp = await page.goto(`${SITIO}/${ruta}`, { waitUntil: 'load', timeout: 45000 });
            await espera(1500);
            const status = resp ? resp.status() : 0;
            const ga = await page.evaluate(id => typeof window.gtag === 'function' &&
                (window.dataLayer || []).some(a => a && a[0] === 'config' && a[1] === id), GA_ID);
            if (status >= 400) falla(area, `\`/${ruta}\` devuelve ${status}`);
            reg.rotos.forEach(r => falla(area, `\`/${ruta}\` pide un archivo que no está: ${r}`));
            const errores = [...new Set(reg.errores)];
            if (errores.length) (CLAVE.includes(ruta) ? falla : aviso)(area, `\`/${ruta}\` tiene errores de JavaScript: ${errores.slice(0, 3).join(' · ')}`);
            if (!ga && ruta !== 'escuela/admin/') aviso('Google Analytics', `\`/${ruta}\` no tiene GA4 (${GA_ID})`);
            if (status < 400 && !reg.rotos.length && !errores.length) ok(area, `\`/${ruta}\``);
        } catch (e) {
            falla(area, `\`/${ruta}\` no cargó: ${e.message.split('\n')[0]}`);
        }
        await page.close();
    }
}

// Circuito de compra: lo que ve quien llega desde un anuncio.
async function chequearCompraLilith(browser) {
    const area = 'Compra en /lilith';
    const utm = 'utm_source=chequeo&utm_medium=bot&utm_campaign=chequeo';
    const casos = [
        { nombre: 'compu, con animación', ancho: 1400, alto: 850, movimiento: 'no-preference', pagar: true },
        { nombre: 'celular, con animación', ancho: 390, alto: 800, movimiento: 'no-preference' },
        { nombre: 'compu, sin animación', ancho: 1400, alto: 850, movimiento: 'reduce' },
        { nombre: 'celular, sin animación', ancho: 390, alto: 800, movimiento: 'reduce', pagar: true },
        { nombre: 'celular, con el motor de la animación caído', ancho: 390, alto: 800, movimiento: 'no-preference', bloquear: ['recorrido.js'] },
    ];
    for (const c of casos) {
        const { page, reg } = await nuevaPagina(browser, c);
        const problemas = [];
        try {
            await page.goto(`${SITIO}/lilith?${utm}#curso`, { waitUntil: 'load', timeout: 45000 });
            await espera(3000);
            const url = page.url();
            if (!url.includes(utm) || !url.endsWith('#curso')) problemas.push(`la redirección perdió los UTM o el ancla (quedó ${url})`);

            const estado = await page.evaluate(() => {
                const visible = el => {
                    if (!el) return 'no existe';
                    const caja = el.closest('.efecto-texto');
                    if (caja) caja.scrollTop = el.offsetTop - caja.clientHeight / 2;
                    const r = el.getBoundingClientRect();
                    if (r.bottom <= 0 || r.top >= innerHeight) return 'fuera de pantalla';
                    let op = 1; for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
                    if (op < 0.9) return 'transparente';
                    const arriba = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
                    return arriba && (arriba === el || el.contains(arriba)) ? 'ok' : 'tapado';
                };
                const wa = document.getElementById('wa-comprobante-lilith');
                const loading = document.getElementById('loading-pago-lilith');
                return {
                    titulo: visible(document.querySelector('#curso h2')),
                    claseGratis: visible(document.querySelector('#curso .btn-clase-gratis')),
                    mp: visible(document.getElementById('btn-pagar-mp-lilith')),
                    paypal: visible(document.getElementById('btn-pagar-paypal-lilith')),
                    whatsapp: wa ? wa.href : '',
                    cargando: loading ? getComputedStyle(loading).display : 'none',
                    visibleMedido: (window.dataLayer || []).some(a => a && a[0] === 'event' && a[1] === 'bloque_curso_visible'),
                };
            });
            for (const [k, nombre] of [['titulo', 'el título del curso'], ['claseGratis', 'el botón de la clase gratis'], ['mp', 'el botón de Mercado Pago'], ['paypal', 'el botón de PayPal']]) {
                if (estado[k] !== 'ok') problemas.push(`${nombre}: ${estado[k]}`);
            }
            if (!estado.whatsapp.startsWith(WHATSAPP_COMPROBANTES + '?text=') || !decodeURIComponent(estado.whatsapp).includes('Luna Negra')) problemas.push(`el WhatsApp del comprobante apunta a ${estado.whatsapp || '(nada)'}`);
            if (estado.cargando !== 'none') problemas.push('"Preparando tu pago..." se ve al cargar');
            if (!estado.visibleMedido) problemas.push('no se midió bloque_curso_visible en GA4');

            if (c.pagar) {
                await page.evaluate(() => document.getElementById('btn-pagar-mp-lilith').click());
                for (let i = 0; i < 16 && !reg.pagos.includes('crearPago'); i++) await espera(500);
                if (!reg.pagos.includes('crearPago')) problemas.push('"Pagar con Mercado Pago" no llama al servidor de pagos');
            }
            reg.rotos.forEach(r => problemas.push(`falta un archivo: ${r}`));
        } catch (e) {
            problemas.push(`no cargó: ${e.message.split('\n')[0]}`);
        }
        if (problemas.length) problemas.forEach(p => falla(area, `${c.nombre}: ${p}`));
        else ok(area, `${c.nombre}: entra por #curso con UTM, todo visible${c.pagar ? ' y el pago responde' : ''}`);
        await page.close();
    }
}

// Cada aula, sin sesion iniciada: la Clase 1 tiene que estar lista para
// reproducir (es el regalo), sin pedir cuenta.
async function chequearAulasSinLogin(browser) {
    const area = 'Clase gratis sin iniciar sesión';
    const servidorTxt = readFileSync(join(RAIZ, 'functions', 'index.js'), 'utf8');
    const registrados = ((servidorTxt.match(/const CURSO_URLS\s*=\s*\{([\s\S]*?)\};/) || [])[1] || '');
    const aulas = archivos(join(PUBLIC, 'escuela', 'abierta'), ['.html'])
        .filter(r => r.endsWith('/index.html')).map(r => r.split('/')[0])
        .filter(slug => registrados.includes(`'/escuela/abierta/${slug}/'`));
    for (const slug of aulas) {
        const { page, reg } = await nuevaPagina(browser);
        try {
            await page.goto(`${SITIO}/escuela/abierta/${slug}/`, { waitUntil: 'load', timeout: 45000 });
            let st = null;
            for (let i = 0; i < 20; i++) {
                await espera(500);
                st = await page.evaluate(() => {
                    const f = document.querySelector('.clase-item iframe');
                    if (!f) return { problema: 'no hay video en la clase 1' };
                    const visible = getComputedStyle(f).display !== 'none' && f.getBoundingClientRect().height > 50;
                    return { src: f.src || '', visible, pideLogin: !!document.querySelector('.clase-gate-play') };
                });
                if (st.problema || (st.src && st.visible)) break;
            }
            if (st.problema) falla(area, `\`${slug}\`: ${st.problema}`);
            else if (st.pideLogin) falla(area, `\`${slug}\`: pide iniciar sesión para ver la clase 1`);
            else if (!st.src || !st.visible) falla(area, `\`${slug}\`: la clase 1 no cargó el video`);
            else ok(area, `\`${slug}\`: la clase 1 se ve sin cuenta`);
        } catch (e) { falla(area, `\`${slug}\`: no cargó: ${e.message.split('\n')[0]}`); }
        await page.close();
    }
}

async function chequearLinaje(browser) {
    const area = '/linaje';
    for (const movimiento of ['no-preference', 'reduce']) {
        const { page } = await nuevaPagina(browser, { movimiento });
        try {
            await page.goto(`${SITIO}/linaje/#seminario-linaje`, { waitUntil: 'load', timeout: 45000 });
            await espera(2500);
            const v = await page.evaluate(() => {
                const el = document.querySelector('#seminario-linaje h2');
                if (!el) return 'no existe';
                const r = el.getBoundingClientRect();
                let op = 1; for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
                return r.bottom > 0 && r.top < innerHeight && op > 0.9 ? 'ok' : 'no se ve';
            });
            const modo = movimiento === 'reduce' ? 'sin animación' : 'con animación';
            if (v === 'ok') ok(area, `${modo}: el seminario se ve al entrar por su ancla`);
            else falla(area, `${modo}: el título del seminario ${v}`);
        } catch (e) { falla(area, `no cargó: ${e.message.split('\n')[0]}`); }
        await page.close();
    }
}

// ---------------------------------------------------------------
// Informe
// ---------------------------------------------------------------
function informe() {
    const fallas = resultados.filter(r => r.nivel === 'falla');
    const avisos = resultados.filter(r => r.nivel === 'aviso');
    const oks = resultados.filter(r => r.nivel === 'ok');
    const fecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    const lineas = [];
    lineas.push(fallas.length ? `## 🔴 ${fallas.length} problema(s) en sebabru.com` : '## 🟢 sebabru.com funciona bien');
    lineas.push(`_Chequeo del ${fecha}. ${oks.length} controles bien, ${fallas.length} fallas, ${avisos.length} avisos._`, '');
    const grupo = (titulo, items) => {
        if (!items.length) return;
        lineas.push(`### ${titulo}`);
        const porArea = {};
        items.forEach(i => (porArea[i.area] = porArea[i.area] || []).push(i.detalle));
        for (const [area, ds] of Object.entries(porArea)) {
            lineas.push(`**${area}**`);
            ds.forEach(d => lineas.push(`- ${d}`));
        }
        lineas.push('');
    };
    grupo('Fallas (hay que arreglar)', fallas);
    grupo('Avisos (revisar cuando se pueda)', avisos);
    lineas.push('<details><summary>Controles que pasaron</summary>', '');
    oks.forEach(o => lineas.push(`- ${o.area}: ${o.detalle}`));
    lineas.push('', '</details>');
    return { texto: lineas.join('\n'), fallas: fallas.length };
}

// ---------------------------------------------------------------
const paginas = archivos(PUBLIC, ['.html']);
chequearComillas(paginas);
chequearReferencias(paginas);
chequearPrecios();

if (!process.env.SOLO_ESTATICO) {
    await chequearServidor();
    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
        await chequearCompraLilith(browser);
        await chequearLinaje(browser);
        await chequearAulasSinLogin(browser);
        await chequearPaginas(browser, paginas);
    } finally {
        await browser.close();
    }
}

const { texto, fallas } = informe();
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'informe.md'), texto);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, texto + '\n');
console.log(texto);
process.exit(fallas ? 1 : 0);
