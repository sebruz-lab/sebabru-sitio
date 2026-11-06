// Lector del ebook "Tu identidad en el cielo": pantalla completa, paginado
// como un libro (columnas CSS, un capitulo por vez), indice desplegable,
// tamano de letra, tema papel/noche, y retoma donde se dejo (localStorage).
// Se abre con cualquier [data-abrir-ebook] o entrando con #leer.
// El texto vive en ebook/contenido.html; los glifos, en ebook/glifos.js.
(function () {
    'use strict';

    var VERSION = '3';
    var BASE = document.currentScript && document.currentScript.src
        ? new URL('.', document.currentScript.src).href
        : '/tu-identidad-en-el-cielo/ebook/';
    var CLAVE_POS = 'ebook-identidad:posicion';
    var CLAVE_PREFS = 'ebook-identidad:prefs';
    var TAMANIOS = [16, 17.5, 19, 20.5, 22.5];
    var FUENTES = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,300..500,0..100;1,9..144,300..500,0..100&family=Newsreader:ital,opsz,wght@0,6..72,400..500;1,6..72,400..500&display=swap';

    var ICONOS = {
        indice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
        tema: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/></svg>',
        pantalla: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
        cerrar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    };

    var el = {};
    var capitulos = [];
    var disponibles = [];
    var estado = { abierto: false, cap: -1, pag: 0, pags: 1, W: 0, G: 0, tam: 2, tema: 'papel' };
    var conIndice = false;
    var abridor = null;
    var ignorarClick = false;
    var timerBarras = null;
    var cargado = null;

    // ---------- utilidades ----------
    function guardar(clave, valor) { try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) {} }
    function leer(clave) { try { return JSON.parse(localStorage.getItem(clave)); } catch (e) { return null; } }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function glifos() { return window.EbookGlifos || { signo: function () { return ''; }, planeta: function () { return ''; } }; }
    function glifoPlaneta(p) {
        if (p === 'asc') return '<span class="glifo-ac">AC</span>';
        return p ? glifos().planeta(p) : '';
    }
    function cargarCss(href) {
        return new Promise(function (ok) {
            var l = document.createElement('link');
            l.rel = 'stylesheet'; l.href = href; l.onload = ok; l.onerror = ok;
            document.head.appendChild(l);
        });
    }

    // ---------- contenido ----------
    function cargar() {
        if (cargado) return cargado;
        cargado = Promise.all([
            cargarCss(BASE + 'lector.css?v=' + VERSION),
            fetch(BASE + 'contenido.html?v=' + VERSION).then(function (r) {
                if (!r.ok) throw new Error('contenido ' + r.status);
                return r.text();
            })
        ]).then(function (res) {
            cargarCss(FUENTES);
            prepararContenido(res[1]);
            construir();
        });
        cargado.catch(function () { cargado = null; });
        return cargado;
    }

    function prepararContenido(html) {
        var tpl = document.createElement('template');
        tpl.innerHTML = html;
        capitulos = Array.prototype.map.call(tpl.content.querySelectorAll('section.capitulo'), function (s) {
            var cap = {
                id: s.id,
                titulo: s.getAttribute('data-titulo') || '',
                planeta: s.getAttribute('data-planeta'),
                pendiente: s.hasAttribute('data-pendiente'),
                html: '',
                secciones: []
            };
            if (cap.pendiente) return cap;
            var padre = null;
            Array.prototype.forEach.call(s.querySelectorAll('h3[id], h4[id]'), function (h) {
                var sec = { id: h.id, texto: h.textContent.trim(), nivel: h.tagName === 'H3' ? 3 : 4, signo: h.getAttribute('data-signo') };
                if (sec.nivel === 3) padre = sec; else sec.padre = padre && padre.id;
                cap.secciones.push(sec);
            });
            decorar(s, cap.planeta);
            cap.html = s.innerHTML;
            return cap;
        });
        disponibles = capitulos.filter(function (c) { return !c.pendiente; });
    }

    function decorar(s, planeta) {
        var h2 = s.querySelector('h2');
        if (h2) {
            var ap = document.createElement('div');
            ap.className = 'apertura';
            var gl = glifoPlaneta(planeta);
            if (gl) ap.insertAdjacentHTML('beforeend', '<div class="apertura-glifo">' + gl + '</div>');
            h2.parentNode.insertBefore(ap, h2);
            ap.appendChild(h2);
            ap.insertAdjacentHTML('beforeend', '<span class="apertura-filete" aria-hidden="true"></span>');
            var p = s.querySelector('p');
            if (p) p.classList.add('inicial');
        }
        Array.prototype.forEach.call(s.querySelectorAll('h4[data-signo]'), function (h) {
            h.insertAdjacentHTML('afterbegin', '<span class="h4-glifo">' + glifos().signo(h.getAttribute('data-signo')) + '</span>');
        });
        Array.prototype.forEach.call(s.querySelectorAll('td[data-signo]'), function (td) {
            td.insertAdjacentHTML('afterbegin', glifos().signo(td.getAttribute('data-signo')));
        });
    }

    // ---------- armado del lector ----------
    function construir() {
        var r = document.createElement('div');
        r.className = 'lector';
        r.hidden = true;
        r.lang = 'es';
        r.setAttribute('role', 'dialog');
        r.setAttribute('aria-modal', 'true');
        r.setAttribute('aria-label', 'Tu identidad en el cielo');
        r.innerHTML =
            '<header class="lector-barra lector-arriba">' +
                '<button type="button" class="lb lb-indice" aria-label="Índice" aria-expanded="false">' + ICONOS.indice + '</button>' +
                '<div class="lector-titulo">Tu identidad en el cielo</div>' +
                '<div class="lector-acciones">' +
                    '<button type="button" class="lb lb-letra lb-menos" aria-label="Letra más chica"><small>A</small></button>' +
                    '<button type="button" class="lb lb-letra lb-mas" aria-label="Letra más grande">A</button>' +
                    '<button type="button" class="lb lb-tema" aria-label="Modo noche">' + ICONOS.tema + '</button>' +
                    '<button type="button" class="lb lb-pantalla" aria-label="Pantalla completa">' + ICONOS.pantalla + '</button>' +
                    '<button type="button" class="lb lb-cerrar" aria-label="Cerrar el libro">' + ICONOS.cerrar + '</button>' +
                '</div>' +
            '</header>' +
            '<div class="lector-hoja" tabindex="-1">' +
                '<div class="lector-ventana"><div class="lector-flujo"></div></div>' +
            '</div>' +
            '<footer class="lector-barra lector-abajo">' +
                '<span class="lector-capitulo"></span><span class="lector-pagina"></span>' +
                '<div class="lector-progreso"><i></i></div>' +
            '</footer>' +
            '<div class="lector-velo"></div>' +
            '<nav class="lector-indice" aria-label="Índice">' +
                '<div class="indice-cabeza"><h2>Índice</h2>' +
                '<button type="button" class="lb lb-cerrar-indice" aria-label="Cerrar el índice">' + ICONOS.cerrar + '</button></div>' +
                '<ol></ol>' +
            '</nav>' +
            '<div class="lector-aviso" role="status" aria-live="polite"></div>';
        document.body.appendChild(r);

        el.raiz = r;
        el.hoja = r.querySelector('.lector-hoja');
        el.ventana = r.querySelector('.lector-ventana');
        el.flujo = r.querySelector('.lector-flujo');
        el.capitulo = r.querySelector('.lector-capitulo');
        el.pagina = r.querySelector('.lector-pagina');
        el.progreso = r.querySelector('.lector-progreso i');
        el.indice = r.querySelector('.lector-indice');
        el.aviso = r.querySelector('.lector-aviso');
        el.btnIndice = r.querySelector('.lb-indice');
        el.btnMenos = r.querySelector('.lb-menos');
        el.btnMas = r.querySelector('.lb-mas');
        el.btnTema = r.querySelector('.lb-tema');
        el.btnPantalla = r.querySelector('.lb-pantalla');

        if (!document.documentElement.requestFullscreen) el.btnPantalla.hidden = true;

        construirIndice();
        aplicarPrefs();
        conectarEventos();
    }

    function nombreCorto(texto) {
        var i = texto.lastIndexOf(' en ');
        return i >= 0 ? texto.slice(i + 4) : texto;
    }

    function construirIndice() {
        var html = '';
        capitulos.forEach(function (c) {
            var gl = c.planeta === 'asc' ? '<span class="ix-ac">AC</span>'
                : (c.planeta ? glifos().planeta(c.planeta) : '<span class="ix-sin-glifo"></span>');
            if (c.pendiente) {
                html += '<li class="ix-capitulo pendiente"><span class="ix-link" aria-disabled="true">' + gl +
                    '<span>' + esc(c.titulo) + '</span><span class="ix-pronto">pronto</span></span></li>';
                return;
            }
            html += '<li class="ix-capitulo"><button type="button" class="ix-link ix-cap" data-cap="' + c.id + '">' + gl +
                '<span>' + esc(c.titulo) + '</span></button>';
            var subs = c.secciones.filter(function (s) { return s.nivel === 3; });
            if (subs.length) {
                html += '<ol class="ix-sub">';
                subs.forEach(function (s) {
                    html += '<li><button type="button" class="ix-link" data-cap="' + c.id + '" data-ancla="' + s.id + '">' + esc(s.texto) + '</button>';
                    var hijos = c.secciones.filter(function (h) { return h.nivel === 4 && h.padre === s.id; });
                    if (hijos.length) {
                        html += '<div class="ix-signos">' + hijos.map(function (h) {
                            return '<button type="button" class="ix-link" data-cap="' + c.id + '" data-ancla="' + h.id + '" aria-label="' + esc(h.texto) + '">' +
                                glifos().signo(h.signo) + '<span>' + esc(nombreCorto(h.texto)) + '</span></button>';
                        }).join('') + '</div>';
                    }
                    html += '</li>';
                });
                html += '</ol>';
            }
            html += '</li>';
        });
        el.indice.querySelector('ol').innerHTML = html;
    }

    // ---------- preferencias ----------
    function aplicarPrefs() {
        var p = leer(CLAVE_PREFS) || {};
        var oscuro = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        estado.tema = p.tema === 'noche' || p.tema === 'papel' ? p.tema : (oscuro ? 'noche' : 'papel');
        estado.tam = typeof p.tam === 'number' && TAMANIOS[p.tam] ? p.tam : (window.innerWidth < 500 ? 1 : 2);
        pintarPrefs();
    }
    function pintarPrefs() {
        el.raiz.classList.toggle('tema-noche', estado.tema === 'noche');
        el.btnTema.setAttribute('aria-label', estado.tema === 'noche' ? 'Modo papel' : 'Modo noche');
        el.raiz.style.setProperty('--tam', TAMANIOS[estado.tam] + 'px');
        el.btnMenos.disabled = estado.tam === 0;
        el.btnMas.disabled = estado.tam === TAMANIOS.length - 1;
    }
    function guardarPrefs() { guardar(CLAVE_PREFS, { tema: estado.tema, tam: estado.tam }); }

    // ---------- paginado ----------
    function paginar() {
        var vw = el.raiz.clientWidth, vh = el.raiz.clientHeight;
        var cols = vw >= 1000 && vw > vh * 1.15 ? 2 : 1;
        var G = cols === 2 ? 72 : 44;
        var margen = vw < 700 ? 44 : 120;
        var ideal = Math.round(TAMANIOS[estado.tam] * 33);
        var W = Math.floor(Math.min(vw - margen, cols * ideal + (cols - 1) * G));
        el.ventana.style.width = W + 'px';
        el.ventana.style.marginLeft = (-W / 2) + 'px';
        el.flujo.style.width = W + 'px';
        el.flujo.style.columnCount = cols;
        el.flujo.style.columnGap = G + 'px';
        el.flujo.style.setProperty('--alto-hoja', el.ventana.clientHeight + 'px');
        estado.W = W; estado.G = G;
        var fin = el.flujo.querySelector('.fin-capitulo');
        var x = fin ? fin.getBoundingClientRect().left - el.flujo.getBoundingClientRect().left : 0;
        estado.pags = Math.max(1, Math.floor((x + 1) / (W + G)) + 1);
    }

    function paginaDe(nodo) {
        if (!nodo) return 0;
        var x = nodo.getBoundingClientRect().left - el.flujo.getBoundingClientRect().left;
        return Math.max(0, Math.min(estado.pags - 1, Math.floor((x + 2) / (estado.W + estado.G))));
    }

    function fraccion() { return estado.pags > 1 ? estado.pag / (estado.pags - 1) : 0; }

    function repaginar() {
        if (!estado.abierto || estado.cap < 0) return;
        var f = fraccion();
        paginar();
        mostrarPagina(Math.round(f * (estado.pags - 1)), false);
    }

    function mostrarPagina(p, animar) {
        estado.pag = Math.max(0, Math.min(estado.pags - 1, p));
        if (!animar) el.flujo.classList.add('sin-transicion');
        el.flujo.style.transform = 'translateX(' + (-estado.pag * (estado.W + estado.G)) + 'px)';
        if (!animar) { void el.flujo.offsetWidth; el.flujo.classList.remove('sin-transicion'); }
        actualizarPie();
        guardar(CLAVE_POS, { cap: disponibles[estado.cap].id, frac: fraccion() });
        medirProgreso();
    }

    // Cuanto leen: un evento al llegar al 25, 50, 75 y 100% de cada capitulo
    // (una vez por capitulo y umbral en cada visita).
    var progresoEnviado = {};
    function medirProgreso() {
        if (typeof window.gtag !== 'function' || estado.cap < 0) return;
        var cap = disponibles[estado.cap].id;
        var pct = estado.pags > 1 ? Math.round(estado.pag / (estado.pags - 1) * 100) : 100;
        [25, 50, 75, 100].forEach(function (u) {
            var clave = cap + '_' + u;
            if (pct >= u && !progresoEnviado[clave]) {
                progresoEnviado[clave] = true;
                window.gtag('event', 'ebook_progreso', { libro: 'tu-identidad-en-el-cielo', capitulo: cap, porcentaje: u });
            }
        });
    }

    function irA(capId, op) {
        op = op || {};
        var idx = 0;
        disponibles.forEach(function (c, i) { if (c.id === capId) idx = i; });
        var cambia = idx !== estado.cap;
        function poner() {
            if (cambia) {
                estado.cap = idx;
                el.flujo.innerHTML = disponibles[idx].html + '<span class="fin-capitulo" aria-hidden="true"></span>';
            }
            paginar();
            var p = 0;
            if (op.ancla) p = paginaDe(el.flujo.querySelector('[id="' + op.ancla + '"]'));
            else if (op.final) p = estado.pags - 1;
            else if (op.frac != null) p = Math.round(op.frac * (estado.pags - 1));
            mostrarPagina(p, false);
        }
        if (op.fundido) {
            el.flujo.classList.add('cambiando');
            setTimeout(function () {
                poner();
                requestAnimationFrame(function () { el.flujo.classList.remove('cambiando'); });
            }, 230);
        } else {
            poner();
        }
    }

    function siguiente() {
        ocultarBarras();
        if (estado.pag < estado.pags - 1) mostrarPagina(estado.pag + 1, true);
        else if (estado.cap < disponibles.length - 1) irA(disponibles[estado.cap + 1].id, { fundido: true });
    }
    function anterior() {
        ocultarBarras();
        if (estado.pag > 0) mostrarPagina(estado.pag - 1, true);
        else if (estado.cap > 0) irA(disponibles[estado.cap - 1].id, { final: true, fundido: true });
    }

    function actualizarPie() {
        var c = disponibles[estado.cap];
        el.capitulo.textContent = c ? c.titulo : '';
        el.pagina.textContent = (estado.pag + 1) + ' de ' + estado.pags;
        var total = (estado.cap + (estado.pag + 1) / estado.pags) / disponibles.length;
        el.progreso.style.width = (total * 100).toFixed(1) + '%';
    }

    // ---------- barras, indice, aviso ----------
    function mostrarBarras(conTimer) {
        el.raiz.classList.remove('barras-ocultas');
        clearTimeout(timerBarras);
        if (conTimer) timerBarras = setTimeout(function () { if (!conIndice) ocultarBarras(); }, 3500);
    }
    function ocultarBarras() {
        clearTimeout(timerBarras);
        if (!conIndice) el.raiz.classList.add('barras-ocultas');
    }
    function alternarBarras() {
        if (el.raiz.classList.contains('barras-ocultas')) mostrarBarras(false); else ocultarBarras();
    }

    function marcarIndice() {
        Array.prototype.forEach.call(el.indice.querySelectorAll('.actual'), function (b) { b.classList.remove('actual'); });
        var c = disponibles[estado.cap];
        if (!c) return;
        var bc = el.indice.querySelector('.ix-cap[data-cap="' + c.id + '"]');
        if (bc) bc.classList.add('actual');
        var mejor = null;
        c.secciones.forEach(function (s) {
            var h = el.flujo.querySelector('[id="' + s.id + '"]');
            if (h && paginaDe(h) <= estado.pag) mejor = s;
        });
        if (mejor) {
            var b = el.indice.querySelector('[data-ancla="' + mejor.id + '"]');
            if (b) b.classList.add('actual');
        }
    }
    function abrirIndice() {
        marcarIndice();
        conIndice = true;
        el.raiz.classList.add('con-indice');
        el.btnIndice.setAttribute('aria-expanded', 'true');
        mostrarBarras(false);
        var foco = el.indice.querySelector('.ix-link.actual') || el.indice.querySelector('button.ix-link');
        if (foco) {
            foco.focus({ preventScroll: true });
            if (foco.scrollIntoView) foco.scrollIntoView({ block: 'center' });
        }
    }
    function cerrarIndice() {
        if (!conIndice) return;
        conIndice = false;
        el.raiz.classList.remove('con-indice');
        el.btnIndice.setAttribute('aria-expanded', 'false');
        el.hoja.focus({ preventScroll: true });
    }

    function avisar(texto) {
        el.aviso.textContent = texto;
        el.aviso.classList.add('visible');
        setTimeout(function () { el.aviso.classList.remove('visible'); }, 2600);
    }

    function pantallaCompleta(activar) {
        var d = document.documentElement;
        if (!d.requestFullscreen) return;
        if (activar && !document.fullscreenElement) d.requestFullscreen().catch(function () {});
        else if (!activar && document.fullscreenElement) document.exitFullscreen().catch(function () {});
    }

    // ---------- eventos ----------
    function conectarEventos() {
        el.raiz.querySelector('.lb-cerrar').addEventListener('click', function () { cerrar(false); });
        el.btnIndice.addEventListener('click', function () { if (conIndice) cerrarIndice(); else abrirIndice(); });
        el.raiz.querySelector('.lb-cerrar-indice').addEventListener('click', cerrarIndice);
        el.raiz.querySelector('.lector-velo').addEventListener('click', cerrarIndice);
        el.btnPantalla.addEventListener('click', function () { pantallaCompleta(!document.fullscreenElement); });
        el.btnTema.addEventListener('click', function () {
            estado.tema = estado.tema === 'noche' ? 'papel' : 'noche';
            pintarPrefs(); guardarPrefs(); mostrarBarras(true);
        });
        function cambiarTam(d) {
            var n = Math.max(0, Math.min(TAMANIOS.length - 1, estado.tam + d));
            if (n === estado.tam) return;
            estado.tam = n;
            pintarPrefs(); guardarPrefs(); repaginar(); mostrarBarras(true);
        }
        el.btnMenos.addEventListener('click', function () { cambiarTam(-1); });
        el.btnMas.addEventListener('click', function () { cambiarTam(1); });

        el.indice.addEventListener('click', function (e) {
            var b = e.target.closest('button[data-cap]');
            if (!b) return;
            irA(b.getAttribute('data-cap'), { ancla: b.getAttribute('data-ancla'), fundido: true });
            cerrarIndice();
            ocultarBarras();
        });

        el.hoja.addEventListener('click', function (e) {
            if (ignorarClick || e.target.closest('a, button')) return;
            if (window.getSelection && String(window.getSelection())) return;
            var x = e.clientX / el.raiz.clientWidth;
            if (x < 0.3) anterior();
            else if (x > 0.7) siguiente();
            else alternarBarras();
        });

        var toque = null;
        el.hoja.addEventListener('touchstart', function (e) {
            var t = e.changedTouches[0];
            toque = { x: t.clientX, y: t.clientY };
        }, { passive: true });
        el.hoja.addEventListener('touchend', function (e) {
            if (!toque) return;
            var t = e.changedTouches[0];
            var dx = t.clientX - toque.x, dy = t.clientY - toque.y;
            toque = null;
            if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) {
                ignorarClick = true;
                setTimeout(function () { ignorarClick = false; }, 450);
                if (dx < 0) siguiente(); else anterior();
            }
        }, { passive: true });

        var ultimaRueda = 0;
        el.hoja.addEventListener('wheel', function (e) {
            var d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            if (Math.abs(d) < 12) return;
            e.preventDefault();
            var ahora = Date.now();
            if (ahora - ultimaRueda < 450) return;
            ultimaRueda = ahora;
            if (d > 0) siguiente(); else anterior();
        }, { passive: false });

        document.addEventListener('keydown', function (e) {
            if (!estado.abierto) return;
            if (e.key === 'Escape') { e.preventDefault(); if (conIndice) cerrarIndice(); else cerrar(false); return; }
            if (conIndice) return;
            var enBoton = e.target.closest && e.target.closest('button');
            if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey && !enBoton)) { e.preventDefault(); siguiente(); }
            else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey && !enBoton)) { e.preventDefault(); anterior(); }
            else if (e.key === 'Home') { e.preventDefault(); mostrarPagina(0, true); }
            else if (e.key === 'End') { e.preventDefault(); mostrarPagina(estado.pags - 1, true); }
        });

        var timerResize = null;
        window.addEventListener('resize', function () {
            clearTimeout(timerResize);
            timerResize = setTimeout(repaginar, 150);
        });
        if (document.fonts && document.fonts.addEventListener) {
            document.fonts.addEventListener('loadingdone', function () { setTimeout(repaginar, 50); });
        }
        window.addEventListener('popstate', function () {
            if (estado.abierto && !(history.state && history.state.ebook)) cerrar(true);
        });
    }

    // ---------- abrir / cerrar ----------
    function abrir(e) {
        if (e) {
            e.preventDefault();
            abridor = e.currentTarget;
            pantallaCompleta(true);
        }
        if (estado.abierto) return;
        cargar().then(function () {
            estado.abierto = true;
            document.documentElement.classList.add('ebook-abierto');
            el.raiz.hidden = false;
            var pos = leer(CLAVE_POS);
            var valido = pos && disponibles.some(function (c) { return c.id === pos.cap; });
            estado.cap = -1;
            irA(valido ? pos.cap : disponibles[0].id, { frac: valido ? pos.frac : 0 });
            requestAnimationFrame(function () { el.raiz.classList.add('visible'); });
            if (valido && (pos.frac > 0 || pos.cap !== disponibles[0].id)) avisar('Seguís donde lo dejaste');
            mostrarBarras(true);
            el.hoja.focus({ preventScroll: true });
            if (!(history.state && history.state.ebook)) history.pushState({ ebook: true }, '', '#leer');
            if (window.gtag) window.gtag('event', 'ebook_abierto', { libro: 'tu-identidad-en-el-cielo' });
        }).catch(function () {
            pantallaCompleta(false);
            alert('No pudimos abrir el libro. Probá de nuevo en un rato.');
        });
    }

    function cerrar(desdeHistorial) {
        if (!estado.abierto) return;
        estado.abierto = false;
        cerrarIndice();
        el.raiz.classList.remove('visible');
        setTimeout(function () { if (!estado.abierto) el.raiz.hidden = true; }, 360);
        document.documentElement.classList.remove('ebook-abierto');
        pantallaCompleta(false);
        if (!desdeHistorial && history.state && history.state.ebook) history.back();
        if (abridor && abridor.focus) abridor.focus({ preventScroll: true });
    }

    function iniciar() {
        Array.prototype.forEach.call(document.querySelectorAll('[data-ebook-glifos]'), function (t) {
            t.innerHTML = glifoPlaneta('luna') + glifoPlaneta('asc') + glifoPlaneta('sol');
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-abrir-ebook]'), function (b) {
            b.addEventListener('click', abrir);
        });
        if (location.hash === '#leer') {
            history.replaceState(null, '', location.pathname + location.search);
            abrir(null);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
})();
