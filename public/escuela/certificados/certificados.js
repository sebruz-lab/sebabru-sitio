// Tu titulo de egreso.
//
// Historia corta: esta pagina listaba a todos los egresados con nombre y
// apellido y linkeaba el PDF de cada uno a pdfs/<nombre>.pdf. Como el
// certificado lleva el DNI impreso, eso dejaba un dato personal al aire. En
// noviembre de 2026 los PDF dejaron de publicarse y pasaron a salir por una
// function, con sesion y solo el propio.
//
// Ahora ademas el titulo se emite solo: la persona dice como va escrito su
// nombre, su DNI y sus pronombres, lo ve en una vista previa, confirma, y el
// PDF se arma en el servidor, se descarga y le llega por mail.
//
// Los cuatro certificados viejos siguen bajandose por el camino de antes:
// esa rama es la de #cert-legado y no cambio.
import { auth } from '../firebase.js';
import { onAuthStateChanged, getIdToken } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const BASE = 'https://us-central1-sebabru-e5563.cloudfunctions.net';
const URL_LEGADO = `${BASE}/descargarCertificado`;
const URL_MIS = `${BASE}/misTitulos`;
const URL_EMITIR = `${BASE}/emitirTitulo`;
const URL_DESCARGAR = `${BASE}/descargarTitulo`;

const PRONOMBRES = [
    { id: 'f', etiqueta: 'Femenino' },
    { id: 'm', etiqueta: 'Masculino' },
    { id: 'x', etiqueta: 'Neutro' },
];

const $ = (id) => document.getElementById(id);

const mostrar = (id) => {
    ['cert-cargando', 'cert-sin-sesion', 'cert-nada', 'cert-listo'].forEach((x) => {
        const el = $(x);
        if (el) el.style.display = (x === id) ? 'block' : 'none';
    });
};

const avisar = (texto, bien) => {
    const el = $('cert-aviso');
    if (!el) return;
    el.textContent = texto || '';
    el.style.display = texto ? 'block' : 'none';
    el.style.color = bien ? '#b9e6c4' : '#ffb4b4';
    if (texto) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

const escapar = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

async function token() {
    return getIdToken(auth.currentUser, true);
}

// Lee el error que manda la function, que siempre viene en {error}. Si la
// respuesta no era JSON (un 502 del proxy, por ejemplo), deja el de respaldo.
async function mensajeDeError(resp, respaldo) {
    try {
        const datos = await resp.json();
        if (datos && datos.error) return datos.error;
    } catch (_) { /* no era JSON */ }
    return respaldo;
}

// Baja un blob sin dejar una URL publica dando vueltas.
function bajarBlob(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// -------------------------------------------------------
// La vista previa
// -------------------------------------------------------

// El mismo payload que arma la function, para que lo que se ve sea
// exactamente lo que se imprime. El numero es de muestra hasta que el titulo
// existe de verdad.
function fragmentoDeHoja(datos) {
    const json = JSON.stringify(datos);
    // Al reves que en la hoja: UTF-8 -> bytes -> base64 -> base64url. Sin el
    // paso de encodeURIComponent, el btoa se rompe con cualquier acento.
    const bytes = encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)));
    return btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fechaLarga(fechaISO) {
    if (fechaISO) {
        const [a, m, d] = String(fechaISO).split('-');
        if (a && m && d) return `${Number(d)} de ${MESES[Number(m) - 1]} de ${a}`;
    }
    const hoy = new Date();
    return `${hoy.getDate()} de ${MESES[hoy.getMonth()]} de ${hoy.getFullYear()}`;
}

let confirmarPendiente = null;

// La hoja mide 1123 px de ancho (A4 horizontal a 96 dpi) y se muestra entera
// con un transform: scale(). El factor depende del ancho real de la caja, que
// en CSS no se puede leer, asi que se calcula aca y se ajusta si la ventana
// cambia de tamano.
function ajustarEscalaPrevia() {
    const caja = document.querySelector('.cert-previa-hoja');
    if (!caja || !caja.offsetWidth) return;
    caja.style.setProperty('--cert-escala', caja.offsetWidth / 1123);
}
window.addEventListener('resize', ajustarEscalaPrevia);

function abrirPrevia(payload, alConfirmar) {
    confirmarPendiente = alConfirmar;
    $('cert-previa-frame').src = `../titulo/hoja.html#hoja=${fragmentoDeHoja(payload)}`;
    $('cert-previa').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    ajustarEscalaPrevia();
}

function cerrarPrevia() {
    confirmarPendiente = null;
    $('cert-previa').style.display = 'none';
    // Se vacia el iframe: adentro esta el DNI, no hace falta que siga vivo.
    $('cert-previa-frame').src = 'about:blank';
    document.body.style.overflow = '';
}

// -------------------------------------------------------
// Las tarjetas
// -------------------------------------------------------

