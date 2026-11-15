// Los textos de los acordeones de /signos/<signo>/.
//
// POR QUE NO ESTAN EN EL HTML DE ESTA PAGINA
//
// Cada uno de estos 200 textos tiene UNA sola pagina rastreable, en
// /carta-natal/. Si tambien estuvieran en el HTML de /signos/, el mismo
// texto viviria en dos URLs del sitio y Google tendria que elegir una, con
// las dos compitiendo por la misma consulta. Se cargan desde
// /textos/signos/<id>.json, que robots.txt tiene en Disallow: Googlebot no
// los puede bajar, y la persona los lee completos sin irse de la pagina.
//
// Los escribe paginas-textos.js (C:\dev\herramientas-sebabru) desde la
// coleccion carta_textos de Firestore.

(function () {
    'use strict';

    var cache = {};

    function parrafo(texto) {
        var p = document.createElement('p');
        p.textContent = texto;
        return p;
    }

    function pintar(caja, datos) {
        caja.textContent = '';

        String(datos.texto)
            .split(/\n\s*\n/)
            .map(function (t) { return t.trim(); })
            .filter(Boolean)
            .forEach(function (t) { caja.appendChild(parrafo(t)); });

        if (datos.imagen) {
            var cita = document.createElement('blockquote');
            cita.className = 'visualizacion ' + (caja.dataset.signo || '');
            var p = document.createElement('p');
            var rotulo = document.createElement('strong');
            rotulo.textContent = 'La imagen:';
            p.appendChild(rotulo);
            p.appendChild(document.createTextNode(' ' + datos.imagen));
            cita.appendChild(p);
            caja.appendChild(cita);
        }

        if (caja.dataset.pagina) {
            var pie = document.createElement('p');
            pie.className = 'seguir';
            var a = document.createElement('a');
            a.href = caja.dataset.pagina;
            a.textContent = (caja.dataset.titulo || 'Leer esta pagina') + ' \u2192';
            pie.appendChild(a);
            caja.appendChild(pie);
        }
    }

    function cargar(caja) {
        var id = caja.dataset.texto;
        if (!id || caja.dataset.estado) return;
        caja.dataset.estado = 'cargando';
        caja.appendChild(parrafo('Cargando\u2026'));

        if (cache[id]) { pintar(caja, cache[id]); caja.dataset.estado = 'listo'; return; }

        fetch('/textos/signos/' + id + '.json')
            .then(function (r) {
                if (!r.ok) throw new Error(r.status);
                return r.json();
            })
            .then(function (datos) {
                cache[id] = datos;
                pintar(caja, datos);
                caja.dataset.estado = 'listo';
            })
            .catch(function () {
                // Si el texto no carga, por lo menos queda el camino a la
                // pagina donde esta: nunca un acordeon vacio.
                caja.textContent = '';
                if (caja.dataset.pagina) {
                    var p = document.createElement('p');
                    var a = document.createElement('a');
                    a.href = caja.dataset.pagina;
                    a.textContent = 'Leer este texto \u2192';
                    p.appendChild(a);
                    caja.appendChild(p);
                } else {
                    caja.appendChild(parrafo('No pude cargar el texto.'));
                }
                caja.dataset.estado = 'error';
            });
    }

    var cajas = document.querySelectorAll('[data-texto]');

    Array.prototype.forEach.call(cajas, function (caja) {
        var det = caja.closest('details');
        if (!det) { cargar(caja); return; }
        if (det.open) cargar(caja);
        det.addEventListener('toggle', function () {
            if (det.open) cargar(caja);
        });
        // Al pasar por encima ya se trae el texto: cuando la persona
        // termina de abrir el acordeon, suele estar puesto.
        det.addEventListener('mouseenter', function () { cargar(caja); });
    });
})();
