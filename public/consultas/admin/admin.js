// Panel de la agenda de consultas.
//
// No lee Firestore directo: todo pasa por la function adminAgenda, que
// verifica el ID token y el claim admin. Asi las colecciones agenda_* quedan
// cerradas al cliente en firestore.rules.

import { auth } from '../../escuela/firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { entrarConGoogle } from '../../escuela/google.js';

const API = 'https://us-central1-sebabru-e5563.cloudfunctions.net';
const ZONA = 'America/Argentina/Cordoba';
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const $ = id => document.getElementById(id);
let datos = { config: null, turnos: [], bloqueos: [] };

function mostrarPaso(id) {
  for (const p of document.querySelectorAll('.pa-paso')) p.classList.remove('visible');
  $('pa-cargando').style.display = 'none';
  if (id) $(id).classList.add('visible');
}

function avisar(texto, tipo) {
  const caja = $(tipo === 'error' ? 'pa-error' : 'pa-ok');
  const otra = $(tipo === 'error' ? 'pa-ok' : 'pa-error');
  otra.classList.remove('visible');
  caja.textContent = texto;
  caja.classList.add('visible');
  if (tipo !== 'error') setTimeout(() => caja.classList.remove('visible'), 4000);
}

function fechaLarga(iso) {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

// -------------------------------------------------------
// Llamadas
// -------------------------------------------------------
async function llamar(cuerpo) {
  const usuario = auth.currentUser;
  if (!usuario) throw new Error('sin_sesion');
  const token = await usuario.getIdToken();
  const resp = await fetch(`${API}/adminAgenda`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(cuerpo),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data.error || 'fallo'), { data });
  return data;
}

async function recargar() {
  const data = await llamar({ accion: 'listar' });
  datos = data;
  pintarTurnos();
  pintarConfig();
  pintarBloqueos();
}

// -------------------------------------------------------
// Turnos
// -------------------------------------------------------
function pintarTurnos() {
  const caja = $('pa-lista-turnos');
  caja.innerHTML = '';
  const ahora = Date.now();
  const vigentes = datos.turnos.filter(t => t.estado === 'reservado');

  if (!vigentes.length) {
    const p = document.createElement('p');
    p.className = 'pa-vacio';
    p.textContent = 'No hay turnos reservados en esta ventana.';
    caja.appendChild(p);
    return;
  }

  for (const t of vigentes) {
    const fila = document.createElement('div');
    fila.className = 'pa-turno' + (Date.parse(t.inicio) < ahora ? ' cancelado' : '');

    const cuando = document.createElement('div');
    cuando.className = 'pa-cuando';
    cuando.textContent = fechaLarga(t.inicio);
    fila.appendChild(cuando);

    const quien = document.createElement('div');
    quien.className = 'pa-quien';
    quien.textContent = `${t.nombre || 'sin nombre'} · ${t.email || ''} · ${t.telefono || ''} · ${t.modalidad || ''}`;
    if (!t.enCalendario) {
      const aviso = document.createElement('div');
      aviso.className = 'pa-aviso-cal';
      aviso.textContent = 'No está en tu calendario: anotalo a mano.';
      quien.appendChild(aviso);
    }
    fila.appendChild(quien);

    const acciones = document.createElement('div');
    acciones.className = 'pa-acciones';

    const mover = document.createElement('button');
    mover.type = 'button';
    mover.className = 'pa-mini';
    mover.textContent = 'Mover';
    mover.addEventListener('click', () => moverTurno(t));
    acciones.appendChild(mover);

    const cancelar = document.createElement('button');
    cancelar.type = 'button';
    cancelar.className = 'pa-mini';
    cancelar.textContent = 'Cancelar';
    cancelar.addEventListener('click', () => cancelarTurno(t));
    acciones.appendChild(cancelar);

    fila.appendChild(acciones);
    caja.appendChild(fila);
  }
}

async function cancelarTurno(t) {
  if (!window.confirm(`¿Cancelar el turno de ${t.nombre || t.email} del ${fechaLarga(t.inicio)}? Le va a llegar un mail avisándole.`)) return;
  try {
    await llamar({ accion: 'cancelar', turnoId: t.id });
    avisar('Turno cancelado.', 'ok');
    await recargar();
  } catch (e) {
    avisar(`No se pudo cancelar: ${e.message}`, 'error');
  }
}

