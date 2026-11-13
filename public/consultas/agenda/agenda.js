// Agendador de consultas.
//
// Dos entradas: con ?p=&t= (el pedido ya existe, viene del formulario o del
// mail) o sin nada (segunda sesion: se piden nombre, mail y telefono y el
// pedido se crea aca).
//
// Los horarios llegan del servidor en hora de Argentina, con el offset
// escrito (…-03:00). Todo lo que se ve en pantalla se arma con Intl en la
// zona que elija quien mira, asi alguien en Madrid ve su hora y no la de
// Seba, sin que el servidor tenga que saber donde esta.

const API = 'https://us-central1-sebabru-e5563.cloudfunctions.net';
const TURNSTILE_SITEKEY = '0x4AAAAAAFwEydZNkPMtSb8Q';

const estado = {
  p: null,
  t: null,
  zona: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Argentina/Cordoba',
  slots: [],
  porDia: new Map(),
  diaElegido: null,
  horaElegida: null,
  turno: null,
  duracionMin: 120,
  modalidad: '',
  nombre: '',
  mesVisible: null, // 'YYYY-MM'
  meses: [],
};

const $ = id => document.getElementById(id);

function mostrarPaso(id) {
  for (const paso of document.querySelectorAll('.ag-paso')) paso.classList.remove('visible');
  $('ag-cargando').style.display = 'none';
  if (id) $(id).classList.add('visible');
}

function cargando(si) {
  $('ag-cargando').style.display = si ? 'block' : 'none';
}

function mostrarError(donde, texto) {
  const caja = $(donde);
  caja.textContent = texto;
  caja.classList.add('visible');
}

function limpiarError(donde) {
  $(donde).classList.remove('visible');
}

function medir(evento, extra) {
  if (window.gtag) gtag('event', evento, extra || {});
}

// Los motivos que contesta el servidor, en castellano.
const MENSAJES = {
  token_invalido: 'Este enlace no es válido o venció. Escribinos a info@sebabru.com y te mandamos uno nuevo.',
  slot_ocupado: 'Ese horario se ocupó mientras elegías. Te actualicé la lista: elegí otro.',
  agenda_pausada: 'La agenda está cerrada por unos días. Escribinos a info@sebabru.com y lo vemos.',
  calendar_no_disponible: 'No pudimos leer la agenda en este momento. Probá de nuevo en un rato.',
  horario_invalido: 'Ese horario no es válido. Elegí uno de la lista.',
  captcha_requerido: 'Necesitamos que confirmes que no sos un robot. Probá de nuevo.',
  email_invalido: 'Revisá tu dirección de mail.',
  modalidad_invalida: 'Elegí si la sesión es online o presencial.',
  faltan_datos: 'Faltan datos: completá tu nombre y tu teléfono.',
  no_configurado: 'La agenda todavía no está habilitada. Escribinos a info@sebabru.com.',
  fallo: 'Algo falló de nuestro lado. Probá de nuevo en unos minutos.',
};

function mensajeDe(data, resp) {
  if (resp && resp.status === 429) return 'Demasiados intentos desde esta conexión. Esperá unos minutos.';
  return MENSAJES[data && data.error] || (data && data.error) || MENSAJES.fallo;
}

// -------------------------------------------------------
// Fechas, en la zona que eligio quien mira
// -------------------------------------------------------
function partes(iso, opciones) {
  return new Intl.DateTimeFormat('es-AR', { timeZone: estado.zona, ...opciones }).format(new Date(iso));
}

function claveDia(iso) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: estado.zona, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
  return p; // en-CA da YYYY-MM-DD
}

