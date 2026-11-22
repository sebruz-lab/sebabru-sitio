// Borradores de formulario.
//
// Ningun formulario del sitio se vacia cuando falla un envio: los valores
// quedan en pantalla. Lo que si se perdia, y entero, era cerrar la pestana a
// mitad de camino — o que iOS descarte el iframe al cambiar de app, que es
// como se llena el formulario de consultas en la practica. Diez campos,
// incluido el lugar de nacimiento, que la persona ya peleo una vez.
//
// Esto guarda lo escrito en el propio navegador mientras se escribe, lo
// ofrece al volver, y lo borra apenas el envio sale bien.
//
// Tres reglas:
//
//  1. Las contrasenas NO se guardan, nunca. Ni el honeypot: si se restaurara
//     un honeypot con contenido, el servidor tomaria a la persona por un bot.
//  2. Todo va envuelto en try/catch. En una ventana privada localStorage
//     puede tirar al leerlo o al escribirlo, y un formulario que no anda por
//     culpa de su red de seguridad es peor que uno sin red.
//  3. No se restaura en silencio. Aparece un aviso con un boton para
//     descartar: encontrarse campos llenos sin saber por que confunde mas de
//     lo que ayuda, sobre todo si son de hace una semana.
(function (global) {
    'use strict';

    var PREFIJO = 'sb_borrador_';
    // Si cambia la forma de lo guardado, subir esto invalida lo viejo.
    var VERSION = 1;
    // Un borrador de hace mas de una semana ya no le sirve a nadie.
    var VENCE_MS = 7 * 24 * 60 * 60 * 1000;

    function leer(clave) {
        try {
            var crudo = localStorage.getItem(clave);
            if (!crudo) return null;
            var dato = JSON.parse(crudo);
            if (!dato || dato.v !== VERSION) return null;
            if (Date.now() - (dato.t || 0) > VENCE_MS) {
                localStorage.removeItem(clave);
                return null;
            }
            return dato.campos || null;
        } catch (e) {
            return null;
        }
    }

    function guardar(clave, campos) {
        try {
            localStorage.setItem(clave, JSON.stringify({ v: VERSION, t: Date.now(), campos: campos }));
        } catch (e) { /* sin espacio o sin localStorage: se sigue igual */ }
    }

    function borrar(clave) {
        try { localStorage.removeItem(clave); } catch (e) {}
    }

    // Que campos se guardan. Fuera: contrasenas, honeypot, botones, archivos
    // y cualquier cosa sin nombre.
    function guardables(form) {
        var salida = [];
        var campos = form.querySelectorAll('input, select, textarea');
        for (var i = 0; i < campos.length; i++) {
            var c = campos[i];
            var tipo = (c.type || '').toLowerCase();
            if (tipo === 'password' || tipo === 'hidden' || tipo === 'file'
                || tipo === 'submit' || tipo === 'button') continue;
            if (c.name === 'website' || /(^|[-_])hp([-_]|$)/.test(c.id || '')) continue;
            if (c.getAttribute('data-sin-borrador') !== null) continue;
            var nombre = c.id || c.name;
            if (!nombre) continue;
            salida.push({ nombre: nombre, campo: c, tipo: tipo });
        }
        return salida;
    }

    function tomar(form) {
        var campos = {};
        var lista = guardables(form);
        var hayAlgo = false;
        for (var i = 0; i < lista.length; i++) {
            var c = lista[i].campo;
            var valor = (lista[i].tipo === 'checkbox' || lista[i].tipo === 'radio')
                ? c.checked : c.value;
            if (valor === '' || valor === false) continue;
            campos[lista[i].nombre] = valor;
            hayAlgo = true;
        }
        return hayAlgo ? campos : null;
    }

    function poner(form, campos) {
        var lista = guardables(form);
        var puestos = 0;
        for (var i = 0; i < lista.length; i++) {
            var nombre = lista[i].nombre;
            if (!Object.prototype.hasOwnProperty.call(campos, nombre)) continue;
            var c = lista[i].campo;
            if (lista[i].tipo === 'checkbox' || lista[i].tipo === 'radio') {
                c.checked = Boolean(campos[nombre]);
            } else {
                c.value = campos[nombre];
            }
            // Para que reaccionen los que escuchan input/change (el buscador
            // de lugares, las validaciones que pintan el campo en rojo).
            try {
                c.dispatchEvent(new Event('input', { bubbles: true }));
                c.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {}
            puestos++;
        }
        return puestos;
    }

    // Vacia los campos a mano. No se usa form.reset() porque el contenedor no
    // siempre es un <form> (en el pedido del libro los campos cuelgan de un
    // div), y porque reset() vuelve al valor del HTML, no al vacio.
    function vaciar(form) {
        var lista = guardables(form);
        for (var i = 0; i < lista.length; i++) {
            var c = lista[i].campo;
            if (lista[i].tipo === 'checkbox' || lista[i].tipo === 'radio') c.checked = false;
            else c.value = '';
            try {
                c.dispatchEvent(new Event('input', { bubbles: true }));
                c.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {}
        }
    }

    function avisoDeRestaurado(form, alDescartar) {
        var caja = document.createElement('div');
        caja.setAttribute('role', 'status');
        caja.style.cssText = 'margin:0 0 16px;padding:10px 14px;border:1px solid currentColor;'
            + 'border-radius:6px;font-size:0.9em;line-height:1.5;opacity:0.85;';
        var texto = document.createElement('span');
        texto.textContent = 'Recuperamos lo que habías empezado a completar. ';
        var boton = document.createElement('button');
        boton.type = 'button';
        boton.textContent = 'Empezar de nuevo';
        boton.style.cssText = 'background:none;border:none;padding:0;font:inherit;'
            + 'color:inherit;text-decoration:underline;cursor:pointer;';
        boton.addEventListener('click', function () {
            alDescartar();
            if (caja.parentNode) caja.parentNode.removeChild(caja);
        });
        caja.appendChild(texto);
        caja.appendChild(boton);
        form.insertBefore(caja, form.firstChild);
    }

    // form: el <form> (o cualquier contenedor con campos adentro)
    // nombre: una clave estable para este formulario
    // opciones.aviso: false para no mostrar el cartel de restaurado
    function cuidar(form, nombre, opciones) {
        if (!form || !nombre) return null;
        var clave = PREFIJO + nombre;
        var config = opciones || {};

        var guardado = leer(clave);
        if (guardado) {
            var puestos = poner(form, guardado);
            if (puestos && config.aviso !== false) {
                avisoDeRestaurado(form, function () {
                    borrar(clave);
                    vaciar(form);
                });
            }
        }

        // Con debounce: escribir en localStorage en cada tecla es trabajo al
        // pedo y en un celular se nota.
        var reloj = null;
        var anotar = function () {
            clearTimeout(reloj);
            reloj = setTimeout(function () {
                var campos = tomar(form);
                if (campos) guardar(clave, campos); else borrar(clave);
            }, 400);
        };
        form.addEventListener('input', anotar);
        form.addEventListener('change', anotar);

        return {
            // Se llama cuando el envio salio bien. Si no se llama, el
            // borrador queda y se le ofrece de nuevo a la persona: preferible
            // a borrarlo antes de tiempo.
            listo: function () { clearTimeout(reloj); borrar(clave); },
            borrar: function () { clearTimeout(reloj); borrar(clave); },
        };
    }

    global.sbBorrador = { cuidar: cuidar };
})(window);
