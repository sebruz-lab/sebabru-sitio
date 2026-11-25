// Formulario de inscripcion a las formaciones de la escuela.
//
// Uno solo para las cinco paginas que lo muestran: las cuatro de
// /formaciones/ (intro, lectura, seminarios3, transitos) y /programa/, que
// lleva cuatro formularios en la misma pagina, uno debajo de cada curso. La
// logica es identica y cinco copias serian cinco lugares donde arreglar el
// mismo bug. El markup vive en formulario.js, tambien una sola vez.
//
// Cada pagina escribe solo el hueco, con tres atributos:
//
//     data-form-id   el formId del servidor, que es el cursoId (intro27...)
//     data-nombre    como se llama en los eventos de Analytics (opcional)
//     data-titulo    el encabezado del formulario (opcional)
//
//     <div class="inscripcion" data-form-id="intro27"></div>
//
// NADA SE BUSCA POR ID. Con cuatro formularios en /programa/, un
// document.getElementById('inp-nombre') devolveria siempre el del primero:
// la persona completa el tercer formulario y los datos salen del de arriba.
// Cada instancia busca lo suyo adentro de su propia caja.
//
// Sale del formulario de consultas (public/consultas/formulario.html), que
// es el unico del sitio que ya postea a registrarInscripcion. Lo que se
// mantiene de ahi, y conviene no perder:
//
//   - el borrador (window.sbBorrador), que se borra SOLO si el envio salio
//     bien: este es un formulario largo y en el celular cambiar de app
//     puede hacer que el navegador lo descarte;
//   - el aviso de "estamos guardando" a los 3 segundos, que es el arranque
//     en frio de la funcion y le toca a quien manda el primer formulario
//     del dia: sin eso ve un boton quieto y recarga;
//   - el .catch() del resp.json(), porque un 502 del proxy devuelve HTML y
//     sin eso la persona veia en pantalla "Unexpected token '<'";
//   - el manejo de data.aviso, que es la respuesta del camino de custodia:
//     el dato quedo guardado y se lo dice, en vez de pedirle que escriba
//     todo otra vez para chocarse con el mismo problema.
//
// Lo que se agrega respecto del de consultas: la trampa para bots (el campo
// hp, que el de consultas no tiene) y que los datos de nacimiento son
// opcionales, igual que en el Google Form que esto reemplaza. Si faltan, la
// inscripcion entra igual y la carta se hace a mano.

import { conectarBuscador } from '/cartas/buscador-lugares.js?v=1.14.0';
import { crearFormulario } from '/formaciones/formulario.js?v=4';

const ENDPOINT = 'https://us-central1-sebabru-e5563.cloudfunctions.net/registrarInscripcion';
const ENDPOINT_CUPON = 'https://us-central1-sebabru-e5563.cloudfunctions.net/validarDescuento';
const TURNSTILE_SITEKEY = '0x4AAAAAAFwEydZNkPMtSb8Q';
const SIN_RESULTADOS = 'No encontramos ese lugar. Si está bien escrito, envialo así.';

// ---- Fecha y hora, desde lo que venga ----
// Copia de normalizarFecha / completarFecha / completarHora de la
// calculadora (C:\dev\tucarta\ui\fecha.js, con sus tests), igual que en
// el formulario de consultas: si cambian alla, cambiarlas en los dos.
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const sinTildes = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const dos = (n) => String(n).padStart(2, '0');

function normalizarFecha(valor, escribiendo) {
    if (/[a-zñ]/i.test(sinTildes(String(valor)))) return valor;
    const campos = ['', '', ''];
    let i = 0;
    for (const c of String(valor)) {
        if (c >= '0' && c <= '9') {
            if (i < 2 && campos[i].length === 2) i++;
            if (i === 2 && campos[2].length === 4) break;
            campos[i] += c;
        } else if (/[\s./-]/.test(c) && i < 2 && campos[i]) {
            campos[i] = campos[i].padStart(2, '0');
            i++;
        }
    }
    let res = campos[0];
    if (i >= 1) res += '/' + campos[1];
    if (i >= 2) res += '/' + campos[2];
    if (escribiendo && i < 2 && campos[i].length === 2) res += '/';
    return res;
}