function textoHora(iso) {
  return partes(iso, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function textoDiaLargo(iso) {
  return partes(iso, { weekday: 'long', day: 'numeric', month: 'long' });
}

function nombreDeMes(clave) {
  const [a, m] = clave.split('-');
  const d = new Date(Date.UTC(+a, +m - 1, 15));
  return new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

// -------------------------------------------------------
// Zona horaria
// -------------------------------------------------------
function llenarZonas() {
  const select = $('ag-select-zona');
  let zonas = [];
  try {
    zonas = Intl.supportedValuesOf('timeZone');
  } catch (_) {
    zonas = ['America/Argentina/Cordoba', 'America/Montevideo', 'America/Santiago',
      'America/Sao_Paulo', 'America/Bogota', 'America/Mexico_City', 'America/New_York',
      'America/Los_Angeles', 'Europe/Madrid', 'Europe/London', 'Europe/Berlin'];
  }
  if (!zonas.includes(estado.zona)) zonas = [estado.zona, ...zonas];
  select.innerHTML = '';
  for (const z of zonas) {
    const op = document.createElement('option');
    op.value = z;
    op.textContent = z.replace(/_/g, ' ');
    if (z === estado.zona) op.selected = true;
    select.appendChild(op);
  }
  select.addEventListener('change', () => {
    estado.zona = select.value;
    estado.diaElegido = null;
    estado.horaElegida = null;
    agruparSlots();
    pintarCalendario();
    pintarHorarios();
    $('ag-resumen').hidden = true;
  });
}

// -------------------------------------------------------
// Calendario
// -------------------------------------------------------
function agruparSlots() {
  estado.porDia = new Map();
  for (const iso of estado.slots) {
    const dia = claveDia(iso);
    if (!estado.porDia.has(dia)) estado.porDia.set(dia, []);
    estado.porDia.get(dia).push(iso);
  }
  // Los meses que tienen al menos un horario: no tiene sentido dejar pasar
  // las flechas por meses enteros vacios.
  estado.meses = [...new Set([...estado.porDia.keys()].map(d => d.slice(0, 7)))].sort();
  if (!estado.meses.length) {
    estado.mesVisible = null;
  } else if (!estado.mesVisible || !estado.meses.includes(estado.mesVisible)) {
    estado.mesVisible = estado.meses[0];
  }
}

function pintarCalendario() {
  const grilla = $('ag-grilla');
  grilla.innerHTML = '';

  if (!estado.mesVisible) {
    $('ag-mes-nombre').textContent = '';
    $('ag-mes-antes').disabled = true;
    $('ag-mes-despues').disabled = true;
    grilla.innerHTML = '<p style="grid-column:1/-1; color:#8f8d88; line-height:1.7;">No hay horarios libres en los próximos días. Escribinos a <a href="mailto:info@sebabru.com">info@sebabru.com</a> y buscamos un hueco.</p>';
    return;
  }

  $('ag-mes-nombre').textContent = nombreDeMes(estado.mesVisible);
  const i = estado.meses.indexOf(estado.mesVisible);
  $('ag-mes-antes').disabled = i <= 0;
  $('ag-mes-despues').disabled = i >= estado.meses.length - 1;

  for (const n of ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom']) {
    const c = document.createElement('div');
    c.className = 'ag-dia-nombre';
    c.textContent = n;
    grilla.appendChild(c);
  }

  const [anio, mes] = estado.mesVisible.split('-').map(Number);
  // getUTCDay da 0 para domingo; la grilla arranca en lunes.
  const primero = new Date(Date.UTC(anio, mes - 1, 1));
  const corrimiento = (primero.getUTCDay() + 6) % 7;
  const diasDelMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();

  for (let k = 0; k < corrimiento; k++) {
    const c = document.createElement('div');
    c.className = 'ag-dia vacio';
    grilla.appendChild(c);
  }

  for (let d = 1; d <= diasDelMes; d++) {
    const clave = `${estado.mesVisible}-${String(d).padStart(2, '0')}`;
    const libres = estado.porDia.get(clave);
    const celda = document.createElement(libres ? 'button' : 'div');
    celda.className = 'ag-dia' + (libres ? ' libre' : '') + (clave === estado.diaElegido ? ' elegido' : '');
    celda.textContent = String(d);
    if (libres) {
      celda.type = 'button';
      celda.setAttribute('aria-label', `${d}: ${libres.length} horario${libres.length > 1 ? 's' : ''}`);
      celda.addEventListener('click', () => {
        estado.diaElegido = clave;
        estado.horaElegida = null;
        $('ag-resumen').hidden = true;
        pintarCalendario();
        pintarHorarios();
      });
    }
    grilla.appendChild(celda);
  }
}

function pintarHorarios() {
  const caja = $('ag-horarios');
  const lista = $('ag-lista-horas');
  lista.innerHTML = '';
  const libres = estado.diaElegido ? estado.porDia.get(estado.diaElegido) : null;
  if (!libres || !libres.length) {
    caja.hidden = true;
    return;
  }
  caja.hidden = false;
  $('ag-horarios-titulo').textContent = textoDiaLargo(libres[0]);
  for (const iso of libres) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ag-hora' + (iso === estado.horaElegida ? ' elegida' : '');
    b.textContent = textoHora(iso);
    b.addEventListener('click', () => {
      estado.horaElegida = iso;
      pintarHorarios();
      pintarResumen();
    });
    lista.appendChild(b);
  }
}

function pintarResumen() {
  if (!estado.horaElegida) return;
  limpiarError('ag-error-reserva');
  const iso = estado.horaElegida;
  const cambia = Boolean(estado.turno);
  $('ag-resumen-texto').innerHTML =
    `${cambia ? 'Vas a mover tu sesión al' : 'Tu sesión queda el'} <strong>${textoDiaLargo(iso)} a las ${textoHora(iso)}</strong>` +
    `, y dura ${estado.duracionMin} minutos.`;
  $('ag-btn-confirmar').textContent = cambia ? 'Mover mi sesión' : 'Confirmar mi sesión';
  $('ag-resumen').hidden = false;
  $('ag-resumen').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// -------------------------------------------------------
// Pantalla del turno ya agendado
// -------------------------------------------------------
function pintarFicha() {
  const t = estado.turno;
  $('ag-ficha-cuando').textContent = `${textoDiaLargo(t.inicio)}, ${textoHora(t.inicio)}`;
  $('ag-ficha-zona').textContent = `Hora de ${estado.zona.replace(/_/g, ' ')}. Dura ${estado.duracionMin} minutos.`;
  const donde = $('ag-ficha-donde');
  if ((t.modalidad || estado.modalidad) === 'Presencial') {
    donde.innerHTML = 'El encuentro es presencial. Pedile a Clari cómo llegar: <a href="https://wa.me/5493544559877">+54 9 3544 559877</a>.';
  } else if (t.meet) {
    // El enlace propio de esta sesión. Se arma en el servidor y viene del
    // evento de Google, así que no es texto de nadie: igual se inserta con
    // el DOM en vez de con innerHTML.
    donde.textContent = 'El encuentro es por Google Meet: ';
    const a = document.createElement('a');
    a.href = t.meet;
    a.textContent = 'entrar a la reunión';
    donde.appendChild(a);
  } else {
    donde.innerHTML = 'El encuentro es por Zoom: <a href="https://us02web.zoom.us/j/8020861967?pwd=Gl9uLBofVZd0XmzTPhAHnQDc8RtnsE.1">entrar a la reunión</a> (ID 802 086 1967, passcode paso).';
  }
  mostrarPaso('ag-confirmado');
}

// -------------------------------------------------------
// Llamadas al servidor
// -------------------------------------------------------
async function traerDisponibilidad() {
  const url = `${API}/disponibilidad?p=${encodeURIComponent(estado.p)}&t=${encodeURIComponent(estado.t)}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error('disponibilidad'), { data, resp });
  return data;
}

function aplicar(data) {
  estado.slots = data.slots || [];
  estado.duracionMin = data.duracionMin || 120;
  estado.modalidad = data.modalidad || '';
  estado.nombre = data.nombre || '';
  estado.turno = data.turno || null;

  if (estado.nombre) {
    const pila = estado.nombre.split(' ')[0];
    $('ag-saludo').textContent = `${pila}, elegí tu día y tu hora`;
    $('ag-confirmado-titulo').textContent = `${pila}, tu sesión está agendada`;
  }

  if (estado.turno) {
    pintarFicha();
    return;
  }

  if (data.pausado) {
    $('ag-roto-titulo').textContent = 'La agenda está cerrada por unos días';
    $('ag-roto-texto').textContent = 'Escribinos a info@sebabru.com y coordinamos a mano.';
    mostrarPaso('ag-roto');
    return;
  }

  agruparSlots();
  pintarCalendario();
  pintarHorarios();
  mostrarPaso('ag-elegir');
}

async function cargarAgenda() {
  cargando(true);
  try {
    aplicar(await traerDisponibilidad());
  } catch (e) {
    cargando(false);
    $('ag-roto-titulo').textContent = 'No pudimos abrir tu agenda';
    $('ag-roto-texto').textContent = mensajeDe(e.data, e.resp);
    mostrarPaso('ag-roto');
    medir('turno_error', { motivo: (e.data && e.data.error) || 'disponibilidad' });
  }
}

async function confirmar() {
  const boton = $('ag-btn-confirmar');
  const original = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Agendando...';
  limpiarError('ag-error-reserva');
  try {
    const resp = await fetch(`${API}/reservarTurno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p: estado.p, t: estado.t, inicio: estado.horaElegida }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      mostrarError('ag-error-reserva', mensajeDe(data, resp));
      medir('turno_error', { motivo: data.error || 'reserva' });
      // Si se lo ganó otra persona, la lista que está viendo ya no sirve.
      if (data.error === 'slot_ocupado') {
        estado.horaElegida = null;
        $('ag-resumen').hidden = true;
        const fresco = await traerDisponibilidad().catch(() => null);
        if (fresco) { estado.slots = fresco.slots || []; agruparSlots(); pintarCalendario(); pintarHorarios(); }
      }
      return;
    }
    estado.turno = data.turno;
    medir('turno_reservado', { modalidad: estado.modalidad || 'Online' });
    pintarFicha();
  } catch (_) {
    mostrarError('ag-error-reserva', MENSAJES.fallo);
  } finally {
    boton.disabled = false;
    boton.textContent = original;
  }
}

