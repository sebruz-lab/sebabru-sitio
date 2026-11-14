const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const dnsPromesas = require('dns').promises;

// nodemailer (35 archivos) y google-auth-library (97) se cargaban en el
// arranque en frio de las 31 functions, incluidas las que no mandan un mail
// ni hablan con Google: buscarLugar, que es el typeahead del lugar de
// nacimiento, pagaba los dos para nada.
//
// Estos dos envoltorios los cargan recien cuando alguien los usa de verdad,
// y a proposito mantienen la forma exacta de llamarlos
// (nodemailer.createTransport(...) y new JWT(...)): asi ningun lugar que ya
// los usa tiene que cambiar.
const nodemailer = {
  createTransport: (opciones) => require('nodemailer').createTransport(opciones),
};

// Un constructor que devuelve un objeto reemplaza al this, asi que
// new JWT({...}) entrega un JWT de verdad. Es la unica forma de diferir el
// require sin tocar los dos lugares que lo construyen.
class JWT {
  constructor(opciones) {
    const { JWT: JWTReal } = require('google-auth-library');
    return new JWTReal(opciones);
  }
}
const brevo = require('./brevo');
const mails = require('./mails');

// mercadopago se carga recien cuando hace falta, no al cargar el archivo.
// Los 40 endpoints viven todos aca, asi que buscarLugar pagaba el require de
// mercadopago en cada arranque en frio para nada. Mismo criterio que
// puppeteer en pdfDeCarta y que @googleapis/sheets en getSheetsClient.
let _mp = null;
function mp() {
  if (!_mp) _mp = require('mercadopago');
  return _mp;
}

// Un cliente de Mercado Pago por instancia. Antes se armaba un
// MercadoPagoConfig nuevo en cada llamada (habia cinco repartidos).
let _mpClient = null;
function clienteMP() {
  if (!_mpClient) {
    _mpClient = new (mp().MercadoPagoConfig)({ accessToken: process.env.MP_ACCESS_TOKEN });
  }
  return _mpClient;
}
function preferenciaMP() { return new (mp().Preference)(clienteMP()); }
function pagoMP() { return new (mp().Payment)(clienteMP()); }

const CURSO_URLS = {
  luna:      '/escuela/abierta/luna/',
  identidad: '/escuela/abierta/identidad/',
  tarot:     '/escuela/abierta/tarot/',
  signos:    '/escuela/abierta/signos/',
  casas:     '/escuela/abierta/casas/',
  pluton26:  '/escuela/abierta/pluton26/',
  lilith:    '/escuela/abierta/lilith/',
  linaje:    '/escuela/abierta/linaje/',
  lunas26:   '/escuela/lunas26/',
  quiron:    '/escuela/quiron/',
  'tu-identidad-en-el-cielo': '/tu-identidad-en-el-cielo/',
};

const PRECIOS = {
  luna:      { ars: 60000, usd: 50 },
  // Version grabada. El curso en vivo del mismo nombre es
  // 'tu-identidad-en-el-cielo', mas abajo, y cuesta distinto.
  identidad: { ars: 30000, usd: 20 },
  tarot:     { ars: 80000, usd: 60 },
  signos:    { ars: 60000, usd: 50 },
  casas:     { ars: 60000, usd: 50 },
  pluton26:  { ars: 80000, usd: 70 },
  lilith:    { ars: 80000, usd: 50 },
  'tu-identidad-en-el-cielo': { ars: 40000 },
  linaje:    { ars: 60000, usd: 50 },
  // Una consulta astrologica. Por transferencia tiene un precio propio
  // (arsTransferencia) en vez del 10% de descuento que llevan los cursos.
  consulta:  { ars: 135000, arsTransferencia: 120000, usd: 90 },
};

// Lo que se paga por aca y no es un curso (una consulta): no hay acceso que
// dar ni codigo que generar, solo avisar que el pago llego. mpWebhook y
// exitoPaypal cortan temprano con estos, y el checkout vuelve a su pagina.
const PRODUCTOS_SIN_ACCESO = new Set(['consulta']);
const VUELTA_PAGO = {
  consulta: { ok: '/consultas/?pago=ok', corte: '/consultas/' },
};

