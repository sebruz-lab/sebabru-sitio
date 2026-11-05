// Entrar con Google eligiendo con qué cuenta.
//
// Por defecto Google entra sola con la sesión que ya está abierta en el
// navegador, sin preguntar nada: en una compu compartida, o cuando la
// persona tiene dos mails, eso termina en la cuenta equivocada y después no
// encuentra sus cursos. Con prompt=select_account siempre aparece la lista
// para elegir.
//
// entrarConGoogle avisa además con qué cuenta entró, y cuando ese mail
// todavía no tenía cuenta en el sitio aclara que se acaba de crear una
// nueva (si no, la persona queda con una cuenta vacía sin entender por qué
// no están sus cursos). Ese aviso se espera unos segundos antes de seguir,
// porque varias páginas redirigen enseguida.
//
// El aviso se dibuja acá mismo, con estilos propios, así cualquier página
// del sitio lo tiene sin agregar nada.
import { GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const ESPERA_CUENTA_NUEVA = 3500; // ms

export function proveedorGoogle() {
    const proveedor = new GoogleAuthProvider();
    proveedor.setCustomParameters({ prompt: 'select_account' });
    return proveedor;
}

export function avisoCuentaGoogle({ usuario, nueva }) {
    return nueva
        ? `Creamos una cuenta nueva con ${usuario.email}. Si ya tenías otra, salí y volvé a entrar con ese mail.`
        : `Entraste con ${usuario.email}.`;
}

// Cartelito abajo de la pantalla, encima de todo, que se va solo.
export function avisarCuenta(texto, { importante = false } = {}) {
    const caja = document.createElement('div');
    caja.setAttribute('role', 'status');
    caja.textContent = texto;
    caja.style.cssText = 'position:fixed; bottom:24px; left:50%; transform:translate(-50%,10px);'
        + ' z-index:999999; background:rgba(18,18,26,0.97); color:#fff; padding:14px 22px;'
        + ' border-radius:10px; border:1px solid '
        + (importante ? 'rgba(245,109,150,0.55)' : 'rgba(255,255,255,0.12)') + ';'
        + " box-shadow:0 10px 30px rgba(0,0,0,0.5); font-family:'Outfit',sans-serif; font-size:0.92rem;"
        + ' max-width:min(90vw,420px); text-align:center; line-height:1.4; opacity:0;'
        + ' transition:opacity .3s ease, transform .3s ease;';
    document.body.appendChild(caja);
    requestAnimationFrame(() => {
        caja.style.opacity = '1';
        caja.style.transform = 'translate(-50%,0)';
    });
    setTimeout(() => {
        caja.style.opacity = '0';
        caja.style.transform = 'translate(-50%,10px)';
        setTimeout(() => caja.remove(), 300);
    }, importante ? 7000 : 4000);
}

// Devuelve { usuario, nueva, resultado }.
export async function entrarConGoogle(auth, { avisar = true } = {}) {
    const resultado = await signInWithPopup(auth, proveedorGoogle());
    const marcas = resultado.user.metadata || {};
    // Recién creada: Firebase pone la misma marca de tiempo en las dos.
    const nueva = Boolean(marcas.creationTime) && marcas.creationTime === marcas.lastSignInTime;
    const entrada = { usuario: resultado.user, nueva, resultado };
    if (avisar) {
        avisarCuenta(avisoCuentaGoogle(entrada), { importante: nueva });
        // La cuenta nueva es lo que hay que leer: se le da tiempo antes de
        // que la página siga (muchas redirigen).
        if (nueva) await new Promise((listo) => setTimeout(listo, ESPERA_CUENTA_NUEVA));
    }
    return entrada;
}
