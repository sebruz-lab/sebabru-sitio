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

// Dias enteros entre dos fechas. Se mide al mediodia por la misma razon que
// diaDeSemana: ningun redondeo puede correr el resultado de dia.
function diasEntre(aISO, bISO) {
  return Math.round((Date.parse(`${aISO}T12:00:00Z`) - Date.parse(`${bISO}T12:00:00Z`)) / 86400000);
}

// -------------------------------------------------------
// Cada cuanto se repite algo
//
// Hay tres cosas que se repiten en la agenda y las tres se repiten igual: una
// franja de la semana, un horario excepcional recurrente y el encuentro
// habitual de una persona. Antes solo las series se repetian, siempre cada 14
// dias y con el numero escrito en el codigo.
//
// El default NO es el mismo para todas, y por eso lo elige cada quien:
//
//   una franja o un excepcional sin frecuencia -> semanal, que es lo que
//   significaban los que ya estan guardados.
//   una serie sin frecuencia -> quincenal, que es lo que significaban las
//   series que ya estan guardadas.
//
// Si se equivocara el default, las dos cosas cambiarian de comportamiento
// solas en un deploy.
// -------------------------------------------------------
const DIAS_QUINCENA = 14;

function diasDeFrecuencia(frecuencia) {
  return frecuencia === 'semanal' ? 7 : DIAS_QUINCENA;
}

function periodoDeSerie(serie) {
  return diasDeFrecuencia((serie && serie.frecuencia) || 'quincenal');
}

