const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const dnsPromesas = require('dns').promises;
const { sheets: sheetsApi } = require('@googleapis/sheets');
const { JWT } = require('google-auth-library');
const brevo = require('./brevo');

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
async function checkRateLimit(nombreFuncion, req, maxRequests) {
  const ref = _db.collection('rate_limits').doc(claveRateLimit(nombreFuncion, req));

  return _db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const ahora = Date.now();

    if (!snap.exists || (ahora - snap.data().windowStart) > RATE_LIMIT_WINDOW_MS) {
      tx.set(ref, { windowStart: ahora, count: 1 });
      return true;
    }

    if (snap.data().count >= maxRequests) return false;

    tx.update(ref, { count: admin.firestore.FieldValue.increment(1) });
    return true;
  });
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
    functions.logger.warn('MP_WEBHOOK_SECRET no configurado: firma del webhook sin verificar.');
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

// Verifica un token de Cloudflare Turnstile contra siteverify. Si
// TURNSTILE_SECRET_KEY no esta configurado, no bloquea nada (igual que
// verificarFirmaMP) para no romper en desarrollo/emulador.
async function verificarTurnstile(token, req) {
  const secreto = process.env.TURNSTILE_SECRET_KEY;
  if (!secreto) {
    functions.logger.warn('TURNSTILE_SECRET_KEY no configurado: captcha sin verificar.');
    return true;
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
    await _db.collection('brevo_contactos').add({
      ...datos,
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
    tx.update(invRef, {
      usado: true,
      usada: true,
      usadoPor: userEmail,
      usadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  if (inv.expiraEn) {
    const expira = inv.expiraEn.toDate ? inv.expiraEn.toDate() : new Date(inv.expiraEn);
    if (expira < new Date()) {
      throw new functions.https.HttpsError('deadline-exceeded', 'Esta invitación expiró.');
    }
  }

  const emailDestino = (inv.emailDestino || inv.email || '').toLowerCase().trim();
  if (emailDestino && emailDestino !== userEmail) {
    throw new functions.https.HttpsError('permission-denied', `Esta invitación es exclusiva para ${emailDestino}.`);
  }

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
    const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(mpClient);

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
    return res.status(500).json({ error: { status: 'INTERNAL', message: error.message } });
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
    const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const paymentClient = new Payment(mpClient);

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

    if (codigo_descuento) {
      await _db.collection('codigos_descuento').doc(codigo_descuento).update({
        usos: admin.firestore.FieldValue.increment(1)
      });
    }

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

  try {
    const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const paymentClient = new Payment(mpClient);
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

    const esRegalo = payment.metadata?.regalo === 'true';
    // Pago sin cuenta asociada (metaEmail vacío): no hay forma de confirmar
    // que quien llama a este endpoint con el payment_id (visible en la URL
    // de vuelta de MP) es realmente quien pagó. Lo tratamos igual que un
    // regalo: se genera/recupera un código de un solo uso en "regalos" (con
    // su propio chequeo de "ya usado") en vez de otorgar el curso directo a
    // cualquiera que llegue con el payment_id.
    const esAnonima = !metaEmail;

    if (esRegalo || esAnonima) {
      const pagoRef = _db.collection('pagos_procesados').doc(String(paymentId));
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
    return res.status(500).json({ error: { status: 'INTERNAL', message: error.message } });
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
    const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(mpClient);

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
    return res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------
// guardarPedido: Guarda datos de envío del libro
// -------------------------------------------------------
exports.guardarPedido = functions.https.onRequest(async (req, res) => {
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
      const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
      const paymentClient = new Payment(mpClient);
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

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    await transporter.sendMail({
      from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
      to: 'sebruz@gmail.com',
      subject: `📦 Nuevo pedido Luna Negra — ${nombre}`,
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
      `
    });

    functions.logger.info('Pedido guardado', { pedidoId, email, metodo });
    return res.status(200).json({ ok: true });

  } catch (error) {
    functions.logger.error('Error en guardarPedido:', error.message);
    return res.status(500).json({ error: error.message });
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
    confirmacion: {
      asunto: 'Tu consulta astrológica',
      parrafos: (nombre, conCarta, modalidad) => [
        `Hola, ${nombre}:`,
        'Recibimos tu pedido de consulta. Ya tenemos tus datos.',
        conCarta ? 'Te mando adjunta tu carta natal, calculada con los datos que nos pasaste (fecha, hora y lugar de nacimiento). Revisá que estén bien: si algo no coincide, respondé este mail y la corregimos.' : '',
        'El tiempo de espera para una sesión es de entre una y dos semanas: te escribimos para coordinar el día y la hora.',
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
    confirmacion: {
      asunto: 'Tu consulta astrológica',
      parrafos: (nombre, conCarta, modalidad) => [
        `Hola, ${nombre}:`,
        'Recibimos tus datos para la consulta que te regalaron. Está todo listo de tu lado.',
        conCarta ? 'Te mando adjunta tu carta natal, calculada con los datos que nos pasaste (fecha, hora y lugar de nacimiento). Revisá que estén bien: si algo no coincide, respondé este mail y la corregimos.' : '',
        'El tiempo de espera para una sesión es de entre una y dos semanas: te escribimos para coordinar el día y la hora.',
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
  _sheetsClient = sheetsApi({ version: 'v4', auth });
  return _sheetsClient;
}

// Crea la pestaña (con fila de encabezados) si todavia no existe en el
// documento -- asi sumar un formulario nuevo no requiere crear la hoja a mano.
// Devuelve los titulos que tiene la fila 1, que es lo que usa el modo
// columnasPorEncabezado para saber en que columna va cada valor.
async function asegurarHojaInscripcion(sheets, spreadsheetId, nombreHoja, encabezados, porEncabezado) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existe = (meta.data.sheets || []).some(s => s.properties.title === nombreHoja);
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
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${nombreHoja}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [encabezados] },
    });
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
  return encabezados;
}

exports.registrarInscripcion = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();

  if (!(await checkRateLimit('registrarInscripcion', req, 10))) {
    return res.status(429).json({ error: 'Demasiados pedidos desde esta conexión. Probá de nuevo en unos minutos.' });
  }

  // A partir del 3er envio desde la misma IP (en la ventana de 10 min de
  // checkRateLimit), pedimos un captcha de Cloudflare Turnstile resuelto.
  // Los primeros 2 pasan libres para no molestar a quien se equivoca en el
  // formulario o se anota con un amigx desde la misma conexion.
  const intentosSnap = await _db.collection('rate_limits').doc(claveRateLimit('registrarInscripcion', req)).get();
  const intentos = intentosSnap.exists ? intentosSnap.data().count : 1;
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

  try {
    const sheets = getSheetsClient();
    // Si el formulario declara su propia planilla por variable de entorno y
    // esa variable no llego al deploy, antes caia en silencio en la planilla
    // de las inscripciones y escribia ahi: todo contestaba 200 y la fila
    // aparecia en otro lado. Mejor fallar y que se vea.
    if (config.spreadsheetEnv && !process.env[config.spreadsheetEnv]) {
      throw new Error(`Falta ${config.spreadsheetEnv} en el entorno de la función (formulario ${formId})`);
    }
    const spreadsheetId = (config.spreadsheetEnv && process.env[config.spreadsheetEnv])
      || config.spreadsheet || process.env.SHEETS_SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error(`Falta la planilla del formulario ${formId}`);
    const etiquetaFecha = config.etiquetaFecha || 'Fecha de inscripción';
    const encabezados = [etiquetaFecha, ...config.campos.map(c => c.label)];
    if (config.columnaCarta) encabezados.push(config.columnaCarta);
    // Columnas que no vienen del formulario sino del formulario mismo (hoy,
    // si la consulta es un regalo): el mismo valor en todas sus filas.
    for (const titulo of Object.keys(config.columnasFijas || {})) encabezados.push(titulo);
    // Los campos "finales" van despues de la columna Carta y de las fijas,
    // asi un campo nuevo del formulario no corre ninguna columna que ya
    // tenga datos en la planilla.
    for (const c of config.camposFinales || []) encabezados.push(c.label);
    const titulos = await asegurarHojaInscripcion(
      sheets, spreadsheetId, config.hoja, encabezados, config.columnasPorEncabezado
    );

    // La carta se arma antes de escribir la fila, asi la planilla dice si
    // salio sola o si hay que hacerla a mano (pasa cuando el lugar de
    // nacimiento no esta en el buscador y la persona lo escribe igual).
    const carta = config.carta ? cartaDeInscripcion(valores, req.body?.lugar, config.carta.grupo) : null;
    const estadoCarta = carta ? 'Sí' : 'No: el lugar no se eligió de la lista';

    const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    let fila;
    if (config.columnasPorEncabezado) {
      // Cada valor va en la columna que lleva su titulo, sin importar en que
      // posicion quedo: asi la hoja se puede reordenar o ampliar a mano.
      const porTitulo = { [etiquetaFecha]: ahora };
      for (const c of config.campos) porTitulo[c.label] = valores[c.key] || '';
      if (config.columnaCarta) porTitulo[config.columnaCarta] = estadoCarta;
      Object.assign(porTitulo, config.columnasFijas || {});
      for (const c of config.camposFinales || []) porTitulo[c.label] = valores[c.key] || '';
      fila = titulos.map(t => (t in porTitulo ? porTitulo[t] : ''));
    } else {
      fila = [ahora, ...config.campos.map(c => valores[c.key] || '')];
      if (config.columnaCarta) fila.push(estadoCarta);
      fila.push(...Object.values(config.columnasFijas || {}));
      fila.push(...(config.camposFinales || []).map(c => valores[c.key] || ''));
    }

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
    // En que planilla y en que celdas quedo, para no tener que adivinar
    // cuando alguien no encuentra una fila.
    functions.logger.info('Fila agregada', {
      formId,
      planilla: spreadsheetId,
      rango: escrito.data?.updates?.updatedRange || '(no lo dijo)',
      columnas: titulos.length,
    });

    let cartaGuardada = false;
    if (carta) {
      try {
        await guardarCartaInscripcion(config, carta);
        cartaGuardada = true;
      } catch (error) {
        functions.logger.error('No se pudo guardar la carta de la inscripción:', error.message);
      }
    }
    // La confirmacion (con la carta en PDF) la manda enviarCartaInscripcion,
    // aparte: armar el PDF tarda y la persona no tiene que esperarlo.
    if (config.confirmacion && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valores.email || '')) {
      try {
        await _db.collection('envios_carta').add({
          formId, email: valores.email, nombre: valores.nombre || '', modalidad: valores.modalidad || null, carta, creado: new Date().toISOString(),
        });
      } catch (error) {
        functions.logger.error('No se pudo pedir el mail de confirmación:', error.message);
      }
    }

    // Y el alta en el mailing, por la misma cola. A la lista del formulario
    // entra siempre; a la de lunaciones, solo si marco el casillero.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valores.email || '')) {
      const quiereNovedades = valores.novedades === 'Sí';
      await encolarContactoBrevo({
        email: valores.email,
        nombre: valores.nombre || '',
        listas: [
          ...(config.brevoLista ? [config.brevoLista] : []),
          ...(quiereNovedades ? ['suscriptores'] : []),
        ],
        atributos: {
          ORIGEN: `formulario-${formId}`,
          CONSENTIMIENTO: quiereNovedades ? 'formulario-checkbox' : 'relacion-comercial',
          TELEFONO_TXT: valores.telefono || '',
        },
        motivo: `inscripcion:${formId}`,
      });
    }

    const filasHtml = [...config.campos, ...(config.camposFinales || [])].map(c =>
      `<tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;width:180px;">${escapeHtml(c.label)}</td><td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(valores[c.key] || '—')}</td></tr>`
    ).join('') + (config.carta
      ? `<tr><td style="padding:10px;border-bottom:1px solid #eee;color:#888;width:180px;">Carta</td><td style="padding:10px;border-bottom:1px solid #eee;">${cartaGuardada
        ? `Guardada en tus cartas de <a href="https://sebabru.com/cartas/">sebabru.com/cartas</a> (${escapeHtml(config.carta.grupo)})`
        : 'No se guardó: el lugar no se eligió de la lista. Cargala a mano.'}</td></tr>`
      : '');

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    await transporter.sendMail({
      from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
      to: AVISOS_INSCRIPCION,
      subject: `📝 Nueva inscripción — ${config.nombreEvento}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;">
          <h2 style="color:#249b95;">Nueva inscripción: ${escapeHtml(config.nombreEvento)}</h2>
          <table style="width:100%;border-collapse:collapse;margin-top:16px;">
            ${filasHtml}
          </table>
        </div>
      `
    });

    functions.logger.info('Inscripción registrada', { formId, hoja: config.hoja });
    return res.status(200).json({ ok: true });

  } catch (error) {
    functions.logger.error('Error en registrarInscripcion:', error.message);
    return res.status(500).json({ error: error.message });
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
  const parrafos = config.confirmacion.parrafos(nombre, Boolean(pdf), envio.modalidad);
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

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: `"Seba Bru Astrología" <${process.env.GMAIL_USER}>`,
      to: AVISOS_INSCRIPCION,
      subject: 'El buscador de lugares se quedó sin respaldo',
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
]);

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
      new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('timeout')), 3000)),
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

exports.suscribir = functions.https.onRequest(async (req, res) => {
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

  const atributos = {
    ORIGEN: origen,
    UTM: utmComoTexto(sanitizeOrigen(req.body?.utm)),
    FECHA_ALTA: brevo.fechaBrevo(new Date()),
    CONSENTIMIENTO: 'doi-sitio',
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
      await anotarPedido('ya_suscrito');
      return res.status(200).json({ ok: true, estado: 'ya_suscrito' });
    }

    // Alta directa, sin paso de confirmacion. Lo que cuida que la direccion
    // sea de verdad es el captcha (desde el primer envio), la trampa para
    // bots, el control de tipeos y la revision de MX de mas arriba.
    await brevo.upsertContacto({ email, nombre, listas: ['suscriptores'], atributos });

    // La bienvenida es un agregado: si falla, la persona ya quedo suscrita
    // igual y no tiene sentido devolverle un error por eso.
    try {
      await brevo.enviarConPlantilla({
        email, nombre,
        templateId: process.env.BREVO_BIENVENIDA_TEMPLATE_ID,
      });
    } catch (error) {
      functions.logger.error('No se pudo mandar la bienvenida:', error.message);
    }

    await anotarPedido('suscrito');
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
    await brevo.upsertContacto({
      email,
      listas: ['suscriptores'],
      atributos: {
        ORIGEN: 'tucarta',
        CONSENTIMIENTO: 'tucarta-novedades',
        FECHA_ALTA: brevo.fechaBrevo(new Date()),
      },
    });
  } else {
    await brevo.quitarDeLista(email, ['suscriptores']);
  }
});
