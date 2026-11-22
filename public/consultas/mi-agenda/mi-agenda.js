// El espacio personal: tu proximo encuentro y como moverlo.
//
// Se entra de dos maneras y la pagina no hace diferencia entre ellas:
//
//   ?a=<token>   el enlace privado que llega por mail, sin contrasena.
//   una sesion   la cuenta de la escuela, con Google o con mail y clave.
//
// El enlace gana si esta: quien lo tiene lo abrio a proposito.
//
// Los horarios llegan del servidor en hora de Argentina, con el offset
// escrito (...-03:00), y se muestran en la zona de quien mira, igual que en
// /consultas/agenda/. Asi alguien en Madrid ve su hora sin que el servidor
// tenga que saber donde esta.

import { auth } from '../../escuela/firebase.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { calendarioMes } from '../calendario-mes.js?v=1';

const API = 'https://us-central1-sebabru-e5563.cloudfunctions.net';
const ZONA_SEBA = 'America/Argentina/Cordoba';

const ZONA_DETECTADA = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (_) {
    return '';
  }
})();

const estado = {
  // El token del enlace, si se entro por ahi.
  a: null,
  zona: ZONA_DETECTADA || ZONA_SEBA,
  zonaDetectada: Boolean(ZONA_DETECTADA),
  nombre: '',
  series: [],
  turnos: [],
  // El turno que se esta moviendo, lo que se eligio para el, y la respuesta
  // de disponibilidad que las pantallas de abajo vuelven a leer al repintar.
  moviendo: null,
  elegida: null,
  disponibilidad: null,
  // Para no cargar el espacio dos veces cuando Firebase avisa de la sesion
  // despues de que ya entramos con el enlace.
  abierto: false,
};

const $ = id => document.getElementById(id);

function mostrarPaso(id) {
  for (const paso of document.querySelectorAll('.mi-paso')) paso.classList.remove('visible');
  $('mi-cargando').style.display = 'none';
  if (id) $(id).classList.add('visible');
}

function cargando(si) {
  $('mi-cargando').style.display = si ? 'block' : 'none';
}

function mostrarError(donde, texto) {
  const caja = $(donde);
  caja.textContent = texto;
  caja.classList.add('visible');
}

function limpiar(donde) {
  $(donde).classList.remove('visible');
}

const MENSAJES = {
  sin_acceso: 'Este enlace no es válido o venció. Escribime a info@sebabru.com y te mando uno nuevo.',
  turno_no_encontrado: 'No encontramos ese encuentro. Recargá la página y probá de nuevo.',
  muy_tarde: 'Falta muy poco para el encuentro como para moverlo desde acá. Escribime y lo vemos.',
  slot_ocupado: 'Ese horario se ocupó mientras elegías. Te actualicé la lista: elegí otro.',
  agenda_pausada: 'La agenda está cerrada por unos días. Escribime a info@sebabru.com y lo vemos.',
  calendar_no_disponible: 'No pudimos leer la agenda en este momento. Probá de nuevo en un rato.',
  horario_invalido: 'Ese horario no es válido. Elegí uno de la lista.',
  fallo: 'Algo falló de nuestro lado. Probá de nuevo en unos minutos.',
};

function mensajeDe(data, resp) {
  if (resp && resp.status === 429) return 'Demasiados intentos desde esta conexión. Esperá unos minutos.';
  if (data && data.error === 'muy_tarde' && data.horas) {
    return `Los cambios se pueden hacer hasta ${data.horas} horas antes del encuentro, y falta menos que eso. Escribime a info@sebabru.com y lo vemos.`;
  }
  return MENSAJES[data && data.error] || (data && data.error) || MENSAJES.fallo;
}

// -------------------------------------------------------
// Fechas, en la zona de quien mira
// -------------------------------------------------------
function partes(iso, opciones) {
  return new Intl.DateTimeFormat('es-AR', { timeZone: estado.zona, ...opciones }).format(new Date(iso));
}