async function cancelar() {
  if (!window.confirm('¿Cancelamos tu sesión? Después podés elegir otro día.')) return;
  const boton = $('ag-btn-cancelar');
  boton.disabled = true;
  limpiarError('ag-error-ficha');
  try {
    const resp = await fetch(`${API}/cancelarTurno`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p: estado.p, t: estado.t }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      mostrarError('ag-error-ficha', mensajeDe(data, resp));
      return;
    }
    estado.turno = null;
    estado.diaElegido = null;
    estado.horaElegida = null;
    medir('turno_cancelado', {});
    await cargarAgenda();
  } catch (_) {
    mostrarError('ag-error-ficha', MENSAJES.fallo);
  } finally {
    boton.disabled = false;
  }
}

// -------------------------------------------------------
// La puerta suelta: el formulario corto
// -------------------------------------------------------
let captchaToken = '';

// El script de Turnstile se trae recién acá, en la puerta suelta. Quien
// entra con su enlace del formulario o del mail no lo descarga nunca.
let captchaPedido = false;
function montarCaptcha() {
  if (typeof turnstile === 'undefined') {
    if (!captchaPedido) {
      captchaPedido = true;
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }
    setTimeout(montarCaptcha, 300);
    return;
  }
  turnstile.render('#ag-captcha', {
    sitekey: TURNSTILE_SITEKEY,
    theme: 'dark',
    callback: token => { captchaToken = token; },
    'expired-callback': () => { captchaToken = ''; },
  });
}

