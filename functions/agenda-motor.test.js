// Pruebas del motor de disponibilidad.
//
//   node --test functions/
//
// No necesitan emulador, credenciales ni red: agenda-motor.js no habla con
// nada. Esa es toda la razon por la que el motor vive en su propio archivo.
//
// Las fechas estan escritas a mano y el `ahora` entra por parametro, asi que
// estas pruebas dan lo mismo hoy y en 2028.

const { test } = require('node:test');
const assert = require('node:assert');
const m = require('./agenda-motor');

// Martes 1 y jueves 3 de diciembre de 2026, de 10 a 18. El `ahora` queda
// lejos de la ventana para que la anticipacion no tape nada sin aviso.
const AHORA = m.msDeHoraLocal('2026-11-20', '09:00');

const CONFIG = {
  bufferMin: 15,
  duracionMin: 120,
  granularidadMin: 30,
  // La cadencia compartida, como va a quedar la agenda: 60 de sesion mas 15
  // de aire. Con la franja de 10 a 18 da 10:00, 11:15, 12:30, 13:45, 15:00,
  // 16:15 y 17:30.
  cadenciaMin: 75,
  anticipacionHoras: 48,
  ventanaDias: 60,
  semana: {
    '2': [{ desde: '10:00', hasta: '18:00' }], // martes
    '4': [{ desde: '10:00', hasta: '18:00' }], // jueves
  },
};

function horarios(extra) {
  return m.horariosDe({
    config: CONFIG, desde: '2026-12-01', hasta: '2026-12-01', ahora: AHORA, ...extra,
  });
}

const horasDe = lista => lista.map(s => s.slice(11, 16));

// -------------------------------------------------------
// Los tipos
// -------------------------------------------------------

test('sin tipo, es la consulta de dos horas con la configuracion de siempre', () => {
  const t = m.tipoDe(CONFIG, undefined);
  assert.equal(t.id, 'dos-horas');
  assert.equal(t.duracionMin, 120);
  assert.equal(t.granularidadMin, 30);
});

test('los campos sueltos de la configuracion vieja siguen mandando', () => {
  // Si Seba tenia sus consultas en 90 minutos, siguen en 90: el dia que se
  // agregaron los tipos no se le cambio la duracion por abajo.
  const t = m.tipoDe({ ...CONFIG, duracionMin: 90 }, 'dos-horas');
  assert.equal(t.duracionMin, 90);
});

test('lo que Seba guarda para un tipo gana sobre el valor de fabrica', () => {
  const t = m.tipoDe({ ...CONFIG, tipos: { 'una-hora': { anticipacionCambioHoras: 6 } } }, 'una-hora');
  assert.equal(t.duracionMin, 60);
  assert.equal(t.anticipacionCambioHoras, 6);
});

test('un tipo sin anticipacion propia para cambiar usa la de reservar', () => {
  const t = m.tipoDe(CONFIG, 'dos-horas');
  assert.equal(t.anticipacionCambioHoras, 48);
});

// -------------------------------------------------------
// Duraciones que conviven
// -------------------------------------------------------

test('los dos tipos arrancan en los mismos puntos y llegan hasta donde pueden', () => {
  // La misma grilla de 75 minutos. Lo unico que los diferencia es hasta
  // donde alcanzan: la sesion de una hora entra a las 16:15 y la consulta
  // de dos no, porque terminaria 18:15.
  assert.deepEqual(horasDe(horarios({ tipo: 'una-hora' }).slots),
    ['10:00', '11:15', '12:30', '13:45', '15:00', '16:15']);
  assert.deepEqual(horasDe(horarios({ tipo: 'dos-horas' }).slots),
    ['10:00', '11:15', '12:30', '13:45', '15:00']);
});

test('una hora tomada en el medio tapa mas horarios de consulta que de sesion', () => {
  // Una sesion de 11 a 12 (la de las 11:15 corrida, como si Seba la hubiera
  // puesto a mano): la consulta pierde los dos primeros arranques y la
  // sesion tambien, pero despues la sesion llega mas lejos.
  const ocupados = [[m.msDeHoraLocal('2026-12-01', '11:00'), m.msDeHoraLocal('2026-12-01', '12:00')]];
  assert.deepEqual(horasDe(horarios({ tipo: 'dos-horas', ocupados }).slots),
    ['12:30', '13:45', '15:00']);
  assert.deepEqual(horasDe(horarios({ tipo: 'una-hora', ocupados }).slots),
    ['12:30', '13:45', '15:00', '16:15']);
});

