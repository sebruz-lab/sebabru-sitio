// 1. IMPORTACIONES
import { auth, db } from './firebase.js';
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    onAuthStateChanged, 
    signOut,
    GoogleAuthProvider,
    signInWithPopup 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc, setDoc, onSnapshotsInSync } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"; 

const googleProvider = new GoogleAuthProvider();

// --- DIAGNÓSTICO Y LIMPIEZA ---
onSnapshotsInSync(db, () => {
    console.log("🔥 Conexión activa con la base de datos 'cursos'");
});

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
}

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
    const btnLogout = document.getElementById('btn-logout');
    const btnLogin = document.getElementById('btn-login');
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
        } else {
            console.log("Sin sesión activa.");
            if(btnLogout) btnLogout.style.display = 'none';
            if(btnLogin) btnLogin.style.display = 'block';
        }
    });

    if (btnLogin) btnLogin.onclick = () => { modal.style.display = 'flex'; };

    if (btnLogout) {
        btnLogout.onclick = async () => {
            await signOut(auth);
            alert("Sesión cerrada.");
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
                alert("Error al iniciar sesión con Google.");
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
                alert("¡Cuenta creada! Verifica si tenés acceso al curso, sino pedile a Seba o a Clari.");
                window.location.reload();
            } catch (error) {
                btn.innerText = "CREAR CUENTA";
                if(errorMsg) {
                    errorMsg.style.display = 'block';
                    errorMsg.innerText = "Error: " + error.message;
                }
            }
        };
    }

    // --- FUNCIÓN CENTRAL DE PERMISOS ---
    async function verificarYEntrar(email, url) {
        try {
            const docSnap = await getDoc(doc(db, "usuarios", email.toLowerCase().trim()));
            if (docSnap.exists()) {
                const misCursos = docSnap.data().cursos || [];
                const tienePermiso = misCursos.some(c => url.toLowerCase().includes(c.toLowerCase()));
                if (tienePermiso) {
                    window.location.href = url;
                } else {
                    alert("No tenés acceso habilitado para este curso.");
                    modal.style.display = 'none';
                }
            } else {
                alert("Usuario no registrado en la base de datos.");
            }
        } catch (error) {
            console.error(error);
            alert("Error de conexión. Intentá en modo Incógnito.");
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