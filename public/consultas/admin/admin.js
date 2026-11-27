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
  pintarBorrador();
  pintarConfig();
  pintarBloqueos();
  pintarExcepcionales();
  await cargarCalendario();
}

// -------------------------------------------------------
// El borrador
//
// Lo que se guarda en Disponibilidad y en Bloqueos va al borrador, no a lo
// que ve la gente. Este cartel es lo único que separa las dos cosas, así que
// tiene que estar siempre que haya algo sin publicar y nunca cuando no.
// -------------------------------------------------------
function pintarBorrador() {
  $('pa-borrador').hidden = !datos.hayCambios;
  // Cada cosa por su nombre. "1 bloqueo o espacio extraordinario nuevo" es
  // la frase que escribe quien no quiere contar dos listas, y obliga a quien
  // la lee a ir a buscar cuál de las dos fue.
  const sueltas = [
    [(datos.bloqueos || []).filter(b => b.borrador === true).length, 'bloqueo', 'bloqueos'],
    [(datos.excepcionales || []).filter(e => e.borrador === true).length, 'espacio extraordinario', 'espacios extraordinarios'],
  ].filter(([n]) => n > 0).map(([n, uno, varios]) => `${n} ${n === 1 ? uno : varios}`);
  $('pa-borrador-detalle').textContent = sueltas.length ? `Hay ${sueltas.join(' y ')} sin publicar.` : '';
}

async function publicar() {
  if (!window.confirm('¿Publicar? A partir de ahora la gente ve esta configuración.')) return;
  const boton = $('pa-btn-publicar');
  boton.disabled = true;
  try {
    await llamar({ accion: 'publicar' });
    avisar('Publicado. Ahora la gente ve lo mismo que vos.', 'ok');
    await recargar();
  } catch (e) {
    avisar(`No se pudo publicar: ${e.message}`, 'error');
  } finally {
    boton.disabled = false;
  }
}

async function descartar() {
  if (!window.confirm('¿Descartar los cambios sin publicar? Vuelve a quedar como lo que ve la gente.')) return;
  try {
    await llamar({ accion: 'descartarBorrador' });
    avisar('Descartado.', 'ok');
    await recargar();
  } catch (e) {
    avisar(`No se pudo descartar: ${e.message}`, 'error');
  }
}

// -------------------------------------------------------
// El calendario
//
// Un mes por pantalla, con el nombre de quien viene cada día, y el día que se
// toca desplegado abajo con todo lo que pasa en él: lo tomado, lo libre para
// cada tipo, lo guardado para consultas y lo extraordinario.
//
// Por qué el resumen y el detalle están separados: en una celda de mes no
// entran cinco espacios de tres clases distintas, y menos en el celular. Pero
// un mes es la unidad en la que se piensa una agenda, así que la celda resume
// (nombres y puntitos) y el día abierto cuenta el resto.
//
// Mira el borrador, igual que la vista previa.
// -------------------------------------------------------
let calMes = null;        // 'YYYY-MM'
let diaAbierto = null;    // 'YYYY-MM-DD', el día desplegado
let ultimoCalendario = null;
// El turno que se está moviendo. Mientras hay uno elegido, los horarios
// libres del día abierto pasan a ser destinos en los que se puede tocar.
let turnoElegido = null;
const NOMBRES_POR_CELDA = 3;

function hoyISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Las cuentas del mes se hacen todas en UTC y al mediodía: así ningún cambio
// de hora corre un día para atrás.
function mesVecino(mes, n) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function diasDelMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

function nombreDeMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(a, m - 1, 15)));
}

async function cargarCalendario() {
  if (!calMes) calMes = hoyISO().slice(0, 7);
  const caja = $('pa-calendario');
  caja.textContent = 'Cargando...';
  try {
    const data = await llamar({
      accion: 'calendario',
      desde: `${calMes}-01`,
      hasta: `${calMes}-${String(diasDelMes(calMes)).padStart(2, '0')}`,
    });
    // Al entrar, el día de hoy ya desplegado: es lo que Seba viene a mirar.
    // En otro mes no se abre nada, porque no hay un día obvio.
    if (!diaAbierto || diaAbierto.slice(0, 7) !== calMes) {
      const hoy = hoyISO();
      diaAbierto = hoy.slice(0, 7) === calMes ? hoy : null;
    }
    pintarCalendario(data);
  } catch (e) {
    caja.textContent = '';
    avisar(`No se pudo cargar el calendario: ${e.message}`, 'error');
  }
}

function soloHora(iso) {
  return iso.slice(11, 16);
}

function fechaDelDia(diaISO) {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(`${diaISO}T12:00:00-03:00`));
}

// El nombre como entra en una celda de mes: el primero, sin apellido. Manda
// el ancho de la celda, y en un mes entero no hay lugar para más.
function nombresito(t) {
  const n = (t.nombre || '').trim();
  if (n) return n.split(/\s+/)[0];
  return (t.email || 'sin nombre').split('@')[0];
}