let _db;
function ensureInit() {
  if (_db) return;
  try { admin.app(); } catch (_) { admin.initializeApp(); }
  _db = getFirestore('cursos');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Limpia texto libre que viene del cliente antes de usarlo en el asunto de
// un email (evita inyeccion de headers via \r\n) o de guardarlo en Firestore.
function sanitizeTexto(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}

// Origen de la compra: utm_source/medium/campaign y gclid que guarda
// public/origen.js al aterrizar en el sitio (60 dias), mas la pagina de
// llegada y la fecha. Llega del navegador: solo texto corto, campos fijos.
const CAMPOS_ORIGEN = ['source', 'medium', 'campaign', 'gclid', 'landing', 'fecha'];
function sanitizeOrigen(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of CAMPOS_ORIGEN) {
    const v = sanitizeTexto(o[k], 200);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
// Mercado Pago guarda la metadata plana: origen_source, origen_medium...
function origenAMetadata(origen) {
  const m = {};
  if (origen) for (const k of CAMPOS_ORIGEN) if (origen[k]) m[`origen_${k}`] = origen[k];
  return m;
}
function origenDeMetadata(meta) {
  const o = {};
  for (const k of CAMPOS_ORIGEN) if (meta && meta[`origen_${k}`]) o[k] = String(meta[`origen_${k}`]);
  return Object.keys(o).length ? o : null;
}

function datosCompraMP(payment) {
  const meta = payment.metadata || {};
  return {
    tipo: 'curso',
    producto: meta.curso_id || null,
    nombre: meta.curso_nombre || meta.curso_id || null,
    metodo: 'mercadopago',
    monto: payment.transaction_amount ?? null,
    moneda: payment.currency_id || 'ARS',
    email: (meta.user_email || payment.payer?.email || '').toLowerCase() || null,
    regalo: meta.regalo === 'true',
    codigoDescuento: meta.codigo_descuento || null,
    estado: 'pagado',
    pagoId: String(payment.id),
    origen: origenDeMetadata(meta),
  };
}

// Registro de cada compra en "compras" (lo lista /escuela/admin). Es un
// agregado: si falla, el pago sigue su curso igual. create() es idempotente
// por id: el webhook y verificarPagoMP pueden llegar los dos sin duplicar.
async function registrarCompra(id, datos) {
  try {
    await _db.collection('compras').doc(id).create({
      ...datos,
      fecha: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e.code !== 6 /* ALREADY_EXISTS */) {
      functions.logger.error('No se pudo registrar la compra', { id, message: e.message });
    }
    // Sea porque ya estaba (el webhook y verificarPagoMP llegan los dos) o
    // porque fallo, no encolamos el contacto: asi no se duplica el alta.
    return;
  }

  // Una transferencia se declara, no se confirma: queda anotada igual,
  // pero sin fecha de compra, para no contar como ingreso algo que todavia
  // no entro.
  const declarada = datos.estado === 'pendiente' || datos.metodo === 'transferencia';
  await encolarContactoBrevo({
    email: datos.email,
    nombre: datos.nombre || '',
    listas: [datos.tipo === 'libro' ? 'libro'
      : PRODUCTOS_SIN_ACCESO.has(datos.producto) ? 'consultas'
      : 'alumnos'],
    atributos: {
      ORIGEN: 'compra',
      CONSENTIMIENTO: 'relacion-comercial',
      UTM: utmComoTexto(datos.origen),
      PRODUCTO_ULTIMO: `${declarada ? 'pendiente: ' : ''}${datos.nombre || datos.producto || ''}`.slice(0, 200),
      ...(declarada ? {} : { ULTIMA_COMPRA: brevo.fechaBrevo(new Date()) }),
    },
    motivo: 'compra',
  });
}

// Pago de algo que no es un curso: no hay nada que entregar automaticamente,
// asi que se le confirma a la persona que el pago llego y nos avisamos para
// coordinar a mano. Es un agregado: si falla, el pago ya quedo en "compras".
async function avisarPagoSinAcceso(transporter, { nombreProducto, email, monto, moneda, metodo }) {
  const importe = monto ? `${moneda || 'ARS'} ${monto}` : 'el importe';
  if (email) {
    await transporter.sendMail({
      from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `Recibimos tu pago — ${nombreProducto}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;">
        <p>¡Gracias! Ya nos llegó tu pago de <strong>${escapeHtml(nombreProducto)}</strong>.</p>
        <p>En los próximos días te escribimos para coordinar el día y la hora del encuentro.</p>
        <p>Seba</p>
      </div>`,
    });
  }
  await transporter.sendMail({
    from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
    to: AVISOS_INSCRIPCION,
    subject: `Pago recibido — ${nombreProducto}`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;">
      <p>Entró un pago de <strong>${escapeHtml(nombreProducto)}</strong> por ${escapeHtml(importe)} (${escapeHtml(metodo)}).</p>
      <p>Mail de quien pagó: ${escapeHtml(email || 'no lo dejó')}. Hay que coordinar el encuentro a mano.</p>
    </div>`,
  });
}

// Un pago entro, se genero el codigo de acceso y no hay a quien mandarselo
// (compra anonima que no dejo mail). Antes esto era solo un logger.warn: el
// pago quedaba cobrado, el acceso sin entregar y nadie se enteraba. El codigo
// existe y es valido, asi que alcanza con que el aviso llegue para poder
// mandarlo a mano cuando la persona reclame.
async function avisarCodigoSinDestino(transporter, { nombreProducto, codigo, pagoId, metodo }) {
  try {
    await transporter.sendMail({
      from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
      to: AVISOS_INSCRIPCION,
      subject: `Pago sin mail de destino — ${nombreProducto}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;">
        <p>Entró un pago de <strong>${escapeHtml(nombreProducto)}</strong> por ${escapeHtml(metodo)} y <strong>no quedó ningún mail</strong> al que mandarle el acceso.</p>
        <p>El código de acceso quedó generado: <strong>${escapeHtml(codigo)}</strong> — se canjea en ${process.env.SITE_URL}/canjear</p>
        <p>Pago: ${escapeHtml(String(pagoId))}. Si alguien reclama esta compra, mandale ese código.</p>
      </div>`,
    });
  } catch (e) {
    functions.logger.error('No se pudo avisar del codigo sin destino', { pagoId, message: e.message });
  }
}

const ALLOWED_ORIGINS = [
  'https://sebabru.com',
  'https://sebabru-e5563.web.app',
  'https://sebabru-e5563.firebaseapp.com',
];

function setCors(req, res, methods) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Methods', methods);
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Sin esto, el browser manda un OPTIONS antes de CADA POST, y ese
  // preflight paga su propio viaje a us-central1 (y puede despertar la
  // instancia en frio). Con una hora de cache, el primer envio lo paga y
  // los reintentos y los envios siguientes no.
  res.set('Access-Control-Max-Age', '3600');
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

function claveRateLimit(nombreFuncion, req) {
  const ipCruda = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  return `${nombreFuncion}_${ipCruda}`.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
}

// Limite simple por IP en una ventana fija, guardado en Firestore.
// No es a prueba de balas (alguien con muchas IPs lo esquiva) pero frena
// el caso real mas probable: un script en loop pegandole a un endpoint
// sin login desde una sola conexion.
// Mira el contador y decide, SIN escribir todavia. Devuelve tambien la
// escritura pendiente en .anotar(), para que quien este apurado la mande
// junto con las otras en vez de esperarla sola.
//
// Antes esto era una transaccion, o sea dos viajes a Firestore en fila
// (abrirla y confirmarla) y los dos antes que cualquier otra cosa. Se cambio
// por una lectura y una escritura separadas, y hay una razon por la que no
// afloja nada:
//
//   - La DECISION no cambia de lugar: se sigue leyendo el contador y
//     rechazando antes de aceptar un envio. Eso es lo que importa.
//   - El contador sigue siendo exacto, porque increment() es atomico del
//     lado de Firestore.
//   - Lo unico que se pierde es que dos envios simultaneos pueden decidir
//     sobre el mismo numero. Con un limite de 10 envios cada 10 minutos por
//     IP, errarle por uno no significa nada: no es un control de acceso, es
//     un freno al abuso.
async function mirarRitmo(nombreFuncion, req, maxRequests) {
  const ref = _db.collection('rate_limits').doc(claveRateLimit(nombreFuncion, req));
  const snap = await ref.get();
  const ahora = Date.now();

  // El contador queda tambien en el req para quien lo necesite:
  // registrarInscripcion decide con esto si pide captcha.
  if (!snap.exists || (ahora - snap.data().windowStart) > RATE_LIMIT_WINDOW_MS) {
    req._intentos = 1;
    return { ok: true, anotar: () => ref.set({ windowStart: ahora, count: 1 }) };
  }

  const cuantos = snap.data().count;
  if (cuantos >= maxRequests) {
    req._intentos = cuantos;
    // No se anota nada: el envio se rechaza y no cuenta.
    return { ok: false, anotar: () => Promise.resolve() };
  }

  req._intentos = cuantos + 1;
  return { ok: true, anotar: () => ref.update({ count: admin.firestore.FieldValue.increment(1) }) };
}

// La forma de siempre, para los siete endpoints donde 150 ms no cambian nada.
// A proposito no se toca su firma: la usan desde los webhooks de pago hasta
// el buscador de lugares.
async function checkRateLimit(nombreFuncion, req, maxRequests) {
  const ritmo = await mirarRitmo(nombreFuncion, req, maxRequests);
  await ritmo.anotar();
  return ritmo.ok;
}

// Verifica la firma x-signature que Mercado Pago manda en cada webhook,
// usando el "secreto de firma" configurado en el panel de MP (Developers ->
// Tu integracion -> Webhooks). Si MP_WEBHOOK_SECRET no esta configurado
// todavia, no bloquea nada (se loguea un aviso) -- el estado del pago se
// reconfirma igual contra la API de MP mas abajo en mpWebhook, asi que esto
// es una capa extra, no el unico control.
function verificarFirmaMP(req, dataId) {
  const secreto = process.env.MP_WEBHOOK_SECRET;
  if (!secreto) {
    // A proposito NO se bloquea: si este webhook rechazara todo, ninguna
    // compra activaria el acceso. Pero se loguea como error, no como aviso,
    // para que aparezca en las alertas: mientras el secreto no este cargado
    // el unico control real es la reconsulta del pago contra la API de MP,
    // mas abajo en mpWebhook. Cargar el secreto desde el panel de MP
    // (Developers -> Tu integracion -> Webhooks) alcanza para que esta
    // verificacion empiece a aplicarse sola.
    functions.logger.error('MP_WEBHOOK_SECRET no configurado: el webhook de Mercado Pago esta aceptando pedidos sin verificar la firma.');
    return true;
  }

  const firmaHeader = req.headers['x-signature'] || '';
  const requestId = req.headers['x-request-id'] || '';
  const partes = Object.fromEntries(
    firmaHeader.split(',').map(p => p.trim().split('=').map(s => s.trim()))
  );
  const { ts, v1 } = partes;
  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const esperado = crypto.createHmac('sha256', secreto).update(manifest).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(v1));
  } catch (_) {
    return false; // longitudes distintas -> timingSafeEqual tira, no es valida
  }
}

// Verifica un token de Cloudflare Turnstile contra siteverify. Sin
// TURNSTILE_SECRET_KEY no bloquea nada en el emulador, para no obligar a
// configurar el captcha en desarrollo; pero en produccion rechaza, porque si
// no una variable de entorno mal desplegada dejaba el endpoint sin captcha
// y lo unico que avisaba era una linea en el log.
async function verificarTurnstile(token, req) {
  const secreto = process.env.TURNSTILE_SECRET_KEY;
  if (!secreto) {
    if (process.env.FUNCTIONS_EMULATOR) {
      functions.logger.warn('TURNSTILE_SECRET_KEY no configurado: captcha sin verificar (emulador).');
      return true;
    }
    functions.logger.error('TURNSTILE_SECRET_KEY no configurado en produccion: se rechaza el pedido.');
    return false;
  }
  if (!token) return false;
  try {
    const ipCruda = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: secreto, response: token, remoteip: ipCruda }),
    });
    const data = await resp.json();
    return data.success === true;
  } catch (e) {
    functions.logger.error('Error verificando captcha', e.message);
    return false;
  }
}

// -------------------------------------------------------
// Mailing (Brevo). El alta de un contacto NO se hace en linea desde una
// compra ni desde una inscripcion: se deja un pedido en "brevo_contactos" y
// lo levanta el trigger sincronizarContactoBrevo. Dos razones:
//
//  1. Si Brevo esta caido o lento, el cobro y la inscripcion siguen igual.
//  2. En un onRequest no se puede dejar una promesa sin await: la instancia
//     se congela despues del res.send() y la llamada queda a medias o se
//     ejecuta en la invocacion siguiente. La cola lo resuelve bien, y es el
//     mismo patron que ya usamos con envios_carta.
//
// Encolar es un add() a Firestore y va siempre dentro de un try/catch que
// solo loguea: tampoco el encolado puede romper nada.
async function encolarContactoBrevo(datos) {
  if (!datos || !datos.email) return;
  try {
    // El id, si viene, nombra el documento y no se guarda adentro. Sirve
    // para que un trigger con retry no encole el alta dos veces: ver
    // encolarMail en mails.js, que hace lo mismo y por lo mismo.
    const { id, ...resto } = datos;
    const destino = id
      ? _db.collection('brevo_contactos').doc(String(id))
      : _db.collection('brevo_contactos').doc();
    await destino.set({
      ...resto,
      email: String(datos.email).trim().toLowerCase(),
      creado: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    functions.logger.error('No se pudo encolar el contacto para el mailing:', error.message);
  }
}

// Los cursos de un usuario como texto, que es lo que entiende Brevo (no
// tiene atributos de tipo lista).
function cursosComoTexto(cursos) {
  return (Array.isArray(cursos) ? cursos : []).join(', ');
}

// El origen de una compra ({utm_source, utm_medium, ...}) resumido en una
// linea, para que entre en el atributo UTM.
function utmComoTexto(origen) {
  if (!origen || typeof origen !== 'object') return '';
  // Solo de donde vino, no la landing ni la fecha: eso ya esta en "compras".
  return ['source', 'medium', 'campaign', 'gclid']
    .map(k => origen[k]).filter(Boolean).join('/').slice(0, 200);
}

async function validarCodigo(codigo, cursoId) {
  if (!codigo) return null;
  const codigoNorm = codigo.toUpperCase();
  if (!CODIGO_VALIDO.test(codigoNorm)) return null;
  const snap = await _db.collection('codigos_descuento').doc(codigoNorm).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data.activo) return null;
  if (data.expiraEn && data.expiraEn.toDate() < new Date()) return null;
  if (data.maxUsos && data.usos >= data.maxUsos) return null;
  if (data.cursos?.length && !data.cursos.includes(cursoId)) return null;
  return data;
}

// -------------------------------------------------------
// obtenerMuestra: expone SOLO el primer video de un curso (la clase
// gratis), sin requerir login. El resto de "cursos/{id}.videos" sigue
// protegido por las reglas de Firestore (solo dueños del curso).
// -------------------------------------------------------
exports.obtenerMuestra = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  ensureInit();

  const cursoId = String(req.query.curso || '').trim();
  if (!cursoId || !CURSO_URLS[cursoId]) {
    return res.status(400).json({ error: 'Curso inválido.' });
  }

  try {
    const snap = await _db.collection('cursos').doc(cursoId).get();
    const videoId = snap.data()?.videos?.[0] || null;
    if (!videoId) return res.status(404).json({ error: 'Este curso todavía no tiene clase gratis cargada.' });
    return res.status(200).json({ videoId });
  } catch (error) {
    functions.logger.error('Error en obtenerMuestra:', error);
    return res.status(500).json({ error: 'Error al obtener la clase gratis.' });
  }
});

// -------------------------------------------------------
// registrarInteres: marca a un usuario logueado (que todavia no compro)
// como interesado en un curso, porque miro la clase gratis. Sirve para
// segmentar leads: cursos:[] + interesados:[...] = mostro interes pero
// no compro nada todavia.
// -------------------------------------------------------
exports.registrarInteres = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debés iniciar sesión.');
  }
  ensureInit();

  const email = (context.auth.token.email || '').toLowerCase().trim();
  if (!email) {
    throw new functions.https.HttpsError('failed-precondition', 'Tu cuenta no tiene un email asociado.');
  }

  const cursoId = String(data?.cursoId || '').trim();
  if (!cursoId || !CURSO_URLS[cursoId]) {
    throw new functions.https.HttpsError('invalid-argument', 'Curso inválido.');
  }

  const ref = _db.collection('usuarios').doc(email);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      cursos: [],
      cohorte: '2026',
      fechaRegistro: admin.firestore.FieldValue.serverTimestamp(),
      interesados: [cursoId],
    });
  } else {
    await ref.update({ interesados: admin.firestore.FieldValue.arrayUnion(cursoId) });
  }

  functions.logger.info('Interes registrado', { email, cursoId });
  return { ok: true };
});

// -------------------------------------------------------
// Regalo de cursos: generar y asegurar el codigo de canje
// -------------------------------------------------------

// Codigo corto y legible para compartir (sin I/O/0/1, que se confunden).
function generarCodigoRegalo() {
  const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bloque = () => {
    let s = '';
    for (let i = 0; i < 5; i++) s += ABC[crypto.randomInt(ABC.length)];
    return s;
  };
  return `RG-${bloque()}-${bloque()}`;
}

// Los codigos (regalo y descuento) se usan tal cual como ID de documento de
// Firestore -- sin esto, un codigo con "/" (o vacio, o gigante) puede romper
// la referencia al documento en vez de simplemente "no encontrado".
const CODIGO_VALIDO = /^[A-Z0-9-]{1,40}$/;

// Crea (o recupera, si ya se creo antes para este mismo pago) el codigo de
// regalo asociado a un pago. Idempotente: se puede llamar desde el webhook
// de MP y desde verificarPagoMP para el mismo pago sin generar dos codigos
// ni pisar el estado "usado" de uno ya canjeado.
async function asegurarRegalo(pagoRef, { cursoId, cursoNombre, compradorEmail, origen }) {
  const codigo = await _db.runTransaction(async tx => {
    const snap = await tx.get(pagoRef);
    if (snap.exists && snap.data().codigoRegalo) return snap.data().codigoRegalo;
    const nuevo = generarCodigoRegalo();
    tx.set(pagoRef, { codigoRegalo: nuevo }, { merge: true });
    return nuevo;
  });

  try {
    await _db.collection('regalos').doc(codigo).create({
      cursoId,
      cursoNombre,
      cursoUrl: CURSO_URLS[cursoId] || '/escuela/abierta/',
      compradoPor: compradorEmail,
      origen,
      creadoEn: admin.firestore.FieldValue.serverTimestamp(),
      usado: false,
    });
  } catch (e) {
    // Ya existe (llamada repetida / carrera webhook vs verificarPagoMP): no pisar su estado.
    if (!/already exists/i.test(e.message || '')) throw e;
  }

  return codigo;
}

// Consume un uso del codigo de descuento, una sola vez por pago. El contador
// vive en "codigos_descuento", pero la marca de "este pago ya lo conto" va en
// el mismo doc de "pagos_procesados" que hace de candado del pago: asi el
// webhook y verificarPagoMP pueden llegar los dos, en cualquier orden, y el
// uso se cuenta una sola vez. Antes el incremento colgaba solo del webhook y,
// si ese nunca llegaba (firma mal configurada, MP caido), el cupon no gastaba
// usos y se podia pasar de maxUsos.
async function contarUsoDescuento(pagoRef, codigo) {
  if (!codigo || !CODIGO_VALIDO.test(codigo)) return;
  const codigoRef = _db.collection('codigos_descuento').doc(codigo);
  try {
    await _db.runTransaction(async tx => {
      const pago = await tx.get(pagoRef);
      if (pago.exists && pago.data().cuponContado) return;
      const cupon = await tx.get(codigoRef);
      if (!cupon.exists) {
        functions.logger.warn('Codigo de descuento inexistente al contar el uso', { codigo });
        return;
      }
      tx.update(codigoRef, { usos: admin.firestore.FieldValue.increment(1) });
      tx.set(pagoRef, { cuponContado: true }, { merge: true });
    });
  } catch (e) {
    // Es un agregado contable: si falla, el pago y el acceso siguen su curso.
    functions.logger.error('No se pudo contar el uso del descuento', { codigo, message: e.message });
  }
}

// -------------------------------------------------------
// activarInvitacion: canjear token de invitación server-side
// -------------------------------------------------------
exports.activarInvitacion = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debés iniciar sesión.');
  }
  ensureInit();

  const { token } = data;
  if (!token || typeof token !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Token requerido.');
  }

  const userEmail = context.auth.token.email.toLowerCase().trim();
  const invRef = _db.collection('invitaciones').doc(token);

  let inv;
  await _db.runTransaction(async tx => {
    const snap = await tx.get(invRef);
    if (!snap.exists) {
      throw new functions.https.HttpsError('not-found', 'Invitación no encontrada.');
    }
    inv = snap.data();
    if (inv.usado || inv.usada) {
      throw new functions.https.HttpsError('already-exists', 'Esta invitación ya fue utilizada.');
    }

    // Expiración y destinatario se validan ACA ADENTRO, antes de marcarla
    // como usada. Cuando se chequeaban después del update, cualquiera con el
    // token quemaba definitivamente la invitación de quien había pagado: la
    // transacción ya la había consumido y el error llegaba tarde.
    if (inv.expiraEn) {
      const expira = inv.expiraEn.toDate ? inv.expiraEn.toDate() : new Date(inv.expiraEn);
      if (expira < new Date()) {
        throw new functions.https.HttpsError('deadline-exceeded', 'Esta invitación expiró.');
      }
    }

    // El mensaje no nombra la dirección: si no, le confirmaba a cualquiera
    // que tuviera el token a qué mail se le mandó la invitación.
    const destino = (inv.emailDestino || inv.email || '').toLowerCase().trim();
    if (destino && destino !== userEmail) {
      throw new functions.https.HttpsError('permission-denied', 'Esta invitación es para otra persona. Entrá con la cuenta a la que te llegó.');
    }

    tx.update(invRef, {
      usado: true,
      usada: true,
      usadoPor: userEmail,
      usadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  const cursoId = inv.cursoId || inv.curso;
  if (!cursoId) {
    throw new functions.https.HttpsError('internal', 'Invitación sin curso asociado.');
  }

  await _db.collection('usuarios').doc(userEmail).set(
    { cursos: admin.firestore.FieldValue.arrayUnion(cursoId) },
    { merge: true }
  );

  functions.logger.info('Invitación canjeada', { userEmail, cursoId, token });
  return { cursoId, cursoUrl: inv.cursoUrl || CURSO_URLS[cursoId] || '/escuela/abierta/' };
});

// -------------------------------------------------------
// canjearRegalo: canjear un codigo de regalo y habilitar el curso
// -------------------------------------------------------
exports.canjearRegalo = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debés iniciar sesión.');
  }
  ensureInit();

  const userEmail = (context.auth.token.email || '').toLowerCase().trim();
  if (!userEmail) {
    throw new functions.https.HttpsError('failed-precondition', 'Tu cuenta no tiene un email asociado.');
  }

  const codigo = String(data?.codigo || '').trim().toUpperCase();
  if (!codigo || !CODIGO_VALIDO.test(codigo)) {
    throw new functions.https.HttpsError('invalid-argument', 'Código requerido.');
  }

  const regaloRef = _db.collection('regalos').doc(codigo);

  const cursoId = await _db.runTransaction(async tx => {
    const snap = await tx.get(regaloRef);
    if (!snap.exists) {
      throw new functions.https.HttpsError('not-found', 'Ese código no existe.');
    }
    const r = snap.data();
    if (r.usado) {
      throw new functions.https.HttpsError('already-exists', 'Ese código ya fue canjeado.');
    }
    tx.update(regaloRef, {
      usado: true,
      usadoPor: userEmail,
      usadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
    return r.cursoId;
  });

  const regaloData = (await regaloRef.get()).data();

  const userRef = _db.collection('usuarios').doc(userEmail);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({
      cursos: [cursoId],
      cohorte: '2026',
      fechaRegistro: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await userRef.update({ cursos: admin.firestore.FieldValue.arrayUnion(cursoId) });
  }

  functions.logger.info('Regalo canjeado', { userEmail, cursoId, codigo });
  return {
    cursoId,
    cursoNombre: regaloData.cursoNombre,
    cursoUrl: regaloData.cursoUrl || CURSO_URLS[cursoId] || '/escuela/abierta/',
  };
});

// -------------------------------------------------------
// reclamarPago: para compras hechas sin sesion (login diferido).
// El comprador paga como anonimo, recibe un codigo de acceso por mail y,
// si despues inicia sesion desde gracias.html, esto le habilita el curso
// directo sin tener que ir a /canjear a pegar el codigo a mano.
// -------------------------------------------------------
exports.reclamarPago = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debés iniciar sesión.');
  }
  ensureInit();

  const callerEmail = (context.auth.token.email || '').toLowerCase().trim();
  if (!callerEmail) {
    throw new functions.https.HttpsError('failed-precondition', 'Tu cuenta no tiene un email asociado.');
  }

  const paymentId = String(data?.paymentId || '').trim();
  if (!paymentId) {
    throw new functions.https.HttpsError('invalid-argument', 'Falta el identificador de pago.');
  }

  const pagoSnap = await _db.collection('pagos_procesados').doc(paymentId).get();
  if (!pagoSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'No encontramos ese pago.');
  }
  const pago = pagoSnap.data();

  // Un regalo real (para otra persona) no se autoreclama: el codigo queda
  // para que el comprador lo comparta.
  if (pago.regalo) {
    return { granted: false, esRegalo: true };
  }
  if (!pago.codigoRegalo) {
    // Compra con sesion iniciada: el acceso ya se otorgo directo, nada que reclamar.
    return { granted: false, yaAsignado: true };
  }

  const regaloRef = _db.collection('regalos').doc(pago.codigoRegalo);
  const regaloSnap = await regaloRef.get();
  if (!regaloSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Código no encontrado.');
  }
  const r = regaloSnap.data();

  if (r.usado) {
    if (r.usadoPor === callerEmail) {
      return { granted: true, cursoId: r.cursoId, cursoNombre: r.cursoNombre, cursoUrl: r.cursoUrl };
    }
    return { granted: false, yaCanjeado: true };
  }

  const compradorEmail = (r.compradoPor || '').toLowerCase().trim();
  if (compradorEmail && compradorEmail !== callerEmail) {
    return { granted: false, otroComprador: true };
  }

  try {
    await _db.runTransaction(async tx => {
      const s = await tx.get(regaloRef);
      if (s.data().usado) {
        throw new functions.https.HttpsError('already-exists', 'Ese código ya fue canjeado.');
      }
      tx.update(regaloRef, {
        usado: true,
        usadoPor: callerEmail,
        usadoEn: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    if (e instanceof functions.https.HttpsError && e.code === 'already-exists') {
      return { granted: false, yaCanjeado: true };
    }
    throw e;
  }

  const userRef = _db.collection('usuarios').doc(callerEmail);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({
      cursos: [r.cursoId],
      cohorte: '2026',
      fechaRegistro: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await userRef.update({ cursos: admin.firestore.FieldValue.arrayUnion(r.cursoId) });
  }

  functions.logger.info('Pago reclamado', { callerEmail, cursoId: r.cursoId, paymentId });
  return { granted: true, cursoId: r.cursoId, cursoNombre: r.cursoNombre, cursoUrl: r.cursoUrl };
});

// -------------------------------------------------------
// crearPago: MercadoPago
// -------------------------------------------------------
exports.crearPago = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: { status: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });

  ensureInit();

  // Login opcional: si viene token valido lo usamos; si no, es una compra
  // anonima (la persona reclama el acceso despues, con un codigo). El precio
  // se valida siempre server-side, asi que no hay riesgo de manipulacion.
  let userEmail = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const decodedToken = await admin.auth().verifyIdToken(authHeader.replace('Bearer ', ''));
      userEmail = decodedToken.email || null;
    } catch (e) { /* token invalido -> se trata como anonimo */ }
  }

  if (!(await checkRateLimit('crearPago', req, 15))) {
    return res.status(429).json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Demasiados intentos. Probá de nuevo en unos minutos.' } });
  }

  const { cursoId, codigoDescuento } = req.body.data || {};
  const cursoNombre = sanitizeTexto(req.body.data?.cursoNombre, 200);
  const regalo = req.body.data?.regalo === true;
  const origen = sanitizeOrigen(req.body.data?.origen);

  const preciosBase = PRECIOS[cursoId];
  if (!cursoId || !cursoNombre || !preciosBase) {
    return res.status(400).json({ error: { status: 'INVALID_ARGUMENT', message: 'Faltan datos del curso.' } });
  }

  const codigoData = await validarCodigo(codigoDescuento, cursoId);
  const descuento = codigoData?.descuento || 0;
  const precio = Math.round(preciosBase.ars * (1 - descuento / 100));

  // Una consulta no vuelve a la pagina de gracias de la escuela.
  const vuelta = VUELTA_PAGO[cursoId];

  functions.logger.info('Iniciando crearPago', { cursoId, userEmail, precio, descuento });

  try {
    const preference = preferenciaMP();

    const result = await preference.create({
      body: {
        items: [{
          title: cursoNombre,
          quantity: 1,
          unit_price: precio,
          currency_id: 'ARS'
        }],
        ...(userEmail ? { payer: { email: userEmail } } : {}),
        back_urls: {
          success: `${process.env.SITE_URL}${vuelta ? vuelta.ok : '/escuela/abierta/gracias.html'}`,
          failure: `${process.env.SITE_URL}${vuelta ? vuelta.corte : '/escuela/abierta/'}`,
          pending: `${process.env.SITE_URL}${vuelta ? vuelta.corte : '/escuela/abierta/'}`
        },
        auto_approve: false,
        notification_url: 'https://us-central1-sebabru-e5563.cloudfunctions.net/mpWebhook',
        metadata: {
          curso_id: cursoId,
          curso_nombre: cursoNombre,
          user_email: userEmail || null,
          codigo_descuento: codigoData ? codigoDescuento.toUpperCase() : null,
          regalo: regalo ? 'true' : 'false',
          ...origenAMetadata(origen),
        }
      }
    });

    functions.logger.info('Preferencia creada OK', { preferenceId: result.id });
    return res.status(200).json({ result: { init_point: result.init_point } });

  } catch (error) {
    functions.logger.error('Error en crearPago:', { message: error.message, stack: error.stack });
    // Mensaje generico: el detalle va al log. Los mensajes internos nombran
    // variables de entorno, IDs de planilla y respuestas crudas del proveedor
    // de pago, que no tienen por que viajar al navegador.
    return res.status(500).json({ error: { status: 'INTERNAL', message: 'No se pudo generar el pago. Probá de nuevo en unos minutos.' } });
  }
});

// -------------------------------------------------------
// mpWebhook
// -------------------------------------------------------
exports.mpWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  ensureInit();

  if (!(await checkRateLimit('mpWebhook', req, 60))) {
    functions.logger.warn('mpWebhook: rate limit alcanzado', { ip: req.headers['x-forwarded-for'] || req.ip });
    return res.status(429).send('Too Many Requests');
  }

  const { type, data } = req.body;
  functions.logger.info('Webhook recibido', { type, data });

  if (type !== 'payment' || !data?.id) return res.status(200).send('OK');

  if (!verificarFirmaMP(req, data.id)) {
    functions.logger.error('mpWebhook: firma invalida', { id: data.id });
    return res.status(401).send('Firma invalida');
  }

  try {
    const paymentClient = pagoMP();

    const payment = await paymentClient.get({ id: data.id });

    if (payment.status !== 'approved') {
      functions.logger.info('Pago no aprobado', { id: data.id, status: payment.status });
      return res.status(200).send('OK');
    }

    const { curso_id, curso_nombre, user_email, codigo_descuento, regalo } = payment.metadata || {};
    const esRegalo = regalo === 'true';
    const payerEmail = payment.payer?.email || null;
    // Compra anonima: no hay cuenta atada al pago -> se entrega por codigo.
    const esAnonima = !user_email;
    const porCodigo = esRegalo || esAnonima;

    if (!curso_id) {
      functions.logger.error('Metadata incompleta en pago', { id: data.id });
      return res.status(200).send('OK');
    }

    // Antes del chequeo de "ya procesado": verificarPagoMP puede haber
    // llegado primero. registrarCompra no duplica.
    await registrarCompra(`mp_${data.id}`, datosCompraMP(payment));

    // create() falla atomicamente si el doc ya existe (a diferencia de
    // get()+set(), que deja una ventana entre ambos pasos donde dos
    // notificaciones casi simultaneas del webhook pueden pasar las dos el
    // chequeo de "no existe todavia" antes de que la primera lo cree).
    const pagoRef = _db.collection('pagos_procesados').doc(String(data.id));
    try {
      await pagoRef.create({ procesadoEn: admin.firestore.FieldValue.serverTimestamp(), regalo: esRegalo, anonima: esAnonima });
    } catch (e) {
      if (e.code === 6 /* ALREADY_EXISTS */) {
        functions.logger.info('Pago ya procesado', { id: data.id });
        return res.status(200).send('OK');
      }
      throw e;
    }

    await contarUsoDescuento(pagoRef, codigo_descuento);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    const nombreCurso = curso_nombre || curso_id;

    if (PRODUCTOS_SIN_ACCESO.has(curso_id)) {
      await avisarPagoSinAcceso(transporter, {
        nombreProducto: nombreCurso,
        email: user_email || payerEmail,
        monto: payment.transaction_amount ?? null,
        moneda: payment.currency_id || 'ARS',
        metodo: 'Mercado Pago',
      });
      functions.logger.info('Pago sin acceso avisado', { id: data.id, curso_id });
      return res.status(200).send('OK');
    }

    if (porCodigo) {
      const codigo = await asegurarRegalo(pagoRef, {
        cursoId: curso_id, cursoNombre: nombreCurso, compradorEmail: user_email || payerEmail, origen: 'mp'
      });

      const destino = user_email || payerEmail;
      if (destino) {
        await transporter.sendMail({
          from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
          to: destino,
          bcc: 'espaciointeriorastrologia@gmail.com',
          subject: esRegalo ? `Tu código de regalo: ${nombreCurso}` : `Tu código de acceso: ${nombreCurso}`,
          html: emailRegaloHtml(nombreCurso, codigo, esRegalo)
        });
      } else {
        functions.logger.warn('Pago por codigo sin email de destino', { id: data.id, codigo });
        await avisarCodigoSinDestino(transporter, {
          nombreProducto: nombreCurso, codigo, pagoId: data.id, metodo: 'Mercado Pago',
        });
      }

      functions.logger.info('Compra por codigo', { destino, curso_id, codigo, esRegalo });
      return res.status(200).send('OK');
    }

    const userRef = _db.collection('usuarios').doc(user_email.toLowerCase().trim());
    await userRef.set({ cursos: admin.firestore.FieldValue.arrayUnion(curso_id) }, { merge: true });

    functions.logger.info('Acceso otorgado', { user_email, curso_id });

    const cursoUrl = `${process.env.SITE_URL}${CURSO_URLS[curso_id] || '/escuela/abierta/'}`;

    await transporter.sendMail({
      from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
      to: user_email,
      bcc: 'espaciointeriorastrologia@gmail.com',
      subject: `Tu acceso al curso: ${nombreCurso}`,
      html: emailAccesoHtml(nombreCurso, cursoUrl, user_email)
    });

    functions.logger.info('Email enviado', { user_email, curso_id });
    res.status(200).send('OK');

  } catch (error) {
    functions.logger.error('Error en mpWebhook:', error);
    res.status(500).send('Error interno');
  }
});

// -------------------------------------------------------
// PayPal helpers
// -------------------------------------------------------
function paypalBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function paypalToken() {
  const creds = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  return d.access_token;
}

function emailAccesoHtml(nombreCurso, cursoUrl, userEmail) {
  const fecha = new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const nombreSeguro = escapeHtml(nombreCurso);
  const emailSeguro = escapeHtml(userEmail);
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #222;">
      <h2 style="color: #249b95;">¡Gracias por tu compra!</h2>
      <p>Tu pago fue acreditado. Ya tenés acceso a <strong>${nombreSeguro}</strong>.</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${cursoUrl}"
           style="background:#249b95; color:white; padding:14px 28px; border-radius:6px;
                  text-decoration:none; font-weight:bold; font-size:1rem;">
          INGRESAR AL CURSO
        </a>
      </p>
      <p style="color:#888; font-size:0.85em;">
        Si el botón no funciona, copiá este link:<br>
        <a href="${cursoUrl}" style="color:#249b95;">${cursoUrl}</a>
      </p>
      <hr style="border:none; border-top:1px solid #eee; margin:30px 0;">
      <p style="color:#555; font-size:0.9em; line-height:1.7;">
        Felicitaciones y espero que lo disfrutes!<br>
        Cualquier duda o pregunta acá estoy para asesorarte, podés responder a este mismo correo.<br><br>
        Seba.
      </p>
      <hr style="border:none; border-top:1px solid #eee; margin:24px 0;">
      <div style="font-family: 'Courier New', Courier, monospace; font-size:0.78em; color:#999; line-height:2;">
        COMPROBANTE DE ACCESO<br>
        ────────────────────────────<br>
        Curso &nbsp;&nbsp;: ${nombreSeguro}<br>
        Usuario : ${emailSeguro}<br>
        Fecha &nbsp;&nbsp;: ${fecha}<br>
        ────────────────────────────
      </div>
      <p style="color:#aaa; font-size:0.8em; margin-top:20px;">Seba Bru Astrología · sebabru.com</p>
    </div>`;
}

function emailRegaloHtml(cursoNombre, codigo, esRegalo) {
  const nombreSeguro = escapeHtml(cursoNombre);
  const codigoSeguro = escapeHtml(codigo);
  const bajada = esRegalo
    ? `<p>Compartilo con quien quieras regalarle <strong>${nombreSeguro}</strong> — lo puede canjear cuando quiera en
         <a href="https://sebabru.com/canjear" style="color:#249b95;">sebabru.com/canjear</a>.</p>
       <p style="color:#888; font-size:0.85em;">Es un código de un solo uso: guardalo hasta que se lo pases a esa persona.</p>`
    : `<p>Con este código habilitás <strong>${nombreSeguro}</strong> en tu cuenta. Entrá a
         <a href="https://sebabru.com/canjear" style="color:#249b95;">sebabru.com/canjear</a>, iniciá sesión (o creá tu cuenta,
         es gratis) y pegá el código.</p>
       <p style="color:#888; font-size:0.85em;">Es un código de un solo uso. Guardá este mail.</p>`;
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #222;">
      <h2 style="color: #249b95;">¡Gracias por tu compra!</h2>
      <p>${esRegalo ? 'Generamos tu código de regalo para' : 'Tu pago fue acreditado. Tu código de acceso a'} <strong>${nombreSeguro}</strong>:</p>
      <p style="text-align: center; margin: 24px 0;">
        <span style="display:inline-block; background:#f5f5f5; border:1px dashed #249b95; border-radius:8px;
                     padding:14px 28px; font-family:'Courier New',monospace; font-size:1.3rem; letter-spacing:0.1em; color:#249b95;">
          ${codigoSeguro}
        </span>
      </p>
      ${bajada}
      <hr style="border:none; border-top:1px solid #eee; margin:30px 0;">
      <p style="color:#555; font-size:0.9em; line-height:1.7;">
        Cualquier duda podés responder a este mismo correo.<br><br>
        Seba.
      </p>
      <p style="color:#aaa; font-size:0.8em; margin-top:20px;">Seba Bru Astrología · sebabru.com</p>
    </div>`;
}

// -------------------------------------------------------
// verificarPagoMP: verifica pago aprobado y activa acceso
// -------------------------------------------------------
exports.verificarPagoMP = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  ensureInit();

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Debés iniciar sesión para verificar el pago.' });
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(authHeader.replace('Bearer ', ''));
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido.' });
  }

  const userEmail = decodedToken.email.toLowerCase().trim();
  const { paymentId } = req.body || {};

  if (!paymentId) {
    return res.status(400).json({ error: 'Falta el payment_id.' });
  }

  // Sin este limite se podian probar payment_id de a miles: los pagos sin
  // cuenta asociada entregan el codigo de regalo a quien llega primero, y el
  // payment_id viaja en la URL de vuelta de MP, asi que no hay que adivinarlo
  // de cero. Quien vuelve de pagar de verdad usa este endpoint una o dos veces.
  if (!(await checkRateLimit('verificarPagoMP', req, 10))) {
    return res.status(429).json({ error: 'Demasiados intentos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  try {
    const paymentClient = pagoMP();
    const payment = await paymentClient.get({ id: paymentId });

    if (payment.status !== 'approved') {
      return res.status(400).json({ error: 'El pago no está aprobado.', status: payment.status });
    }

    const metaEmail = (payment.metadata?.user_email || '').toLowerCase().trim();
    if (metaEmail && metaEmail !== userEmail) {
      return res.status(403).json({ error: 'El pago no corresponde a tu cuenta.' });
    }

    const curso_id = payment.metadata?.curso_id;
    if (!curso_id) {
      return res.status(400).json({ error: 'Metadata de curso incompleta.' });
    }

    await registrarCompra(`mp_${paymentId}`, datosCompraMP(payment));

    // Mismo candado que usa el webhook: el uso del cupon se cuenta una vez
    // por pago, sin importar cual de los dos caminos llego primero.
    const pagoRef = _db.collection('pagos_procesados').doc(String(paymentId));
    await contarUsoDescuento(pagoRef, payment.metadata?.codigo_descuento);

    const esRegalo = payment.metadata?.regalo === 'true';
    // Pago sin cuenta asociada (metaEmail vacío): no hay forma de confirmar
    // que quien llama a este endpoint con el payment_id (visible en la URL
    // de vuelta de MP) es realmente quien pagó. Lo tratamos igual que un
    // regalo: se genera/recupera un código de un solo uso en "regalos" (con
    // su propio chequeo de "ya usado") en vez de otorgar el curso directo a
    // cualquiera que llegue con el payment_id.
    const esAnonima = !metaEmail;

    if (esRegalo || esAnonima) {
      const cursoNombre = payment.metadata?.curso_nombre || curso_id;
      const codigo = await asegurarRegalo(pagoRef, {
        cursoId: curso_id, cursoNombre, compradorEmail: userEmail, origen: 'mp'
      });

      functions.logger.info('verificarPagoMP: regalo listo', { userEmail, curso_id, paymentId });
      return res.status(200).json({
        ok: true, regalo: true, codigoRegalo: codigo, cursoNombre,
        canjearUrl: `${process.env.SITE_URL}/canjear`
      });
    }

    const userRef = _db.collection('usuarios').doc(userEmail);
    await userRef.set({ cursos: admin.firestore.FieldValue.arrayUnion(curso_id) }, { merge: true });

    functions.logger.info('verificarPagoMP: acceso activado', { userEmail, curso_id, paymentId });

    const cursoUrl = CURSO_URLS[curso_id] || '/escuela/abierta/';
    return res.status(200).json({ ok: true, cursoId: curso_id, cursoUrl });

  } catch (error) {
    functions.logger.error('Error en verificarPagoMP:', error);
    return res.status(500).json({ error: 'Error al verificar el pago. Intentá de nuevo en unos minutos.' });
  }
});

// -------------------------------------------------------
// crearPagoPaypal
// -------------------------------------------------------
exports.crearPagoPaypal = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: { status: 'METHOD_NOT_ALLOWED' } });

  ensureInit();

  // Login opcional: igual que crearPago, se puede pagar sin sesion y
  // reclamar el acceso despues con un codigo.
  let userEmail = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const decodedToken = await admin.auth().verifyIdToken(authHeader.replace('Bearer ', ''));
      userEmail = decodedToken.email ? decodedToken.email.toLowerCase().trim() : null;
    } catch (e) { /* token invalido -> se trata como anonimo */ }
  }

  if (!(await checkRateLimit('crearPagoPaypal', req, 15))) {
    return res.status(429).json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Demasiados intentos. Probá de nuevo en unos minutos.' } });
  }

  const { cursoId, codigoDescuento } = req.body.data || {};
  const cursoNombre = sanitizeTexto(req.body.data?.cursoNombre, 200);
  const regalo = req.body.data?.regalo === true;

  const preciosBase = PRECIOS[cursoId];
  if (!cursoId || !cursoNombre || !preciosBase) {
    return res.status(400).json({ error: { status: 'INVALID_ARGUMENT', message: 'Faltan datos del curso.' } });
  }

  const codigoData = await validarCodigo(codigoDescuento, cursoId);
  const descuento = codigoData?.descuento || 0;
  const precioUsd = (preciosBase.usd * (1 - descuento / 100)).toFixed(2);
  const origen = sanitizeOrigen(req.body.data?.origen);

  functions.logger.info('Iniciando crearPagoPaypal', { cursoId, userEmail, precioUsd, descuento });

  try {
    const token = await paypalToken();
    const orderRes = await fetch(`${paypalBase()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'USD', value: precioUsd },
          description: cursoNombre
        }],
        // landing_page GUEST_CHECKOUT hace que el checkout arranque en el
        // formulario de tarjeta en vez de la pantalla de login, para que se
        // pueda pagar sin cuenta de PayPal. Va en experience_context y no en
        // application_context: ese ultimo esta deprecado desde la v2.9 y sus
        // valores aceptados no incluyen GUEST_CHECKOUT. Es una preferencia,
        // no una garantia: PayPal puede ignorarla segun el pais del
        // comprador o si ya tiene sesion abierta.
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Seba Bru Astrología',
              landing_page: 'GUEST_CHECKOUT',
              user_action: 'PAY_NOW',
              return_url: 'https://us-central1-sebabru-e5563.cloudfunctions.net/exitoPaypal',
              cancel_url: `${process.env.SITE_URL}${VUELTA_PAGO[cursoId] ? VUELTA_PAGO[cursoId].corte : '/escuela/abierta/'}`
            }
          }
        }
      })
    });
    const order = await orderRes.json();

    if (!order.id) throw new Error('PayPal no devolvió orden: ' + JSON.stringify(order));

    await _db.collection('ordenes_paypal').doc(order.id).set({
      cursoId,
      cursoNombre,
      userEmail,
      codigoDescuento: codigoData ? codigoDescuento.toUpperCase() : null,
      regalo,
      precioUsd,
      origen,
      status: 'pending',
      creadaEn: admin.firestore.FieldValue.serverTimestamp()
    });

    // Al mandar payment_source, PayPal devuelve el link como 'payer-action'
    // en vez de 'approve' (que es el de las ordenes sin payment_source). Se
    // aceptan los dos para no depender de ese detalle.
    const approveLink = order.links?.find(l => l.rel === 'payer-action' || l.rel === 'approve');
    if (!approveLink) throw new Error('PayPal no devolvio link de aprobacion: ' + JSON.stringify(order.links));
    functions.logger.info('Orden PayPal creada', { orderId: order.id });
    return res.status(200).json({ result: { approve_url: approveLink.href } });

  } catch (error) {
    functions.logger.error('Error en crearPagoPaypal:', { message: error.message });
    // Mensaje generico: el detalle va al log. Los mensajes internos nombran
    // variables de entorno, IDs de planilla y respuestas crudas del proveedor
    // de pago, que no tienen por que viajar al navegador.
    return res.status(500).json({ error: { status: 'INTERNAL', message: 'No se pudo generar el pago. Probá de nuevo en unos minutos.' } });
  }
});

