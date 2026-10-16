const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const CURSO_URLS = {
  luna:      '/escuela/abierta/luna/',
  tarot:     '/escuela/abierta/tarot/',
  signos:    '/escuela/abierta/signos/',
  casas:     '/escuela/abierta/casas/',
  pluton26:  '/escuela/abierta/pluton26/',
  lilith:    '/escuela/abierta/lilith/',
  linaje:    '/escuela/abierta/linaje/',
  lunas26:   '/escuela/lunas26/',
  quiron:    '/escuela/quiron/',
};

const PRECIOS = {
  luna:      { ars: 60000, usd: 50 },
  tarot:     { ars: 80000, usd: 60 },
  signos:    { ars: 60000, usd: 50 },
  casas:     { ars: 60000, usd: 50 },
  pluton26:  { ars: 80000, usd: 70 },
  lilith:    { ars: 80000, usd: 50 },
  linaje:    { ars: 60000, usd: 50 },
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
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

// Limite simple por IP en una ventana fija, guardado en Firestore.
// No es a prueba de balas (alguien con muchas IPs lo esquiva) pero frena
// el caso real mas probable: un script en loop pegandole a un endpoint
// sin login desde una sola conexion.
async function checkRateLimit(nombreFuncion, req, maxRequests) {
  const ipCruda = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  const key = `${nombreFuncion}_${ipCruda}`.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
  const ref = _db.collection('rate_limits').doc(key);

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
          success: `${process.env.SITE_URL}/escuela/abierta/gracias.html`,
          failure: `${process.env.SITE_URL}/escuela/abierta/`,
          pending: `${process.env.SITE_URL}/escuela/abierta/`
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
        application_context: {
          brand_name: 'Seba Bru Astrología',
          return_url: 'https://us-central1-sebabru-e5563.cloudfunctions.net/exitoPaypal',
          cancel_url: `${process.env.SITE_URL}/escuela/abierta/`
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

    const approveLink = order.links.find(l => l.rel === 'approve');
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
  // Mismo calculo que el checkout: transferencia = 10% + el descuento del codigo.
  const monto = Math.round(preciosBase.ars * (1 - (10 + descuento) / 100));

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