function claveDia(iso) {
  // en-CA da YYYY-MM-DD, que es lo que hace falta para agrupar.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: estado.zona, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

const textoHora = iso => partes(iso, { hour: '2-digit', minute: '2-digit', hour12: false });
const textoDiaLargo = iso => partes(iso, { weekday: 'long', day: 'numeric', month: 'long' });

function nombreDeZona() {
  const ciudad = String(estado.zona).split('/').pop().replace(/_/g, ' ');
  return estado.zonaDetectada ? ciudad : `${ciudad} (no pudimos detectar tu zona)`;
}

// -------------------------------------------------------
// Llamadas al servidor
//
// Un solo lugar decide como se identifica la peticion: con el token del
// enlace o con el ID token de la sesion. El resto de la pagina no se entera
// de cual de los dos es.
// -------------------------------------------------------
async function llamar(endpoint, { metodo = 'GET', cuerpo = null, query = {} } = {}) {
  const url = new URL(`${API}/${endpoint}`);
  const cabeceras = {};

  if (estado.a) {
    if (metodo === 'GET') url.searchParams.set('a', estado.a);
  } else {
    const usuario = auth.currentUser;
    if (!usuario) throw Object.assign(new Error('sin_sesion'), { data: { error: 'sin_acceso' } });
    cabeceras.Authorization = `Bearer ${await usuario.getIdToken()}`;
  }

  for (const [k, v] of Object.entries(query)) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }

  const opciones = { method: metodo, headers: cabeceras };
  if (metodo !== 'GET') {
    opciones.headers['Content-Type'] = 'application/json';
    opciones.body = JSON.stringify({ ...(cuerpo || {}), ...(estado.a ? { a: estado.a } : {}) });
  }

  const resp = await fetch(url, opciones);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(endpoint), { data, resp });
  return data;
}

// -------------------------------------------------------
// El espacio
// -------------------------------------------------------
async function abrirEspacio() {
  cargando(true);
  try {
    const data = await llamar('miAgenda');
    estado.abierto = true;
    estado.nombre = data.nombre || '';
    estado.series = data.series || [];
    estado.turnos = data.turnos || [];
    pintarEspacio();
  } catch (e) {
    const motivo = e.data && e.data.error;
    // Sin acceso no es un error roto: es que todavia no sabemos quien es.
    if (motivo === 'sin_acceso' && !estado.a) {
      mostrarPaso('mi-entrar');
      return;
    }
    $('mi-roto-titulo').textContent = motivo === 'sin_acceso'
      ? 'Este enlace ya no sirve'
      : 'No pudimos abrir tu espacio';
    $('mi-roto-texto').textContent = mensajeDe(e.data, e.resp);
    mostrarPaso('mi-roto');
  }
}

function pintarEspacio() {
  const pila = estado.nombre ? estado.nombre.split(' ')[0] : '';
  $('mi-saludo').textContent = pila ? `${pila}, tu espacio` : 'Tu espacio';
  $('mi-zona').textContent = `Los horarios están en hora de ${nombreDeZona()}.`;

  const proximo = estado.turnos[0];
  $('mi-sin-turnos').hidden = Boolean(proximo);
  $('mi-proximo').hidden = !proximo;
  $('mi-btn-cambiar').hidden = !proximo;
  $('mi-nota-cambiar').hidden = true;

  if (proximo) {
    $('mi-proximo-etiqueta').textContent = proximo.deSerie
      ? 'Tu próximo encuentro'
      : 'Tu próxima consulta';
    $('mi-proximo-cuando').textContent = `${textoDiaLargo(proximo.inicio)}, ${textoHora(proximo.inicio)}`;
    $('mi-proximo-dura').textContent = `Dura ${proximo.duracionMin} minutos.`;
    pintarDonde($('mi-proximo-donde'), proximo);

    $('mi-btn-cambiar').disabled = !proximo.puedeCambiar;
    if (!proximo.puedeCambiar) {
      $('mi-nota-cambiar').hidden = false;
      $('mi-nota-cambiar').innerHTML = `Los cambios se pueden hacer hasta ${proximo.anticipacionCambioHoras} horas antes, y ya falta menos que eso. Si necesitás moverlo igual, escribime a <a href="mailto:info@sebabru.com">info@sebabru.com</a>.`;
    }
  }

  // Los que vienen despues del proximo.
  const siguientes = estado.turnos.slice(1);
  $('mi-siguientes').hidden = siguientes.length === 0;
  const lista = $('mi-lista-siguientes');
  lista.innerHTML = '';
  for (const t of siguientes) {
    const fila = document.createElement('div');
    fila.className = 'mi-fila';
    const fecha = document.createElement('div');
    fecha.className = 'mi-fecha';
    fecha.textContent = `${textoDiaLargo(t.inicio)}, ${textoHora(t.inicio)}`;
    const dura = document.createElement('div');
    dura.className = 'mi-dura';
    dura.textContent = `${t.duracionMin} min`;
    fila.append(fecha, dura);
    lista.appendChild(fila);
  }

  // Las notificaciones son de la serie: quien tiene una consulta suelta no
  // tiene nada que elegir aca.
  const serie = estado.series[0];
  $('mi-notis').hidden = !serie;
  if (serie) {
    $('mi-noti-recordatorio').checked = (serie.notificaciones || {}).recordatorio !== false;
  }

  mostrarPaso('mi-espacio');
}

