// La grilla de mes de la agenda.
//
// Es la misma que tiene /consultas/agenda/ desde que existe: un mes por
// pantalla, los dias con horarios libres en claro y tocables, el resto
// apagados, y flechas que saltan solo entre los meses que tienen algo.
//
// Vive aparte porque la usan dos paginas. Hoy la usa /consultas/mi-agenda/;
// /consultas/agenda/ todavia tiene su copia y la va a adoptar cuando esa
// pagina se toque. Mientras tanto, lo que se arregle aca hay que mirarlo
// tambien alla.
//
// No sabe nada de turnos, de tipos ni del servidor: recibe una lista de
// horarios en ISO con su offset (…-03:00) y avisa que dia se eligio. La zona
// en la que se leen esos horarios la pone quien la usa, porque la pagina
// muestra la hora de quien mira y no la de Seba.

const DIAS_CORTOS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

export function calendarioMes({ grilla, titulo, botonAntes, botonDespues, zona, alElegirDia, vacio }) {
  let porDia = new Map();
  let meses = [];
  let mesVisible = null;
  let diaElegido = null;

  // 'YYYY-MM-DD' del dia al que pertenece ese instante en la zona de quien
  // mira. en-CA da justo ese formato.
  const claveDia = iso => new Intl.DateTimeFormat('en-CA', {
    timeZone: zona(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));

  const nombreDeMes = clave => {
    const [a, m] = clave.split('-');
    return new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(+a, +m - 1, 15)));
  };

  function agrupar(horarios) {
    porDia = new Map();
    for (const iso of horarios) {
      const dia = claveDia(iso);
      if (!porDia.has(dia)) porDia.set(dia, []);
      porDia.get(dia).push(iso);
    }
    // Solo los meses que tienen algo: no tiene sentido que las flechas pasen
    // por meses enteros vacios.
    meses = [...new Set([...porDia.keys()].map(d => d.slice(0, 7)))].sort();
    if (!meses.length) mesVisible = null;
    else if (!mesVisible || !meses.includes(mesVisible)) mesVisible = meses[0];
    // Un dia que ya no tiene horarios deja de estar elegido: si no, abajo
    // queda una lista de horas que ya no existen.
    if (diaElegido && !porDia.has(diaElegido)) diaElegido = null;
  }

  function pintar() {
    grilla.innerHTML = '';

    if (!mesVisible) {
      titulo.textContent = '';
      botonAntes.disabled = true;
      botonDespues.disabled = true;
      const p = document.createElement('p');
      p.style.cssText = 'grid-column:1/-1; color:#8f8d88; line-height:1.7;';
      p.textContent = vacio || 'No hay horarios libres en los próximos días.';
      grilla.appendChild(p);
      return;
    }

    titulo.textContent = nombreDeMes(mesVisible);
    const i = meses.indexOf(mesVisible);
    botonAntes.disabled = i <= 0;
    botonDespues.disabled = i >= meses.length - 1;

    for (const n of DIAS_CORTOS) {
      const c = document.createElement('div');
      c.className = 'ag-dia-nombre';
      c.textContent = n;
      grilla.appendChild(c);
    }

    const [anio, mes] = mesVisible.split('-').map(Number);
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
      const clave = `${mesVisible}-${String(d).padStart(2, '0')}`;
      const libres = porDia.get(clave);
      const celda = document.createElement(libres ? 'button' : 'div');
      celda.className = 'ag-dia' + (libres ? ' libre' : '') + (clave === diaElegido ? ' elegido' : '');
      celda.textContent = String(d);
      if (libres) {
        celda.type = 'button';
        celda.setAttribute('aria-label', `${d}: ${libres.length} horario${libres.length > 1 ? 's' : ''}`);
        celda.addEventListener('click', () => {
          diaElegido = clave;
          pintar();
          alElegirDia(clave, libres);
        });
      }
      grilla.appendChild(celda);
    }
  }

  botonAntes.addEventListener('click', () => {
    const i = meses.indexOf(mesVisible);
    if (i > 0) { mesVisible = meses[i - 1]; pintar(); }
  });
  botonDespues.addEventListener('click', () => {
    const i = meses.indexOf(mesVisible);
    if (i >= 0 && i < meses.length - 1) { mesVisible = meses[i + 1]; pintar(); }
  });

  return {
    // Los horarios cambiaron (se cargaron, o alguien tomo uno).
    mostrar(horarios) {
      agrupar(horarios);
      pintar();
      return diaElegido;
    },
    // Volver a dibujar sin tocar los horarios, para reflejar una eleccion.
    repintar: pintar,
    diaElegido: () => diaElegido,
    horariosDelDia: () => (diaElegido ? porDia.get(diaElegido) || [] : []),
    soltarDia() { diaElegido = null; pintar(); },
  };
}
