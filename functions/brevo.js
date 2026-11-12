// Cliente minimo de la API de Brevo (el mailing: listas, contactos y
// campanas). Sin el SDK oficial a proposito: index.js se carga entero en
// cada instancia nueva y ya pesa bastante (mercadopago, puppeteer,
// googleapis, nodemailer), asi que sumar otro cliente HTTP seria pagar
// arranque en frio en crearPago y en buscarLugar para nada. Son unos pocos
// endpoints JSON con un header, y fetch ya viene en Node 22 (lo mismo que
// hace verificarTurnstile).
//
// Regla de oro de todo este archivo: un problema de Brevo NUNCA tiene que
// romper una compra ni una inscripcion. Por eso casi todas las altas se
// encolan en Firestore y las procesa un trigger aparte; el unico lugar que
// llama en linea es el endpoint de suscripcion, donde Brevo ES el flujo.

// El logger de las functions si estamos dentro de ellas, y la consola si
// este archivo se copio a una herramienta local.
let logger = console;
try { logger = require('firebase-functions').logger; } catch (_) { /* script local */ }

const BASE = 'https://api.brevo.com/v3';
const TIMEOUT_MS = 8000;

// Nombre corto de cada lista -> variable de entorno con su id. Los ids los
// da Brevo al crear las listas, asi que no van hardcodeados: cambian si
// alguna vez se rehace la cuenta.
const LISTAS_ENV = {
  suscriptores: 'BREVO_LISTA_SUSCRIPTORES',
  alumnos:      'BREVO_LISTA_ALUMNOS',
  consultas:    'BREVO_LISTA_CONSULTAS',
  interesados:  'BREVO_LISTA_INTERESADOS',
  libro:        'BREVO_LISTA_LIBRO',
};

const LISTAS = Object.keys(LISTAS_ENV);

// Los atributos de contacto, con su tipo en Brevo. Brevo no tiene arrays:
// lo que es multiple (los cursos) va como texto separado por comas, y la
// segmentacion de verdad se hace por pertenencia a lista.
const ATRIBUTOS = {
  NOMBRE:          'text',
  ORIGEN:          'text',
  UTM:             'text',
  FECHA_ALTA:      'date',
  CONSENTIMIENTO:  'text',
  CURSOS:          'text',
  PRODUCTO_ULTIMO: 'text',
  ULTIMA_COMPRA:   'date',
  TOTAL_COMPRAS:   'float',
  TELEFONO_TXT:    'text',
};

class BrevoError extends Error {
  constructor(mensaje, { status, code, cuerpo } = {}) {
    super(mensaje);
    this.name = 'BrevoError';
    this.status = status;
    this.code = code;
    this.cuerpo = cuerpo;
  }
}

function brevoConfigurado() {
  return !!process.env.BREVO_API_KEY;
}

// Para no llenar los logs: el aviso de que falta la llave se escribe una
// sola vez por instancia.
let avisoDado = false;
function avisarSinLlave(ruta) {
  if (!avisoDado) {
    logger.warn('BREVO_API_KEY no configurado: el mailing queda sin hacer.', { ruta });
    avisoDado = true;
  }
  return null;
}

// Nombres de lista -> ids numericos. Avisa (y saltea) la lista cuya
// variable de entorno falte, en vez de mandar un listIds con undefined
// adentro, que Brevo rechaza entero.
function idsDeListas(nombres) {
  const ids = [];
  for (const nombre of [].concat(nombres || [])) {
    const env = LISTAS_ENV[nombre];
    const valor = env && process.env[env];
    if (!valor) {
      logger.warn('Lista de Brevo sin id configurado, se saltea.', { lista: nombre, env });
      continue;
    }
    ids.push(Number(valor));
  }
  return ids;
}

// Saca los valores vacios de los atributos. Importante: mandar un atributo
// en blanco lo BORRA en Brevo, asi que un alta que no conoce el nombre no
// tiene que pisar el nombre que ya habia.
function atributosLimpios(attrs) {
  const salida = {};
  for (const [clave, valor] of Object.entries(attrs || {})) {
    if (valor === undefined || valor === null || valor === '') continue;
    salida[clave] = valor;
  }
  return salida;
}

// Las fechas de Brevo son aaaa-mm-dd.
function fechaBrevo(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha || Date.now());
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

