// Cola de mails salientes.
//
// El problema que resuelve: los formularios tardaban unos quince segundos en
// contestar, y el pedazo mas grande de esa espera era un sendMail por SMTP
// de Gmail -- conexion TCP nueva, STARTTLS, AUTH LOGIN, DATA, QUIT -- hecho
// en linea, como ultimo await antes del res.send(). Son dos a seis segundos
// en los que la persona mira "Enviando..." para que a Seba le llegue un
// aviso interno que ella no va a leer nunca.
//
// Asi que el mail no se manda: se encola. encolarMail() escribe un documento
// en Firestore (unos 150 ms) y el trigger enviarMailEncolado lo manda despues,
// cuando ya nadie espera. Es el mismo patron que brevo_contactos ->
// sincronizarContactoBrevo y envios_carta -> enviarCartaInscripcion, por la
// misma razon de fondo: en un onRequest la instancia se congela despues del
// res.send(), asi que lo que no se encola, se espera.
//
// Dos reglas de este archivo:
//
//   1. encolarMail() NUNCA tira. Un problema con el mail no puede romper una
//      compra ni una inscripcion. Si la cola falla, se loguea como error y la
//      operacion sigue.
//   2. El trigger se declara con retry: true, asi un rato malo de Gmail no
//      pierde el aviso. Por eso hay que cuidar que no mande dos veces: ver
//      la marca "enviado" mas abajo.
//
// Lo que NO va por aca: el mail de bienvenida de la suscripcion y las
// campanas, que son de Brevo (ver brevo.js y CLAUDE.md). Esto es el
// nodemailer/Gmail de los transaccionales, nada mas.

// El logger de las functions si estamos dentro de ellas, y la consola si
// este archivo se copio a una herramienta local (igual que brevo.js).
let logger = console;
try { logger = require('firebase-functions').logger; } catch (_) { /* script local */ }

const COLECCION = 'mails_salientes';

// Tope de un documento de Firestore: 1 MiB. Dejamos un margen holgado para
// el resto de los campos. Hoy el unico adjunto que pasa por aca es el .ics
// de un turno, que son dos kilobytes; la carta natal en PDF va por su propio
// camino (envios_carta), que es el que tiene la memoria para armarla.
const MAX_ADJUNTO = 700 * 1024;

let _transporter = null;

// Un solo transporter para toda la instancia, con pool: antes se creaba uno
// nuevo en cada sendMail (habia seis createTransport repartidos por
// index.js), asi que cada mail abria su propia conexion SMTP y pagaba el
// handshake completo. Con el pool, los mails que caen en la misma instancia
// reusan la conexion.
function transporteMail() {
  if (_transporter) return _transporter;
  // Perezoso a proposito: nodemailer solo se carga en la instancia que
  // realmente manda un mail, no en la que atiende buscarLugar.
  const nodemailer = require('nodemailer');
  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
  });
  return _transporter;
}

// Los adjuntos viajan en el documento, asi que el Buffer se guarda en base64
// y se reconstruye al mandar.
function adjuntosParaGuardar(adjuntos, motivo) {
  if (!Array.isArray(adjuntos) || !adjuntos.length) return [];
  const guardables = [];
  for (const adj of adjuntos) {
    if (!adj || !adj.content) continue;
    const contenido = Buffer.isBuffer(adj.content)
      ? adj.content.toString('base64')
      : Buffer.from(String(adj.content)).toString('base64');
    if (contenido.length > MAX_ADJUNTO) {
      // Se avisa fuerte y el mail sale sin el adjunto: mejor el aviso sin
      // archivo que ningun aviso, y en el log queda que falto.
      logger.error('Adjunto demasiado grande para la cola de mails: va sin el.', {
        motivo, archivo: adj.filename, bytes: contenido.length,
      });
      continue;
    }
    guardables.push({
      filename: adj.filename || 'adjunto',
      contenido,
      tipo: adj.contentType || 'application/octet-stream',
    });
  }
  return guardables;
}

