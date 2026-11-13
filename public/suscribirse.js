// Formulario de suscripcion a la newsletter, para cualquier pagina del
// sitio. Vive en un modulo aparte (y no pegado en cada pagina) por lo mismo
// que calc-lunacion.js: las paginas de lunaciones se reescriben enteras cada
// mes y lo unico que hay que mantener ahi es el div.
//
// Para usarlo:
//   <div data-suscribirse data-origen="lunanueva"></div>
//   <script src="/suscribirse.js?v=1" defer></script>
//
// data-origen es obligatorio y tiene que estar en la lista cerrada que
// valida la funcion suscribir (home, lunanueva, lunallena, kit, links,
// suscribirse, formulario). data-titulo, data-texto y data-exito (lo que
// dice una vez que la persona ya se anoto) son opcionales.
//
// NO HAY CASILLA, Y ES A PROPOSITO
//
// Donde aparece este widget, suscribirse es lo que la persona vino a hacer:
// apreto un boton que dice suscribite, o entro a pedir el ebook. Pedirle
// ademas que marque una casilla es ponerle un tramite a algo que ya eligio.
// Asi que el consentimiento es apretar el boton, con los terminos escritos
// justo arriba: un acto deliberado e informado, que es lo que pide la ley.
//
// La alternativa que NO se usa es traer la casilla ya marcada. Eso no vale
// como consentimiento y, peor, produce suscriptores que no saben que se
// suscribieron — que es lo que termina en denuncias de spam. Sin casilla no
// hay nada que premarcar.
//
// Donde la suscripcion NO es el motivo de la visita (el modal de ingreso de
// la escuela, la cuenta de la calculadora, el formulario de consultas) hay
// una casilla aparte y DESMARCADA. Esos formularios no usan este widget.
//
// data-canje reemplaza esa linea de terminos cuando la suscripcion es la
// condicion para recibir algo (el ebook). data-boton cambia el boton.
//
// El alta es con doble opt-in: esto no suscribe a nadie, pide el mail de
// confirmacion. Quien no hace clic no entra en la lista.

var URL_SUSCRIBIR = 'https://us-central1-sebabru-e5563.cloudfunctions.net/suscribir';
var SITEKEY = '0x4AAAAAAFwEydZNkPMtSb8Q';

// A proposito no se promete un numero de mails por mes: la lista manda
// lo que el cielo vaya pidiendo, y un numero escrito es una promesa que
// despues hay que cumplir.
var TITULO = 'Cerca del cielo, por mail';
var TEXTO = 'Contenidos astrológicos gratuitos para mantenerte cerca del cielo y sus '
    + 'movimientos: los informes de cada luna, los textos de cada signo, el podcast de '
    + 'los tránsitos y lo que vaya apareciendo.';

