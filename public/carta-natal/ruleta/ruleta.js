// PROTOTIPO: el motor de la rueda de puntos de /carta-natal/.
//
// Tres trabajos:
//   1. Girar el aro con el scroll, y marcar quien queda bajo la aguja.
//   2. Abrir el punto que se toca, sin que la persona se vaya de la pagina.
//   3. El "volver a la rueda".
//
// NADA DE ESTO ES IMPRESCINDIBLE. La clase .ruleta la pone un script inline
// del <head> y la saca el mismo si este archivo no llega a correr: sin ella
// la pagina es la grilla de quince recuadros con sus 180 enlaces, y cada
// glifo de la rueda es un enlace de verdad al indice de su punto. Lo unico
// que se pierde si falla el JavaScript es el circulo.
//
// La resistencia del giro se mide EN TIEMPO y no por cuadro, copiando a
// script.js: en un equipo que dibuja a 30 cuadros por segundo, una
// amortiguacion por cuadro llega al destino en la mitad de tiempo y el
// movimiento se siente distinto en cada telefono. Y el bucle se DUERME
// cuando llego: dejarlo corriendo repinta sesenta veces por segundo con la
// pagina quieta, que en un equipo de gama media es bateria y calor.
(function () {
    'use strict';

    var raiz = document.documentElement;
    if (!raiz.classList.contains('ruleta')) return;

    var rueda = document.getElementById('rueda');
    var aro = document.getElementById('rueda-aro');
    var nombre = document.getElementById('rueda-nombre');
    var volver = document.getElementById('rueda-volver');
    if (!rueda || !aro || !nombre) return;

    var puntos = [].slice.call(aro.querySelectorAll('.rueda-punto'));
    var N = puntos.length;
    if (!N) return;

    var PASO = 360 / N;

    // ------------------------------------------------ el giro con el scroll

    // Cuanto scroll vale una vuelta entera. Una vuelta y media de pantalla
    // para los quince puntos: menos que eso y pasan todos de golpe.
    function largoDelBarrido() {
        return window.innerHeight * 1.6;
    }

    // 0 cuando la rueda recien aparece por abajo, 1 cuando ya se fue por
    // arriba. Es la posicion de la rueda en la pantalla, no el scroll de la
    // pagina: asi la rueda gira donde esta y no hace falta una pista de
    // scroll aparte que empuje el panel fuera de la vista.
    function progreso() {
        var caja = rueda.getBoundingClientRect();
        var arranque = window.innerHeight * 0.75;
        var p = (arranque - caja.top) / largoDelBarrido();
        return p < 0 ? 0 : p > 1 ? 1 : p;
    }

    var TAU_ALTA = 260; // ms, equipo que sostiene 60 cuadros
    var TAU_BAJA = 100; // ms, equipo que apenas llega a 30
    var APRENDIZAJE = 300;

    var dtMedio = (navigator.hardwareConcurrency || 8) <= 4 ? 26 : 16.67;

    function tauPara(dt) {
        var gama = (dt - 18) / (34 - 18);
        gama = gama < 0 ? 0 : gama > 1 ? 1 : gama;
        return TAU_ALTA + (TAU_BAJA - TAU_ALTA) * gama;
    }

    var segActual = 0;
    var ultimoCuadro = 0;
    var enFoco = -1;

    function marcarFoco(i) {
        if (i === enFoco) return;
        if (puntos[enFoco]) puntos[enFoco].classList.remove('en-foco');
        enFoco = i;
        puntos[i].classList.add('en-foco');
        nombre.textContent = puntos[i].dataset.nombre || '';
    }

    function cuadro(ahora) {
        var dt = ultimoCuadro ? Math.min(ahora - ultimoCuadro, 100) : 16.67;
        ultimoCuadro = ahora;
        dtMedio += (dt - dtMedio) * Math.min(dt / APRENDIZAJE, 1);
        var tau = tauPara(dtMedio);

        // El destino en "pasos de punto": 0 es el primero bajo la aguja.
        var destino = progreso() * (N - 1);
        var llego = Math.abs(destino - segActual) < 0.0005;
        segActual = llego ? destino : segActual + (destino - segActual) * (1 - Math.exp(-dt / tau));

        aro.style.setProperty('--giro', (-segActual * PASO).toFixed(3) + 'deg');

        var i = Math.round(segActual);
        marcarFoco(i < 0 ? 0 : i > N - 1 ? N - 1 : i);

        return llego;
    }

    var despierto = false;

    function despertar() {
        if (despierto) return;
        despierto = true;
        ultimoCuadro = 0;
        (function bucle(ahora) {
            if (cuadro(ahora || performance.now())) {
                despierto = false;
                return;
            }
            requestAnimationFrame(bucle);
        })();
    }

    window.addEventListener('scroll', despertar, { passive: true });
    window.addEventListener('resize', despertar);
    window.addEventListener('orientationchange', despertar);
    despertar();

    // ------------------------------------------------ abrir y cerrar un punto

    var tarjetas = {};
    [].forEach.call(document.querySelectorAll('.punto-card'), function (t) {
        tarjetas[t.dataset.punto || 'casas'] = t;
    });

    // El titulo que en la grilla daba el <summary>, que la rueda esconde.
    function ponerTitulo(tarjeta, texto) {
        var cuerpo = tarjeta.querySelector('.punto-cuerpo');
        if (!cuerpo || cuerpo.querySelector('.punto-abierto-titulo')) return;
        var h = document.createElement('p');
        h.className = 'punto-abierto-titulo';
        h.textContent = texto;
        cuerpo.insertBefore(h, cuerpo.firstChild);
    }

    function cerrarTodo() {
        for (var k in tarjetas) if (tarjetas[k].open) tarjetas[k].open = false;
        if (volver) volver.hidden = true;
    }

    function abrir(id, texto) {
        var tarjeta = tarjetas[id];
        if (!tarjeta) return false;
        var yaEstaba = tarjeta.open;
        cerrarTodo();
        if (yaEstaba) return true; // tocar el mismo lo cierra
        ponerTitulo(tarjeta, texto);
        // Abrirlo dispara el "toggle" que ya escucha madre.js, que es quien
        // trae la funcion y los primeros parrafos desde /textos/.
        tarjeta.open = true;
        if (volver) volver.hidden = false;
        tarjeta.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return true;
    }

    puntos.forEach(function (a) {
        a.addEventListener('click', function (e) {
            // Si alguien lo abre en una pestaña nueva, que ande como enlace.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            if (abrir(a.dataset.punto, a.dataset.nombre || '')) e.preventDefault();
        });
    });

    if (volver) {
        volver.querySelector('a').addEventListener('click', function () {
            cerrarTodo();
        });
    }

    // Avisa al guardia del <head> que este archivo corrio.
    window.__ruletaOk = true;
})();
