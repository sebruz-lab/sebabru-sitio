// 1. IMPORTACIONES
import { auth, db } from './firebase.js';
import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    signOut,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc, setDoc, onSnapshotsInSync } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { entrarConGoogle } from './google.js?v=2';
import { pedirVerificacion } from './verificar.js?v=1';

// ======================================================
// EL CATALOGO DEL MENU DE LA ESCUELA
// ======================================================
// Las aulas de cada ano. Un ano con la lista vacia no se dibuja: por eso
// 2027 ya figura aca y no se ve hasta que tenga su primer curso. Abrir el ano
// que viene es agregarle entradas a esa lista, nada mas.
//
// Ojo con los pares de nombre parecido: 'linaje26' es el aula de la cursada
// regular y 'linaje' el curso suelto de la abierta; lo mismo con
// 'lunanegra'/'lilith' y 'pluton'/'pluton26'.
const AULAS_POR_ANIO = {
    2027: [],
    2026: [
        { slug: 'linaje26',     nombre: 'Linaje, clan y genealogía 2026' },
        { slug: 'lunas26',      nombre: 'La Luna en la carta natal 2026' },
        { slug: 'planetas',     nombre: 'Planetas y Luminarias' },
        { slug: 'quiron',       nombre: 'Neptuno, Urano y Quirón' },
        { slug: 'escucha',      nombre: 'Escucha Astrológica' },
        { slug: 'saturnoluna',  nombre: 'Saturno y la Luna' },
        { slug: 'introduccion', nombre: 'Introducción al Lenguaje Astrológico' },
        { slug: 'lectura',      nombre: 'Lectura e Interpretación' },
        { slug: 'revo',         nombre: 'Revoluciones Solares' },
        { slug: 'lunanegra',    nombre: 'Luna Negra' },
        { slug: 'pluton',       nombre: 'Seminario Plutón' },
        { slug: 'cosito',       nombre: '¿Qué es ese cosito?' },
        { slug: 'transitos',    nombre: 'Tránsitos' },
    ],
};

// Los cursos de la escuela abierta. Van como enlaces comunes y no con el
// candado: esas paginas son publicas (primera clase gratis y checkout) y
// resuelven solas si la persona ya lo compro.
const CURSOS_ABIERTA = [
    { url: 'abierta/',          nombre: 'Ver el recorrido completo' },
    { slug: 'luna',      url: 'abierta/luna/',      nombre: 'La Luna en la carta natal' },
    { slug: 'identidad', url: 'abierta/identidad/', nombre: 'Tu identidad en el cielo' },
    { slug: 'tarot',     url: 'abierta/tarot/',     nombre: 'Tarot — Mazo Rider-Waite' },
    { slug: 'signos',    url: 'abierta/signos/',    nombre: 'Signos' },
    { slug: 'casas',     url: 'abierta/casas/',     nombre: 'Casas y ascendentes' },
    { slug: 'pluton26',  url: 'abierta/pluton26/',  nombre: 'Plutón y los Nodos Lunares' },
    { slug: 'lilith',    url: 'abierta/lilith/',    nombre: 'Luna Negra · Lilith en la carta natal' },
    { slug: 'linaje',    url: 'abierta/linaje/',    nombre: 'Linaje, clan y genealogía' },
];

// Todo lo que se puede cursar, por slug: lo que necesita "Mis cursos" para
// traducir usuarios/{mail}.cursos en nombres y enlaces. Se arma de las dos
// listas de arriba, asi no hay una tercera que mantener sincronizada.
const CATALOGO_POR_SLUG = (() => {
    const mapa = {};
    Object.keys(AULAS_POR_ANIO).forEach(anio => {
        (AULAS_POR_ANIO[anio] || []).forEach(a => {
            mapa[a.slug] = { nombre: a.nombre, url: a.slug + '/index.html' };
        });
    });
    // La abierta pisa a la regular solo si el slug no existia: los pares de
    // nombre parecido (linaje26/linaje, pluton/pluton26) son slugs distintos.
    CURSOS_ABIERTA.forEach(c => {
        if (c.slug && !mapa[c.slug]) mapa[c.slug] = { nombre: c.nombre, url: c.url };
    });
    return mapa;
})();

const ENLACES_EGRESADXS = [
    { url: '/escuela/egresadxs/',    nombre: 'Lista de egresadxs' },
    { url: '/escuela/certificados/', nombre: 'Gestionar mis diplomas' },
    { url: '/titulo/',               nombre: 'Verificar un título' },
];