// Si algo que se repite aplica a este dia. No mira el dia de la semana: de eso
// se encarga quien llama, que ya lo sabe (las franjas vienen de un mapa por
// dia de semana y los excepcionales traen su `diaSemana`).
//
// Un ancla que falta, o una frecuencia semanal, significan "todas las
// semanas". Es a proposito y es la red que evita el peor error posible aca:
// una quincenal sin ancla seria "cada 14 dias contados desde la epoca", o sea
// una franja que aparece y desaparece sin que nada en la pantalla lo explique.
function caeEnLaFecha(entrada, diaISO, frecuenciaPorDefecto = 'semanal') {
  if (!entrada) return false;
  if (entrada.desdeFecha && diaISO < entrada.desdeFecha) return false;
  if (entrada.hastaFecha && diaISO > entrada.hastaFecha) return false;
  const dias = diasDeFrecuencia(entrada.frecuencia || frecuenciaPorDefecto);
  if (dias === 7 || !entrada.ancla) return true;
  if (diaISO < entrada.ancla) return false;
  // Se cuenta en SEMANAS desde el ancla, no en dias exactos. El ancla marca
  // la semana en la que algo arranca, y asi un ancla que cayo en otro dia de
  // la semana sigue funcionando: con dias exactos, un ancla puesta un lunes
  // sobre una franja de los martes no daba multiplo de 14 ningun martes y la
  // franja desaparecia entera, sin nada en la pantalla que lo explicara.
  const semanas = Math.floor(diasEntre(diaISO, entrada.ancla) / 7);
  return semanas % (dias / 7) === 0;
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

// Si un excepcional aplica a este dia, sin mirar el tipo. Las dos formas (con
// fecha y recurrente) en un solo lugar, porque hay tres cosas que lo
// preguntan.
function excepcionalEnElDia(e, diaISO) {
  if (!e || !e.desde || !e.hasta) return false;
  if (e.repite) {
    if (Number(e.diaSemana) !== diaDeSemana(diaISO)) return false;
    return caeEnLaFecha(e, diaISO, 'semanal');
  }
  return e.fecha === diaISO;
}

// -------------------------------------------------------
// Un extra tomado cierra los otros extras de ese dia
//
// Cuando Seba abre tres horarios un lunes para que alguien elija uno, los tres
// son el mismo lunes: tomado uno, los otros dos no tienen que seguir
// ofreciendose. Eso es lo que marca `unicoPorDia`.
//
// Se DERIVA de las reservas en vez de guardarse en el documento. Guardarlo
// pedia escribir al confirmar, revertir en los cinco caminos de cancelacion
// que existen (y el que mas se olvida no se llama cancelar: es la liberacion
// del turno viejo al reprogramar), y aun asi quedaba mal cuando dos turnos
// caian en extras distintos del mismo dia. Derivado, cancelar reabre el dia
// gratis y no hay nada que mantener.
//
// `reservas` son solo los turnos del sitio, no la ocupacion entera: un evento
// cualquiera del calendario de Seba adentro del extra tapa esa franja -- de
// eso ya se encarga chocaCon -- pero no cierra el dia, porque nadie reservo.
// -------------------------------------------------------
function diaConExtraTomado(diaISO, excepcionales, reservas) {
  if (!reservas || !reservas.length) return false;
  const base = msDeHoraLocal(diaISO, '00:00');
  for (const e of (excepcionales || [])) {
    if (!e || !e.unicoPorDia) continue;
    if (!excepcionalEnElDia(e, diaISO)) continue;
    const desdeMin = minutosDeHora(e.desde);
    const hastaMin = minutosDeHora(e.hasta);
    if (desdeMin === null || hastaMin === null || hastaMin <= desdeMin) continue;
    const arranca = base + desdeMin * 60000;
    const termina = base + hastaMin * 60000;
    if (reservas.some(([a, b]) => a < termina && b > arranca)) return true;
  }
  return false;
}

function franjasExcepcionales(diaISO, tipo, excepcionales, reservas) {
  const salida = [];
  const tomado = diaConExtraTomado(diaISO, excepcionales, reservas);
  for (const e of (excepcionales || [])) {
    // Por defecto, solo las consultas de dos horas.
    if (!aplicaATipo(e, tipo, tipo === TIPO_POR_DEFECTO)) continue;
    if (!excepcionalEnElDia(e, diaISO)) continue;
    // El que cierra el dia tambien se cierra a si mismo, y esta bien: su
    // horario ya esta ocupado por el turno que lo tomo.
    if (e.unicoPorDia && tomado) continue;
    salida.push({ desde: e.desde, hasta: e.hasta, motivo: e.motivo || '' });
  }
  return salida;
}

// -------------------------------------------------------
// Las franjas regulares de un dia
//
// Antes era una linea adentro de horariosDe: el arreglo del dia de la semana,
// tal cual. Ahora una franja puede valer una semana de por medio y puede ser
// solo para un tipo de turno, que es lo que permite tener un viernes de
// sesiones y el siguiente de consultas sin bloqueos puestos a mano.
//
// Una franja sin `tipos` vale para todos y una sin `frecuencia` cae todas las
// semanas: las franjas que ya estan guardadas siguen significando lo mismo.
// -------------------------------------------------------
function franjasDelDia(diaISO, tipo, config) {
  const todas = (config && config.semana && config.semana[String(diaDeSemana(diaISO))]) || [];
  return todas.filter(f => aplicaATipo(f, tipo) && caeEnLaFecha(f, diaISO, 'semanal'));
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
  series = [], excluirSerie = null, reservas = [], materializadas = null,
  // Las ocurrencias de una serie cuyo turno existe y ya no esta reservado:
  // cancelado, o movido a otro horario. Son las unicas, junto con las series
  // pausadas, cuyo espacio se vuelve a ofrecer.
  liberadas = null,
  ahora = Date.now(), topeDias = null, sinAnticipacion = false,
}) {
  const t = tipoDe(config, tipo);
  // El tipo YA resuelto, y es el que usa todo el cuerpo de aca para abajo.
  //
  // Antes el cuerpo usaba el `tipo` crudo, y eso hacia que una llamada sin
  // tipo (que significa "la consulta de dos horas", el unico que existia
  // antes de que hubiera tipos) no viera ni los horarios excepcionales ni los
  // bloqueos puestos para las consultas: `aplicaATipo` compara contra
  // 'dos-horas' y recibia undefined. Callado, porque las dos cosas se
  // resuelven con un "no aplica".
  const tipoId = t.id;
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
  const deSeries = [];

  for (let dia = desde; dia <= hasta; dia = sumarDias(dia, 1)) {
    for (const tramo of tramosBloqueados(dia, tipoId, bloqueos)) bloqueados.push(tramo);

    const regulares = franjasDelDia(dia, tipoId, config);
    const extras = franjasExcepcionales(dia, tipoId, excepcionales, reservas);

    // Los espacios de los encuentros habituales ocupan igual que cualquier
    // otra cosa, con el mismo aire. Se arma un `ocupados` propio del dia en
    // lugar de sumarlos a la lista general a proposito: quien llama usa esa
    // lista tambien para pintar "esto esta en tu Google Calendar", y un
    // encuentro que todavia no se materializo no esta ahi. Decirlo seria
    // mentir en la unica pantalla donde Seba comprueba lo que configuro.
    const tramosSerie = tramosDeSeries(dia, series, config, excluirSerie, materializadas, liberadas);
    const ocupadosDelDia = tramosSerie.length
      ? [...ocupados, ...tramosSerie.map(t => [t.inicio, t.fin])]
      : ocupados;
    for (const t of tramosSerie) {
      deSeries.push({
        desde: isoLocal(t.inicio),
        hasta: isoLocal(t.fin),
        diaEntero: false,
        motivo: t.nombre ? `Espacio de ${t.nombre}` : 'Espacio habitual',
        serieId: t.serieId,
        ocurrencia: t.ocurrencia,
      });
    }

    // Los espacios habituales que quedaron libres -- cancelados, movidos, o de
    // una serie pausada. Van con la lista normal y no con los extraordinarios:
    // no son un hueco que Seba abrio a mano, son el horario de siempre de
    // alguien que esta vez no lo usa. El arranque es la hora de esa persona y
    // no un punto de la grilla, asi que se prueba uno por uno en vez de pasar
    // por el bucle de las franjas.
    for (const b of bloquesDeSeries(dia, series, config, liberadas)) {
      if (b.inicio + duracionMs > b.hasta) continue;
      if (b.inicio < minimoMs || b.inicio > topeMs) continue;
      if (bloqueadoPara(b.inicio, b.inicio + duracionMs, tipoId, bloqueos)) continue;
      if (chocaCon(b.inicio, b.inicio + duracionMs, ocupadosDelDia, bufferMs)) continue;
      slots.push(isoLocal(b.inicio));
    }

    for (const [franjas, destino] of [[regulares, slots], [extras, sueltos]]) {
      for (const franja of franjas) {
        const desdeMin = minutosDeHora(franja.desde);
        const hastaMin = minutosDeHora(franja.hasta);
        if (desdeMin === null || hastaMin === null || hastaMin <= desdeMin) continue;
        const base = msDeHoraLocal(dia, '00:00');
        const finFranja = base + hastaMin * 60000;
        for (let inicio = base + desdeMin * 60000; inicio + duracionMs <= finFranja; inicio += paso) {
          if (inicio < minimoMs || inicio > topeMs) continue;
          if (bloqueadoPara(inicio, inicio + duracionMs, tipoId, bloqueos)) continue;
          if (chocaCon(inicio, inicio + duracionMs, ocupadosDelDia, bufferMs)) continue;
          destino.push(isoLocal(inicio));
        }
      }
    }
  }

  // Un horario que ya esta entre los regulares no se repite como
  // excepcional: pasa cuando Seba abre un excepcional encima de una franja
  // que despues agrega a su semana regular.
  // Un espacio habitual libre puede caer tambien adentro de una franja de la
  // semana, y entonces el mismo horario se genero dos veces. Se ordena ademas
  // porque los habituales se agregan antes que las franjas de cada dia y la
  // pagina espera la lista en hora.
  const unicos = [...new Set(slots)].sort();
  const yaEsta = new Set(unicos);
  return {
    slots: unicos,
    excepcionales: sueltos.filter(s => !yaEsta.has(s)),
    bloqueados,
    // Los espacios de los encuentros habituales, aparte y con la misma forma
    // que `bloqueados`, para que el panel los pinte con el pintor que ya
    // tiene. Sin esta lista, un dia entero sin huecos se veria igual que un
    // dia sin franja: vacio y sin explicacion.
    series: deSeries,
  };
}