function pintarCalendario(data) {
  ultimoCalendario = data;
  $('pa-cal-rango').textContent = nombreDeMes(calMes);
  const caja = $('pa-calendario');
  caja.innerHTML = '';

  // La barra de "estás moviendo a alguien". Va arriba de todo porque, una vez
  // que se eligió un turno, es el único estado que importa en la pantalla.
  if (turnoElegido) {
    const barra = document.createElement('div');
    barra.className = 'pa-moviendo';

    const texto = document.createElement('div');
    texto.textContent = `Moviendo el turno de ${turnoElegido.nombre || turnoElegido.email} del ${fechaLarga(turnoElegido.inicio)}. Tocá el horario nuevo.`;
    barra.appendChild(texto);

    const botones = document.createElement('div');
    botones.className = 'pa-borrador-botones';
    const cancelarT = document.createElement('button');
    cancelarT.type = 'button';
    cancelarT.className = 'pa-mini';
    cancelarT.textContent = 'Cancelar el turno';
    cancelarT.addEventListener('click', () => cancelarTurno(turnoElegido));
    const soltar = document.createElement('button');
    soltar.type = 'button';
    soltar.className = 'pa-mini';
    soltar.textContent = 'Dejarlo como está';
    soltar.addEventListener('click', () => { turnoElegido = null; pintarCalendario(data); });
    botones.append(cancelarT, soltar);
    barra.appendChild(botones);

    caja.appendChild(barra);
  }

  // La grilla del mes
  const grilla = document.createElement('div');
  grilla.className = 'pa-mes';
  for (const n of ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom']) {
    const c = document.createElement('div');
    c.className = 'pa-mes-nombre';
    c.textContent = n;
    grilla.appendChild(c);
  }

  const porDia = new Map((data.dias || []).map(d => [d.dia, d]));
  const [anio, mes] = calMes.split('-').map(Number);
  // getUTCDay da 0 para domingo; la grilla arranca en lunes.
  const corrimiento = (new Date(Date.UTC(anio, mes - 1, 1)).getUTCDay() + 6) % 7;
  const hoy = hoyISO();

  for (let k = 0; k < corrimiento; k++) {
    const c = document.createElement('div');
    c.className = 'pa-mes-dia fuera';
    grilla.appendChild(c);
  }

  for (let n = 1; n <= diasDelMes(calMes); n++) {
    const clave = `${calMes}-${String(n).padStart(2, '0')}`;
    const d = porDia.get(clave)
      || { dia: clave, turnos: [], sesiones: [], consultas: [], guardados: [], extraordinarios: [], ocupado: [] };
    const total = d.turnos.length + d.sesiones.length + d.consultas.length
      + d.guardados.length + d.extraordinarios.length + (d.ocupado || []).length;

    const celda = document.createElement('button');
    celda.type = 'button';
    celda.className = 'pa-mes-dia'
      + (total ? '' : ' sinnada')
      + (clave === hoy ? ' hoy' : '')
      + (clave === diaAbierto ? ' abierto' : '');
    celda.setAttribute('aria-expanded', clave === diaAbierto ? 'true' : 'false');

    const numero = document.createElement('div');
    numero.className = 'pa-mes-numero';
    numero.textContent = String(n);
    celda.appendChild(numero);

    // Los nombresitos: para qué se abre esta pantalla es para ver quién
    // viene, así que van antes que cualquier otra cosa de la celda.
    for (const t of d.turnos.slice(0, NOMBRES_POR_CELDA)) {
      const chip = document.createElement('span');
      chip.className = `pa-mes-chip ${t.deSerie ? 'sesion' : 'consulta'}`
        + (t.enCalendario ? '' : ' sin-calendario');
      chip.textContent = `${soloHora(t.inicio)} ${nombresito(t)}`;
      celda.appendChild(chip);
    }
    if (d.turnos.length > NOMBRES_POR_CELDA) {
      const mas = document.createElement('span');
      mas.className = 'pa-mes-mas';
      mas.textContent = `+${d.turnos.length - NOMBRES_POR_CELDA}`;
      celda.appendChild(mas);
    }

    // Y los puntitos de lo que está libre o guardado, con su número. Es el
    // resumen que distingue un día con dos huecos de uno lleno.
    const marcas = document.createElement('div');
    marcas.className = 'pa-mes-marcas';
    const paraConsultaDelDia = new Set(d.consultas);
    const soloSesion = d.sesiones.filter(iso => !paraConsultaDelDia.has(iso)).length;
    const cuentas = [
      ['consulta', d.consultas.length, 'libre para una consulta'],
      ['sesion', soloSesion, 'libre solo para una sesión'],
      ['guardado', d.guardados.length, 'guardado para consultas'],
      ['extra', d.extraordinarios.length, 'extraordinario'],
      ['ocupado', (d.ocupado || []).length, 'ocupado en tu calendario'],
    ];
    for (const [clase, cuantos, que] of cuentas) {
      if (!cuantos) continue;
      const m = document.createElement('span');
      m.className = 'pa-mes-marca';
      m.title = `${cuantos} ${que}`;
      const punto = document.createElement('i');
      punto.className = `pa-punto ${clase}`;
      m.append(punto, document.createTextNode(String(cuantos)));
      marcas.appendChild(m);
    }
    celda.appendChild(marcas);

    celda.addEventListener('click', () => {
      diaAbierto = diaAbierto === clave ? null : clave;
      pintarCalendario(data);
    });
    grilla.appendChild(celda);
  }
  caja.appendChild(grilla);

  // Y el día desplegado
  if (diaAbierto) {
    const detalle = document.createElement('div');
    detalle.className = 'pa-mes-detalle';
    detalle.appendChild(pintarDia(porDia.get(diaAbierto)
      || { dia: diaAbierto, turnos: [], sesiones: [], consultas: [], guardados: [], extraordinarios: [] }));
    caja.appendChild(detalle);
  }
}

// Un día entero, con sus fichas. Es lo que se ve al tocar una celda del mes,
// y lo que hace que se pueda mover o cancelar un turno.
function pintarDia(d) {
  const habituales = d.habituales || [];
  const total = d.turnos.length + d.sesiones.length + d.consultas.length
    + d.guardados.length + d.extraordinarios.length + habituales.length;

  const bloque = document.createElement('div');
  bloque.className = 'pa-cal-dia';

  const fecha = document.createElement('div');
  fecha.className = 'pa-cal-fecha';
  fecha.textContent = fechaDelDia(d.dia);
  bloque.appendChild(fecha);

  const fichas = document.createElement('div');
  fichas.className = 'pa-cal-fichas';

  if (!total) {
    const nada = document.createElement('span');
    nada.className = 'pa-vacio';
    nada.style.fontSize = '0.78rem';
    nada.textContent = 'Sin horarios: no tenés franja abierta este día.';
    fichas.appendChild(nada);
  }

  // Lo tomado primero: es lo que Seba busca cuando abre esta pantalla.
  for (const t of d.turnos) {
    const f = ficha('tomado', `${soloHora(t.inicio)} ${t.nombre || t.email || 'sin nombre'}`);
    if (!t.enCalendario) {
      f.classList.add('sin-calendario');
      f.title = 'No está en tu calendario: anotalo a mano.';
    } else {
      f.title = `${t.deSerie ? 'Sesión' : 'Consulta'} · ${t.email || ''} · tocá para moverlo`;
    }
    if (turnoElegido && turnoElegido.id === t.id) f.classList.add('elegido');
    hacerBoton(f, () => elegirTurno(t));
    fichas.appendChild(f);
  }
  // Un horario que está libre para los dos tipos aparece una vez, como
  // consulta: ofrecerlo dos veces llenaría el día de fichas repetidas y
  // esconde lo que importa, que es dónde entra una de dos horas.
  const paraConsulta = new Set(d.consultas);
  const libre = (clase, iso, texto) => {
    const f = ficha(clase, texto);
    if (turnoElegido) {
      f.classList.add('destino');
      hacerBoton(f, () => moverTurnoA(iso));
    }
    return f;
  };
  for (const iso of d.consultas) fichas.appendChild(libre('consulta', iso, `${soloHora(iso)} · 2 h`));
  for (const iso of d.sesiones) {
    if (paraConsulta.has(iso)) continue;
    fichas.appendChild(libre('sesion', iso, `${soloHora(iso)} · 1 h`));
  }
  for (const g of d.guardados) {
    const f = ficha('guardado', `${soloHora(g.desde)}–${soloHora(g.hasta)} guardado`);
    if (g.motivo) f.title = g.motivo;
    fichas.appendChild(f);
  }
  for (const iso of d.extraordinarios) fichas.appendChild(ficha('extra', `${soloHora(iso)} extraordinario`));
  // Los espacios de los encuentros habituales que todavía no están tomados
  // como turno. Sin esta ficha, un día lleno de encuentros se vería igual que
  // un día sin franja: vacío y sin explicación.
  for (const h of habituales) {
    const f = ficha('habitual', `${soloHora(h.desde)}–${soloHora(h.hasta)} ${h.motivo || 'espacio habitual'}`);
    f.title = 'Espacio reservado para un encuentro habitual. No se ofrece a nadie más.';
    fichas.appendChild(f);
  }
  // Lo que ya tenías en Google Calendar. Va al final porque no es un espacio
  // de la agenda, es la razón por la que faltan espacios.
  for (const o of (d.ocupado || [])) {
    const f = ficha('ocupado', o.diaEntero
      ? 'Todo el día ocupado en tu calendario'
      : `${soloHora(o.desde)}–${soloHora(o.hasta)} ocupado en tu calendario`);
    f.title = 'Viene de Google Calendar: mientras esté, no se puede ofrecer ese rato.';
    fichas.appendChild(f);
  }

  bloque.appendChild(fichas);
  return bloque;
}

function ficha(clase, texto) {
  const f = document.createElement('span');
  f.className = `pa-ficha ${clase}`;
  f.textContent = texto;
  return f;
}

// Una ficha se vuelve tocable recién cuando hace algo. Se le pone rol y
// teclado a mano porque es un span: un botón de verdad traería su propio
// relleno y su propia tipografía, y habría que desarmárselos.
function hacerBoton(elemento, alTocar) {
  elemento.setAttribute('role', 'button');
  elemento.setAttribute('tabindex', '0');
  elemento.style.cursor = 'pointer';
  elemento.addEventListener('click', alTocar);
  elemento.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alTocar(); }
  });
}

