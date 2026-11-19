// La pagina madre de /carta-natal/. Tres trabajos, ninguno imprescindible:
// si este archivo no llega, la pagina sigue siendo la lista entera con sus
// 195 enlaces. Por eso el script del <head> saca la clase .estaciones si no
// ve window.__estacionesOk en DOMContentLoaded.
//
//   1. Las estaciones: al abrir se ve solo el titulo, y el resto aparece a
//      los 5 segundos o al primer scroll, lo que pase primero.
//   2. El primer parrafo de cada signo, traido de /textos/punto-<id>.json.
//   3. El evento de GA4 al abrir un signo, para saber en diciembre cuanta
//      gente lee aca y cuanta sigue hasta la hoja.
//
// Sin dependencias y sin innerHTML: todo con createElement y textContent,
// igual que /signos/textos.js, que es de donde sale este patron.
(function () {
    'use strict';

    var raiz = document.documentElement;

    // ------------------------------------------------ 1. las estaciones

    var ESPERA = 5000;
    var revelado = false;
    var movido = false;

    function revelar() {
        if (revelado) return;
        revelado = true;
        raiz.classList.remove('estaciones');
        // Y 5 segundos mas tarde, la pista para seguir bajando.
        setTimeout(pista, ESPERA);
    }

    // El "Deslizá" aparece a los 5 segundos y solo si la persona todavia
    // no se movio: a quien ya esta bajando no hay que decirle que baje.
    function pista() {
        var p = document.querySelector('.deslizar-hint');
        if (!p || movido) return;
        p.hidden = false;
    }

    function alMoverse() {
        movido = true;
        var p = document.querySelector('.deslizar-hint');
        if (p) p.hidden = true;
        revelar();
    }

    if (raiz.classList.contains('estaciones')) {
        window.addEventListener('scroll', alMoverse, { passive: true, once: true });
        setTimeout(revelar, ESPERA);
    } else {
        // Sin estaciones (prefers-reduced-motion), la pista no va: ya esta
        // todo a la vista y no hay nada que anunciar.
        revelado = true;
    }

    // Le avisa al guardia del <head> que este archivo llego y corrio. Si
    // no lo ve, destapa la pagina el solo.
    window.__estacionesOk = true;

    // ------------------------------------------------ 2. los textos

    var cache = {};

    function parrafo(texto, clase) {
        var p = document.createElement('p');
        p.className = clase;
        p.textContent = texto;
        return p;
    }

    // Cuelga el primer parrafo de cada signo arriba de su enlace. El
    // enlace ya estaba en el HTML: esto no crea ninguno.
    function pintar(tarjeta, datos) {
        var porSlug = {};
        (datos.signos || []).forEach(function (s) { porSlug[s.slug] = s; });

        var items = tarjeta.querySelectorAll('.signo-item');
        Array.prototype.forEach.call(items, function (item) {
            var cuerpo = item.querySelector('.signo-cuerpo');
            if (!cuerpo || cuerpo.dataset.pintado) return;
            var dato = porSlug[item.dataset.signo];
            var texto = dato && dato.entrada;
            // Un signo sin texto no dice nada: queda el enlace, que lleva a
            // la pagina donde Seba avisa que esta en proceso.
            if (texto) cuerpo.insertBefore(parrafo(texto, 'entrada'), cuerpo.firstChild);
            cuerpo.dataset.pintado = '1';
        });
    }

    function cargar(tarjeta) {
        var id = tarjeta.dataset.punto;
        // Las casas no tienen data-punto: cada pagina de casa son los doce
        // signos adentro, no hay texto de la casa que traer.
        if (!id || tarjeta.dataset.estado) return;

        if (cache[id]) { pintar(tarjeta, cache[id]); tarjeta.dataset.estado = 'listo'; return; }

        tarjeta.dataset.estado = 'cargando';
        fetch('/textos/punto-' + id + '.json?v=1')
            .then(function (r) {
                if (!r.ok) throw new Error(r.status);
                return r.json();
            })
            .then(function (datos) {
                cache[id] = datos;
                pintar(tarjeta, datos);
                tarjeta.dataset.estado = 'listo';
            })
            .catch(function () {
                // No se muestra ningun aviso: los doce enlaces ya estan en
                // la pagina y siguen funcionando. Lo unico que se pierde es
                // el adelanto. Queda 'error' para poder reintentar.
                tarjeta.dataset.estado = '';
            });
    }

    // ------------------------------------------------ 3. la medicion

    function medir(evento, datos) {
        if (typeof window.gtag !== 'function') return;
        window.gtag('event', evento, datos);
    }

    // ------------------------------------------------ enganche

    var tarjetas = document.querySelectorAll('.punto-card');

    Array.prototype.forEach.call(tarjetas, function (tarjeta) {
        if (tarjeta.open) cargar(tarjeta);
        // Al pasar por encima ya se trae el texto, asi al abrir ya esta.
        tarjeta.addEventListener('mouseenter', function () { cargar(tarjeta); });
        tarjeta.addEventListener('toggle', function () {
            if (!tarjeta.open) return;
            cargar(tarjeta);
            medir('lectura_punto', { punto: tarjeta.dataset.punto || 'casas' });
        });

        var signos = tarjeta.querySelectorAll('.signo-item');
        Array.prototype.forEach.call(signos, function (item) {
            item.addEventListener('toggle', function () {
                if (!item.open) return;
                medir('lectura_signo', {
                    punto: tarjeta.dataset.punto || 'casas',
                    signo: item.dataset.signo,
                });
            });
        });
    });
})();