// -------------------------------------------------------
// exitoPaypal
// -------------------------------------------------------
// -------------------------------------------------------
// crearPagoLibro: MercadoPago sin autenticación (libro)
// -------------------------------------------------------
exports.crearPagoLibro = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  if (!(await checkRateLimit('crearPagoLibro', req, 10))) {
    return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
  }

  try {
    const preference = preferenciaMP();

    const result = await preference.create({
      body: {
        items: [{
          title: 'Luna Negra — Lilith en la Carta Natal',
          quantity: 1,
          unit_price: 35000,
          currency_id: 'ARS'
        }],
        back_urls: {
          success: `${process.env.SITE_URL}/lilith/pedido/?metodo=mp`,
          failure: `${process.env.SITE_URL}/lilith/`,
          pending: `${process.env.SITE_URL}/lilith/`
        },
        metadata: { producto: 'libro-lilith', ...origenAMetadata(sanitizeOrigen(req.body?.origen)) },
      }
    });

    functions.logger.info('Preferencia libro creada', { id: result.id });
    return res.status(200).json({ init_point: result.init_point });

  } catch (error) {
    functions.logger.error('Error en crearPagoLibro:', error.message);
    return res.status(500).json({ error: 'No se pudo generar el pago. Probá de nuevo en unos minutos.' });
  }
});

// -------------------------------------------------------
// guardarPedido: Guarda datos de envío del libro
// -------------------------------------------------------
exports.guardarPedido = functions.runWith({ memory: '512MB' }).https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  if (!(await checkRateLimit('guardarPedido', req, 5))) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  const nombre = sanitizeTexto(req.body?.nombre, 200);
  const esquina = sanitizeTexto(req.body?.esquina, 300);
  const email = sanitizeTexto(req.body?.email, 200).toLowerCase();
  const metodo = sanitizeTexto(req.body?.metodo, 50) || 'desconocido';
  const pagoId = sanitizeTexto(req.body?.pagoId, 100) || null;
  const origen = sanitizeOrigen(req.body?.origen);

  if (!nombre || !esquina || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  // A diferencia del resto del circuito de cobro, este endpoint recibia
  // "metodo"/"pagoId" del cliente y marcaba el pedido como "pagado" sin
  // confirmar nada contra Mercado Pago -> cualquiera podia mandar un pagoId
  // inventado. Ahora, si dice ser un pago con MP, se verifica de verdad.
  let estado = metodo === 'transferencia' ? 'transferencia a confirmar' : 'desconocido';
  let monto = metodo === 'transferencia' ? 30000 : null;

  if (metodo === 'mp') {
    if (!pagoId) {
      return res.status(400).json({ error: 'Falta el identificador del pago.' });
    }
    try {
      const paymentClient = pagoMP();
      const payment = await paymentClient.get({ id: pagoId });

      if (payment.status !== 'approved' || payment.metadata?.producto !== 'libro-lilith') {
        functions.logger.warn('guardarPedido: pago no valido para este pedido', { pagoId, status: payment.status, producto: payment.metadata?.producto });
        return res.status(400).json({ error: 'No pudimos verificar ese pago.' });
      }

      // Evita que el mismo pago real se reutilice para crear varios pedidos
      // (direcciones de envio distintas) con un solo pago de verdad.
      const yaUsado = await _db.collection('pedidos').where('pagoId', '==', pagoId).limit(1).get();
      if (!yaUsado.empty) {
        return res.status(409).json({ error: 'Este pago ya tiene un pedido registrado.' });
      }

      estado = 'pagado';
      monto = payment.transaction_amount ?? 35000;
    } catch (error) {
      functions.logger.error('guardarPedido: error verificando pago MP', { pagoId, message: error.message });
      return res.status(400).json({ error: 'No pudimos verificar ese pago.' });
    }
  }

  const pedidoId = uuidv4();

  try {
    await _db.collection('pedidos').doc(pedidoId).set({
      nombre,
      esquina,
      email,
      metodo,
      pagoId,
      origen,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await registrarCompra(`pedido_${pedidoId}`, {
      tipo: 'libro',
      producto: 'libro-lilith',
      nombre: 'Libro Luna Negra',
      metodo: metodo === 'mp' ? 'mercadopago' : metodo,
      monto,
      moneda: 'ARS',
      email,
      estado,
      pagoId,
      origen,
    });

    const filaOrigen = origen
      ? `<tr><td style="padding:10px;border-top:1px solid #eee;color:#888;">Origen</td><td style="padding:10px;border-top:1px solid #eee;">${escapeHtml([origen.source, origen.medium, origen.campaign].filter(Boolean).join(' / ') || (origen.gclid ? 'Google Ads (gclid)' : ''))}</td></tr>`
      : '';

    // A la cola, igual que el de las inscripciones: quien hace el pedido no
    // tiene que esperar el handshake con Gmail. Ver mails.js.
    await mails.encolarMail(_db, {
      para: 'sebruz@gmail.com',
      asunto: `📦 Nuevo pedido Luna Negra — ${nombre}`,
      motivo: 'pedido-libro',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;">
          <h2 style="color:#249b95;">Nuevo pedido: Luna Negra</h2>
          <table style="width:100%;border-collapse:collapse;margin-top:16px;">
            <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;width:160px;">Nombre (DNI)</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(nombre)}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;">Esquina de casa</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(esquina)}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;">Email</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(email)}</td></tr>
            <tr><td style="padding:10px;color:#888;">Método de pago</td><td style="padding:10px;">${escapeHtml(metodo)}</td></tr>
            ${filaOrigen}
          </table>
          <p style="color:#aaa;font-size:0.82em;margin-top:20px;">ID: ${pedidoId}</p>
        </div>
      `,
    });

    functions.logger.info('Pedido guardado', { pedidoId, email, metodo });
    return res.status(200).json({ ok: true });

  } catch (error) {
    functions.logger.error('Error en guardarPedido:', error.message);
    return res.status(500).json({ error: 'No se pudo guardar el pedido. Escribinos a info@sebabru.com si el cobro ya salió.' });
  }
});

// -------------------------------------------------------
// registrarTransferencia: la transferencia del curso se paga por fuera y
// el comprobante va por WhatsApp; esto deja anotado en "compras" que
// alguien aviso que transfirio (y de donde vino), para cruzarlo despues.
// -------------------------------------------------------
exports.registrarTransferencia = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  if (!(await checkRateLimit('registrarTransferencia', req, 10))) {
    return res.status(429).json({ error: 'Demasiados intentos.' });
  }

  const cursoId = sanitizeTexto(req.body?.cursoId, 50);
  const preciosBase = PRECIOS[cursoId];
  if (!preciosBase) return res.status(400).json({ error: 'Curso inválido.' });

  const codigoData = await validarCodigo(sanitizeTexto(req.body?.codigoDescuento, 30), cursoId);
  const descuento = codigoData?.descuento || 0;
  // Mismo calculo que el checkout: transferencia = 10% + el descuento del
  // codigo. Si el producto tiene un precio propio de transferencia (las
  // consultas), ese reemplaza al 10% y el codigo se aplica sobre el.
  const monto = preciosBase.arsTransferencia
    ? Math.round(preciosBase.arsTransferencia * (1 - descuento / 100))
    : Math.round(preciosBase.ars * (1 - (10 + descuento) / 100));

  await registrarCompra(`transferencia_${uuidv4()}`, {
    tipo: 'curso',
    producto: cursoId,
    nombre: sanitizeTexto(req.body?.cursoNombre, 200) || cursoId,
    metodo: 'transferencia',
    monto,
    moneda: 'ARS',
    email: null,
    regalo: req.body?.regalo === true,
    codigoDescuento: codigoData ? sanitizeTexto(req.body?.codigoDescuento, 30).toUpperCase() : null,
    estado: 'transferencia avisada (a confirmar)',
    origen: sanitizeOrigen(req.body?.origen),
  });
  return res.status(200).json({ ok: true });
});

// -------------------------------------------------------
// exitoPaypal
// -------------------------------------------------------
exports.exitoPaypal = functions.https.onRequest(async (req, res) => {
  ensureInit();

  if (!(await checkRateLimit('exitoPaypal', req, 20))) {
    return res.status(429).send('Demasiados intentos. Probá de nuevo en unos minutos.');
  }

  const orderId = req.query.token;
  if (!orderId) return res.redirect(`${process.env.SITE_URL}/escuela/abierta/`);

  try {
    const token = await paypalToken();
    const captureRes = await fetch(`${paypalBase()}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    });
    const capture = await captureRes.json();

    if (capture.status !== 'COMPLETED') {
      functions.logger.error('Captura PayPal no completada', { orderId, status: capture.status });
      return res.redirect(`${process.env.SITE_URL}/escuela/abierta/`);
    }

    // Mismo fix de idempotencia atomica que en mpWebhook (ver comentario ahi).
    const pagoRef = _db.collection('pagos_procesados').doc(`paypal_${orderId}`);
    try {
      await pagoRef.create({ procesadoEn: admin.firestore.FieldValue.serverTimestamp() });
    } catch (e) {
      if (e.code === 6 /* ALREADY_EXISTS */) {
        return res.redirect(`${process.env.SITE_URL}/escuela/abierta/gracias.html`);
      }
      throw e;
    }

    const ordenSnap = await _db.collection('ordenes_paypal').doc(orderId).get();
    if (!ordenSnap.exists) {
      functions.logger.error('Orden PayPal no encontrada en Firestore', { orderId });
      return res.redirect(`${process.env.SITE_URL}/escuela/abierta/gracias.html`);
    }
    const { cursoId, cursoNombre, userEmail, codigoDescuento, regalo, origen: origenCompra } = ordenSnap.data();
    const payerEmail = capture.payer?.email_address || null;
    const esAnonima = !userEmail;
    const porCodigo = regalo || esAnonima;

    const cobrado = capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount;
    await registrarCompra(`paypal_${orderId}`, {
      tipo: 'curso',
      producto: cursoId || null,
      nombre: cursoNombre || cursoId || null,
      metodo: 'paypal',
      monto: cobrado ? Number(cobrado.value) : null,
      moneda: cobrado?.currency_code || 'USD',
      email: (userEmail || payerEmail || '').toLowerCase() || null,
      regalo: !!regalo,
      codigoDescuento: codigoDescuento || null,
      estado: 'pagado',
      pagoId: `paypal_${orderId}`,
      origen: origenCompra || null,
    });

    if (codigoDescuento) {
      await _db.collection('codigos_descuento').doc(codigoDescuento).update({
        usos: admin.firestore.FieldValue.increment(1)
      });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    if (PRODUCTOS_SIN_ACCESO.has(cursoId)) {
      await avisarPagoSinAcceso(transporter, {
        nombreProducto: cursoNombre || cursoId,
        email: userEmail || payerEmail,
        monto: cobrado ? cobrado.value : null,
        moneda: cobrado?.currency_code || 'USD',
        metodo: 'PayPal',
      });
      functions.logger.info('Pago sin acceso avisado', { orderId, cursoId });
      return res.redirect(`${process.env.SITE_URL}${VUELTA_PAGO[cursoId].ok}`);
    }

    if (porCodigo) {
      const destino = userEmail || payerEmail;
      const codigo = await asegurarRegalo(pagoRef, {
        cursoId, cursoNombre, compradorEmail: destino, origen: 'paypal'
      });

      if (destino) {
        await transporter.sendMail({
          from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
          to: destino,
          bcc: 'espaciointeriorastrologia@gmail.com',
          subject: regalo ? `Tu código de regalo: ${cursoNombre}` : `Tu código de acceso: ${cursoNombre}`,
          html: emailRegaloHtml(cursoNombre, codigo, regalo)
        });
      } else {
        functions.logger.warn('Pago PayPal por codigo sin email de destino', { orderId, codigo });
        await avisarCodigoSinDestino(transporter, {
          nombreProducto: cursoNombre, codigo, pagoId: `paypal_${orderId}`, metodo: 'PayPal',
        });
      }

      functions.logger.info('Codigo PayPal generado', { destino, cursoId, codigo, regalo, esAnonima });
      const param = regalo ? 'regalo=1' : 'acceso=1';
      return res.redirect(`${process.env.SITE_URL}/escuela/abierta/gracias.html?metodo=paypal&${param}&codigo=${encodeURIComponent(codigo)}&paymentId=${encodeURIComponent('paypal_' + orderId)}`);
    }

    await _db.collection('usuarios').doc(userEmail).set({
      cursos: admin.firestore.FieldValue.arrayUnion(cursoId)
    }, { merge: true });

    functions.logger.info('Acceso PayPal otorgado', { userEmail, cursoId });

    const invToken = uuidv4();
    const inviteUrl = `${process.env.SITE_URL}/escuela/invitacion/?token=${invToken}`;

    await _db.collection('invitaciones').doc(invToken).set({
      token: invToken,
      cursoId,
      cursoUrl: CURSO_URLS[cursoId] || '/escuela/abierta/',
      emailDestino: userEmail,
      usada: false,
      creadaEn: admin.firestore.FieldValue.serverTimestamp(),
      paymentId: `paypal_${orderId}`,
      tipo: 'pago'
    });

    await transporter.sendMail({
      from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
      to: userEmail,
      bcc: 'espaciointeriorastrologia@gmail.com',
      subject: `Tu acceso al curso: ${cursoNombre}`,
      html: emailAccesoHtml(cursoNombre, inviteUrl, userEmail)
    });

    functions.logger.info('Email PayPal enviado', { userEmail, cursoId, invToken });
    res.redirect(`${process.env.SITE_URL}/escuela/abierta/gracias.html`);

  } catch (error) {
    functions.logger.error('Error en exitoPaypal:', { message: error.message });
    res.redirect(`${process.env.SITE_URL}/escuela/abierta/`);
  }
});

// -------------------------------------------------------
// crearEnlace: admin crea un enlace maestro multi-uso
// -------------------------------------------------------
exports.crearEnlace = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debés iniciar sesion.');
  }
  const ADMINS = ['sebruz@gmail.com', 'espaciointeriorastrologia@gmail.com'];
  const email = (context.auth.token.email || '').toLowerCase();
  if (!ADMINS.includes(email)) {
    throw new functions.https.HttpsError('permission-denied', 'Solo admins pueden crear enlaces.');
  }
  ensureInit();

  const cursoId     = String(data?.cursoId || '').trim();
  const cursoNombre = String(data?.cursoNombre || cursoId).trim();
  const maxUsos     = Math.min(Math.max(parseInt(data?.maxUsos) || 20, 1), 500);
  const dias        = Math.min(Math.max(parseInt(data?.dias) || 7, 1), 365);

  if (!cursoId) {
    throw new functions.https.HttpsError('invalid-argument', 'cursoId requerido.');
  }

  const { randomBytes } = require('crypto');
  const token = randomBytes(12).toString('hex');

  const expiraEn = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);

  await _db.collection('enlaces').doc(token).set({
    cursoId,
    cursoNombre,
    activo: true,
    maxUsos,
    usos: 0,
    expiraEn,
    creadoEn: admin.firestore.FieldValue.serverTimestamp(),
  });

  functions.logger.info('Enlace creado', { email, cursoId, token, maxUsos, dias });
  return { token };
});

// -------------------------------------------------------
// activarEnlace: enlace maestro multi-uso para talleres
// Firestore: enlaces/{token} = { cursoId, cursoNombre, activo, expiraEn, maxUsos, usos }
// -------------------------------------------------------
exports.activarEnlace = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debés iniciar sesion.');
  }
  ensureInit();

  const userEmail = (context.auth.token.email || '').toLowerCase().trim();
  if (!userEmail) {
    throw new functions.https.HttpsError('failed-precondition', 'Tu cuenta no tiene un email asociado.');
  }

  const token = String(data?.token || '').trim();
  if (!token) {
    throw new functions.https.HttpsError('invalid-argument', 'Token requerido.');
  }

  const enlaceRef = _db.collection('enlaces').doc(token);

  const result = await _db.runTransaction(async tx => {
    const snap = await tx.get(enlaceRef);
    if (!snap.exists) {
      throw new functions.https.HttpsError('not-found', 'Enlace invalido.');
    }
    const e = snap.data();
    if (!e.activo) {
      throw new functions.https.HttpsError('permission-denied', 'Este enlace esta desactivado.');
    }
    if (e.expiraEn && e.expiraEn.toDate && e.expiraEn.toDate() < new Date()) {
      throw new functions.https.HttpsError('permission-denied', 'Este enlace ya expiro.');
    }
    if (e.maxUsos && (e.usos || 0) >= e.maxUsos) {
      throw new functions.https.HttpsError('resource-exhausted', 'Este enlace alcanzo su limite de usos.');
    }
    tx.update(enlaceRef, { usos: admin.firestore.FieldValue.increment(1) });
    return { cursoId: e.cursoId, cursoNombre: e.cursoNombre };
  });

  const { cursoId, cursoNombre } = result;
  const userRef = _db.collection('usuarios').doc(userEmail);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({
      cursos: [cursoId],
      cohorte: '2026',
      fechaRegistro: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await userRef.update({ cursos: admin.firestore.FieldValue.arrayUnion(cursoId) });
  }

  functions.logger.info('Enlace activado', { userEmail, cursoId, token });
  return {
    cursoId,
    cursoNombre: cursoNombre || cursoId,
    cursoUrl: CURSO_URLS[cursoId] || '/escuela/',
  };
});

// -------------------------------------------------------
// registrarInscripcion: motor generico para formularios de inscripcion a
// eventos puntuales (seminarios, cursos cortos). Cada instancia nueva es
// solo una entrada mas en FORMULARIOS_INSCRIPCION -- no requiere tocar el
// resto de esta funcion. Cada respuesta se agrega como fila a una pestaña
// propia dentro del Google Sheets de SHEETS_SPREADSHEET_ID (se crea sola si
// todavia no existe) y se avisa por mail, igual que guardarPedido.
// -------------------------------------------------------
// A donde llegan los avisos de cada inscripcion (pedido de Seba, 2026-11).
const AVISOS_INSCRIPCION = 'info@sebabru.com';

// El consentimiento para la newsletter, aparte de la inscripcion: quien
// pide una consulta entra en la lista de consultas igual (es comunicacion
// sobre algo que pidio), pero a la lista de lunaciones solo entra si marca
// el casillero, que en el formulario viene desmarcado. Va como "campo
// final" para que la columna caiga al final de la planilla, y asi queda
// escrito con fecha, que es el respaldo si alguien alguna vez pregunta de
// donde salio su direccion.
const CAMPO_NOVEDADES = { key: 'novedades', label: 'Quiere novedades', maxLen: 3, opciones: ['Sí', 'No'] };

const FORMULARIOS_INSCRIPCION = {
  'tu-identidad-en-el-cielo': {
    hoja: 'Identidad astral',
    columnaCarta: 'Carta',
    nombreEvento: 'Tu identidad en el cielo',
    camposFinales: [CAMPO_NOVEDADES],
    brevoLista: 'alumnos',
    campos: [
      { key: 'nombre', label: 'Nombre', maxLen: 200, requerido: true },
      { key: 'telefono', label: 'Teléfono', maxLen: 50, requerido: true },
      { key: 'fechaNacimiento', label: 'Fecha de nacimiento', maxLen: 20, requerido: true },
      { key: 'horaNacimiento', label: 'Hora de nacimiento', maxLen: 20, requerido: true },
      { key: 'lugarNacimiento', label: 'Lugar de nacimiento', maxLen: 200, requerido: true },
      { key: 'email', label: 'Email', maxLen: 200, requerido: true },
      // Al final, para no correr las columnas que ya tenia la planilla.
      { key: 'modalidad', label: 'Modalidad', maxLen: 20, requerido: true, opciones: ['Presencial', 'Online'] },
    ],
    // La carta de cada inscripto se guarda en "Mis cartas" de la
    // calculadora de esta cuenta, con el nombre del curso como grupo.
    carta: { para: 'sebruz@gmail.com', grupo: 'Tu identidad en el cielo' },
    // Mail de confirmacion a quien se inscribe, con su carta en PDF
    // (lo manda enviarCartaInscripcion). A quien cursa online, con el Zoom.
    confirmacion: {
      asunto: 'Tu inscripción a Tu identidad en el cielo',
      parrafos: (nombre, conCarta, modalidad) => [
        `Hola, ${nombre}:`,
        '¡Gracias por inscribirte a <em>Tu identidad en el cielo</em>! Ya tenemos tus datos.',
        conCarta ? 'Te mando adjunta tu carta natal, calculada con los datos que nos pasaste (fecha, hora y lugar de nacimiento). Revisá que estén bien: si algo no coincide, respondé este mail y la corregimos.' : '',
        modalidad === 'Online'
          ? 'Unite a la reunión de Zoom con este enlace:<br><a href="https://us02web.zoom.us/j/87111385793?pwd=upJRRWmCEdancwG80rDo6u9QKKPSIo.1">https://us02web.zoom.us/j/87111385793?pwd=upJRRWmCEdancwG80rDo6u9QKKPSIo.1</a><br>Meeting ID: 871 1138 5793<br>Passcode: Astro2025'
          : modalidad === 'Presencial'
            ? 'Pedile la información sobre cómo llegar a Clari: +5493544559877.'
            : '',
        'Para datos del pago podés escribirle a Clari al +5493544584122.',
        '¡Nos vemos pronto!<br>Seba',
      ].filter(Boolean),
    },
  },
  consultas: {
    hoja: 'Consultas',
    // Las consultas van a su propia planilla, no a la de las inscripciones.
    // Se resuelve al atender el pedido, no al cargar el archivo: asi, si la
    // variable no esta, se nota con un error en vez de escribir en la
    // planilla de las inscripciones.
    spreadsheetEnv: 'SHEETS_SPREADSHEET_CONSULTAS',
    etiquetaFecha: 'Fecha del pedido',
    // Seba le agrega columnas propias a esta hoja, asi que cada valor se
    // ubica por el titulo de su columna (ver asegurarHojaInscripcion).
    columnasPorEncabezado: true,
    columnaCarta: 'Carta',
    columnasFijas: { Regalo: 'No' },
    nombreEvento: 'Consulta astrológica',
    camposFinales: [CAMPO_NOVEDADES],
    brevoLista: 'consultas',
    campos: [
      { key: 'nombre', label: 'Nombre', maxLen: 200, requerido: true },
      { key: 'telefono', label: 'Teléfono', maxLen: 50, requerido: true },
      { key: 'email', label: 'Email', maxLen: 200, requerido: true },
      { key: 'fechaNacimiento', label: 'Fecha de nacimiento', maxLen: 20, requerido: true },
      { key: 'horaNacimiento', label: 'Hora de nacimiento', maxLen: 20, requerido: true },
      { key: 'lugarNacimiento', label: 'Lugar de nacimiento', maxLen: 200, requerido: true },
      { key: 'modalidad', label: 'Modalidad', maxLen: 20, requerido: true, opciones: ['Presencial', 'Online'] },
      { key: 'lugarCumpleanos', label: 'Dónde pasó el cumpleaños', maxLen: 200 },
      { key: 'comentario', label: 'Algo más que quiera que sepamos', maxLen: 2000 },
    ],
    carta: { para: 'sebruz@gmail.com', grupo: 'Consultas' },
    // Despues de este formulario se elige el dia y la hora en
    // /consultas/agenda/ (ver el bloque AGENDA DE CONSULTAS).
    agenda: true,
    confirmacion: {
      asunto: 'Tu consulta astrológica',
      parrafos: (nombre, conCarta, modalidad, urlAgenda) => [
        `Hola, ${nombre}:`,
        'Recibimos tu pedido de consulta. Ya tenemos tus datos.',
        conCarta ? 'Te mando adjunta tu carta natal, calculada con los datos que nos pasaste (fecha, hora y lugar de nacimiento). Revisá que estén bien: si algo no coincide, respondé este mail y la corregimos.' : '',
        // Si por lo que sea no hay agenda (falta el secreto, falló el alta
        // del pedido), el mail vuelve a decir lo de antes: nunca un enlace
        // que no lleva a ningún lado.
        urlAgenda
          ? `Falta una sola cosa: elegir el día y la hora de tu sesión.<br><a href="${urlAgenda}">Elegí el día y la hora</a><br>Con ese mismo enlace podés cambiarla o cancelarla después.`
          : 'El tiempo de espera para una sesión es de entre una y dos semanas: te escribimos para coordinar el día y la hora.',
        modalidad === 'Online'
          ? 'El encuentro es por Zoom, con este enlace:<br><a href="https://us02web.zoom.us/j/8020861967?pwd=Gl9uLBofVZd0XmzTPhAHnQDc8RtnsE.1">https://us02web.zoom.us/j/8020861967?pwd=Gl9uLBofVZd0XmzTPhAHnQDc8RtnsE.1</a><br>Meeting ID: 802 086 1967<br>Passcode: paso'
          : modalidad === 'Presencial'
            ? 'Pedile la información sobre cómo llegar a Clari: +5493544559877.'
            : '',
        '¡Nos vemos pronto!<br>Seba',
      ].filter(Boolean),
    },
  },

  // La consulta que alguien regala: quien la recibe solo carga sus datos.
  // Va a la misma hoja que las demas, marcada en la columna Regalo, para que
  // la agenda se lea de un solo lado. Nada de precios ni de pago: eso ya lo
  // arreglo quien la regalo.
  'consultas-regalo': {
    hoja: 'Consultas',
    spreadsheetEnv: 'SHEETS_SPREADSHEET_CONSULTAS',
    etiquetaFecha: 'Fecha del pedido',
    columnasPorEncabezado: true,
    columnaCarta: 'Carta',
    columnasFijas: { Regalo: 'Sí' },
    nombreEvento: 'Consulta regalada',
    camposFinales: [CAMPO_NOVEDADES],
    brevoLista: 'consultas',
    campos: [
      { key: 'nombre', label: 'Nombre', maxLen: 200, requerido: true },
      { key: 'telefono', label: 'Teléfono', maxLen: 50, requerido: true },
      { key: 'email', label: 'Email', maxLen: 200, requerido: true },
      { key: 'fechaNacimiento', label: 'Fecha de nacimiento', maxLen: 20, requerido: true },
      { key: 'horaNacimiento', label: 'Hora de nacimiento', maxLen: 20, requerido: true },
      { key: 'lugarNacimiento', label: 'Lugar de nacimiento', maxLen: 200, requerido: true },
      { key: 'modalidad', label: 'Modalidad', maxLen: 20, requerido: true, opciones: ['Presencial', 'Online'] },
      { key: 'lugarCumpleanos', label: 'Dónde pasó el cumpleaños', maxLen: 200 },
      { key: 'regalaQuien', label: 'Quién la regaló', maxLen: 200 },
      { key: 'comentario', label: 'Algo más que quiera que sepamos', maxLen: 2000 },
    ],
    carta: { para: 'sebruz@gmail.com', grupo: 'Consultas' },
    agenda: true,
    confirmacion: {
      asunto: 'Tu consulta astrológica',
      parrafos: (nombre, conCarta, modalidad, urlAgenda) => [
        `Hola, ${nombre}:`,
        'Recibimos tus datos para la consulta que te regalaron. Está todo listo de tu lado.',
        conCarta ? 'Te mando adjunta tu carta natal, calculada con los datos que nos pasaste (fecha, hora y lugar de nacimiento). Revisá que estén bien: si algo no coincide, respondé este mail y la corregimos.' : '',
        urlAgenda
          ? `Falta una sola cosa: elegir el día y la hora de tu sesión.<br><a href="${urlAgenda}">Elegí el día y la hora</a><br>Con ese mismo enlace podés cambiarla o cancelarla después.`
          : 'El tiempo de espera para una sesión es de entre una y dos semanas: te escribimos para coordinar el día y la hora.',
        modalidad === 'Online'
          ? 'El encuentro es por Zoom, con este enlace:<br><a href="https://us02web.zoom.us/j/8020861967?pwd=Gl9uLBofVZd0XmzTPhAHnQDc8RtnsE.1">https://us02web.zoom.us/j/8020861967?pwd=Gl9uLBofVZd0XmzTPhAHnQDc8RtnsE.1</a><br>Meeting ID: 802 086 1967<br>Passcode: paso'
          : modalidad === 'Presencial'
            ? 'Pedile la información sobre cómo llegar a Clari: +5493544559877.'
            : '',
        '¡Nos vemos pronto!<br>Seba',
      ].filter(Boolean),
    },
  },
};

