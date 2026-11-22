// Motor de disponibilidad de la agenda.
//
// Todo lo que decide QUE horarios existen vive aca: las fechas, los tipos de
// turno, los bloqueos, los horarios excepcionales y la proyeccion quincenal.
// Lo que NO vive aca es nada que hable con Firestore ni con Google Calendar:
// este archivo no hace una sola llamada de red.
//
// Esa frontera es a proposito y es lo que lo vuelve comprobable: las reglas
// se prueban con `node --test functions/` en un segundo, sin emulador y sin
// credenciales. index.js se queda con lo que sabe leer y escribir, y le pasa
// los datos ya leidos.
//
// Argentina no tiene horario de verano desde 2009, asi que toda la agenda se
// calcula con un offset fijo. Es lo que permite generar los horarios con
// aritmetica de milisegundos y sin una libreria de zonas horarias. Si alguna
// vez vuelve el huso de verano, esto es lo primero que hay que tocar.

const AGENDA_OFFSET = '-03:00';
const AGENDA_ZONA = 'America/Argentina/Cordoba';

// Lo mas largo que puede durar un turno. Lo usan el saneado de la
// configuracion (nadie puede guardar una duracion mayor) y la consulta de
// turnos vecinos de reservarParaPedido, que necesita saber cuanto antes del
// horario pedido puede empezar algo que lo solape.
const MAX_TURNO_MIN = 480;

// -------------------------------------------------------
// Los dos tipos de turno
//
// Los ids son 'una-hora' y 'dos-horas' y no 'sesion' y 'consulta' por una
// razon concreta: en castellano las dos palabras se usan para las dos cosas
// (a una sesion tambien se le dice consulta, y al reves). Un id que nombra la
// duracion no se puede confundir con el otro. Los nombres para la pantalla
// salen de `nombre`.
//
//   una-hora  -> la sesion individual, cada 15 dias.
//   dos-horas -> la consulta suelta (carta natal o revolucion solar: para la
//                agenda son la misma cosa, y por eso el formulario de
//                consultas no necesita preguntar cual es).
// -------------------------------------------------------
const TIPOS_POR_DEFECTO = {
  'una-hora': {
    nombre: 'Sesión',
    duracionMin: 60,
    // Solo se usa si la configuracion no tiene cadenciaMin. Y vale 75, no
    // 60, porque una grilla en punto con 15 minutos de aire es incoherente:
    // cualquier hueco que quede entre dos turnos ya tomados cae siempre a
    // menos de 15 minutos de alguno de los dos, asi que no se ofrece nunca
    // y la sesion solo entra en los bordes de la franja. 75 es duracion mas
    // aire, el mismo numero que da cadenciaSugerida.
    granularidadMin: 75,
    // Un cuarto de hora entre un encuentro y el siguiente. De aca sale la
    // cadencia de 75 minutos de la agenda: 14:00, 15:15, 16:30.
    bufferMin: 15,
    anticipacionHoras: 24,
    // Mas corta que la de reservar: mover un turno existente es mas barato
    // que pedirlo, y es la regla del apartado 9.
    anticipacionCambioHoras: 12,
  },
  'dos-horas': {
    nombre: 'Consulta',
    duracionMin: 120,
    granularidadMin: 30,
    bufferMin: 15,
    anticipacionHoras: 48,
    anticipacionCambioHoras: 48,
  },
};

// El tipo por defecto cuando no viene ninguno. Es la consulta de dos horas
// porque es lo unico que existia antes de que hubiera tipos: un pedido viejo,
// sin campo `tipo`, tiene que seguir significando exactamente lo mismo.
const TIPO_POR_DEFECTO = 'dos-horas';