// Donde es el encuentro. El enlace del Meet lo arma el servidor desde el
// evento de Google, asi que no es texto de nadie: igual se mete con el DOM.
function pintarDonde(caja, turno) {
  caja.textContent = '';
  if (turno.modalidad === 'Presencial') {
    caja.textContent = 'El encuentro es presencial. Pedile a Clari cómo llegar: ';
    const a = document.createElement('a');
    a.href = 'https://wa.me/5493544559877';
    a.textContent = '+54 9 3544 559877';
    caja.appendChild(a);
    return;
  }
  if (turno.meet) {
    caja.textContent = 'El encuentro es por Google Meet: ';
    const a = document.createElement('a');
    a.href = turno.meet;
    a.textContent = 'entrar a la reunión';
    caja.appendChild(a);
    return;
  }
  caja.innerHTML = 'El encuentro es por Zoom: <a href="https://us02web.zoom.us/j/8020861967?pwd=Gl9uLBofVZd0XmzTPhAHnQDc8RtnsE.1">entrar a la reunión</a> (ID 802 086 1967, passcode paso).';
}

// -------------------------------------------------------
// Elegir otro horario
// -------------------------------------------------------
async function abrirCambio() {
  const turno = estado.turnos[0];
  if (!turno) return;
  estado.moviendo = turno;
  estado.elegida = null;
  limpiar('mi-error-elegir');
  limpiar('mi-error-confirmar');
  $('mi-resumen').hidden = true;
  $('mi-dias-sueltos').innerHTML = '';
  $('mi-sueltos').hidden = true;
  $('mi-nada').hidden = true;
  $('mi-horarios').hidden = true;
  $('mi-elegir-zona').textContent = `Vas a mover el encuentro del ${textoDiaLargo(turno.inicio)} a las ${textoHora(turno.inicio)}. Los horarios están en hora de ${nombreDeZona()}.`;
  mostrarPaso('mi-elegir');
  cargando(true);

  try {
    const data = await llamar('miDisponibilidad', { query: { turno: turno.id } });
    cargando(false);
    estado.disponibilidad = data;
    if (data.pausado) {
      mostrarError('mi-error-elegir', MENSAJES.agenda_pausada);
      return;
    }
    pintarHorarios(data);
  } catch (e) {
    cargando(false);
    mostrarError('mi-error-elegir', mensajeDe(e.data, e.resp));
  }
}

// El calendario de mes, compartido con /consultas/agenda/. Se arma una sola
// vez: despues solo se le cambian los horarios.
let calendario = null;

function armarCalendario() {
  if (calendario) return calendario;
  calendario = calendarioMes({
    grilla: $('mi-grilla'),
    titulo: $('mi-mes-nombre'),
    botonAntes: $('mi-mes-antes'),
    botonDespues: $('mi-mes-despues'),
    zona: () => estado.zona,
    vacio: 'No hay horarios libres en los próximos días.',
    alElegirDia: () => pintarHorasDelDia(),
  });
  return calendario;
}

function pintarHorarios(data) {
  const cal = armarCalendario();
  cal.mostrar(data.slots || []);
  pintarHorasDelDia();

  const sueltos = pintarDiasSueltos($('mi-dias-sueltos'), data.excepcionales || []);
  $('mi-sueltos').hidden = !sueltos;
  $('mi-nada').hidden = (data.slots || []).length > 0 || sueltos;
}