function anioCompleto(texto) {
    return texto.replace(/^(\d{1,2}\/\d{1,2}\/)(\d{2})$/, (_, dm, aa) => dm + (+aa <= 40 ? '20' : '19') + aa);
}

function completarFecha(texto) {
    const t = sinTildes(String(texto)).trim();
    if (!t) return '';
    const mes = MESES.findIndex((m) => new RegExp('(^|[^a-z])' + m + '[a-z]*').test(t)) + 1
        || (/(^|[^a-z])set[a-z]*/.test(t) ? 9 : 0);
    if (mes) {
        const nums = t.replace(/[a-z]+/g, ' ').match(/\d+/g) || [];
        const anio = nums.find((n) => n.length === 4) || (nums.length > 1 ? nums[nums.length - 1] : '');
        const dia = nums.find((n) => n !== anio && n.length <= 2);
        if (!dia || !anio) return texto.trim();
        return anioCompleto(dos(dia) + '/' + dos(mes) + '/' + anio);
    }
    const nums = t.match(/\d+/g) || [];
    const dig = t.replace(/\D/g, '');
    const candidatos = [];
    if (nums.length >= 3) candidatos.push(nums[0].length === 4 ? [nums[2], nums[1], nums[0]] : nums.slice(0, 3));
    if (dig.length === 8) candidatos.push([dig.slice(0, 2), dig.slice(2, 4), dig.slice(4)], [dig.slice(6), dig.slice(4, 6), dig.slice(0, 4)]);
    if (dig.length === 6) candidatos.push([dig.slice(0, 2), dig.slice(2, 4), dig.slice(4)]);
    const sirve = ([d, m, a]) => d.length <= 2 && m.length <= 2 && (a.length === 2 || a.length === 4)
        && +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31;
    const elegido = candidatos.find(sirve);
    if (!elegido) return normalizarFecha(texto, false);
    return anioCompleto(dos(elegido[0]) + '/' + dos(elegido[1]) + '/' + elegido[2]);
}

function completarHora(texto) {
    const t = sinTildes(String(texto)).trim();
    if (!t) return '';
    if (/mediodia/.test(t)) return '12:00';
    if (/medianoche/.test(t)) return '00:00';
    const tarde = /(^|[^a-z])(pm|p\.m|tarde|noche)/.test(t);
    const manana = /(^|[^a-z])(am|a\.m|manana|madrugada)/.test(t);
    const media = /(y\s*)?media/.test(t) && !/mediodia|medianoche/.test(t);
    const cuarto = /(y\s*)?cuarto/.test(t);
    const nums = t.match(/\d+/g) || [];
    if (!nums.length) return texto.trim();
    let h;
    let m = 0;
    if (nums.length >= 2) {
        h = +nums[0];
        m = +nums[1];
    } else {
        const d = nums[0];
        if (d.length === 4) { h = +d.slice(0, 2); m = +d.slice(2); }
        else if (d.length === 3) { h = +d.slice(0, 1); m = +d.slice(1); }
        else { h = +d; }
    }
    if (media && !m) m = 30;
    if (cuarto && !m) m = 15;
    if (!Number.isFinite(h) || !Number.isFinite(m) || m > 59) return texto.trim();
    if (tarde && h < 12) h += 12;
    if (manana && h === 12) h = 0;
    if (h > 23) return texto.trim();
    return dos(h) + ':' + dos(m);
}

// El cache de GeoNames es de la pagina, no de cada formulario: en /programa/
// hay cuatro y quien escribe el mismo pueblo en dos de ellos no tiene por que
// esperar dos veces.
const cacheRespaldo = new Map();

document.querySelectorAll('.inscripcion[data-form-id]').forEach(arrancar);

