// Abre el formulario de suscripcion de /links en una ventana, para que la
// persona no se vaya de la pagina: el widget de /suscribirse.js reemplaza su
// propio contenido por el mensaje de listo, asi que al terminar sigue aca.
//
// El disparador es un enlace de verdad a /suscribirse, no un boton: si este
// script o suscribirse.js no cargan, el click navega a la pagina de siempre
// en vez de no hacer nada. Por eso lo primero que hace es preventDefault.
(function () {
    var abrir = document.getElementById('abrir-suscribirse');
    var modal = document.getElementById('sus-modal');
    if (!abrir || !modal) return;

    var caja = modal.querySelector('.sus-modal-caja');
    // Quien tenia el foco antes de abrir, para devolverselo al cerrar.
    var foco = null;

    // Lo que se puede tabular adentro de la ventana. Se calcula en cada
    // apertura y no una sola vez, porque el widget cambia su contenido: al
    // enviarse bien, el formulario entero desaparece y queda el mensaje.
    function tabulables() {
        return Array.prototype.filter.call(
            caja.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'),
            function (el) {
                return !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null;
            }
        );
    }

    function abrirModal(e) {
        if (e) e.preventDefault();
        foco = document.activeElement;
        modal.hidden = false;
        document.body.classList.add('sus-abierto');
        // Al campo del mail, que es lo que la persona vino a completar. Si el
        // widget ya se envio, al primer elemento que quede.
        var email = caja.querySelector('input[type="email"]');
        var destino = email || tabulables()[0];
        if (destino) destino.focus();
    }

    function cerrarModal() {
        modal.hidden = true;
        document.body.classList.remove('sus-abierto');
        if (foco && foco.focus) foco.focus();
    }

    abrir.addEventListener('click', abrirModal);

    // El fondo y la cruz comparten el atributo: los dos cierran.
    Array.prototype.forEach.call(
        modal.querySelectorAll('[data-cerrar-suscribirse]'),
        function (el) { el.addEventListener('click', cerrarModal); }
    );

    document.addEventListener('keydown', function (e) {
        if (modal.hidden) return;

        if (e.key === 'Escape') return cerrarModal();

        // El foco no se escapa de la ventana mientras esta abierta.
        if (e.key !== 'Tab') return;
        var items = tabulables();
        if (!items.length) return;
        var primero = items[0];
        var ultimo = items[items.length - 1];
        if (!e.shiftKey && document.activeElement === ultimo) {
            e.preventDefault();
            primero.focus();
        } else if (e.shiftKey && document.activeElement === primero) {
            e.preventDefault();
            ultimo.focus();
        }
    });
})();
