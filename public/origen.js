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
