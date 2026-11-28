// Mandar el mail de verificación al crear una cuenta con contraseña.
//
// Por qué existe, desde la auditoría del 28/11/2026: el sitio creaba cuentas
// con createUserWithEmailAndPassword y no mandaba nunca el mail de
// verificación, así que cualquiera podía registrarse con una dirección que no
// es suya. Y como toda la autoridad del sistema sale de
// request.auth.token.email, eso tenía consecuencias concretas: quien supiera
// a qué dirección se mandó una invitación podía registrarse con ella, antes
// que su dueña, y quedarse con el curso que pagó otra persona.
//
// Ahora los canjes (activarInvitacion, canjearRegalo, reclamarPago,
// activarEnlace) y el panel piden el mail verificado del lado del servidor.
// Esto es la otra mitad: el camino para que quien usa contraseña pueda
// verificarlo. Quien entra con Google no lo necesita, porque Google ya
// devuelve email_verified en true.
//
// Entrar a las aulas NO pide verificación, a propósito: si la pidiera,
// cualquier cuenta vieja sin verificar se quedaría afuera de un curso que ya
// pagó. Lo que la pide es canjear y administrar.

import { sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const MENSAJE_OK = 'Te mandamos un mail para confirmar tu dirección. Abrí el enlace '
    + 'cuando puedas: lo vas a necesitar para canjear un código.';

// Nunca tira. Un fallo acá no puede impedir que la cuenta quede creada: la
// persona ya tiene su cuenta y puede entrar a sus cursos igual.
export async function pedirVerificacion(usuario) {
    if (!usuario || usuario.emailVerified) return { mandado: false, mensaje: '' };
    try {
        await sendEmailVerification(usuario);
        return { mandado: true, mensaje: MENSAJE_OK };
    } catch (e) {
        // El caso más común es auth/too-many-requests, que pasa si alguien
        // se registra varias veces seguidas probando. No es un error que la
        // persona pueda arreglar ni que tenga que leer.
        console.warn('No se pudo mandar el mail de verificación:', e?.code || e);
        return { mandado: false, mensaje: '' };
    }
}

// Los mensajes de error del registro, sin filtrar el código crudo de
// Firebase. El texto de auth/email-already-in-use le confirma a cualquiera
// que una dirección ajena ya tiene cuenta en el sitio con sólo probar a
// registrarse. escuela.js ya lo hacía así; esto lo deja en un solo lugar.
export function mensajeDeErrorDeRegistro(codigo) {
    if (codigo === 'auth/invalid-email') return 'Esa dirección de correo no parece válida.';
    if (codigo === 'auth/weak-password') return 'La contraseña tiene que tener al menos 6 caracteres.';
    if (codigo === 'auth/too-many-requests') return 'Probaste muchas veces seguidas. Esperá unos minutos.';
    // Incluye email-already-in-use a propósito: el mismo texto para "ya
    // existe" y para "no se pudo", así no hay forma de distinguirlos.
    return 'No pudimos crear la cuenta. Si ya tenés una, entrá con tu contraseña o pedí una nueva.';
}
