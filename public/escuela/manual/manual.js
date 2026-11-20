// Manual de Primer Año: la pagina de /escuela/manual/.
//
// El EPUB no esta en el hosting: lo entrega la function manualEpub, solo con
// sesion de la escuela y a quien tenga al menos un curso habilitante (la regla
// y las excepciones estan en functions/index.js, junto a MANUAL_EXCLUIDOS).
// Aca se pide una sola vez y alimenta al lector (window.ManualFuente, que usa
// lector.js).
//
// EL MANUAL SE LEE EN LINEA Y NO SE BAJA (decision de Seba, 19/11/2026): se
// saco el boton "Descargar EPUB". El EPUB sigue siendo el formato en el que
// viaja, pero es un detalle de como esta hecho, no algo que la persona reciba.
import { auth } from '../firebase.js';
import { onAuthStateChanged, getIdToken } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const URL_MANUAL = 'https://us-central1-sebabru-e5563.cloudfunctions.net/manualEpub';

const $ = (id) => document.getElementById(id);

const mostrar = (id) => {
    ['manual-cargando', 'manual-sin-sesion', 'manual-sin-acceso', 'manual-listo'].forEach((x) => {
        const el = $(x);
        if (el) el.hidden = x !== id;
    });
};

// El EPUB, cuando llega. lector.js puede pedir el texto antes (si se entra con
// #leer), asi que ManualFuente espera a esta promesa en vez de fallar.
let resolverEpub, rechazarEpub;
const epubListo = new Promise((ok, mal) => { resolverEpub = ok; rechazarEpub = mal; });
epubListo.catch(() => {});

// Arma, desde el EPUB, el HTML con un <section class="capitulo"> por capitulo
// que espera el lector. Sigue el orden del spine y cambia las imagenes del
// zip por URLs locales (blob:), porque el lector no puede leer adentro del zip.
async function textoDelEpub(blob) {
    const zip = await window.JSZip.loadAsync(blob);
    const xml = async (ruta) => new DOMParser().parseFromString(await zip.file(ruta).async('string'), 'application/xml');

    const container = await xml('META-INF/container.xml');
    const rutaOpf = container.querySelector('rootfile').getAttribute('full-path');
    const dirOpf = rutaOpf.includes('/') ? rutaOpf.slice(0, rutaOpf.lastIndexOf('/') + 1) : '';
    const opf = await xml(rutaOpf);

    const manifiesto = {};
    opf.querySelectorAll('manifest > item').forEach((it) => {
        manifiesto[it.getAttribute('id')] = { href: it.getAttribute('href'), tipo: it.getAttribute('media-type') };
    });
    const resolver = (base, rel) => new URL(rel, 'http://x/' + base).pathname.slice(1);

    const partes = [];
    for (const ref of opf.querySelectorAll('spine > itemref')) {
        const item = manifiesto[ref.getAttribute('idref')];
        if (!item || item.tipo !== 'application/xhtml+xml') continue;
        const ruta = dirOpf + item.href;
        const doc = new DOMParser().parseFromString(await zip.file(ruta).async('string'), 'application/xhtml+xml');
        const seccion = doc.querySelector('section.capitulo');
        if (!seccion) continue;  // portada y separadores de bloque: el lector arma los suyos
        for (const img of seccion.querySelectorAll('img[src]')) {
            const archivo = zip.file(resolver(ruta, img.getAttribute('src')));
            if (archivo) img.setAttribute('src', URL.createObjectURL(await archivo.async('blob')));
        }
        partes.push(new XMLSerializer().serializeToString(seccion));
    }
    return partes.join('\n');
}

window.ManualFuente = () => epubListo.then(textoDelEpub);

async function mensajeDeError(resp, respaldo) {
    try {
        const datos = await resp.json();
        return datos.error || respaldo;
    } catch (e) {
        return respaldo;
    }
}

async function traerManual(usuario) {
    mostrar('manual-cargando');
    let resp;
    try {
        const token = await getIdToken(usuario);
        resp = await fetch(URL_MANUAL, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
        $('manual-error').textContent = 'No pudimos conectarnos. Revisá tu conexión y recargá la página.';
        mostrar('manual-sin-acceso');
        rechazarEpub(e);
        return;
    }
    if (resp.status === 401) {
        mostrar('manual-sin-sesion');
        rechazarEpub(new Error('sin sesion'));
        return;
    }
    if (!resp.ok) {
        $('manual-error').textContent = await mensajeDeError(resp, 'No pudimos abrir el manual. Probá de nuevo en unos minutos.');
        mostrar('manual-sin-acceso');
        rechazarEpub(new Error('manual ' + resp.status));
        return;
    }

    const blob = await resp.blob();
    resolverEpub(blob);

    document.querySelectorAll('.manual-email').forEach((el) => { el.textContent = usuario.email || ''; });
    mostrar('manual-listo');
    if (window.gtag) window.gtag('event', 'manual_habilitado');
}

onAuthStateChanged(auth, (usuario) => {
    if (!usuario) {
        mostrar('manual-sin-sesion');
        rechazarEpub(new Error('sin sesion'));
        return;
    }
    traerManual(usuario);
});