// Carta de una inscripcion para la calculadora (sebabru.com/cartas): con
// el lugar elegido en el buscador del formulario (coordenadas y zona
// horaria ya resueltas). Si algo no cierra, devuelve null y la inscripcion
// sigue igual (queda en la planilla y en el mail).
function cartaDeInscripcion(valores, lugar, grupo) {
  const f = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(valores.fechaNacimiento || '');
  const h = /^(\d{2}):(\d{2})$/.exec(valores.horaNacimiento || '');
  if (!f || !h || !lugar || typeof lugar !== 'object') return null;
  const [, d, m, a] = f;
  const fecha = new Date(Date.UTC(+a, +m - 1, +d));
  if (fecha.getUTCMonth() !== +m - 1 || fecha.getUTCDate() !== +d || +a < 1800) return null;
  if (+h[1] > 23 || +h[2] > 59) return null;
  const lat = Number(lugar.lat);
  const lon = Number(lugar.lon);
  const zona = sanitizeTexto(lugar.zona, 64);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(zona)) return null;
  const texto = (k, n) => sanitizeTexto(lugar[k], n) || undefined;
  const datosLugar = Object.fromEntries(Object.entries({
    nombre: texto('nombre', 200), provincia: texto('provincia', 200), pais: texto('pais', 3),
    paisNombre: texto('paisNombre', 100), lat, lon, zona,
  }).filter(([, v]) => v !== undefined));
  return {
    nombre: (valores.nombre || '').slice(0, 60),
    fecha: `${a}-${m}-${d}`,
    hora: `${h[1]}:${h[2]}`,
    lugar: datosLugar,
    correccion: null,
    eleccion: 0,
    tipo: 'natal',
    grupo: grupo.slice(0, 60),
    guardada: new Date().toISOString(),
  };
}

const _uidPorEmail = new Map();
async function guardarCartaInscripcion(config, carta) {
  if (!_uidPorEmail.has(config.carta.para)) {
    _uidPorEmail.set(config.carta.para, (await admin.auth().getUserByEmail(config.carta.para)).uid);
  }
  const uid = _uidPorEmail.get(config.carta.para);
  await _db.collection('tucarta_usuarios').doc(uid).collection('cartas').add(carta);
}

// PDF de una carta natal, igual a la impresion de la calculadora: abre
// sebabru.com/cartas/#hoja=... en un Chrome del servidor y la imprime. Las
// librerias se cargan recien aca (son pesadas y el resto de las funciones
// no las usa). CHROME_LOCAL: un Chrome de la compu, para probar.
async function pdfDeCarta(carta) {
  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');
  const { nombre, fecha, hora, lugar } = carta;
  const hoja = Buffer.from(JSON.stringify({ nombre, fecha, hora, lugar })).toString('base64url');
  const url = `${process.env.CARTAS_URL || 'https://sebabru.com/cartas/'}#hoja=${hoja}`;
  const browser = await puppeteer.launch({
    args: process.env.CHROME_LOCAL ? [] : chromium.args,
    defaultViewport: { width: 1000, height: 1400 },
    executablePath: process.env.CHROME_LOCAL || await chromium.executablePath(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction('window.hojaLista || window.hojaError', { timeout: 60000 });
    const error = await page.evaluate('window.hojaError');
    if (error) throw new Error(`La hoja no se pudo armar: ${error}`);
    await page.emulateMediaType('print');
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  } finally {
    await browser.close();
  }
}

let _sheetsClient;
function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const auth = new JWT({
    email: process.env.SHEETS_CLIENT_EMAIL,
    key: (process.env.SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  // @googleapis/sheets es grande y solo lo usan los formularios: se carga
  // aca, no al cargar el archivo.
  const { sheets: sheetsApi } = require('@googleapis/sheets');
  _sheetsClient = sheetsApi({ version: 'v4', auth });
  return _sheetsClient;
}

// Crea la pestaña (con fila de encabezados) si todavia no existe en el
// documento -- asi sumar un formulario nuevo no requiere crear la hoja a mano.
// Devuelve los titulos que tiene la fila 1, que es lo que usa el modo
// columnasPorEncabezado para saber en que columna va cada valor.
// Lo que esta funcion ya averiguo en esta instancia, para no volver a
// preguntarselo a Sheets en cada envio. Se cachean dos cosas, y solo dos,
// porque son las que no pueden cambiar a nuestras espaldas:
//
//   - que la pestana existe: nadie borra una pestana con datos adentro;
//   - que fila 1 ya tiene los encabezados que escribimos nosotros, en las
//     hojas que NO son columnasPorEncabezado (ahi la fila 1 es toda nuestra).
//
// Los titulos de una hoja columnasPorEncabezado NO se cachean a proposito:
// Seba le agrega columnas a mano a la de consultas, y si una columna nueva
// entra en el medio, cachear las posiciones significaria escribir valores en
// la columna equivocada. Ese values.get de la fila 1 se paga siempre.
const _hojasVistas = new Set();
const _encabezadosEscritos = new Map();

// En que planilla escribe un formulario. Un formulario puede traer la suya
// por variable de entorno (consultas), fija en la config, o caer en la de
// las inscripciones.
function planillaDeFormulario(config) {
  return (config.spreadsheetEnv && process.env[config.spreadsheetEnv])
    || config.spreadsheet || process.env.SHEETS_SPREADSHEET_ID;
}

// Los titulos de la fila 1, en el orden en que se armaron siempre: la fecha,
// los campos del formulario, la columna Carta, las columnas fijas y recien
// al final los campos "finales". Ese orden importa: un campo nuevo del
// formulario no tiene que correr ninguna columna que ya tenga datos.
//
// Esta funcion existe porque ahora la fila la escribe el trigger, no el
// endpoint: los dos tienen que estar de acuerdo en los titulos.
function encabezadosDeFormulario(config) {
  const encabezados = [
    config.etiquetaFecha || 'Fecha de inscripción',
    ...config.campos.map(c => c.label),
  ];
  if (config.columnaCarta) encabezados.push(config.columnaCarta);
  for (const titulo of Object.keys(config.columnasFijas || {})) encabezados.push(titulo);
  for (const c of config.camposFinales || []) encabezados.push(c.label);
  return encabezados;
}

function filaDeFormulario(config, titulos, valores, estadoCarta, ahora) {
  const etiquetaFecha = config.etiquetaFecha || 'Fecha de inscripción';
  if (config.columnasPorEncabezado) {
    // Cada valor va en la columna que lleva su titulo, sin importar en que
    // posicion quedo: asi la hoja se puede reordenar o ampliar a mano.
    const porTitulo = { [etiquetaFecha]: ahora };
    for (const c of config.campos) porTitulo[c.label] = valores[c.key] || '';
    if (config.columnaCarta) porTitulo[config.columnaCarta] = estadoCarta;
    Object.assign(porTitulo, config.columnasFijas || {});
    for (const c of config.camposFinales || []) porTitulo[c.label] = valores[c.key] || '';
    return titulos.map(t => (t in porTitulo ? porTitulo[t] : ''));
  }
  const fila = [ahora, ...config.campos.map(c => valores[c.key] || '')];
  if (config.columnaCarta) fila.push(estadoCarta);
  fila.push(...Object.values(config.columnasFijas || {}));
  fila.push(...(config.camposFinales || []).map(c => valores[c.key] || ''));
  return fila;
}

// La cola de la planilla. Dos trabajos distintos:
//   tipo 'inscripcion' -> agrega la fila de un formulario
//   tipo 'sesion'      -> escribe el dia y la hora de un turno
// La vacia el trigger escribirFilaPlanilla. Como encolarMail y
// encolarContactoBrevo, nunca tira: una inscripcion no se cae porque Sheets
// este de mal humor.
async function encolarFilaPlanilla(datos) {
  try {
    // Igual que encolarMail y encolarContactoBrevo: con id, el documento se
    // llama asi, y un trigger que se repite reescribe este en vez de pedir
    // una segunda fila. Una fila duplicada en la planilla no se nota.
    const { id, ...resto } = datos;
    const destino = id
      ? _db.collection('filas_planilla').doc(String(id))
      : _db.collection('filas_planilla').doc();
    await destino.set({
      ...resto,
      creado: new Date().toISOString(),
    });
  } catch (error) {
    functions.logger.error('No se pudo encolar la fila de la planilla:', error.message);
  }
}

async function asegurarHojaInscripcion(sheets, spreadsheetId, nombreHoja, encabezados, porEncabezado) {
  const clave = spreadsheetId + '|' + nombreHoja;

  // El spreadsheets.get trae la metadata del documento entero y es la
  // llamada mas cara de las tres: solo se usa para saber si la pestana
  // existe, asi que una vez por instancia alcanza.
  let existe = _hojasVistas.has(clave);
  if (!existe) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    existe = (meta.data.sheets || []).some(s => s.properties.title === nombreHoja);
    if (existe) _hojasVistas.add(clave);
  }

  if (existe) {
    if (porEncabezado) {
      // Modo para hojas que alguien mas edita a mano: la fila 1 no se pisa.
      // Solo se agregan al final los titulos que falten, asi las columnas
      // propias que haya agregado (donde sea) quedan intactas.
      const filaUno = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${nombreHoja}!1:1` });
      const actuales = (filaUno.data.values && filaUno.data.values[0]) || [];
      const faltan = encabezados.filter(t => !actuales.includes(t));
      if (!faltan.length) return actuales;
      const todos = [...actuales, ...faltan];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${nombreHoja}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [todos] },
      });
      return todos;
    }
    // Si el formulario sumo campos, los titulos de la fila 1 se ponen al dia
    // (los campos nuevos van al final, asi que las columnas viejas no se mueven).
    // Si ya los escribimos en esta instancia y son los mismos, no hay nada
    // que poner al dia: esta fila 1 es nuestra, no la toca nadie mas.
    const firma = JSON.stringify(encabezados);
    if (_encabezadosEscritos.get(clave) === firma) return encabezados;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${nombreHoja}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [encabezados] },
    });
    _encabezadosEscritos.set(clave, firma);
    return encabezados;
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: nombreHoja } } }] },
  });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${nombreHoja}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [encabezados] },
  });
  _hojasVistas.add(clave);
  if (!porEncabezado) _encabezadosEscritos.set(clave, JSON.stringify(encabezados));
  return encabezados;
}

exports.registrarInscripcion = functions.runWith({ memory: '512MB' }).https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  // La decision se toma aca, como siempre. Lo que se posterga es solo
  // anotar el envio en el contador: eso viaja abajo, junto con la escritura
  // del pedido, en vez de ser un viaje propio a Firestore. Ver mirarRitmo.
  const ritmo = await mirarRitmo('registrarInscripcion', req, 10);
  if (!ritmo.ok) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  // A partir del 3er envio desde la misma IP (en la ventana de 10 min de
  // checkRateLimit), pedimos un captcha de Cloudflare Turnstile resuelto.
  // Los primeros 2 pasan libres para no molestar a quien se equivoca en el
  // formulario o se anota con un amigx desde la misma conexion.
  const intentos = req._intentos || 1;
  if (intentos > 2) {
    const captchaOk = await verificarTurnstile(sanitizeTexto(req.body?.captchaToken, 2000), req);
    if (!captchaOk) {
      return res.status(400).json({ error: 'captcha_requerido' });
    }
  }

  const formId = sanitizeTexto(req.body?.formId, 100);
  const config = FORMULARIOS_INSCRIPCION[formId];
  if (!config) {
    return res.status(400).json({ error: 'Formulario no reconocido.' });
  }

  const camposRecibidos = (req.body?.campos && typeof req.body.campos === 'object') ? req.body.campos : {};
  const valores = {};
  for (const campo of [...config.campos, ...(config.camposFinales || [])]) {
    const valor = sanitizeTexto(camposRecibidos[campo.key], campo.maxLen);
    if (campo.requerido && !valor) {
      return res.status(400).json({ error: `Falta el campo obligatorio: ${campo.label}` });
    }
    if (campo.opciones && valor && !campo.opciones.includes(valor)) {
      return res.status(400).json({ error: `Elegí una opción en: ${campo.label}` });
    }
    valores[campo.key] = valor;
  }

  // El enlace al agendador, si el formulario lo usa. Se arma despues de
  // escribir la fila y viaja en la respuesta para que el formulario muestre
  // el boton "Elegi el dia y la hora".
  let urlAgenda = null;

  try {
    // La planilla ya no se escribe aca. Era el segundo costo del envio (dos
    // a cinco segundos contra la API de Sheets, a veces cuatro viajes) y es
    // una fila que lee Seba, no quien se esta inscribiendo. Se encola en
    // filas_planilla y la escribe el trigger escribirFilaPlanilla.
    //
    // Del entorno si se sigue desconfiando aca mismo, que no cuesta nada: si
    // el formulario declara su propia planilla por variable de entorno y esa
    // variable no llego al deploy, antes la fila caia en silencio en la
    // planilla de las inscripciones y aparecia en otro lado con un 200 de
    // respuesta. Eso tiene que fallar, y tiene que fallar a la vista.
    if (config.spreadsheetEnv && !process.env[config.spreadsheetEnv]) {
      throw new Error(`Falta ${config.spreadsheetEnv} en el entorno de la función (formulario ${formId})`);
    }
    if (!planillaDeFormulario(config)) throw new Error(`Falta la planilla del formulario ${formId}`);

    // La carta se arma antes de encolar la fila, asi la planilla dice si
    // salio sola o si hay que hacerla a mano (pasa cuando el lugar de
    // nacimiento no esta en el buscador y la persona lo escribe igual). Es
    // calculo, no I/O: no suma espera.
    const carta = config.carta ? cartaDeInscripcion(valores, req.body?.lugar, config.carta.grupo) : null;
    const estadoCarta = carta ? 'Sí' : 'No: el lugar no se eligió de la lista';
    const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

    // Y aca esta todo lo que queda del camino critico: UNA escritura.
    //
    // Antes eran dos viajes a Firestore en fila: primero el pedido de la
    // agenda (habia que esperarlo porque su id va en la respuesta) y recien
    // despues las otras cuatro escrituras. Ahora el id se saca con .doc(),
    // que lo arma la libreria SIN ir a la red, asi que el enlace de la
    // agenda se puede firmar antes de escribir y todo entra en una sola
    // escritura. De ahi en adelante trabaja un trigger.
    //
    // El piso es este y no se puede bajar: en una function v1 la instancia
    // se congela despues del res.send(), asi que contestar sin haber
    // guardado nada no seria "procesarlo despues", seria perderlo.
    const pendiente = {
      formId,
      valores,
      carta,
      estadoCarta,
      ahora,
      // La marca que el trigger mira para saber que esto es una inscripcion
      // sin procesar.
      pendiente: true,
      creado: new Date().toISOString(),
    };

    let ref;
    if (config.agenda) {
      // Paso 2 de una consulta: elegir el dia y la hora en
      // /consultas/agenda/. Esto se escribe como el pedido mismo y no en una
      // coleccion aparte a proposito: pedidoDeAgenda hace un get() de
      // agenda_pedidos y contesta token_invalido si no existe, asi que si el
      // pedido lo creara el trigger, quien aprieta "Elegi el dia y la hora"
      // enseguida se encontraria la agenda cerrada.
      ref = _db.collection('agenda_pedidos').doc();
      urlAgenda = urlDeAgenda(ref.id);
      Object.assign(pendiente, {
        origen: 'formulario',
        nombre: valores.nombre || '',
        email: valores.email || '',
        telefono: valores.telefono || '',
        modalidad: valores.modalidad || '',
        // La escribe escribirFilaPlanilla cuando la fila quede en la hoja.
        filaPlanilla: null,
        turnoId: null,
        urlAgenda,
      });
    } else {
      // Los formularios sin agenda (las inscripciones a cursos) no tienen
      // pedido: su carga va a su propia coleccion, que atiende el mismo
      // trigger.
      ref = _db.collection('inscripciones_pendientes').doc();
    }

    // Las dos escrituras que quedan, juntas: el pedido y la anotacion del
    // contador de ritmo, que se decidio arriba y se anota aca.
    //
    // La del contador se traga su error a proposito. Si tirara, el catch de
    // abajo contestaria 500 con el pedido ya escrito y el trigger
    // procesandolo igual: la persona veria un error, lo mandaria de nuevo y
    // se inscribiria dos veces. Un contador de abuso no puede tirar abajo
    // una inscripcion.
    await Promise.all([
      ref.set(pendiente),
      ritmo.anotar().catch(error => {
        functions.logger.error('No se pudo anotar el envio en el contador:', error.message);
      }),
    ]);

    functions.logger.info('Inscripción recibida', {
      formId, id: ref.id, coleccion: config.agenda ? 'agenda_pedidos' : 'inscripciones_pendientes',
    });
    return res.status(200).json({ ok: true, agenda: urlAgenda });

  } catch (error) {
    functions.logger.error('Error en registrarInscripcion:', error.message);
    return res.status(500).json({ error: 'No se pudo registrar la inscripción. Probá de nuevo en unos minutos.' });
  }
});

// -------------------------------------------------------
// enviarCartaInscripcion: el mail de confirmacion a quien se inscribe,
// con su carta natal en PDF. Se dispara con cada envio que deja
// registrarInscripcion en envios_carta. Si no hay carta (no eligio el lugar
// de la lista) o el PDF falla, la confirmacion sale igual, sin el adjunto, y
// a Seba le llega un aviso para mandarla a mano.
// -------------------------------------------------------
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

exports.enviarCartaInscripcion = onDocumentCreated({
  document: 'envios_carta/{id}',
  database: 'cursos',
  region: 'us-central1',
  memory: '2GiB',
  timeoutSeconds: 120,
  maxInstances: 3,
}, async (event) => {
  ensureInit();
  const envio = event.data?.data();
  const config = FORMULARIOS_INSCRIPCION[envio?.formId];
  if (!envio || !config?.confirmacion) return;

  let pdf = null;
  let motivo = envio.carta ? '' : 'no eligió el lugar de la lista';
  if (envio.carta) {
    try {
      pdf = await pdfDeCarta(envio.carta);
    } catch (error) {
      motivo = error.message;
      functions.logger.error('No se pudo armar el PDF de la carta:', error.message);
    }
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  const nombre = escapeHtml((envio.nombre || '').split(' ')[0] || 'hola');
  // El cuarto dato es el enlace al agendador: va en el mail para quien
  // cerro la pestaña antes de elegir el dia.
  const parrafos = config.confirmacion.parrafos(nombre, Boolean(pdf), envio.modalidad, envio.urlAgenda || null);
  await transporter.sendMail({
    from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
    to: envio.email,
    subject: config.confirmacion.asunto,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;">
      ${parrafos.map((p) => `<p>${p}</p>`).join('')}
    </div>`,
    text: parrafos.join('\n\n').replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''),
    attachments: pdf ? [{
      filename: `Carta natal - ${(envio.nombre || 'Tu carta').replace(/[^\p{L}\p{N} .-]/gu, '').trim() || 'Tu carta'}.pdf`,
      content: pdf,
      contentType: 'application/pdf',
    }] : [],
  });

  if (!pdf) {
    await transporter.sendMail({
      from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
      to: AVISOS_INSCRIPCION,
      subject: `Confirmación sin carta — ${config.nombreEvento}`,
      html: `<p>A ${escapeHtml(envio.nombre)} (${escapeHtml(envio.email)}) le llegó la confirmación de la inscripción <strong>sin</strong> la carta en PDF: ${escapeHtml(motivo)}. Mandásela a mano.</p>`,
    });
  }
  await event.data.ref.update({ enviado: new Date().toISOString(), conCarta: Boolean(pdf), motivo: motivo || null });
  functions.logger.info('Confirmación enviada', { formId: envio.formId, conCarta: Boolean(pdf) });
});

// -------------------------------------------------------
// fijarClaimsAdmin: la calculadora de cartas (tucarta) usa esto para que el
// "modo admin" (importar la planilla de inscripciones) deje de depender
// solo de un chequeo en el JS del navegador. El cliente manda su propio ID
// token; acá se verifica server-side y, si el email verificado está en
// ADMINS_TUCARTA, se deja el custom claim {admin:true} puesto en esa
// cuenta. Cualquier cuenta puede llamar esto, pero solo puede marcarse a sí
// misma -- nunca a otra.
// -------------------------------------------------------
const ADMINS_TUCARTA = ['sebruz@gmail.com', 'espaciointeriorastrologia@gmail.com'];

exports.fijarClaimsAdmin = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'Falta el token de sesión.' });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido.' });
  }

  const esAdminTucarta = ADMINS_TUCARTA.includes((decoded.email || '').toLowerCase());
  if (esAdminTucarta && decoded.admin !== true) {
    await admin.auth().setCustomUserClaims(decoded.uid, { admin: true });
  }
  return res.status(200).json({ admin: esAdminTucarta });
});
// -------------------------------------------------------
// Respaldo del buscador de lugares
// -------------------------------------------------------
// El indice de sebabru.com/cartas tiene Argentina, Uruguay y España enteros
// y del resto del mundo solo las localidades de mas de 1000 habitantes. Un
// paraje o un pueblito chico de afuera no aparece. Cuando el buscador local
// no encuentra nada, el formulario pregunta aca y nosotros le preguntamos a
// GeoNames, que es de donde sale el indice: asi un resultado de afuera se ve
// igual que uno de adentro.
//
// Sin GEONAMES_USER en el .env la funcion contesta vacio: el buscador queda
// exactamente como estaba.