// Las horas del dia elegido en el calendario, con los tramos guardados para
// consultas en gris al lado de las que si se pueden tomar.
function pintarHorasDelDia() {
  const data = estado.disponibilidad;
  const caja = $('mi-horarios');
  const lista = $('mi-lista-horas');
  lista.innerHTML = '';

  const dia = calendario.diaElegido();
  const horas = calendario.horariosDelDia();
  if (!dia || !horas.length) {
    caja.hidden = true;
    return;
  }
  caja.hidden = false;
  $('mi-horarios-titulo').textContent = textoDiaLargo(horas[0]);

  for (const iso of horas) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mi-hora'
      + (iso === estado.elegida ? ' elegida' : '')
      + (iso === data.actual ? ' actual' : '');
    b.textContent = textoHora(iso);
    if (iso === data.actual) b.title = 'El horario que tenés ahora';
    b.addEventListener('click', () => {
      estado.elegida = iso;
      pintarHorasDelDia();
      pintarResumen(data);
    });
    lista.appendChild(b);
  }

  // Los guardados para consultas, solo los de este dia: se ven, con su
  // motivo, en lugar de desaparecer sin explicacion.
  for (const b of (data.bloqueados || [])) {
    if (b.diaEntero || claveDia(b.desde) !== dia) continue;
    const gris = document.createElement('button');
    gris.type = 'button';
    gris.className = 'mi-hora reservado';
    gris.disabled = true;
    gris.textContent = `${textoHora(b.desde)} a ${textoHora(b.hasta)}`;
    gris.title = b.motivo || 'Guardado para consultas de dos horas';
    lista.appendChild(gris);
  }
}

// Los extraordinarios siguen siendo una lista: son pocos y sueltos, y
// meterlos en un calendario propio seria un mes casi vacio.
function pintarDiasSueltos(caja, slots) {
  caja.innerHTML = '';
  const porDia = new Map();
  for (const iso of slots) {
    const dia = claveDia(iso);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(iso);
  }

  for (const [, horas] of [...porDia.entries()].sort()) {
    const bloque = document.createElement('div');
    bloque.className = 'mi-dia';

    const titulo = document.createElement('h4');
    titulo.textContent = textoDiaLargo(horas[0]);
    bloque.appendChild(titulo);

    const fila = document.createElement('div');
    fila.className = 'mi-horas';
    for (const iso of horas) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mi-hora' + (iso === estado.elegida ? ' elegida' : '');
      b.textContent = textoHora(iso);
      b.addEventListener('click', () => {
        estado.elegida = iso;
        pintarDiasSueltos(caja, slots);
        pintarResumen(estado.disponibilidad);
      });
      fila.appendChild(b);
    }
    bloque.appendChild(fila);
    caja.appendChild(bloque);
  }

  return porDia.size > 0;
}