// -------------------------------------------------------
// Mover y cancelar, desde el propio calendario
//
// Antes mover un turno era escribir "2026-12-03T16:00" en un window.prompt.
// Ahora se toca el turno y después el horario nuevo: los horarios libres ya
// están en pantalla, así que pedirlos tipeados era pedir que adivine algo
// que tiene delante.
// -------------------------------------------------------
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

function elegirTurno(t) {
  turnoElegido = turnoElegido && turnoElegido.id === t.id ? null : t;
  pintarCalendario(ultimoCalendario);
}

// Anotar un turno a mano. Si el horario se pisa con algo, se pregunta y se
// repite el pedido con `superponer`: superponer nunca pasa en silencio, y es
// lo único que el panel puede hacer y la página pública no.
async function anotarTurno(superponer) {
  const fecha = $('pa-nt-fecha').value;
  const hora = $('pa-nt-hora').value;
  const nombre = $('pa-nt-nombre').value.trim();
  if (!nombre) return avisar('Poné el nombre.', 'error');
  if (!fecha || !hora) return avisar('Poné la fecha y la hora.', 'error');

  const boton = $('pa-btn-nuevo-turno');
  boton.disabled = true;
  try {
    const duracion = Number($('pa-nt-duracion').value);
    const r = await llamar({
      accion: 'crearTurno',
      nombre,
      email: $('pa-nt-email').value.trim(),
      telefono: $('pa-nt-telefono').value.trim(),
      // El fragmento de hora de Argentina, igual que todo lo demás que manda
      // el panel: el servidor trabaja siempre en esa zona.
      inicio: `${fecha}T${hora}:00-03:00`,
      tipo: $('pa-nt-tipo').value,
      duracionMin: Number.isFinite(duracion) && duracion >= 15 ? duracion : null,
      modalidad: $('pa-nt-modalidad').value,
      avisar: $('pa-nt-avisar').checked,
      superponer: superponer === true,
    });
    for (const id of ['pa-nt-nombre', 'pa-nt-email', 'pa-nt-telefono', 'pa-nt-duracion']) $(id).value = '';
    avisar(`Anotado: ${fechaLarga(r.turno.inicio)}.`, 'ok');
    await cargarCalendario();
  } catch (e) {
    if (e.message === 'slot_ocupado' && !superponer) {
      const ok = window.confirm(
        'Ese horario se pisa con algo que ya tenés: otro turno, un encuentro habitual '
        + 'o algo de tu calendario.\n\n¿Lo anoto igual, superpuesto?');
      if (ok) return anotarTurno(true);
      return;
    }
    avisar(e.message === 'demasiados_superpuestos'
      ? 'Ya hay varios turnos superpuestos en ese mismo horario.'
      : `No se pudo anotar: ${e.message}`, 'error');
  } finally {
    boton.disabled = false;
  }
}

async function moverTurnoA(inicioISO) {
  const t = turnoElegido;
  if (!t) return;
  if (!window.confirm(`¿Mover el turno de ${t.nombre || t.email} al ${fechaLarga(inicioISO)}? Le va a llegar un mail con la fecha nueva.`)) return;
  try {
    // Al admin no se le aplican las franjas ni la anticipación: solo se
    // controla que no se pise con algo que ya tenga en el calendario.
    await llamar({ accion: 'mover', turnoId: t.id, inicio: inicioISO });
    turnoElegido = null;
    avisar('Turno movido. A la persona le llegó el mail con la fecha nueva.', 'ok');
    await cargarCalendario();
  } catch (e) {
    if (e.message === 'slot_ocupado') {
      const ok = window.confirm(
        'Ese horario se pisa con algo que ya tenés.\n\n¿Lo muevo igual, superpuesto?');
      if (ok) {
        try {
          await llamar({ accion: 'mover', turnoId: t.id, inicio: inicioISO, superponer: true });
          turnoElegido = null;
          avisar('Turno movido, superpuesto.', 'ok');
          await cargarCalendario();
          return;
        } catch (e2) {
          avisar(`No se pudo mover: ${e2.message}`, 'error');
          return;
        }
      }
      return;
    }
    avisar(`No se pudo mover: ${e.message}`, 'error');
  }
}

// -------------------------------------------------------
// Disponibilidad
// -------------------------------------------------------
// Los valores de fábrica de cada tipo, los mismos que tiene agenda-motor.js.
// Están acá para que un campo vacío muestre lo que el servidor va a usar de
// todos modos, en lugar de un hueco.
const TIPOS = {
  'una-hora': { duracionMin: 60, bufferMin: 15, anticipacionHoras: 24, anticipacionCambioHoras: 12 },
  'dos-horas': { duracionMin: 120, bufferMin: 15, anticipacionHoras: 48, anticipacionCambioHoras: 48 },
};

function pintarConfig() {
  const c = datos.config || {};

  // Lo que Seba guardó para cada tipo, o el valor de fábrica. La consulta de
  // dos horas además hereda los campos sueltos de la configuración vieja, que
  // es lo que hace que nada haya cambiado el día que aparecieron los tipos.
  const tipo = (id, campo) => {
    const guardado = c.tipos?.[id]?.[campo];
    if (Number.isFinite(guardado)) return guardado;
    if (id === 'dos-horas' && Number.isFinite(c[campo])) return c[campo];
    return TIPOS[id][campo];
  };

  $('pa-cadencia').value = Number.isFinite(c.cadenciaMin) ? c.cadenciaMin : '';
  for (const [id, pre] of [['una-hora', 'pa-t1'], ['dos-horas', 'pa-t2']]) {
    $(`${pre}-duracion`).value = tipo(id, 'duracionMin');
    $(`${pre}-buffer`).value = tipo(id, 'bufferMin');
    $(`${pre}-anticipacion`).value = tipo(id, 'anticipacionHoras');
    $(`${pre}-cambio`).value = tipo(id, 'anticipacionCambioHoras');
  }
  $('pa-ventana').value = c.ventanaDias ?? 60;
  $('pa-ventana-series').value = c.ventanaSeriesDias ?? 60;
  $('pa-pausado').checked = c.pausado === true;
  pintarCadencia();

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
    sumar.addEventListener('click', () => agregarFranja(franjas, null));
    fila.appendChild(sumar);

    for (const f of (c.semana?.[String(d)] || [])) agregarFranja(franjas, f);
    caja.appendChild(fila);
  }
}

