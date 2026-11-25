// El formulario de inscripcion, en una ventana emergente.
//
// POR QUE EMERGENTE Y NO UN DESPLEGABLE
// El texto de cada año vive en una caja de scrolleo de alto fijo (.subsection,
// el bloque de la home). Un formulario de once campos adentro de 70vh queda
// comprimido, y si son dos años en el mismo bloque -- el segundo curso lleva
// el segundo y el tercer año -- el acordeon de script.js cierra uno al abrir
// el otro, porque son <details> hermanos. La emergente saca el formulario de
// la caja y le da la pantalla entera.
//
// COMO SE USA
// La pagina pone el boton adentro de la caja:
//
//     <button type="button" class="abrir-inscripcion btn-sutil"
//             data-abre="intro27">Inscribite al primer año</button>
//
// y la emergente AFUERA de cualquier .section-container, al final del body:
//
//     <div class="emergente-inscripcion" id="emergente-intro27" ...>
//
// Lo de "afuera" no es una preferencia de orden: .section-container tiene
// transform: scale(1.05) en style.css, y un transform convierte al elemento
// en el bloque contenedor de sus descendientes position:fixed. Adentro, la
// emergente se posicionaria contra la seccion en vez de contra la pantalla.
//
// El formulario de adentro lo arma inscripcion.js como cualquier otro: este
// modulo no sabe nada del formulario, solo abre y cierra la ventana.
//
// Sin comillas tipograficas (ver CLAUDE.md).

const abiertas = [];

function bloquearFondo(bloquear) {
    // Mientras la emergente esta abierta, el fondo no scrollea.
    document.body.style.overflow = bloquear ? 'hidden' : '';
}

function abrir(caja, boton) {
    caja.classList.add('activa');
    caja.removeAttribute('aria-hidden');
    abiertas.push({ caja: caja, boton: boton });
    bloquearFondo(true);
    // El foco entra a la ventana: si no, quien navega con teclado sigue
    // tabulando por la pagina de atras sin ver donde esta.
    const primero = caja.querySelector('input, select, textarea, button');
    if (primero) primero.focus({ preventScroll: true });
}

function cerrar(registro) {
    registro.caja.classList.remove('activa');
    registro.caja.setAttribute('aria-hidden', 'true');
    const i = abiertas.indexOf(registro);
    if (i !== -1) abiertas.splice(i, 1);
    if (!abiertas.length) bloquearFondo(false);
    // El foco vuelve de donde salio.
    if (registro.boton) registro.boton.focus({ preventScroll: true });
}

function cerrarUltima() {
    if (abiertas.length) cerrar(abiertas[abiertas.length - 1]);
}

document.querySelectorAll('.abrir-inscripcion[data-abre]').forEach((boton) => {
    const caja = document.getElementById('emergente-' + boton.dataset.abre);
    if (!caja) return;   // sin su emergente, el boton no hace nada
    boton.addEventListener('click', () => abrir(caja, boton));
});

document.querySelectorAll('.emergente-inscripcion').forEach((caja) => {
    caja.setAttribute('aria-hidden', 'true');

    caja.querySelectorAll('.emergente-cerrar').forEach((x) => {
        x.addEventListener('click', () => {
            const r = abiertas.find((a) => a.caja === caja);
            if (r) cerrar(r);
        });
    });

    // Clic en el fondo oscuro, no adentro de la ventana.
    caja.addEventListener('click', (e) => {
        if (e.target !== caja) return;
        const r = abiertas.find((a) => a.caja === caja);
        if (r) cerrar(r);
    });
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cerrarUltima();
});

// LLEGAR DERECHO AL FORMULARIO
// Hay enlaces de afuera del sitio (mailings, Instagram) que apuntan a
// /formaciones/intro/#form para saltearse el texto. Ese id lo lleva ahora el
// grupo del boton, asi que el navegador scrollea hasta ahi pero el
// formulario sigue cerrado: quien llego buscandolo tendria que buscar otra
// vez. Si el hash cae sobre un boton, o sobre algo que lo contiene, se abre.
function abrirPorHash() {
    const hash = location.hash.slice(1);
    if (!hash) return;
    let destino;
    try {
        destino = document.getElementById(decodeURIComponent(hash));
    } catch (e) {
        return;   // un hash mal escapado no es un error de la pagina
    }
    if (!destino) return;
    const boton = destino.matches('.abrir-inscripcion[data-abre]')
        ? destino
        : destino.querySelector('.abrir-inscripcion[data-abre]');
    if (!boton) return;
    const caja = document.getElementById('emergente-' + boton.dataset.abre);
    if (caja && !caja.classList.contains('activa')) abrir(caja, boton);
}

abrirPorHash();
window.addEventListener('hashchange', abrirPorHash);