var ESTILOS = `
.suscribirse {
    max-width: 520px; margin: 80px auto; padding: 30px 26px; box-sizing: border-box;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px; font-family: 'Outfit', sans-serif;
}
.suscribirse .sus-titulo {
    margin: 0 0 14px; font-size: 0.82rem; font-weight: 300; color: #fff;
    text-transform: uppercase; letter-spacing: 0.1em; line-height: 1.5;
}
.suscribirse .sus-intro { margin: 0 0 24px; color: #cccac3; font-size: 0.92rem; line-height: 1.7; }
.suscribirse .sus-campo { margin-bottom: 20px; }
.suscribirse label {
    display: block; margin-bottom: 6px; font-size: 0.7rem; letter-spacing: 1px;
    text-transform: uppercase; color: #cccac3;
}
.suscribirse label .sus-opcional { text-transform: none; letter-spacing: 0; opacity: 0.7; }
.suscribirse input[type="email"], .suscribirse input[type="text"] {
    width: 100%; box-sizing: border-box; padding: 9px 2px;
    background: transparent; border: none; border-bottom: 1px solid rgba(255,255,255,0.18);
    border-radius: 0; color: #fff; font-family: 'Outfit', sans-serif; font-size: 16px;
}
.suscribirse input[type="email"]:focus, .suscribirse input[type="text"]:focus {
    outline: none; border-bottom-color: #fff;
}
.suscribirse .sus-canje {
    margin: 0 0 24px; color: #cccac3; font-size: 0.82rem; line-height: 1.6;
}
.suscribirse .sus-canje a { color: inherit; text-decoration: underline; }
.suscribirse .sus-trampa {
    position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden;
}
.suscribirse button {
    width: 100%; padding: 13px 20px; background: #fff; color: #000; border: 1px solid #fff;
    border-radius: 10px; font-family: 'Outfit', sans-serif; font-size: 0.86rem;
    letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer;
    transition: background 0.25s ease, color 0.25s ease;
}
.suscribirse button:hover:not(:disabled) { background: transparent; color: #fff; }
.suscribirse button:disabled { opacity: 0.55; cursor: default; }
.suscribirse .sus-error {
    display: none; margin: 0 0 18px; padding: 11px 13px; border-radius: 9px;
    background: rgba(255,120,120,0.09); border: 1px solid rgba(255,120,120,0.3);
    color: #ffc9c9; font-size: 0.85rem; line-height: 1.6;
}
.suscribirse .sus-error button {
    width: auto; margin-top: 9px; padding: 7px 14px; font-size: 0.75rem;
    background: transparent; color: #ffc9c9; border-color: rgba(255,120,120,0.45);
}
.suscribirse .sus-captcha { margin-bottom: 18px; }
.suscribirse .sus-listo { margin: 0; color: #fff; font-size: 0.95rem; line-height: 1.75; }
.suscribirse .sus-listo strong { font-weight: 400; }
.suscribirse .sus-listo .sus-nota {
    display: block; margin-top: 12px; color: #cccac3; font-size: 0.82rem;
}
@media (min-width: 769px) {
    .suscribirse { padding: 38px 34px; }
    .suscribirse input[type="email"], .suscribirse input[type="text"] { font-size: 0.95rem; }
}
`;

function ponerEstilos() {
    if (document.getElementById('suscribirse-estilos')) return;
    var hoja = document.createElement('style');
    hoja.id = 'suscribirse-estilos';
    hoja.textContent = ESTILOS;
    document.head.appendChild(hoja);
}

// El captcha se carga recien cuando la persona toca el formulario: son unos
// 60 KB que no hacen falta para la gran mayoria de las visitas.
var cargaCaptcha = null;
function cargarCaptcha() {
    if (cargaCaptcha) return cargaCaptcha;
    cargaCaptcha = new Promise(function (listo, falla) {
        var s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.defer = true;
        s.onload = function () { listo(); };
        s.onerror = function () { falla(new Error('no cargo el captcha')); };
        document.head.appendChild(s);
    });
    return cargaCaptcha;
}

// Un token del captcha. appearance interaction-only quiere decir que la
// persona solo ve algo si Cloudflare sospecha de ella; en el caso normal es
// invisible. Si el captcha no carga devuelve vacio y el servidor contesta
// captcha_requerido, que se le explica abajo.
function pedirToken(estado) {
    // Un corte para TODO el flujo: cargar el script y conseguir el token. Si
    // el captcha esta bloqueado por una extension, o la red se corta a mitad,
    // el script puede no cargar nunca y tampoco dar error. Sin esto, el boton
    // se queda apagado para siempre y la persona no entiende que paso. Con
    // esto seguimos sin token: el servidor contesta captcha_requerido y abajo
    // se le explica.
    var corte;
    var seRindio = new Promise(function (listo) {
        corte = setTimeout(function () { listo(''); }, 15000);
    });
    return Promise.race([pedirTokenAlCaptcha(estado), seRindio])
        .then(function (token) { clearTimeout(corte); return token; });
}