async function moverTurno(t) {
  const actual = t.inicio.slice(0, 16);
  const nuevo = window.prompt(
    'Nueva fecha y hora, en hora de Argentina (formato AAAA-MM-DDTHH:MM):', actual
  );
  if (!nuevo) return;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(nuevo.trim())) {
    avisar('El formato tiene que ser AAAA-MM-DDTHH:MM, por ejemplo 2026-12-03T16:00.', 'error');
    return;
  }
  try {
    // Al admin no se le aplican las franjas ni la anticipación: solo se
    // controla que no se pise con algo que ya tenga en el calendario.
    await llamar({ accion: 'mover', turnoId: t.id, inicio: `${nuevo.trim()}:00-03:00` });
    avisar('Turno movido. A la persona le llegó el mail con la fecha nueva.', 'ok');
    await recargar();
  } catch (e) {
    avisar(e.message === 'slot_ocupado'
      ? 'Ese horario se pisa con otra cosa de tu calendario.'
      : `No se pudo mover: ${e.message}`, 'error');
  }
}

// -------------------------------------------------------
// Disponibilidad
// -------------------------------------------------------
function pintarConfig() {
  const c = datos.config || {};
  $('pa-duracion').value = c.duracionMin ?? 120;
  $('pa-buffer').value = c.bufferMin ?? 15;
  $('pa-granularidad').value = c.granularidadMin ?? 30;
  $('pa-anticipacion').value = c.anticipacionHoras ?? 48;
  $('pa-ventana').value = c.ventanaDias ?? 60;
  $('pa-pausado').checked = c.pausado === true;

  const caja = $('pa-semana');
  caja.innerHTML = '';
  // Lunes primero, domingo al final: es como se lee una semana.
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const fila = document.createElement('div');
    fila.className = 'pa-dia';
    fila.dataset.dia = String(d);

    const nombre = document.createElement('strong');
    nombre.textContent = DIAS[d];
    fila.appendChild(nombre);

    const franjas = document.createElement('div');
    franjas.className = 'pa-franjas';
    fila.appendChild(franjas);

    const sumar = document.createElement('button');
    sumar.type = 'button';
    sumar.className = 'pa-mini';
    sumar.textContent = '+ franja';
    sumar.addEventListener('click', () => agregarFranja(franjas, '', ''));
    fila.appendChild(sumar);

    for (const f of (c.semana?.[String(d)] || [])) agregarFranja(franjas, f.desde, f.hasta);
    caja.appendChild(fila);
  }
}

function agregarFranja(contenedor, desde, hasta) {
  const caja = document.createElement('div');
  caja.className = 'pa-franja';

  const a = document.createElement('input');
  a.type = 'time'; a.value = desde || '10:00'; a.setAttribute('aria-label', 'Desde');
  const b = document.createElement('input');
  b.type = 'time'; b.value = hasta || '18:00'; b.setAttribute('aria-label', 'Hasta');

  const quitar = document.createElement('button');
  quitar.type = 'button';
  quitar.className = 'pa-mini';
  quitar.textContent = '×';
  quitar.setAttribute('aria-label', 'Quitar la franja');
  quitar.addEventListener('click', () => caja.remove());

  caja.append(a, document.createTextNode('a'), b, quitar);
  contenedor.appendChild(caja);
}

function leerConfigDeLaPantalla() {
  const semana = {};
  for (const fila of document.querySelectorAll('.pa-dia')) {
    const franjas = [];
    for (const f of fila.querySelectorAll('.pa-franja')) {
      const [a, b] = f.querySelectorAll('input');
      if (a.value && b.value) franjas.push({ desde: a.value, hasta: b.value });
    }
    if (franjas.length) semana[fila.dataset.dia] = franjas;
  }
  return {
    duracionMin: Number($('pa-duracion').value),
    bufferMin: Number($('pa-buffer').value),
    granularidadMin: Number($('pa-granularidad').value),
    anticipacionHoras: Number($('pa-anticipacion').value),
    ventanaDias: Number($('pa-ventana').value),
    pausado: $('pa-pausado').checked,
    semana,
  };
}

