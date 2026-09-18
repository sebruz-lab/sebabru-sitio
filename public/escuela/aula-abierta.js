// public/escuela/aula-abierta.js
//
// Gating compartido para las aulas de Formacion Abierta:
// - Sin login: se ve el temario completo y la Clase 1 se puede "desbloquear"
//   iniciando sesion (login liviano, sirve para captar el mail de un lead).
// - Logueado sin haber comprado: la Clase 1 se reproduce directo, el resto
//   queda con candado + boton para comprar. Se marca el mail como interesado
//   en el curso (usuarios/{email}.interesados).
// - Logueado y con el curso comprado: se desbloquea todo.
import {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { app, auth, db } from './firebase.js';
import { videoEntryToSrc } from './escuela.js?v=2';

const OBTENER_MUESTRA_URL = 'https://us-central1-sebabru-e5563.cloudfunctions.net/obtenerMuestra';
const CREAR_PAGO_PAYPAL_URL = 'https://us-central1-sebabru-e5563.cloudfunctions.net/crearPagoPaypal';

const PRECIOS = {
  luna:      { ars: 60000, usd: 50, nombre: 'La Luna en la carta natal' },
  tarot:     { ars: 80000, usd: 60, nombre: 'Tarot — Mazo Rider-Waite' },
  signos:    { ars: 60000, usd: 50, nombre: 'Signos' },
  casas:     { ars: 60000, usd: 50, nombre: 'Casas y ascendentes' },
  pluton26:  { ars: 80000, usd: 70, nombre: 'Plutón y los Nodos Lunares' },
  lilith:    { ars: 80000, usd: 50, nombre: 'Luna Negra · Lilith en la carta natal' },
};

const MODAL_HTML = `
<div id="aula-login-modal" class="modal-overlay">
  <div class="modal-box">
    <button type="button" id="aula-close-modal" class="close-btn">&times;</button>
    <p style="font-size:0.85rem; opacity:0.8; margin-bottom:14px;">Iniciá sesión para ver la clase gratis &mdash; es gratis, solo pedimos tu mail.</p>
    <div class="google-auth-container" style="margin-bottom:20px; text-align:center;">
      <button type="button" id="aula-btn-google" style="width:100%; display:flex; align-items:center; justify-content:center; gap:10px; background:white; color:#444; border:1px solid #ddd; padding:10px; border-radius:5px; cursor:pointer; font-family:sans-serif; font-weight:bold;">
        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" width="18" height="18">
        CONTINUAR CON GOOGLE
      </button>
      <h3 style="margin:15px 0; color:#888; font-size:0.8rem;">&mdash; O BIEN &mdash;</h3>
    </div>
    <div id="aula-seccion-login">
      <h2>Ingresar</h2>
      <form id="aula-login-form">
        <input type="email" id="aula-email-login" placeholder="Tu Email" required>
        <input type="password" id="aula-pass-login" placeholder="Contraseña" required>
        <button type="submit" class="btn-login">ENTRAR</button>
      </form>
      <p style="margin-top:10px; font-size:0.9em;">¿No tenés cuenta? <a href="#" id="aula-ir-a-registro">Registrate aquí</a></p>
    </div>
    <div id="aula-seccion-registro" style="display:none;">
      <h2>Crear Cuenta</h2>
      <form id="aula-registro-form">
        <input type="email" id="aula-email-registro" placeholder="Tu Email" required>
        <input type="password" id="aula-pass-registro" placeholder="Creá una contraseña" required>
        <button type="submit" class="btn-login" style="background:#4CAF50;">CREAR CUENTA</button>
      </form>
      <p style="margin-top:10px; font-size:0.9em;">¿Ya tenés cuenta? <a href="#" id="aula-ir-a-login">Ingresá aquí</a></p>
    </div>
    <p class="error-msg" id="aula-login-error" style="display:none; color:red; margin-top:10px;"></p>
  </div>
</div>`;

function asegurarModal() {
  if (document.getElementById('aula-login-modal')) return;
  document.body.insertAdjacentHTML('beforeend', MODAL_HTML);

  const modal = document.getElementById('aula-login-modal');
  const cerrar = () => modal.classList.remove('active');
  document.getElementById('aula-close-modal').addEventListener('click', cerrar);
  modal.addEventListener('click', e => { if (e.target === modal) cerrar(); });

  document.getElementById('aula-ir-a-registro').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('aula-seccion-login').style.display = 'none';
    document.getElementById('aula-seccion-registro').style.display = 'block';
  });
  document.getElementById('aula-ir-a-login').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('aula-seccion-registro').style.display = 'none';
    document.getElementById('aula-seccion-login').style.display = 'block';
  });

  const mostrarError = (msg) => {
    const el = document.getElementById('aula-login-error');
    el.textContent = msg;
    el.style.display = 'block';
  };

  document.getElementById('aula-login-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, document.getElementById('aula-email-login').value, document.getElementById('aula-pass-login').value);
      cerrar();
    } catch { mostrarError('Email o contraseña incorrectos.'); }
  });
  document.getElementById('aula-registro-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await createUserWithEmailAndPassword(auth, document.getElementById('aula-email-registro').value, document.getElementById('aula-pass-registro').value);
      cerrar();
    } catch (err) { mostrarError('No se pudo crear la cuenta. ' + err.message); }
  });
  document.getElementById('aula-btn-google').addEventListener('click', async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); cerrar(); }
    catch { mostrarError('No se pudo iniciar con Google.'); }
  });
}