function arrancar(caja) {
    const formId = caja.dataset.formId;
    const nombreGa = caja.dataset.nombre || formId;

    caja.innerHTML = crearFormulario(formId, { titulo: caja.dataset.titulo, nombre: nombreGa });

    const form = caja.querySelector('form');
    const campo = (nombre) => form.querySelector('[data-campo="' + nombre + '"]');

    const formWrap = caja.querySelector('.form-wrap');
    const listo = caja.querySelector('.listo');
    const avisoListo = caja.querySelector('.aviso-listo');
    const btn = form.querySelector('.btn-enviar');
    const errorMsg = caja.querySelector('.error-msg');
    const avisoTarda = form.querySelector('.aviso-tarda');
    const captchaWrap = form.querySelector('.captcha-wrap');
    const inpFecha = campo('fecha');
    const inpHora = campo('hora');
    const inpLugar = campo('lugar');
    const listaLugar = form.querySelector('.sugerencias');

    const borrador = window.sbBorrador ? window.sbBorrador.cuidar(form, formId) : null;

    let captchaToken = '';
    let captchaWidgetId = null;

    // ---- El cupon ----
    // Chequear el codigo es opcional y nunca frena el envio: el servidor lo
    // revalida igual y, si no vale, la inscripcion entra con el codigo anotado
    // tal como lo escribio. Esto es solo para que quien tiene un codigo vea
    // antes de mandar que es de verdad y cuanto descuenta.
    const inpCodigo = campo('codigoDescuento');
    const btnCupon = form.querySelector('.btn-cupon');
    const cuponMsg = form.querySelector('.cupon-msg');
    let cuponChequeado = '';

    function decirCupon(texto, clase) {
        cuponMsg.textContent = texto;
        cuponMsg.className = 'cupon-msg' + (clase ? ' ' + clase : '');
    }

    async function chequearCupon() {
        const codigo = inpCodigo.value.trim().toUpperCase();
        inpCodigo.value = codigo;
        if (!codigo) { cuponChequeado = ''; decirCupon('', ''); return; }
        if (codigo === cuponChequeado) return;   // ya lo dijimos
        cuponChequeado = codigo;
        decirCupon('Chequeando...', '');
        try {
            const resp = await fetch(ENDPOINT_CUPON
                + '?codigo=' + encodeURIComponent(codigo)
                + '&curso=' + encodeURIComponent(formId));
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !('valido' in data)) {
                // No se pudo chequear: no es lo mismo que no valer, y decirle
                // que su codigo no existe cuando el problema es nuestro seria
                // mentirle. Se manda igual y el servidor decide.
                decirCupon('No pudimos chequearlo ahora. Mandá la inscripción igual: lo revisamos nosotros.', '');
                return;
            }
            if (data.valido) {
                decirCupon(data.descuento + '% de descuento. Te lo aplicamos al pasarte los datos del pago.', 'ok');
            } else {
                decirCupon('No encontramos ese código. Podés mandar la inscripción igual y lo revisamos.', 'aviso');
            }
        } catch (err) {
            decirCupon('No pudimos chequearlo ahora. Mandá la inscripción igual: lo revisamos nosotros.', '');
        }
    }

    btnCupon.addEventListener('click', chequearCupon);
    inpCodigo.addEventListener('blur', chequearCupon);
    // Enter adentro del campo chequea, no manda el formulario: a esa altura
    // todavia falta el captcha y un envio a medias seria peor.
    inpCodigo.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        chequearCupon();
    });
    // Si lo edita despues de chequear, el cartel viejo deja de valer.
    inpCodigo.addEventListener('input', () => {
        if (inpCodigo.value.trim().toUpperCase() !== cuponChequeado) decirCupon('', '');
    });

    // La lista de sugerencias dice en que estamos: si tiene el aviso de "no
    // encontramos", el lugar no existe en ningun lado y la inscripcion se
    // manda igual; si dice "Buscando...", todavia no sabemos.
    const buscandoLugar = () => Boolean(listaLugar.querySelector('.buscando'));
    const lugarNoEncontrado = () => Boolean(listaLugar.querySelector('.sin-resultados:not(.buscando)'));

    // Cada error tambien va a Analytics con el motivo: asi se ve que parte
    // del formulario traba a la gente.
    function mostrarError(msg, motivo) {
        errorMsg.textContent = msg;
        errorMsg.style.display = 'block';
        errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (window.gtag) gtag('event', 'inscripcion_error', { formulario: nombreGa, motivo: motivo || 'otro' });
    }

    // Un campo obligatorio vacio o mal escrito: el navegador frena el envio
    // con su propio cartel, antes de nuestras validaciones. Tambien se
    // registra, una vez por intento.
    let invalidoAvisado = false;
    form.addEventListener('invalid', (e) => {
        if (invalidoAvisado) return;
        invalidoAvisado = true;
        setTimeout(() => { invalidoAvisado = false; }, 0);
        if (window.gtag) {
            gtag('event', 'inscripcion_error', {
                formulario: nombreGa,
                motivo: 'falta_' + (e.target.dataset.campo || ''),
            });
        }
    }, true);

    // Empezar a llenar, una vez: con inscripcion, muestra cuantos abandonan.
    let empezado = false;
    form.addEventListener('focusin', () => {
        if (empezado) return;
        empezado = true;
        if (window.gtag) gtag('event', 'inscripcion_inicio', { formulario: nombreGa });
    });

    // El captcha solo se pide a partir del 5to envio desde la misma
    // conexion, y lo decide el servidor: hasta entonces este bloque queda
    // oculto y nadie lo ve.
    function mostrarCaptcha() {
        captchaWrap.style.display = 'block';
        if (captchaWidgetId !== null) return;
        if (typeof turnstile === 'undefined') { setTimeout(mostrarCaptcha, 300); return; }
        captchaWidgetId = turnstile.render(captchaWrap, {
            sitekey: TURNSTILE_SITEKEY,
            callback: (token) => { captchaToken = token; form.requestSubmit(); },
            'error-callback': () => { captchaToken = ''; },
            'expired-callback': () => { captchaToken = ''; },
        });
    }

    inpFecha.addEventListener('input', (e) => {
        inpFecha.value = normalizarFecha(inpFecha.value, !e.inputType || e.inputType.startsWith('insert'));
    });
    inpFecha.addEventListener('change', () => { inpFecha.value = completarFecha(inpFecha.value); });
    inpHora.addEventListener('change', () => { inpHora.value = completarHora(inpHora.value); });

    // ---- El buscador de lugares ----
    // Cuando el indice local no tiene el lugar (tiene Argentina, Uruguay y
    // España enteros, y del resto del mundo solo lo de mas de 1000
    // habitantes), se lo preguntamos a GeoNames por nuestra funcion. Si no
    // contesta, el buscador se queda como estaba.
    function respaldoPara(campoLugar, lista) {
        return async function (texto) {
            const clave = texto.trim().toLowerCase();
            if (!clave) return [];
            if (cacheRespaldo.has(clave)) return cacheRespaldo.get(clave);

            lista.innerHTML = '<li class="sin-resultados buscando" role="presentation">Buscando...</li>';
            lista.hidden = false;
            // GeoNames da 1.000 consultas por hora para todo el sitio, asi
            // que no vamos a la red en cada tecla: esperamos a que frene.
            await new Promise((listoYa) => setTimeout(listoYa, 350));
            if (campoLugar.value.trim().toLowerCase() !== clave) return [];

            try {
                const r = await fetch('https://us-central1-sebabru-e5563.cloudfunctions.net/buscarLugar?q=' + encodeURIComponent(texto));
                if (!r.ok) return [];
                const lugares = (await r.json()).lugares || [];
                cacheRespaldo.set(clave, lugares);
                return lugares;
            } catch {
                return [];
            }
        };
    }

    // El buscador descarta el lugar elegido en cada tecleo. Si el texto
    // quedo igual al del lugar que se habia elegido (por ejemplo, borrar una
    // letra y volver a escribirla), lo recuperamos: si no, la carta no sale
    // y la persona no se entera.
    let lugarElegido = null;
    let lugarRecordado = null;
    let textoRecordado = '';
    conectarBuscador(inpLugar, listaLugar, (l) => {
        if (l) {
            lugarRecordado = {
                nombre: l.nombre, provincia: l.provincia, pais: l.pais,
                paisNombre: l.paisNombre, lat: l.lat, lon: l.lon, zona: l.zona,
            };
            textoRecordado = inpLugar.value.trim();
            lugarElegido = lugarRecordado;
            return;
        }
        lugarElegido = (lugarRecordado && inpLugar.value.trim() === textoRecordado) ? lugarRecordado : null;
    }, { sinResultados: SIN_RESULTADOS, respaldo: respaldoPara(inpLugar, listaLugar) });

    // ---- El envio ----
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMsg.style.display = 'none';

        // Los tres datos de nacimiento son opcionales (quien ya curso con
        // nosotros no los vuelve a cargar), pero si pone uno tiene que poner
        // los tres: con dos de tres no hay carta, y media carga es peor que
        // ninguna porque no se nota.
        inpFecha.value = completarFecha(inpFecha.value);
        inpHora.value = completarHora(inpHora.value);
        const fecha = inpFecha.value.trim();
        const hora = inpHora.value.trim();
        const lugar = inpLugar.value.trim();
        const algunoDeNacimiento = Boolean(fecha || hora || lugar);

        if (algunoDeNacimiento) {
            if (!/^\d{2}\/\d{2}\/\d{4}$/.test(fecha)) {
                mostrarError('La fecha de nacimiento tiene que tener el formato DD/MM/AAAA, por ejemplo 05/03/1990. Si preferís no cargarla, dejá vacíos los tres datos de nacimiento.', 'fecha');
                return;
            }
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
                mostrarError('No entendimos la hora de nacimiento. Escribila como 09:30 (o 9, 930, 9.30, 9 pm...).', 'hora');
                return;
            }
            // El lugar se elige de la lista, asi la carta sale con las
            // coordenadas justas. Si no aparece en ningun lado, la
            // inscripcion entra igual y la carta se hace a mano: la planilla
            // lo deja asentado en la columna Carta. Lo que no conviene es
            // mandarlo sin elegir cuando la lista tiene justo el lugar.
            if (!lugarElegido) {
                if (buscandoLugar()) {
                    mostrarError('Esperá un segundo, estamos buscando ese lugar.', 'lugar');
                    return;
                }
                if (!lugarNoEncontrado()) {
                    mostrarError('Elegí tu lugar de nacimiento de la lista que aparece al escribir.', 'lugar');
                    return;
                }
                if (window.gtag) gtag('event', 'lugar_sin_resultado', { formulario: nombreGa });
            }
        }

        if (captchaWrap.style.display !== 'none' && !captchaToken) {
            mostrarError('Confirmá que sos una persona en el casillero de arriba.', 'captcha');
            return;
        }

        const textoBoton = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';
        const relojTarda = setTimeout(() => { avisoTarda.style.display = 'block'; }, 3000);

        try {
            const resp = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    formId,
                    campos: {
                        nombre: campo('nombre').value.trim(),
                        telefono: campo('telefono').value.trim(),
                        email: campo('email').value.trim(),
                        fechaNacimiento: fecha,
                        horaNacimiento: hora,
                        lugarNacimiento: lugar,
                        conocimientos: campo('conocimientos').value,
                        modalidad: campo('modalidad').value,
                        formaPago: campo('formaPago').value,
                        novedades: campo('novedades').checked ? 'Sí' : 'No',
                        codigoDescuento: inpCodigo.value.trim().toUpperCase(),
                    },
                    lugar: algunoDeNacimiento ? (lugarElegido || null) : null,
                    hp: campo('hp').value,
                    captchaToken: captchaToken || undefined,
                }),
            });
            // Sin el .catch, una respuesta que no es JSON (un 502 del proxy
            // devuelve HTML) le mostraba a la persona el error de parseo:
            // "Unexpected token '<'".
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                if (data.error === 'captcha_requerido') {
                    captchaToken = '';
                    mostrarCaptcha();
                    mostrarError('Antes de enviar, confirmá que sos una persona en el casillero de abajo.', 'captcha');
                    return;
                }
                throw new Error(data.error || 'No pudimos registrar tu inscripción.');
            }

            // Salio bien: recien aca se borra el borrador.
            if (borrador) borrador.listo();

            // data.aviso es el camino de custodia: la inscripcion quedo
            // guardada pero no se pudo terminar de procesar, y la termina
            // Seba a mano. Se dice, en vez de mostrar el mensaje de siempre
            // como si todo hubiera salido bien.
            if (data.aviso) avisoListo.textContent = data.aviso;

            formWrap.style.display = 'none';
            listo.classList.add('visible');
            listo.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (window.gtag) gtag('event', 'inscripcion', { formulario: nombreGa });
        } catch (err) {
            mostrarError(err.message || 'No pudimos registrar tu inscripción. Probá de nuevo.', 'servidor');
        } finally {
            clearTimeout(relojTarda);
            avisoTarda.style.display = 'none';
            btn.disabled = false;
            btn.innerHTML = textoBoton;
        }
    });
}