// En Argentina la zona horaria va por provincia (zone.tab), no por el
// poligono que usa GeoNames. Es la misma tabla que arma el indice local, y
// tiene que seguir igual: si no, la misma persona obtendria dos cartas
// distintas segun por que camino encontro su lugar.
const ZONA_AR_GEONAMES = {
  '01': 'Buenos_Aires', '07': 'Buenos_Aires',
  '05': 'Cordoba', '21': 'Cordoba', '22': 'Cordoba', '03': 'Cordoba',
  '09': 'Cordoba', '14': 'Cordoba', '08': 'Cordoba', '06': 'Cordoba',
  '17': 'Salta', '11': 'Salta', '15': 'Salta', '16': 'Salta',
  '10': 'Jujuy', '24': 'Tucuman', '02': 'Catamarca', '04': 'Catamarca',
  '12': 'La_Rioja', '18': 'San_Juan', '13': 'Mendoza', '19': 'San_Luis',
  '20': 'Rio_Gallegos', '23': 'Ushuaia'
};

// El mismo orden que el indice local: primero el publico de la casa.
const PRIORIDAD_PAIS = { AR: 3, UY: 2, ES: 1 };

// Poblados (PPL*) y parajes (LCTY). Afuera quedan cerros, arroyos, estancias
// y las localidades historicas o abandonadas.
const CODIGOS_LUGAR = /^(PPL|PPLA|PPLA2|PPLA3|PPLA4|PPLC|PPLF|PPLG|PPLL|PPLS|PPLX|STLMT|LCTY)$/;

const cacheLugares = new Map(); // texto buscado -> { hora, lugares }
const CACHE_LUGARES_MAX = 500;
const CACHE_LUGARES_MS = 24 * 60 * 60 * 1000;

function lugarDeGeoNames(g) {
  if (!g || !CODIGOS_LUGAR.test(g.fcode || '')) return null;
  const lat = Number(g.lat);
  const lon = Number(g.lng);
  const zonaGeo = g.timezone && g.timezone.timeZoneId;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !zonaGeo) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  let zona = zonaGeo;
  if (g.countryCode === 'AR') {
    const z = ZONA_AR_GEONAMES[g.adminCode1];
    if (!z) return null; // Antartida: sin provincia, no sabemos la zona
    zona = 'America/Argentina/' + z;
  }
  if (!/^[A-Za-z0-9_+\-/]+$/.test(zona)) return null;

  return {
    nombre: sanitizeTexto(g.name, 200),
    provincia: sanitizeTexto(g.adminName1 || '', 200),
    pais: sanitizeTexto(g.countryCode || '', 3),
    paisNombre: sanitizeTexto(g.countryName || '', 100),
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4,
    zona,
    poblacion: Number(g.population) || 0,
  };
}

// Avisa que GeoNames dejo de atender (cuota agotada, o la cuenta sin
// habilitar). Como el error se repite en cada consulta hasta que se arregla,
// manda un solo mail cada 6 horas y no uno por intento.
const AVISO_GEONAMES_CADA_MS = 6 * 60 * 60 * 1000;

async function avisarGeoNamesCaido(estado) {
  try {
    const ref = _db.collection('avisos').doc('geonames');
    const puedeAvisar = await _db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const ahora = Date.now();
      if (snap.exists && (ahora - (snap.data().ultimo || 0)) < AVISO_GEONAMES_CADA_MS) return false;
      tx.set(ref, { ultimo: ahora, mensaje: estado.message || '', codigo: estado.value ?? null });
      return true;
    });
    if (!puedeAvisar) return;

    // Esto corre adentro de buscarLugar, que es el typeahead del lugar de
    // nacimiento: se dispara mientras la persona escribe. Mandar el mail en
    // linea le cobraba el handshake con Gmail a una tecla. A la cola.
    await mails.encolarMail(_db, {
      para: AVISOS_INSCRIPCION,
      asunto: 'El buscador de lugares se quedó sin respaldo',
      motivo: 'geonames-caido',
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;">
        <p>GeoNames dejó de contestar, así que el buscador de los formularios
        volvió a funcionar solo con el índice propio: los parajes y los pueblos
        chicos de afuera no van a aparecer hasta que se normalice.</p>
        <p>Los formularios siguen andando. Quien no encuentre su lugar lo va a
        mandar igual, y esos pedidos quedan con <strong>Carta: No</strong> en la
        planilla para hacerlos a mano.</p>
        <p>Lo que contestó GeoNames:<br><em>${escapeHtml(estado.message || 'sin mensaje')}</em></p>
        <p>Si es la cuota por hora, se arregla solo. Si se repite seguido, hay
        que revisar el tope por IP o pasar a una cuenta paga.</p>
      </div>`,
    });
  } catch (error) {
    // Avisar es lo secundario: si falla, no rompemos la busqueda.
    functions.logger.error('No se pudo avisar que GeoNames no atiende:', error.message);
  }
}

exports.buscarLugar = functions.https.onRequest(async (req, res) => {
  ensureInit();
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const usuario = process.env.GEONAMES_USER;
  const q = sanitizeTexto(req.query.q, 80);
  // Sin cuenta configurada, o con menos de 3 letras, no hay respaldo: el
  // buscador local sigue siendo el unico, como antes.
  if (!usuario || !q || q.length < 3) return res.json({ lugares: [] });

  const clave = q.toLowerCase();
  const guardado = cacheLugares.get(clave);
  if (guardado && Date.now() - guardado.hora < CACHE_LUGARES_MS) {
    return res.json({ lugares: guardado.lugares });
  }

  // GeoNames da 1.000 consultas por hora para todo el sitio, asi que una
  // sola IP no puede llevarselas puestas. Llenar el formulario gasta una o
  // dos: 30 cada 10 minutos deja margen de sobra y frena a un bot enseguida.
  // Pasarse no rompe nada: se pierde el respaldo, no el formulario.
  if (!await checkRateLimit('buscarLugar', req, 30)) {
    return res.status(429).json({ lugares: [] });
  }

  try {
    const params = new URLSearchParams({
      name_startsWith: q,
      maxRows: '20',
      style: 'FULL',
      lang: 'es',
      orderby: 'relevance',
      username: usuario,
    });
    // Poblados y parajes (el resto lo filtra CODIGOS_LUGAR).
    params.append('featureClass', 'P');
    params.append('featureClass', 'L');

    // Si GeoNames tarda, no dejamos esperando a la persona: el formulario
    // se queda con lo que ya tenia.
    const corte = AbortSignal.timeout(5000);
    const r = await fetch(`http://api.geonames.org/searchJSON?${params}`, { signal: corte });
    if (!r.ok) throw new Error('GeoNames respondio ' + r.status);
    const data = await r.json();

    if (data.status) {
      // Cuota agotada o cuenta sin habilitar. El buscador sigue andando con
      // el indice local, asi que nadie se daria cuenta: por eso avisamos.
      functions.logger.error('GeoNames no atendio', data.status);
      await avisarGeoNamesCaido(data.status);
      return res.json({ lugares: [] });
    }

    const lugares = (data.geonames || [])
      .map(lugarDeGeoNames)
      .filter(Boolean)
      .sort((a, b) =>
        (PRIORIDAD_PAIS[b.pais] || 0) - (PRIORIDAD_PAIS[a.pais] || 0) ||
        b.poblacion - a.poblacion)
      .slice(0, 8)
      .map(({ poblacion, ...l }) => l);

    if (cacheLugares.size >= CACHE_LUGARES_MAX) cacheLugares.clear();
    cacheLugares.set(clave, { hora: Date.now(), lugares });
    return res.json({ lugares });
  } catch (error) {
    functions.logger.error('No se pudo preguntar a GeoNames:', error.message);
    return res.json({ lugares: [] });
  }
});

// -------------------------------------------------------
// suscribir: el alta a la newsletter desde el formulario del sitio, con
// doble opt-in. Brevo guarda el contacto sin confirmar y lo mete en la
// lista recien cuando la persona hace clic en el mail que le llega, asi la
// lista solo tiene direcciones de gente que quiso estar (y que existe).
//
// Es el unico lugar que le habla a Brevo en linea, porque aca Brevo ES el
// flujo: sin el no hay nada que contestar. Igual tiene plan B, abajo.
// -------------------------------------------------------

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// De donde se puede suscribir alguien. Es una lista cerrada a proposito:
// el atributo ORIGEN de Brevo no puede ser texto libre que venga del
// navegador.
const ORIGENES_SUSCRIPCION = new Set([
  'home', 'lunanueva', 'lunallena', 'kit', 'links', 'suscribirse', 'formulario',
  'ebook', 'cartas',
]);

// Que mail sale al darse de alta. Casi siempre la bienvenida; desde la
// pagina del regalo, el que lleva al libro — ahi la persona no vino a
// suscribirse, vino por el ebook, y recibir una bienvenida en su lugar
// seria no darle lo que le prometimos.
function plantillaDeAlta(origen) {
  if (origen === 'ebook' && process.env.BREVO_EBOOK_TEMPLATE_ID) {
    return process.env.BREVO_EBOOK_TEMPLATE_ID;
  }
  return process.env.BREVO_BIENVENIDA_TEMPLATE_ID;
}

// Los errores de tipeo mas comunes en el dominio. No se rechaza la
// direccion: se le ofrece la correccion, que es lo que salva la
// suscripcion.
const DOMINIOS_TIPEADOS = {
  'gmail.con': 'gmail.com', 'gmai.com': 'gmail.com', 'gmial.com': 'gmail.com',
  'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com', 'gamil.com': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'hotmai.com': 'hotmail.com',
  'yahoo.co': 'yahoo.com', 'outlook.con': 'outlook.com', 'icloud.con': 'icloud.com',
};

// Verifica que el dominio del mail tenga servidores de correo. Es lo que
// reemplaza al doble opt-in para atajar los rebotes: una direccion mal
// tipeada como "gmial.com" no tiene MX, asi que se rechaza en el momento y
// la persona la corrige. Los rebotes duros son lo que hace que Brevo
// suspenda una cuenta, asi que esta es la defensa principal.
//
// Si la consulta falla o tarda, deja pasar: mejor un contacto de mas que
// trabar a alguien por un problema de DNS nuestro.
async function dominioRecibeCorreo(dominio) {
  if (!dominio) return false;
  try {
    const mx = await Promise.race([
      dnsPromesas.resolveMx(dominio),
      // 1,5 s: una consulta de MX que tarda mas que eso no va a contestar,
      // y mientras tanto la persona espera con el boton en Enviando...
      new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('timeout')), 1500)),
    ]);
    return Array.isArray(mx) && mx.length > 0;
  } catch (error) {
    // El dominio no existe: error de tipeo seguro.
    if (error.code === 'ENOTFOUND' || error.code === 'NXDOMAIN') return false;

    // ENODATA: el dominio existe pero no tiene MX. Pasa con los dominios
    // registrados para aprovechar errores de tipeo, como gmial.com. El
    // estandar permite caer al registro A cuando no hay MX, asi que antes
    // de rechazar miramos si hay alguno: si tampoco hay, no hay forma de
    // que reciba correo.
    if (error.code === 'ENODATA') {
      try {
        const direcciones = await dnsPromesas.resolve4(dominio).catch(() => dnsPromesas.resolve6(dominio));
        return Array.isArray(direcciones) && direcciones.length > 0;
      } catch (_) {
        return false;
      }
    }

    // Timeout, servidor caido, lo que sea: no sabemos, no bloqueamos.
    functions.logger.warn('No pude revisar el correo del dominio', { dominio, error: error.code || error.message });
    return true;
  }
}

exports.suscribir = functions.runWith({ memory: '512MB' }).https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  // Mas bajo que en los formularios de inscripcion: nadie se suscribe cinco
  // veces en diez minutos.
  if (!(await checkRateLimit('suscribir', req, 5))) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  // Honeypot: un campo que la persona no ve y que los bots llenan igual. Se
  // contesta que salio todo bien y no se hace nada, asi el bot no aprende
  // que fue descubierto.
  if (sanitizeTexto(req.body?.hp, 200)) {
    functions.logger.info('Suscripción descartada por el honeypot.');
    return res.status(200).json({ ok: true, estado: 'suscrito' });
  }

  // El captcha desde el primer envio, al contrario de registrarInscripcion,
  // que deja pasar los dos primeros. Un formulario de un campo es el blanco
  // favorito de los bots de listas, y el widget invisible no molesta a
  // nadie.
  if (!(await verificarTurnstile(sanitizeTexto(req.body?.captchaToken, 2000), req))) {
    return res.status(400).json({ error: 'captcha_requerido' });
  }

  const email = sanitizeTexto(req.body?.email, 200).toLowerCase();
  if (!EMAIL_VALIDO.test(email)) {
    return res.status(400).json({ error: 'email_invalido' });
  }

  const [parte, dominio] = email.split('@');
  if (DOMINIOS_TIPEADOS[dominio]) {
    return res.status(400).json({
      error: 'email_sospechoso',
      sugerencia: `${parte}@${DOMINIOS_TIPEADOS[dominio]}`,
    });
  }

  if (req.body?.consentimiento !== true) {
    return res.status(400).json({ error: 'consentimiento_requerido' });
  }

  // Sin doble opt-in, esta es la unica barrera contra las direcciones que no
  // existen. Va despues del captcha para que nadie pueda usar el endpoint
  // como un escaner de dominios.
  if (!(await dominioRecibeCorreo(dominio))) {
    return res.status(400).json({ error: 'dominio_sin_correo', dominio });
  }

  const nombre = sanitizeTexto(req.body?.nombre, 100);
  const origenCrudo = sanitizeTexto(req.body?.origen, 40);
  const origen = ORIGENES_SUSCRIPCION.has(origenCrudo) ? origenCrudo : 'otro';

  // Como se dio el consentimiento, para poder distinguirlos despues. Decia
  // 'doi-sitio' por el doble opt-in, que se saco el 2026-11-12: ya no hay
  // paso de confirmacion, asi que el valor mentia.
  //
  // En el regalo del ebook el consentimiento es el intercambio: la persona
  // sabe que deja su mail para recibir el libro y queda en la lista, y lo
  // apreta a proposito. Queda anotado distinto porque es un trato distinto,
  // y si alguna vez hay que revisar de donde salio una direccion, importa.
  const atributos = {
    ORIGEN: origen,
    UTM: utmComoTexto(sanitizeOrigen(req.body?.utm)),
    FECHA_ALTA: brevo.fechaBrevo(new Date()),
    CONSENTIMIENTO: origen === 'ebook' ? 'canje-ebook' : 'boton-sitio',
  };

  // La constancia del consentimiento queda tambien de este lado, no solo en
  // Brevo: con fecha, origen e IP. Es lo que prueba de donde salio cada
  // direccion si alguna vez alguien pregunta, y sobrevive a un cambio de
  // proveedor de mailing.
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const anotarPedido = async estado => {
    try {
      await _db.collection('suscripciones').doc(email).set({
        email,
        origen,
        nombre: nombre || '',
        ip,
        userAgent: sanitizeTexto(req.headers['user-agent'], 300),
        estado,
        pedido: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (error) {
      functions.logger.error('No se pudo anotar la suscripción:', error.message);
    }
  };

  // Sin la llave de Brevo no hay alta posible. El pedido se guarda para no
  // perder a nadie, pero se dice la verdad en vez de contestar que salio
  // bien. Pasa si el formulario se publica antes de configurar Brevo.
  if (!brevo.brevoConfigurado()) {
    functions.logger.error('Alguien quiso suscribirse y BREVO_API_KEY no esta configurada.');
    await encolarContactoBrevo({ email, nombre, listas: ['suscriptores'], atributos, motivo: 'suscripcion' });
    await anotarPedido('sin_configurar');
    return res.status(503).json({ error: 'no_configurado' });
  }

  try {
    // Si ya esta en la lista, no se le manda otro mail de bienvenida: si
    // no, el formulario serviria para molestar a cualquiera cargando su
    // direccion una y otra vez.
    const contacto = await brevo.obtenerContacto(email);
    const idSuscriptores = brevo.idsDeListas(['suscriptores'])[0];
    if (contacto && idSuscriptores && (contacto.listIds || []).includes(idSuscriptores)) {
      // La respuesta es la MISMA que la de un alta nueva, a proposito. Antes
      // contestaba estado 'ya_suscrito', y con eso cualquiera podia averiguar
      // si una direccion ajena estaba en la lista. Queda anotado en el log y
      // en "suscripciones", que es donde hace falta saberlo. El texto que ve
      // la persona no promete un mail nuevo, asi que sirve en los dos casos.
      await anotarPedido('ya_suscrito');
      functions.logger.info('Alta de alguien que ya estaba en la lista', { origen });
      return res.status(200).json({ ok: true, estado: 'suscrito' });
    }

    // Alta directa, sin paso de confirmacion. Lo que cuida que la direccion
    // sea de verdad es el captcha (desde el primer envio), la trampa para
    // bots, el control de tipeos y la revision de MX de mas arriba.
    await brevo.upsertContacto({ email, nombre, listas: ['suscriptores'], atributos });

    // El mail es un agregado: si falla, la persona ya quedo suscrita igual
    // y no tiene sentido devolverle un error por eso.
    // El mail y la constancia son dos cosas independientes: encadenarlas
    // sumaba el viaje a Brevo y el de Firestore uno detras del otro. Ninguna
    // de las dos puede tirar (cada una se traga su error), asi que el
    // Promise.all no necesita catch.
    const mandarBienvenida = (async () => {
      try {
        await brevo.enviarConPlantilla({
          email, nombre,
          templateId: plantillaDeAlta(origen),
          params: { baja: urlDeBaja(email) },
          headers: cabecerasDeBaja(email),
        });
      } catch (error) {
        functions.logger.error('No se pudo mandar el mail del alta:', error.message);
      }
    })();

    await Promise.all([mandarBienvenida, anotarPedido('suscrito')]);
    functions.logger.info('Suscripción nueva', { origen });
    return res.status(200).json({ ok: true, estado: 'suscrito' });

  } catch (error) {
    // Brevo no contesto. En vez de perder a quien se quiso suscribir, el
    // alta queda en la cola y el trigger la reintenta.
    functions.logger.error('Brevo no respondió al dar el alta:', error.message);
    await encolarContactoBrevo({ email, nombre, listas: ['suscriptores'], atributos, motivo: 'suscripcion' });
    await anotarPedido('reintentando');
    return res.status(200).json({ ok: true, estado: 'demorado' });
  }
});

// -------------------------------------------------------
// enviarMailEncolado: el que vacia la cola de mails_salientes. Los
// formularios y los pagos encolan el mail en vez de mandarlo en el momento,
// porque el handshake SMTP con Gmail son dos a seis segundos y en un
// onRequest eso se le cobra a quien esta esperando del otro lado. Ver
// mails.js, que es donde esta la logica.
//
// retry en true: un rato malo de Gmail no pierde el aviso. Que no mande dos
// veces lo cuida mails.js con la marca enviado, porque los triggers de
// Firestore son at-least-once.
// -------------------------------------------------------
exports.enviarMailEncolado = onDocumentCreated({
  document: 'mails_salientes/{id}',
  database: 'cursos',
  region: 'us-central1',
  retry: true,
  maxInstances: 3,
}, async (event) => {
  ensureInit();
  if (!event.data) return;
  await mails.enviarMailEncolado(event.data.ref);
});

// -------------------------------------------------------
// procesarInscripcion: todo lo que el formulario ya no espera.
//
// registrarInscripcion contesta despues de una sola escritura y de ahi en
// adelante trabaja esto: la fila en la planilla, la carta guardada, la
// confirmacion con el PDF, el alta en el mailing y el aviso a Seba.
//
// Son dos triggers porque hay dos colecciones (un formulario con agenda
// escribe su pedido, uno sin agenda escribe en la coleccion suelta), pero la
// logica es una sola y esta en procesarPendiente.
//
// retry en true: un rato malo de Firestore no pierde una inscripcion. Que no
// se procese dos veces lo cuida la marca "pendiente", que se apaga al final.
// -------------------------------------------------------
const OPCIONES_TRIGGER_INSCRIPCION = {
  database: 'cursos',
  region: 'us-central1',
  retry: true,
  maxInstances: 3,
};

exports.procesarInscripcion = onDocumentCreated({
  ...OPCIONES_TRIGGER_INSCRIPCION,
  document: 'inscripciones_pendientes/{id}',
}, (event) => procesarPendiente(event));

// Este tambien se dispara con los pedidos que crea iniciarAgenda (los de la
// agenda suelta, origen 'directo'): procesarPendiente los deja pasar porque
// no tienen la marca.
exports.procesarPedidoDeAgenda = onDocumentCreated({
  ...OPCIONES_TRIGGER_INSCRIPCION,
  document: 'agenda_pedidos/{id}',
}, (event) => procesarPendiente(event));

async function procesarPendiente(event) {
  ensureInit();
  if (!event.data) return;
  const ref = event.data.ref;

  // event.data es la foto del momento de la creacion. Con retry en true esto
  // puede correr dos veces, asi que se vuelve a leer: los triggers de
  // Firestore son at-least-once y mandar la confirmacion dos veces se nota.
  const snap = await ref.get();
  if (!snap.exists) return;
  const d = snap.data();

  // Un pedido de la agenda suelta, o algo que ya se proceso.
  if (!d.pendiente) return;

  const config = FORMULARIOS_INSCRIPCION[d.formId];
  if (!config) {
    // Un formulario que ya no existe: no hay reintento que lo arregle.
    functions.logger.error('Inscripcion pendiente de un formulario desconocido', { formId: d.formId });
    await ref.update({ pendiente: false, error: 'formulario_desconocido' });
    return;
  }

  const valores = d.valores || {};
  const tieneMail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valores.email || '');
  // Solo los formularios con agenda guardan su pedido en agenda_pedidos: ese
  // id es el que necesita la fila para despues decir donde quedo.
  const pedidoId = config.agenda ? ref.id : null;

  // Todo lo que se encola abajo lleva un nombre derivado del id de esta
  // inscripcion, y no uno al azar. Es lo que hace que este trigger sea
  // repetible: si el update del final falla, el reintento reescribe los
  // mismos cuatro documentos en lugar de pedir una segunda fila en la
  // planilla y un segundo aviso. Los cuatro los consume un
  // onDocumentCreated, asi que reescribirlos no dispara nada.

  // Las cuatro cosas son independientes entre si y cada una se traga su
  // error: que falle una no puede dejar las otras sin hacer. Lo unico que no
  // se traga nada es el update final, que es el que marca esto como hecho.
  const guardarCartaYAvisar = (async () => {
    let cartaGuardada = false;
    if (d.carta) {
      try {
        await guardarCartaInscripcion(config, d.carta);
        cartaGuardada = true;
      } catch (error) {
        functions.logger.error('No se pudo guardar la carta de la inscripción:', error.message);
      }
    }

    const filasHtml = [...config.campos, ...(config.camposFinales || [])].map(c =>
      `<tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;width:180px;">${escapeHtml(c.label)}</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(valores[c.key] || '—')}</td></tr>`
    ).join('') + (config.carta
      ? `<tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;width:180px;">Carta</td><td style="padding:10px;border-bottom:1px solid #eee;">${cartaGuardada
        ? `Guardada en tus cartas de <a href="https://sebabru.com/cartas/">sebabru.com/cartas</a> (${escapeHtml(config.carta.grupo)})`
        : 'No se guardó: el lugar no se eligió de la lista. Cargala a mano.'}</td></tr>`
      : '');

    await mails.encolarMail(_db, {
      id: `inscripcion-${ref.id}`,
      para: AVISOS_INSCRIPCION,
      asunto: `📝 Nueva inscripción — ${config.nombreEvento}`,
      motivo: `inscripcion:${d.formId}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;">
          <h2 style="color:#249b95;">Nueva inscripción: ${escapeHtml(config.nombreEvento)}</h2>
          <table style="width:100%;border-collapse:collapse;margin-top:16px;">
            ${filasHtml}
          </table>
        </div>
      `,
    });
  })();

  // La confirmacion (con la carta en PDF) la manda enviarCartaInscripcion,
  // aparte: armar el PDF tarda y pesa 2 GiB de memoria.
  const pedirConfirmacion = (async () => {
    if (!config.confirmacion || !tieneMail) return;
    try {
      await _db.collection('envios_carta').doc(ref.id).set({
        formId: d.formId,
        email: valores.email,
        nombre: valores.nombre || '',
        modalidad: valores.modalidad || null,
        carta: d.carta || null,
        urlAgenda: d.urlAgenda || null,
        creado: new Date().toISOString(),
      });
    } catch (error) {
      functions.logger.error('No se pudo pedir el mail de confirmación:', error.message);
    }
  })();

  // El alta en el mailing. A la lista del formulario entra siempre; a la de
  // lunaciones, solo si marco el casillero.
  const altaEnElMailing = (async () => {
    if (!tieneMail) return;
    const quiereNovedades = valores.novedades === 'Sí';
    await encolarContactoBrevo({
      id: `inscripcion-${ref.id}`,
      email: valores.email,
      nombre: valores.nombre || '',
      listas: [
        ...(config.brevoLista ? [config.brevoLista] : []),
        ...(quiereNovedades ? ['suscriptores'] : []),
      ],
      atributos: {
        ORIGEN: `formulario-${d.formId}`,
        CONSENTIMIENTO: quiereNovedades ? 'formulario-checkbox' : 'relacion-comercial',
        TELEFONO_TXT: valores.telefono || '',
      },
      motivo: `inscripcion:${d.formId}`,
    });
  })();

  await Promise.all([
    encolarFilaPlanilla({
      id: `inscripcion-${ref.id}`,
      tipo: 'inscripcion', formId: d.formId, pedidoId,
      valores, estadoCarta: d.estadoCarta || '', ahora: d.ahora || '',
    }),
    guardarCartaYAvisar,
    pedirConfirmacion,
    altaEnElMailing,
  ]);

  // Recien ahora se apaga la marca: si algo de arriba tira, el reintento
  // vuelve a entrar en vez de dar la inscripcion por procesada. Y se borra la
  // carga cruda, que ya no hace falta y son los datos de nacimiento de una
  // persona guardados dos veces.
  await ref.update({
    pendiente: false,
    procesado: new Date().toISOString(),
    valores: admin.firestore.FieldValue.delete(),
    carta: admin.firestore.FieldValue.delete(),
  });
  functions.logger.info('Inscripción procesada', { formId: d.formId, id: ref.id });
}