function tarjeta(t) {
    const e = t.emitido;
    const campos = `
      <div class="cert-campo">
        <label for="n-${t.id}">Tu nombre y apellido, como va impreso</label>
        <input id="n-${t.id}" type="text" autocomplete="name" maxlength="80"
               value="${escapar(e ? e.nombre : t.sugerido)}">
      </div>
      <div class="cert-campo">
        <label for="d-${t.id}">DNI</label>
        <input id="d-${t.id}" type="text" inputmode="numeric" maxlength="11"
               value="${escapar(e ? e.dni : '')}">
      </div>
      ${t.pidePronombre ? `
      <div class="cert-campo">
        <label for="p-${t.id}">&iquest;Cu&aacute;les son tus pronombres?</label>
        <select id="p-${t.id}">
          ${PRONOMBRES.map((p) => `<option value="${p.id}"${(e ? e.pronombre : 'f') === p.id ? ' selected' : ''}>${p.etiqueta} &mdash; ${escapar(t.titulos[p.id] || '')}</option>`).join('')}
        </select>
        <small>Es lo que decide c&oacute;mo dice el t&iacute;tulo en el diploma.</small>
      </div>` : ''}`;

    return `
    <article class="cert-tarjeta" data-id="${escapar(t.id)}">
      <h2>${escapar(t.curso)}</h2>
      ${e ? `
        <p class="cert-emitido">
          Emitido el ${escapar(e.fechaLarga)} &middot; certificado N&ordm; <strong>${escapar(e.numero)}</strong>
        </p>
        <p class="cert-acciones">
          <button type="button" class="btn-sutil cert-primario" data-accion="bajar">Descargar mi t&iacute;tulo</button>
          <button type="button" class="btn-sutil" data-accion="editar">Corregir mis datos</button>
        </p>
        <p class="cert-nota">Lo mandamos tambi&eacute;n a tu mail. Quien quiera comprobar que es aut&eacute;ntico puede escanear el c&oacute;digo del t&iacute;tulo.</p>
        <div class="cert-form" hidden>
          ${campos}
          <p class="cert-nota">Te quedan ${e.restantes} correcci${e.restantes === 1 ? '&oacute;n' : 'ones'}. El n&uacute;mero de certificado no cambia.</p>
          <p class="cert-acciones">
            <button type="button" class="btn-sutil cert-primario" data-accion="previa">Ver c&oacute;mo queda</button>
            <button type="button" class="btn-sutil" data-accion="cancelar">Dejarlo como est&aacute;</button>
          </p>
        </div>` : `
        <p class="cert-nota">Complet&aacute; tus datos como quer&eacute;s que figuren. Despu&eacute;s vas a poder verlo antes de emitirlo.</p>
        <div class="cert-form">
          ${campos}
          <p class="cert-acciones">
            <button type="button" class="btn-sutil cert-primario" data-accion="previa">Ver c&oacute;mo queda</button>
          </p>
        </div>`}
    </article>`;
}

// -------------------------------------------------------
// Las acciones
// -------------------------------------------------------

function leerFormulario(t, tarjetaEl) {
    const nombre = tarjetaEl.querySelector(`#n-${CSS.escape(t.id)}`).value.trim().replace(/\s+/g, ' ');
    const dni = tarjetaEl.querySelector(`#d-${CSS.escape(t.id)}`).value.replace(/[.\s]/g, '');
    const sel = tarjetaEl.querySelector(`#p-${CSS.escape(t.id)}`);
    const pronombre = sel ? sel.value : 'x';

    if (!nombre || nombre.split(' ').length < 2) {
        return { error: 'Escribí tu nombre y tu apellido, como querés que salga impreso.' };
    }
    if (!/^\d{7,9}$/.test(dni)) {
        return { error: 'El DNI tiene que ser de 7 a 9 números, sin puntos ni letras.' };
    }
    return { nombre, dni, pronombre };
}

async function emitir(t, datos, boton) {
    const textoOriginal = boton.innerHTML;
    boton.disabled = true;
    boton.textContent = 'Emitiendo...';
    try {
        const resp = await fetch(URL_EMITIR, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await token()) },
            body: JSON.stringify({ curso: t.id, ...datos }),
        });
        if (!resp.ok) {
            avisar(await mensajeDeError(resp, 'No pudimos emitir tu título. Probá de nuevo en unos minutos.'));
            return null;
        }
        return await resp.json();
    } catch (_) {
        avisar('No pudimos conectarnos. Revisá tu conexión y probá de nuevo.');
        return null;
    } finally {
        boton.disabled = false;
        boton.innerHTML = textoOriginal;
    }
}

async function bajar(t, boton) {
    avisar('');
    const textoOriginal = boton.innerHTML;
    boton.disabled = true;
    boton.textContent = 'Preparando...';
    try {
        const resp = await fetch(`${URL_DESCARGAR}?curso=${encodeURIComponent(t.id)}`, {
            headers: { Authorization: 'Bearer ' + (await token()) },
        });
        if (!resp.ok) {
            avisar(await mensajeDeError(resp, 'No pudimos armar tu título ahora. Probá de nuevo en unos minutos.'));
            return false;
        }
        bajarBlob(await resp.blob(), `Titulo - ${t.curso}.pdf`);
        return true;
    } catch (_) {
        avisar('No pudimos conectarnos. Revisá tu conexión y probá de nuevo.');
        return false;
    } finally {
        boton.disabled = false;
        boton.innerHTML = textoOriginal;
    }
}