test('un hueco de una hora justa no alcanza para una sesion de una hora', () => {
  // Los 15 minutos de aire tienen que salir de algun lado, y de los dos
  // lados hay algo pegado. Es la contracara de que el aire exista: en la
  // cadencia de 75 ya viene puesto, pero un hueco que quedo de un turno
  // movido a mano puede no tenerlo.
  const dia = f => m.msDeHoraLocal('2026-12-01', f);
  const justo = [[dia('10:00'), dia('14:00')], [dia('15:00'), dia('18:00')]];
  assert.deepEqual(horasDe(horarios({ tipo: 'una-hora', ocupados: justo }).slots), []);
  assert.deepEqual(horasDe(horarios({ tipo: 'dos-horas', ocupados: justo }).slots), []);
});

// -------------------------------------------------------
// La cadencia compartida: el jueves de Seba
//
// "Tengo los jueves de 14 a 18 espacio para sesiones de una hora y de dos,
// depende la semana. En la agenda es un espacio de 14 a 15, otro de 15:15 a
// 16:15 y otro de 16:30 a 17:30. Si una sesion de 2 entra en juego, seria de
// 14 a 16 o de 15:15 a 17:15."
//
// Eso es todo este bloque, y es la razon por la que la grilla tiene que ser
// una sola para los dos tipos.
// -------------------------------------------------------
const JUEVES = {
  ...CONFIG,
  // 60 de sesion + 15 de aire. La da cadenciaSugerida, no se escribe a mano.
  cadenciaMin: 75,
  semana: { '4': [{ desde: '14:00', hasta: '18:00' }] },
};

function elJueves(extra) {
  return m.horariosDe({
    config: JUEVES, desde: '2026-12-03', hasta: '2026-12-03', ahora: AHORA, ...extra,
  });
}

test('la cadencia sugerida sale de la sesion mas corta, duracion mas aire', () => {
  assert.equal(m.cadenciaSugerida(CONFIG), 75);
  assert.equal(m.cadenciaSugerida({ tipos: { 'una-hora': { duracionMin: 60, bufferMin: 0 } } }), 60);
});

test('el jueves de 14 a 18 da tres sesiones de una hora: 14:00, 15:15 y 16:30', () => {
  assert.deepEqual(horasDe(elJueves({ tipo: 'una-hora' }).slots), ['14:00', '15:15', '16:30']);
});

test('y dos consultas de dos horas, en los mismos puntos de arranque', () => {
  // 16:30 no entra: terminaria 18:30 y la franja cierra a las 18.
  assert.deepEqual(horasDe(elJueves({ tipo: 'dos-horas' }).slots), ['14:00', '15:15']);
});

test('dos espacios de una hora libres y seguidos se vuelven una consulta de dos', () => {
  // Tomada la primera sesion (14 a 15), quedan libres 15:15 y 16:30. La
  // consulta de dos horas entra justo ahi: 15:15 a 17:15.
  const ocupados = [[m.msDeHoraLocal('2026-12-03', '14:00'), m.msDeHoraLocal('2026-12-03', '15:00')]];
  assert.deepEqual(horasDe(elJueves({ tipo: 'una-hora', ocupados }).slots), ['15:15', '16:30']);
  assert.deepEqual(horasDe(elJueves({ tipo: 'dos-horas', ocupados }).slots), ['15:15']);
});

test('una consulta de dos horas se lleva dos espacios de una y deja el tercero', () => {
  // 14 a 16 ocupa los slots de 14:00 y de 15:15. Queda el de 16:30, porque
  // entre las 16 y las 16:30 hay mas aire del que pide.
  const ocupados = [[m.msDeHoraLocal('2026-12-03', '14:00'), m.msDeHoraLocal('2026-12-03', '16:00')]];
  assert.deepEqual(horasDe(elJueves({ tipo: 'una-hora', ocupados }).slots), ['16:30']);
  assert.deepEqual(horasDe(elJueves({ tipo: 'dos-horas', ocupados }).slots), []);
});

test('la consulta del medio, de 15:15 a 17:15, no deja nada mas ese dia', () => {
  const ocupados = [[m.msDeHoraLocal('2026-12-03', '15:15'), m.msDeHoraLocal('2026-12-03', '17:15')]];
  assert.deepEqual(horasDe(elJueves({ tipo: 'una-hora', ocupados }).slots), ['14:00']);
  assert.deepEqual(horasDe(elJueves({ tipo: 'dos-horas', ocupados }).slots), []);
});