async function guardarConfig() {
  const boton = $('pa-btn-guardar');
  boton.disabled = true;
  try {
    await llamar({ accion: 'guardarConfig', config: leerConfigDeLaPantalla() });
    avisar('Disponibilidad guardada.', 'ok');
    await recargar();
  } catch (e) {
    avisar(`No se pudo guardar: ${e.message}`, 'error');
  } finally {
    boton.disabled = false;
  }
}

// -------------------------------------------------------
// Bloqueos
// -------------------------------------------------------
function pintarBloqueos() {
  const caja = $('pa-lista-bloqueos');
  caja.innerHTML = '';
  if (!datos.bloqueos.length) {
    const p = document.createElement('p');
    p.className = 'pa-vacio';
    p.textContent = 'No hay días bloqueados.';
    caja.appendChild(p);
    return;
  }
  for (const b of datos.bloqueos.sort((x, y) => x.desde.localeCompare(y.desde))) {
    const fila = document.createElement('div');
    fila.className = 'pa-turno';

    const texto = document.createElement('div');
    texto.className = 'pa-cuando';
    texto.textContent = b.desde === b.hasta ? b.desde : `${b.desde} a ${b.hasta}`;
    fila.appendChild(texto);

    const motivo = document.createElement('div');
    motivo.className = 'pa-quien';
    motivo.textContent = b.motivo || '';
    fila.appendChild(motivo);

    const quitar = document.createElement('button');
    quitar.type = 'button';
    quitar.className = 'pa-mini';
    quitar.textContent = 'Quitar';
    quitar.addEventListener('click', async () => {
      try {
        await llamar({ accion: 'desbloquear', id: b.id });
        await recargar();
      } catch (e) {
        avisar(`No se pudo quitar: ${e.message}`, 'error');
      }
    });
    fila.appendChild(quitar);
    caja.appendChild(fila);
  }
}

async function bloquear() {
  const desde = $('pa-bl-desde').value;
  const hasta = $('pa-bl-hasta').value || desde;
  if (!desde) return avisar('Elegí al menos la fecha de inicio.', 'error');
  try {
    await llamar({ accion: 'bloquear', desde, hasta, motivo: $('pa-bl-motivo').value.trim() });
    $('pa-bl-desde').value = ''; $('pa-bl-hasta').value = ''; $('pa-bl-motivo').value = '';
    avisar('Días bloqueados.', 'ok');
    await recargar();
  } catch (e) {
    avisar(`No se pudo bloquear: ${e.message}`, 'error');
  }
}

// -------------------------------------------------------
// Vista previa
//
// El iframe trae la pagina publica de verdad, no una copia: una copia se
// veria parecida hoy y mentiria en tres meses. Y se carga recien al apretar
// el boton, porque es una pagina entera: el panel tiene que seguir
// abriendose rapido.
// -------------------------------------------------------
async function cargarPrevia() {
  const boton = $('pa-btn-previa');
  boton.disabled = true;
  boton.textContent = 'Buscando horarios...';
  try {
    const data = await llamar({ accion: 'previsualizar', modalidad: $('pa-previa-modalidad').value });
    const marco = $('pa-previa-marco');
    marco.hidden = false;
    // Con el cache-buster, volver a apretar el boton recarga de verdad.
    marco.src = `/consultas/agenda/?p=${encodeURIComponent(data.p)}&t=${encodeURIComponent(data.t)}&r=${Date.now()}`;
    pintarHorariosLibres(data);
    boton.textContent = 'Actualizar la vista previa';
  } catch (e) {
    avisar(`No se pudo armar la vista previa: ${e.message}`, 'error');
    boton.textContent = 'Cargar la vista previa';
  } finally {
    boton.disabled = false;
  }
}