// -------------------------------------------------------
// La periodicidad de los encuentros habituales
//
// "Cada 15 dias" en la practica es cada 14: el mismo dia de la semana, una
// semana de por medio. El ejemplo del pedido lo dice solo -- jueves 26 de
// noviembre, jueves 10 de diciembre, jueves 24 de diciembre -- y son 14 dias
// entre uno y el siguiente. Con 15 el encuentro se correria un dia por vez y
// a los dos meses cae un martes.
//
// Desde que la frecuencia se elige por persona, el numero sale de
// periodoDeSerie y 14 es el default. El parametro existe para que los dos
// lugares que proyectan fechas no tengan cada uno su propia idea de cada
// cuanto.
// -------------------------------------------------------

// Las fechas desde una, inclusive, hasta un tope.
function proyectarQuincenal(primeraISO, hora, hastaISO, periodo = DIAS_QUINCENA) {
  const fechas = [];
  for (let dia = primeraISO; dia <= hastaISO; dia = sumarDias(dia, periodo)) {
    fechas.push(msDeHoraLocal(dia, hora));
  }
  return fechas;
}

// Los encuentros de una serie dentro de una ventana. El ancla es la fecha
// desde la que se cuentan los periodos, asi que la serie no necesita
// guardar la lista: se deriva, y moverla es cambiar una fecha.
//
// `serie.hasta` corta la proyeccion. Tiene que cortarla ACA y no solo donde se
// mira la ocupacion: si no, el trabajo diario seguiria materializando
// encuentros de alguien que ya termino.
function fechasDeSerie(serie, desdeISO, hastaISO) {
  if (!serie || !serie.ancla || !serie.hora) return [];
  const periodo = periodoDeSerie(serie);
  let dia = serie.ancla;
  // Hasta entrar en la ventana. Un while sobre dias de a 14 es barato: dos
  // meses son cuatro vueltas, y un ancla vieja de un ano son 26.
  while (dia < desdeISO) dia = sumarDias(dia, periodo);
  const tope = serie.hasta && serie.hasta < hastaISO ? serie.hasta : hastaISO;
  return proyectarQuincenal(dia, serie.hora, tope, periodo);
}