// -------------------------------------------------------
// escribirFilaPlanilla: el que vacia la cola de filas_planilla. La API de
// Sheets son dos a cinco segundos y nada de lo que escribe lo mira quien
// esta esperando del otro lado: la fila la lee Seba.
//
// retry en true: un rato malo de Sheets no pierde la fila. Y hace falta por
// otra razon, que esta explicada en escribirSesionDeLaCola: cuando el turno
// llega antes que la fila del formulario, el reintento es el que espera.
// -------------------------------------------------------
exports.escribirFilaPlanilla = onDocumentCreated({
  document: 'filas_planilla/{id}',
  database: 'cursos',
  region: 'us-central1',
  retry: true,
  maxInstances: 3,
}, async (event) => {
  ensureInit();
  if (!event.data) return;
  const ref = event.data.ref;

  // event.data es la foto del momento en que se creo el documento. Con
  // retry en true esto puede correr dos veces, asi que se vuelve a leer para
  // ver la marca de "ya escrito": los triggers de Firestore son
  // at-least-once y una fila duplicada en la planilla no se nota.
  const snap = await ref.get();
  if (!snap.exists) return;
  const trabajo = snap.data();
  if (trabajo.escrito) {
    functions.logger.info('La fila ya estaba escrita, no se repite', { id: ref.id });
    return;
  }

  if (trabajo.tipo === 'sesion') await escribirSesionDeLaCola(trabajo);
  else await escribirInscripcionDeLaCola(trabajo);

  await ref.update({ escrito: new Date().toISOString() });
});

// La fila de un formulario. Es lo que hacia registrarInscripcion antes de
// contestar.
async function escribirInscripcionDeLaCola(trabajo) {
  const config = FORMULARIOS_INSCRIPCION[trabajo.formId];
  if (!config) {
    // Un formulario que ya no existe: no hay reintento que lo arregle.
    functions.logger.error('Fila encolada de un formulario desconocido', { formId: trabajo.formId });
    return;
  }
  const spreadsheetId = planillaDeFormulario(config);
  if (!spreadsheetId) throw new Error(`Falta la planilla del formulario ${trabajo.formId}`);

  const sheets = getSheetsClient();
  const titulos = await asegurarHojaInscripcion(
    sheets, spreadsheetId, config.hoja, encabezadosDeFormulario(config), config.columnasPorEncabezado
  );
  const fila = filaDeFormulario(config, titulos, trabajo.valores || {}, trabajo.estadoCarta || '', trabajo.ahora || '');

  // El rango es la columna A, no A1: con A1, Sheets estira la "tabla" a
  // todas las columnas pegadas y, si alguna arrastra formato o una formula
  // hasta el fondo de la hoja, la fila nueva termina mil filas mas abajo,
  // lejos de los datos. Mirando solo la columna A (la fecha, que siempre
  // escribimos nosotros) cae siempre despues del ultimo pedido.
  const escrito = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${config.hoja}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [fila] },
  });
  const rango = escrito.data?.updates?.updatedRange || null;

  // En que planilla y en que celdas quedo, para no tener que adivinar cuando
  // alguien no encuentra una fila.
  functions.logger.info('Fila agregada', {
    formId: trabajo.formId,
    planilla: spreadsheetId,
    rango: rango || '(no lo dijo)',
    columnas: titulos.length,
  });

  // Y se le avisa al pedido donde quedo su fila, que es lo que despues
  // permite escribir el dia y la hora del turno en esa misma fila en vez de
  // en una nueva.
  if (trabajo.pedidoId && rango) {
    await _db.collection('agenda_pedidos').doc(trabajo.pedidoId).set({ filaPlanilla: rango }, { merge: true });
  }
}

// El dia y la hora de un turno.
async function escribirSesionDeLaCola(trabajo) {
  const snap = await _db.collection('agenda_pedidos').doc(trabajo.pedidoId).get();
  if (!snap.exists) {
    functions.logger.error('Sesion encolada de un pedido que no existe', { pedidoId: trabajo.pedidoId });
    return;
  }
  const pedido = snap.data();

  // Aca esta la carrera que trajo encolar las dos cosas: si alguien llena el
  // formulario y elige el horario enseguida, el turno puede llegar antes que
  // la fila. Entonces no se agrega una fila nueva (seria la segunda de la
  // misma persona, y nadie se enteraria): se tira, y el reintento del
  // trigger vuelve en unos segundos, cuando la fila ya este.
  if (pedido.origen !== 'directo' && !pedido.filaPlanilla) {
    throw new Error('la fila del formulario todavia no esta en la planilla: se reintenta');
  }

  const filaNueva = await escribirSesionEnPlanilla(pedido, trabajo.inicioMs);
  if (filaNueva) {
    await snap.ref.set({ filaPlanilla: filaNueva }, { merge: true });
  }
}

// -------------------------------------------------------
// sincronizarContactoBrevo: el que vacia la cola de brevo_contactos. Cada
// compra y cada inscripcion deja ahi un pedido en vez de llamar a Brevo en
// el momento, asi un problema del mailing no puede demorar ni romper un
// cobro.
//
// retry en true: si Brevo esta caido, Cloud Functions reintenta solo. Pero
// un error permanente (una direccion que Brevo rechaza) no se reintenta al
// infinito: se anota en el documento y queda ahi para mirarlo.
// -------------------------------------------------------

const { onDocumentWritten } = require('firebase-functions/v2/firestore');

exports.sincronizarContactoBrevo = onDocumentCreated({
  document: 'brevo_contactos/{id}',
  database: 'cursos',
  region: 'us-central1',
  retry: true,
  maxInstances: 3,
}, async (event) => {
  ensureInit();
  const pedido = event.data?.data();
  if (!pedido || !EMAIL_VALIDO.test(pedido.email || '')) return;

  // Sin llave no hay nada que hacer, y reintentarlo no la va a traer.
  if (!brevo.brevoConfigurado()) {
    functions.logger.warn('Pedido de mailing sin BREVO_API_KEY: queda en la cola.', { id: event.params.id });
    return;
  }

  try {
    if (pedido.doi) {
      await brevo.pedirDobleOptin({
        email: pedido.email,
        nombre: pedido.nombre,
        atributos: pedido.atributos,
        listas: pedido.listas,
        redirectUrl: pedido.redirectUrl,
      });
    } else {
      await brevo.upsertContacto({
        email: pedido.email,
        nombre: pedido.nombre,
        listas: pedido.listas,
        atributos: pedido.atributos,
        quitarDeListas: pedido.quitarDeListas,
      });
    }
    // Listo: la cola no tiene por que crecer.
    await event.data.ref.delete();
  } catch (error) {
    const permanente = error instanceof brevo.BrevoError
      && error.status >= 400 && error.status < 500 && error.status !== 429;

    if (permanente) {
      functions.logger.error('Brevo rechazó el contacto, no se reintenta:', { message: error.message, code: error.code });
      await event.data.ref.update({
        error: String(error.message).slice(0, 500),
        fallo: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }
    // Transitorio: que lo reintente Cloud Functions.
    throw error;
  }
});

// -------------------------------------------------------
// La baja de la lista de correo.
//
// POR QUE HAY QUE HACERLA NOSOTROS
//
// El tag {{ unsubscribe }} de Brevo es de CAMPANAS. Los mails de
// bienvenida y del ebook no salen como campana: salen como transaccional
// por /smtp/email con templateId, y en ese canal Brevo no sustituye el
// tag — el href queda vacio y el enlace no existe. Lo comprobamos el
// 2026-11-13 con el tag puesto dos veces en cada plantilla.
//
// Lo que SI funciona en un transaccional son los params, asi que la URL
// se calcula aca y viaja como {{ params.baja }}.
//
// El token es un HMAC del mail: sin el, la URL seria adivinable y
// cualquiera podria dar de baja a cualquiera cambiando la direccion.
// -------------------------------------------------------
function tokenDeBaja(email) {
  const secreto = process.env.BAJA_SECRET;
  // Sin secreto no se firma: un HMAC con clave vacia lo calcula cualquiera,
  // asi que seria peor que no tener token.
  if (!secreto) return null;
  return crypto.createHmac('sha256', secreto)
    .update(String(email).trim().toLowerCase())
    .digest('hex')
    .slice(0, 24);
}

function urlDeBaja(email) {
  const token = tokenDeBaja(email);
  // Sin secreto configurado, la salida es la pagina de privacidad, que
  // explica como pedir la baja por mail. Nunca un enlace que no funciona.
  if (!token) return `${process.env.SITE_URL || 'https://sebabru.com'}/privacidad/`;
  const e = encodeURIComponent(String(email).trim().toLowerCase());
  return `${process.env.SITE_URL || 'https://sebabru.com'}/baja/?e=${e}&t=${token}`;
}

// Las cabeceras estandar de baja (RFC 8058). Con esto Gmail muestra su
// propio boton "Cancelar suscripcion" al lado del remitente, que es donde
// mucha gente lo busca antes de leer el pie. Si no hay secreto, no se
// mandan: una cabecera de un clic que apunta a /privacidad no cumple nada.
function cabecerasDeBaja(email) {
  if (!tokenDeBaja(email)) return undefined;
  return {
    'List-Unsubscribe': `<${urlDeBaja(email)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// -------------------------------------------------------
// altaEnNovedades: el alta en la lista de correo cuando alguien marca un
// casillero del sitio (el modal de la escuela o la calculadora).
//
// Manda la bienvenida, que no es un lujo: es el primer aviso de que quedo
// en la lista. Sin ella, la primera campana le llega a alguien que no se
// acuerda de haberse anotado, y eso se denuncia como spam.
// -------------------------------------------------------
async function altaEnNovedades({ email, nombre, origen, consentimiento }) {
  // Si el contacto ya existia, no le pisamos el origen: el de la compra o
  // del formulario dice mas que "escuela".
  const existente = await brevo.obtenerContacto(email);

  await brevo.upsertContacto({
    email,
    nombre: nombre || '',
    listas: ['suscriptores'],
    atributos: existente ? {} : {
      ORIGEN: origen,
      CONSENTIMIENTO: consentimiento,
      FECHA_ALTA: brevo.fechaBrevo(new Date()),
    },
  });

  // La bienvenida es un agregado: la persona ya quedo en la lista, asi que
  // no tiene sentido que el trigger reintente el alta entera por esto.
  try {
    await brevo.enviarConPlantilla({
      email,
      nombre: nombre || '',
      templateId: process.env.BREVO_BIENVENIDA_TEMPLATE_ID,
      params: { baja: urlDeBaja(email) },
      headers: cabecerasDeBaja(email),
    });
  } catch (error) {
    functions.logger.error('No se pudo mandar la bienvenida:', error.message);
  }
}

// -------------------------------------------------------
// sincronizarAlumnoBrevo: mantiene al dia la lista de alumnos y la de
// interesados. Mira "usuarios/{email}", que es por donde pasan todos los
// accesos (los pagos, las invitaciones, los regalos, los enlaces y la
// carga a mano del panel), asi que con este trigger no hay que tocar
// ninguna ruta de cobro.
//
// Nunca escribe en "usuarios": si lo hiciera, se dispararia a si mismo.
// -------------------------------------------------------
exports.sincronizarAlumnoBrevo = onDocumentWritten({
  document: 'usuarios/{email}',
  database: 'cursos',
  region: 'us-central1',
  maxInstances: 3,
}, async (event) => {
  if (!brevo.brevoConfigurado()) return;

  const antes = event.data?.before?.data() || {};
  const despues = event.data?.after?.data();
  if (!despues) return; // se borro el usuario: el contacto no se toca

  const email = String(event.params.email || '').toLowerCase();
  if (!EMAIL_VALIDO.test(email)) return;

  // El casillero "quiero recibir contenido astrologico" del modal de
  // ingreso. Se mira aparte de los cursos porque quien recien se registro
  // todavia no tiene ninguno y, sin embargo, ya dijo que si.
  //
  // Igual que en la calculadora, reacciona SOLO al cambio del casillero: si
  // la persona se dio de baja desde un mail y el documento sigue diciendo
  // true, cualquier otra escritura la volveria a suscribir.
  const queriaNovedades = antes.novedades === true;
  const quiereNovedades = despues.novedades === true;
  if (queriaNovedades !== quiereNovedades) {
    if (quiereNovedades) {
      await altaEnNovedades({
        email,
        nombre: despues.nombre || '',
        origen: 'escuela',
        consentimiento: 'escuela-novedades',
      });
    } else {
      await brevo.quitarDeLista(email, ['suscriptores']);
    }
  }

  const cursos = Array.isArray(despues.cursos) ? despues.cursos : [];
  const interesados = Array.isArray(despues.interesados) ? despues.interesados : [];

  // El documento tambien se escribe cuando alguien cambia solo su nombre:
  // ahi no hay nada que sincronizar.
  const igual = cursosComoTexto(antes.cursos) === cursosComoTexto(cursos)
    && cursosComoTexto(antes.interesados) === cursosComoTexto(interesados);
  if (igual) return;

  // Recien registrado, sin cursos ni intereses todavia: no es ni alumno ni
  // interesado, no va a ninguna lista.
  if (!cursos.length && !interesados.length) return;

  const esAlumno = cursos.length > 0;

  // Si el contacto es nuevo le ponemos origen y consentimiento; si ya
  // existe no se los pisamos, porque los de la compra o del formulario
  // dicen mas que "escuela".
  const existente = await brevo.obtenerContacto(email);
  const atributosNuevos = existente ? {} : {
    ORIGEN: 'escuela',
    CONSENTIMIENTO: 'relacion-comercial',
    FECHA_ALTA: brevo.fechaBrevo(new Date()),
  };

  await brevo.upsertContacto({
    email,
    nombre: despues.nombre || '',
    listas: [esAlumno ? 'alumnos' : 'interesados'],
    // Quien compro deja de ser un interesado: no tiene sentido que le siga
    // llegando el aviso de "mirá la clase gratis" de un curso que ya tiene.
    quitarDeListas: esAlumno ? ['interesados'] : [],
    atributos: { CURSOS: cursosComoTexto(cursos), ...atributosNuevos },
  });
});

// -------------------------------------------------------
// sincronizarNovedadesTucarta: el casillero "quiero recibir novedades" de
// la calculadora de cartas, que hasta ahora se leia copiando mails a mano
// desde el panel.
//
// Reacciona SOLO al cambio del casillero, no a cualquier escritura del
// documento. Es importante: si alguien se da de baja desde un mail y el
// documento sigue diciendo novedades:true, un trigger menos cuidadoso lo
// volveria a suscribir en la proxima carta que guarde.
// -------------------------------------------------------
exports.sincronizarNovedadesTucarta = onDocumentWritten({
  document: 'tucarta_usuarios/{uid}',
  database: 'cursos',
  region: 'us-central1',
  maxInstances: 3,
}, async (event) => {
  if (!brevo.brevoConfigurado()) return;

  const antes = event.data?.before?.data() || {};
  const despues = event.data?.after?.data() || {};

  const email = String(despues.email || antes.email || '').toLowerCase();
  if (!EMAIL_VALIDO.test(email)) return;

  const queria = antes.novedades === true;
  const quiere = despues.novedades === true;
  if (queria === quiere) return;

  if (quiere) {
    await altaEnNovedades({
      email,
      nombre: despues.nombre || '',
      origen: 'tucarta',
      consentimiento: 'tucarta-novedades',
    });
  } else {
    await brevo.quitarDeLista(email, ['suscriptores']);
  }
});

// -------------------------------------------------------
// descargarCertificado: entrega el certificado de egreso
//
// Los PDF estaban en public/escuela/certificados/pdfs/ y se bajaban desde una
// URL publica y adivinable (el archivo se llama como la persona). Cada
// certificado lleva el DNI impreso, asi que eso era un dato personal al aire.
// Ahora viven en functions/certificados/, que no se publica, y salen solo por
// aca: con sesion iniciada y unicamente el propio.
//
// Quien tiene derecho a cual archivo se define en la coleccion "certificados"
// de Firestore, un documento por egresadx con el mail como id:
//   certificados/alguien@ejemplo.com -> { archivo, nombre, curso }
// La coleccion esta cerrada a los clientes en firestore.rules: la escribe solo
// el Admin SDK (las herramientas de admin), nunca el navegador.
// -------------------------------------------------------
const CERTIFICADOS_DIR = require('path').join(__dirname, 'certificados');
const NOMBRE_PDF_VALIDO = /^[a-zA-Z0-9._-]+\.pdf$/;

exports.descargarCertificado = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  ensureInit();

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Debés iniciar sesión para descargar tu certificado.' });
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(authHeader.replace('Bearer ', ''));
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido.' });
  }

  if (!(await checkRateLimit('descargarCertificado', req, 20))) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  const userEmail = (decodedToken.email || '').toLowerCase().trim();
  if (!userEmail) return res.status(403).json({ error: 'Tu cuenta no tiene un mail asociado.' });

  try {
    const snap = await _db.collection('certificados').doc(userEmail).get();
    if (!snap.exists) {
      // Mismo mensaje para "no sos egresadx" y "todavia no cargamos el tuyo":
      // no hace falta que esta respuesta diga quien tiene certificado y quien no.
      return res.status(404).json({ error: 'No encontramos un certificado a tu nombre. Si creés que es un error, escribinos a info@sebabru.com.' });
    }

    const archivo = String(snap.data().archivo || '');
    // El nombre del archivo viene de Firestore, que escribe solo el Admin SDK,
    // pero igual se valida: alcanza un "../" para salirse de la carpeta.
    if (!NOMBRE_PDF_VALIDO.test(archivo)) {
      functions.logger.error('Certificado con nombre de archivo invalido', { userEmail, archivo });
      return res.status(500).json({ error: 'No pudimos preparar tu certificado. Escribinos a info@sebabru.com.' });
    }

    const ruta = require('path').join(CERTIFICADOS_DIR, archivo);
    if (!ruta.startsWith(CERTIFICADOS_DIR)) {
      functions.logger.error('Intento de salir de la carpeta de certificados', { userEmail, archivo });
      return res.status(400).json({ error: 'Pedido inválido.' });
    }

    let pdf;
    try {
      pdf = await require('fs').promises.readFile(ruta);
    } catch (e) {
      functions.logger.error('Falta el PDF del certificado en el deploy', { userEmail, archivo });
      return res.status(500).json({ error: 'No pudimos preparar tu certificado. Escribinos a info@sebabru.com.' });
    }

    functions.logger.info('Certificado descargado', { userEmail, archivo });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${archivo}"`);
    // Es un dato personal: que no quede en cache de proxies ni del navegador.
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).send(pdf);

  } catch (error) {
    functions.logger.error('Error en descargarCertificado:', error.message);
    return res.status(500).json({ error: 'No pudimos preparar tu certificado. Probá de nuevo en unos minutos.' });
  }
});

// -------------------------------------------------------
// exports.baja: saca una direccion de la lista de correo.
//
// La llama /baja/ con JavaScript, no el enlace del mail directamente. Es a
// proposito: Gmail y Outlook pre-cargan los enlaces para analizarlos, asi
// que un GET que da de baja se dispararia con que un escaner mire el mail.
// Los escaneres no ejecutan JavaScript.
//
// Idempotente: si la direccion no esta en ninguna lista, contesta ok igual.
// Y no dice nunca si la direccion existia, para que el endpoint no sirva
// para averiguar si un mail ajeno esta suscrito.
// -------------------------------------------------------
exports.baja = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  if (!(await checkRateLimit('baja', req, 10))) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  const email = sanitizeTexto(req.body?.email, 200).toLowerCase();
  const token = sanitizeTexto(req.body?.token, 100);
  if (!EMAIL_VALIDO.test(email) || !token) {
    return res.status(400).json({ error: 'token_invalido' });
  }

  const esperado = tokenDeBaja(email);
  if (!esperado) {
    functions.logger.error('Falta BAJA_SECRET: no se puede procesar una baja.');
    return res.status(503).json({ error: 'no_configurado' });
  }

  let coincide = false;
  try {
    coincide = crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(token));
  } catch (_) {
    coincide = false; // longitudes distintas: timingSafeEqual tira
  }
  if (!coincide) {
    functions.logger.warn('Baja con token invalido.', { dominio: email.split('@')[1] });
    return res.status(400).json({ error: 'token_invalido' });
  }

  try {
    // 1. Brevo. La marca de la blocklist es la que importa: vive en el
    //    contacto y sobrevive a una reimportacion futura de la planilla, asi
    //    que esta persona no vuelve a entrar sola. Quitarlo de la lista
    //    ademas mantiene los informes honestos.
    //    No frena los transaccionales de compra: esos salen por Gmail.
    await brevo.marcarBaja(email);

    // 2. Firestore, para que no diga lo contrario que Brevo. Si el documento
    //    siguiera en novedades:true, cualquier edicion futura del documento
    //    podria volver a suscribir a quien se dio de baja.
    //    Los dos triggers reaccionan al cambio del flag y llaman a
    //    quitarDeLista otra vez, que es idempotente.
    const ahora = admin.firestore.FieldValue.serverTimestamp();

    await _db.collection('suscripciones').doc(email).set({
      email, estado: 'baja', baja: ahora,
    }, { merge: true });

    const usuario = _db.collection('usuarios').doc(email);
    if ((await usuario.get()).exists) {
      await usuario.set({ novedades: false }, { merge: true });
    }

    const enTucarta = await _db.collection('tucarta_usuarios')
      .where('email', '==', email).limit(10).get();
    for (const doc of enTucarta.docs) {
      await doc.ref.set({ novedades: false }, { merge: true });
    }

    functions.logger.info('Baja procesada.', { dominio: email.split('@')[1] });
    return res.status(200).json({ ok: true });

  } catch (error) {
    functions.logger.error('Error al dar de baja:', error.message);
    return res.status(500).json({ error: 'fallo' });
  }
});

// =======================================================================
// AGENDA DE CONSULTAS
//
// El agendador propio: reemplaza al enlace de Google Appointment Schedules
// y al ida y vuelta por WhatsApp para fijar el dia y la hora de una sesion.
//
// La disponibilidad sale de tres lugares que se cruzan:
//   1. Las franjas por dia de la semana que Seba configura (agenda_config).
//   2. Lo que ya esta ocupado en su Google Calendar (freebusy).
//   3. Los turnos ya reservados por el sitio (agenda_turnos).
//
// Se entra de dos maneras: desde el formulario de consultas (el pedido ya
// existe y trae los datos) o derecho a /consultas/agenda/, para una segunda
// sesion de alguien de quien ya tenemos la carta.
// =======================================================================

// @googleapis/calendar son 180 archivos y hasta ahora los cargaban las 32
// functions al arrancar en frio, incluidas las 28 que no tienen nada que ver
// con la agenda. Se carga adentro de getCalendarClient.

// Argentina no tiene horario de verano desde 2009, asi que toda la agenda se
// calcula con un offset fijo. Es lo que permite generar los horarios con
// aritmetica de milisegundos y sin una libreria de zonas horarias. Si alguna
// vez vuelve el huso de verano, esto es lo primero que hay que tocar.
const AGENDA_OFFSET = '-03:00';
const AGENDA_ZONA = 'America/Argentina/Cordoba';

// El Zoom fijo de las consultas, el mismo que ya va en el mail de
// confirmacion del formulario.
const AGENDA_ZOOM = 'https://us02web.zoom.us/j/8020861967?pwd=Gl9uLBofVZd0XmzTPhAHnQDc8RtnsE.1';
const AGENDA_ZOOM_ID = '802 086 1967';
const AGENDA_ZOOM_PASS = 'paso';
const AGENDA_WHATSAPP_CLARI = '+5493544559877';