// Mensaje genérico a propósito para auth/email-already-in-use: no confirma
// ni niega si ese email ya tiene cuenta (evita que alguien lo use para
// enumerar qué emails están registrados en el sitio).
// Reemplaza los alert()/confirm() nativos (interrumpen el flujo y se ven
// ajenos al diseño oscuro del sitio) por un toast chico que aparece abajo
// y se va solo. No bloquea: si el código sigue (ej. reload), el toast
// puede no llegar a verse del todo, así que para esos casos se llama con
// un pequeño delay antes de la acción siguiente.
function mostrarAviso(mensaje, tipo = 'info') {
    let cont = document.getElementById('aviso-toast-container');
    if (!cont) {
        cont = document.createElement('div');
        cont.id = 'aviso-toast-container';
        cont.style.cssText = 'position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:999999; display:flex; flex-direction:column; gap:10px; align-items:center; pointer-events:none;';
        document.body.appendChild(cont);
    }
    const toast = document.createElement('div');
    toast.textContent = mensaje;
    toast.style.cssText = `
        background: rgba(18,18,26,0.97); color:#fff; padding:14px 22px; border-radius:10px;
        border:1px solid ${tipo === 'error' ? 'rgba(245,109,150,0.45)' : 'rgba(255,255,255,0.12)'};
        box-shadow:0 10px 30px rgba(0,0,0,0.5); font-family:'Outfit',sans-serif; font-size:13px;
        max-width:min(90vw, 420px); text-align:center; line-height:1.4;
        opacity:0; transform:translateY(10px); transition:opacity .3s ease, transform .3s ease; pointer-events:auto;
    `;
    cont.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function mensajeErrorRegistro(code) {
    switch (code) {
        case 'auth/weak-password':
            return 'La contraseña es muy corta (mínimo 6 caracteres).';
        case 'auth/invalid-email':
            return 'Ese email no es válido.';
        default:
            return 'No pudimos crear la cuenta con esos datos. Si ya tenés una cuenta, probá iniciar sesión.';
    }
}

// Detecta si un video guardado en cursos/{id}.videos es un GUID de Bunny
// (formato UUID) o un ID de YouTube, y arma la URL de embed correspondiente.
// Así los GUIDs de Bunny ya no viajan en el HTML estático de cada página:
// solo se conocen recién acá, después de confirmar en Firestore que el
// usuario logueado es dueño del curso (protegido por firestore.rules).
export function videoEntryToSrc(entry, libraryId, bunnyHost = 'player.mediadelivery.net') {
    if (/^https?:\/\//.test(entry)) return entry;
    const esGuidBunny = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry);
    if (esGuidBunny) {
        return `https://${bunnyHost}/embed/${libraryId}/${entry}?autoplay=false&loop=false&muted=false&preload=false&responsive=true`;
    }
    return `https://www.youtube.com/embed/${entry}`;
}

// Trae cursos/{cursoId}.videos (solo lo puede leer quien ya compró el curso,
// o un admin) y completa, en orden de aparición, el data-src de cada
// iframe de clase que todavía no lo tenga. Se llama recién después de
// confirmar el acceso, para no exponer nunca los IDs de video sin login.
export async function poblarVideosClases(cursoId, libraryId, bunnyHost) {
    try {
        const snap = await getDoc(doc(db, 'cursos', cursoId));
        const videos = snap.exists() ? [...(snap.data().videos || [])] : [];
        document.querySelectorAll('.clase-item').forEach(clase => {
            const iframe = clase.querySelector('iframe:not([data-src])');
            if (!iframe) return;
            const entry = videos.shift();
            if (entry) iframe.dataset.src = videoEntryToSrc(entry, libraryId, bunnyHost);
        });
    } catch (e) {
        console.error('Error cargando videos del curso:', e);
    }
}

// Carga diferida de los videos: pasa data-src a src recien cuando la clase
// se acerca a pantalla, para no pedir 10 reproductores de una.
//
// Vivia copiada en el <script> de cada aula y las copias se fueron separando:
// revo y cosito contemplaban los <details>, planetas no, y el video de su
// encuentro practico dependia de que el navegador avisara por un elemento sin
// caja de layout. Aca queda una sola version para todas.
export function activarLazyVideos() {
    const obs = new IntersectionObserver(entries => {
        entries.forEach(e => {
            if (!e.isIntersecting || !e.target.dataset.src) return;
            e.target.src = e.target.dataset.src;
            delete e.target.dataset.src;
            obs.unobserve(e.target);
        });
    }, { rootMargin: '200px' });

    document.querySelectorAll('iframe[data-src]').forEach(iframe => {
        // Un iframe dentro de un <details> cerrado no tiene caja de layout,
        // asi que el observer no lo ve: ese se carga al abrir el desplegable.
        if (!iframe.closest('details')) obs.observe(iframe);
    });

    document.querySelectorAll('details').forEach(d => {
        d.addEventListener('toggle', () => {
            if (!d.open) return;
            d.querySelectorAll('iframe[data-src]').forEach(iframe => {
                iframe.src = iframe.dataset.src;
                delete iframe.dataset.src;   // que no recargue al cerrar y abrir
            });
        });
    });
}

// --- DIAGNÓSTICO Y LIMPIEZA ---
onSnapshotsInSync(db, () => {
    console.log("🔥 Conexión activa con la base de datos 'cursos'");
});

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
}

