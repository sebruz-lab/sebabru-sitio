// Dibuja la grilla de egresadxs a partir de window.EGRESADXS (perfiles.js).
//
// Botones chicos, no una lista larga: en compu entran de a tres por fila y la
// pagina se lee de un vistazo. El perfil se abre en un emergente, porque un
// acordeon dentro de una grilla empuja a toda la fila de al lado.
//
// El orden es al azar en cada carga: la formacion es una sola y no hay razon
// para que alguien quede siempre primero.
(function () {
    'use strict';

    var lista = document.getElementById('egresadxs-lista');
    var conteo = document.getElementById('egresadxs-conteo');
    var gente = (window.EGRESADXS || []).slice();

    if (!lista) return;

    function escapar(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // "Ramiro Furio Boffa" -> "ramiro-furio-boffa". Sin acentos, porque el
    // enlace lo van a pegar en WhatsApp y ahi un acento queda ilegible.
    function slug(nombre) {
        return String(nombre)
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function iniciales(nombre) {
        var partes = String(nombre).trim().split(/\s+/);
        return ((partes[0] || '')[0] || '') + ((partes[1] || '')[0] || '');
    }

    function tieneContacto(p) {
        return !!(p.whatsapp || p.mail || p.instagram || p.web);
    }

    function tienePerfil(p) {
        return tieneContacto(p) || !!(p.foto || p.bio || p.donde);
    }

    function telefonoLimpio(n) {
        return String(n).replace(/[^0-9]/g, '');
    }

    function botonesDe(p) {
        var b = [];
        if (p.whatsapp) {
            b.push('<a class="egr-contacto egr-wa" target="_blank" rel="noopener"' +
                ' href="https://wa.me/' + escapar(telefonoLimpio(p.whatsapp)) + '">' +
                '<i class="fa-brands fa-whatsapp"></i> WhatsApp</a>');
        }
        if (p.mail) {
            b.push('<a class="egr-contacto" href="mailto:' + escapar(p.mail) + '">' +
                '<i class="fa-solid fa-envelope"></i> Mail</a>');
        }
        if (p.instagram) {
            var usuario = String(p.instagram).replace(/^@/, '');
            b.push('<a class="egr-contacto" target="_blank" rel="noopener"' +
                ' href="https://instagram.com/' + escapar(usuario) + '">' +
                '<i class="fa-brands fa-instagram"></i> @' + escapar(usuario) + '</a>');
        }
        if (p.web) {
            b.push('<a class="egr-contacto" target="_blank" rel="noopener" href="' + escapar(p.web) + '">' +
                '<i class="fa-solid fa-link"></i> Sitio</a>');
        }
        return b.join('');
    }

    function fotoDe(p) {
        if (p.foto) {
            return '<img class="egr-foto" src="' + escapar(p.foto) + '" alt="' + escapar(p.nombre) + '" loading="lazy">';
        }
        return '<span class="egr-foto egr-foto-vacia">' + escapar(iniciales(p.nombre)) + '</span>';
    }

    // Al azar, barajando de verdad (Fisher-Yates): ordenar con un sort y un
    // random deja las primeras posiciones casi siempre iguales.
    for (var i = gente.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = gente[i];
        gente[i] = gente[j];
        gente[j] = tmp;
    }

    var porSlug = {};

    var html = gente.map(function (p) {
        var id = slug(p.nombre);
        porSlug[id] = p;

        if (!tienePerfil(p)) {
            return '<li class="egr-item">' +
                '<div class="egr-boton egr-boton-solo" id="' + id + '">' +
                escapar(p.nombre) + '</div></li>';
        }

        return '<li class="egr-item">' +
            '<button type="button" class="egr-boton" id="' + id + '" data-slug="' + id + '">' +
            '<span>' + escapar(p.nombre) + '</span>' +
            '<i class="fa-solid fa-plus egr-mas" aria-hidden="true"></i></button></li>';
    }).join('');

    lista.innerHTML = html;

    if (conteo) {
        conteo.textContent = gente.length === 1
            ? '1 egresadx'
            : gente.length + ' egresadxs';
    }

    // --- El emergente ---------------------------------------------------

    var fondo = document.getElementById('egr-modal');
    var caja = document.getElementById('egr-modal-cuerpo');
    var ultimoFoco = null;

    function cerrar() {
        if (!fondo) return;
        fondo.hidden = true;
        document.body.classList.remove('egr-sin-scroll');
        if (history.replaceState) {
            history.replaceState(null, '', location.pathname + location.search);
        }
        if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
        ultimoFoco = null;
    }

    function abrir(id, mover) {
        var p = porSlug[id];
        if (!p || !fondo || !caja) return;
        // Sin perfil no hay nada que mostrar: un emergente con el nombre solo
        // y nada mas parece un error. Pasa con un enlace viejo (#nombre) de
        // alguien que todavia no mando sus datos.
        if (!tienePerfil(p)) return;

        caja.innerHTML =
            '<div class="egr-perfil-cuerpo">' +
                fotoDe(p) +
                '<div class="egr-datos">' +
                    '<h2 class="egr-perfil-nombre">' + escapar(p.nombre) + '</h2>' +
                    (p.donde ? '<p class="egr-donde">' + escapar(p.donde) + '</p>' : '') +
                    (p.bio ? '<p class="egr-bio">' + escapar(p.bio) + '</p>' : '') +
                    (tieneContacto(p) ? '<div class="egr-contactos">' + botonesDe(p) + '</div>' : '') +
                    '<button type="button" class="egr-compartir" data-slug="' + id + '"' +
                    ' data-nombre="' + escapar(p.nombre) + '">' +
                    '<i class="fa-solid fa-share-nodes"></i> Compartir este perfil</button>' +
                '</div>' +
            '</div>';

        ultimoFoco = document.getElementById(id);
        fondo.hidden = false;
        document.body.classList.add('egr-sin-scroll');
        var cerrarBtn = fondo.querySelector('.egr-cerrar');
        if (cerrarBtn) cerrarBtn.focus();
        if (mover !== false && history.replaceState) {
            history.replaceState(null, '', '#' + id);
        }
    }

    lista.addEventListener('click', function (e) {
        var boton = e.target.closest('.egr-boton[data-slug]');
        if (boton) abrir(boton.getAttribute('data-slug'));
    });

    if (fondo) {
        fondo.addEventListener('click', function (e) {
            var compartir = e.target.closest('.egr-compartir');
            if (compartir) return compartirPerfil(compartir);
            // Afuera de la tarjeta, o en la cruz.
            if (e.target === fondo || e.target.closest('.egr-cerrar')) cerrar();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !fondo.hidden) cerrar();
        });
    }

    function compartirPerfil(boton) {
        var url = location.origin + location.pathname + '#' + boton.getAttribute('data-slug');
        var nombre = boton.getAttribute('data-nombre');
        var texto = nombre + ', egresadx de la Escuela de Astrologia de Seba Bru.';

        if (navigator.share) {
            navigator.share({ title: nombre, text: texto, url: url }).catch(function () {});
            return;
        }
        var avisar = function (ok) {
            var antes = boton.innerHTML;
            boton.innerHTML = ok
                ? '<i class="fa-solid fa-check"></i> Enlace copiado'
                : '<i class="fa-solid fa-link"></i> ' + escapar(url);
            setTimeout(function () { boton.innerHTML = antes; }, 2500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () { avisar(true); },
                function () { avisar(false); });
        } else {
            avisar(false);
        }
    }

    // Si la direccion ya trae un nombre, abrir ese perfil. El enlace compartido
    // sigue funcionando aunque el orden de la grilla cambie en cada carga.
    function abrirDelHash() {
        var id = decodeURIComponent((location.hash || '').replace(/^#/, ''));
        if (id && porSlug[id]) abrir(id, false);
    }

    abrirDelHash();
    window.addEventListener('hashchange', abrirDelHash);
})();