function pintarResumen(data) {
  if (!estado.elegida) return;
  limpiar('mi-error-confirmar');
  const esElMismo = estado.elegida === data.actual;
  $('mi-resumen-texto').innerHTML = esElMismo
    ? 'Ese es el horario que ya tenés. Si querés dejarlo así, volvé para atrás.'
    : `Tu encuentro pasa al <strong>${textoDiaLargo(estado.elegida)} a las ${textoHora(estado.elegida)}</strong>, y dura ${data.duracionMin} minutos.`;
  $('mi-btn-confirmar').disabled = esElMismo;
  $('mi-resumen').hidden = false;
  $('mi-resumen').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function confirmar() {
  if (!estado.elegida || !estado.moviendo) return;
  const boton = $('mi-btn-confirmar');
  const original = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Moviendo...';
  limpiar('mi-error-confirmar');
  // El evento del calendario se espera en linea, asi que esto puede tardar.
  const reloj = setTimeout(() => $('mi-tarda').classList.add('visible'), 3000);

  try {
    const data = await llamar('miCambio', {
      metodo: 'POST',
      cuerpo: { turno: estado.moviendo.id, inicio: estado.elegida },
    });
    if (data.sinCambios) {
      volverAlEspacio();
      return;
    }
    // El espacio se vuelve a pedir en lugar de parchearse en memoria: lo que
    // acaba de cambiar son los turnos, y el servidor es el que sabe como
    // quedaron.
    await abrirEspacio();
    mostrarOk('Listo, tu encuentro quedó movido. Te mandé la confirmación por mail.');
  } catch (e) {
    mostrarError('mi-error-confirmar', mensajeDe(e.data, e.resp));
    // Si se lo gano otra persona, la lista que esta viendo ya no sirve.
    if (e.data && e.data.error === 'slot_ocupado') {
      estado.elegida = null;
      $('mi-resumen').hidden = true;
      await abrirCambio();
    }
  } finally {
    clearTimeout(reloj);
    $('mi-tarda').classList.remove('visible');
    boton.disabled = false;
    boton.textContent = original;
  }
}

function mostrarOk(texto) {
  const caja = $('mi-ok');
  caja.textContent = texto;
  caja.classList.add('visible');
  setTimeout(() => caja.classList.remove('visible'), 8000);
}

function volverAlEspacio() {
  estado.elegida = null;
  estado.moviendo = null;
  limpiar('mi-ok');
  mostrarPaso('mi-espacio');
}

// -------------------------------------------------------
// Entrar con la cuenta de la escuela
// -------------------------------------------------------
async function entrarConMail(evento) {
  evento.preventDefault();
  limpiar('mi-error-login');
  const boton = $('mi-btn-entrar');
  const email = $('mi-email').value.trim();
  const pass = $('mi-pass').value;
  if (!email || !pass) {
    mostrarError('mi-error-login', 'Completá tu mail y tu contraseña.');
    return;
  }
  boton.disabled = true;
  boton.textContent = 'Entrando...';
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // De acá sigue onAuthStateChanged.
  } catch (_) {
    mostrarError('mi-error-login', 'No pudimos entrar con ese mail y esa contraseña. Si no te acordás, escribime a info@sebabru.com.');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Entrar';
  }
}

async function entrarConGoogleAca() {
  limpiar('mi-error-login');
  const boton = $('mi-btn-google');
  boton.disabled = true;
  try {
    // Se trae recien al apretar el boton: quien entra con su enlace del mail
    // no descarga nunca este modulo.
    const { entrarConGoogle } = await import('../../escuela/google.js');
    await entrarConGoogle(auth);
  } catch (_) {
    mostrarError('mi-error-login', 'No pudimos entrar con Google. Probá de nuevo.');
  } finally {
    boton.disabled = false;
  }
}

// -------------------------------------------------------
// Notificaciones
// -------------------------------------------------------
async function guardarNotificaciones() {
  const serie = estado.series[0];
  if (!serie) return;
  const casillero = $('mi-noti-recordatorio');
  casillero.disabled = true;
  try {
    await llamar('miAgenda', {
      metodo: 'POST',
      cuerpo: {
        accion: 'notificaciones',
        serie: serie.id,
        recordatorio: casillero.checked,
      },
    });
    mostrarOk('Listo, lo guardé.');
  } catch (e) {
    // Se vuelve el casillero a como estaba: no queda diciendo algo que no
    // se guardo.
    casillero.checked = !casillero.checked;
    mostrarError('mi-error-espacio', mensajeDe(e.data, e.resp));
  } finally {
    casillero.disabled = false;
  }
}

// -------------------------------------------------------
// Arranque
// -------------------------------------------------------
$('mi-btn-cambiar').addEventListener('click', abrirCambio);
$('mi-btn-volver').addEventListener('click', volverAlEspacio);
$('mi-btn-confirmar').addEventListener('click', confirmar);
$('mi-btn-google').addEventListener('click', entrarConGoogleAca);
$('mi-form-login').addEventListener('submit', entrarConMail);
$('mi-btn-reintentar').addEventListener('click', () => {
  if (estado.a || auth.currentUser) abrirEspacio();
  else mostrarPaso('mi-entrar');
});
$('mi-noti-recordatorio').addEventListener('change', guardarNotificaciones);

estado.a = new URLSearchParams(location.search).get('a');

if (estado.a) {
  // Con enlace no se espera a Firebase: es el camino de quien no tiene
  // cuenta, y hacerlo esperar a que el SDK resuelva que no hay sesion es
  // medio segundo de pantalla en blanco al gusto de nadie.
  abrirEspacio();
} else {
  onAuthStateChanged(auth, usuario => {
    if (!usuario) {
      if (!estado.abierto) mostrarPaso('mi-entrar');
      return;
    }
    abrirEspacio();
  });
}
