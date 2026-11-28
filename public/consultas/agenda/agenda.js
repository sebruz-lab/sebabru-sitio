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
const ZONA_SEBA = 'America/Argentina/Cordoba';

// La deteccion anda en todo navegador de los ultimos diez anios y no pide
// permiso ni pregunta nada. El try es por los que no tengan Intl completo.
const ZONA_DETECTADA = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (_) {
    return '';
  }
})();

const estado = {
  p: null,
  t: null,
  // Si la deteccion no viniera, se usa la de Seba y la frase lo dice en
  // lugar de mentir.
  zona: ZONA_DETECTADA || ZONA_SEBA,
  zonaDetectada: Boolean(ZONA_DETECTADA),
  zonaNombre: '',
  slots: [],
  // Los que abrio Seba aparte de sus dias habituales, y los tramos que este
  // turno no puede usar porque estan guardados para otra cosa. Vienen en
  // listas propias para que no se mezclen con los regulares.
  excepcionales: [],
  bloqueados: [],
  porDia: new Map(),
  diaElegido: null,
  horaElegida: null,
  turno: null,
  previsualizacion: false,
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
  // Desde la vista previa del panel no se mide nada: si no, cada vez que
  // Seba abre esa pestana se le mete un turno_inicio en Analytics.
  if (estado.previsualizacion) return;
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
//
// La zona se detecta sola y se dice en una frase. El desplegable de las 400
// zonas IANA nunca fue la deteccion: era el arreglo por si la deteccion se
// equivoca (alguien de viaje, la compu con la hora mal puesta). Asi que en
// vez de una lista hay un buscador de ciudades, que es como la gente sabe
// donde esta.
// -------------------------------------------------------

// Las zonas del publico de Seba, escritas como las diria una persona. Lo
// que no este aca cae en el respaldo de abajo: nunca se muestra un
// "America/..." pelado.
const NOMBRES_DE_ZONA = {
  'America/Argentina/Buenos_Aires': 'Buenos Aires, Argentina',
  'America/Argentina/Cordoba': 'Córdoba, Argentina',
  'America/Argentina/Mendoza': 'Mendoza, Argentina',
  'America/Argentina/Salta': 'Salta, Argentina',
  'America/Argentina/Tucuman': 'Tucumán, Argentina',
  'America/Argentina/Jujuy': 'Jujuy, Argentina',
  'America/Argentina/La_Rioja': 'La Rioja, Argentina',
  'America/Argentina/San_Juan': 'San Juan, Argentina',
  'America/Argentina/San_Luis': 'San Luis, Argentina',
  'America/Argentina/Catamarca': 'Catamarca, Argentina',
  'America/Argentina/Rio_Gallegos': 'Río Gallegos, Argentina',
  'America/Argentina/Ushuaia': 'Ushuaia, Argentina',
  'America/Montevideo': 'Montevideo, Uruguay',
  'America/Santiago': 'Santiago, Chile',
  'America/Punta_Arenas': 'Punta Arenas, Chile',
  'America/Asuncion': 'Asunción, Paraguay',
  'America/La_Paz': 'La Paz, Bolivia',
  'America/Lima': 'Lima, Perú',
  'America/Bogota': 'Bogotá, Colombia',
  'America/Guayaquil': 'Quito, Ecuador',
  'America/Caracas': 'Caracas, Venezuela',
  'America/Sao_Paulo': 'San Pablo, Brasil',
  'America/Bahia': 'Salvador de Bahía, Brasil',
  'America/Manaus': 'Manaos, Brasil',
  'America/Fortaleza': 'Fortaleza, Brasil',
  'America/Mexico_City': 'Ciudad de México, México',
  'America/Monterrey': 'Monterrey, México',
  'America/Tijuana': 'Tijuana, México',
  'America/Cancun': 'Cancún, México',
  'America/Guatemala': 'Guatemala',
  'America/Costa_Rica': 'San José, Costa Rica',
  'America/Panama': 'Panamá',
  'America/Havana': 'La Habana, Cuba',
  'America/Santo_Domingo': 'Santo Domingo, República Dominicana',
  'America/Puerto_Rico': 'San Juan, Puerto Rico',
  'America/New_York': 'Nueva York, Estados Unidos',
  'America/Chicago': 'Chicago, Estados Unidos',
  'America/Denver': 'Denver, Estados Unidos',
  'America/Phoenix': 'Phoenix, Estados Unidos',
  'America/Los_Angeles': 'Los Ángeles, Estados Unidos',
  'America/Toronto': 'Toronto, Canadá',
  'America/Vancouver': 'Vancouver, Canadá',
  'Europe/Madrid': 'Madrid, España',
  'Atlantic/Canary': 'Islas Canarias, España',
  'Europe/Lisbon': 'Lisboa, Portugal',
  'Europe/Rome': 'Roma, Italia',
  'Europe/Paris': 'París, Francia',
  'Europe/Berlin': 'Berlín, Alemania',
  'Europe/Amsterdam': 'Ámsterdam, Países Bajos',
  'Europe/Brussels': 'Bruselas, Bélgica',
  'Europe/Zurich': 'Zúrich, Suiza',
  'Europe/Vienna': 'Viena, Austria',
  'Europe/London': 'Londres, Reino Unido',
  'Europe/Dublin': 'Dublín, Irlanda',
  'Europe/Stockholm': 'Estocolmo, Suecia',
  'Europe/Oslo': 'Oslo, Noruega',
  'Europe/Copenhagen': 'Copenhague, Dinamarca',
  'Europe/Athens': 'Atenas, Grecia',
  'Europe/Moscow': 'Moscú, Rusia',
  'Asia/Jerusalem': 'Jerusalén, Israel',
  'Australia/Sydney': 'Sídney, Australia',
  'Australia/Melbourne': 'Melbourne, Australia',
  'Pacific/Auckland': 'Auckland, Nueva Zelanda',
};

// Cuanto se adelanta o se atrasa una zona respecto de la de Seba, ahora
// mismo. Se saca comparando como escribe las dos la misma fecha: no hace
// falta saber nada de horarios de verano.
function minutosDeDiferencia(zona) {
  const ahora = new Date();
  const enZona = f => {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: f, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(ahora).reduce((o, x) => (o[x.type] = x.value, o), {});
    // La hora 24 existe en en-CA y es la medianoche del dia que arranca:
    // vale 0, pero del dia siguiente. Sumarla como 24 lo resuelve sola,
    // porque Date.UTC acepta que la hora se pase.
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  };
  return Math.round((enZona(zona) - enZona(ZONA_SEBA)) / 60000);
}

function zonaLegible(iana) {
  if (NOMBRES_DE_ZONA[iana]) return NOMBRES_DE_ZONA[iana];
  // El respaldo: la ciudad del id, mas la diferencia con Argentina, que es
  // el dato que de verdad le sirve a quien mira.
  const ciudad = String(iana || '').split('/').pop().replace(/_/g, ' ');
  let minutos = 0;
  try {
    minutos = minutosDeDiferencia(iana);
  } catch (_) {
    return ciudad;
  }
  if (!minutos) return `${ciudad} (igual que en Argentina)`;
  const horas = Math.abs(minutos) / 60;
  const cuanto = Number.isInteger(horas) ? horas : horas.toFixed(1).replace('.', ',');
  const unidad = horas === 1 ? 'hora' : 'horas';
  return `${ciudad} (${cuanto} ${unidad} ${minutos > 0 ? 'más' : 'menos'} que en Argentina)`;
}

// Cambiar de zona no cambia los horarios que hay: cambia como se leen. Se
// sueltan el dia y la hora elegidos porque en la zona nueva son otros.
function fijarZona(iana, nombre) {
  estado.zona = iana;
  estado.zonaNombre = nombre || zonaLegible(iana);
  estado.diaElegido = null;
  estado.horaElegida = null;
  pintarFraseDeZona();
  agruparSlots();
  pintarCalendario();
  pintarHorarios();
  $('ag-resumen').hidden = true;
}

function pintarFraseDeZona() {
  $('ag-zona-antes').textContent = estado.zonaDetectada
    ? 'Agendás tu sesión en el horario de'
    : 'No pudimos detectar tu zona: estás viendo los horarios de';
  $('ag-zona-nombre').textContent = estado.zonaNombre;
  $('ag-zona-nombre').setAttribute('aria-label', `Zona horaria: ${estado.zonaNombre}. Tocá para cambiarla`);
}

// El buscador se trae recien al tocar "corregir": es el mismo modulo (y la
// misma URL con version) que usa el formulario de consultas, asi que quien
// ya paso por ahi lo tiene en cache. Quien solo viene a elegir un horario no
// lo descarga nunca.
let buscadorListo = false;
const cacheRespaldo = new Map();

async function respaldoDeLugares(texto) {
  const clave = texto.trim().toLowerCase();
  if (!clave) return [];
  if (cacheRespaldo.has(clave)) return cacheRespaldo.get(clave);
  const lista = $('ag-zona-sugerencias');
  lista.innerHTML = '<li class="sin-resultados buscando" role="presentation">Buscando...</li>';
  lista.hidden = false;
  // GeoNames da 1.000 consultas por hora para todo el sitio: se espera a que
  // la persona frene de escribir antes de salir a la red.
  await new Promise(listo => setTimeout(listo, 350));
  if ($('ag-zona-campo').value.trim().toLowerCase() !== clave) return [];
  try {
    const r = await fetch(`${API}/buscarLugar?q=${encodeURIComponent(texto)}`);
    if (!r.ok) return [];
    const lugares = (await r.json()).lugares || [];
    cacheRespaldo.set(clave, lugares);
    return lugares;
  } catch (_) {
    return [];
  }
}

async function abrirBuscadorDeZona() {
  const caja = $('ag-zona-buscador');
  const campo = $('ag-zona-campo');
  caja.hidden = false;
  campo.focus();
  if (buscadorListo) return;
  buscadorListo = true;
  try {
    const { conectarBuscador } = await import('/cartas/buscador-lugares.js?v=1.14.0');
    conectarBuscador(campo, $('ag-zona-sugerencias'), lugar => {
      if (!lugar) return;
      const aviso = $('ag-zona-aviso');
      if (!lugar.zona) {
        // Cambiar la zona a ciegas seria peor que dejarla como esta.
        aviso.textContent = 'De ese lugar no sabemos la zona horaria. Probá con una ciudad más grande cerca.';
        aviso.hidden = false;
        return;
      }
      aviso.hidden = true;
      fijarZona(lugar.zona, [lugar.nombre, lugar.paisNombre].filter(Boolean).join(', '));
      campo.value = '';
      caja.hidden = true;
      $('ag-zona-nombre').focus();
    }, {
      sinResultados: 'No encontramos esa ciudad. Probá con una más grande cerca.',
      respaldo: respaldoDeLugares,
    });
  } catch (_) {
    buscadorListo = false;
    const aviso = $('ag-zona-aviso');
    aviso.textContent = 'No pudimos abrir el buscador de ciudades. Probá de nuevo en un rato.';
    aviso.hidden = false;
  }
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

// Todo lo que llega de disponibilidad, en un solo lugar: tres listas y los
// tres pintados. Antes cada sitio que refrescaba los horarios copiaba la
// linea de `estado.slots`, y por eso los excepcionales y los bloqueados no
// aparecian en ninguno.
function recibirHorarios(data) {
  estado.slots = data.slots || [];
  estado.excepcionales = data.excepcionales || [];
  estado.bloqueados = data.bloqueados || [];
  agruparSlots();
  pintarCalendario();
  pintarHorarios();
  pintarDiasSueltos();
}

function pintarCalendario() {
  const grilla = $('ag-grilla');
  grilla.innerHTML = '';

  if (!estado.mesVisible) {
    $('ag-mes-nombre').textContent = '';
    $('ag-mes-antes').disabled = true;
    $('ag-mes-despues').disabled = true;
    // Con horarios extraordinarios abiertos, decir "no hay nada" sería
    // falso: están justo abajo, detrás de la pregunta.
    grilla.innerHTML = estado.excepcionales.length
      ? '<p style="grid-column:1/-1; color:#8f8d88; line-height:1.7;">No hay horarios libres en mis días habituales, pero abrí algunos aparte: están más abajo.</p>'
      // Misma situacion que el bloque de abajo, asi que la misma salida: dos
      // caminos distintos para lo mismo solo hacen dudar.
      : '<p style="grid-column:1/-1; color:#8f8d88; line-height:1.7;">No hay horarios libres en los próximos días. Escribile a Clari contándole los momentos que tenés disponibles y buscamos un hueco: <a href="https://wa.me/5493544559877">+54 9 3544 55-9877</a>.</p>';
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
      pintarDiasSueltos();
      pintarResumen();
    });
    lista.appendChild(b);
  }

  // Los tramos guardados para otra cosa, solo los de este día: se ven, en
  // gris y con su motivo, en lugar de desaparecer sin explicación.
  for (const b of estado.bloqueados) {
    if (b.diaEntero || claveDia(b.desde) !== estado.diaElegido) continue;
    const gris = document.createElement('button');
    gris.type = 'button';
    gris.className = 'ag-hora reservado';
    gris.disabled = true;
    gris.textContent = `${textoHora(b.desde)} a ${textoHora(b.hasta)}`;
    gris.title = b.motivo || 'Guardado para otro tipo de encuentro';
    lista.appendChild(gris);
  }
}