// La configuracion de un tipo, mezclada en este orden: lo que trae el tipo
// por defecto, lo que Seba guardo para ese tipo, y -- solo para el tipo
// heredado -- los campos sueltos de la configuracion vieja.
//
// Ese ultimo paso es lo que hace que la agenda de hoy no cambie de
// comportamiento: `duracionMin` y companhia siguen estando en la raiz de
// agenda_config y siguen mandando para las consultas de dos horas, asi que
// si Seba las tenia en 90 minutos, siguen en 90.
function tipoDe(config, tipo) {
  const id = tipo && TIPOS_POR_DEFECTO[tipo] ? tipo : TIPO_POR_DEFECTO;
  const base = TIPOS_POR_DEFECTO[id];
  const guardado = (config && config.tipos && config.tipos[id]) || {};
  const heredado = {};
  if (id === TIPO_POR_DEFECTO && config) {
    for (const campo of ['duracionMin', 'granularidadMin', 'anticipacionHoras', 'bufferMin']) {
      if (Number.isFinite(config[campo])) heredado[campo] = config[campo];
    }
  }
  const mezcla = { ...base, ...heredado, ...guardado, id };
  // Sin anticipacion propia para cambiar, cambiar cuesta lo mismo que
  // reservar. Nunca al reves: un tipo no deberia dejar mover un turno con
  // menos aviso del que pidio para tomarlo... salvo que este escrito.
  if (!Number.isFinite(mezcla.anticipacionCambioHoras)) {
    mezcla.anticipacionCambioHoras = mezcla.anticipacionHoras;
  }
  return mezcla;
}

// La cadencia que le corresponde a una configuracion: el ritmo del turno mas
// corto, duracion mas aire. Es lo que el panel ofrece por defecto para que
// cadenciaMin no haya que calcularlo a mano ni se desincronice de los tipos.
function cadenciaSugerida(config) {
  const corto = tipoDe(config, 'una-hora');
  return corto.duracionMin + (corto.bufferMin || 0);
}

// -------------------------------------------------------
// Fechas, todas en hora de Argentina con el offset fijo
// -------------------------------------------------------
function msDeHoraLocal(fechaISO, hhmm) {
  return Date.parse(`${fechaISO}T${hhmm}:00${AGENDA_OFFSET}`);
}