function pedirTokenAlCaptcha(estado) {
    return cargarCaptcha().then(function () {
        if (estado.widget === null) {
            estado.widget = window.turnstile.render(estado.cajaCaptcha, {
                sitekey: SITEKEY,
                appearance: 'interaction-only',
                execution: 'execute',
                callback: function (token) { estado.entregar(token); },
                'error-callback': function () { estado.entregar(''); },
                'expired-callback': function () { estado.entregar(''); },
            });
        } else {
            window.turnstile.reset(estado.widget);
        }
        return new Promise(function (listo) {
            estado.entregar = function (token) {
                estado.entregar = function () {};
                listo(token || '');
            };
            window.turnstile.execute(estado.widget);
        });
    }).catch(function () { return ''; });
}

function armar(caja, n) {
    var id = function (parte) { return 'sus-' + parte + '-' + n; };
    var origen = caja.getAttribute('data-origen') || 'home';
    var titulo = caja.getAttribute('data-titulo') || TITULO;
    var texto = caja.getAttribute('data-texto') || TEXTO;
    // Lo que dice al terminar. La pagina del ebook lo cambia, porque ahi
    // lo que llega no es una bienvenida: es el libro.
    var exito = caja.getAttribute('data-exito') || '';
    // La linea de terminos que va arriba del boton. Por omision dice que
    // te vamos a escribir; la pagina del ebook la cambia por el trato.
    var canje = caja.getAttribute('data-canje')
        || 'Al anotarte te empiezan a llegar los contenidos astrológicos por mail.';
    var textoBoton = caja.getAttribute('data-boton') || 'Suscribirme';

    caja.classList.add('suscribirse');
    caja.innerHTML = '<h3 class="sus-titulo">' + titulo + '</h3>'
        + '<p class="sus-intro">' + texto + '</p>'
        + '<p class="sus-error" id="' + id('error') + '" role="alert"></p>'
        + '<form novalidate>'
        + '<div class="sus-campo">'
        + '<label for="' + id('email') + '">Tu mail</label>'
        + '<input type="email" id="' + id('email') + '" maxlength="200" autocomplete="email" '
        + 'inputmode="email" placeholder="nombre@correo.com" required>'
        + '</div>'
        + '<div class="sus-campo">'
        + '<label for="' + id('nombre') + '">Nombre <span class="sus-opcional">(opcional)</span></label>'
        + '<input type="text" id="' + id('nombre') + '" maxlength="100" autocomplete="given-name">'
        + '</div>'
        // La trampa para los bots: no se ve, no se puede tabular hasta ella
        // y el navegador no la autocompleta. Si viene con algo, el servidor
        // contesta que salio bien y no hace nada.
        + '<div class="sus-trampa" aria-hidden="true">'
        + '<label for="' + id('hp') + '">No completar</label>'
        + '<input type="text" id="' + id('hp') + '" name="website" tabindex="-1" autocomplete="off">'
        + '</div>'
        + '<p class="sus-canje">' + canje + ' '
        + '<a href="/privacidad/">Cómo cuidamos tus datos</a>.</p>'
        + '<div class="sus-captcha" id="' + id('captcha') + '"></div>'
        + '<button type="submit">' + textoBoton + '</button>'
        + '</form>';

    var form = caja.querySelector('form');
    var error = caja.querySelector('#' + id('error'));
    var email = caja.querySelector('#' + id('email'));
    var nombre = caja.querySelector('#' + id('nombre'));
    var trampa = caja.querySelector('#' + id('hp'));
    var boton = caja.querySelector('button[type="submit"]');

    var estado = {
        widget: null,
        cajaCaptcha: caja.querySelector('#' + id('captcha')),
        entregar: function () {},
    };

    // Precargar el captcha en cuanto la persona muestra intencion de
    // escribir, asi no espera nada al apretar el boton.
    email.addEventListener('focus', function () { cargarCaptcha().catch(function () {}); }, { once: true });

    var avisar = function (mensaje, html) {
        error.innerHTML = html || '';
        if (!html) error.textContent = mensaje;
        error.style.display = 'block';
    };
    var limpiarAviso = function () { error.style.display = 'none'; error.innerHTML = ''; };

    var mostrarListo = function (estadoAlta, direccion) {
        var textos = {
            suscrito: (exito || 'Listo, ya estás en la lista. Te mandamos un mail de bienvenida a <strong>'
                + direccion + '</strong>.')
                + '<span class="sus-nota">Si no lo ves, mirá en spam o en promociones.</span>',
            demorado: 'Te anotamos. El mail de bienvenida puede demorar un rato en llegar.'
                + '<span class="sus-nota">Si no llega, escribinos a info@sebabru.com.</span>',
            ya_suscrito: 'Ya estabas en la lista. Nos vemos en el próximo mail.',
        };
        caja.innerHTML = '<h3 class="sus-titulo">' + titulo + '</h3>'
            + '<p class="sus-listo">' + (textos[estadoAlta] || textos.suscrito) + '</p>';
    };

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        limpiarAviso();

        var direccion = email.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(direccion)) {
            email.focus();
            return avisar('Revisá el mail: parece que falta algo.');
        }
        boton.disabled = true;
        boton.textContent = 'Enviando...';
        var terminar = function () {
            boton.disabled = false;
            boton.textContent = textoBoton;
        };

        pedirToken(estado).then(function (token) {
            return fetch(URL_SUSCRIBIR, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: direccion,
                    nombre: nombre.value.trim(),
                    origen: origen,
                    consentimiento: true,
                    captchaToken: token,
                    hp: trampa.value,
                    utm: (window.sbOrigen && window.sbOrigen()) || null,
                }),
            });
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (data) {
                return { ok: r.ok, status: r.status, data: data };
            });
        }).then(function (resp) {
            if (resp.ok && resp.data.ok) {
                if (window.gtag) gtag('event', 'suscripcion', { origen: origen });
                return mostrarListo(resp.data.estado, direccion);
            }

            terminar();
            var fallo = resp.data.error;

            if (fallo === 'email_sospechoso' && resp.data.sugerencia) {
                var sugerida = String(resp.data.sugerencia).replace(/[<>&"]/g, '');
                avisar('', 'Puede que haya un error de tipeo. ¿Quisiste decir <strong>'
                    + sugerida + '</strong>?<br><button type="button">Sí, usar ese</button>');
                error.querySelector('button').addEventListener('click', function () {
                    email.value = sugerida;
                    limpiarAviso();
                    form.dispatchEvent(new Event('submit', { cancelable: true }));
                });
                return;
            }
            if (fallo === 'captcha_requerido') {
                return avisar('No pudimos verificar que no sos un robot. Recargá la página y probá de nuevo.');
            }
            if (fallo === 'consentimiento_requerido') {
                return avisar('Para suscribirte necesitamos que marques la casilla.');
            }
            if (fallo === 'email_invalido') {
                return avisar('Revisá el mail: parece que falta algo.');
            }
            if (fallo === 'dominio_sin_correo') {
                // El servidor no encontro servidores de correo en ese
                // dominio: casi siempre es un error de tipeo despues de la
                // arroba.
                return avisar('No encontramos ese dominio de correo. Revisá lo que va después de la arroba.');
            }
            if (fallo === 'no_configurado') {
                // El formulario esta publicado pero el mailing todavia no
                // quedo configurado. El pedido no se pierde, pero no le
                // prometemos un mail que no va a salir.
                return avisar('Todavía no tenemos la suscripción abierta. Escribinos a info@sebabru.com y te anotamos a mano.');
            }
            if (resp.status === 429) {
                return avisar(resp.data.error || 'Probá de nuevo en unos minutos.');
            }
            avisar('No pudimos anotarte ahora. Probá de nuevo en un rato, o escribinos a info@sebabru.com.');
        }).catch(function () {
            terminar();
            avisar('No pudimos conectarnos. Revisá tu conexión y probá de nuevo.');
        });
    });
}

ponerEstilos();
document.querySelectorAll('[data-suscribirse]').forEach(armar);