// Al volver con "atrás" el navegador restaura la página tal cual estaba
// (bfcache), con el overlay "Ingresando..." todavía prendido.
window.addEventListener('pageshow', (e) => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay && e.persisted) overlay.style.display = 'none';
});

// --- El menu de las tres lineas --------------------------------------
//
// Vive en /escuela/ y tambien dentro de cada aula, asi que las rutas son
// absolutas: una relativa como "lunanegra/index.html" funciona en la portada
// pero desde un aula apunta a /escuela/lunanegra/lunanegra/index.html.
//
// Se pinta al principio del DOMContentLoaded, antes de que se enganchen los
// candados: los enlaces de las aulas llevan .curso-lock y data-url, asi que
// pasan por verificarYEntrar() igual que las tarjetas y dan el mismo aviso
// cuando no hay acceso.
function rutaEscuela(x) {
    return x.charAt(0) === '/' ? x : '/escuela/' + x;
}

function grupoDelMenu(titulo, items, conCandado) {
    const grupo = document.createElement('details');
    grupo.className = 'grupo-menu';

    const cabeza = document.createElement('summary');
    cabeza.textContent = titulo;
    grupo.appendChild(cabeza);

    const lista = document.createElement('ul');
    items.forEach(item => {
        const li = document.createElement('li');

        // "Cerrar sesion" no es un enlace: hace algo, no lleva a ningun lado.
        if (item.accion) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = item.nombre;
            if (item.id) b.id = item.id;
            li.appendChild(b);
            lista.appendChild(li);
            return;
        }

        const a = document.createElement('a');
        a.textContent = item.nombre;
        if (conCandado) {
            a.href = '#';
            a.className = 'curso-lock';
            a.dataset.url = rutaEscuela(item.slug + '/index.html');
        } else {
            a.href = rutaEscuela(item.url);
        }
        // El puntito de aviso (hoy, cuando no sabemos el nombre).
        if (item.alerta) {
            const punto = document.createElement('span');
            punto.className = 'alerta-cuenta';
            punto.id = item.alerta;
            punto.hidden = true;
            punto.title = 'Todavía no sabemos tu nombre';
            punto.setAttribute('aria-label', 'Todavía no sabemos tu nombre');
            a.appendChild(punto);
        }
        li.appendChild(a);
        lista.appendChild(li);
    });
    grupo.appendChild(lista);
    return grupo;
}

// Lo que siempre esta, con sesion o sin ella: todo el catalogo listado, tenga
// acceso o no. Los dos grupos de arriba ("Mi cuenta" y "Mis cursos") se
// agregan despues, cuando Firebase dice quien es.
function pintarMenuEscuela() {
    const panel = document.getElementById('menu-escuela-panel');
    if (!panel) return;

    panel.appendChild(grupoDelMenu('Escuela Abierta', CURSOS_ABIERTA, false));

    // Del ano mas nuevo al mas viejo, y saltando los que todavia no tienen
    // cursos: asi 2027 aparece solo el dia que se cargue el primero.
    Object.keys(AULAS_POR_ANIO)
        .map(Number)
        .sort((a, b) => b - a)
        .forEach(anio => {
            const aulas = AULAS_POR_ANIO[anio];
            if (!aulas || !aulas.length) return;
            panel.appendChild(grupoDelMenu(String(anio), aulas, true));
        });

    panel.appendChild(grupoDelMenu('Egresadxs', ENLACES_EGRESADXS, false));
}

const OPCIONES_CUENTA = [
    { url: '/escuela/cuenta/',       nombre: 'Mis datos', alerta: 'alerta-nombre' },
    { url: '/cartas/',               nombre: 'Mi calculadora de cartas astrales' },
    { url: '/escuela/certificados/', nombre: 'Mis diplomas' },
    { accion: true, id: 'btn-logout', nombre: 'Cerrar sesión' },
];