function pintarHorariosLibres(data) {
  const caja = $('pa-previa-horarios');
  caja.innerHTML = '';
  const slots = data.slots || [];

  const total = document.createElement('p');
  total.className = 'pa-previa-total';
  if (data.pausado) {
    total.textContent = 'La agenda está cerrada: nadie puede reservar.';
  } else if (!slots.length) {
    total.textContent = `No hay ningún horario libre entre el ${data.desde} y el ${data.hasta}.`;
  } else {
    const dias = new Set(slots.map(s => s.slice(0, 10))).size;
    total.textContent = `${slots.length} horarios libres en ${dias} día${dias > 1 ? 's' : ''}, entre el ${data.desde} y el ${data.hasta}`;
  }
  caja.appendChild(total);
  if (!slots.length) return;

  // Los slots vienen en hora de Argentina y ordenados, asi que el dia sale
  // de los primeros diez caracteres: no hace falta mirar zonas horarias.
  const porDia = new Map();
  for (const iso of slots) {
    const dia = iso.slice(0, 10);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(iso);
  }

  for (const [dia, horas] of porDia) {
    const fila = document.createElement('div');
    fila.className = 'pa-previa-dia';

    const fecha = document.createElement('div');
    fecha.className = 'pa-previa-fecha';
    fecha.textContent = new Intl.DateTimeFormat('es-AR', {
      timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'long',
    }).format(new Date(horas[0]));
    fila.appendChild(fecha);

    const texto = document.createElement('div');
    texto.className = 'pa-previa-horas';
    texto.textContent = horas.map(h => h.slice(11, 16)).join(' · ');
    fila.appendChild(texto);

    const bloquear = document.createElement('button');
    bloquear.type = 'button';
    bloquear.className = 'pa-mini';
    bloquear.textContent = 'Bloquear este día';
    bloquear.addEventListener('click', () => bloquearDia(dia, bloquear));
    fila.appendChild(bloquear);

    caja.appendChild(fila);
  }
}

async function bloquearDia(dia, boton) {
  if (!window.confirm(`¿Bloquear el ${dia}? Deja de ofrecerse, y los turnos que ya estén reservados ese día siguen en pie.`)) return;
  boton.disabled = true;
  try {
    await llamar({ accion: 'bloquear', desde: dia, hasta: dia, motivo: '' });
    avisar('Día bloqueado.', 'ok');
    await recargar();
    await cargarPrevia();
  } catch (e) {
    avisar(`No se pudo bloquear: ${e.message}`, 'error');
    boton.disabled = false;
  }
}

// -------------------------------------------------------
// Sesión
// -------------------------------------------------------
async function entrar() {
  const boton = $('pa-btn-entrar');
  boton.disabled = true;
  $('pa-error-login').classList.remove('visible');
  try {
    await entrarConGoogle(auth);
  } catch (e) {
    $('pa-error-login').textContent = 'No pudimos entrar con Google. Probá de nuevo.';
    $('pa-error-login').classList.add('visible');
  } finally {
    boton.disabled = false;
  }
}

// El claim admin lo pone fijarClaimsAdmin para las cuentas de la lista.
// Se pide siempre al entrar: la primera vez la cuenta todavía no lo tiene,
// y despues de ponerlo hay que renovar el token para que el claim viaje.
async function asegurarClaimAdmin(usuario) {
  const resp = await fetch(`${API}/fijarClaimsAdmin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await usuario.getIdToken()}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.admin) return false;
  await usuario.getIdToken(true);
  return true;
}

onAuthStateChanged(auth, async usuario => {
  if (!usuario) {
    mostrarPaso('pa-login');
    return;
  }
  $('pa-cargando').style.display = 'block';
  try {
    if (!(await asegurarClaimAdmin(usuario))) {
      $('pa-error-login').textContent = 'Esta cuenta no tiene acceso al panel.';
      $('pa-error-login').classList.add('visible');
      mostrarPaso('pa-login');
      return;
    }
    await recargar();
    mostrarPaso('pa-panel');
  } catch (e) {
    $('pa-error-login').textContent = `No pudimos abrir el panel: ${e.message}`;
    $('pa-error-login').classList.add('visible');
    mostrarPaso('pa-login');
  }
});

$('pa-btn-entrar').addEventListener('click', entrar);
$('pa-btn-salir').addEventListener('click', () => signOut(auth));
$('pa-btn-guardar').addEventListener('click', guardarConfig);
$('pa-btn-bloquear').addEventListener('click', bloquear);
$('pa-btn-previa').addEventListener('click', cargarPrevia);

for (const tab of document.querySelectorAll('.pa-tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.pa-tab')) t.classList.remove('activa');
    for (const p of document.querySelectorAll('.pa-panel')) p.classList.remove('visible');
    tab.classList.add('activa');
    $(tab.dataset.panel).classList.add('visible');
  });
}