const AGENDA_CONFIG_POR_DEFECTO = {
  zona: AGENDA_ZONA,
  duracionMin: 120,
  // Aire entre una sesion y la siguiente (y entre una sesion y cualquier
  // otra cosa que haya en el calendario).
  bufferMin: 15,
  // Cada cuanto puede arrancar un turno dentro de una franja.
  granularidadMin: 30,
  // Nadie puede reservar para dentro de menos de esto.
  anticipacionHoras: 48,
  ventanaDias: 60,
  // 0 = domingo. Arranca con lunes a viernes de 10 a 18; Seba lo cambia
  // desde /consultas/admin/ sin tocar codigo.
  semana: {
    '1': [{ desde: '10:00', hasta: '18:00' }],
    '2': [{ desde: '10:00', hasta: '18:00' }],
    '3': [{ desde: '10:00', hasta: '18:00' }],
    '4': [{ desde: '10:00', hasta: '18:00' }],
    '5': [{ desde: '10:00', hasta: '18:00' }],
  },
  pausado: false,
};

let _calendarClient;
// Mismo service account que escribe las planillas, con otro scope. Se arma
// un JWT propio porque el de Sheets ya quedo cacheado con el suyo: un JWT
// pide su token una vez y no vuelve a mirar la lista de scopes.
//
// Para que esto funcione hay dos pasos a mano, una sola vez: habilitar la
// Google Calendar API en el proyecto y autorizar la delegacion de dominio.
//
// Por que delegacion y no compartir el calendario: info@sebabru.com es una
// cuenta de Google Workspace, y la politica del dominio solo deja compartir
// calendarios con direcciones externas como "libre/ocupado". La cuenta de
// servicio vive en gserviceaccount.com, asi que para Workspace es externa y
// nunca podria escribir (comprobado el 2026-11-13: el desplegable de
// permisos aparece con todo gris menos libre/ocupado).
//
// Con AGENDA_IMPERSONAR la cuenta de servicio actua *como* esa persona, que
// es la forma prevista para Workspace, y de paso habilita dos cosas que una
// cuenta de servicio suelta no puede: crear el Meet de cada sesion y mandar
// la invitacion de Google a quien reserva.
//
// Sin AGENDA_IMPERSONAR sigue funcionando como cuenta de servicio comun,
// con un calendario compartido: asi esto no se rompe si alguna vez se
// vuelve atras.
function getCalendarClient() {
  if (_calendarClient) return _calendarClient;
  const { calendar: calendarApi } = require('@googleapis/calendar');
  const auth = new JWT({
    email: process.env.SHEETS_CLIENT_EMAIL,
    key: (process.env.SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
    subject: process.env.AGENDA_IMPERSONAR || undefined,
  });
  _calendarClient = calendarApi({ version: 'v3', auth });
  return _calendarClient;
}

// Actuando como Seba se puede invitar y crear Meet; como cuenta de servicio
// suelta, no (Google contesta "Service accounts cannot invite attendees").
function agendaActuaComoSeba() {
  return Boolean(process.env.AGENDA_IMPERSONAR);
}

function calendarioDeTurnos() {
  return process.env.AGENDA_CALENDAR_ID || 'primary';
}

// De donde se lee la ocupacion. Por defecto, el mismo calendario donde se
// escriben los turnos; con AGENDA_CALENDARIOS_OCUPACION se pueden sumar
// otros (por ejemplo el personal de Seba, si los turnos van a uno aparte).
function calendariosDeOcupacion() {
  const extra = (process.env.AGENDA_CALENDARIOS_OCUPACION || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([calendarioDeTurnos(), ...extra])];
}

// -------------------------------------------------------
// Token del pedido. Mismo patron que tokenDeBaja: sin el, cualquiera podria
// abrir la agenda de otra persona cambiando el id en la URL (y verle el
// nombre, el mail y el telefono).
// -------------------------------------------------------
function tokenDeAgenda(pedidoId) {
  const secreto = process.env.AGENDA_SECRET;
  if (!secreto) return null;
  return crypto.createHmac('sha256', secreto).update(String(pedidoId)).digest('hex').slice(0, 24);
}

function tokenDeAgendaValido(pedidoId, token) {
  const esperado = tokenDeAgenda(pedidoId);
  if (!esperado || !token) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(String(token)));
  } catch (_) {
    return false; // longitudes distintas: timingSafeEqual tira
  }
}

function urlDeAgenda(pedidoId) {
  const t = tokenDeAgenda(pedidoId);
  const base = process.env.SITE_URL || 'https://sebabru.com';
  if (!t) return `${base}/consultas/agenda/`;
  return `${base}/consultas/agenda/?p=${encodeURIComponent(pedidoId)}&t=${t}`;
}

// -------------------------------------------------------
// Fechas, todas en hora de Argentina con el offset fijo.
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
// las dos pierde el create(). Es el mismo truco que pagos_procesados.
function idDeTurno(ms) {
  return `${diaLocal(ms)}T${horaLocal(ms).replace(':', '-')}`;
}

// -------------------------------------------------------
// Configuracion y bloqueos
// -------------------------------------------------------
async function leerConfigAgenda() {
  const snap = await _db.collection('agenda_config').doc('general').get();
  const guardada = snap.exists ? snap.data() : {};
  const config = { ...AGENDA_CONFIG_POR_DEFECTO, ...guardada };
  // La semana se reemplaza entera, no se mezcla: si Seba deja un dia sin
  // franjas, ese dia tiene que quedar cerrado, no volver al valor de fabrica.
  config.semana = (guardada && guardada.semana) ? guardada.semana : AGENDA_CONFIG_POR_DEFECTO.semana;
  return config;
}

async function leerBloqueos() {
  const snap = await _db.collection('agenda_bloqueos').get();
  return snap.docs.map(d => d.data()).filter(b => b && b.desde && b.hasta);
}

function diaBloqueado(fechaISO, bloqueos) {
  return bloqueos.some(b => fechaISO >= b.desde && fechaISO <= b.hasta);
}

// -------------------------------------------------------
// Ocupacion: lo que dice Google Calendar mas los turnos que ya dio el sitio.
// Devuelve intervalos [desde, hasta] en milisegundos.
// -------------------------------------------------------
async function ocupacionEntre(desdeMs, hastaMs) {
  // Las dos consultas son independientes y la de Google es la lenta (medio
  // segundo largo contra la API de Calendar). En fila, la persona esperaba
  // una despues de la otra para ver el calendario; en paralelo paga solo la
  // mas lenta de las dos.
  const [respCalendar, turnos] = await Promise.all([
    getCalendarClient().freebusy.query({
      requestBody: {
        timeMin: new Date(desdeMs).toISOString(),
        timeMax: new Date(hastaMs).toISOString(),
        timeZone: 'UTC',
        items: calendariosDeOcupacion().map(id => ({ id })),
      },
    }).catch(e => {
      // Sin Calendar no se inventa disponibilidad: es preferible no ofrecer
      // nada a ofrecer un horario encima de algo que Seba ya tenia.
      functions.logger.error('No se pudo leer la ocupacion de Calendar', e.message);
      throw new Error('calendar_no_disponible');
    }),
    // Los turnos del sitio tambien crean un evento en Calendar, asi que esto
    // es redundante casi siempre. Casi: si la creacion del evento fallo, el
    // turno existe igual y el horario no se puede volver a ofrecer.
    _db.collection('agenda_turnos')
      .where('inicio', '>=', new Date(desdeMs))
      .where('inicio', '<=', new Date(hastaMs))
      .get(),
  ]);

  const ocupados = [];
  for (const info of Object.values(respCalendar.data.calendars || {})) {
    for (const hueco of (info.busy || [])) {
      ocupados.push([Date.parse(hueco.start), Date.parse(hueco.end)]);
    }
  }
  for (const doc of turnos.docs) {
    const t = doc.data();
    if (t.estado !== 'reservado') continue;
    ocupados.push([t.inicio.toMillis(), t.fin.toMillis()]);
  }

  return ocupados;
}

function chocaCon(inicioMs, finMs, ocupados, bufferMs) {
  return ocupados.some(([a, b]) => inicioMs < (b + bufferMs) && (finMs + bufferMs) > a);
}

// -------------------------------------------------------
// Los horarios libres entre dos fechas, en hora de Argentina.
// -------------------------------------------------------
function generarSlots(config, desdeISO, hastaISO, bloqueos, ocupados) {
  const duracionMs = config.duracionMin * 60000;
  const bufferMs = (config.bufferMin || 0) * 60000;
  const paso = (config.granularidadMin || 30) * 60000;
  const minimoMs = Date.now() + (config.anticipacionHoras || 0) * 3600000;
  const topeMs = Date.now() + (config.ventanaDias || 60) * 86400000;

  const slots = [];
  for (let dia = desdeISO; dia <= hastaISO; dia = sumarDias(dia, 1)) {
    if (diaBloqueado(dia, bloqueos)) continue;
    const franjas = config.semana[String(diaDeSemana(dia))] || [];
    for (const franja of franjas) {
      const desdeMin = minutosDeHora(franja.desde);
      const hastaMin = minutosDeHora(franja.hasta);
      if (desdeMin === null || hastaMin === null || hastaMin <= desdeMin) continue;
      const base = msDeHoraLocal(dia, '00:00');
      const finFranja = base + hastaMin * 60000;
      for (let inicio = base + desdeMin * 60000; inicio + duracionMs <= finFranja; inicio += paso) {
        if (inicio < minimoMs || inicio > topeMs) continue;
        if (chocaCon(inicio, inicio + duracionMs, ocupados, bufferMs)) continue;
        slots.push(isoLocal(inicio));
      }
    }
  }
  return slots;
}

// -------------------------------------------------------
// La planilla. Para un pedido que vino del formulario se actualizan las dos
// celdas de su fila; para uno directo se escribe una fila nueva.
// -------------------------------------------------------
const AGENDA_COL_DIA = 'Día de la sesión';
const AGENDA_COL_HORA = 'Hora de la sesión';

function letraDeColumna(indice) {
  let n = indice + 1, letra = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = Math.floor((n - 1) / 26);
  }
  return letra;
}

async function escribirSesionEnPlanilla(pedido, inicioMs) {
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_CONSULTAS;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_CONSULTAS');
  const sheets = getSheetsClient();
  const hoja = 'Consultas';
  const config = FORMULARIOS_INSCRIPCION.consultas;

  // Se asegura que las dos columnas existan sin pisar las que Seba agrego
  // a mano (la hoja es columnasPorEncabezado por eso mismo).
  const encabezados = [
    config.etiquetaFecha,
    ...config.campos.map(c => c.label),
    config.columnaCarta,
    ...Object.keys(config.columnasFijas || {}),
    ...(config.camposFinales || []).map(c => c.label),
    AGENDA_COL_DIA, AGENDA_COL_HORA,
  ];
  const titulos = await asegurarHojaInscripcion(sheets, spreadsheetId, hoja, encabezados, true);

  const dia = new Date(inicioMs).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  const hora = horaLocal(inicioMs);

  const filaGuardada = /![A-Z]+(\d+)/.exec(pedido.filaPlanilla || '');
  if (filaGuardada) {
    const nro = filaGuardada[1];
    const datos = [];
    for (const [titulo, valor] of [[AGENDA_COL_DIA, dia], [AGENDA_COL_HORA, hora]]) {
      const i = titulos.indexOf(titulo);
      if (i < 0) continue;
      datos.push({ range: `${hoja}!${letraDeColumna(i)}${nro}`, values: [[valor]] });
    }
    if (datos.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: datos },
      });
    }
    return;
  }

  // Sin fila que actualizar. Una fila nueva se agrega solo si el pedido
  // nacio en la agenda suelta: un pedido que vino del formulario YA tiene su
  // fila, y si no la encontramos es porque algo fallo antes. Agregar otra
  // deja dos filas de la misma persona en la planilla y nadie se entera.
  //
  // Antes esto se decidia por filaPlanilla vacio, que es justo lo que pasa
  // cuando algo salio mal. Ahora lo decide el origen, que es un hecho del
  // pedido y no el sintoma de una falla.
  if (pedido.origen !== 'directo') {
    throw new Error('pedido de formulario sin filaPlanilla: no se agrega una fila nueva');
  }

  // Pedido directo: se escribe una fila nueva con lo poco que sabemos. La
  // carta ya la tenemos de la sesion anterior.
  const porTitulo = {
    [config.etiquetaFecha]: new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
    Nombre: pedido.nombre || '',
    'Teléfono': pedido.telefono || '',
    Email: pedido.email || '',
    Modalidad: pedido.modalidad || '',
    [config.columnaCarta]: 'Ya la tiene',
    Regalo: 'No',
    [AGENDA_COL_DIA]: dia,
    [AGENDA_COL_HORA]: hora,
  };
  const escrito = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${hoja}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [titulos.map(t => (t in porTitulo ? porTitulo[t] : ''))] },
  });
  // Se devuelve donde quedo para guardarlo en el pedido: si despues mueve
  // la sesion, se actualiza esta fila en vez de escribir otra igual.
  return escrito.data?.updates?.updatedRange || null;
}