// "Mi cuenta" y "Mis cursos", en ese orden, arriba de todo. Solo con sesion:
// sin ella, afuera del menu aparece el boton Entrar.
//
// Los cursos van como enlaces directos y no con el candado: ya sabemos que
// tiene acceso (de ahi salio la lista), asi que no hace falta volver a
// preguntarle a Firestore para abrir el aula.
function pintarMenuDeSesion(slugs) {
    const panel = document.getElementById('menu-escuela-panel');
    if (!panel) return;

    ['grupo-mis-cursos', 'grupo-mi-cuenta'].forEach(id => {
        const viejo = document.getElementById(id);
        if (viejo) viejo.remove();
    });
    if (!slugs) return;

    if (slugs.length) {
        const items = slugs.map(slug => {
            const ficha = CATALOGO_POR_SLUG[slug];
            // Un aula que no este en las listas igual tiene que poder abrirse:
            // perder el acceso por un nombre que falta seria peor que el
            // titulo feo.
            return ficha || { nombre: slug, url: slug + '/index.html' };
        });
        const cursos = grupoDelMenu('Mis cursos', items, false);
        cursos.id = 'grupo-mis-cursos';
        cursos.open = true;
        panel.insertBefore(cursos, panel.firstChild);
    }

    const cuenta = grupoDelMenu('Mi cuenta', OPCIONES_CUENTA, false);
    cuenta.id = 'grupo-mi-cuenta';
    panel.insertBefore(cuenta, panel.firstChild);
}

// Un desplegable: abre, cierra, y se cierra solo al tocar afuera o con Escape.
function conectarDesplegable(boton, panel) {
    if (!boton || !panel) return { cerrar: () => {} };

    const cerrar = () => {
        panel.hidden = true;
        boton.setAttribute('aria-expanded', 'false');
    };
    const alternar = () => {
        const abierto = !panel.hidden;
        if (abierto) return cerrar();
        panel.hidden = false;
        boton.setAttribute('aria-expanded', 'true');
    };

    boton.addEventListener('click', (e) => { e.stopPropagation(); alternar(); });
    document.addEventListener('click', (e) => {
        if (panel.hidden) return;
        if (panel.contains(e.target) || boton.contains(e.target)) return;
        cerrar();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });

    return { cerrar };
}

