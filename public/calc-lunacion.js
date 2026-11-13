// Calculadora chica para /lunanueva y /lunallena: la persona pone sus datos
// natales y se le abre sebabru.com/cartas en la vista "Carta Natal +
// lunacion", que le dice en que casa le cae la lunacion mas cercana.
//
// Vive en un modulo aparte (y no pegado en cada pagina) porque esas dos
// paginas se reescriben enteras cada lunacion: asi lo unico que hay que
// mantener ahi es el div con data-calc-lunacion.
//
// Para usarlo:
//   <div data-calc-lunacion></div>
//   <script type="module" src="/calc-lunacion.js?v=1"></script>
import { conectarBuscador, normalizarFecha, completarFecha } from '/cartas/buscador-lugares.js?v=1.16.0';

const TEXTO = 'En esta calculadora vas a poder saberlo con exactitud. '
    + 'Solo poné tus datos natales y enterate.';

const ESTILOS = `
.calc-lunacion .cl-intro { margin: 0 0 18px; }
.calc-lunacion .cl-campo { margin-bottom: 12px; }
.calc-lunacion label {
    display: block; margin-bottom: 5px; font-size: 0.75rem; letter-spacing: 1px;
    text-transform: uppercase; color: #cccac3; font-family: 'Outfit', sans-serif;
}
.calc-lunacion label .cl-opcional { text-transform: none; letter-spacing: 0; opacity: 0.7; }
.calc-lunacion input {
    width: 100%; box-sizing: border-box; padding: 11px 14px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.18);
    border-radius: 10px; color: #fff; font-family: 'Outfit', sans-serif; font-size: 16px;
}
.calc-lunacion input:focus { outline: none; border-color: var(--luna-theme, #3bc2bc); }
.calc-lunacion .cl-fila { display: flex; gap: 10px; }
.calc-lunacion .cl-fila .cl-campo { flex: 1; min-width: 0; }
.calc-lunacion .cl-lugar { position: relative; }
.calc-lunacion .sugerencias {
    list-style: none; margin: 4px 0 0; padding: 4px; position: absolute; z-index: 20;
    left: 0; right: 0; max-height: 220px; overflow-y: auto;
    background: #12141d; border: 1px solid rgba(255,255,255,0.18); border-radius: 10px;
}
.calc-lunacion .sugerencias li {
    padding: 9px 11px; border-radius: 7px; cursor: pointer; color: #cccac3; font-size: 0.79rem;
}
.calc-lunacion .sugerencias li[aria-selected="true"], .calc-lunacion .sugerencias li:hover {
    background: rgba(255,255,255,0.09); color: #fff;
}
.calc-lunacion button {
    width: 100%; margin: 14px 0 10px; padding: 13px 22px; cursor: pointer;
    background: transparent; color: #fff; border: 1px solid #fff; border-radius: 30px;
    font-family: 'Outfit', sans-serif; font-size: 0.875rem; letter-spacing: 1px;
    text-transform: uppercase; transition: background 0.2s ease;
}
.calc-lunacion button:hover { background: rgba(255,255,255,0.14); }
.calc-lunacion .cl-error {
    display: none; margin: 0 0 12px; padding: 10px 14px; border-radius: 10px;
    background: rgba(245,109,150,0.1); border: 1px solid #f56d96; color: #f56d96;
    font-size: 0.75rem;
}
.calc-lunacion .cl-nota { margin: 0; font-size: 0.75rem; text-align: center; line-height: 1.6; }
.calc-lunacion .cl-nota a { color: inherit; text-decoration: underline; }
@media (min-width: 769px) { .calc-lunacion input { font-size: 0.83rem; } }
`;

function ponerEstilos() {
    if (document.getElementById('calc-lunacion-estilos')) return;
    const hoja = document.createElement('style');
    hoja.id = 'calc-lunacion-estilos';
    hoja.textContent = ESTILOS;
    document.head.appendChild(hoja);
}