// Cada campo lleva su clase y se lee por clase, nunca por posición dentro de
// la franja: antes eran dos `input` y se leían con un destructuring del
// querySelectorAll, así que el primer campo nuevo que entrara en la caja
// —este `input type="date"` del ancla— desordenaba los dos horarios en
// silencio.
function agregarFranja(contenedor, franja) {
  const f = franja || {};
  const caja = document.createElement('div');
  caja.className = 'pa-franja';

  const a = document.createElement('input');
  a.type = 'time'; a.className = 'pa-franja-desde';
  a.value = f.desde || '10:00'; a.setAttribute('aria-label', 'Desde');
  const b = document.createElement('input');
  b.type = 'time'; b.className = 'pa-franja-hasta';
  b.value = f.hasta || '18:00'; b.setAttribute('aria-label', 'Hasta');

  // Cada cuánto cae esta franja. Es lo que permite tener un viernes de
  // sesiones y el siguiente de consultas sin bloquear nada a mano.
  const frecuencia = document.createElement('select');
  frecuencia.className = 'pa-franja-frecuencia';
  frecuencia.setAttribute('aria-label', 'Cada cuánto');
  for (const [valor, texto] of [['semanal', 'todas las semanas'], ['quincenal', 'una semana de por medio']]) {
    const o = document.createElement('option');
    o.value = valor; o.textContent = texto;
    frecuencia.appendChild(o);
  }
  frecuencia.value = f.frecuencia === 'quincenal' ? 'quincenal' : 'semanal';

  // Desde qué día se cuentan las semanas. Solo hace falta si es quincenal.
  const ancla = document.createElement('input');
  ancla.type = 'date'; ancla.className = 'pa-franja-ancla';
  ancla.value = f.ancla || '';
  ancla.title = 'Desde qué día empieza a contarse';
  ancla.setAttribute('aria-label', 'Desde qué día');

  const verAncla = () => { ancla.hidden = frecuencia.value !== 'quincenal'; };
  frecuencia.addEventListener('change', verAncla);
  verAncla();

  // Para qué sirve la franja. Vacío es los dos tipos, que es lo que
  // significan las franjas de siempre.
  const tipos = document.createElement('select');
  tipos.className = 'pa-franja-tipos';
  tipos.setAttribute('aria-label', 'Para qué');
  for (const [valor, texto] of [['', 'sesiones y consultas'], ['una-hora', 'solo sesiones'], ['dos-horas', 'solo consultas']]) {
    const o = document.createElement('option');
    o.value = valor; o.textContent = texto;
    tipos.appendChild(o);
  }
  tipos.value = Array.isArray(f.tipos) && f.tipos.length === 1 ? f.tipos[0] : '';

  const quitar = document.createElement('button');
  quitar.type = 'button';
  quitar.className = 'pa-mini';
  quitar.textContent = '×';
  quitar.setAttribute('aria-label', 'Quitar la franja');
  quitar.addEventListener('click', () => caja.remove());

  caja.append(a, document.createTextNode('a'), b, frecuencia, ancla, tipos, quitar);
  contenedor.appendChild(caja);
}

// La primera franja que haya configurada, para mostrar la cadencia en
// concreto. Si no hay ninguna, se usa un jueves de 14 a 18, que es el ejemplo
// con el que esto se pensó.
function primeraFranja() {
  for (const fila of document.querySelectorAll('.pa-dia')) {
    const f = fila.querySelector('.pa-franja');
    if (!f) continue;
    const a = f.querySelector('.pa-franja-desde');
    const b = f.querySelector('.pa-franja-hasta');
    if (a.value && b.value && b.value > a.value) {
      return { dia: DIAS[Number(fila.dataset.dia)], desde: a.value, hasta: b.value };
    }
  }
  return { dia: 'jueves', desde: '14:00', hasta: '18:00' };
}

// Los horarios que la cadencia produce, escritos. Un número de minutos no se
// evalúa de un vistazo; una lista de horas sí. No duplica el motor: es la
// misma progresión aritmética, desde el arranque de la franja.
function pintarCadencia() {
  const caja = $('pa-cadencia-previa');
  const cadencia = Number($('pa-cadencia').value);
  const franja = primeraFranja();
  const enMinutos = h => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  const enHora = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  if (!Number.isFinite(cadencia) || cadencia < 15) {
    caja.classList.add('apagada');
    const sugerida = Number($('pa-t1-duracion').value) + Number($('pa-t1-buffer').value);
    caja.textContent = `Apagada: cada tipo usa su propia grilla, y la consulta se sigue ofreciendo cada ${datos.config?.granularidadMin ?? 30} minutos. Para que los dos compartan la misma, poné ${sugerida}.`;
    return;
  }

  caja.classList.remove('apagada');
  const inicio = enMinutos(franja.desde);
  const fin = enMinutos(franja.hasta);
  const arranques = [];
  for (let m = inicio; m <= fin; m += cadencia) arranques.push(m);

  const cabe = (duracion) => arranques.filter(m => m + duracion <= fin).map(enHora);
  const unaHora = cabe(Number($('pa-t1-duracion').value) || 60);
  const dosHoras = cabe(Number($('pa-t2-duracion').value) || 120);

  caja.textContent = `Un ${franja.dia.toLowerCase()} de ${franja.desde} a ${franja.hasta} daría: `
    + `sesiones a las ${unaHora.join(', ') || '(ninguna)'}; `
    + `consultas a las ${dosHoras.join(', ') || '(ninguna)'}.`;
}