// -------------------------------------------------------
// Los espacios de los encuentros habituales
//
// El horario de quien viene cada quince dias desde hace anos no se protege
// porque su turno este creado: se protege porque es suyo. Antes dependia de
// que el turno estuviera materializado, y eso valia hasta donde llegaba el
// ultimo barrido -- el mismo horizonte en el que el publico puede reservar,
// asi que en el borde habia carrera y el espacio se podia perder.
//
// Devuelve un tramo por encuentro, con su ocurrencia, para que quien excluya
// pueda excluir UN encuentro y no la serie entera: si se excluyera la serie,
// alguien podria mover su encuentro del 10 encima de su propio horario del
// 24.
// -------------------------------------------------------
// Cuanto dura un encuentro habitual.
//
// Esta en una sola funcion porque la respuesta tiene que ser la MISMA en los
// dos lados que la preguntan: el que protege el horario (tramosDeSeries) y el
// que crea el turno (extenderSerie, en index.js). Cuando no lo era, una serie
// vieja sin `tipo` se protegia como consulta -- dos horas, el tipo por
// defecto del sitio -- y se materializaba como sesion de una. El espacio de
// Belen, de 08:00 a 09:00, tapaba hasta las 10:00 un horario que en el
// calendario estaba vacio, y el encuentro de las 09:30 de la persona
// siguiente se rechazaba como ocupado sin que nada se viera.
//
// El default es la sesion de una hora y no el tipo por defecto del sitio:
// un encuentro habitual es una sesion, no una consulta de dos horas.
const TIPO_DE_SERIE = 'una-hora';

function duracionDeSerie(serie, config) {
  if (serie && Number.isFinite(serie.duracionMin)) return serie.duracionMin;
  return tipoDe(config, (serie && serie.tipo) || TIPO_DE_SERIE).duracionMin;
}

