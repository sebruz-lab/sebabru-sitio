// =========================================================
// MEDICION GA4 de las paginas de venta (/lilith, /linaje).
// Independiente de Firebase y del recorrido: si algo de eso falla, los
// clics se siguen midiendo. Todo se declara en el HTML con atributos:
//
//   data-ga="nombre_evento"     evento a enviar al hacer clic (o al
//                               tildar, si es un checkbox)
//   data-ga-producto="curso-lilith" | "libro-lilith" | ...
//   data-ga-nombre="..."        nombre legible del producto
//   data-ga-valor="35000"       valor fijo, o
//   data-ga-precio="id"         id del elemento que muestra el precio
//                               actual (sigue el descuento aplicado)
//   data-ga-moneda="ARS" | "USD"
//   data-ga-metodo, data-ga-origen, data-ga-pais,
//   data-ga-seccion, data-ga-destino            parametros extra
//   data-ga-regalo="id"         id del checkbox "Es para regalar"
//   data-ga-compra              este clic inicia un pago: se recuerda el
//                               producto para medir la compra confirmada
//                               al volver (escuela/abierta/gracias.html)
//   data-ga-visible="evento"    se envia una vez, cuando el elemento queda
//                               a la vista (en el recorrido animado lo
//                               avisa recorrido.js; en la version plana,
//                               el scroll normal)
// =========================================================
(function () {
    'use strict';

    function enviar(nombre, params) {
        if (typeof window.gtag === 'function') window.gtag('event', nombre, params);
    }

    function leerPrecio(el) {
        if (el.dataset.gaValor) return parseFloat(el.dataset.gaValor) || 0;
        var fuente = el.dataset.gaPrecio && document.getElementById(el.dataset.gaPrecio);
        if (!fuente) return null;
        // "$72.000", "USD 45" -> primer numero; los puntos son de miles.
        var m = fuente.textContent.replace(/\./g, '').match(/\d+(,\d+)?/);
        return m ? parseFloat(m[0].replace(',', '.')) : null;
    }

    function paramsDe(el) {
        var d = el.dataset;
        var p = { producto: d.gaProducto || '' };
        if (d.gaMetodo) p.metodo = d.gaMetodo;
        if (d.gaOrigen) p.origen = d.gaOrigen;
        if (d.gaPais) p.pais = d.gaPais;
        if (d.gaSeccion) p.seccion = d.gaSeccion;
        if (d.gaDestino) p.destino = d.gaDestino;
        var valor = leerPrecio(el);
        if (valor !== null) {
            p.value = valor;
            p.currency = d.gaMoneda || 'ARS';
        }
        var chk = d.gaRegalo && document.getElementById(d.gaRegalo);
        if (chk) p.regalo = chk.checked;
        return p;
    }

    function recordarCompra(el, p) {
        try {
            localStorage.setItem('sb_compra_pendiente', JSON.stringify({
                producto: p.producto,
                nombre: el.dataset.gaNombre || p.producto,
                value: p.value || 0,
                currency: p.currency || 'ARS',
                metodo: p.metodo || '',
                regalo: !!p.regalo,
                id: 'pend_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                t: Date.now()
            }));
        } catch (e) { /* sin localStorage: la compra se mide igual, sin valor */ }
    }

    // Captura: se mide antes de que el handler del boton navegue a otra pagina.
    document.addEventListener('click', function (e) {
        var el = e.target.closest ? e.target.closest('[data-ga]') : null;
        if (!el || el.type === 'checkbox') return;
        var p = paramsDe(el);
        enviar(el.dataset.ga, p);
        if (el.hasAttribute('data-ga-compra')) recordarCompra(el, p);
    }, true);

    function medirVisible(el) {
        if (el.__gaVisto) return;
        el.__gaVisto = true;
        enviar(el.dataset.gaVisible, paramsDe(el));
    }
    document.addEventListener('bloque-visible', function (e) {
        if (e.target.hasAttribute && e.target.hasAttribute('data-ga-visible')) medirVisible(e.target);
    });
    function observarVisibles() {
        var els = document.querySelectorAll('[data-ga-visible]');
        if (!els.length || !('IntersectionObserver' in window)) return;
        var obs = new IntersectionObserver(function (entradas) {
            entradas.forEach(function (en) {
                // Con el recorrido animado todos los bloques estan "dentro"
                // de la ventana aunque se vean transparentes: ahi manda el
                // aviso de recorrido.js, no esto.
                if (!en.isIntersecting || document.documentElement.classList.contains('recorrido')) return;
                medirVisible(en.target);
                obs.unobserve(en.target);
            });
        }, { threshold: 0.2 });
        for (var i = 0; i < els.length; i++) {
            // Si recorrido.js ya lo mostro antes de que esto cargara (ej.
            // entrada directa por /lilith/#curso), se mide ahora.
            if (els[i].__visto) medirVisible(els[i]);
            obs.observe(els[i]);
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observarVisibles);
    else observarVisibles();

    document.addEventListener('change', function (e) {
        var el = e.target;
        if (el.type !== 'checkbox' || !el.hasAttribute('data-ga') || !el.checked) return;
        enviar(el.dataset.ga, paramsDe(el));
    }, true);

    // ---------- Profundidad de scroll (25/50/75/90%) ----------
    // Independiente del "scroll" automatico de GA4 (Enhanced measurement,
    // se activa/desactiva desde el panel de GA4, no desde el codigo): esto
    // mide directo contra el alto real del documento, una vez por umbral
    // y por carga de pagina.
    var UMBRALES = [25, 50, 75, 90];
    var umbralesEnviados = {};
    var tickingScroll = false;
    function medirProfundidad() {
        var alto = document.documentElement.scrollHeight - window.innerHeight;
        var pct = alto > 0 ? ((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight) * 100 : 100;
        for (var i = 0; i < UMBRALES.length; i++) {
            var u = UMBRALES[i];
            if (pct >= u && !umbralesEnviados[u]) {
                umbralesEnviados[u] = true;
                enviar('scroll_profundidad', { profundidad: u });
            }
        }
        tickingScroll = false;
    }
    window.addEventListener('scroll', function () {
        if (!tickingScroll) { window.requestAnimationFrame(medirProfundidad); tickingScroll = true; }
    }, { passive: true });
})();
