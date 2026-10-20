// 1. IMPORTACIONES
import { auth, db } from './firebase.js';
import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    signOut,
    GoogleAuthProvider,
    signInWithPopup,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc, setDoc, onSnapshotsInSync } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const googleProvider = new GoogleAuthProvider();

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
        box-shadow:0 10px 30px rgba(0,0,0,0.5); font-family:'Outfit',sans-serif; font-size:0.92rem;
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

document.addEventListener('DOMContentLoaded', () => {

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
    const btnLogout = document.getElementById('btn-logout');
    const btnLogin = document.getElementById('btn-login');
    const linkMiCuenta = document.getElementById('link-mi-cuenta');
    const btnGoogle = document.getElementById('btn-google'); // Botón de Google

    let urlDestino = ''; 
    let usuarioActual = null;

    // ======================================================
    // 2. MANEJO DE SESIÓN (Log In / Log Out)
    // ======================================================
    onAuthStateChanged(auth, (user) => {
        usuarioActual = user;
        if (user) {
            console.log("Usuario logueado:", user.email);
            if(btnLogout) btnLogout.style.display = 'block';
            if(btnLogin) btnLogin.style.display = 'none';
            if(linkMiCuenta) linkMiCuenta.style.display = 'inline-block';
        } else {
            console.log("Sin sesión activa.");
            if(btnLogout) btnLogout.style.display = 'none';
            if(btnLogin) btnLogin.style.display = 'block';
            if(linkMiCuenta) linkMiCuenta.style.display = 'none';
        }
    });

    if (btnLogin) btnLogin.onclick = () => { modal.style.display = 'flex'; };

    if (btnLogout) {
        btnLogout.onclick = async () => {
            await signOut(auth);
            window.location.reload();
        };
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
                const result = await signInWithPopup(auth, googleProvider);
                // El popup se cerró — mostrar overlay inmediatamente
                const loadingOverlay = document.getElementById('loading-overlay');
                if (loadingOverlay) loadingOverlay.style.display = 'flex';
                if (modal) modal.style.display = 'none';
                const user = result.user;
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
                    });
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
            } else {
                modal.style.display = 'flex';
                seccionLogin.style.display = 'block';
                seccionRegistro.style.display = 'none';
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

    // --- FORMULARIO DE REGISTRO EMAIL ---
    if (registroForm) {
        registroForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = registroForm.querySelector('button');
            const email = document.getElementById('email-registro').value.toLowerCase().trim();
            const pass = document.getElementById('pass-registro').value.trim();

            btn.innerText = "CREANDO CUENTA...";

            try {
                await createUserWithEmailAndPassword(auth, email, pass);
                await setDoc(doc(db, "usuarios", email), {
                    cursos: [],
                    cohorte: "2026",
                });
                mostrarAviso("¡Cuenta creada! Verificá si tenés acceso al curso, sino pedile a Seba o a Clari.");
                setTimeout(() => window.location.reload(), 1800);
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
        const STORAGE_KEY = 'visitadas_' + window.location.pathname;
        const visitadas   = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));

        function marcarVisitadaEnSidebar(id) {
            const link = listaClases.querySelector(`a[href="#${id}"]`);
            if (link) link.classList.add('visitada');
        }

        // Aplicar estado guardado al cargar la página
        visitadas.forEach(id => marcarVisitadaEnSidebar(id));

        // Observar cada clase: se marca al verla en un 40%
        const observerVisitas = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !visitadas.has(entry.target.id)) {
                    visitadas.add(entry.target.id);
                    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visitadas]));
                    marcarVisitadaEnSidebar(entry.target.id);
                }
            });
        }, { threshold: 0.4 });

        articles.forEach(clase => observerVisitas.observe(clase));
    }

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