async function descargarLegado(boton) {
    avisar('');
    const textoOriginal = boton.textContent;
    boton.disabled = true;
    boton.textContent = 'Preparando...';
    try {
        const resp = await fetch(URL_LEGADO, { headers: { Authorization: 'Bearer ' + (await token()) } });
        if (!resp.ok) {
            avisar(await mensajeDeError(resp, 'No pudimos preparar tu certificado. Probá de nuevo en unos minutos.'));
            return;
        }
        bajarBlob(await resp.blob(), 'certificado.pdf');
    } catch (_) {
        avisar('No pudimos conectarnos. Revisá tu conexión y probá de nuevo.');
    } finally {
        boton.disabled = false;
        boton.textContent = textoOriginal;
    }
}

// -------------------------------------------------------
// Armado de la pagina
// -------------------------------------------------------

async function pintar() {
    let datos;
    try {
        const resp = await fetch(URL_MIS, { headers: { Authorization: 'Bearer ' + (await token()) } });
        if (!resp.ok) throw new Error(await mensajeDeError(resp, 'No pudimos cargar tus títulos.'));
        datos = await resp.json();
    } catch (e) {
        mostrar('cert-listo');
        avisar(e.message || 'No pudimos cargar tus títulos. Probá de nuevo en unos minutos.');
        return;
    }

    const titulos = datos.titulos || [];
    if (!titulos.length && !datos.legado) return mostrar('cert-nada');

    mostrar('cert-listo');
    $('cert-titulos').innerHTML = titulos.map(tarjeta).join('');
    $('cert-legado').style.display = datos.legado ? 'block' : 'none';

    titulos.forEach((t) => {
        const el = $('cert-titulos').querySelector(`[data-id="${CSS.escape(t.id)}"]`);
        const form = el.querySelector('.cert-form');

        el.addEventListener('click', async (ev) => {
            const boton = ev.target.closest('button[data-accion]');
            if (!boton) return;
            const accion = boton.dataset.accion;
            avisar('');

            if (accion === 'bajar') return bajar(t, boton);
            if (accion === 'editar') { form.hidden = false; return; }
            if (accion === 'cancelar') { form.hidden = true; return; }

            if (accion === 'previa') {
                const datosForm = leerFormulario(t, el);
                if (datosForm.error) return avisar(datosForm.error);

                abrirPrevia({
                    plantilla: t.plantilla,
                    nombre: datosForm.nombre,
                    dni: datosForm.dni,
                    curso: t.curso,
                    titulo: t.titulos[datosForm.pronombre] || t.titulos.x || '',
                    fecha: fechaLarga(t.emitido ? t.emitido.fecha : null),
                    // Hasta que no se emite no hay numero. El de muestra lo
                    // arma el servidor (misTitulos) y termina en XX, para que
                    // quede claro que todavia no es el definitivo.
                    numero: t.emitido ? t.emitido.numero : (t.numeroMuestra || ''),
                    qr: '',
                    // La plantilla 'seminario' no trae el texto escrito en la
                    // hoja: lo recibe en tres tramos. Sin esto la vista previa
                    // sale con el parrafo vacio y no sirve para lo unico que
                    // existe, que es mirar como va a quedar antes de emitir.
                    ...(t.encabezado ? { encabezado: t.encabezado } : {}),
                    ...(t.cuerpo || {}),
                }, async () => {
                    const confirmar = $('cert-previa-confirmar');
                    const emitido = await emitir(t, datosForm, confirmar);
                    cerrarPrevia();
                    if (!emitido) return;

                    await pintar();

                    // La descarga sale sola: es lo que la persona vino a
                    // hacer. Si el navegador la bloquea, el boton sigue ahi.
                    // Va antes del aviso porque bajar() limpia el cartel.
                    const nuevo = $('cert-titulos').querySelector(`[data-id="${CSS.escape(t.id)}"] button[data-accion="bajar"]`);
                    const bajo = nuevo ? await bajar(t, nuevo) : false;

                    // Si la descarga fallo, el cartel que corresponde es el
                    // de ese error, no el de "listo".
                    if (bajo || !nuevo) {
                        avisar(`Listo. Tu título es el ${emitido.numero} y te lo mandamos a tu mail. Acá abajo lo podés volver a bajar cuando quieras.`, true);
                    }
                });
            }
        });
    });
}

$('cert-previa-volver').addEventListener('click', cerrarPrevia);
$('cert-previa-confirmar').addEventListener('click', () => {
    if (confirmarPendiente) confirmarPendiente();
});
document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && $('cert-previa').style.display === 'flex') cerrarPrevia();
});

onAuthStateChanged(auth, (user) => {
    if (!user) return mostrar('cert-sin-sesion');

    document.querySelectorAll('.cert-email').forEach((el) => { el.textContent = user.email; });

    const boton = $('cert-descargar');
    if (boton && !boton.dataset.listo) {
        boton.dataset.listo = '1';
        boton.addEventListener('click', () => descargarLegado(boton));
    }

    pintar();
});