// 'YYYY-MM-DD' del dia argentino al que pertenece ese instante.
function diaLocal(ms) {
  return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// 'HH:MM' en hora argentina.
function horaLocal(ms) {
  return new Date(ms - 3 * 3600 * 1000).toISOString().slice(11, 16);
}

function isoLocal(ms) {
  return `${diaLocal(ms)}T${horaLocal(ms)}:00${AGENDA_OFFSET}`;
}

// Domingo = 0. Se mira al mediodia para que ningun redondeo lo corra de dia.
function diaDeSemana(fechaISO) {
  return new Date(msDeHoraLocal(fechaISO, '12:00')).getUTCDay();
}

function sumarDias(fechaISO, n) {
  return new Date(Date.parse(`${fechaISO}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function minutosDeHora(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// El id del turno sale del horario, no de un random: dos personas que
// aprietan el mismo horario a la vez chocan en el mismo documento y una de
// las dos pierde la transaccion. Es el mismo truco que pagos_procesados.
//
// Ojo: esto protege del MISMO horario, no de dos que se solapan. De eso se
// encarga la comprobacion que reservarParaPedido hace adentro de la
// transaccion.
function idDeTurno(ms) {
  return `${diaLocal(ms)}T${horaLocal(ms).replace(':', '-')}`;
}

// -------------------------------------------------------
// Solapamiento
// -------------------------------------------------------
function chocaCon(inicioMs, finMs, ocupados, bufferMs) {
  return ocupados.some(([a, b]) => inicioMs < (b + bufferMs) && (finMs + bufferMs) > a);
}

// -------------------------------------------------------
// Bloqueos
//
// Un bloqueo tiene tres partes, y las dos ultimas son opcionales:
//
//   { desde: '2026-12-24', hasta: '2026-12-26' }   el dia entero, todo tipo
//   { ..., desdeHora: '10:00', hastaHora: '12:00' } solo ese tramo del dia
//   { ..., tipos: ['una-hora'] }                    solo para esos tipos
//
// Sin horas es el dia completo y sin tipos aplica a todos, que es lo que
// significan los bloqueos que ya estan guardados: no hay nada que migrar.
//
// El bloqueo por tipo es lo que resuelve la regla que mas importa: un tramo
// con tipos: ['una-hora'] desaparece de los turnos de una hora y queda
// entero para una consulta de dos. Al reves no hay nada que hacer: que una
// consulta de dos horas solo se ofrezca si el bloque esta completo libre ya
// lo hace chocaCon, porque mide con inicio + 120.
// -------------------------------------------------------

// A que tipos aplica un bloqueo (o un excepcional): sin la lista, a todos.
function aplicaATipo(entrada, tipo, porDefecto) {
  const lista = Array.isArray(entrada && entrada.tipos) ? entrada.tipos : null;
  if (!lista) return porDefecto === undefined ? true : porDefecto;
  if (!lista.length) return true;
  return lista.includes(tipo);
}

// El intervalo [desde, hasta] en milisegundos que ocupa un bloqueo en un dia
// determinado, o null si ese dia no esta bloqueado.
function tramoDelBloqueo(bloqueo, diaISO) {
  if (!bloqueo || !bloqueo.desde || !bloqueo.hasta) return null;
  if (diaISO < bloqueo.desde || diaISO > bloqueo.hasta) return null;
  const desdeMin = minutosDeHora(bloqueo.desdeHora);
  const hastaMin = minutosDeHora(bloqueo.hastaHora);
  const base = msDeHoraLocal(diaISO, '00:00');
  // Sin tramo horario, o con uno mal escrito, es el dia entero. Preferir el
  // dia entero ante un dato dudoso es el lado seguro del error: de mas se
  // bloquea, nunca de menos.
  if (desdeMin === null || hastaMin === null || hastaMin <= desdeMin) {
    return [base, base + 24 * 60 * 60000];
  }
  return [base + desdeMin * 60000, base + hastaMin * 60000];
}

// El bloqueo que impide este turno, o null. Devuelve el bloqueo entero (y no
// un booleano) porque el motivo se muestra en pantalla: un hueco gris con un
// "guardado para consultas de dos horas" se entiende, y un hueco que no esta
// se lee como "no hay lugar".
function bloqueadoPara(inicioMs, finMs, tipo, bloqueos) {
  const dia = diaLocal(inicioMs);
  for (const b of (bloqueos || [])) {
    if (!aplicaATipo(b, tipo)) continue;
    const tramo = tramoDelBloqueo(b, dia);
    if (!tramo) continue;
    // Sin buffer: un bloqueo es un "no aca", no un "no cerca". Asi una
    // consulta de 12 a 14 convive con un bloqueo de 10 a 12.
    if (inicioMs < tramo[1] && finMs > tramo[0]) return b;
  }
  return null;
}

// Los tramos de un dia que estan bloqueados para este tipo, para pintarlos.
// Se devuelven tal como se guardaron (en hora de Argentina) porque la pagina
// los muestra, no los calcula.
function tramosBloqueados(diaISO, tipo, bloqueos) {
  const salida = [];
  for (const b of (bloqueos || [])) {
    if (!aplicaATipo(b, tipo)) continue;
    const tramo = tramoDelBloqueo(b, diaISO);
    if (!tramo) continue;
    salida.push({
      desde: isoLocal(tramo[0]),
      hasta: isoLocal(tramo[1]),
      diaEntero: !minutosDeHora(b.desdeHora),
      motivo: b.motivo || '',
    });
  }
  return salida;
}

// -------------------------------------------------------
// Horarios excepcionales
//
// Espacios que Seba abre de vez en cuando y que no quiere en su
// disponibilidad regular. Dos formas:
//
//   { fecha: '2026-12-15', desde: '09:00', hasta: '11:00' }
//   { repite: true, diaSemana: 1, desde: '09:00', hasta: '11:00',
//     desdeFecha: null, hastaFecha: null }
//
// Las dos reglas que no se negocian:
//
//   1. Son para las consultas de dos horas. Lo decide un solo lugar: la
//      lista `tipos` de cada excepcional, que cuando falta vale
//      ['dos-horas']. Hubo un momento en que esto se controlaba ademas con
//      un flag por tipo de turno, y las dos perillas se tapaban entre si en
//      silencio: con una sola, abrir un excepcional para una sesion es algo
//      que Seba escribe a proposito y nunca algo que pasa por descuido.
//   2. No establecen un horario habitual. Esto no se controla aca: lo
//      controla quien evalua el cambio de horario quincenal, que llama al
//      motor con la lista de excepcionales vacia. Un lunes a la manana
//      excepcional no se puede volver el quincenal de nadie, ni siquiera si
//      esta libre los proximos dos meses.
// -------------------------------------------------------
function franjasExcepcionales(diaISO, tipo, excepcionales) {
  const dow = diaDeSemana(diaISO);
  const salida = [];
  for (const e of (excepcionales || [])) {
    if (!e || !e.desde || !e.hasta) continue;
    // Por defecto, solo las consultas de dos horas.
    if (!aplicaATipo(e, tipo, tipo === TIPO_POR_DEFECTO)) continue;
    if (e.repite) {
      if (Number(e.diaSemana) !== dow) continue;
      if (e.desdeFecha && diaISO < e.desdeFecha) continue;
      if (e.hastaFecha && diaISO > e.hastaFecha) continue;
    } else if (e.fecha !== diaISO) {
      continue;
    }
    salida.push({ desde: e.desde, hasta: e.hasta, motivo: e.motivo || '' });
  }
  return salida;
}

// -------------------------------------------------------
// Los horarios de un tramo
//
// Devuelve tres listas, y las tres hacen falta:
//
//   slots       los horarios regulares libres: lo que se puede elegir.
//   excepcionales los excepcionales libres, aparte, porque la pagina los
//               muestra recien despues del "no encontras un horario que te
//               sirva?" y nunca mezclados con los regulares.
//   bloqueados  los tramos que este tipo no puede usar, para pintarlos en
//               gris con su motivo en lugar de que desaparezcan.
//
// `ahora` y `topeDias` entran por parametro para poder probar el motor y
// para que la materializacion de las quincenales pueda mirar mas lejos que
// la ventana en la que el publico puede reservar.
// -------------------------------------------------------
function horariosDe({
  config, tipo, desde, hasta,
  bloqueos = [], excepcionales = [], ocupados = [],
  ahora = Date.now(), topeDias = null, sinAnticipacion = false,
}) {
  const t = tipoDe(config, tipo);
  const duracionMs = t.duracionMin * 60000;
  // La cadencia: cada cuanto puede arrancar un turno adentro de una franja,
  // contando desde donde empieza la franja.
  //
  // Lo importante es que con cadenciaMin es UNA SOLA para los dos tipos, y
  // eso es lo que hace funcionar la agenda que Seba tiene de verdad. Su
  // jueves de 14 a 18, con sesiones de 60 y 15 de aire, da una cadencia de
  // 75: 14:00, 15:15, 16:30. La consulta de dos horas no se inventa
  // horarios propios, arranca en uno de esos mismos puntos y corre dos horas
  // derecho (14:00 a 16:00, o 15:15 a 17:15).
  //
  // De ahi sale solo lo que el pedido llama la regla inversa: dos espacios
  // de una hora libres y seguidos son una consulta de dos, porque 15:15 a
  // 17:15 tapa los slots de 15:15 y de 16:30. Y no al reves: para que una
  // sesion de una hora no parta un bloque que Seba quiere entero, lo que hay
  // es el bloqueo con tipos: ['una-hora'].
  //
  // Con grillas distintas por tipo esto no cerraba: la consulta se ofrecia
  // cada 30 minutos, caia a las 14:30 y dejaba la franja partida en pedazos
  // donde no entraba nada. Sin cadenciaMin se cae a la granularidad del
  // tipo, que es como venia funcionando la agenda de las consultas.
  const paso = ((config && config.cadenciaMin) || t.granularidadMin || 30) * 60000;
  // El aire lo pone el tipo que se esta reservando, no el que ya estaba:
  // `ocupados` son intervalos pelados -- de Calendar vienen sin tipo ninguno
  // -- asi que no hay forma de saber de que tipo era lo de al lado. Hoy los
  // dos tipos tienen los mismos 15 minutos, asi que da igual; si alguna vez
  // dejan de tenerlos, el que manda es el que llega.
  const bufferMs = (Number.isFinite(t.bufferMin) ? t.bufferMin : 0) * 60000;
  const minimoMs = sinAnticipacion ? 0 : ahora + (t.anticipacionHoras || 0) * 3600000;
  const dias = Number.isFinite(topeDias)
    ? topeDias
    : (config && config.ventanaDias ? config.ventanaDias : 60);
  const topeMs = ahora + dias * 86400000;

  const slots = [];
  const sueltos = [];
  const bloqueados = [];

  for (let dia = desde; dia <= hasta; dia = sumarDias(dia, 1)) {
    for (const tramo of tramosBloqueados(dia, tipo, bloqueos)) bloqueados.push(tramo);

    const regulares = (config && config.semana && config.semana[String(diaDeSemana(dia))]) || [];
    const extras = franjasExcepcionales(dia, tipo, excepcionales);

    for (const [franjas, destino] of [[regulares, slots], [extras, sueltos]]) {
      for (const franja of franjas) {
        const desdeMin = minutosDeHora(franja.desde);
        const hastaMin = minutosDeHora(franja.hasta);
        if (desdeMin === null || hastaMin === null || hastaMin <= desdeMin) continue;
        const base = msDeHoraLocal(dia, '00:00');
        const finFranja = base + hastaMin * 60000;
        for (let inicio = base + desdeMin * 60000; inicio + duracionMs <= finFranja; inicio += paso) {
          if (inicio < minimoMs || inicio > topeMs) continue;
          if (bloqueadoPara(inicio, inicio + duracionMs, tipo, bloqueos)) continue;
          if (chocaCon(inicio, inicio + duracionMs, ocupados, bufferMs)) continue;
          destino.push(isoLocal(inicio));
        }
      }
    }
  }

  // Un horario que ya esta entre los regulares no se repite como
  // excepcional: pasa cuando Seba abre un excepcional encima de una franja
  // que despues agrega a su semana regular.
  const yaEsta = new Set(slots);
  return {
    slots,
    excepcionales: sueltos.filter(s => !yaEsta.has(s)),
    bloqueados,
  };
}

// -------------------------------------------------------
// La periodicidad quincenal
//
// "Cada 15 dias" en la practica es cada 14: el mismo dia de la semana, una
// semana de por medio. El ejemplo del pedido lo dice solo -- jueves 26 de
// noviembre, jueves 10 de diciembre, jueves 24 de diciembre -- y son 14 dias
// entre uno y el siguiente. Con 15 el encuentro se correria un dia por vez y
// a los dos meses cae un martes.
// -------------------------------------------------------
const DIAS_QUINCENA = 14;

// Las fechas quincenales desde una, inclusive, hasta un tope.
function proyectarQuincenal(primeraISO, hora, hastaISO) {
  const fechas = [];
  for (let dia = primeraISO; dia <= hastaISO; dia = sumarDias(dia, DIAS_QUINCENA)) {
    fechas.push(msDeHoraLocal(dia, hora));
  }
  return fechas;
}

// Los encuentros de una serie dentro de una ventana. El ancla es la fecha
// desde la que se cuentan las quincenas, asi que la serie no necesita
// guardar la lista: se deriva, y moverla es cambiar una fecha.
function fechasDeSerie(serie, desdeISO, hastaISO) {
  if (!serie || !serie.ancla || !serie.hora) return [];
  let dia = serie.ancla;
  // Hasta entrar en la ventana. Un while sobre dias de a 14 es barato: dos
  // meses son cuatro vueltas, y un ancla vieja de un ano son 26.
  while (dia < desdeISO) dia = sumarDias(dia, DIAS_QUINCENA);
  return proyectarQuincenal(dia, serie.hora, hastaISO);
}

// -------------------------------------------------------
// La regla de anticipacion para cambiar un turno (apartado 9)
//
// Se mide contra el inicio del turno ORIGINAL, no contra el nuevo: lo que la
// regla protege es el espacio que esta por empezar. Y se comprueba en el
// servidor, nunca solo en la pantalla.
// -------------------------------------------------------
function puedeCambiar(inicioTurnoMs, configTipo, ahora = Date.now()) {
  const horas = Number.isFinite(configTipo && configTipo.anticipacionCambioHoras)
    ? configTipo.anticipacionCambioHoras
    : 0;
  return inicioTurnoMs - ahora >= horas * 3600000;
}

module.exports = {
  AGENDA_OFFSET, AGENDA_ZONA, MAX_TURNO_MIN,
  TIPOS_POR_DEFECTO, TIPO_POR_DEFECTO, DIAS_QUINCENA,
  tipoDe, cadenciaSugerida,
  msDeHoraLocal, diaLocal, horaLocal, isoLocal, diaDeSemana, sumarDias,
  minutosDeHora, idDeTurno,
  chocaCon, aplicaATipo, tramoDelBloqueo, bloqueadoPara, tramosBloqueados,
  franjasExcepcionales,
  horariosDe,
  proyectarQuincenal, fechasDeSerie, puedeCambiar,
};