function adjuntosParaMandar(adjuntos) {
  return (Array.isArray(adjuntos) ? adjuntos : []).map(adj => ({
    filename: adj.filename,
    content: Buffer.from(adj.contenido, 'base64'),
    contentType: adj.tipo,
  }));
}

// Encola un mail. Recibe el db de index.js (que es la base 'cursos', no la
// default) en vez de inicializar otro.
//
// datos: { para, asunto, html, texto?, responderA?, adjuntos?, motivo }
//   para     : string o array de direcciones
//   motivo   : para que es, para poder leer los logs despues
//              ('inscripcion:consultas', 'compra', 'turno-reservado'...)
async function encolarMail(db, datos) {
  if (!datos || !datos.para || !datos.asunto) {
    logger.error('Pedido de mail sin destinatario o sin asunto: se descarta.', {
      motivo: datos && datos.motivo,
    });
    return null;
  }
  try {
    // Con datos.id el documento tiene ese nombre en lugar de uno al azar.
    // Lo usa quien encola desde un trigger con retry: si el trigger se
    // repite, el segundo intento reescribe este mismo documento en vez de
    // encolar un segundo mail, y como enviarMailEncolado es
    // onDocumentCreated, reescribirlo no lo vuelve a disparar.
    const destino = datos.id
      ? db.collection(COLECCION).doc(String(datos.id))
      : db.collection(COLECCION).doc();
    await destino.set({
      para: Array.isArray(datos.para) ? datos.para.join(', ') : String(datos.para),
      asunto: String(datos.asunto),
      html: String(datos.html || ''),
      texto: datos.texto ? String(datos.texto) : null,
      responderA: datos.responderA ? String(datos.responderA) : null,
      adjuntos: adjuntosParaGuardar(datos.adjuntos, datos.motivo),
      motivo: String(datos.motivo || 'sin-motivo'),
      enviado: null,
      creado: new Date().toISOString(),
    });
    return destino.id;
  } catch (error) {
    // No se re-lanza: ver la regla 1 arriba.
    logger.error('No se pudo encolar el mail:', error.message, { motivo: datos.motivo });
    return null;
  }
}

// Manda un mail ya encolado. Lo llama el trigger.
//
// La marca "enviado" es contra el doble envio: los triggers de Firestore son
// at-least-once, y con retry: true un fallo vuelve a entrar aca. Se relee el
// documento (event.data trae la foto del momento de la creacion, que todavia
// no tiene la marca) y, si ya salio, no se manda de nuevo. Queda una ventana
// chica entre el sendMail y la marca; es la que hay sin un lock, y para un
// aviso duplicado cada tanto alcanza.
async function enviarMailEncolado(ref) {
  const snap = await ref.get();
  if (!snap.exists) return;
  const mail = snap.data();

  if (mail.enviado) {
    logger.info('Mail ya enviado, no se repite.', { id: ref.id, motivo: mail.motivo });
    return;
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    // Sin credenciales no hay nada que hacer, y reintentarlo no las va a
    // traer: se corta sin tirar para no dejar el trigger en bucle.
    logger.error('Falta GMAIL_USER o GMAIL_APP_PASSWORD: el mail queda en la cola.', {
      id: ref.id, motivo: mail.motivo,
    });
    return;
  }

  await transporteMail().sendMail({
    from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
    to: mail.para,
    replyTo: mail.responderA || undefined,
    subject: mail.asunto,
    html: mail.html,
    text: mail.texto || undefined,
    attachments: adjuntosParaMandar(mail.adjuntos),
  });

  await ref.update({ enviado: new Date().toISOString() });
  logger.info('Mail enviado', { id: ref.id, motivo: mail.motivo, para: mail.para });
}

module.exports = {
  COLECCION,
  transporteMail,
  encolarMail,
  enviarMailEncolado,
};