function abrirModal() {
  asegurarModal();
  document.getElementById('aula-login-modal').classList.add('active');
}

function contenedorDe(clase) {
  return clase.querySelector('div[style*="position:relative"]');
}

function bloquearClase(clase) {
  if (clase.dataset.bloqueada) return;
  clase.dataset.bloqueada = '1';
  const cont = contenedorDe(clase);
  if (!cont) return;
  const iframe = cont.querySelector('iframe');
  if (iframe) iframe.style.display = 'none';
  const candado = document.createElement('div');
  candado.className = 'clase-candado';
  candado.innerHTML = `
    <i class="fa-solid fa-lock"></i>
    <p>Comprá el curso para desbloquear esta clase</p>
    <a href="#checkout-aula" class="btn-external">Ver planes</a>`;
  cont.appendChild(candado);
}

function quitarCandado(clase) {
  delete clase.dataset.bloqueada;
  const c = clase.querySelector('.clase-candado');
  if (c) c.remove();
  const iframe = contenedorDe(clase)?.querySelector('iframe');
  if (iframe) iframe.style.display = 'block';
}

function insertarBotonComprar() {
  if (document.getElementById('btn-comprar-aula')) return;
  const sidebarContent = document.querySelector('.sidebar-content');
  const footer = document.querySelector('.sidebar-footer');
  if (!sidebarContent || !footer) return;
  const btn = document.createElement('a');
  btn.id = 'btn-comprar-aula';
  btn.href = '#checkout-aula';
  btn.className = 'btn-sidebar-main btn-comprar-aula';
  btn.innerHTML = '<i class="fa-solid fa-cart-shopping"></i> Comprar este curso';
  sidebarContent.insertBefore(btn, footer);
}

function ocultarBotonComprar() {
  document.getElementById('btn-comprar-aula')?.remove();
}