// -------------------------------------------------------
// Mails del turno. Van por nodemailer/Gmail como todos los transaccionales
// (Brevo es para la newsletter), pero NO en linea: se encolan en
// mails_salientes y los manda el trigger enviarMailEncolado.
//
// Importa mas aca que en otros lados: reservarTurno mandaba dos mails
// seguidos por SMTP -- el de la persona con el .ics y el aviso interno --
// antes de contestar. Son varios segundos mirando "Agendando..." para que
// salga un aviso que quien reserva no va a leer. Ver mails.js.
// -------------------------------------------------------
function textoFechaLarga(ms) {
  return new Date(ms).toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

function marcaIcs(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// El .ics es lo que reemplaza a la invitacion de Google: un service account
// sin delegacion de dominio no puede sumar invitados a un evento, asi que la
// persona agrega la sesion a su calendario desde el adjunto.
function archivoIcs(turnoId, inicioMs, finMs, lugar, descripcion) {
  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Seba Bru Astrologia//Agenda//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${turnoId}@sebabru.com`,
    `DTSTAMP:${marcaIcs(Date.now())}`,
    `DTSTART:${marcaIcs(inicioMs)}`,
    `DTEND:${marcaIcs(finMs)}`,
    'SUMMARY:Sesión de astrología con Seba Bru',
    `DESCRIPTION:${String(descripcion).replace(/\n/g, '\\n')}`,
    `LOCATION:${lugar}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lineas.join('\r\n');
}

// Donde es el encuentro. Si el evento trajo un Meet propio, ese gana: es un
// enlace por sesion. Si no, el Zoom fijo de siempre.
function datosDelEncuentro(modalidad, meet) {
  if (modalidad === 'Presencial') {
    return {
      lugar: 'Presencial',
      htmlPersona: `El encuentro es presencial. Pedile la información sobre cómo llegar a Clari: ${escapeHtml(AGENDA_WHATSAPP_CLARI)}.`,
      textoEvento: `Presencial. Contacto de Clari: ${AGENDA_WHATSAPP_CLARI}`,
    };
  }
  if (meet) {
    return {
      lugar: meet,
      htmlPersona: `El encuentro es por Google Meet, con este enlace:<br><a href="${meet}">${meet}</a>`,
      textoEvento: `Google Meet: ${meet}`,
    };
  }
  return {
    lugar: AGENDA_ZOOM,
    htmlPersona: `El encuentro es por Zoom, con este enlace:<br><a href="${AGENDA_ZOOM}">${AGENDA_ZOOM}</a><br>Meeting ID: ${AGENDA_ZOOM_ID}<br>Passcode: ${AGENDA_ZOOM_PASS}`,
    textoEvento: `Zoom: ${AGENDA_ZOOM} (ID ${AGENDA_ZOOM_ID}, passcode ${AGENDA_ZOOM_PASS})`,
  };
}

async function avisarTurnoReservado(pedido, pedidoId, inicioMs, finMs, turnoId, meet) {
  const encuentro = datosDelEncuentro(pedido.modalidad, meet);
  const cuando = `${textoFechaLarga(inicioMs)} a las ${horaLocal(inicioMs)}`;
  const enlace = urlDeAgenda(pedidoId);

  const ics = archivoIcs(
    turnoId, inicioMs, finMs, encuentro.lugar,
    `Sesión de astrología con Seba Bru.\n${encuentro.textoEvento}`
  );

  await mails.encolarMail(_db, {
    motivo: 'turno-reservado',
    para: pedido.email,
    asunto: `Tu sesión: ${cuando} (hora de Argentina)`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;">
        <p>Hola, ${escapeHtml(pedido.nombre || '')}:</p>
        <p>Tu sesión quedó agendada para el <strong>${escapeHtml(cuando)}</strong>, hora de Argentina. Dura ${Math.round((finMs - inicioMs) / 60000)} minutos.</p>
        <p>${encuentro.htmlPersona}</p>
        <p>Te adjunto el archivo para que la agregues a tu calendario.</p>
        <p>Si necesitás cambiarla o cancelarla, entrá acá:<br><a href="${enlace}">${enlace}</a></p>
        <p>¡Nos vemos!<br>Seba</p>
      </div>
    `,
    adjuntos: [{ filename: 'sesion-seba-bru.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }],
  });

  await mails.encolarMail(_db, {
    motivo: 'turno-reservado-aviso',
    para: AVISOS_INSCRIPCION,
    asunto: `🗓️ Turno reservado — ${cuando}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;">
        <h2 style="color:#249b95;">Turno reservado</h2>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;width:180px;">Cuándo</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(cuando)}</td></tr>
          <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;">Nombre</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(pedido.nombre || '—')}</td></tr>
          <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;">Email</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(pedido.email || '—')}</td></tr>
          <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;">Teléfono</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(pedido.telefono || '—')}</td></tr>
          <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;">Modalidad</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(pedido.modalidad || '—')}</td></tr>
          <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;">Entró por</td><td style="padding:10px;border-bottom:1px solid #eee;">${pedido.origen === 'directo' ? 'La agenda suelta (segunda sesión)' : 'El formulario de consultas'}</td></tr>
        </table>
      </div>
    `,
  });
}

async function avisarTurnoCancelado(pedido, pedidoId, inicioMs, porQuien) {
  const cuando = `${textoFechaLarga(inicioMs)} a las ${horaLocal(inicioMs)}`;
  const enlace = urlDeAgenda(pedidoId);

  if (pedido.email) {
    await mails.encolarMail(_db, {
      motivo: 'turno-cancelado',
      para: pedido.email,
      asunto: `Se canceló tu sesión del ${cuando}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;">
          <p>Hola, ${escapeHtml(pedido.nombre || '')}:</p>
          <p>Tu sesión del <strong>${escapeHtml(cuando)}</strong> quedó cancelada.</p>
          <p>Cuando quieras, elegí otro día y otra hora acá:<br><a href="${enlace}">${enlace}</a></p>
          <p>Seba</p>
        </div>
      `,
    });
  }

  await mails.encolarMail(_db, {
    motivo: 'turno-cancelado-aviso',
    para: AVISOS_INSCRIPCION,
    asunto: `❌ Turno cancelado — ${cuando}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;">
        <p>Se canceló el turno del <strong>${escapeHtml(cuando)}</strong> de ${escapeHtml(pedido.nombre || '—')} (${escapeHtml(pedido.email || '—')}).</p>
        <p>Lo canceló: ${porQuien === 'admin' ? 'Seba, desde el panel' : 'la persona, desde la agenda'}.</p>
      </div>
    `,
  });
}

// -------------------------------------------------------
// Crear y borrar el evento en el calendario de Seba.
// -------------------------------------------------------
async function crearEventoDeTurno(pedido, pedidoId, inicioMs, finMs, turnoId) {
  const cal = getCalendarClient();
  const comoSeba = agendaActuaComoSeba();
  const online = pedido.modalidad !== 'Presencial';

  const cuerpo = {
    summary: `Consulta — ${pedido.nombre || pedido.email || 'sin nombre'}`,
    description: [
      `${pedido.nombre || ''} · ${pedido.email || ''} · ${pedido.telefono || ''}`,
      `Modalidad: ${pedido.modalidad || '—'}`,
      '',
      `Agenda de la persona: ${urlDeAgenda(pedidoId)}`,
    ].join('\n'),
    start: { dateTime: isoLocal(inicioMs), timeZone: AGENDA_ZONA },
    end: { dateTime: isoLocal(finMs), timeZone: AGENDA_ZONA },
  };

  // Actuando como Seba, quien reserva entra como invitado y recibe la
  // invitacion de Google, con su boton de confirmar y sus recordatorios.
  if (comoSeba && pedido.email) {
    cuerpo.attendees = [{ email: pedido.email, displayName: pedido.nombre || undefined }];
  }
  // Y cada sesion online tiene su propio Meet en vez del Zoom compartido.
  if (comoSeba && online) {
    cuerpo.conferenceData = {
      createRequest: {
        // Con el id del turno, un reintento no crea dos reuniones.
        requestId: `turno-${turnoId}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  } else {
    cuerpo.location = datosDelEncuentro(pedido.modalidad).lugar;
  }

  const r = await cal.events.insert({
    calendarId: calendarioDeTurnos(),
    requestBody: cuerpo,
    // Sin esto Google ignora el pedido de conferencia, sin avisar.
    conferenceDataVersion: cuerpo.conferenceData ? 1 : 0,
    sendUpdates: cuerpo.attendees ? 'all' : 'none',
  });

  return { eventId: r.data.id, meet: r.data.hangoutLink || null };
}

async function borrarEventoDeTurno(eventId) {
  if (!eventId) return;
  try {
    await getCalendarClient().events.delete({
      calendarId: calendarioDeTurnos(),
      eventId,
      // Si la persona esta como invitada, que Google le avise que se
      // cancelo: nuestro mail de cancelacion sale igual, pero asi tambien
      // le desaparece de su propio calendario.
      sendUpdates: agendaActuaComoSeba() ? 'all' : 'none',
    });
  } catch (e) {
    // Si el evento ya no esta (lo borro Seba a mano), no es un error.
    functions.logger.warn('No se pudo borrar el evento del turno', { eventId, error: e.message });
  }
}

// -------------------------------------------------------
// Leer el pedido a partir de ?p=&t=. Devuelve null si el token no cierra.
// -------------------------------------------------------
async function pedidoDeAgenda(pedidoId, token) {
  if (!pedidoId || !tokenDeAgendaValido(pedidoId, token)) return null;
  const snap = await _db.collection('agenda_pedidos').doc(String(pedidoId)).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

// El turno vigente de un pedido, tal como lo muestra la pagina.
async function turnoDelPedido(pedido) {
  if (!pedido.turnoId) return null;
  const snap = await _db.collection('agenda_turnos').doc(pedido.turnoId).get();
  if (!snap.exists || snap.data().estado !== 'reservado') return null;
  const t = snap.data();
  return {
    id: snap.id,
    inicio: isoLocal(t.inicio.toMillis()),
    fin: isoLocal(t.fin.toMillis()),
    modalidad: t.modalidad || pedido.modalidad || '',
    meet: t.meet || null,
  };
}

// =======================================================================
// Endpoints de la agenda
// =======================================================================

// -------------------------------------------------------
// iniciarAgenda: la puerta suelta de /consultas/agenda/, para una segunda
// sesion o para alguien de quien ya tenemos la carta. Solo pide nombre,
// mail y telefono.
//
// El captcha va desde el primer envio, al reves que en el formulario de
// consultas: ahi hay una planilla y un mail de por medio, aca se puede
// llenar la agenda de Seba de turnos falsos, que es mucho mas caro de
// desarmar.
// -------------------------------------------------------
exports.iniciarAgenda = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  if (!(await checkRateLimit('iniciarAgenda', req, 8))) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  if (!process.env.AGENDA_SECRET) {
    functions.logger.error('Falta AGENDA_SECRET: la agenda no puede emitir tokens.');
    return res.status(503).json({ error: 'no_configurado' });
  }

  if (!(await verificarTurnstile(sanitizeTexto(req.body?.captchaToken, 2000), req))) {
    return res.status(400).json({ error: 'captcha_requerido' });
  }

  const nombre = sanitizeTexto(req.body?.nombre, 200);
  const email = sanitizeTexto(req.body?.email, 200).toLowerCase();
  const telefono = sanitizeTexto(req.body?.telefono, 50);
  const modalidad = sanitizeTexto(req.body?.modalidad, 20);

  if (!nombre || !telefono) return res.status(400).json({ error: 'faltan_datos' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'email_invalido' });
  if (!['Presencial', 'Online'].includes(modalidad)) return res.status(400).json({ error: 'modalidad_invalida' });

  try {
    const ref = await _db.collection('agenda_pedidos').add({
      origen: 'directo',
      nombre, email, telefono, modalidad,
      formId: null,
      filaPlanilla: null,
      turnoId: null,
      creado: new Date().toISOString(),
    });
    functions.logger.info('Pedido de agenda directo', { pedidoId: ref.id });
    return res.status(200).json({ ok: true, p: ref.id, t: tokenDeAgenda(ref.id), nombre });
  } catch (error) {
    functions.logger.error('Error en iniciarAgenda:', error.message);
    return res.status(500).json({ error: 'fallo' });
  }
});

// -------------------------------------------------------
// Los horarios libres de un tramo, acotado y cruzado con el calendario.
//
// Esta aparte porque lo usan dos lugares: la pagina publica y la vista
// previa del panel. Si cada uno calculara sus horarios con su propio
// codigo, la vista previa dejaria de servir para lo unico que sirve, que es
// ver lo que ve la gente.
// -------------------------------------------------------
async function slotsVisibles(config, desdePedido, hastaPedido) {
  const hoy = diaLocal(Date.now());
  let desde = fechaValida(desdePedido) && desdePedido > hoy ? desdePedido : hoy;
  let hasta = fechaValida(hastaPedido) ? hastaPedido : sumarDias(desde, 45);
  const tope = diaLocal(Date.now() + (config.ventanaDias || 60) * 86400000);
  if (hasta > tope) hasta = tope;
  // Un tramo de a lo sumo 70 dias por pedido: es la unica cota contra una
  // consulta que haga a Calendar recorrer anios.
  if (hasta > sumarDias(desde, 70)) hasta = sumarDias(desde, 70);
  if (hasta < desde) return { desde, hasta, slots: [] };

  const [ocupados, bloqueos] = await Promise.all([
    ocupacionEntre(msDeHoraLocal(desde, '00:00'), msDeHoraLocal(hasta, '23:59')),
    leerBloqueos(),
  ]);
  return { desde, hasta, slots: generarSlots(config, desde, hasta, bloqueos, ocupados) };
}

// -------------------------------------------------------
// disponibilidad: los horarios libres de un tramo, en hora de Argentina.
// La pagina los muestra en la zona horaria de quien mira.
// -------------------------------------------------------
exports.disponibilidad = functions.runWith({ memory: '512MB' }).https.onRequest(async (req, res) => {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  if (!(await checkRateLimit('disponibilidad', req, 120))) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  const pedido = await pedidoDeAgenda(sanitizeTexto(req.query.p, 64), sanitizeTexto(req.query.t, 64));
  if (!pedido) return res.status(403).json({ error: 'token_invalido' });

  try {
    // Independientes entre si: dos lecturas de Firestore que no se esperan.
    const [config, turno] = await Promise.all([
      leerConfigAgenda(),
      turnoDelPedido(pedido),
    ]);

    const respuesta = {
      ok: true,
      nombre: pedido.nombre || '',
      modalidad: pedido.modalidad || '',
      // El pedido fijo que usa el panel para mirar la pagina por dentro. La
      // pagina lo necesita saber para apagar el boton de confirmar y para no
      // mandar eventos a Analytics cada vez que Seba abre el panel.
      previsualizacion: pedido.origen === 'previsualizacion',
      zona: AGENDA_ZONA,
      duracionMin: config.duracionMin,
      ventanaDias: config.ventanaDias,
      anticipacionHoras: config.anticipacionHoras,
      turno,
      slots: [],
    };

    if (config.pausado) {
      respuesta.pausado = true;
      return res.status(200).json(respuesta);
    }

    const visibles = await slotsVisibles(
      config,
      sanitizeTexto(req.query.desde, 10),
      sanitizeTexto(req.query.hasta, 10)
    );
    respuesta.desde = visibles.desde;
    respuesta.hasta = visibles.hasta;
    respuesta.slots = visibles.slots;
    return res.status(200).json(respuesta);

  } catch (error) {
    if (error.message === 'calendar_no_disponible') {
      return res.status(503).json({ error: 'calendar_no_disponible' });
    }
    functions.logger.error('Error en disponibilidad:', error.message);
    return res.status(500).json({ error: 'fallo' });
  }
});

// -------------------------------------------------------
// reservarTurno: fija el horario. Si el pedido ya tenia uno, lo libera
// primero: ese es el camino de "cambiar la fecha".
// -------------------------------------------------------
exports.reservarTurno = functions.runWith({ memory: '512MB' }).https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  if (!(await checkRateLimit('reservarTurno', req, 15))) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  const pedidoId = sanitizeTexto(req.body?.p, 64);
  const pedido = await pedidoDeAgenda(pedidoId, sanitizeTexto(req.body?.t, 64));
  if (!pedido) return res.status(403).json({ error: 'token_invalido' });

  // Desde la vista previa del panel no se reserva: es para mirar. Si no, un
  // clic de Seba probando la pantalla le mete un turno en el calendario.
  if (pedido.origen === 'previsualizacion') {
    return res.status(403).json({ error: 'es_previsualizacion' });
  }

  const inicioTexto = sanitizeTexto(req.body?.inicio, 40);
  const inicioMs = Date.parse(inicioTexto);
  if (!Number.isFinite(inicioMs)) return res.status(400).json({ error: 'horario_invalido' });
  try {
    const r = await reservarParaPedido(pedido, pedidoId, inicioMs, 'persona');
    if (r.error) return res.status(r.status).json({ error: r.error });
    return res.status(200).json({ ok: true, turno: r.turno });


  } catch (error) {
    if (error.message === 'calendar_no_disponible') {
      return res.status(503).json({ error: 'calendar_no_disponible' });
    }
    functions.logger.error('Error en reservarTurno:', error.message);
    return res.status(500).json({ error: 'fallo' });
  }
});

// -------------------------------------------------------
// cancelarTurno: libera el horario y borra el evento.
// -------------------------------------------------------
exports.cancelarTurno = functions.runWith({ memory: '512MB' }).https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  if (!(await checkRateLimit('cancelarTurno', req, 15))) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  const pedidoId = sanitizeTexto(req.body?.p, 64);
  const pedido = await pedidoDeAgenda(pedidoId, sanitizeTexto(req.body?.t, 64));
  if (!pedido) return res.status(403).json({ error: 'token_invalido' });

  if (pedido.origen === 'previsualizacion') {
    return res.status(403).json({ error: 'es_previsualizacion' });
  }

  try {
    // Idempotente: cancelar algo que ya no esta contesta ok igual.
    if (!pedido.turnoId) return res.status(200).json({ ok: true });

    const ref = _db.collection('agenda_turnos').doc(pedido.turnoId);
    const snap = await ref.get();
    if (snap.exists && snap.data().estado === 'reservado') {
      const inicioMs = snap.data().inicio.toMillis();
      await borrarEventoDeTurno(snap.data().eventId);
      await ref.set({ estado: 'cancelado', cancelado: new Date().toISOString(), canceladoPor: 'persona' }, { merge: true });
      try {
        await avisarTurnoCancelado(pedido, pedidoId, inicioMs, 'persona');
      } catch (e) {
        functions.logger.error('No se pudo avisar la cancelacion', e.message);
      }
    }
    await _db.collection('agenda_pedidos').doc(pedidoId).set({ turnoId: null }, { merge: true });

    functions.logger.info('Turno cancelado por la persona', { pedidoId });
    return res.status(200).json({ ok: true });

  } catch (error) {
    functions.logger.error('Error en cancelarTurno:', error.message);
    return res.status(500).json({ error: 'fallo' });
  }
});

// -------------------------------------------------------
// El corazon de la reserva, compartido por la pagina y por el panel.
//
// Devuelve { turno } si salio, o { error, status } con un motivo nominal.
// Nunca tira por un fallo de la planilla o del mail: el turno ya existe y
// la persona ya lo vio confirmado, asi que esos fallos se loguean.
// -------------------------------------------------------
async function reservarParaPedido(pedido, pedidoId, inicioMs, quien) {
  const dia = diaLocal(inicioMs);

  // Las tres son independientes: la config y los bloqueos son dos lecturas
  // de Firestore y la ocupacion es Google Calendar, que es la lenta. Antes
  // la config se esperaba sola y recien despues salian las otras dos, asi
  // que se sumaban. Salen las tres juntas y se paga la mas lenta.
  const promesaConfig = leerConfigAgenda();
  const promesaBloqueos = leerBloqueos();
  const promesaOcupacion = ocupacionEntre(msDeHoraLocal(dia, '00:00'), msDeHoraLocal(dia, '23:59'));

  const config = await promesaConfig;
  // Seba, desde el panel, puede poner un turno aunque la agenda este en
  // pausa o fuera de las franjas: la pausa es para el publico.
  const esAdmin = quien === 'admin';
  if (config.pausado && !esAdmin) {
    // Las otras dos ya salieron: si se vuelve sin esperarlas, un rechazo
    // suyo queda sin atender y Node lo levanta como unhandledRejection.
    promesaBloqueos.catch(() => {});
    promesaOcupacion.catch(() => {});
    return { error: 'agenda_pausada', status: 409 };
  }

  const turnoAnterior = pedido.turnoId || null;
  const [bloqueos, ocupadosCrudos] = await Promise.all([promesaBloqueos, promesaOcupacion]);
  const ocupados = ocupadosCrudos
    // Al reprogramar, el turno que la persona ya tenia no se cuenta como
    // ocupado: si no, no podria mover la sesion dos horas.
    .filter(([a]) => !(turnoAnterior && idDeTurno(a) === turnoAnterior));

  if (!esAdmin) {
    // El horario tiene que ser uno de los que la pagina podia ofrecer: no
    // alcanza con que este libre, tambien tiene que caer en una franja, en
    // la grilla y despues de la anticipacion minima.
    const legales = generarSlots(config, dia, dia, bloqueos, ocupados);
    if (!legales.includes(isoLocal(inicioMs))) return { error: 'slot_ocupado', status: 409 };
  } else if (chocaCon(inicioMs, inicioMs + config.duracionMin * 60000, ocupados, 0)) {
    // Al admin solo se le controla que no se pise con algo: las franjas y
    // la anticipacion son sugerencias para el publico, no para el.
    return { error: 'slot_ocupado', status: 409 };
  }

  const finMs = inicioMs + config.duracionMin * 60000;
  const turnoId = idDeTurno(inicioMs);

  // Aca esta la carrera: dos personas con el mismo horario abierto. El id
  // del documento sale del horario, asi que el segundo create() falla.
  try {
    await _db.collection('agenda_turnos').doc(turnoId).create({
      estado: 'reservado',
      inicio: new Date(inicioMs),
      fin: new Date(finMs),
      pedidoId,
      nombre: pedido.nombre || '',
      email: pedido.email || '',
      telefono: pedido.telefono || '',
      modalidad: pedido.modalidad || '',
      eventId: null,
      creado: new Date().toISOString(),
    });
  } catch (e) {
    if (e.code === 6) return { error: 'slot_ocupado', status: 409 };
    throw e;
  }

  // Recien ahora se suelta el turno viejo: si algo falla antes, la persona
  // se queda con el que tenia en vez de quedarse sin ninguno.
  if (turnoAnterior && turnoAnterior !== turnoId) {
    const viejo = await _db.collection('agenda_turnos').doc(turnoAnterior).get();
    if (viejo.exists) {
      await borrarEventoDeTurno(viejo.data().eventId);
      await viejo.ref.set({
        estado: 'cancelado',
        cancelado: new Date().toISOString(),
        canceladoPor: 'reprogramacion',
      }, { merge: true });
    }
  }

  let eventId = null;
  let meet = null;
  try {
    ({ eventId, meet } = await crearEventoDeTurno(pedido, pedidoId, inicioMs, finMs, turnoId));
  } catch (e) {
    // El turno vale igual (la persona ya tiene su confirmacion) pero Seba
    // no lo ve en su calendario: hay que avisarle fuerte.
    functions.logger.error('Turno sin evento en Calendar', { turnoId, error: e.message });
    try {
      await mails.encolarMail(_db, {
        motivo: 'turno-sin-calendario',
        para: AVISOS_INSCRIPCION,
        asunto: '⚠️ Turno reservado que NO entró en el calendario',
        html: `<p>Anotalo a mano: ${escapeHtml(textoFechaLarga(inicioMs))} a las ${horaLocal(inicioMs)}, ${escapeHtml(pedido.nombre || '')} (${escapeHtml(pedido.email || '')}).</p><p>Error: ${escapeHtml(e.message)}</p>`,
      });
    } catch (_) { /* encolarMail no tira, pero por las dudas */ }
  }

  // Dos documentos distintos: no hay razon para esperar uno y despues el
  // otro.
  await Promise.all([
    _db.collection('agenda_turnos').doc(turnoId).set({ eventId, meet }, { merge: true }),
    _db.collection('agenda_pedidos').doc(pedidoId).set({ turnoId }, { merge: true }),
  ]);

  // La planilla tambien se encola. Era lo ultimo que quedaba en fila antes
  // de contestar y es el gasto mas grande de reservarTurno despues del
  // evento en Calendar: hasta cuatro viajes a la API de Sheets para escribir
  // el dia y la hora en una fila que lee Seba. Lo hace el trigger
  // escribirFilaPlanilla, que ademas sabe esperar si la fila del formulario
  // todavia no llego.
  //
  // El evento en Calendar, en cambio, se queda en linea a proposito: si el
  // turno no entra en el calendario, el turno no existe, y eso la persona lo
  // tiene que saber antes de ver "listo".
  try {
    await Promise.all([
      encolarFilaPlanilla({ tipo: 'sesion', pedidoId, inicioMs }),
      avisarTurnoReservado(pedido, pedidoId, inicioMs, finMs, turnoId, meet),
    ]);
  } catch (e) {
    functions.logger.error('No se pudo avisar del turno', e.message);
  }

  functions.logger.info('Turno reservado', { turnoId, pedidoId, quien, origen: pedido.origen });
  return {
    turno: {
      id: turnoId, inicio: isoLocal(inicioMs), fin: isoLocal(finMs),
      modalidad: pedido.modalidad || '', meet,
    },
  };
}

// -------------------------------------------------------
// adminAgenda: todo lo que hace Seba desde /consultas/admin/.
//
// El panel no lee Firestore directo: pasa por aca. Asi las colecciones de
// la agenda quedan cerradas al cliente en firestore.rules y hay un solo
// lugar donde mirar quien toca que.
// -------------------------------------------------------
async function sesionDeAdmin(req) {
  const cabecera = req.headers.authorization || '';
  if (!cabecera.startsWith('Bearer ')) return null;
  try {
    const token = await admin.auth().verifyIdToken(cabecera.replace('Bearer ', ''));
    return token.admin === true ? token : null;
  } catch (_) {
    return null;
  }
}

function fechaValida(f) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(f || ''));
}

// La configuracion que llega del panel se reconstruye campo por campo: lo
// que no este en esta lista no entra en Firestore.
function configSaneada(cruda) {
  const entero = (v, min, max, porDefecto) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= min && n <= max ? n : porDefecto;
  };
  const semana = {};
  for (let d = 0; d <= 6; d++) {
    const franjas = Array.isArray(cruda?.semana?.[String(d)]) ? cruda.semana[String(d)] : [];
    const limpias = [];
    for (const f of franjas.slice(0, 6)) {
      const desde = minutosDeHora(f?.desde);
      const hasta = minutosDeHora(f?.hasta);
      if (desde === null || hasta === null || hasta <= desde) continue;
      limpias.push({ desde: f.desde, hasta: f.hasta });
    }
    if (limpias.length) semana[String(d)] = limpias;
  }
  return {
    zona: AGENDA_ZONA,
    duracionMin: entero(cruda?.duracionMin, 15, 480, 120),
    bufferMin: entero(cruda?.bufferMin, 0, 240, 15),
    granularidadMin: entero(cruda?.granularidadMin, 5, 240, 30),
    anticipacionHoras: entero(cruda?.anticipacionHoras, 0, 720, 48),
    ventanaDias: entero(cruda?.ventanaDias, 1, 365, 60),
    semana,
    pausado: cruda?.pausado === true,
  };
}

exports.adminAgenda = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  const sesion = await sesionDeAdmin(req);
  if (!sesion) return res.status(403).json({ error: 'no_autorizado' });

  if (!(await checkRateLimit('adminAgenda', req, 200))) {
    return res.status(429).json({ error: 'Demasiados pedidos. Probá de nuevo en unos minutos.' });
  }

  const accion = sanitizeTexto(req.body?.accion, 40);

  try {
    switch (accion) {

      // Todo lo que el panel necesita para pintarse: configuracion,
      // bloqueos y los turnos de la ventana que pide.
      case 'listar': {
        const desde = fechaValida(req.body?.desde) ? req.body.desde : diaLocal(Date.now() - 30 * 86400000);
        const hasta = fechaValida(req.body?.hasta) ? req.body.hasta : diaLocal(Date.now() + 120 * 86400000);
        const snap = await _db.collection('agenda_turnos')
          .where('inicio', '>=', new Date(msDeHoraLocal(desde, '00:00')))
          .where('inicio', '<=', new Date(msDeHoraLocal(hasta, '23:59')))
          .orderBy('inicio')
          .get();
        const turnos = snap.docs.map(d => {
          const t = d.data();
          return {
            id: d.id,
            estado: t.estado,
            inicio: isoLocal(t.inicio.toMillis()),
            fin: isoLocal(t.fin.toMillis()),
            nombre: t.nombre || '', email: t.email || '', telefono: t.telefono || '',
            modalidad: t.modalidad || '',
            pedidoId: t.pedidoId || null,
            enCalendario: !!t.eventId,
          };
        });
        const bloqueos = (await _db.collection('agenda_bloqueos').get())
          .docs.map(d => ({ id: d.id, ...d.data() }));
        return res.status(200).json({ ok: true, config: await leerConfigAgenda(), turnos, bloqueos });
      }

      // Lo que necesita la vista previa del panel: un pedido con el que
      // abrir la pagina publica de verdad, y los horarios que esa pagina va
      // a ofrecer. Es un pedido unico y fijo, asi no acumula basura, y
      // reservarTurno lo rechaza por origen.
      case 'previsualizar': {
        const modalidad = req.body?.modalidad === 'Presencial' ? 'Presencial' : 'Online';
        await _db.collection('agenda_pedidos').doc('previsualizacion').set({
          origen: 'previsualizacion',
          nombre: '', email: '', telefono: '',
          modalidad,
          turnoId: null,
          visto: new Date().toISOString(),
        }, { merge: true });

        const config = await leerConfigAgenda();
        // Sin desde ni hasta: los mismos valores por defecto que usa la
        // pagina, para que los horarios sean exactamente los que se ofrecen.
        const visibles = config.pausado
          ? { desde: null, hasta: null, slots: [] }
          : await slotsVisibles(config, null, null);

        return res.status(200).json({
          ok: true,
          p: 'previsualizacion',
          t: tokenDeAgenda('previsualizacion'),
          zona: AGENDA_ZONA,
          pausado: config.pausado === true,
          duracionMin: config.duracionMin,
          desde: visibles.desde,
          hasta: visibles.hasta,
          slots: visibles.slots,
        });
      }

      case 'guardarConfig': {
        const limpia = configSaneada(req.body?.config);
        await _db.collection('agenda_config').doc('general').set(limpia);
        functions.logger.info('Configuracion de agenda guardada', { por: sesion.email });
        return res.status(200).json({ ok: true, config: limpia });
      }

      case 'bloquear': {
        const desde = req.body?.desde, hasta = req.body?.hasta;
        if (!fechaValida(desde) || !fechaValida(hasta) || hasta < desde) {
          return res.status(400).json({ error: 'fechas_invalidas' });
        }
        const ref = await _db.collection('agenda_bloqueos').add({
          desde, hasta,
          motivo: sanitizeTexto(req.body?.motivo, 200),
          creado: new Date().toISOString(),
        });
        return res.status(200).json({ ok: true, id: ref.id });
      }

      case 'desbloquear': {
        const id = sanitizeTexto(req.body?.id, 64);
        if (!id) return res.status(400).json({ error: 'falta_id' });
        await _db.collection('agenda_bloqueos').doc(id).delete();
        return res.status(200).json({ ok: true });
      }

      case 'cancelar': {
        const turnoId = sanitizeTexto(req.body?.turnoId, 64);
        const ref = _db.collection('agenda_turnos').doc(turnoId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'no_existe' });
        const t = snap.data();
        if (t.estado === 'reservado') {
          await borrarEventoDeTurno(t.eventId);
          await ref.set({ estado: 'cancelado', cancelado: new Date().toISOString(), canceladoPor: 'admin' }, { merge: true });
          if (t.pedidoId) {
            await _db.collection('agenda_pedidos').doc(t.pedidoId).set({ turnoId: null }, { merge: true });
            const pedido = await _db.collection('agenda_pedidos').doc(t.pedidoId).get();
            if (pedido.exists) {
              try {
                await avisarTurnoCancelado(pedido.data(), t.pedidoId, t.inicio.toMillis(), 'admin');
              } catch (e) {
                functions.logger.error('No se pudo avisar la cancelacion', e.message);
              }
            }
          }
        }
        functions.logger.info('Turno cancelado desde el panel', { turnoId, por: sesion.email });
        return res.status(200).json({ ok: true });
      }

      case 'mover': {
        const turnoId = sanitizeTexto(req.body?.turnoId, 64);
        const inicioMs = Date.parse(sanitizeTexto(req.body?.inicio, 40));
        if (!Number.isFinite(inicioMs)) return res.status(400).json({ error: 'horario_invalido' });
        const snap = await _db.collection('agenda_turnos').doc(turnoId).get();
        if (!snap.exists) return res.status(404).json({ error: 'no_existe' });
        const pedidoId = snap.data().pedidoId;
        const pedidoSnap = pedidoId ? await _db.collection('agenda_pedidos').doc(pedidoId).get() : null;
        if (!pedidoSnap || !pedidoSnap.exists) return res.status(404).json({ error: 'sin_pedido' });
        const r = await reservarParaPedido({ ...pedidoSnap.data(), turnoId }, pedidoId, inicioMs, 'admin');
        if (r.error) return res.status(r.status).json({ error: r.error });
        functions.logger.info('Turno movido desde el panel', { turnoId, nuevo: r.turno.id, por: sesion.email });
        return res.status(200).json({ ok: true, turno: r.turno });
      }

      default:
        return res.status(400).json({ error: 'accion_desconocida' });
    }
  } catch (error) {
    if (error.message === 'calendar_no_disponible') {
      return res.status(503).json({ error: 'calendar_no_disponible' });
    }
    functions.logger.error('Error en adminAgenda:', error.message, { accion });
    return res.status(500).json({ error: 'fallo' });
  }
});

// =======================================================================
// mantenerDespierto: el arranque en frio, sin pagarlo
//
// Las 33 functions viven en un solo index.js, asi que cada una carga 425
// archivos al arrancar. Medido en produccion: 4,0 s en frio contra 0,35 s en
// caliente. O sea que el arranque en frio es el 90% de lo que todavia espera
// quien manda un formulario -- y no es trabajo nuestro, es Google levantando
// el contenedor antes de que nuestro codigo exista.
//
// Esto le pega un OPTIONS a los tres endpoints donde alguien espera del otro
// lado. El OPTIONS entra por setCors, contesta 204 y se va: levanta la
// instancia sin hacer nada de trabajo, sin tocar Firestore y sin pagar nada
// (cada ping es una decima de segundo, muy abajo del nivel gratuito).
//
// Un solo trabajo de Cloud Scheduler para los tres. Si en lugar de esto se
// usara un trabajo por endpoint, se gastarian los 3 gratis que regala
// Scheduler y no quedaria ninguno para otra cosa.
//
// Lo que esto NO es: una garantia. Google puede apagar la instancia igual, y
// mantiene UNA: si dos personas envian el formulario al mismo tiempo, la
// segunda arranca en frio. La alternativa que si lo garantiza es
// minInstances, que son entre USD 1,50 y 4,20 por mes segun cuantos
// endpoints y con cuanta memoria. Por eso esto loguea cuanto tardo cada
// ping: son los numeros con los que decidir si vale la pena pagar.
// =======================================================================
const { onSchedule } = require('firebase-functions/v2/scheduler');

const DESPERTAR = ['registrarInscripcion', 'suscribir', 'reservarTurno'];

exports.mantenerDespierto = onSchedule({
  // De 8 de la manana a medianoche, hora de Argentina. De madrugada nadie se
  // inscribe y quien lo haga paga los 4 segundos: no vale tenerlo prendido.
  schedule: '*/5 8-23 * * *',
  timeZone: 'America/Argentina/Cordoba',
  region: 'us-central1',
  memory: '256MiB',
  timeoutSeconds: 60,
  retryCount: 0,
}, async () => {
  const proyecto = process.env.GCLOUD_PROJECT || 'sebabru-e5563';
  const base = `https://us-central1-${proyecto}.cloudfunctions.net`;

  const resultados = await Promise.all(DESPERTAR.map(async (nombre) => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}/${nombre}`, {
        method: 'OPTIONS',
        headers: {
          // Un preflight como el que manda el browser: sin un Origin de la
          // lista, setCors no devuelve la cabecera y el OPTIONS no sirve de
          // ensayo de lo que va a pasar de verdad.
          Origin: 'https://sebabru.com',
          'Access-Control-Request-Method': 'POST',
        },
      });
      return { nombre, estado: r.status, ms: Date.now() - t0 };
    } catch (error) {
      return { nombre, error: error.message, ms: Date.now() - t0 };
    }
  }));

  // Un ping de ~4000 ms es una instancia que se habia apagado; uno de ~300 ms
  // es una que seguia prendida. Es la medicion que dice si hace falta pagar
  // minInstances o no.
  functions.logger.info('Instancias despertadas', { resultados });
});