// El nucleo. opciones.reintentos es cuantos reintentos (no intentos) se
// permiten, y opciones.soloRateLimit limita el reintento al 429: lo usan
// los pedidos que mandan un mail, para que un 500 ambiguo no termine en dos
// mails al mismo destinatario.
async function pedirBrevo(metodo, ruta, cuerpo, opciones = {}) {
  const { reintentos = 2, soloRateLimit = false } = opciones;
  const llave = process.env.BREVO_API_KEY;
  if (!llave) return avisarSinLlave(ruta);

  let ultimoError = null;

  for (let intento = 0; intento <= reintentos; intento++) {
    if (intento > 0) {
      // Espera creciente con un poco de ruido, para no reintentar todas las
      // instancias al mismo milisegundo.
      await esperar(400 * Math.pow(2, intento - 1) + Math.floor(Math.random() * 200));
    }

    let resp;
    try {
      resp = await fetch(`${BASE}${ruta}`, {
        method: metodo,
        headers: {
          'api-key': llave,
          'accept': 'application/json',
          ...(cuerpo ? { 'content-type': 'application/json' } : {}),
        },
        ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // Timeout o problema de red: reintentable, salvo en los pedidos que
      // mandan mail (no sabemos si llego o no).
      ultimoError = new BrevoError(`Brevo no responde: ${e.message}`, { code: 'red' });
      if (soloRateLimit) throw ultimoError;
      continue;
    }

    if (resp.status === 204) return {};

    let datos = null;
    const texto = await resp.text();
    if (texto) {
      try { datos = JSON.parse(texto); } catch (_) { datos = { raw: texto.slice(0, 500) }; }
    }

    if (resp.ok) return datos || {};

    const code = datos && datos.code;

    // El contacto ya existe: para nosotros es exito, no error (siempre
    // mandamos updateEnabled).
    if (code === 'duplicate_parameter') return datos || {};

    ultimoError = new BrevoError(
      `Brevo ${resp.status} en ${ruta}: ${(datos && datos.message) || resp.statusText}`,
      { status: resp.status, code, cuerpo: datos }
    );

    const reintentable = resp.status === 429 || (!soloRateLimit && resp.status >= 500);
    if (!reintentable) throw ultimoError;
  }

  throw ultimoError;
}

// --- Contactos -----------------------------------------------------------

// Crea o actualiza un contacto. Es idempotente: se puede llamar mil veces
// con el mismo mail.
async function upsertContacto({ email, nombre, listas, atributos, quitarDeListas } = {}) {
  if (!email) return null;
  if (!brevoConfigurado()) return avisarSinLlave('/contacts');

  const mail = String(email).trim().toLowerCase();
  const attrs = atributosLimpios({ NOMBRE: nombre, ...(atributos || {}) });
  const ids = idsDeListas(listas);

  const resultado = await pedirBrevo('POST', '/contacts', {
    email: mail,
    attributes: attrs,
    ...(ids.length ? { listIds: ids } : {}),
    updateEnabled: true,
  });

  // Sacarlo de una lista es otro pedido (el POST de arriba solo suma).
  const idsQuitar = idsDeListas(quitarDeListas);
  if (idsQuitar.length) {
    await pedirBrevo('PUT', `/contacts/${encodeURIComponent(mail)}`, { unlinkListIds: idsQuitar });
  }

  return resultado;
}

// Devuelve el contacto o null si no existe. El 404 es el caso normal, no un
// error.
async function obtenerContacto(email) {
  if (!email) return null;
  if (!brevoConfigurado()) return avisarSinLlave('/contacts/{email}');
  try {
    return await pedirBrevo('GET', `/contacts/${encodeURIComponent(String(email).trim().toLowerCase())}`);
  } catch (e) {
    if (e instanceof BrevoError && e.status === 404) return null;
    throw e;
  }
}

// Alta con doble opt-in: Brevo guarda el contacto sin confirmar y lo mete en
// la lista recien cuando la persona hace clic en el mail. Necesita una
// plantilla marcada como "double opt-in" en el panel (con el tag
// {{ doubleoptin }}); sin BREVO_DOI_TEMPLATE_ID no hay forma de mandarlo.
//
// soloRateLimit: este pedido manda un mail, asi que no se reintenta ante un
// 500 ni ante un timeout. Quien llama tiene su propio plan B.
async function pedirDobleOptin({ email, nombre, atributos, listas, redirectUrl } = {}) {
  if (!email) return null;
  if (!brevoConfigurado()) return avisarSinLlave('/contacts/doubleOptinConfirmation');

  const templateId = Number(process.env.BREVO_DOI_TEMPLATE_ID);
  if (!templateId) {
    throw new BrevoError('BREVO_DOI_TEMPLATE_ID no configurado: no se puede mandar el doble opt-in.', { code: 'sin_plantilla' });
  }

  const ids = idsDeListas(listas && listas.length ? listas : ['suscriptores']);
  if (!ids.length) {
    throw new BrevoError('Ninguna lista valida para el doble opt-in.', { code: 'sin_lista' });
  }

  return pedirBrevo('POST', '/contacts/doubleOptinConfirmation', {
    email: String(email).trim().toLowerCase(),
    attributes: atributosLimpios({ NOMBRE: nombre, ...(atributos || {}) }),
    includeListIds: ids,
    templateId,
    redirectionUrl: redirectUrl,
  }, { reintentos: 1, soloRateLimit: true });
}

async function quitarDeLista(email, listas) {
  const ids = idsDeListas(listas);
  if (!email || !ids.length) return null;
  if (!brevoConfigurado()) return avisarSinLlave('/contacts/{email}');
  try {
    return await pedirBrevo('PUT', `/contacts/${encodeURIComponent(String(email).trim().toLowerCase())}`, { unlinkListIds: ids });
  } catch (e) {
    // Si el contacto no esta, ya esta fuera de la lista: nada que hacer.
    if (e instanceof BrevoError && e.status === 404) return null;
    throw e;
  }
}

// --- Importacion (la usa la herramienta local de migracion) --------------

// emptyContactsAttributes en false es clave: asi un CSV que no trae la
// columna NOMBRE no borra los nombres que ya estaban cargados.
async function importarContactos({ csv, listas, actualizar = true } = {}) {
  return pedirBrevo('POST', '/contacts/import', {
    fileBody: csv,
    listIds: idsDeListas(listas),
    updateExistingContacts: actualizar,
    emptyContactsAttributes: false,
  });
}

// La importacion es asincronica: devuelve un processId que se consulta aca
// hasta que pasa a "completed".
async function estadoProceso(id) {
  return pedirBrevo('GET', `/processes/${encodeURIComponent(id)}`);
}

// --- Campanas ------------------------------------------------------------

// Crea la campana como BORRADOR, a proposito: sin scheduledAt Brevo la deja
// sin enviar. No hay en todo este archivo una forma de disparar una campana
// de verdad, y es la garantia de que siempre la revisa una persona antes.
async function crearCampaniaBorrador({ nombre, asunto, html, listas, previo } = {}) {
  return pedirBrevo('POST', '/emailCampaigns', {
    name: nombre,
    subject: asunto,
    previewText: previo || '',
    sender: {
      name: process.env.BREVO_REMITENTE_NOMBRE || 'Seba Bru Astrología',
      email: process.env.BREVO_REMITENTE_EMAIL || 'info@sebabru.com',
    },
    type: 'classic',
    htmlContent: html,
    recipients: { listIds: idsDeListas(listas) },
    inlineImageActivation: false,
  });
}

async function enviarPruebaCampania(campaniaId, emails) {
  return pedirBrevo('POST', `/emailCampaigns/${Number(campaniaId)}/sendTest`, {
    emailTo: [].concat(emails),
  });
}

// --- Estructura de la cuenta (la usa crear-estructura.js) ----------------

async function listarListas() {
  return pedirBrevo('GET', '/contacts/lists?limit=50');
}

async function crearLista(nombre, carpetaId) {
  return pedirBrevo('POST', '/contacts/lists', { name: nombre, folderId: Number(carpetaId) });
}

async function listarAtributos() {
  return pedirBrevo('GET', '/contacts/attributes');
}

async function crearAtributo(nombre, tipo) {
  return pedirBrevo('POST', `/contacts/attributes/normal/${encodeURIComponent(nombre)}`, { type: tipo });
}

async function listarCarpetas() {
  return pedirBrevo('GET', '/contacts/folders?limit=50&offset=0');
}

async function crearCarpeta(nombre) {
  return pedirBrevo('POST', '/contacts/folders', { name: nombre });
}

module.exports = {
  BrevoError,
  LISTAS,
  LISTAS_ENV,
  ATRIBUTOS,
  brevoConfigurado,
  pedirBrevo,
  idsDeListas,
  atributosLimpios,
  fechaBrevo,
  upsertContacto,
  obtenerContacto,
  pedirDobleOptin,
  quitarDeLista,
  importarContactos,
  estadoProceso,
  crearCampaniaBorrador,
  enviarPruebaCampania,
  listarListas,
  crearLista,
  listarAtributos,
  crearAtributo,
  listarCarpetas,
  crearCarpeta,
};
