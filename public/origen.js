// Origen de la visita: si se llega al sitio con utm_source / utm_medium /
// utm_campaign o gclid en la direccion, se guardan (con la pagina de
// llegada y la fecha) por 60 dias. Cada pago o pedido los manda al
// servidor con window.sbOrigen(), y se ven en /escuela/admin -> Compras.
// Una visita nueva con parametros reemplaza a la anterior.
(function () {
    var CLAVE = 'sb_origen';
    var DIAS = 60;
    try {
        var q = new URLSearchParams(window.location.search);
        var o = {
            source: q.get('utm_source'),
            medium: q.get('utm_medium'),
            campaign: q.get('utm_campaign'),
            gclid: q.get('gclid')
        };
        if (o.source || o.medium || o.campaign || o.gclid) {
            o.landing = window.location.pathname;
            o.fecha = new Date().toISOString();
            var limpio = {};
            for (var k in o) if (o[k]) limpio[k] = String(o[k]).slice(0, 200);
            localStorage.setItem(CLAVE, JSON.stringify(limpio));
        }
    } catch (e) { /* sin localStorage: no se guarda el origen */ }

    window.sbOrigen = function () {
        try {
            var o = JSON.parse(localStorage.getItem(CLAVE) || 'null');
            if (!o || !o.fecha || Date.now() - Date.parse(o.fecha) > DIAS * 864e5) return null;
            return o;
        } catch (e) { return null; }
    };
})();

// Atribucion al copiar: si alguien selecciona y copia un tramo largo del
// sitio, el portapapeles se lleva pegada la firma y la URL de la pagina. No
// impide copiar nada (eso no se puede): hace que la copia llegue firmada al
// lugar donde se pegue.
//
// Va por el evento 'copy' y no por texto escondido en el HTML a proposito.
// Un <span> en font-size:0 consigue lo mismo, pero el texto oculto esta
// nombrado en las politicas de spam de Google y un lector de pantalla lo lee
// igual: quien usa uno se comeria la firma en medio de cada parrafo. Aca no
// hay nada escondido en el DOM.
//
// Esta en origen.js porque es el unico JS que cargan TODAS las paginas,
// incluidas las 196 generadas de /carta-natal/ y las del Kit: asi no hay que
// tocar ningun HTML y el proximo regenerado no lo pisa.
(function () {
    var MINIMO = 200;  // debajo de esto no se firma: copiar una palabra para
                       // buscarla en otro lado tiene que seguir siendo limpio.

    document.addEventListener('copy', function (e) {
        try {
            var a = document.activeElement;
            if (a) {
                var t = (a.tagName || '').toLowerCase();
                if (t === 'input' || t === 'textarea' || a.isContentEditable) return;
            }

            var sel = window.getSelection();
            if (!sel || sel.isCollapsed) return;

            var texto = String(sel);
            if (texto.trim().length < MINIMO) return;

            var url = 'https://sebabru.com' + window.location.pathname;
            var firma = 'Seba Bru, ' + url;

            var dt = e.clipboardData || window.clipboardData;
            if (!dt) return;

            dt.setData('text/plain', texto + '\n\n\u2014 ' + firma);

            var div = document.createElement('div');
            div.appendChild(sel.getRangeAt(0).cloneContents());
            dt.setData(
                'text/html',
                div.innerHTML +
                '<p>&mdash; Seba Bru, <a href="' + encodeURI(url) + '">' +
                encodeURI(url) + '</a></p>'
            );

            e.preventDefault();
        } catch (err) { /* si algo falla, copiar tiene que seguir andando */ }
    });
})();