function construirCheckoutHTML(info) {
  const precioTrans = Math.round(info.ars * 0.9);
  return `
<section class="checkout-aula" id="checkout-aula">
  <p class="checkout-titulo">¿Querés el curso completo?</p>
  <p class="checkout-sub">Comprás una vez, acceso permanente. Sin fecha de inicio, sin vencimiento.</p>
  <div class="comprar-section" id="seccion-compra">
    <details class="comprar-main" open>
      <summary>
        <span class="summary-left"><i class="fa-brands fa-cc-mastercard" style="color:#009ee3; font-size:1.1rem;"></i> Mercado Pago</span>
        <i class="fa-solid fa-chevron-down summary-chevron"></i>
      </summary>
      <div class="comprar-body">
        <p class="precio-mp" id="precio-mp">$${info.ars.toLocaleString('es-AR')} <span>ARS</span></p>
        <button class="btn-mp" id="btn-pagar-mp" type="button">
          <i class="fa-brands fa-cc-mastercard"></i> PAGAR CON MERCADO PAGO
        </button>
        <p class="login-aviso" id="aviso-login-mp">No hace falta iniciar sesión para comprar. El acceso te llega por mail. Si preferís, podés <a id="link-login-mp">iniciar sesión antes</a>.</p>
      </div>
    </details>
    <details class="comprar-main">
      <summary>
        <span class="summary-left">
          <i class="fa-solid fa-building-columns" style="color:#cfcfd6; font-size:1rem;"></i>
          Transferencia <span id="tag-trans" style="font-size:0.72rem; background:rgba(255,255,255,0.1); color:#f0f0f4; border:1px solid rgba(255,255,255,0.25); border-radius:20px; padding:2px 8px;">10% off</span>
        </span>
        <i class="fa-solid fa-chevron-down summary-chevron"></i>
      </summary>
      <div class="comprar-body">
        <div class="precio-transferencia">
          <span class="precio-final" id="precio-trans">$${precioTrans.toLocaleString('es-AR')}</span>
          <span class="precio-original">$${info.ars.toLocaleString('es-AR')}</span>
          <span class="descuento-tag" id="dtag-trans">-10%</span>
        </div>
        <div class="datos-bancarios">
          <div><strong>Banco:</strong> Galicia</div>
          <div><strong>Titular:</strong> SEBASTIAN MATIAS BRUZZESE</div>
          <div><strong>CTA:</strong> 4034684-5 274-4</div>
          <div><strong>CBU:</strong> 00702746-30004034684549</div>
          <div><strong>CUIL:</strong> 20-30712644-4</div>
        </div>
        <div class="alias-row">
          <span class="alias-valor">Seba.astrologia</span>
          <button class="btn-copiar-alias" id="btn-copiar-alias" type="button">
            <i class="fa-solid fa-copy"></i> Copiar alias
          </button>
        </div>
        <div id="info-comprobante" style="display:none; margin-top:14px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.18); border-radius:10px; padding:14px 16px;">
          <p style="font-size:0.82rem; color:#ccc; margin:0 0 10px; line-height:1.7;">
            <i class="fa-solid fa-circle-check" style="color:#f0f0f4; margin-right:6px;"></i>
            Alias copiado. Enviá el comprobante a <strong style="color:#f0f0f0;">sebruz@gmail.com</strong> o al <strong style="color:#f0f0f0;">+54 9 3544 584122</strong>
          </p>
          <a class="wa-comprobante" href="#" target="_blank" rel="noopener noreferrer"
             style="display:inline-flex; align-items:center; gap:8px; background:#25d366; color:white; padding:9px 16px; border-radius:7px; text-decoration:none; font-size:0.82rem; font-family:'Outfit',sans-serif;">
            <i class="fa-brands fa-whatsapp" style="font-size:1rem;"></i> Ya pagué &mdash; enviar comprobante
          </a>
        </div>
      </div>
    </details>
    <details class="comprar-main">
      <summary>
        <span class="summary-left">
          <i class="fa-brands fa-paypal" style="color:#7ea8e0; font-size:1.15rem;"></i>
          PayPal <span style="font-size:0.72rem; background:rgba(255,255,255,0.1); color:#f0f0f4; border:1px solid rgba(255,255,255,0.25); border-radius:20px; padding:2px 8px;">Internacional</span>
        </span>
        <i class="fa-solid fa-chevron-down summary-chevron"></i>
      </summary>
      <div class="comprar-body">
        <p class="precio-mp" id="precio-pp">USD ${info.usd} <span>dólares</span></p>
        <button class="btn-mp" id="btn-pagar-paypal" type="button" style="background:#003087;">
          <i class="fa-brands fa-paypal"></i> PAGAR CON PAYPAL
        </button>
        <p class="login-aviso" id="aviso-login-paypal">No hace falta iniciar sesión para comprar. El acceso te llega por mail. Si preferís, podés <a id="link-login-paypal">iniciar sesión antes</a>.</p>
      </div>
    </details>
    <div class="codigo-descuento-row">
      <input type="text" id="inp-codigo" placeholder="¿Tenés un código de descuento?" maxlength="20">
      <button class="btn-codigo" id="btn-codigo" type="button">Aplicar</button>
      <span class="codigo-msg" id="msg-codigo"></span>
    </div>
  </div>
</section>`;
}

