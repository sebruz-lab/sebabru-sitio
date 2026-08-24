const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const CURSO_URLS = {
  luna:      '/escuela/abierta/luna/',
  tarot:     '/escuela/abierta/tarot/',
  signos:    '/escuela/abierta/signos/',
  casas:     '/escuela/abierta/casas/',
  pluton26:  '/escuela/abierta/pluton26/',
};

const PRECIOS = {
  luna:      { ars: 60000, usd: 50 },
  tarot:     { ars: 80000, usd: 60 },
  signos:    { ars: 60000, usd: 50 },
  casas:     { ars: 60000, usd: 50 },
  pluton26:  { ars: 80000, usd: 70 },
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

async function validarCodigo(codigo, cursoId) {
  if (!codigo) return null;
  const snap = await _db.collection('codigos_descuento').doc(codigo.toUpperCase()).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data.activo) return null;
  if (data.expiraEn && data.expiraEn.toDate() < new Date()) return null;
  if (data.maxUsos && data.usos >= data.maxUsos) return null;
  if (data.cursos?.length && !data.cursos.includes(cursoId)) return null;
  return data;
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
    if (!snap.exists()) {
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
// crearPago: MercadoPago
// -------------------------------------------------------
exports.crearPago = functions.https.onRequest(async (req, res) => {
  setCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: { status: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });

  ensureInit();

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: { status: 'UNAUTHENTICATED', message: 'Debés iniciar sesión para comprar.' } });
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(authHeader.replace('Bearer ', ''));
  } catch (e) {
    return res.status(401).json({ error: { status: 'UNAUTHENTICATED', message: 'Token inválido.' } });
  }

  const userEmail = decodedToken.email;
  const { cursoId, codigoDescuento } = req.body.data || {};
  const cursoNombre = sanitizeTexto(req.body.data?.cursoNombre, 200);

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
        payer: { email: userEmail },
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
          user_email: userEmail,
          codigo_descuento: codigoData ? codigoDescuento.toUpperCase() : null,
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

  const { type, data } = req.body;
  functions.logger.info('Webhook recibido', { type, data });

  if (type !== 'payment' || !data?.id) return res.status(200).send('OK');

  try {
    const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const paymentClient = new Payment(mpClient);

    const payment = await paymentClient.get({ id: data.id });

    if (payment.status !== 'approved') {
      functions.logger.info('Pago no aprobado', { id: data.id, status: payment.status });
      return res.status(200).send('OK');
    }

    const { curso_id, curso_nombre, user_email, codigo_descuento } = payment.metadata || {};

    if (!user_email || !curso_id) {
      functions.logger.error('Metadata incompleta en pago', { id: data.id });
      return res.status(200).send('OK');
    }

    const pagoRef = _db.collection('pagos_procesados').doc(String(data.id));
    const pagoSnap = await pagoRef.get();
    if (pagoSnap.exists) {
      functions.logger.info('Pago ya procesado', { id: data.id });
      return res.status(200).send('OK');
    }
    await pagoRef.set({ procesadoEn: admin.firestore.FieldValue.serverTimestamp() });

    const userRef = _db.collection('usuarios').doc(user_email.toLowerCase().trim());
    await userRef.set({ cursos: admin.firestore.FieldValue.arrayUnion(curso_id) }, { merge: true });

    if (codigo_descuento) {
      await _db.collection('codigos_descuento').doc(codigo_descuento).update({
        usos: admin.firestore.FieldValue.increment(1)
      });
    }

    functions.logger.info('Acceso otorgado', { user_email, curso_id });

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    const nombreCurso = curso_nombre || curso_id;
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

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: { status: 'UNAUTHENTICATED', message: 'Debés iniciar sesión para comprar.' } });
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(authHeader.replace('Bearer ', ''));
  } catch (e) {
    return res.status(401).json({ error: { status: 'UNAUTHENTICATED', message: 'Token inválido.' } });
  }

  const userEmail = decodedToken.email.toLowerCase().trim();
  const { cursoId, codigoDescuento } = req.body.data || {};
  const cursoNombre = sanitizeTexto(req.body.data?.cursoNombre, 200);

  const preciosBase = PRECIOS[cursoId];
  if (!cursoId || !cursoNombre || !preciosBase) {
    return res.status(400).json({ error: { status: 'INVALID_ARGUMENT', message: 'Faltan datos del curso.' } });
  }

  const codigoData = await validarCodigo(codigoDescuento, cursoId);
  const descuento = codigoData?.descuento || 0;
  const precioUsd = (preciosBase.usd * (1 - descuento / 100)).toFixed(2);

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

  if (!nombre || !esquina || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  const pedidoId = uuidv4();

  try {
    await _db.collection('pedidos').doc(pedidoId).set({
      nombre,
      esquina,
      email,
      metodo,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

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
// exitoPaypal
// -------------------------------------------------------
exports.exitoPaypal = functions.https.onRequest(async (req, res) => {
  ensureInit();

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

    const pagoRef = _db.collection('pagos_procesados').doc(`paypal_${orderId}`);
    if ((await pagoRef.get()).exists) {
      return res.redirect(`${process.env.SITE_URL}/escuela/abierta/gracias.html`);
    }
    await pagoRef.set({ procesadoEn: admin.firestore.FieldValue.serverTimestamp() });

    const ordenSnap = await _db.collection('ordenes_paypal').doc(orderId).get();
    if (!ordenSnap.exists) {
      functions.logger.error('Orden PayPal no encontrada en Firestore', { orderId });
      return res.redirect(`${process.env.SITE_URL}/escuela/abierta/gracias.html`);
    }
    const { cursoId, cursoNombre, userEmail, codigoDescuento } = ordenSnap.data();

    await _db.collection('usuarios').doc(userEmail).set({
      cursos: admin.firestore.FieldValue.arrayUnion(cursoId)
    }, { merge: true });

    if (codigoDescuento) {
      await _db.collection('codigos_descuento').doc(codigoDescuento).update({
        usos: admin.firestore.FieldValue.increment(1)
      });
    }

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

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
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
