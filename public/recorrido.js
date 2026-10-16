// =========================================================
// RECORRIDO ESPACIAL de /lilith y /linaje (la home tiene el suyo en
// script.js). Una "camara" viaja por puntos 2D (data-x/data-y de cada
// .bloque) en vez de bajar en linea recta.
//
// Dos modos, segun la clase "recorrido" en <html> (la pone el script
// del <head> de cada pagina, solo si no hay "reducir movimiento"):
//  - con la clase: recorrido animado.
//  - sin la clase: version plana (recorrido.css). Aca solo se calcula
//    --scroll-progress de cada imagen+texto por su posicion en la pagina.
// Si el recorrido animado falla en cualquier momento, se pasa a la
// version plana: el contenido y los botones de compra nunca quedan
// invisibles. window.__recorridoOk le avisa al <head> que arranco bien.
//
// Anclas: /pagina/#id-de-un-bloque (ej. /lilith/#curso) cae directo en
// ese bloque en los dos modos, y lo mismo los botones data-ir-a-bloque.
// =========================================================
(function () {
    'use strict';

    var html = document.documentElement;
    var escenaTrack = document.getElementById('escena-track');
    if (!escenaTrack) return;
    var escena = document.getElementById('escena');
    var universo = document.getElementById('universo');
    var capaLejana = document.getElementById('capa-lejana');
    var BLOQUES = Array.prototype.slice.call(escenaTrack.querySelectorAll('.bloque'));
    var POS = BLOQUES.map(function (b) { return [parseFloat(b.dataset.x) || 0, parseFloat(b.dataset.y) || 0]; });
    var NB = BLOQUES.length;
    var PARALLAX_MAPA = 0.45;

    // Resistencia del scroll: mismo mecanismo que la home (script.js) — el
    // recorrido persigue con peso el punto que marca el scroll en vez de
    // saltar directo. RESISTENCIA mas chico = mas pesado/lento. Estas
    // paginas tienen recorridos cortos, por eso una resistencia mas
    // liviana que la de la home. Se puede ajustar por pagina con
    // data-resistencia en #escena-track.
    var RESISTENCIA = parseFloat(escenaTrack.dataset.resistencia) || 0.09;
    var segActual = null;
    var plano = !html.classList.contains('recorrido');
    var usuarioScrolleo = false;

    function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    function clamp01(v) { return Math.max(0, Math.min(1, v)); }

    function cargarIframes(el) {
        var pendientes = el.querySelectorAll('iframe[data-src]');
        for (var n = 0; n < pendientes.length; n++) {
            pendientes[n].src = pendientes[n].dataset.src;
            pendientes[n].removeAttribute('data-src');
        }
    }

    // ---------- Version plana ----------
    var shrinks = document.querySelectorAll('.efecto-shrink-container');
    var tickingPlano = false;
    function framePlano() {
        for (var s = 0; s < shrinks.length; s++) {
            var rect = shrinks[s].getBoundingClientRect();
            var pr = clamp01(-rect.top / (rect.height - window.innerHeight));
            shrinks[s].style.setProperty('--scroll-progress', pr);
            shrinks[s].style.setProperty('--progreso-mobile', pr * pr * (3 - 2 * pr));
        }
        tickingPlano = false;
    }
    function onScrollPlano() {
        if (!tickingPlano) {
            window.requestAnimationFrame(framePlano);
            tickingPlano = true;
        }
    }
    function activarPlano() {
        plano = true;
        html.classList.remove('recorrido');
        // Lo que la camara dejo escrito inline (opacidad, posicion) lo pisa
        // recorrido.css con !important; solo hay que reubicar el scroll.
        cargarIframes(document);
        window.addEventListener('scroll', onScrollPlano, { passive: true });
        window.addEventListener('resize', framePlano);
        framePlano();
        var id = idDelHash();
        if (id) irAlBloque(id, false);
    }

    // ---------- Recorrido animado ----------
    function frameRecorrido() {
        // Al saltar a un ancla, el navegador puede "scrollear" la ventana
        // fija (.escena, overflow:hidden) para mostrar el bloque: eso corre
        // todo el universo de lugar. La camara la maneja este script.
        if (escena && (escena.scrollTop || escena.scrollLeft)) { escena.scrollTop = 0; escena.scrollLeft = 0; }

        var scrollable = escenaTrack.offsetHeight - window.innerHeight;
        var p = scrollable > 0 ? clamp01(-escenaTrack.getBoundingClientRect().top / scrollable) : 0;
        var segCrudo = p * (NB - 1);

        if (segActual === null) segActual = segCrudo;
        segActual += (segCrudo - segActual) * RESISTENCIA;
        var seg = segActual;

        var i = Math.floor(seg), f = seg - i, j = Math.min(i + 1, NB - 1);
        var fe = easeInOut(f);
        var camX = POS[i][0] + (POS[j][0] - POS[i][0]) * fe;
        var camY = POS[i][1] + (POS[j][1] - POS[i][1]) * fe;

        universo.style.transform = 'translate(' + (-camX).toFixed(1) + 'px,' + (-camY).toFixed(1) + 'px)';
        if (capaLejana) {
            capaLejana.style.transform = 'translate(' + (-camX * PARALLAX_MAPA).toFixed(1) + 'px,' + (-camY * PARALLAX_MAPA).toFixed(1) + 'px)';
        }

        for (var k = 0; k < NB; k++) {
            var dx = camX - POS[k][0], dy = camY - POS[k][1];
            var d = Math.sqrt(dx * dx + dy * dy);
            var D_MESETA = 60;
            var vis = clamp01(1 - Math.max(0, d - D_MESETA) / 470);
            var b = BLOQUES[k];
            b.style.opacity = vis;
            b.style.visibility = vis > 0.03 ? 'visible' : 'hidden';
            b.style.transform = 'translate(-50%,-50%) translate(' + POS[k][0] + 'px,' + POS[k][1] + 'px) scale(' + (0.92 + 0.08 * vis).toFixed(3) + ')';
            b.style.pointerEvents = vis > 0.6 ? 'auto' : 'none';

            if (b.classList.contains('efecto-shrink-container')) {
                var DWELL_IMG_TEXTO = 0.6;
                var ventana = 1 - DWELL_IMG_TEXTO;
                var localImgTexto = clamp01((seg - (k - ventana)) / ventana);
                b.style.setProperty('--scroll-progress', easeInOut(localImgTexto));

                var DWELL_MOBILE = 0.3;
                var ventanaMobile = 1 - DWELL_MOBILE;
                var lMob = clamp01((seg - (k - ventanaMobile)) / ventanaMobile);
                b.style.setProperty('--progreso-mobile', lMob * lMob * (3 - 2 * lMob));
            }

            if (vis > 0.45) cargarIframes(b);

            // Aviso (una vez por bloque) de que la camara lo dejo a la
            // vista, para medicion.js (data-ga-visible).
            if (vis > 0.6 && !b.__visto) {
                b.__visto = true;
                b.dispatchEvent(new CustomEvent('bloque-visible', { bubbles: true }));
            }
        }
    }

    // ---------- Ir a un bloque (anclas y botones) ----------
    function idDelHash() {
        var id = '';
        try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (e) { return null; }
        return id && document.getElementById(id) ? id : null;
    }

    // En el recorrido aterriza en seg===idx, el pico de foco del bloque
    // (con la ventana DWELL de arriba, ahi el texto ya esta al 100%). En
    // la version plana, un imagen+texto aterriza al final de su tramo
    // sticky (imagen ya corrida, texto visible); el resto, en su inicio.
    function irAlBloque(id, suave) {
        var el = document.getElementById(id);
        if (!el) return false;
        var bloque = el.closest('.bloque') || el;
        var top;
        if (plano) {
            top = bloque.getBoundingClientRect().top + window.pageYOffset;
            if (bloque.classList.contains('efecto-shrink-container')) {
                top += bloque.offsetHeight - window.innerHeight;
            } else {
                top -= parseFloat(window.getComputedStyle(bloque).scrollMarginTop) || 0;
            }
        } else {
            var idx = BLOQUES.indexOf(bloque);
            if (idx < 0) return false;
            var scrollable = escenaTrack.offsetHeight - window.innerHeight;
            top = escenaTrack.offsetTop + scrollable * (idx / Math.max(1, NB - 1));
            // Entrada directa: la camara aparece ahi, sin viajar.
            if (!suave) segActual = null;
        }
        window.scrollTo({ top: Math.max(0, top), behavior: suave ? 'smooth' : 'instant' });
        return true;
    }

    // Links internos a un bloque (href="#id" o data-ir-a-bloque): los
    // resuelve irAlBloque en vez del salto nativo del navegador, que en el
    // recorrido no sabe donde esta cada bloque. Sin JS, el href="#id"
    // igual funciona solo (version plana).
    document.addEventListener('click', function (e) {
        var a = e.target.closest ? e.target.closest('[data-ir-a-bloque], a[href^="#"]') : null;
        if (!a) return;
        var id = a.getAttribute('data-ir-a-bloque') || a.getAttribute('href').slice(1);
        if (!id || !document.getElementById(id)) return;
        e.preventDefault();
        irAlBloque(id, true);
        if (window.history && history.replaceState) history.replaceState(null, '', '#' + id);
    });

    window.addEventListener('hashchange', function () {
        var id = idDelHash();
        if (id) irAlBloque(id, true);
    });

    ['wheel', 'touchstart', 'keydown'].forEach(function (tipo) {
        window.addEventListener(tipo, function () { usuarioScrolleo = true; }, { passive: true, once: true });
    });
    // El navegador hace su propio salto al ancla al terminar de cargar, y
    // puede pisar el nuestro: se repite al "load" si la persona todavia
    // no scrolleo por su cuenta.
    window.addEventListener('load', function () {
        var id = idDelHash();
        if (id && !usuarioScrolleo) irAlBloque(id, false);
    });

    // ---------- Arranque ----------
    if (plano) {
        activarPlano();
        return;
    }

    try {
        var idInicial = idDelHash();
        if (idInicial) irAlBloque(idInicial, false);
        frameRecorrido();
        window.__recorridoOk = true;
    } catch (err) {
        activarPlano();
        return;
    }

    // El recorrido corre en su propio loop continuo (no solo al
    // scrollear): la resistencia necesita seguir animando unos frames
    // mas despues de que el scroll se detiene, para terminar de
    // alcanzar la posicion (igual que la home).
    (function loop() {
        if (plano) return;
        try {
            frameRecorrido();
        } catch (err) {
            activarPlano();
            return;
        }
        window.requestAnimationFrame(loop);
    })();
})();