document.addEventListener('DOMContentLoaded', () => {

    // El menu se pinta primero: sus enlaces de aulas tienen que estar en el
    // DOM antes de que se busquen los .curso-lock, unas lineas mas abajo.
    pintarMenuEscuela();

    // --- ELEMENTOS DE LA INTERFAZ ---
    const modal = document.getElementById('login-modal');
    const closeBtn = document.getElementById('close-modal');
    const cursosLocks = document.querySelectorAll('.curso-lock');
    const errorMsg = document.getElementById('login-error');
    
    // Formularios y Secciones
    const loginForm = document.getElementById('login-form');
    const registroForm = document.getElementById('registro-form');
    const seccionLogin = document.getElementById('seccion-login');
    const seccionRegistro = document.getElementById('seccion-registro');
    
    // Enlaces y Botones
    const linkIrRegistro = document.getElementById('ir-a-registro');
    const linkIrLogin = document.getElementById('ir-a-login');
    const linkOlvideContrasena = document.getElementById('olvide-contrasena');
    const botonCuenta = document.getElementById('boton-cuenta');
    const btnGoogle = document.getElementById('btn-google'); // Botón de Google

    // "Mi cuenta" y "Cerrar sesión" se pintan dentro del panel cuando hay
    // sesión, asi que no se pueden buscar ahora: no existen todavia.
    conectarDesplegable(document.getElementById('menu-escuela-toggle'),
                        document.getElementById('menu-escuela-panel'));

    let urlDestino = ''; 
    let usuarioActual = null;

    // ======================================================
    // 2. MANEJO DE SESIÓN (Log In / Log Out)
    // ======================================================
    // Sin sesión: a la izquierda de las tres lineas aparece "Entrar", que
    // abre el modal de ingreso. Con sesión ese boton desaparece y la cuenta
    // pasa a vivir adentro del menu, arriba de todo, con "Mis cursos" debajo.
    onAuthStateChanged(auth, async (user) => {
        usuarioActual = user;
        if (!user) {
            console.log("Sin sesión activa.");
            if (botonCuenta) botonCuenta.hidden = false;
            pintarMenuDeSesion(null);
            return;
        }

        console.log("Usuario logueado:", user.email);
        if (botonCuenta) botonCuenta.hidden = true;

        // Una sola lectura del usuario sirve para las dos cosas: los cursos
        // que van en el menu y el nombre, que es lo que se imprime en el
        // diploma y conviene avisar antes de que haga falta.
        let cursos = [];
        let nombre = (user.displayName || '').trim();
        try {
            const snap = await getDoc(doc(db, 'usuarios', user.email.toLowerCase().trim()));
            if (snap.exists()) {
                const datos = snap.data();
                cursos = Array.isArray(datos.cursos) ? datos.cursos : [];
                if (!nombre) nombre = ((datos.nombre || '')).trim();
            }
        } catch (e) {
            // Si no se puede leer, el menu sale sin "Mis cursos" y sin alerta:
            // no se inventa ninguna de las dos.
            console.error(e);
            nombre = nombre || 'x';
        }

        pintarMenuDeSesion(cursos);

        const alertaNombre = document.getElementById('alerta-nombre');
        if (alertaNombre) alertaNombre.hidden = Boolean(nombre);

        const btnLogout = document.getElementById('btn-logout');
        if (btnLogout) {
            btnLogout.onclick = async () => {
                await signOut(auth);
                window.location.reload();
            };
        }
    });

    // El boton "Entrar" abre el modal de ingreso. Dentro de un aula no hay
    // modal (ahi siempre hay sesión), asi que lleva a la escuela.
    if (botonCuenta) {
        botonCuenta.addEventListener('click', () => {
            if (usuarioActual) return;
            if (modal) {
                modal.style.display = 'flex';
                if (seccionLogin) seccionLogin.style.display = 'block';
                if (seccionRegistro) seccionRegistro.style.display = 'none';
            } else {
                window.location.href = '/escuela/';
            }
        });
    }

    // Alternar entre Login y Registro
    if (linkIrRegistro) {
        linkIrRegistro.onclick = (e) => {
            e.preventDefault();
            seccionLogin.style.display = 'none';
            seccionRegistro.style.display = 'block';
            if(errorMsg) errorMsg.style.display = 'none';
        };
    }
    if (linkIrLogin) {
        linkIrLogin.onclick = (e) => {
            e.preventDefault();
            seccionRegistro.style.display = 'none';
            seccionLogin.style.display = 'block';
            if(errorMsg) errorMsg.style.display = 'none';
        };
    }

    // ======================================================
    // 3. LÓGICA DE ACCESO Y AUTENTICACIÓN
    // ======================================================

    // --- LOGIN CON GOOGLE ---
    if (btnGoogle) {
        btnGoogle.onclick = async () => {
            try {
                // entrarConGoogle hace elegir la cuenta y avisa con cuál
                // entró (y si recén se creó), antes de seguir.
                const { usuario: user } = await entrarConGoogle(auth);
                // El popup se cerró — mostrar overlay inmediatamente
                const loadingOverlay = document.getElementById('loading-overlay');
                if (loadingOverlay) loadingOverlay.style.display = 'flex';
                if (modal) modal.style.display = 'none';
                const email = user.email.toLowerCase().trim();

                // Verificamos si ya existe en la base de datos "cursos"
                const docRef = doc(db, "usuarios", email);
                const docSnap = await getDoc(docRef);

                if (!docSnap.exists()) {
                    await setDoc(docRef, {
                        cursos: [],
                        nombre: user.displayName,
                        fechaRegistro: new Date(),
                        cohorte: "2026",
                        novedades: quiereNovedades(),
                    });
                } else {
                    await prenderNovedades(docRef, docSnap.data());
                }

                if (urlDestino) {
                    await verificarYEntrar(email, urlDestino);
                } else {
                    modal.style.display = 'none';
                    window.location.reload();
                }
            } catch (error) {
                console.error(error);
                mostrarAviso("Error al iniciar sesión con Google.", 'error');
            }
        };
    }

    // --- CLIC EN CANDADOS ---
    cursosLocks.forEach(curso => {
        curso.addEventListener('click', (e) => {
            e.preventDefault();
            urlDestino = curso.getAttribute('data-url');
            if (usuarioActual) {
                verificarYEntrar(usuarioActual.email, urlDestino);
            } else if (modal) {
                modal.style.display = 'flex';
                seccionLogin.style.display = 'block';
                seccionRegistro.style.display = 'none';
            } else {
                // Dentro de un aula no hay modal de ingreso.
                window.location.href = '/escuela/';
            }
        });
    });

    // --- RECUPERAR CONTRASEÑA ---
    if (linkOlvideContrasena) {
        linkOlvideContrasena.onclick = async (e) => {
            e.preventDefault();
            const email = document.getElementById('email-login').value.toLowerCase().trim();
            if (!email) {
                mostrarAviso('Escribí tu email arriba y volvé a tocar "¿Olvidaste tu contraseña?".', 'error');
                return;
            }
            try {
                await sendPasswordResetEmail(auth, email);
                mostrarAviso('Te enviamos un mail para restablecer tu contraseña.');
            } catch (error) {
                mostrarAviso('No pudimos enviar el mail. Revisá que el email esté bien escrito.', 'error');
            }
        };
    }

    // --- FORMULARIO DE LOGIN EMAIL ---
    if (loginForm) {
        loginForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = loginForm.querySelector('button');
            const email = document.getElementById('email-login').value.toLowerCase().trim();
            const pass = document.getElementById('pass-login').value.trim();

            btn.innerText = "VERIFICANDO...";
            if(errorMsg) errorMsg.style.display = 'none';

            try {
                await signInWithEmailAndPassword(auth, email, pass);
                try {
                    const ref = doc(db, "usuarios", email);
                    const snap = await getDoc(ref);
                    if (snap.exists()) await prenderNovedades(ref, snap.data());
                } catch (e) {
                    // Que no se caiga el ingreso por esto.
                    console.error(e);
                }
                await verificarYEntrar(email, urlDestino); 
            } catch (error) {
                btn.innerText = "ENTRAR";
                if(errorMsg) {
                    errorMsg.style.display = 'block';
                    errorMsg.innerText = "Email o contraseña incorrectos.";
                }
            }
        };
    }

    // El casillero de la lista de correo. Vive arriba del modal porque
    // los tres caminos de abajo (Google, entrar, crear cuenta) pueden
    // terminar en una cuenta nueva.
    //
    // Solo se escribe cuando esta MARCADO. Que alguien entre con el
    // casillero vacio no significa que quiera darse de baja: se dio de
    // alta otro dia, y la baja se hace desde el enlace de cualquier mail.
    // Si lo escribieramos en false, cada ingreso lo desuscribiria.
    function quiereNovedades() {
        const c = document.getElementById('acepta-novedades');
        return Boolean(c && c.checked);
    }

    async function prenderNovedades(ref, datos) {
        if (!quiereNovedades()) return;
        if (datos && datos.novedades === true) return;
        await setDoc(ref, { novedades: true }, { merge: true });
    }

    // --- FORMULARIO DE REGISTRO EMAIL ---
    if (registroForm) {
        registroForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = registroForm.querySelector('button');
            const email = document.getElementById('email-registro').value.toLowerCase().trim();
            const pass = document.getElementById('pass-registro').value.trim();

            btn.innerText = "CREANDO CUENTA...";

            try {
                const cred = await createUserWithEmailAndPassword(auth, email, pass);
                await setDoc(doc(db, "usuarios", email), {
                    cursos: [],
                    cohorte: "2026",
                    novedades: quiereNovedades(),
                });
                // El mail de confirmacion de la direccion. No hace falta para
                // entrar a un curso que ya se tiene: hace falta para canjear
                // un codigo, que es donde alguien podria registrarse con una
                // direccion ajena (auditoria del 28/11/2026).
                await pedirVerificacion(cred.user);
                mostrarAviso("¡Cuenta creada! Te mandamos un mail para confirmar tu dirección. Verificá si tenés acceso al curso, sino pedile a Seba o a Clari.");
                setTimeout(() => window.location.reload(), 2600);
            } catch (error) {
                btn.innerText = "CREAR CUENTA";
                if(errorMsg) {
                    errorMsg.style.display = 'block';
                    // Mensajes genericos a proposito: el texto crudo de Firebase
                    // (ej. "auth/email-already-in-use") permite confirmar que
                    // mail ya tiene cuenta en el sitio con solo probar registrarse.
                    errorMsg.innerText = mensajeErrorRegistro(error.code);
                }
            }
        };
    }

    // --- FUNCIÓN CENTRAL DE PERMISOS ---
    async function verificarYEntrar(email, url) {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
        if (modal) modal.style.display = 'none';
        try {
            const docSnap = await getDoc(doc(db, "usuarios", email.toLowerCase().trim()));
            if (docSnap.exists()) {
                const misCursos = docSnap.data().cursos || [];
                // Coincidencia exacta contra los segmentos de la URL, no un
                // "contiene" sobre el string completo: antes, tener el curso
                // "luna" bastaba para que cualquier URL que contuviera esa
                // substring en cualquier lado (ej. "/escuela/lunas26/",
                // "/escuela/lunanegra/") pasara este chequeo.
                const segmentosUrl = url.toLowerCase().split('/').filter(Boolean);
                const tienePermiso = misCursos.some(c => segmentosUrl.includes(c.toLowerCase()));
                if (tienePermiso) {
                    window.location.href = url;
                } else {
                    if (loadingOverlay) loadingOverlay.style.display = 'none';
                    mostrarAviso("No tenés acceso habilitado para este curso.", 'error');
                }
            } else {
                if (loadingOverlay) loadingOverlay.style.display = 'none';
                mostrarAviso("Usuario no registrado en la base de datos.", 'error');
            }
        } catch (error) {
            console.error(error);
            if (loadingOverlay) loadingOverlay.style.display = 'none';
            mostrarAviso("Error de conexión. Intentá en modo Incógnito.", 'error');
        }
    }

    if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';

    // ======================================================
    // 4. FIX PARA VIDEOS Y PDF (SIN BLOQUEO DE CLICK DERECHO)
    // ======================================================
    
    // Arreglo para que el video no se achique
    document.querySelectorAll('.video-container iframe').forEach(video => {
        video.style.width = "100%";
        video.style.height = "100%";
        video.setAttribute('width', '100%');
    });

    // Función para los documentos PDF (Botón externo)
    document.querySelectorAll('.pdf-wrapper').forEach(wrapper => {
        const iframe = wrapper.querySelector('iframe');
        if (iframe) {
            const pdfUrl = iframe.src;
            const link = document.createElement('a');
            link.href = pdfUrl;
            link.target = "_blank";
            link.className = "btn-external";
            link.style.display = "inline-block";
            link.style.marginTop = "15px";
            link.style.padding = "12px 25px";
            link.style.backgroundColor = "#249b95";
            link.style.color = "white";
            link.style.textDecoration = "none";
            link.style.borderRadius = "8px";
            link.style.fontWeight = "bold";
            link.innerHTML = '<i class="fa-solid fa-expand"></i> ABRIR EN PANTALLA COMPLETA / DESCARGAR';
            wrapper.after(link);
        }
    });

    // ======================================================
    // 5. GENERADOR DEL MENÚ (SIDEBAR) Y FUNCIONALIDAD MÓVIL
    // ======================================================

    // A) Generar la lista de clases automáticamente
    const listaClases = document.getElementById('lista-clases');
    const articles = document.querySelectorAll('.clase-item');

    if (listaClases && articles.length > 0) {
        listaClases.innerHTML = ''; // Limpiamos por las dudas
        
        articles.forEach(clase => {
            const titulo = clase.getAttribute('data-titulo') || 'Clase sin título';
            const id = clase.id;
            
            // Creamos el item de la lista
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = `#${id}`;
            a.innerText = titulo;
            
            // Agregamos comportamiento de scroll suave y cerrar menú en móvil
            a.addEventListener('click', (e) => {
                // Si estamos en móvil, cerramos el menú al hacer clic
                const sidebar = document.getElementById('sidebar');
                if (window.innerWidth <= 768) {
                    sidebar.classList.remove('active');
                }
            });

            li.appendChild(a);
            listaClases.appendChild(li);
        });
        console.log("✅ Lista de clases generada correctamente.");

        // --- CLASES VISITADAS ---
        // Se marcan al DARLE PLAY, no al pasar scrolleando. Antes bastaba con
        // que la clase entrara un 40% en pantalla, asi que bajar hasta el final
        // del aula dejaba todo marcado como visto sin haber mirado nada.
        const STORAGE_KEY = 'visitadas_' + window.location.pathname;
        const visitadas   = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));

        function marcarVisitadaEnSidebar(id) {
            const link = listaClases.querySelector(`a[href="#${id}"]`);
            if (link) link.classList.add('visitada');
        }

        // Aplicar estado guardado al cargar la página
        visitadas.forEach(id => marcarVisitadaEnSidebar(id));

        function marcarVista(id) {
            if (!id || visitadas.has(id)) return;
            visitadas.add(id);
            // En incognito o con el almacenamiento bloqueado esto tira: que no
            // se lleve puesto el resto del enganche.
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...visitadas])); } catch (e) {}
            marcarVisitadaEnSidebar(id);
        }

        function cargarScriptUnaVez(src, clave) {
            if (!window[clave]) {
                window[clave] = new Promise((ok, falla) => {
                    const s = document.createElement('script');
                    s.src = src; s.onload = ok; s.onerror = falla;
                    document.head.appendChild(s);
                });
            }
            return window[clave];
        }

        function apiYoutube() {
            if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
            if (!window._promesaYT) {
                window._promesaYT = new Promise(ok => {
                    const previo = window.onYouTubeIframeAPIReady;
                    window.onYouTubeIframeAPIReady = () => { if (previo) previo(); ok(window.YT); };
                    const s = document.createElement('script');
                    s.src = 'https://www.youtube.com/iframe_api';
                    document.head.appendChild(s);
                });
            }
            return window._promesaYT;
        }

        // Engancha el evento de reproduccion. Bunny avisa por player.js;
        // YouTube por su IFrame API, que exige enablejsapi=1 en la URL.
        function engancharPlay(iframe) {
            if (!iframe || iframe.dataset.playEnganchado) return;
            const clase = iframe.closest('.clase-item');
            if (!clase || !clase.id) return;
            let src = iframe.src || '';
            if (!src) return;

            iframe.dataset.playEnganchado = '1';   // antes de tocar src: si no, el
                                                   // MutationObserver se re-dispara
            const id = clase.id;

            if (src.includes('youtube.com')) {
                if (!src.includes('enablejsapi=1')) {
                    // Se agrega ahora, recien cargado y todavia sin reproducir,
                    // asi que el recargo del iframe pasa desapercibido.
                    src += (src.includes('?') ? '&' : '?') +
                           'enablejsapi=1&origin=' + encodeURIComponent(location.origin);
                    iframe.src = src;
                }
                apiYoutube().then(YT => {
                    new YT.Player(iframe, {
                        events: {
                            onStateChange: e => { if (e.data === YT.PlayerState.PLAYING) marcarVista(id); }
                        }
                    });
                }).catch(() => {});
            } else {
                cargarScriptUnaVez('https://assets.mediadelivery.net/playerjs/player-0.1.0.min.js', '_promesaPlayerjs')
                    .then(() => {
                        const p = new window.playerjs.Player(iframe);
                        p.on('ready', () => p.on('play', () => marcarVista(id)));
                    }).catch(() => {});
            }
        }

        // Los iframes de clase arrancan vacios y reciben su src recien al
        // scrollear (lazy load), asi que hay que esperar a que aparezca.
        document.querySelectorAll('.clase-item iframe').forEach(ifr => {
            if (ifr.src) engancharPlay(ifr);
        });
        new MutationObserver(muts => {
            muts.forEach(m => {
                if (m.attributeName === 'src' && m.target.src) engancharPlay(m.target);
            });
        }).observe(document.body, { attributes: true, attributeFilter: ['src'], subtree: true });
    }

    // --- BOTON "EXPANDIR" DE LOS PDFs ---
    // escuela.css define .pdf-wrapper.fullscreen-mode desde hace rato, pero
    // nada aplicaba la clase: los 25 botones de revo, lectura e introduccion
    // no hacian nada.
    document.querySelectorAll('.btn-expandir').forEach(btn => {
        btn.addEventListener('click', () => {
            const wrapper = btn.closest('.pdf-wrapper');
            if (!wrapper) return;
            const full = wrapper.classList.toggle('fullscreen-mode');
            document.body.style.overflow = full ? 'hidden' : '';   // si no, la pagina
                                                                   // scrollea detras
            const icono = btn.querySelector('i');
            if (icono) icono.className = full ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
        });
    });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.pdf-wrapper.fullscreen-mode').forEach(w => {
            w.classList.remove('fullscreen-mode');
            const icono = w.querySelector('.btn-expandir i');
            if (icono) icono.className = 'fa-solid fa-expand';
        });
        document.body.style.overflow = '';
    });

    // B) Hacer funcionar el botón "TEMARIO" (Móvil)
    const btnTemario = document.getElementById('menu-toggle');
    const sidebar = document.getElementById('sidebar');

    if (btnTemario && sidebar) {
        btnTemario.addEventListener('click', (e) => {
            e.preventDefault(); // Evita comportamientos raros
            sidebar.classList.toggle('active'); // Muestra/Oculta el menú
            console.log("Botón Temario clickeado");
        });
        
        // Cerrar al hacer click fuera (Opcional, mejora la experiencia)
        document.addEventListener('click', (e) => {
            if (!sidebar.contains(e.target) && !btnTemario.contains(e.target) && sidebar.classList.contains('active')) {
                sidebar.classList.remove('active');
            }
        });
    }
    function openTab(evt, tabName) {
        // Ocultar todos los videos de esa clase
        var i, tabcontent, tablinks;
        // Buscamos dentro del artículo específico para no afectar otras clases si hacés lo mismo
        var currentArticle = evt.currentTarget.closest('.clase-item');
        
        tabcontent = currentArticle.getElementsByClassName("tab-content");
        for (i = 0; i < tabcontent.length; i++) {
            tabcontent[i].style.display = "none";
        }
        
        // Desmarcar todos los botones
        tablinks = currentArticle.getElementsByClassName("tab-btn");
        for (i = 0; i < tablinks.length; i++) {
            tablinks[i].className = tablinks[i].className.replace(" active", "");
        }
        
        // Mostrar el video actual y marcar el botón
        currentArticle.querySelector('#' + tabName).style.display = "block";
        evt.currentTarget.className += " active";
    }
});