test('sin cadencia compartida, la consulta se ofrecia cada media hora', () => {
  // El comportamiento viejo, que sigue siendo el de la agenda de consultas
  // hasta que se le ponga cadenciaMin. Esta aca para que la diferencia
  // quede escrita y no se descubra de casualidad.
  const sinCadencia = { ...JUEVES, cadenciaMin: null };
  assert.deepEqual(
    horasDe(m.horariosDe({ config: sinCadencia, tipo: 'dos-horas', desde: '2026-12-03', hasta: '2026-12-03', ahora: AHORA }).slots),
    ['14:00', '14:30', '15:00', '15:30', '16:00']
  );
});

test('la sesion de una hora no puede partir el bloque que Seba guardo', () => {
  // La regla "pero no al reves", con el bloqueo por tipo: el jueves de 14 a
  // 16 queda reservado para una consulta, y ninguna sesion de una hora
  // puede meterse ahi adentro.
  const bloqueos = [{
    desde: '2026-12-03', hasta: '2026-12-03',
    desdeHora: '14:00', hastaHora: '16:00',
    tipos: ['una-hora'], motivo: 'Guardado para una consulta',
  }];
  assert.deepEqual(horasDe(elJueves({ tipo: 'una-hora', bloqueos }).slots), ['16:30']);
  assert.deepEqual(horasDe(elJueves({ tipo: 'dos-horas', bloqueos }).slots), ['14:00', '15:15']);
});

// -------------------------------------------------------
// Bloqueos por tipo: la regla que mas importa
// -------------------------------------------------------

test('un bloqueo de 10 a 12 solo para una hora deja el bloque entero para la consulta', () => {
  const bloqueos = [{
    desde: '2026-12-01', hasta: '2026-12-01',
    desdeHora: '10:00', hastaHora: '12:00',
    tipos: ['una-hora'], motivo: 'Guardado para consultas',
  }];

  // Para la sesion de una hora: los dos arranques que caen adentro del
  // bloqueo desaparecen, y el primero que sobrevive es el de las 12:30.
  const sesion = horarios({ tipo: 'una-hora', bloqueos });
  assert.deepEqual(horasDe(sesion.slots), ['12:30', '13:45', '15:00', '16:15']);

  // Y no desaparecen en silencio: se devuelven para pintarlos en gris.
  assert.equal(sesion.bloqueados.length, 1);
  assert.equal(sesion.bloqueados[0].motivo, 'Guardado para consultas');
  assert.equal(sesion.bloqueados[0].diaEntero, false);

  // Para la consulta de dos horas, el bloque sigue entero y sin avisos.
  const consulta = horarios({ tipo: 'dos-horas', bloqueos });
  assert.ok(horasDe(consulta.slots).includes('10:00'));
  assert.deepEqual(consulta.bloqueados, []);
});

test('un bloqueo sin horas ni tipos es el dia entero para todos', () => {
  // Es lo que significan los bloqueos que ya estaban guardados: no hay nada
  // que migrar.
  const bloqueos = [{ desde: '2026-12-01', hasta: '2026-12-01' }];
  assert.deepEqual(horarios({ tipo: 'dos-horas', bloqueos }).slots, []);
  assert.deepEqual(horarios({ tipo: 'una-hora', bloqueos }).slots, []);
  assert.equal(horarios({ tipo: 'una-hora', bloqueos }).bloqueados[0].diaEntero, true);
});

test('un bloqueo con horas al reves se trata como dia entero', () => {
  // Ante un dato dudoso, de mas se bloquea y nunca de menos.
  const bloqueos = [{
    desde: '2026-12-01', hasta: '2026-12-01', desdeHora: '15:00', hastaHora: '09:00',
  }];
  assert.deepEqual(horarios({ tipo: 'dos-horas', bloqueos }).slots, []);
});

test('un bloqueo que termina a las 12 no molesta a lo que arranca despues', () => {
  // Sin buffer contra los bloqueos: un bloqueo es un "no aca", no un "no
  // cerca". El arranque de las 12:30 queda intacto.
  const bloqueos = [{
    desde: '2026-12-01', hasta: '2026-12-01', desdeHora: '10:00', hastaHora: '12:00',
  }];
  assert.deepEqual(horasDe(horarios({ tipo: 'dos-horas', bloqueos }).slots),
    ['12:30', '13:45', '15:00']);
});

// -------------------------------------------------------
// Horarios excepcionales
// -------------------------------------------------------