function leerConfigDeLaPantalla() {
  const semana = {};
  for (const fila of document.querySelectorAll('.pa-dia')) {
    const franjas = [];
    for (const f of fila.querySelectorAll('.pa-franja')) {
      const a = f.querySelector('.pa-franja-desde').value;
      const b = f.querySelector('.pa-franja-hasta').value;
      if (!a || !b) continue;
      const frecuencia = f.querySelector('.pa-franja-frecuencia').value;
      const soloTipo = f.querySelector('.pa-franja-tipos').value;
      franjas.push({
        desde: a, hasta: b, frecuencia,
        ancla: frecuencia === 'quincenal' ? (f.querySelector('.pa-franja-ancla').value || null) : null,
        tipos: soloTipo ? [soloTipo] : [],
      });
    }
    if (franjas.length) semana[fila.dataset.dia] = franjas;
  }

  const delTipo = pre => ({
    duracionMin: Number($(`${pre}-duracion`).value),
    bufferMin: Number($(`${pre}-buffer`).value),
    anticipacionHoras: Number($(`${pre}-anticipacion`).value),
    anticipacionCambioHoras: Number($(`${pre}-cambio`).value),
  });

  const cadencia = Number($('pa-cadencia').value);

  return {
    // Los campos sueltos de siempre siguen yendo, con lo que diga la consulta
    // de dos horas: son los que lee cualquier cosa que todavía no sepa de
    // tipos, y el servidor los usa como valor heredado.
    ...delTipo('pa-t2'),
    granularidadMin: datos.config?.granularidadMin ?? 30,
    // Vacío o fuera de rango apaga la cadencia compartida.
    cadenciaMin: Number.isFinite(cadencia) && cadencia >= 15 ? cadencia : null,
    ventanaDias: Number($('pa-ventana').value),
    ventanaSeriesDias: Number($('pa-ventana-series').value),
    pausado: $('pa-pausado').checked,
    semana,
    tipos: { 'una-hora': delTipo('pa-t1'), 'dos-horas': delTipo('pa-t2') },
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
    const dias = b.desde === b.hasta ? b.desde : `${b.desde} a ${b.hasta}`;
    texto.textContent = b.desdeHora && b.hastaHora
      ? `${dias}, de ${b.desdeHora} a ${b.hastaHora}`
      : dias;
    fila.appendChild(texto);

    const motivo = document.createElement('div');
    motivo.className = 'pa-quien';
    // A qué tipo aplica, escrito: es lo que distingue "me tomé el día" de
    // "guardé este bloque para una consulta", y en la lista se confunden.
    const para = {
      'una-hora': 'Solo las sesiones de una hora (guardado para una consulta)',
      'dos-horas': 'Solo las consultas',
    }[(b.tipos || [])[0]] || 'Todo';
    motivo.textContent = [para, b.motivo].filter(Boolean).join(' · ');
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
  const desdeHora = $('pa-bl-desde-hora').value;
  const hastaHora = $('pa-bl-hasta-hora').value;
  const tipo = $('pa-bl-tipos').value;

  if (!desde) return avisar('Elegí al menos la fecha de inicio.', 'error');
  // Media hora no significa nada: o están las dos o es el día entero.
  if (Boolean(desdeHora) !== Boolean(hastaHora)) {
    return avisar('Para bloquear un tramo del día poné las dos horas. Si querés el día entero, dejá las dos vacías.', 'error');
  }
  if (desdeHora && hastaHora <= desdeHora) {
    return avisar('La hora de fin tiene que ser posterior a la de inicio.', 'error');
  }

  try {
    await llamar({
      accion: 'bloquear', desde, hasta,
      desdeHora: desdeHora || null,
      hastaHora: hastaHora || null,
      tipos: tipo ? [tipo] : [],
      motivo: $('pa-bl-motivo').value.trim(),
    });
    for (const id of ['pa-bl-desde', 'pa-bl-hasta', 'pa-bl-desde-hora', 'pa-bl-hasta-hora', 'pa-bl-motivo']) {
      $(id).value = '';
    }
    $('pa-bl-tipos').value = '';
    avisar(tipo === 'una-hora' ? 'Listo: ese tramo queda guardado para consultas.' : 'Bloqueado.', 'ok');
    await recargar();
  } catch (e) {
    avisar(`No se pudo bloquear: ${e.message}`, 'error');
  }
}

// -------------------------------------------------------
// Espacios extraordinarios
//
// Lo contrario de un bloqueo: un horario que no está en las franjas de la
// semana y que se abre igual. Viven en su propia colección y en la página
// pública salen aparte, detrás del "¿No encontrás un horario que te sirva?".
//
// La regla que la pantalla tiene que dejar clara, porque no se deduce: un
// extraordinario nunca establece un horario quincenal. El motor los ignora
// al proyectar una serie, incluso los que repiten todas las semanas.
// -------------------------------------------------------
function pintarFormExcepcional() {
  const repite = $('pa-ex-cuando').value === 'repite';
  $('pa-ex-caja-fecha').hidden = repite;
  $('pa-ex-caja-dia').hidden = !repite;
  $('pa-ex-caja-frecuencia').hidden = !repite;
  $('pa-ex-caja-ancla').hidden = !repite || $('pa-ex-frecuencia').value !== 'quincenal';
  $('pa-ex-caja-desde-fecha').hidden = !repite;
  $('pa-ex-caja-hasta-fecha').hidden = !repite;
}

// Editar uno que ya existe usa el mismo formulario de arriba, precargado, como
// las sesiones.
let editandoExtra = null;
const CAMPOS_EXTRA = ['pa-ex-fecha', 'pa-ex-desde-fecha', 'pa-ex-hasta-fecha', 'pa-ex-desde', 'pa-ex-hasta', 'pa-ex-motivo', 'pa-ex-ancla'];

function editarExcepcional(e) {
  editandoExtra = e.id;
  $('pa-ex-cuando').value = e.repite ? 'repite' : 'fecha';
  $('pa-ex-fecha').value = e.fecha || '';
  $('pa-ex-dia').value = String(e.diaSemana ?? 1);
  $('pa-ex-frecuencia').value = e.frecuencia === 'quincenal' ? 'quincenal' : 'semanal';
  $('pa-ex-ancla').value = e.ancla || '';
  $('pa-ex-desde-fecha').value = e.desdeFecha || '';
  $('pa-ex-hasta-fecha').value = e.hastaFecha || '';
  $('pa-ex-desde').value = e.desde || '';
  $('pa-ex-hasta').value = e.hasta || '';
  const tipos = e.tipos || [];
  $('pa-ex-tipos').value = tipos.length === 1 ? tipos[0] : 'ambos';
  $('pa-ex-unico').checked = e.unicoPorDia === true;
  $('pa-ex-motivo').value = e.motivo || '';
  pintarFormExcepcional();
  $('pa-btn-excepcional').textContent = 'Guardar el cambio';
  $('pa-btn-excepcional').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function salirDeExtra() {
  editandoExtra = null;
  for (const id of CAMPOS_EXTRA) $(id).value = '';
  $('pa-ex-unico').checked = true;
  $('pa-btn-excepcional').textContent = 'Abrir el espacio';
}

function textoDeExcepcional(e) {
  const horas = `de ${e.desde} a ${e.hasta}`;
  if (!e.repite) return `${e.fecha}, ${horas}`;
  const limite = [
    e.desdeFecha ? `desde el ${e.desdeFecha}` : '',
    e.hastaFecha ? `hasta el ${e.hastaFecha}` : '',
  ].filter(Boolean).join(' ');
  const cada = e.frecuencia === 'quincenal'
    ? `Un ${DIA_CORTO[e.diaSemana]} de por medio${e.ancla ? ` desde el ${e.ancla}` : ''}`
    : `Todos los ${DIA_CORTO[e.diaSemana]}`;
  return `${cada}, ${horas}${limite ? ` (${limite})` : ''}`;
}

function pintarExcepcionales() {
  const caja = $('pa-lista-excepcionales');
  caja.innerHTML = '';
  const lista = datos.excepcionales || [];
  if (!lista.length) {
    const p = document.createElement('p');
    p.className = 'pa-vacio';
    p.textContent = 'No hay espacios extraordinarios.';
    caja.appendChild(p);
    return;
  }
  for (const e of lista) {
    const fila = document.createElement('div');
    fila.className = 'pa-turno';

    const texto = document.createElement('div');
    texto.className = 'pa-cuando';
    texto.textContent = textoDeExcepcional(e);
    fila.appendChild(texto);

    const detalle = document.createElement('div');
    detalle.className = 'pa-quien';
    const tipos = e.tipos || [];
    const para = tipos.length === 1
      ? { 'una-hora': 'Solo sesiones de una hora', 'dos-horas': 'Solo consultas de dos horas' }[tipos[0]]
      : 'Consultas y sesiones';
    detalle.textContent = [
      para,
      e.unicoPorDia ? 'uno por día' : '',
      e.motivo,
      e.borrador ? 'sin publicar' : '',
    ].filter(Boolean).join(' · ');
    fila.appendChild(detalle);

    const editar = document.createElement('button');
    editar.type = 'button';
    editar.className = 'pa-mini';
    editar.textContent = 'Editar';
    editar.addEventListener('click', () => editarExcepcional(e));
    fila.appendChild(editar);

    const quitar = document.createElement('button');
    quitar.type = 'button';
    quitar.className = 'pa-mini';
    quitar.textContent = 'Quitar';
    quitar.addEventListener('click', async () => {
      try {
        await llamar({ accion: 'quitarExcepcional', id: e.id });
        await recargar();
      } catch (err) {
        avisar(`No se pudo quitar: ${err.message}`, 'error');
      }
    });
    fila.appendChild(quitar);
    caja.appendChild(fila);
  }
}

async function abrirExcepcional() {
  const repite = $('pa-ex-cuando').value === 'repite';
  const desde = $('pa-ex-desde').value;
  const hasta = $('pa-ex-hasta').value;
  const tipo = $('pa-ex-tipos').value;

  if (!desde || !hasta) return avisar('Poné la hora de inicio y la de fin.', 'error');
  if (hasta <= desde) return avisar('La hora de fin tiene que ser posterior a la de inicio.', 'error');

  const excepcional = {
    desde, hasta,
    tipos: tipo === 'ambos' ? ['dos-horas', 'una-hora'] : [tipo],
    motivo: $('pa-ex-motivo').value.trim(),
    unicoPorDia: $('pa-ex-unico').checked,
  };
  if (repite) {
    excepcional.repite = true;
    excepcional.diaSemana = Number($('pa-ex-dia').value);
    excepcional.frecuencia = $('pa-ex-frecuencia').value;
    excepcional.ancla = excepcional.frecuencia === 'quincenal' ? ($('pa-ex-ancla').value || null) : null;
    excepcional.desdeFecha = $('pa-ex-desde-fecha').value || null;
    excepcional.hastaFecha = $('pa-ex-hasta-fecha').value || null;
    if (excepcional.hastaFecha && excepcional.desdeFecha
        && excepcional.hastaFecha < excepcional.desdeFecha) {
      return avisar('El "hasta" tiene que ser posterior al "a partir de".', 'error');
    }
  } else {
    if (!$('pa-ex-fecha').value) return avisar('Elegí la fecha.', 'error');
    excepcional.fecha = $('pa-ex-fecha').value;
  }

  // Un extraordinario adentro de una franja regular no agrega ni un horario:
  // el motor saca de la lista de extraordinarios lo que ya está entre los
  // regulares, para no ofrecer la misma hora dos veces. Visto desde el panel
  // eso es un espacio que se guarda bien y no aparece en ningún lado, así que
  // conviene decirlo antes y no después.
  const dow = repite
    ? excepcional.diaSemana
    : new Date(`${excepcional.fecha}T12:00:00Z`).getUTCDay();
  //
  // Solo cuenta una franja que de verdad lo tape: una quincenal cae la mitad
  // de las veces y una que sirve para otro tipo no ofrece estos horarios, así
  // que avisar por ellas sería avisar en falso.
  const franjas = ((datos.config?.semana || {})[String(dow)] || []).filter(f => {
    if (f.frecuencia === 'quincenal') return false;
    const suyos = Array.isArray(f.tipos) ? f.tipos : [];
    if (!suyos.length) return true;
    return excepcional.tipos.some(t => suyos.includes(t));
  });
  const tapado = franjas.find(f => f.desde <= desde && f.hasta >= hasta);
  if (tapado) {
    const ok = window.confirm(
      `Los ${DIA_CORTO[dow]} ya los tenés abiertos de ${tapado.desde} a ${tapado.hasta} en tus horarios de la semana. `
      + 'Un extraordinario ahí adentro no agrega ningún horario: los que daría ya se ofrecen como regulares, '
      + 'y por eso no va a aparecer en la vista previa.\n\n¿Lo guardo igual?');
    if (!ok) return;
  }

  try {
    if (editandoExtra) {
      await llamar({ accion: 'guardarExcepcional', id: editandoExtra, excepcional });
      salirDeExtra();
      avisar('Guardado. Acordate de publicarlo.', 'ok');
    } else {
      await llamar({ accion: 'excepcional', excepcional });
      for (const id of CAMPOS_EXTRA) $(id).value = '';
      avisar('Listo: el espacio queda abierto. Acordate de publicarlo.', 'ok');
    }
    await recargar();
  } catch (e) {
    avisar(`No se pudo guardar: ${e.message}`, 'error');
  }
}

// -------------------------------------------------------
// Acompañamiento
//
// Lo que se ve acá son las series: una por persona, con su día y su hora
// quincenal. Los encuentros no son una promesa, son turnos tomados de
// verdad hasta dos meses para adelante, y por eso se listan.
// -------------------------------------------------------
const DIA_CORTO = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

let series = [];

async function cargarSeries() {
  const caja = $('pa-lista-series');
  caja.textContent = 'Cargando...';
  try {
    series = (await llamar({ accion: 'series' })).series || [];
    pintarSeries();
  } catch (e) {
    caja.textContent = '';
    avisar(`No se pudieron cargar: ${e.message}`, 'error');
  }
}

function pintarSeries() {
  const caja = $('pa-lista-series');
  caja.innerHTML = '';

  if (!series.length) {
    const p = document.createElement('p');
    p.className = 'pa-vacio';
    p.textContent = 'Todavía no hay nadie en el acompañamiento.';
    caja.appendChild(p);
    return;
  }

  for (const s of series) {
    const ficha = document.createElement('div');
    ficha.className = 'pa-serie' + (s.estado === 'pausada' ? ' pausada' : '');

    const cabeza = document.createElement('div');
    cabeza.className = 'pa-serie-cabeza';
    const nombre = document.createElement('strong');
    nombre.textContent = s.nombre || s.email;
    const cuando = document.createElement('span');
    cuando.className = 'pa-serie-cuando';
    const cadaCuanto = s.frecuencia === 'semanal' ? 'cada semana' : 'cada 15 días';
    const duracion = s.duracionMin ? `, ${s.duracionMin} min` : '';
    // Indefinido es lo normal, y por eso no se escribe: lo que merece decirse
    // es que termina.
    const termina = s.hasta ? `, hasta el ${s.hasta}` : '';
    cuando.textContent = `${DIA_CORTO[s.diaSemana]} a las ${s.hora}, ${cadaCuanto}${duracion}${termina}`;
    cabeza.append(nombre, cuando);
    ficha.appendChild(cabeza);

    const datos = document.createElement('div');
    datos.className = 'pa-serie-datos';
    datos.textContent = [s.email || 'falta el mail', s.telefono, s.modalidad].filter(Boolean).join(' · ')
      + (s.estado === 'pausada' ? ' · EN PAUSA' : '');
    ficha.appendChild(datos);

    if (s.recurrenciaExterna) {
      const importada = document.createElement('div');
      importada.className = 'pa-serie-conflicto';
      importada.textContent = 'Importada del calendario: su horario ya está reservado y nadie más lo puede '
        + 'tomar, pero los encuentros los sigue poniendo la repetición vieja. Con "Pasar al sistema" la corto '
        + 'y empiezo a crearlos yo, con su enlace y su invitación.';
      ficha.appendChild(importada);
    }

    // Sin mail, el espacio queda igual de protegido pero no se le puede
    // mandar el enlace ni invitarla al encuentro. Conviene que se vea.
    if (!s.email) {
      const falta = document.createElement('div');
      falta.className = 'pa-serie-conflicto';
      falta.textContent = 'Sin mail: su horario está reservado, pero no puede recibir el enlace '
        + 'para cambiarlo ni la invitación de cada encuentro. Agregalo con Editar.';
      ficha.appendChild(falta);
    }

    if (s.conflictos && s.conflictos.length) {
      const aviso = document.createElement('div');
      aviso.className = 'pa-serie-conflicto';
      aviso.textContent = 'No se pudieron tomar estos encuentros porque el horario ya estaba ocupado: '
        + s.conflictos.map(c => fechaLarga(c.inicio)).join('; ')
        + '. Movelos a mano o proponele otro horario.';
      ficha.appendChild(aviso);
    }

    const encuentros = document.createElement('div');
    encuentros.className = 'pa-serie-encuentros';
    if (!s.encuentros.length) {
      const vacio = document.createElement('span');
      vacio.className = 'pa-vacio';
      vacio.style.fontSize = '0.8rem';
      vacio.textContent = 'Sin encuentros tomados.';
      encuentros.appendChild(vacio);
    }
    for (const e of s.encuentros) {
      const pastilla = document.createElement('span');
      // Punteado = movido: el encuentro de esa quincena está, pero no en el
      // horario habitual de la persona.
      const movido = e.inicio.slice(11, 16) !== s.hora;
      pastilla.className = 'pa-encuentro' + (movido ? ' movido' : '');
      pastilla.textContent = fechaLarga(e.inicio);
      if (movido) pastilla.title = 'Movido: no está en su horario habitual';
      encuentros.appendChild(pastilla);
    }
    ficha.appendChild(encuentros);

    const acciones = document.createElement('div');
    acciones.className = 'pa-serie-acciones';

    acciones.appendChild(boton('Editar', () => editarSerie(s)));
    // Una serie importada todavía no tiene encuentros propios: el enlace y el
    // estirado no sirven hasta que pase al sistema.
    if (s.recurrenciaExterna) {
      acciones.appendChild(boton('Pasar al sistema', () => adoptarSerie(s)));
    } else {
      acciones.appendChild(boton('Mandarle el enlace', () => mandarEnlace(s, true)));
      acciones.appendChild(boton('Ver el enlace', () => mandarEnlace(s, false)));
      acciones.appendChild(boton('Estirar sus encuentros', () => estirarSerie(s)));
    }
    acciones.appendChild(boton(s.estado === 'pausada' ? 'Reactivar' : 'Pausar', () => pausarSerie(s)));
    acciones.appendChild(boton('Borrar', () => borrarSerie(s)));

    ficha.appendChild(acciones);
    caja.appendChild(ficha);
  }
}

function boton(texto, alTocar) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pa-mini';
  b.textContent = texto;
  b.addEventListener('click', alTocar);
  return b;
}

// Editar es el mismo formulario de arriba, precargado. Mientras hay alguien
// en edición el botón cambia de texto, porque si no se parece demasiado a
// estar sumando a otra persona.
let editando = null;

// Los campos del formulario, en un solo lugar: el alta y la edición mandan lo
// mismo, y antes estaba escrito dos veces (así que un campo nuevo había que
// acordarse de sumarlo en los dos).
const CAMPOS_SERIE = ['pa-se-nombre', 'pa-se-email', 'pa-se-telefono', 'pa-se-ancla', 'pa-se-hasta', 'pa-se-duracion'];

function serieDeLaPantalla() {
  const duracion = Number($('pa-se-duracion').value);
  return {
    nombre: $('pa-se-nombre').value.trim(),
    email: $('pa-se-email').value.trim(),
    telefono: $('pa-se-telefono').value.trim(),
    diaSemana: Number($('pa-se-dia').value),
    hora: $('pa-se-hora').value,
    ancla: $('pa-se-ancla').value,
    // Vacío es indefinido, que es el caso normal.
    hasta: $('pa-se-hasta').value || null,
    frecuencia: $('pa-se-frecuencia').value,
    duracionMin: Number.isFinite(duracion) && duracion >= 15 ? duracion : null,
    modalidad: $('pa-se-modalidad').value,
  };
}

function editarSerie(s) {
  editando = s.id;
  $('pa-se-nombre').value = s.nombre || '';
  $('pa-se-email').value = s.email || '';
  $('pa-se-telefono').value = s.telefono || '';
  $('pa-se-dia').value = String(s.diaSemana);
  $('pa-se-hora').value = s.hora || '';
  $('pa-se-ancla').value = s.ancla || '';
  $('pa-se-hasta').value = s.hasta || '';
  $('pa-se-duracion').value = s.duracionMin || '';
  $('pa-se-frecuencia').value = s.frecuencia === 'semanal' ? 'semanal' : 'quincenal';
  $('pa-se-modalidad').value = s.modalidad || 'Online';
  $('pa-btn-crear-serie').textContent = 'Guardar los cambios';
  $('pa-se-aviso').hidden = false;
  $('pa-nueva-serie').open = true;
  $('pa-nueva-serie').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function salirDeEdicion() {
  editando = null;
  for (const id of CAMPOS_SERIE) $(id).value = '';
  $('pa-btn-crear-serie').textContent = 'Sumar y tomar sus encuentros';
  $('pa-se-aviso').hidden = true;
}

async function borrarSerie(s) {
  const cuantos = s.encuentros.length;
  const texto = cuantos
    ? `¿Borrar a ${s.nombre || s.email}? Se le cancelan ${cuantos} encuentro${cuantos === 1 ? '' : 's'} y se sacan de tu calendario. Su enlace deja de funcionar.`
    : `¿Borrar a ${s.nombre || s.email}? Su enlace deja de funcionar.`;
  if (!window.confirm(texto)) return;
  try {
    const r = await llamar({ accion: 'borrarSerie', id: s.id });
    avisar(r.cancelados
      ? `Borrada. Se cancelaron ${r.cancelados} encuentro${r.cancelados === 1 ? '' : 's'}.`
      : 'Borrada.', 'ok');
    if (editando === s.id) salirDeEdicion();
    await cargarSeries();
  } catch (e) {
    avisar(`No se pudo borrar: ${mensajeDeSerie(e)}`, 'error');
  }
}

// Importar los encuentros que ya viven en el calendario. Cada uno entra con
// su horario protegido y sin tocar el calendario; el paso que lo toca es
// adoptarla, y se hace de a una.
async function importarSeries() {
  const caja = $('pa-importar-resultado');
  const boton = $('pa-btn-importar');
  let lista;
  try {
    lista = JSON.parse($('pa-importar-datos').value);
    if (!Array.isArray(lista) || !lista.length) throw new Error('vacío');
  } catch (e) {
    return avisar('Eso no es una lista que pueda leer. Pegá el texto completo, con los corchetes.', 'error');
  }

  boton.disabled = true;
  caja.textContent = '';
  let bien = 0;
  let repetidas = 0;
  const mal = [];
  for (const cruda of lista) {
    const { recurrenciaExterna, ...serie } = cruda;
    try {
      const r = await llamar({ accion: 'crearSerie', serie, recurrenciaExterna: recurrenciaExterna || null });
      if (r.yaEstaba) repetidas++;
      else bien++;
    } catch (e) {
      mal.push(`${serie.nombre || 'sin nombre'}: ${e.message}`);
    }
  }
  boton.disabled = false;

  const yaHabia = repetidas ? ` ${repetidas} ya estaba${repetidas === 1 ? '' : 'n'} y no se duplicó.` : '';
  avisar(mal.length
    ? `Entraron ${bien} de ${lista.length}.${yaHabia} Mirá el detalle abajo.`
    : `Listo: entraron ${bien}.${yaHabia} Sus horarios ya están reservados y tu calendario quedó intacto.`,
  mal.length ? 'error' : 'ok');
  if (mal.length) caja.textContent = `No entraron: ${mal.join(' · ')}`;
  $('pa-importar-datos').value = '';
  await cargarSeries();
}

async function adoptarSerie(s) {
  const ok = window.confirm(
    `Voy a cortar la repetición de ${s.nombre || s.email} en tu calendario (lo que ya pasó queda) `
    + 'y a crear de acá en adelante un encuentro por vez, con su invitación.\n\n¿Sigo?');
  if (!ok) return;
  try {
    const r = await llamar({ accion: 'adoptarSerie', id: s.id });
    avisar(r.conflictos.length
      ? `Pasó al sistema con ${r.creados.length} encuentro(s), pero ${r.conflictos.length} no entró porque el horario estaba ocupado.`
      : `Pasó al sistema: ${r.creados.length} encuentro(s) creado(s).`,
    r.conflictos.length ? 'error' : 'ok');
    await cargarSeries();
  } catch (e) {
    avisar(e.message === 'no_se_pudo_cortar'
      ? 'No pude cortar la repetición en el calendario, así que no creé nada: si lo hiciera, cada encuentro quedaría dos veces.'
      : `No se pudo pasar al sistema: ${e.message}`, 'error');
  }
}

async function crearSerie() {
  if (editando) return guardarSerieEditada();
  const boton = $('pa-btn-crear-serie');
  boton.disabled = true;
  try {
    const r = await llamar({
      accion: 'crearSerie',
      serie: serieDeLaPantalla(),
    });

    // Un alta puede salir a medias: la serie queda, y alguno de sus
    // encuentros no entra porque el horario estaba ocupado. Decirlo acá
    // evita que Seba se entere dos semanas después.
    const parte = r.conflictos.length
      ? `Quedó, con ${r.creados.length} encuentro${r.creados.length === 1 ? '' : 's'} tomado${r.creados.length === 1 ? '' : 's'}, pero ${r.conflictos.length} no entró porque el horario ya estaba ocupado.`
      : `Listo: ${r.creados.length} encuentro${r.creados.length === 1 ? '' : 's'} tomado${r.creados.length === 1 ? '' : 's'}.`;
    avisar(parte, r.conflictos.length ? 'error' : 'ok');

    if ($('pa-se-mandar').checked && r.id) {
      await llamar({ accion: 'enlace', serieId: r.id, mandar: true });
      avisar(`${parte} Le mandé el enlace por mail.`, r.conflictos.length ? 'error' : 'ok');
    }

    for (const id of CAMPOS_SERIE) $(id).value = '';
    await cargarSeries();
  } catch (e) {
    avisar(`No se pudo sumar: ${mensajeDeSerie(e)}`, 'error');
  } finally {
    boton.disabled = false;
  }
}

async function guardarSerieEditada() {
  const boton = $('pa-btn-crear-serie');
  boton.disabled = true;
  try {
    await llamar({
      accion: 'guardarSerie',
      id: editando,
      serie: serieDeLaPantalla(),
    });
    avisar('Guardado. Los encuentros que ya estaban tomados siguen donde estaban.', 'ok');
    salirDeEdicion();
    await cargarSeries();
  } catch (e) {
    avisar(`No se pudo guardar: ${mensajeDeSerie(e)}`, 'error');
  } finally {
    boton.disabled = false;
  }
}

function mensajeDeSerie(e) {
  return {
    falta_nombre: 'falta el nombre',
    email_invalido: 'revisá el mail',
    dia_invalido: 'elegí un día',
    hora_invalida: 'revisá la hora',
    ancla_no_coincide: 'la fecha del primer encuentro no cae en el día que elegiste',
    sin_email: 'esa persona no tiene mail cargado',
  }[e.message] || e.message;
}

async function mandarEnlace(s, mandar) {
  try {
    const r = await llamar({ accion: 'enlace', serieId: s.id, mandar });
    if (mandar) {
      avisar(`Le mandé el enlace a ${s.email}.`, 'ok');
      return;
    }
    // Mostrarlo en pantalla, porque el token existe una sola vez: de acá en
    // más solo queda su hash guardado.
    const ficha = [...document.querySelectorAll('.pa-serie')][series.indexOf(s)];
    let caja = ficha.querySelector('.pa-enlace-copiar');
    if (!caja) {
      caja = document.createElement('div');
      caja.className = 'pa-enlace-copiar';
      ficha.appendChild(caja);
    }
    caja.textContent = r.url;
    avisar('Copialo ahora: el enlace se muestra una sola vez.', 'ok');
  } catch (e) {
    avisar(`No se pudo: ${mensajeDeSerie(e)}`, 'error');
  }
}

async function estirarSerie(s) {
  try {
    const r = await llamar({ accion: 'extenderSerie', id: s.id });
    avisar(r.conflictos.length
      ? `Tomé ${r.creados.length}, y ${r.conflictos.length} no entró: el horario ya estaba ocupado.`
      : `Listo: ${r.creados.length} encuentro${r.creados.length === 1 ? '' : 's'} nuevo${r.creados.length === 1 ? '' : 's'}.`,
    r.conflictos.length ? 'error' : 'ok');
    await cargarSeries();
  } catch (e) {
    avisar(`No se pudo: ${e.message}`, 'error');
  }
}

async function pausarSerie(s) {
  const pausar = s.estado !== 'pausada';
  if (pausar && !window.confirm(`¿Pausar el acompañamiento de ${s.nombre || s.email}? Los encuentros que ya están tomados siguen en pie; lo que deja de pasar es que se tomen los nuevos.`)) return;
  try {
    await llamar({
      accion: 'guardarSerie',
      id: s.id,
      serie: { ...s, estado: pausar ? 'pausada' : 'activa' },
    });
    avisar(pausar ? 'Pausado.' : 'Reactivado.', 'ok');
    await cargarSeries();
  } catch (e) {
    avisar(`No se pudo: ${mensajeDeSerie(e)}`, 'error');
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
    const data = await llamar({
      accion: 'previsualizar',
      modalidad: $('pa-previa-modalidad').value,
      tipo: $('pa-previa-tipo').value,
    });
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

  // Los extraordinarios y los tramos guardados van escritos aparte: son
  // justamente lo que no esta en los horarios regulares, asi que si no se
  // listan acá, agregar uno no cambia nada en esta pantalla.
  const extras = data.excepcionales || [];
  // El caso que más tiempo come: hay extraordinarios guardados y la vista
  // previa no muestra ninguno. Callarse ahí es decirle a Seba que el panel
  // está roto, cuando lo que pasa es una de tres cosas concretas.
  if (!extras.length && (datos.excepcionales || []).length) {
    const p = document.createElement('p');
    p.className = 'pa-previa-total';
    const n = datos.excepcionales.length;
    p.textContent = `Tenés ${n} espacio${n > 1 ? 's' : ''} extraordinario${n > 1 ? 's' : ''} `
      + 'y este turno no puede usar ninguno acá. Suele ser por una de tres: ya están adentro de '
      + 'tus horarios de la semana (entonces se ofrecen como regulares y no se repiten), '
      + 'el tramo es más corto que el turno, o no son para este tipo.';
    caja.appendChild(p);
  }
  if (extras.length) {
    const p = document.createElement('p');
    p.className = 'pa-previa-total';
    p.textContent = `Y ${extras.length} extraordinario${extras.length > 1 ? 's' : ''}: `
      + extras.map(iso => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`).join(' · ');
    caja.appendChild(p);
  }
  const guardados = (data.bloqueados || []).filter(b => !b.diaEntero);
  if (guardados.length) {
    const p = document.createElement('p');
    p.className = 'pa-previa-total';
    p.textContent = `Y ${guardados.length} tramo${guardados.length > 1 ? 's' : ''} que este tipo no puede usar: `
      + guardados.map(b => `${b.desde.slice(0, 10)} de ${b.desde.slice(11, 16)} a ${b.hasta.slice(11, 16)}`).join(' · ');
    caja.appendChild(p);
  }

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

$('pa-btn-crear-serie').addEventListener('click', crearSerie);
$('pa-btn-publicar').addEventListener('click', publicar);
$('pa-btn-descartar').addEventListener('click', descartar);
$('pa-cal-antes').addEventListener('click', () => {
  calMes = mesVecino(calMes || hoyISO().slice(0, 7), -1);
  cargarCalendario();
});
$('pa-cal-despues').addEventListener('click', () => {
  calMes = mesVecino(calMes || hoyISO().slice(0, 7), 1);
  cargarCalendario();
});
$('pa-btn-nuevo-turno').addEventListener('click', () => anotarTurno(false));
$('pa-btn-importar').addEventListener('click', importarSeries);
$('pa-btn-excepcional').addEventListener('click', abrirExcepcional);
$('pa-ex-cuando').addEventListener('change', pintarFormExcepcional);
$('pa-ex-frecuencia').addEventListener('change', pintarFormExcepcional);
pintarFormExcepcional();

// La vista previa de la cadencia se rehace con cualquier cosa que la cambie:
// el número, las duraciones, el aire, y las franjas (que le dan el ejemplo).
for (const id of ['pa-cadencia', 'pa-t1-duracion', 'pa-t1-buffer', 'pa-t2-duracion']) {
  $(id).addEventListener('input', pintarCadencia);
}
$('pa-semana').addEventListener('input', pintarCadencia);

// Las series se piden recién al abrir su pestaña, no al abrir el panel: cada
// una trae sus encuentros en una consulta propia, y son quince personas.
let seriesPedidas = false;

for (const tab of document.querySelectorAll('.pa-tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.pa-tab')) t.classList.remove('activa');
    for (const p of document.querySelectorAll('.pa-panel')) p.classList.remove('visible');
    tab.classList.add('activa');
    $(tab.dataset.panel).classList.add('visible');
    if (tab.dataset.panel === 'pa-series' && !seriesPedidas) {
      seriesPedidas = true;
      cargarSeries();
    }
  });
}