async function identificarse(evento) {
  evento.preventDefault();
  limpiarError('ag-error-form');
  const boton = $('ag-btn-seguir');

  const nombre = $('ag-nombre').value.trim();
  const email = $('ag-email').value.trim();
  const telefono = $('ag-telefono').value.trim();
  const modalidad = $('ag-modalidad').value;

  if (!nombre || !telefono) return mostrarError('ag-error-form', MENSAJES.faltan_datos);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return mostrarError('ag-error-form', MENSAJES.email_invalido);
  if (!captchaToken) return mostrarError('ag-error-form', 'Esperá un segundo a que termine la verificación de seguridad y probá de nuevo.');

  boton.disabled = true;
  boton.textContent = 'Buscando horarios...';
  try {
    const resp = await fetch(`${API}/iniciarAgenda`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, email, telefono, modalidad, captchaToken }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      mostrarError('ag-error-form', mensajeDe(data, resp));
      medir('turno_error', { motivo: data.error || 'iniciar' });
      captchaToken = '';
      if (typeof turnstile !== 'undefined') turnstile.reset();
      return;
    }
    estado.p = data.p;
    estado.t = data.t;
    // El enlace queda en la barra de direcciones: si recarga la pagina o lo
    // guarda, vuelve a su propia agenda en vez de empezar de cero.
    history.replaceState(null, '', `?p=${encodeURIComponent(data.p)}&t=${encodeURIComponent(data.t)}`);
    mostrarPaso(null);
    await cargarAgenda();
  } catch (_) {
    mostrarError('ag-error-form', MENSAJES.fallo);
  } finally {
    boton.disabled = false;
    boton.textContent = 'Ver los horarios';
  }
}