const EXCEPCIONAL_FECHA = {
  fecha: '2026-12-02', desde: '09:00', hasta: '11:00', motivo: 'Miercoles suelto',
};
const EXCEPCIONAL_REPITE = {
  repite: true, diaSemana: 3, desde: '09:00', hasta: '11:00', motivo: 'Miercoles a la manana',
};

function elMiercoles(extra) {
  // El miercoles 2 no tiene franja regular: lo unico que puede aparecer es
  // lo excepcional.
  return m.horariosDe({
    config: CONFIG, desde: '2026-12-02', hasta: '2026-12-02', ahora: AHORA, ...extra,
  });
}

test('un excepcional con fecha se ofrece a la consulta, aparte de los regulares', () => {
  const r = elMiercoles({ tipo: 'dos-horas', excepcionales: [EXCEPCIONAL_FECHA] });
  assert.deepEqual(r.slots, []);
  assert.deepEqual(horasDe(r.excepcionales), ['09:00']);
});

test('un excepcional recurrente cae todos los miercoles y respeta sus fechas', () => {
  const r = elMiercoles({ tipo: 'dos-horas', excepcionales: [EXCEPCIONAL_REPITE] });
  assert.deepEqual(horasDe(r.excepcionales), ['09:00']);

  const vencido = elMiercoles({
    tipo: 'dos-horas',
    excepcionales: [{ ...EXCEPCIONAL_REPITE, hastaFecha: '2026-11-30' }],
  });
  assert.deepEqual(vencido.excepcionales, []);
});

test('ningun excepcional se ofrece para una sesion de una hora', () => {
  // Ni el que tiene fecha ni el recurrente: los excepcionales son para las
  // consultas de dos horas.
  for (const e of [EXCEPCIONAL_FECHA, EXCEPCIONAL_REPITE]) {
    const r = elMiercoles({ tipo: 'una-hora', excepcionales: [e] });
    assert.deepEqual(r.slots, []);
    assert.deepEqual(r.excepcionales, []);
  }
});

test('un excepcional se puede abrir a mano para una sesion', () => {
  // La puerta queda, pero hay que pedirla: tipos explicito.
  const r = elMiercoles({
    tipo: 'una-hora',
    excepcionales: [{ ...EXCEPCIONAL_FECHA, tipos: ['una-hora'] }],
  });
  // Uno solo: el tramo es de 09:00 a 11:00 y el arranque siguiente de la
  // cadencia, 10:15, terminaria 11:15.
  assert.deepEqual(horasDe(r.excepcionales), ['09:00']);
});

test('un dia bloqueado tambien se lleva los excepcionales', () => {
  const r = elMiercoles({
    tipo: 'dos-horas',
    excepcionales: [EXCEPCIONAL_FECHA],
    bloqueos: [{ desde: '2026-12-02', hasta: '2026-12-02' }],
  });
  assert.deepEqual(r.excepcionales, []);
});

test('un excepcional que tambien es regular no se cuenta dos veces', () => {
  const r = m.horariosDe({
    config: CONFIG, tipo: 'dos-horas', desde: '2026-12-01', hasta: '2026-12-01', ahora: AHORA,
    excepcionales: [{ fecha: '2026-12-01', desde: '10:00', hasta: '12:00' }],
  });
  assert.ok(horasDe(r.slots).includes('10:00'));
  assert.deepEqual(r.excepcionales, []);
});

// -------------------------------------------------------
// Las dos ventanas
// -------------------------------------------------------

test('la ventana del publico es mas corta que la de las quincenales', () => {
  const dentro = { config: { ...CONFIG, ventanaDias: 21 }, tipo: 'una-hora', ahora: AHORA };
  const lejos = { desde: '2026-12-29', hasta: '2026-12-29' }; // 39 dias despues

  // El publico no llega: esta fuera de los 21 dias.
  assert.deepEqual(m.horariosDe({ ...dentro, ...lejos }).slots, []);
  // La materializacion de las series si, porque mira con su propio tope.
  assert.ok(m.horariosDe({ ...dentro, ...lejos, topeDias: 60 }).slots.length > 0);
});

test('la anticipacion minima tapa los horarios de hoy y manana', () => {
  // Con `ahora` el lunes 30 a las 9, una consulta de 48 horas no puede
  // tomar el martes 1 a las 10 (son 25 horas) pero si el jueves 3.
  const ahora = m.msDeHoraLocal('2026-11-30', '09:00');
  const martes = m.horariosDe({ config: CONFIG, tipo: 'dos-horas', desde: '2026-12-01', hasta: '2026-12-01', ahora });
  const jueves = m.horariosDe({ config: CONFIG, tipo: 'dos-horas', desde: '2026-12-03', hasta: '2026-12-03', ahora });
  assert.deepEqual(martes.slots, []);
  assert.ok(jueves.slots.length > 0);
});