// Los extraordinarios siguen siendo una lista y no un calendario: son pocos
// y sueltos, y un mes propio para dos horarios sería un mes casi vacío.
function pintarDiasSueltos() {
  const caja = $('ag-dias-sueltos');
  caja.innerHTML = '';

  const porDia = new Map();
  for (const iso of estado.excepcionales) {
    const dia = claveDia(iso);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(iso);
  }
  // Lo que se esconde cuando no hay ningun horario extraordinario es la
  // lista, no el bloque. El bloque se ve siempre, porque abajo esta la salida
  // para escribirle a Clari y quien no encontro nada es justamente quien la
  // necesita. Antes se escondia todo y esa salida desaparecia en el unico
  // caso en que hacia falta.
  $('ag-sueltos-lista').hidden = porDia.size === 0;
  if (!porDia.size) return;

  for (const [, horas] of [...porDia.entries()].sort()) {
    const bloque = document.createElement('div');
    bloque.className = 'ag-suelto-dia';

    const titulo = document.createElement('h4');
    titulo.textContent = textoDiaLargo(horas[0]);
    bloque.appendChild(titulo);

    const fila = document.createElement('div');
    fila.className = 'ag-lista-horas';
    for (const iso of horas) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ag-hora' + (iso === estado.horaElegida ? ' elegida' : '');
      b.textContent = textoHora(iso);
      b.addEventListener('click', () => {
        // Un extraordinario no pertenece a ningún día del calendario, así
        // que elegirlo suelta el día elegido: si no, arriba quedaría
        // marcada una hora de otro día.
        estado.diaElegido = null;
        estado.horaElegida = iso;
        pintarCalendario();
        pintarHorarios();
        pintarDiasSueltos();
        pintarResumen();
      });
      fila.appendChild(b);
    }
    bloque.appendChild(fila);
    caja.appendChild(bloque);
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
  const boton = $('ag-btn-confirmar');
  // En la vista previa se puede recorrer todo —dias, horas, zona horaria—
  // menos confirmar: el servidor tambien lo rechaza, pero no tiene sentido
  // ofrecer un boton que va a dar error.
  boton.disabled = estado.previsualizacion;
  boton.textContent = estado.previsualizacion
    ? 'No se reserva desde la vista previa'
    : (cambia ? 'Mover mi sesión' : 'Confirmar mi sesión');
  $('ag-resumen').hidden = false;
  $('ag-resumen').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// -------------------------------------------------------
// Pantalla del turno ya agendado
// -------------------------------------------------------
function pintarFicha() {
  const t = estado.turno;
  $('ag-ficha-cuando').textContent = `${textoDiaLargo(t.inicio)}, ${textoHora(t.inicio)}`;
  $('ag-ficha-zona').textContent = `Hora de ${estado.zonaNombre}. Dura ${estado.duracionMin} minutos.`;
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
  } else if (t.zoom && t.zoom.url) {
    // El Zoom lo manda el servidor junto con el turno reservado. Antes el
    // enlace con el passcode estaba escrito aca, y este archivo lo sirve
    // Hosting a cualquiera sin sesion (auditoría del 28/11/2026).
    donde.textContent = 'El encuentro es por Zoom: ';
    const a = document.createElement('a');
    a.href = t.zoom.url;
    a.textContent = 'entrar a la reunión';
    donde.appendChild(a);
    const resto = document.createElement('span');
    resto.textContent = ` (ID ${t.zoom.id}, passcode ${t.zoom.pass}).`;
    donde.appendChild(resto);
  } else {
    // Sin dato del servidor no se inventa un enlace.
    donde.textContent = 'Te escribimos con el enlace del encuentro. Si no te llega, avisale a Clari: ';
    const a = document.createElement('a');
    a.href = 'https://wa.me/5493544559877';
    a.textContent = '+54 9 3544 559877';
    donde.appendChild(a);
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
  estado.previsualizacion = data.previsualizacion === true;
  $('ag-previa').hidden = !estado.previsualizacion;
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

  recibirHorarios(data);
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
  // El evento en Calendar se espera en linea, asi que esto puede tardar unos
  // segundos. Si tarda, se dice; si contesta rapido, nunca aparece.
  const relojTarda = setTimeout(() => {
    $('ag-tarda').classList.add('visible');
  }, 3000);
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
        if (fresco) recibirHorarios(fresco);
      }
      return;
    }
    estado.turno = data.turno;
    medir('turno_reservado', { modalidad: estado.modalidad || 'Online' });
    pintarFicha();
  } catch (_) {
    mostrarError('ag-error-reserva', MENSAJES.fallo);
  } finally {
    clearTimeout(relojTarda);
    $('ag-tarda').classList.remove('visible');
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

// El borrador del paso 1. Una vez que iniciarAgenda contesta, los datos viven
// en el servidor y el enlace queda en la barra de direcciones; antes de eso,
// cerrar la pestana los borraba.
const borradorAgenda = (window.sbBorrador && document.getElementById('ag-form'))
  ? window.sbBorrador.cuidar(document.getElementById('ag-form'), 'agenda-paso1')
  : null;

// El script de Turnstile se trae recién acá, en la puerta suelta. Quien
// entra con su enlace del formulario o del mail no lo descarga nunca.
let captchaPedido = false;
// Si el script no carga, esto queda en true y el formulario deja de decir
// "esperá un segundo" para siempre.
let captchaImposible = false;
let captchaDesde = 0;

function montarCaptcha() {
  if (typeof turnstile === 'undefined') {
    if (!captchaPedido) {
      captchaPedido = true;
      captchaDesde = Date.now();
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true;
      s.defer = true;
      // Sin esto, una extensión que bloquea Cloudflare dejaba el reintento
      // de abajo corriendo cada 300 ms para siempre, y la persona se
      // quedaba mirando "Esperá un segundo a que termine la verificación de
      // seguridad" sin error, sin salida y sin que nada cambiara nunca.
      s.onerror = () => { captchaImposible = true; };
      document.head.appendChild(s);
    }
    // El mismo corte de 15 segundos que usa el widget de suscripción: pasado
    // ese tiempo el script no va a llegar.
    if (captchaImposible || (captchaDesde && Date.now() - captchaDesde > 15000)) {
      captchaImposible = true;
      return;
    }
    setTimeout(montarCaptcha, 300);
    return;
  }
  turnstile.render('#ag-captcha', {
    sitekey: TURNSTILE_SITEKEY,
    theme: 'dark',
    callback: token => { captchaToken = token; },
    'error-callback': () => { captchaToken = ''; captchaImposible = true; },
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
  if (!captchaToken) {
    // Dos mensajes distintos, porque son dos situaciones distintas: una se
    // arregla sola esperando y la otra no se arregla nunca.
    if (captchaImposible) {
      return mostrarError('ag-error-form', 'Tu navegador está bloqueando la verificación de seguridad, '
        + 'casi siempre por una extensión o un bloqueador de anuncios. Probá desactivarlo un momento, '
        + 'o escribinos a info@sebabru.com y coordinamos el turno por mail.');
    }
    return mostrarError('ag-error-form', 'Esperá un segundo a que termine la verificación de seguridad y probá de nuevo.');
  }

  boton.disabled = true;
  boton.textContent = 'Buscando horarios...';
  try {
    const resp = await fetch(`${API}/iniciarAgenda`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, email, telefono, modalidad, captchaToken, tipo: estado.tipo }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      mostrarError('ag-error-form', mensajeDe(data, resp));
      medir('turno_error', { motivo: data.error || 'iniciar' });
      captchaToken = '';
      if (typeof turnstile !== 'undefined') turnstile.reset();
      return;
    }
    // Los datos ya estan en el servidor: el borrador no hace falta mas.
    if (borradorAgenda) borradorAgenda.listo();
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
  estado.zonaNombre = zonaLegible(estado.zona);
  pintarFraseDeZona();
  $('ag-zona-nombre').addEventListener('click', abrirBuscadorDeZona);
  $('ag-btn-corregir').addEventListener('click', abrirBuscadorDeZona);

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
  // Que clase de encuentro viene a agendar, si el enlace lo dice. Es lo que
  // distingue el enlace que se le manda a alguien que arranca las sesiones
  // (?tipo=una-hora) del enlace de /consultas/, que es la consulta de dos
  // horas. El servidor lo valida y lo guarda en el pedido; de ahi en adelante
  // manda el pedido, asi que recargar la pagina no lo pierde.
  estado.tipo = q.get('tipo');

  // Se sabe por el id del pedido, antes de que conteste el servidor: el
  // turno_inicio se mide al entrar, no despues.
  estado.previsualizacion = estado.p === 'previsualizacion';

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
    recibirHorarios(await traerDisponibilidad());
  } catch (_) { /* se sigue con los que ya estaban */ }
}

iniciar();