function ocultarCheckout() {
  document.getElementById('checkout-aula')?.remove();
}

function actualizarAvisoLogin(logueado) {
  ['aviso-login-mp', 'aviso-login-paypal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = logueado ? 'none' : 'block';
  });
}

function insertarCheckout(slug, primera, funcs) {
  if (document.getElementById('checkout-aula')) return;
  const info = PRECIOS[slug];
  if (!info) return;

  primera.insertAdjacentHTML('afterend', construirCheckoutHTML(info));

  const wa = document.querySelector('#checkout-aula .wa-comprobante');
  if (wa) wa.href = 'https://wa.me/5493544584122?text=' +
    encodeURIComponent(`Hola Seba, acabo de hacer la transferencia para el curso ${info.nombre}. Te mando el comprobante.`);

  document.getElementById('link-login-mp')?.addEventListener('click', abrirModal);
  document.getElementById('link-login-paypal')?.addEventListener('click', abrirModal);

  document.getElementById('btn-copiar-alias')?.addEventListener('click', () => {
    navigator.clipboard.writeText('Seba.astrologia').then(() => {
      const btn = document.getElementById('btn-copiar-alias');
      const info2 = document.getElementById('info-comprobante');
      btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado';
      if (info2) info2.style.display = 'block';
      setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-copy"></i> Copiar alias'; }, 2500);
    });
  });

  document.querySelector('#checkout-aula .wa-comprobante')?.addEventListener('click', () => {
    if (window.gtag) window.gtag('event', 'pago_comprobante', { curso: slug, metodo: 'transferencia' });
  });

  let codigoAplicado = null;
  const inp = document.getElementById('inp-codigo');
  const btnCod = document.getElementById('btn-codigo');
  const msg = document.getElementById('msg-codigo');
  async function aplicarCodigo() {
    const codigo = inp.value.trim().toUpperCase();
    msg.className = 'codigo-msg';
    if (!codigo) return;
    try {
      const snap = await getDoc(doc(db, 'codigos_descuento', codigo));
      if (!snap.exists()) { msg.textContent = 'Código inválido.'; msg.className = 'codigo-msg error'; codigoAplicado = null; return; }
      const data = snap.data();
      if (!data.activo) { msg.textContent = 'Este código ya no está activo.'; msg.className = 'codigo-msg error'; codigoAplicado = null; return; }
      if (data.expiraEn && data.expiraEn.toDate() < new Date()) { msg.textContent = 'Este código ya expiró.'; msg.className = 'codigo-msg error'; codigoAplicado = null; return; }
      if (data.maxUsos && data.usos >= data.maxUsos) { msg.textContent = 'Este código alcanzó el límite de usos.'; msg.className = 'codigo-msg error'; codigoAplicado = null; return; }
      if (data.cursos?.length && !data.cursos.includes(slug)) { msg.textContent = 'Este código no aplica a este curso.'; msg.className = 'codigo-msg error'; codigoAplicado = null; return; }
      codigoAplicado = { codigo, descuento: data.descuento };
      const precioConDesc = Math.round(info.ars * (1 - data.descuento / 100));
      const usdConDesc = (info.usd * (1 - data.descuento / 100)).toFixed(0);
      const descTotal = 10 + data.descuento;
      const precioTransConDesc = Math.round(info.ars * (1 - descTotal / 100));
      document.getElementById('precio-mp').innerHTML = `$${precioConDesc.toLocaleString('es-AR')} <span>ARS &middot; ${data.descuento}% off</span>`;
      document.getElementById('precio-pp').innerHTML = `USD ${usdConDesc} <span>dólares &middot; ${data.descuento}% off</span>`;
      document.getElementById('precio-trans').textContent = `$${precioTransConDesc.toLocaleString('es-AR')}`;
      document.getElementById('dtag-trans').textContent = `-${descTotal}%`;
      document.getElementById('tag-trans').textContent = `${descTotal}% off`;
      msg.textContent = `${data.descuento}% de descuento aplicado`;
      msg.className = 'codigo-msg ok';
    } catch (e) { msg.textContent = 'Error al verificar el código.'; msg.className = 'codigo-msg error'; }
  }
  btnCod?.addEventListener('click', aplicarCodigo);
  inp?.addEventListener('keydown', e => { if (e.key === 'Enter') aplicarCodigo(); });

  const crearPagoFn = httpsCallable(funcs, 'crearPago');
  document.getElementById('btn-pagar-mp')?.addEventListener('click', async () => {
    if (window.gtag) window.gtag('event', 'begin_checkout', { curso: slug, metodo: 'mp' });
    const loading = document.getElementById('loading-pago-aula') || crearLoadingOverlay();
    loading.style.display = 'flex';
    try {
      const result = await crearPagoFn({ cursoId: slug, cursoNombre: info.nombre, codigoDescuento: codigoAplicado?.codigo || null });
      window.location.href = result.data.init_point;
    } catch (err) {
      loading.style.display = 'none';
      alert('No se pudo iniciar el pago. Intentá de nuevo o escribinos al +54 9 3544 584122.\n' + err.message);
    }
  });

  document.getElementById('btn-pagar-paypal')?.addEventListener('click', async () => {
    if (window.gtag) window.gtag('event', 'begin_checkout', { curso: slug, metodo: 'paypal' });
    const loading = document.getElementById('loading-pago-aula') || crearLoadingOverlay();
    loading.querySelector('p').textContent = 'Preparando tu pago con PayPal...';
    loading.style.display = 'flex';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (auth.currentUser) headers['Authorization'] = `Bearer ${await auth.currentUser.getIdToken()}`;
      const response = await fetch(CREAR_PAGO_PAYPAL_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: { cursoId: slug, cursoNombre: info.nombre, codigoDescuento: codigoAplicado?.codigo || null, regalo: false } })
      });
      const data = await response.json();
      if (data.result?.approve_url) { window.location.href = data.result.approve_url; }
      else { throw new Error(data.error?.message || 'No se pudo crear el pago.'); }
    } catch (err) {
      loading.style.display = 'none';
      alert('No se pudo iniciar el pago con PayPal. Intentá de nuevo o escribinos al +54 9 3544 584122.\n' + err.message);
    }
  });

  actualizarAvisoLogin(!!auth.currentUser);
}