// -------------------------------------------------------
// La periodicidad quincenal
// -------------------------------------------------------

test('las fechas quincenales son las del ejemplo del pedido', () => {
  // Jueves 26 de noviembre a las 16, y de ahi cada 14 dias.
  const fechas = m.proyectarQuincenal('2026-11-26', '16:00', '2026-12-31');
  assert.deepEqual(fechas.map(m.diaLocal), ['2026-11-26', '2026-12-10', '2026-12-24']);
  assert.deepEqual(fechas.map(m.horaLocal), ['16:00', '16:00', '16:00']);
});

test('cada 15 dias es cada 14: el encuentro no se corre de dia de la semana', () => {
  const fechas = m.proyectarQuincenal('2026-11-26', '16:00', '2027-02-01');
  const dias = new Set(fechas.map(f => m.diaDeSemana(m.diaLocal(f))));
  assert.deepEqual([...dias], [4], 'todos jueves');
});

test('la serie se proyecta desde su ancla, aunque el ancla sea vieja', () => {
  const serie = { ancla: '2026-01-08', hora: '16:00' }; // un jueves de enero
  const fechas = m.fechasDeSerie(serie, '2026-11-20', '2026-12-31');
  assert.deepEqual(fechas.map(m.diaLocal), ['2026-11-26', '2026-12-10', '2026-12-24']);
});

test('una serie sin ancla u hora no proyecta nada', () => {
  assert.deepEqual(m.fechasDeSerie({ hora: '16:00' }, '2026-11-20', '2026-12-31'), []);
  assert.deepEqual(m.fechasDeSerie(null, '2026-11-20', '2026-12-31'), []);
});

// -------------------------------------------------------
// La regla de las 12 horas
// -------------------------------------------------------

test('la regla de 12 horas, justo arriba y justo abajo del limite', () => {
  const t = m.tipoDe(CONFIG, 'una-hora');
  assert.equal(t.anticipacionCambioHoras, 12);
  const turno = m.msDeHoraLocal('2026-12-01', '16:00');
  const doce = 12 * 3600000;
  assert.equal(m.puedeCambiar(turno, t, turno - doce - 60000), true);
  assert.equal(m.puedeCambiar(turno, t, turno - doce), true);
  assert.equal(m.puedeCambiar(turno, t, turno - doce + 60000), false);
  // Un turno que ya paso no se mueve.
  assert.equal(m.puedeCambiar(turno, t, turno + 60000), false);
});

// -------------------------------------------------------
// Que la agenda de hoy no cambio de comportamiento
//
// Esta es la prueba que sostiene la unica afirmacion importante de la
// migracion: el motor nuevo, llamado sin tipo, tiene que dar exactamente los
// mismos horarios que daba el generarSlots que vivia en index.js.
//
// Abajo esta esa funcion, copiada tal como estaba el 20/11/2026, con un solo
// cambio: el reloj entra por parametro en lugar de salir de Date.now(), para
// que las dos implementaciones midan contra el mismo instante. Es codigo
// muerto a proposito: esta aca para discutirle al motor, no para usarse.
// -------------------------------------------------------
function generarSlotsViejo(config, desdeISO, hastaISO, bloqueos, ocupados, ahora) {
  const duracionMs = config.duracionMin * 60000;
  const bufferMs = (config.bufferMin || 0) * 60000;
  const paso = (config.granularidadMin || 30) * 60000;
  const minimoMs = ahora + (config.anticipacionHoras || 0) * 3600000;
  const topeMs = ahora + (config.ventanaDias || 60) * 86400000;

  const diaBloqueado = (f, bs) => bs.some(b => f >= b.desde && f <= b.hasta);

  const slots = [];
  for (let dia = desdeISO; dia <= hastaISO; dia = m.sumarDias(dia, 1)) {
    if (diaBloqueado(dia, bloqueos)) continue;
    const franjas = config.semana[String(m.diaDeSemana(dia))] || [];
    for (const franja of franjas) {
      const desdeMin = m.minutosDeHora(franja.desde);
      const hastaMin = m.minutosDeHora(franja.hasta);
      if (desdeMin === null || hastaMin === null || hastaMin <= desdeMin) continue;
      const base = m.msDeHoraLocal(dia, '00:00');
      const finFranja = base + hastaMin * 60000;
      for (let inicio = base + desdeMin * 60000; inicio + duracionMs <= finFranja; inicio += paso) {
        if (inicio < minimoMs || inicio > topeMs) continue;
        if (m.chocaCon(inicio, inicio + duracionMs, ocupados, bufferMs)) continue;
        slots.push(m.isoLocal(inicio));
      }
    }
  }
  return slots;
}