function tramosDeSeries(diaISO, series, config, excluir, materializadas, liberadas = null) {
  const dow = diaDeSemana(diaISO);
  const salida = [];
  for (const s of (series || [])) {
    if (!s || !s.hora || minutosDeHora(s.hora) === null) continue;
    // Una serie pausada no ocupa nada: es justo para lo que sirve pausarla.
    if (s.estado && s.estado !== 'activa') continue;
    if (Number(s.diaSemana) !== dow) continue;
    if (!caeEnLaFecha({ frecuencia: s.frecuencia, ancla: s.ancla, hastaFecha: s.hasta || null }, diaISO, 'quincenal')) continue;
    // Sin ancla no hay serie: no se puede saber que quincena le toca.
    if (!s.ancla) continue;
    if (excluir && excluir.serieId && excluir.serieId === s.id && excluir.ocurrencia === diaISO) continue;
    // Si ese encuentro YA se creo, el que manda es el turno y no la regla.
    //
    // La regla existe para proteger lo que todavia no se materializo, que es
    // lo que vive mas alla del horizonte del barrido. Dentro del horizonte el
    // turno esta en `ocupados` y bloquea igual, asi que aplicar las dos cosas
    // no agrega proteccion: lo unico que agrega es que un encuentro cancelado
    // o movido a otro dia siga tapando su horario viejo para siempre. Y ese
    // horario, cuando queda libre, es justamente el que hay que volver a
    // ofrecer.
    if (materializadas && s.id && materializadas.has(`${s.id}|${diaISO}`)) continue;
    // Y lo que se libero no se protege, aunque no llegue en `materializadas`.
    //
    // En la practica toda ocurrencia liberada esta materializada -- las dos
    // listas salen de los mismos documentos -- asi que la linea de arriba ya
    // alcanzaria. Pero entonces el motor dependeria de una invariante que
    // vive en otro archivo, y el dia que dejara de valer protegeria justo el
    // hueco que se acaba de abrir, sin que nada lo dijera.
    if (liberadas && s.id && liberadas.has(`${s.id}|${diaISO}`)) continue;
    const duracion = duracionDeSerie(s, config);
    const inicio = msDeHoraLocal(diaISO, s.hora);
    salida.push({
      serieId: s.id || null,
      ocurrencia: diaISO,
      nombre: s.nombre || '',
      inicio,
      fin: inicio + duracion * 60000,
    });
  }
  return salida;
}

// -------------------------------------------------------
// El espacio de un habitual se ofrece SOLO cuando se libero
//
// El horario de quien viene desde hace anios es suyo: queda reservado para esa
// persona y no se le ofrece a nadie. Se ofrece unicamente cuando de verdad
// quedo libre, que son tres casos y nada mas:
//
//   - la serie esta pausada (esa persona no viene por un tiempo),
//   - su encuentro de ese dia se cancelo,
//   - su encuentro de ese dia se movio a otro horario (`liberadas` trae las
//     dos ultimas, que son un turno que existe y ya no esta reservado).
//
// Antes se ofrecia siempre, con el argumento de que el dia y la hora son
// horario de trabajo de Seba caiga o no esa persona. Eso publicaba el espacio
// de cada habitual todas las semanas: el martes 11:45 de Gabi se le ofrecia a
// cualquiera, y aparecian horarios -- el viernes 08:00 -- que no salian de
// ninguna franja ni de ningun extraordinario, asi que no habia nada que
// editar en el panel. Para abrir un hueco suelto estan los extraordinarios,
// que se ven y se editan; para abrir el horario de verdad, las franjas.
//
// Y SI mira frecuencia y ancla, al contrario de lo que hacia antes: solo los
// dias que son ocurrencia de la serie. Un espacio quincenal no se libera la
// semana en la que esa persona no venia -- esa semana no era de nadie.
//
// Lo que devuelve es un horario de arranque por encuentro liberado de ese dia
// (la hora de esa persona, no una grilla nueva), con el fin del bloque corrido
// al que llegan los encuentros liberados pegados. Por eso dos espacios de una
// hora seguidos y los dos libres alcanzan para una consulta de dos. Se fusiona
// solo lo que se toca: con un hueco de diez minutos en el medio son dos
// bloques, porque ofrecer dos horas encima de un hueco es ofrecer algo que no
// entra. Y no se fusiona con el espacio de al lado si ese sigue siendo de
// alguien: lo que se ofrece es el hueco que quedo, no el de la persona que
// viene igual.
// -------------------------------------------------------
function bloquesDeSeries(diaISO, series, config, liberadas = null) {
  const dow = diaDeSemana(diaISO);
  const ventanas = [];
  for (const s of (series || [])) {
    if (!s || !s.hora || minutosDeHora(s.hora) === null) continue;
    if (Number(s.diaSemana) !== dow) continue;
    // Solo los dias que le tocan a esa serie. Sin ancla no hay serie: no se
    // puede saber que quincena es suya, y por lo tanto tampoco cual se libero.
    if (!s.ancla) continue;
    if (!caeEnLaFecha({ frecuencia: s.frecuencia, ancla: s.ancla, hastaFecha: s.hasta || null }, diaISO, 'quincenal')) continue;
    // Pausada: el espacio esta libre todo lo que dure la pausa, y es justo
    // cuando mas sirve ofrecerlo. Activa: solo si ese encuentro se cancelo o
    // se movio.
    const pausada = Boolean(s.estado) && s.estado !== 'activa';
    const suelta = Boolean(liberadas && s.id && liberadas.has(`${s.id}|${diaISO}`));
    if (!pausada && !suelta) continue;
    const inicio = msDeHoraLocal(diaISO, s.hora);
    ventanas.push([inicio, inicio + duracionDeSerie(s, config) * 60000]);
  }
  if (!ventanas.length) return [];
  ventanas.sort((a, b) => a[0] - b[0]);

  const bloques = [];
  for (const [a, b] of ventanas) {
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && a <= ultimo[1]) { ultimo[1] = Math.max(ultimo[1], b); continue; }
    bloques.push([a, b]);
  }

  const salida = [];
  const vistos = new Set();
  for (const [a] of ventanas) {
    if (vistos.has(a)) continue;
    vistos.add(a);
    const bloque = bloques.find(([x, y]) => a >= x && a < y);
    salida.push({ inicio: a, hasta: bloque ? bloque[1] : a });
  }
  return salida;
}

