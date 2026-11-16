// Dibuja la lista de egresadxs a partir de window.EGRESADXS (perfiles.js).
//
// Acordeon y no ventana emergente a proposito: cada perfil abierto deja su
// propia direccion (#nombre-apellido), asi el boton de compartir manda a la
// persona, no a la lista. Una ventana emergente no se puede enlazar.
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

    // Ordena por nombre completo, sin separar por ano: la formacion es una sola.
    gente.sort(function (a, b) {
        return String(a.nombre).localeCompare(String(b.nombre), 'es');
    });

    var html = gente.map(function (p, i) {
        var id = slug(p.nombre);
        var abrible = tienePerfil(p);
        var panel = 'perfil-' + id;

        var fila = abrible
            ? '<button type="button" class="egr-nombre" id="' + id + '"' +
              ' aria-expanded="false" aria-controls="' + panel + '" data-i="' + i + '">' +
              '<span>' + escapar(p.nombre) + '</span>' +
              '<i class="fa-solid fa-chevron-down egr-flecha" aria-hidden="true"></i></button>'
            : '<div class="egr-nombre egr-nombre-solo" id="' + id + '">' +
              '<span>' + escapar(p.nombre) + '</span></div>';

        if (!abrible) return '<li class="egr-item">' + fila + '</li>';

        var cuerpo =
            '<div class="egr-perfil-cuerpo">' +
                fotoDe(p) +
                '<div class="egr-datos">' +
                    (p.donde ? '<p class="egr-donde">' + escapar(p.donde) + '</p>' : '') +
                    (p.bio ? '<p class="egr-bio">' + escapar(p.bio) + '</p>' : '') +
                    (tieneContacto(p) ? '<div class="egr-contactos">' + botonesDe(p) + '</div>' : '') +
                    '<button type="button" class="egr-compartir" data-slug="' + id + '"' +
                    ' data-nombre="' + escapar(p.nombre) + '">' +
                    '<i class="fa-solid fa-share-nodes"></i> Compartir este perfil</button>' +
                '</div>' +
            '</div>';

        return '<li class="egr-item">' + fila +
            '<div class="egr-perfil" id="' + panel + '" hidden>' + cuerpo + '</div></li>';
    }).join('');

    lista.innerHTML = html;

    if (conteo) {
        conteo.textContent = gente.length === 1
            ? '1 egresadx'
            : gente.length + ' egresadxs';
    }

    function abrir(boton, abrir_) {
        var panel = document.getElementById(boton.getAttribute('aria-controls'));
        if (!panel) return;
        boton.setAttribute('aria-expanded', abrir_ ? 'true' : 'false');
        panel.hidden = !abrir_;
        boton.classList.toggle('egr-abierto', !!abrir_);
    }

    lista.addEventListener('click', function (e) {
        var compartir = e.target.closest('.egr-compartir');
        if (compartir) return compartirPerfil(compartir);

        var boton = e.target.closest('.egr-nombre[aria-controls]');
        if (!boton) return;

        var estaba = boton.getAttribute('aria-expanded') === 'true';
        // Uno por vez: la lista se lee de un vistazo y no se desarma al abrir.
        Array.prototype.forEach.call(
            lista.querySelectorAll('.egr-nombre[aria-controls]'),
            function (otro) { abrir(otro, false); }
        );
        abrir(boton, !estaba);
        if (!estaba && history.replaceState) {
            history.replaceState(null, '', '#' + boton.id);
        }
    });

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

    // Si la direccion ya trae un nombre, abrir ese perfil.
    function abrirDelHash() {
        var id = decodeURIComponent((location.hash || '').replace(/^#/, ''));
        if (!id) return;
        var boton = document.getElementById(id);
        if (!boton || !boton.getAttribute('aria-controls')) return;
        abrir(boton, true);
        boton.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    abrirDelHash();
    window.addEventListener('hashchange', abrirDelHash);
})();