function crearLoadingOverlay() {
  const div = document.createElement('div');
  div.id = 'loading-pago-aula';
  div.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:9999; align-items:center; justify-content:center; flex-direction:column; color:#fff; font-family:"Outfit",sans-serif; gap:18px;';
  div.innerHTML = `
    <div style="width:38px; height:38px; border:3px solid rgba(255,255,255,0.2); border-top-color:#fff; border-radius:50%; animation:aula-spin 0.8s linear infinite;"></div>
    <p>Preparando tu pago...</p>`;
  if (!document.getElementById('aula-spin-style')) {
    const style = document.createElement('style');
    style.id = 'aula-spin-style';
    style.textContent = '@keyframes aula-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }
  document.body.appendChild(div);
  return div;
}

export function initAula(slug, opts = {}) {
  const overlay = document.getElementById('security-overlay');
  const ocultarOverlay = () => { if (overlay) overlay.style.display = 'none'; };

  const funcs = getFunctions(app, 'us-central1');
  const registrarInteresFn = httpsCallable(funcs, 'registrarInteres');

  const clases = Array.from(document.querySelectorAll('.clase-item'));
  if (!clases.length) return;
  const primera = clases[0];
  const resto = clases.slice(1);

  insertarBotonComprar();
  resto.forEach(c => bloquearClase(c));
  insertarCheckout(slug, primera, funcs);

  const previewParams = opts.previewParams || '';
  let muestraRevelada = false;
  let interesRegistrado = false;

  function marcarInteres() {
    if (interesRegistrado) return;
    interesRegistrado = true;
    registrarInteresFn({ cursoId: slug }).catch(() => {});
  }

  function trackMuestra() {
    if (window.gtag) window.gtag('event', 'muestra_gratis', { curso: slug });
  }

  async function revelarMuestraYoutube(iframe) {
    try {
      const resp = await fetch(`${OBTENER_MUESTRA_URL}?curso=${encodeURIComponent(slug)}`);
      const data = await resp.json();
      if (!data.videoId) return false;
      iframe.src = `https://www.youtube.com/embed/${data.videoId}?autoplay=1${previewParams}`;
      return true;
    } catch (e) { return false; }
  }

  function revelarMuestraBunny(iframe) {
    if (!iframe.dataset.src) return false;
    iframe.src = iframe.dataset.src;
    return true;
  }

  async function revelarMuestra() {
    if (muestraRevelada) return;
    const cont = contenedorDe(primera);
    const iframe = cont?.querySelector('iframe');
    if (!cont || !iframe) return;

    const ok = iframe.hasAttribute('data-video')
      ? await revelarMuestraYoutube(iframe)
      : revelarMuestraBunny(iframe);
    if (!ok) return;

    muestraRevelada = true;
    iframe.style.display = 'block';
    cont.querySelector('.clase-gate-play')?.remove();
    trackMuestra();
    marcarInteres();
  }

  function prepararGate() {
    if (muestraRevelada) return;
    const cont = contenedorDe(primera);
    const iframe = cont?.querySelector('iframe');
    if (!cont || !iframe || cont.querySelector('.clase-gate-play')) return;
    iframe.style.display = 'none';
    const gate = document.createElement('button');
    gate.type = 'button';
    gate.className = 'clase-gate-play';
    gate.innerHTML = `
      <i class="fa-solid fa-circle-play"></i>
      <span>Mirar clase gratis</span>
      <span class="gate-sub">Iniciá sesión para verla &mdash; es gratis</span>`;
    gate.addEventListener('click', () => {
      if (auth.currentUser) revelarMuestra();
      else abrirModal();
    });
    cont.appendChild(gate);
  }

  async function desbloquearTodo() {
    ocultarBotonComprar();
    ocultarCheckout();
    const primeraCont = contenedorDe(primera);
    primeraCont?.querySelector('.clase-gate-play')?.remove();
    muestraRevelada = true;

    const primerIframe = primeraCont?.querySelector('iframe');
    if (primerIframe && primerIframe.hasAttribute('data-src')) {
      // Bunny: la Clase 1 (muestra gratis) ya trae su data-src público.
      // El resto de las clases NO viaja en el HTML: se completan recién acá,
      // leyendo cursos/{slug}.videos (protegido por firestore.rules: solo
      // quien ya compró el curso, o un admin, puede leerlo).
      try {
        const cursoSnap = await getDoc(doc(db, 'cursos', slug));
        const videos = [...(cursoSnap.data()?.videos || [])];
        clases.slice(1).forEach(clase => {
          const iframe = contenedorDe(clase)?.querySelector('iframe:not([data-src])');
          if (!iframe) return;
          const entry = videos.shift();
          if (entry) iframe.dataset.src = videoEntryToSrc(entry, 615375);
        });
      } catch (e) { /* si falla, al menos la clase 1 sigue disponible */ }

      const obs = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) { e.target.src = e.target.dataset.src; obs.unobserve(e.target); }
        });
      }, { rootMargin: '200px' });
      document.querySelectorAll('iframe[data-src]').forEach(f => { f.style.display = 'block'; obs.observe(f); });
    } else {
      try {
        const cursoSnap = await getDoc(doc(db, 'cursos', slug));
        const videos = cursoSnap.data()?.videos || [];
        document.querySelectorAll('iframe[data-video]').forEach((iframe, i) => {
          iframe.style.display = 'block';
          if (videos[i]) iframe.src = `https://www.youtube.com/embed/${videos[i]}`;
        });
      } catch (e) { /* si falla, al menos queda desbloqueado visualmente */ }
    }
    clases.forEach(quitarCandado);
  }

  onAuthStateChanged(auth, async (user) => {
    actualizarAvisoLogin(!!user);
    if (!user) { prepararGate(); ocultarOverlay(); return; }

    try {
      const snap = await getDoc(doc(db, 'usuarios', user.email.toLowerCase().trim()));
      const cursos = snap.exists() ? (snap.data().cursos || []) : [];
      if (cursos.includes(slug)) {
        await desbloquearTodo();
      } else {
        await revelarMuestra();
      }
    } catch (e) {
      // Sin datos de usuario (o error de red): tratamos como no-comprador.
      await revelarMuestra();
    }
    ocultarOverlay();
  });
}