// JSON -> base64url, como lo lee /cartas/#carta=...
function aBase64Url(texto) {
    const bytes = new TextEncoder().encode(texto);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function armar(caja, n) {
    const id = (parte) => 'cl-' + parte + '-' + n;
    caja.classList.add('calc-lunacion');
    caja.innerHTML = '<p class="cl-intro">' + TEXTO + '</p>'
        + '<p class="cl-error" id="' + id('error') + '" role="alert"></p>'
        + '<form novalidate>'
        + '<div class="cl-campo">'
        + '<label for="' + id('nombre') + '">Nombre <span class="cl-opcional">(opcional)</span></label>'
        + '<input type="text" id="' + id('nombre') + '" maxlength="60" autocomplete="given-name">'
        + '</div>'
        + '<div class="cl-fila">'
        + '<div class="cl-campo">'
        + '<label for="' + id('fecha') + '">Día de nacimiento</label>'
        + '<input type="text" id="' + id('fecha') + '" placeholder="DD/MM/AAAA" maxlength="30" inputmode="numeric" autocomplete="bday">'
        + '</div>'
        + '<div class="cl-campo">'
        + '<label for="' + id('hora') + '">Hora</label>'
        + '<input type="time" id="' + id('hora') + '">'
        + '</div>'
        + '</div>'
        + '<div class="cl-campo cl-lugar">'
        + '<label for="' + id('lugar') + '">Lugar de nacimiento <span class="cl-opcional">(elegilo de la lista)</span></label>'
        + '<input type="text" id="' + id('lugar') + '" maxlength="200" autocomplete="off"'
        + ' role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="' + id('sug') + '">'
        + '<ul class="sugerencias" id="' + id('sug') + '" role="listbox" hidden></ul>'
        + '</div>'
        + '<button type="submit">Ver dónde me cae</button>'
        + '</form>'
        + '<p class="cl-nota">Se abre en una pestaña nueva. '
        + '<a href="/cartas/#vista=lunacion" target="_blank" rel="noopener">O abrí la calculadora vacía</a>.</p>';

    const campo = (parte) => caja.querySelector('#' + id(parte));
    const fecha = campo('fecha');
    const error = campo('error');
    let lugar = null;

    fecha.addEventListener('input', (e) => {
        fecha.value = normalizarFecha(fecha.value, !e.inputType || e.inputType.startsWith('insert'));
    });
    fecha.addEventListener('change', () => { fecha.value = completarFecha(fecha.value); });

    conectarBuscador(campo('lugar'), campo('sug'), (l) => {
        lugar = l && {
            nombre: l.nombre, provincia: l.provincia, pais: l.pais, paisNombre: l.paisNombre,
            lat: l.lat, lon: l.lon, zona: l.zona
        };
    }, { sinResultados: 'No encontramos ese lugar. Probá con otra forma de escribirlo o con la ciudad más cercana.' });

    caja.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const avisar = (msg) => { error.textContent = msg; error.style.display = 'block'; };
        error.style.display = 'none';
        fecha.value = completarFecha(fecha.value);
        const f = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fecha.value);
        const hora = campo('hora').value;
        if (!f) return avisar('Revisá el día de nacimiento: por ejemplo 05/03/1990.');
        if (!/^\d{2}:\d{2}$/.test(hora)) return avisar('Poné la hora de nacimiento (si no la sabés exacta, la más aproximada).');
        if (!lugar) return avisar('Elegí el lugar de nacimiento de la lista que aparece al escribir.');
        const datos = {
            nombre: campo('nombre').value.trim().slice(0, 60),
            fecha: f[3] + '-' + f[2] + '-' + f[1],
            hora,
            lugar
        };
        window.open('/cartas/#carta=' + aBase64Url(JSON.stringify(datos)) + '&vista=lunacion', '_blank', 'noopener');
        if (window.gtag) gtag('event', 'calculadora_abierta', { origen: 'lunacion' });
    });
}

ponerEstilos();
document.querySelectorAll('[data-calc-lunacion]').forEach(armar);
