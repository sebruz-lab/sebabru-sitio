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

    // La rueda arquetipica: la casa 1 es Aries, la 9 es Sagitario. Es la
    // tabla que explica el ebook en su apertura y que no estaba en ninguna
    // parte del sitio.
    var SIGNOS = [
        ['aries', 'Aries'],
        ['tauro', 'Tauro'],
        ['geminis', 'Géminis'],
        ['cancer', 'Cáncer'],
        ['leo', 'Leo'],
        ['virgo', 'Virgo'],
        ['libra', 'Libra'],
        ['escorpio', 'Escorpio'],
        ['sagitario', 'Sagitario'],
        ['capricornio', 'Capricornio'],
        ['acuario', 'Acuario'],
        ['piscis', 'Piscis']
    ];

    // Como se nombra cada punto en "si tu Saturno esta en casa 3". Es
    // tambien la lista de los que llevan la leyenda: los acordeones de
    // casas (casa1-..., casa12-...) no estan aca a proposito, porque ahi
    // el texto YA es por casa y la leyenda seria circular. El acordeon que
    // ocho signos llaman "Ascendente" es casa1-<signo>, asi que tampoco.
    var PUNTOS = {
        sol: 'Sol',
        luna: 'Luna',
        mercurio: 'Mercurio',
        venus: 'Venus',
        marte: 'Marte',
        jupiter: 'Júpiter',
        saturno: 'Saturno',
        quiron: 'Quirón',
        urano: 'Urano',
        neptuno: 'Neptuno',
        pluton: 'Plutón',
        nodonorte: 'Nodo Norte',
        lunanegra: 'Luna Negra'
    };

    // Las paginas de /carta-natal/ usan lunas/ para la Luna, no luna/.
    var CARPETAS = { luna: 'lunas' };

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

        var leyenda = porCasa(caja.dataset.texto);
        if (leyenda) caja.appendChild(leyenda);
    }

    // La leyenda que cierra el acordeon: el mismo texto se puede leer por
    // casa, leyendo el signo al que esa casa corresponde. Cada signo de la
    // tabla enlaza al MISMO punto en ese signo, en /carta-natal/, asi que
    // la persona llega al texto que le toca con un clic.
    //
    // Devuelve null si el id no es de un punto (las casas no la llevan).
    function porCasa(id) {
        if (!id) return null;
        var corte = String(id).lastIndexOf('-');
        if (corte < 1) return null;

        var punto = String(id).slice(0, corte);
        var signo = String(id).slice(corte + 1);
        var nombre = PUNTOS[punto];
        if (!nombre) return null;

        var carpeta = CARPETAS[punto] || punto;

        var det = document.createElement('details');
        det.className = 'porcasa';

        var res = document.createElement('summary');
        res.textContent = 'Si quer\u00e9s saber m\u00e1s sobre este punto en tu carta\u2026';
        det.appendChild(res);

        var cuerpo = document.createElement('div');
        cuerpo.className = 'porcasa-cuerpo';
        cuerpo.appendChild(parrafo(
            'Pod\u00e9s indagar lo que trae tambi\u00e9n por casa. Para eso pod\u00e9s leer ' +
            'el texto del signo al que esa casa corresponde. Esa correspondencia es as\u00ed:'
        ));

        var lista = document.createElement('ul');
        lista.className = 'casas-signos';
        SIGNOS.forEach(function (par, i) {
            var li = document.createElement('li');
            var num = document.createElement('span');
            num.textContent = String(i + 1);
            li.appendChild(num);
            li.appendChild(document.createTextNode(' '));

            // El signo de esta pagina no es enlace: seria un enlace a si misma.
            if (par[0] === signo) {
                var b = document.createElement('b');
                b.textContent = par[1];
                li.appendChild(b);
            } else {
                var a = document.createElement('a');
                a.href = '/carta-natal/' + carpeta + '/' + par[0] + '/';
                a.textContent = par[1];
                li.appendChild(a);
            }
            lista.appendChild(li);
        });
        cuerpo.appendChild(lista);

        var cierre = document.createElement('p');
        cierre.appendChild(document.createTextNode(
            'O sea, que si tu ' + nombre + ' est\u00e1 en casa 3, leer\u00edas el texto que ' +
            'escrib\u00ed para G\u00e9minis. En la '
        ));
        var calc = document.createElement('a');
        calc.href = '/cartas/';
        // Sin data-ga: estas paginas no cargan medicion.js, asi que el
        // atributo no lo leeria nadie. En /carta-natal/ el mismo enlace si
        // lo lleva (ver porCasa() en paginas-textos.js).
        calc.textContent = 'calculadora de la p\u00e1gina';
        cierre.appendChild(calc);
        cierre.appendChild(document.createTextNode(
            ' pod\u00e9s ver en qu\u00e9 casa est\u00e1 cada punto de tu carta.'
        ));
        cuerpo.appendChild(cierre);

        det.appendChild(cuerpo);
        return det;
    }

    function cargar(caja) {
        var id = caja.dataset.texto;
        if (!id || caja.dataset.estado) return;
        caja.dataset.estado = 'cargando';
        caja.appendChild(parrafo('Cargando\u2026'));

        if (cache[id]) { pintar(caja, cache[id]); caja.dataset.estado = 'listo'; return; }

        fetch('/textos/signos/' + id + '.json')
            .then(function (r) {
                if (!r.ok) {
                    var e = new Error(r.status);
                    e.status = r.status;
                    throw e;
                }
                return r.json();
            })
            .then(function (datos) {
                cache[id] = datos;
                pintar(caja, datos);
                caja.dataset.estado = 'listo';
            })
            .catch(function (e) {
                caja.textContent = '';

                // 404 no es un fallo: es un texto que Seba todavia no
                // escribio. Enlazar a /carta-natal/ ahi seria mandar a la
                // persona afuera de la pagina para que lea el mismo aviso.
                if (e && e.status === 404) {
                    caja.appendChild(parrafo(
                        'Este texto todavía no está escrito: ' +
                        'Seba lo publica acá cuando lo termine.'
                    ));
                    caja.dataset.estado = 'vacio';
                    return;
                }

                // Si el texto esta pero no cargo, por lo menos queda el
                // camino a la pagina donde esta: nunca un acordeon vacio.
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