// Un azar reproducible: la prueba tiene que fallar siempre o no fallar nunca,
// no una vez cada veinte corridas.
function azar(semilla) {
  let x = semilla;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

test('sin tipo, el motor nuevo da los mismos horarios que el generarSlots viejo', () => {
  const dado = azar(20261120);
  const ahora = m.msDeHoraLocal('2026-11-20', '09:00');

  for (let vuelta = 0; vuelta < 200; vuelta++) {
    // Una semana cualquiera, con hasta dos franjas por dia.
    const semana = {};
    for (let d = 0; d <= 6; d++) {
      if (dado() < 0.3) continue;
      const desde = 7 + Math.floor(dado() * 8);
      const largo = 2 + Math.floor(dado() * 7);
      semana[String(d)] = [{
        desde: `${String(desde).padStart(2, '0')}:00`,
        hasta: `${String(Math.min(23, desde + largo)).padStart(2, '0')}:30`,
      }];
    }

    const config = {
      duracionMin: [60, 90, 120, 150][Math.floor(dado() * 4)],
      bufferMin: [0, 10, 15, 30][Math.floor(dado() * 4)],
      granularidadMin: [15, 30, 60][Math.floor(dado() * 3)],
      anticipacionHoras: [0, 24, 48, 72][Math.floor(dado() * 4)],
      ventanaDias: [21, 45, 60][Math.floor(dado() * 3)],
      semana,
    };

    // Bloqueos a la vieja usanza: dias enteros, sin horas y sin tipos.
    const bloqueos = [];
    for (let i = 0; i < Math.floor(dado() * 3); i++) {
      const desde = m.sumarDias('2026-11-20', Math.floor(dado() * 50));
      bloqueos.push({ desde, hasta: m.sumarDias(desde, Math.floor(dado() * 4)) });
    }

    // Y ocupacion suelta, como la que llega de Calendar.
    const ocupados = [];
    for (let i = 0; i < Math.floor(dado() * 6); i++) {
      const dia = m.sumarDias('2026-11-20', Math.floor(dado() * 50));
      const hora = 8 + Math.floor(dado() * 12);
      const inicio = m.msDeHoraLocal(dia, `${String(hora).padStart(2, '0')}:00`);
      ocupados.push([inicio, inicio + (30 + Math.floor(dado() * 150)) * 60000]);
    }

    const desde = '2026-11-20';
    const hasta = '2027-01-10';
    const viejo = generarSlotsViejo(config, desde, hasta, bloqueos, ocupados, ahora);
    const nuevo = m.horariosDe({ config, desde, hasta, bloqueos, ocupados, ahora }).slots;

    assert.deepEqual(nuevo, viejo, `vuelta ${vuelta}: ${JSON.stringify(config)}`);
  }
});

// -------------------------------------------------------
// Las fechas, que son la base de todo lo anterior
// -------------------------------------------------------

test('el dia y la hora locales no se corren con el offset fijo', () => {
  const ms = m.msDeHoraLocal('2026-12-01', '23:30');
  assert.equal(m.diaLocal(ms), '2026-12-01');
  assert.equal(m.horaLocal(ms), '23:30');
  assert.equal(m.isoLocal(ms), '2026-12-01T23:30:00-03:00');
  assert.equal(m.idDeTurno(ms), '2026-12-01T23-30');
});

test('el dia de la semana y la suma de dias cruzan fin de mes y de ano', () => {
  assert.equal(m.diaDeSemana('2026-12-01'), 2, 'martes');
  assert.equal(m.sumarDias('2026-12-31', 1), '2027-01-01');
  assert.equal(m.sumarDias('2026-03-01', -1), '2026-02-28');
});

test('minutosDeHora rechaza lo que no es una hora', () => {
  assert.equal(m.minutosDeHora('10:30'), 630);
  assert.equal(m.minutosDeHora('24:00'), null);
  assert.equal(m.minutosDeHora('10:60'), null);
  assert.equal(m.minutosDeHora(''), null);
  assert.equal(m.minutosDeHora(undefined), null);
});