// -------------------------------------------------------
// Los huecos agendables, en bloques: lo que se publica en Google Calendar
//
// Entra la lista de horarios que el sitio ofrece de verdad (los `slots` que
// devuelve horariosDe) y salen los tramos contiguos, para ver de un vistazo
// cuanto aire queda en el dia en lugar de una fila de eventos cortos.
//
// Se parte de los horarios ofrecidos y no de las franjas menos lo ocupado, y
// es a proposito: lo que se publica tiene que ser lo que alguien puede tomar.
// Un hueco de cuarenta minutos entre dos encuentros no es un espacio
// agendable, y pintarlo como libre seria prometer algo que la pantalla de
// reservas no ofrece.
//
// El aire entre encuentro y encuentro cuenta como parte del bloque: con una
// cadencia de 75 para sesiones de 60, los horarios de 14:00 y 15:15 dejan
// quince minutos en el medio que no son un hueco sino el respiro. Por eso dos
// horarios se fusionan cuando el siguiente arranca a menos de `toleranciaMin`
// del fin del anterior. Sin esa tolerancia cada sesion seria su propio
// evento y el calendario quedaria igual de picado que antes.
//
// `cuantos` dice cuantos espacios entran en el bloque, que es el dato que
// convierte "de 14 a 16:15" en "dos sesiones" -- y de paso avisa cuando dos
// seguidos alcanzan para una consulta de dos horas.
// -------------------------------------------------------
function bloquesLibres(slots, duracionMin, toleranciaMin = 0) {
  const ordenados = [...new Set(slots || [])].sort();
  const bloques = [];
  const duracionMs = duracionMin * 60000;
  const toleranciaMs = toleranciaMin * 60000;

  for (const iso of ordenados) {
    const inicio = Date.parse(iso);
    if (!Number.isFinite(inicio)) continue;
    const fin = inicio + duracionMs;
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && inicio - ultimo.fin <= toleranciaMs) {
      ultimo.fin = Math.max(ultimo.fin, fin);
      ultimo.cuantos += 1;
      continue;
    }
    bloques.push({ inicio, fin, cuantos: 1 });
  }
  return bloques;
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
  TIPOS_POR_DEFECTO, TIPO_POR_DEFECTO, TIPO_DE_SERIE, DIAS_QUINCENA,
  duracionDeSerie, bloquesDeSeries, bloquesLibres,
  tipoDe, cadenciaSugerida,
  msDeHoraLocal, diaLocal, horaLocal, isoLocal, diaDeSemana, sumarDias,
  minutosDeHora, idDeTurno, diasEntre,
  diasDeFrecuencia, periodoDeSerie, caeEnLaFecha,
  chocaCon, aplicaATipo, tramoDelBloqueo, bloqueadoPara, tramosBloqueados,
  franjasExcepcionales, excepcionalEnElDia, diaConExtraTomado, franjasDelDia,
  tramosDeSeries,
  horariosDe,
  proyectarQuincenal, fechasDeSerie, puedeCambiar,
};