// -------------------------------------------------------
// Arranque
// -------------------------------------------------------
function iniciar() {
  llenarZonas();

  $('ag-mes-antes').addEventListener('click', () => {
    const i = estado.meses.indexOf(estado.mesVisible);
    if (i > 0) { estado.mesVisible = estado.meses[i - 1]; pintarCalendario(); }
  });
  $('ag-mes-despues').addEventListener('click', () => {
    const i = estado.meses.indexOf(estado.mesVisible);
    if (i >= 0 && i < estado.meses.length - 1) { estado.mesVisible = estado.meses[i + 1]; pintarCalendario(); }
  });
  $('ag-btn-confirmar').addEventListener('click', confirmar);
  $('ag-btn-cancelar').addEventListener('click', cancelar);
  $('ag-btn-cambiar').addEventListener('click', () => {
    // El turno sigue en pie hasta que elija otro horario: reservarTurno
    // libera el viejo recién cuando el nuevo ya está tomado.
    agruparSlots();
    pintarCalendario();
    pintarHorarios();
    mostrarPaso('ag-elegir');
    cargarHorariosFrescos();
  });
  $('ag-form').addEventListener('submit', identificarse);

  const q = new URLSearchParams(location.search);
  estado.p = q.get('p');
  estado.t = q.get('t');

  if (estado.p && estado.t) {
    medir('turno_inicio', { entrada: 'pedido' });
    cargarAgenda();
  } else {
    medir('turno_inicio', { entrada: 'suelta' });
    mostrarPaso('ag-identificarse');
    montarCaptcha();
  }
}

// Al tocar "cambiar el día" se vuelven a pedir los horarios: los que había
// en memoria pueden tener media hora.
async function cargarHorariosFrescos() {
  try {
    const data = await traerDisponibilidad();
    estado.slots = data.slots || [];
    agruparSlots();
    pintarCalendario();
    pintarHorarios();
  } catch (_) { /* se sigue con los que ya estaban */ }
}

iniciar();
