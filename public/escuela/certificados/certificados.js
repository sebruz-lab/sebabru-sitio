// Descarga del certificado de egreso.
//
// Antes esta pagina listaba a todos los egresados con nombre y apellido y
// linkeaba el PDF de cada uno a /escuela/certificados/pdfs/<nombre>.pdf. Como
// cada certificado lleva el DNI impreso, eso dejaba un dato personal al aire:
// el archivo se bajaba sin sesion y el nombre era adivinable. Desde el
// 2026-11-13 los PDF no se publican: viven con las Cloud Functions y los
// entrega descargarCertificado, con sesion iniciada y solo el propio.
import { auth } from '../firebase.js';
import { onAuthStateChanged, getIdToken } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const URL_CERTIFICADO = 'https://us-central1-sebabru-e5563.cloudfunctions.net/descargarCertificado';

const mostrar = (id) => {
    ['cert-cargando', 'cert-sin-sesion', 'cert-listo'].forEach((x) => {
        const el = document.getElementById(x);
        if (el) el.style.display = (x === id) ? 'block' : 'none';
    });
};

const avisar = (texto) => {
    const el = document.getElementById('cert-aviso');
    if (!el) return;
    el.textContent = texto;
    el.style.display = texto ? 'block' : 'none';
};

async function descargar(boton) {
    avisar('');
    const textoOriginal = boton.textContent;
    boton.disabled = true;
    boton.textContent = 'Preparando...';

    try {
        const token = await getIdToken(auth.currentUser, true);
        const resp = await fetch(URL_CERTIFICADO, { headers: { Authorization: 'Bearer ' + token } });

        if (!resp.ok) {
            let mensaje = 'No pudimos preparar tu certificado. Probá de nuevo en unos minutos.';
            try {
                const datos = await resp.json();
                if (datos && datos.error) mensaje = datos.error;
            } catch (_) { /* la respuesta no era JSON */ }
            avisar(mensaje);
            return;
        }

        // El PDF llega en el cuerpo de la respuesta, no por una URL: asi no
        // queda un enlace publico dando vueltas.
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'certificado.pdf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (e) {
        avisar('No pudimos conectarnos. Revisá tu conexión y probá de nuevo.');
    } finally {
        boton.disabled = false;
        boton.textContent = textoOriginal;
    }
}

onAuthStateChanged(auth, (user) => {
    if (!user) return mostrar('cert-sin-sesion');

    mostrar('cert-listo');
    const quien = document.getElementById('cert-email');
    if (quien) quien.textContent = user.email;

    const boton = document.getElementById('cert-descargar');
    if (boton && !boton.dataset.listo) {
        boton.dataset.listo = '1';
        boton.addEventListener('click', () => descargar(boton));
    }
});
